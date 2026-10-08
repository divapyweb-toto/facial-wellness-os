// Transcripción de notas de voz de WhatsApp con ElevenLabs Scribe v2 · dueño: G2 (ola 2).
// Verificado en la documentación de ElevenLabs (06-10-2026):
//   POST https://api.elevenlabs.io/v1/speech-to-text · multipart/form-data · header xi-api-key
//   campos: file, model_id="scribe_v2", language_code="spa" (ISO-639-3), keyterms (lista; ≤ 1000,
//   cada una < 50 caracteres y ≤ 5 palabras, sin < > { } [ ] \)
//   formatos: OGG y OPUS soportados → el audio de WhatsApp (audio/ogg; codecs=opus) va tal cual.
//   respuesta: {language_code, language_probability, text, words[{text, type, logprob}], audio_duration_secs}
//   precio: USD 0,22 por hora + keyterms USD 0,05 por hora (20 %).
// Con MODO_SIMULADO=1 usa un simulador determinista (simulado: true). Sin ELEVENLABS_API_KEY falla (no inventa texto).
// Nota: el guaraní no está entre los idiomas de Scribe; el jopara se transcribe como español.
// Costo: si config_wa.transcripcion.usd_por_hora existe, se usa como tarifa total por hora
// (ya incluye keyterms); si no, TARIFAS_SCRIBE_POR_DEFECTO. Prioridad: opciones.tarifas > config > defecto.

import { db } from "./db.ts";

export const URL_SCRIBE = "https://api.elevenlabs.io/v1/speech-to-text";
export const MODELO_SCRIBE = "scribe_v2";

export const PALABRAS_CLAVE_POR_DEFECTO = [
  "Voltra",
  "tiras nasales",
  "parches bucales",
  "raspador",
  "ejercitador",
  "Ciudad del Este",
  "Asunción",
  "Encarnación",
  "Luque",
  "San Lorenzo",
];

/** Tarifas por defecto (USD por hora de audio). Se pueden pisar con `tarifas` (p. ej. desde config_wa). */
export const TARIFAS_SCRIBE_POR_DEFECTO = { base_hora: 0.22, keyterms_hora: 0.05 };

/** Por debajo de este valor el vendedor debe pedir "¿me lo escribís?". */
export const UMBRAL_CONFIANZA_POR_DEFECTO = 0.6;

export type OpcionesTranscripcion = {
  palabrasClave?: string[];
  idioma?: string;
  umbralConfianza?: number;
  tarifas?: { base_hora: number; keyterms_hora: number };
  /** Lee config_wa.transcripcion (por defecto: de la base, con caché de 5 min). Inyectable en tests. */
  leerConfig?: () => Promise<unknown>;
  timeoutMs?: number;
  // Inyección para tests (por defecto: Deno.env y fetch global).
  apiKey?: string | null;
  modoSimulado?: boolean;
  fetch?: typeof fetch;
};

export type ResultadoTranscripcion = {
  ok: boolean;
  texto: string;
  /** 0 a 1. Promedio de la probabilidad de cada palabra (exp(logprob)). 0 si falló. */
  confianza: number;
  /** true → pedir al cliente que lo escriba. */
  confianzaBaja: boolean;
  simulado: boolean;
  idioma?: string | null;
  duracionSeg?: number | null;
  costoUsd?: number;
  error?: string;
};

function leerEnv(nombre: string): string | undefined {
  try {
    return Deno.env.get(nombre);
  } catch {
    return undefined;
  }
}

/** Limpia la lista según las reglas de keyterms de Scribe (descarta las inválidas y duplicadas). */
export function limpiarPalabrasClave(lista: string[]): string[] {
  const vistas = new Set<string>();
  const out: string[] = [];
  for (const crudo of lista ?? []) {
    if (typeof crudo !== "string") continue;
    const p = crudo.trim().replace(/\s+/g, " ");
    if (!p || p.length >= 50 || /[<>{}[\]\\]/.test(p) || p.split(" ").length > 5) continue;
    const k = p.toLowerCase();
    if (vistas.has(k)) continue;
    vistas.add(k);
    out.push(p);
    if (out.length >= 1000) break;
  }
  return out;
}

function extension(mime: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("amr")) return "amr";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "bin";
}

/** Confianza = promedio de exp(logprob) de las palabras (type "word"). Sin palabras → 0. */
export function calcularConfianza(words: unknown): number {
  if (!Array.isArray(words)) return 0;
  const probs: number[] = [];
  for (const w of words) {
    if (!w || typeof w !== "object") continue;
    const { type, logprob } = w as { type?: string; logprob?: number };
    if (type && type !== "word") continue;
    if (typeof logprob === "number" && Number.isFinite(logprob)) probs.push(Math.exp(Math.min(0, logprob)));
  }
  if (!probs.length) return 0;
  return Math.round((probs.reduce((a, b) => a + b, 0) / probs.length) * 1000) / 1000;
}

export function costoScribe(
  duracionSeg: number,
  conPalabrasClave: boolean,
  t = TARIFAS_SCRIBE_POR_DEFECTO,
): number {
  const horas = Math.max(0, duracionSeg) / 3600;
  return Math.round(horas * (t.base_hora + (conPalabrasClave ? t.keyterms_hora : 0)) * 1e6) / 1e6;
}

/** Tarifa desde config_wa.transcripcion: usd_por_hora es el total por hora (keyterms incluidos). */
export function tarifasDesdeConfig(cfg: unknown): { base_hora: number; keyterms_hora: number } | null {
  const v = (cfg as { usd_por_hora?: unknown } | null)?.usd_por_hora;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return { base_hora: v, keyterms_hora: 0 };
}

let cacheConfig: { valor: unknown; hasta: number } | null = null;

async function leerConfigPorDefecto(): Promise<unknown> {
  if (cacheConfig && cacheConfig.hasta > Date.now()) return cacheConfig.valor;
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "transcripcion").maybeSingle();
  if (error) return null;
  cacheConfig = { valor: data?.valor ?? null, hasta: Date.now() + 5 * 60_000 };
  return cacheConfig.valor;
}

/** Elige la tarifa: opciones.tarifas > config_wa.transcripcion.usd_por_hora > defecto. Nunca lanza. */
async function resolverTarifas(opciones: OpcionesTranscripcion) {
  if (opciones.tarifas) return opciones.tarifas;
  try {
    return tarifasDesdeConfig(await (opciones.leerConfig ?? leerConfigPorDefecto)()) ?? TARIFAS_SCRIBE_POR_DEFECTO;
  } catch {
    return TARIFAS_SCRIBE_POR_DEFECTO;
  }
}

function simular(bytes: Uint8Array, umbral: number): ResultadoTranscripcion {
  // Determinista: el texto depende solo del tamaño del audio.
  const frases = [
    "Hola, quiero las tiras nasales, ¿cuánto sale el envío a Luque?",
    "Buenas, me interesa el ejercitador, soy de Ciudad del Este.",
    "Quiero dos parches bucales para Asunción, por favor.",
  ];
  const texto = frases[bytes.length % frases.length];
  console.log("[transcripcion] modo simulado (sin ELEVENLABS_API_KEY o MODO_SIMULADO=1)");
  return {
    ok: true,
    texto,
    confianza: 0.95,
    confianzaBaja: 0.95 < umbral,
    simulado: true,
    idioma: "spa",
    duracionSeg: null,
    costoUsd: 0,
  };
}

function fallo(error: string, simulado = false): ResultadoTranscripcion {
  return { ok: false, texto: "", confianza: 0, confianzaBaja: true, simulado, error };
}

export async function transcribirAudio(
  bytes: Uint8Array,
  mime: string,
  opciones: OpcionesTranscripcion = {},
): Promise<ResultadoTranscripcion> {
  const umbral = opciones.umbralConfianza ?? UMBRAL_CONFIANZA_POR_DEFECTO;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return fallo("audio_vacio");

  const apiKey = opciones.apiKey !== undefined ? opciones.apiKey : leerEnv("ELEVENLABS_API_KEY");
  const simulado = opciones.modoSimulado ?? leerEnv("MODO_SIMULADO") === "1";
  if (simulado) return simular(bytes, umbral);
  // 07-10: sin clave en producción NO se simula (el simulador inventaba frases y el bot le respondía eso a un
  // cliente real). Falla y el vendedor le pide que lo escriba.
  if (!apiKey) return fallo("sin_clave_transcripcion");

  const palabras = limpiarPalabrasClave(opciones.palabrasClave ?? PALABRAS_CLAVE_POR_DEFECTO);
  const form = new FormData();
  form.append("model_id", MODELO_SCRIBE);
  form.append("language_code", opciones.idioma ?? "spa");
  form.append("tag_audio_events", "false");
  for (const p of palabras) form.append("keyterms", p);
  const tipo = (mime ?? "").split(";")[0].trim() || "application/octet-stream";
  form.append("file", new Blob([bytes as BlobPart], { type: tipo }), `audio.${extension(mime)}`);

  const f = opciones.fetch ?? fetch;
  try {
    const r = await f(URL_SCRIBE, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(opciones.timeoutMs ?? 30_000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) {
      const det = j?.detail;
      const msg = typeof det === "string" ? det : det?.message ?? (Array.isArray(det) ? det[0]?.msg : null);
      return fallo(`scribe ${r.status}${msg ? `: ${msg}` : ""}`);
    }
    const texto = typeof j.text === "string" ? j.text.trim() : "";
    const confianza = texto ? calcularConfianza(j.words) : 0;
    const duracion = typeof j.audio_duration_secs === "number" ? j.audio_duration_secs : null;
    const tarifas = duracion != null ? await resolverTarifas(opciones) : undefined;
    return {
      ok: true,
      texto,
      confianza,
      confianzaBaja: !texto || confianza < umbral,
      simulado: false,
      idioma: j.language_code ?? null,
      duracionSeg: duracion,
      costoUsd: duracion != null ? costoScribe(duracion, palabras.length > 0, tarifas) : undefined,
    };
  } catch (e) {
    return fallo(`red: ${e instanceof Error ? e.message : String(e)}`);
  }
}
