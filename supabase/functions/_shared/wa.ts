// Módulo de WhatsApp Cloud API (Graph v25.0) · dueño: subagente B (ola 1).
// Todo envío pasa por el filtro de palabras prohibidas (config_wa.palabras_prohibidas)
// y queda registrado en wa_mensajes (dirección 'out').
//
// Destinatario (`to`): teléfono con código de país ('+595981000000' o '595981000000')
// o un identificador de usuario por negocio (BSUID, p. ej. 'PY.1234567890'). Según la
// documentación de Meta, al BSUID se le escribe con el campo `recipient`, no con `to`.

import { contienePalabraProhibida } from "./filtro.ts";
import { db } from "./db.ts";

export const GRAPH_URL = "https://graph.facebook.com/v25.0";

export type ResultadoEnvio = { ok: boolean; wa_message_id?: string; error?: string };
export type Boton = { id: string; titulo: string };
/** Opcional: si quien llama ya conoce cliente y conversación, se evita buscarlos. */
export type OpcionesEnvio = { clienteId?: string | null; conversacionId?: string | null };

export type FilaMensajeSaliente = {
  conversacion_id: string | null;
  cliente_id: string | null;
  direccion: "out";
  wa_message_id: string | null;
  tipo: string;
  texto: string | null;
  contenido: unknown;
  estado: "enviado" | "fallido";
  error: unknown;
};

/** Dependencias de I/O; los tests las reemplazan con `_configurarWA`. */
export type EntornoWA = {
  fetch: typeof fetch;
  token: () => string | undefined;
  phoneNumberId: () => string | undefined;
  palabrasProhibidas: () => Promise<string[] | null>;
  registrar: (fila: FilaMensajeSaliente) => Promise<void>;
  resolverDestino: (to: string) => Promise<{ clienteId: string | null; conversacionId: string | null }>;
};

// ---------- firma del webhook ----------

const enc = new TextEncoder();

/** Valida `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(cuerpo crudo, app secret). */
export async function verificarFirmaMeta(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!header || !appSecret) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const clave = await crypto.subtle.importKey(
    "raw",
    enc.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const datos = typeof rawBody === "string" ? enc.encode(rawBody) : rawBody;
  const firma = new Uint8Array(await crypto.subtle.sign("HMAC", clave, datos as BufferSource));
  const esperado = Array.from(firma, (b) => b.toString(16).padStart(2, "0")).join("");
  return compararSeguro(esperado, m[1].toLowerCase());
}

function compararSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- destinatario ----------

/** Teléfono → {to: dígitos}; BSUID → {recipient}. Teléfono local sin código de país → error. */
export function destinatario(to: string): { to: string } | { recipient: string } | { error: string } {
  const t = (to ?? "").trim();
  if (!t) return { error: "destinatario_vacio" };
  const digitos = t.replace(/[\s-]/g, "");
  if (/^\+?\d+$/.test(digitos)) {
    const d = digitos.replace(/^\+/, "");
    if (d.startsWith("0")) return { error: "telefono_sin_codigo_pais" };
    if (d.length < 8 || d.length > 15) return { error: "telefono_invalido" };
    return { to: d };
  }
  return { recipient: t };
}

// ---------- entorno por defecto ----------

let cachePalabras: { lista: string[]; hasta: number } | null = null;

function listaDesdeValor(valor: unknown): string[] | null {
  if (Array.isArray(valor)) return valor.filter((x) => typeof x === "string");
  if (valor && typeof valor === "object" && Array.isArray((valor as { lista?: unknown }).lista)) {
    return ((valor as { lista: unknown[] }).lista).filter((x) => typeof x === "string") as string[];
  }
  return null;
}

const entornoPorDefecto: EntornoWA = {
  fetch: (...a) => fetch(...a),
  token: () => Deno.env.get("WA_TOKEN"),
  phoneNumberId: () => Deno.env.get("WA_PHONE_NUMBER_ID"),
  palabrasProhibidas: async () => {
    if (cachePalabras && cachePalabras.hasta > Date.now()) return cachePalabras.lista;
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", "palabras_prohibidas")
      .maybeSingle();
    if (error) return null;
    const lista = listaDesdeValor(data?.valor);
    if (lista) cachePalabras = { lista, hasta: Date.now() + 5 * 60_000 };
    return lista;
  },
  registrar: async (fila) => {
    const { error } = await db().from("wa_mensajes").insert(fila);
    if (error) console.error("wa_mensajes insert (out):", error.message);
  },
  resolverDestino: async (to) => {
    const d = destinatario(to);
    let clienteId: string | null = null;
    if ("to" in d) {
      const { data } = await db().from("wa_clientes").select("id").eq("telefono", `+${d.to}`).maybeSingle();
      clienteId = data?.id ?? null;
    } else if ("recipient" in d) {
      const { data } = await db().from("wa_clientes").select("id").eq("wa_user_id", d.recipient).maybeSingle();
      clienteId = data?.id ?? null;
    }
    if (!clienteId) return { clienteId: null, conversacionId: null };
    const { data: conv } = await db().from("wa_conversaciones").select("id").eq("cliente_id", clienteId)
      .neq("estado", "cerrada").order("creado_en", { ascending: false }).limit(1).maybeSingle();
    return { clienteId, conversacionId: conv?.id ?? null };
  },
};

let entorno: EntornoWA = entornoPorDefecto;

/** Solo para tests: reemplaza dependencias. Llamar sin argumentos para volver al real. */
export function _configurarWA(parcial?: Partial<EntornoWA>): void {
  entorno = parcial ? { ...entornoPorDefecto, ...parcial } : entornoPorDefecto;
  cachePalabras = null;
}

// ---------- núcleo de envío ----------

async function filtrar(textos: string[]): Promise<string | null> {
  const lista = await entorno.palabrasProhibidas();
  // Sin lista no se puede asegurar el filtro: no se manda (falla cerrado).
  if (!lista) return "config_palabras_prohibidas_no_disponible";
  for (const t of textos) {
    if (!t) continue;
    const p = contienePalabraProhibida(t, lista);
    if (p) return `palabra_prohibida:${p}`;
  }
  return null;
}

async function enviar(
  to: string,
  tipo: string,
  cuerpo: Record<string, unknown>,
  textoVisible: string | null,
  textosAFiltrar: string[],
  opciones?: OpcionesEnvio,
): Promise<ResultadoEnvio> {
  const dest = destinatario(to);
  const payload = { messaging_product: "whatsapp", recipient_type: "individual", ...dest, type: tipo, ...cuerpo };

  let resultado: ResultadoEnvio;
  let errorDetalle: unknown = null;

  const bloqueo = "error" in dest ? dest.error : await filtrar(textosAFiltrar);
  if (bloqueo) {
    resultado = { ok: false, error: bloqueo };
    errorDetalle = { motivo: bloqueo };
  } else {
    const g = await postGraph(payload);
    resultado = g.ok ? { ok: true, wa_message_id: g.wa_message_id } : { ok: false, error: g.error };
    if (!g.ok) errorDetalle = { motivo: g.error, respuesta: g.raw ?? null };
  }

  // Registro en wa_mensajes (también los bloqueados/fallidos, para verlos en la bandeja).
  try {
    let clienteId = opciones?.clienteId ?? null;
    let conversacionId = opciones?.conversacionId ?? null;
    if (!clienteId || !conversacionId) {
      const r = await entorno.resolverDestino(to);
      clienteId = clienteId ?? r.clienteId;
      conversacionId = conversacionId ?? r.conversacionId;
    }
    await entorno.registrar({
      conversacion_id: conversacionId,
      cliente_id: clienteId,
      direccion: "out",
      wa_message_id: resultado.wa_message_id ?? null,
      tipo,
      texto: textoVisible,
      contenido: payload,
      estado: resultado.ok ? "enviado" : "fallido",
      error: errorDetalle,
    });
  } catch (e) {
    console.error("registro de mensaje saliente falló:", e);
  }
  return resultado;
}

async function postGraph(payload: Record<string, unknown>): Promise<ResultadoEnvio & { raw?: unknown }> {
  const token = entorno.token();
  const phoneId = entorno.phoneNumberId();
  if (!token || !phoneId) return { ok: false, error: "faltan_WA_TOKEN_o_WA_PHONE_NUMBER_ID" };
  try {
    const r = await entorno.fetch(`${GRAPH_URL}/${phoneId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) {
      const e = j?.error ?? {};
      return { ok: false, error: `${e.code ?? r.status}: ${e.message ?? "error_graph"}`, raw: j };
    }
    return { ok: true, wa_message_id: j?.messages?.[0]?.id, raw: j };
  } catch (e) {
    return { ok: false, error: `red: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Junta todos los textos visibles de los componentes de una plantilla (parámetros tipo text). */
function textosDeComponentes(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => textosDeComponentes(v, out));
  else if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (k === "text" && typeof v === "string") out.push(v);
      else if (k !== "payload") textosDeComponentes(v, out);
    }
  }
  return out;
}

// ---------- API pública (contrato) ----------

export function enviarPlantilla(
  to: string,
  nombre: string,
  idioma: string,
  componentes: unknown[] = [],
  opciones?: OpcionesEnvio,
): Promise<ResultadoEnvio> {
  const template: Record<string, unknown> = { name: nombre, language: { code: idioma } };
  if (componentes.length) template.components = componentes;
  const textos = textosDeComponentes(componentes);
  return enviar(to, "template", { template }, `[plantilla ${nombre}] ${textos.join(" | ")}`.trim(), textos, opciones);
}

export function enviarTexto(to: string, texto: string, opciones?: OpcionesEnvio): Promise<ResultadoEnvio> {
  if (!texto?.trim()) return Promise.resolve({ ok: false, error: "texto_vacio" });
  if (texto.length > 4096) return Promise.resolve({ ok: false, error: "texto_mayor_a_4096" });
  return enviar(to, "text", { text: { body: texto, preview_url: false } }, texto, [texto], opciones);
}

export function enviarBotones(
  to: string,
  texto: string,
  botones: Boton[],
  opciones?: OpcionesEnvio,
): Promise<ResultadoEnvio> {
  // Límites de Meta para botones de respuesta: 1 a 3 botones, título ≤ 20, id ≤ 256, cuerpo ≤ 1024.
  if (!texto?.trim() || texto.length > 1024) return Promise.resolve({ ok: false, error: "cuerpo_invalido" });
  if (!botones?.length || botones.length > 3) return Promise.resolve({ ok: false, error: "botones_1_a_3" });
  for (const b of botones) {
    if (!b.titulo || b.titulo.length > 20) return Promise.resolve({ ok: false, error: `titulo_invalido:${b.titulo}` });
    if (!b.id || b.id.length > 256) return Promise.resolve({ ok: false, error: `id_invalido:${b.id}` });
  }
  const interactive = {
    type: "button",
    body: { text: texto },
    action: { buttons: botones.map((b) => ({ type: "reply", reply: { id: b.id, title: b.titulo } })) },
  };
  return enviar(
    to,
    "interactive",
    { interactive },
    `${texto}\n[${botones.map((b) => b.titulo).join("] [")}]`,
    [texto, ...botones.map((b) => b.titulo)],
    opciones,
  );
}

/** Marca el mensaje entrante como leído y muestra "escribiendo…" (Meta lo apaga solo a los 25 s o al responder). */
export async function marcarLeidoYEscribiendo(messageId: string): Promise<ResultadoEnvio> {
  if (!messageId) return { ok: false, error: "message_id_vacio" };
  const r = await postGraph({
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  });
  return { ok: r.ok, error: r.error };
}

/** Descarga un archivo de Meta: GET /{media-id} → url (vence a los 5 min) → GET url con Bearer. */
export async function descargarMedia(
  mediaId: string,
): Promise<{ ok: true; bytes: Uint8Array; mime: string } | { ok: false; error: string }> {
  const token = entorno.token();
  if (!token) return { ok: false, error: "falta_WA_TOKEN" };
  const auth = { Authorization: `Bearer ${token}` };
  const r1 = await entorno.fetch(`${GRAPH_URL}/${mediaId}`, { headers: auth });
  const meta = await r1.json().catch(() => ({}));
  if (!r1.ok || !meta?.url) return { ok: false, error: `media_info ${r1.status}: ${meta?.error?.message ?? ""}` };
  const r2 = await entorno.fetch(meta.url, { headers: auth });
  if (!r2.ok) return { ok: false, error: `media_descarga ${r2.status}` };
  return { ok: true, bytes: new Uint8Array(await r2.arrayBuffer()), mime: meta.mime_type ?? "application/octet-stream" };
}
