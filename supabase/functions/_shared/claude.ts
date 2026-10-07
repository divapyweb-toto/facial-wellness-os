// _shared/claude.ts · Dueño: G1 (ola 2, vendedor con IA)
// Llamadas a la Messages API y a la Message Batches API de Anthropic con fetch directo (sin SDK).
// Verificado contra la documentación oficial el 06-10-2026:
//   - POST https://api.anthropic.com/v1/messages, headers x-api-key + anthropic-version: 2023-06-01.
//   - Prompt caching: cache_control {type:"ephemeral", ttl:"1h"} sin header beta; máx. 4 breakpoints;
//     lo de 1 h tiene que ir antes que lo de 5 min. Mínimo cacheable: Haiku 4.5 = 4.096 tokens,
//     Sonnet 5.5 = 512 tokens (por debajo no falla: simplemente no cachea).
//   - Batches: POST /v1/messages/batches {requests:[{custom_id, params}]}, GET /v1/messages/batches/{id}
//     (processing_status 'in_progress' | 'canceling' | 'ended', results_url), resultados en JSONL
//     {custom_id, result:{type:'succeeded'|'errored'|'canceled'|'expired', message?}}. 50 % de descuento.
//   - Sonnet 5.5: no acepta thinking {type:"disabled"} ni tool_choice any/tool; con pensamiento adaptativo
//     hay que devolver los bloques `thinking` sin tocar dentro del bucle de herramientas (se hace: se
//     agrega `contenido` completo). Haiku 4.5: sin `thinking` ni `effort` (effort da error en Haiku 4.5).
//   - Salida estructurada (GA, sin header beta): output_config.format = {type:"json_schema", schema}. La aceptan
//     Haiku 4.5 y Sonnet 5.5, también en el Batch API. No se combina con prefill del asistente ni con citas.
//     Esquema: todo objeto con additionalProperties:false; sin minLength/maxLength/minimum/maximum (la
//     validación de largos y rangos sigue del lado nuestro).
//
// Precios: NUNCA en el código. Se leen de config_wa.precios_claude (USD por millón de tokens).
// Modo simulado: sin ANTHROPIC_API_KEY o con MODO_SIMULADO=1 responde un simulador determinista.

export const ANTHROPIC_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";

// ---------- tipos ----------

export type BloqueTexto = { type: "text"; text: string; cache_control?: CacheControl };
export type BloqueToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type BloqueToolResult = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
/** Cualquier otro bloque (thinking, fallback, etc.) se conserva tal cual para devolverlo a la API. */
export type BloqueOtro = { type: string; [k: string]: unknown };
export type Bloque = BloqueTexto | BloqueToolUse | BloqueToolResult | BloqueOtro;

export type Mensaje = { role: "user" | "assistant"; content: string | Bloque[] };

export type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

export type Herramienta = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
};

export type Uso = {
  entrada: number;
  salida: number;
  cache_lectura: number;
  cache_escritura: number;
  cache_escritura_1h?: number;
  cache_escritura_5m?: number;
};

/** USD por millón de tokens (config_wa.precios_claude[modelo]). */
export type PrecioModelo = {
  entrada: number;
  salida: number;
  cache_escritura_5m: number;
  cache_escritura_1h: number;
  cache_lectura: number;
  /** Multiplicador del Batch API (0.5 = 50 % de descuento). */
  lote?: number;
};
export type TablaPrecios = Record<string, PrecioModelo>;

export type PedidoClaude = {
  modelo: string;
  system: string | BloqueTexto[];
  mensajes: Mensaje[];
  herramientas?: Herramienta[];
  maxTokens?: number;
  /** true: cachea system y herramientas con TTL `ttlCache` (1 h por defecto) y el resto con caché automática. */
  cache?: boolean;
  ttlCache?: "5m" | "1h";
  /** Esfuerzo (output_config.effort). Se ignora en Haiku 4.5, que no lo acepta. */
  esfuerzo?: "low" | "medium" | "high";
  /** Sonnet 5.5 en la API de Claude: reintento del lado del servidor ante una negativa (fallbacks:"default"). */
  fallbackServidor?: boolean;
  /**
   * Salida estructurada (output_config.format json_schema). Opcional: quien llama igual valida la respuesta.
   * No usar junto con prefill (un mensaje final del asistente): la API lo rechaza.
   */
  esquemaJson?: Record<string, unknown>;
};

export type RespuestaClaude = {
  contenido: Bloque[];
  stop_reason: string | null;
  uso: Uso;
  costo_usd: number;
  simulado: boolean;
  modelo: string;
};

export class ErrorClaude extends Error {
  constructor(mensaje: string, public status?: number, public reintentable = false) {
    super(mensaje);
  }
}

// ---------- entorno (inyectable en tests) ----------

export type EntornoClaude = {
  fetch: typeof fetch;
  apiKey: () => string | undefined;
  modoSimulado: () => boolean;
  precios: () => Promise<TablaPrecios | null>;
  dormir: (ms: number) => Promise<void>;
};

let cachePrecios: { tabla: TablaPrecios | null; hasta: number } | null = null;

async function preciosDesdeConfig(): Promise<TablaPrecios | null> {
  if (cachePrecios && cachePrecios.hasta > Date.now()) return cachePrecios.tabla;
  const { db } = await import("./db.ts");
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "precios_claude").maybeSingle();
  if (error) {
    console.error("config_wa.precios_claude:", error.message);
    return null;
  }
  const tabla = (data?.valor ?? null) as TablaPrecios | null;
  cachePrecios = { tabla, hasta: Date.now() + 5 * 60_000 };
  return tabla;
}

const entornoPorDefecto: EntornoClaude = {
  fetch: (...a) => fetch(...a),
  apiKey: () => Deno.env.get("ANTHROPIC_API_KEY"),
  modoSimulado: () => Deno.env.get("MODO_SIMULADO") === "1" || !Deno.env.get("ANTHROPIC_API_KEY"),
  precios: preciosDesdeConfig,
  dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let entorno: EntornoClaude = entornoPorDefecto;

/** Solo para tests: reemplaza dependencias. Sin argumentos vuelve al entorno real. */
export function _configurarClaude(parcial?: Partial<EntornoClaude>): void {
  entorno = parcial ? { ...entornoPorDefecto, ...parcial } : entornoPorDefecto;
  cachePrecios = null;
}

export function esModoSimulado(): boolean {
  return entorno.modoSimulado();
}

// ---------- costo (puro) ----------

/** Precio del modelo; acepta el ID con fecha o el alias (claude-haiku-4-5-20251001 → claude-haiku-4-5). */
export function precioDe(modelo: string, tabla: TablaPrecios | null | undefined): PrecioModelo | null {
  if (!tabla) return null;
  if (tabla[modelo]) return tabla[modelo];
  const sinFecha = modelo.replace(/-\d{8}$/, "");
  if (tabla[sinFecha]) return tabla[sinFecha];
  const conFecha = Object.keys(tabla).find((k) => k.replace(/-\d{8}$/, "") === sinFecha);
  return conFecha ? tabla[conFecha] : null;
}

/**
 * Costo en USD de una respuesta. Si la API no separa la escritura de caché por TTL,
 * se cobra toda al TTL pedido (`ttlPorDefecto`). `lote` aplica el descuento del Batch API.
 * Sin precio conocido devuelve null (quien llama lo registra y avisa).
 */
export function calcularCostoUsd(
  uso: Uso,
  precio: PrecioModelo | null,
  opciones: { lote?: boolean; ttlPorDefecto?: "5m" | "1h" } = {},
): number | null {
  if (!precio) return null;
  const e1h = uso.cache_escritura_1h ?? (opciones.ttlPorDefecto === "5m" ? 0 : uso.cache_escritura);
  const e5m = uso.cache_escritura_5m ?? (uso.cache_escritura - e1h);
  const usd = (uso.entrada * precio.entrada +
    uso.salida * precio.salida +
    uso.cache_lectura * precio.cache_lectura +
    Math.max(e1h, 0) * precio.cache_escritura_1h +
    Math.max(e5m, 0) * precio.cache_escritura_5m) / 1_000_000;
  const mult = opciones.lote ? (precio.lote ?? 0.5) : 1;
  return Math.round(usd * mult * 1e8) / 1e8;
}

export function sumarUso(a: Uso, b: Uso): Uso {
  return {
    entrada: a.entrada + b.entrada,
    salida: a.salida + b.salida,
    cache_lectura: a.cache_lectura + b.cache_lectura,
    cache_escritura: a.cache_escritura + b.cache_escritura,
    cache_escritura_1h: (a.cache_escritura_1h ?? 0) + (b.cache_escritura_1h ?? 0),
    cache_escritura_5m: (a.cache_escritura_5m ?? 0) + (b.cache_escritura_5m ?? 0),
  };
}

export const USO_CERO: Uso = { entrada: 0, salida: 0, cache_lectura: 0, cache_escritura: 0, cache_escritura_1h: 0, cache_escritura_5m: 0 };

function usoDesdeApi(u: Record<string, unknown> | undefined): Uso {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const cc = (u?.cache_creation ?? null) as Record<string, unknown> | null;
  return {
    entrada: n(u?.input_tokens),
    salida: n(u?.output_tokens),
    cache_lectura: n(u?.cache_read_input_tokens),
    cache_escritura: n(u?.cache_creation_input_tokens),
    ...(cc
      ? { cache_escritura_1h: n(cc.ephemeral_1h_input_tokens), cache_escritura_5m: n(cc.ephemeral_5m_input_tokens) }
      : {}),
  };
}

// ---------- armado del cuerpo (puro) ----------

export function esHaiku(modelo: string): boolean {
  return /haiku/i.test(modelo);
}

export function esSonnet55(modelo: string): boolean {
  return /^claude-sonnet-5-5(\b|-|$)/.test(modelo);
}

/** Cuerpo de /v1/messages. Exportado para tests y para el Batch API (sin fallbacks: el Batch lo rechaza). */
export function armarCuerpo(p: PedidoClaude, paraLote = false): { cuerpo: Record<string, unknown>; betas: string[] } {
  const ttl = p.ttlCache ?? "1h";
  const cc: CacheControl = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const system: BloqueTexto[] = typeof p.system === "string" ? [{ type: "text", text: p.system }] : p.system.map((b) => ({ ...b }));
  const tools = (p.herramientas ?? []).map((h) => ({ ...h }));
  if (p.cache) {
    // Breakpoint 1: herramientas (van primero en el prefijo). Breakpoint 2: primer bloque del system
    // (el estable); los bloques siguientes del system son variables (fecha, cliente) y no se marcan.
    if (tools.length) tools[tools.length - 1].cache_control = cc;
    if (system.length && !system.some((b) => b.cache_control)) system[0].cache_control = cc;
  }
  const cuerpo: Record<string, unknown> = {
    model: p.modelo,
    max_tokens: p.maxTokens ?? 1024,
    system,
    messages: p.mensajes,
  };
  if (tools.length) cuerpo.tools = tools;
  // Caché automática (5 min) para la cola de la conversación: abarata las vueltas del bucle de herramientas.
  // Va después de los marcadores de 1 h (regla de orden: el TTL más largo primero).
  if (p.cache) cuerpo.cache_control = { type: "ephemeral" };
  const betas: string[] = [];
  const outputConfig: Record<string, unknown> = {};
  if (p.esfuerzo && !esHaiku(p.modelo)) outputConfig.effort = p.esfuerzo;
  if (p.esquemaJson) outputConfig.format = { type: "json_schema", schema: p.esquemaJson };
  if (Object.keys(outputConfig).length) cuerpo.output_config = outputConfig;
  if (!paraLote && p.fallbackServidor && esSonnet55(p.modelo)) {
    cuerpo.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  return { cuerpo, betas };
}

export function textoDe(contenido: Bloque[]): string {
  return contenido.filter((b): b is BloqueTexto => b.type === "text" && typeof (b as BloqueTexto).text === "string")
    .map((b) => b.text).join("\n").trim();
}

export function usosDeHerramientas(contenido: Bloque[]): BloqueToolUse[] {
  return contenido.filter((b): b is BloqueToolUse => b.type === "tool_use");
}

// ---------- simulador determinista ----------

const PALABRAS_SALUD_SIM = ["apnea", "embaraz", "medicac", "pastilla", "enfermedad", "presion", "asma", "me cura", "cura"];

function normalizarSim(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function ultimoTextoUsuario(mensajes: Mensaje[]): string {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const t = m.content.filter((b) => b.type === "text").map((b) => (b as BloqueTexto).text).join(" ");
    if (t) return t;
    return "";
  }
  return "";
}

/**
 * Simulador: decide por palabras clave del último mensaje del cliente.
 * - Si la última entrada son resultados de herramientas → responde con texto usando el primer precio del catálogo.
 * - Salud → derivar_a_enrique. Precio/cuánto → consultar_catalogo. Resto → saludo con pregunta.
 */
export function simularRespuesta(p: PedidoClaude): RespuestaClaude {
  const ultimo = p.mensajes[p.mensajes.length - 1];
  const nombres = new Set((p.herramientas ?? []).map((h) => h.name));
  const uso: Uso = { ...USO_CERO, entrada: 0, salida: 0 };
  const base = { uso, costo_usd: 0, simulado: true, modelo: p.modelo };
  if (ultimo && Array.isArray(ultimo.content) && ultimo.content.some((b) => b.type === "tool_result")) {
    const res = ultimo.content.find((b) => b.type === "tool_result") as BloqueToolResult;
    let texto = "Listo, ya quedó. ¿Te ayudo con algo más?";
    try {
      const j = JSON.parse(res.content);
      const prod = j?.productos?.[0];
      if (prod?.precio_texto) {
        texto = `${prod.titulo} sale Gs ${prod.precio_texto} + envío Gs ${j.envio_texto} = Gs ${prod.total_texto}, pagás al recibir. ¿Te lo preparo?`;
      } else if (j?.derivado) texto = "";
    } catch { /* texto por defecto */ }
    return { ...base, contenido: texto ? [{ type: "text", text: texto }] : [], stop_reason: "end_turn" };
  }
  const t = normalizarSim(ultimoTextoUsuario(p.mensajes));
  if (nombres.has("derivar_a_enrique") && PALABRAS_SALUD_SIM.some((w) => t.includes(w))) {
    return {
      ...base,
      contenido: [{
        type: "tool_use",
        id: "sim_tool_1",
        name: "derivar_a_enrique",
        input: { motivo: "salud", resumen: `Consulta de salud: ${t.slice(0, 120)}` },
      }],
      stop_reason: "tool_use",
    };
  }
  if (nombres.has("consultar_catalogo") && /(precio|cuanto|sale|costo|vale)/.test(t)) {
    return {
      ...base,
      contenido: [{ type: "tool_use", id: "sim_tool_1", name: "consultar_catalogo", input: {} }],
      stop_reason: "tool_use",
    };
  }
  return {
    ...base,
    contenido: [{ type: "text", text: "¡Hola! Contame qué estás buscando y te paso precio y envío." }],
    stop_reason: "end_turn",
  };
}

// ---------- llamada real ----------

function headers(apiKey: string, betas: string[]): Record<string, string> {
  const h: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  if (betas.length) h["anthropic-beta"] = betas.join(",");
  return h;
}

/**
 * Una llamada a /v1/messages. Reintenta una vez ante 429, 5xx, 529 o error de red.
 * Lanza ErrorClaude si falla (el orquestador deriva a Enrique).
 */
export async function llamarClaude(p: PedidoClaude): Promise<RespuestaClaude> {
  if (entorno.modoSimulado()) {
    console.log("claude: modo simulado (sin ANTHROPIC_API_KEY o MODO_SIMULADO=1)");
    return simularRespuesta(p);
  }
  const apiKey = entorno.apiKey();
  if (!apiKey) throw new ErrorClaude("falta ANTHROPIC_API_KEY");
  const { cuerpo, betas } = armarCuerpo(p);

  let ultimoError: ErrorClaude | null = null;
  for (let intento = 0; intento < 2; intento++) {
    if (intento > 0) await entorno.dormir(1500);
    let r: Response;
    try {
      r = await entorno.fetch(`${ANTHROPIC_URL}/messages`, {
        method: "POST",
        headers: headers(apiKey, betas),
        body: JSON.stringify(cuerpo),
      });
    } catch (e) {
      ultimoError = new ErrorClaude(`red: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      continue;
    }
    const j = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (!r.ok) {
      const err = (j.error ?? {}) as { type?: string; message?: string };
      const reintentable = r.status === 429 || r.status >= 500;
      ultimoError = new ErrorClaude(`HTTP ${r.status} ${err.type ?? ""}: ${err.message ?? "error"}`, r.status, reintentable);
      if (!reintentable) break;
      continue;
    }
    const uso = usoDesdeApi(j.usage as Record<string, unknown> | undefined);
    const precio = precioDe(p.modelo, await entorno.precios());
    const costo = calcularCostoUsd(uso, precio, { ttlPorDefecto: p.ttlCache ?? "1h" });
    if (costo === null) console.warn(`claude: sin precio para ${p.modelo} en config_wa.precios_claude`);
    return {
      contenido: (j.content ?? []) as Bloque[],
      stop_reason: (j.stop_reason ?? null) as string | null,
      uso,
      costo_usd: costo ?? 0,
      simulado: false,
      modelo: String(j.model ?? p.modelo),
    };
  }
  throw ultimoError ?? new ErrorClaude("falla desconocida");
}

// ---------- Batch API ----------

export type PedidoLote = { custom_id: string; pedido: PedidoClaude };
export type ResultadoLote = {
  custom_id: string;
  tipo: "succeeded" | "errored" | "canceled" | "expired";
  contenido: Bloque[];
  texto: string;
  uso: Uso;
  costo_usd: number;
  error?: string;
};
export type EstadoLote = {
  id: string;
  estado: "in_progress" | "canceling" | "ended";
  resultados?: ResultadoLote[];
  simulado: boolean;
};

/**
 * Crea un lote (50 % más barato, responde en < 24 h). Con `esperar` consulta cada `cadaMs`
 * hasta que termina o hasta `maxEsperaMs` (en una Edge Function conviene no esperar y consultar después).
 */
export async function llamarClaudeLote(
  pedidos: PedidoLote[],
  opciones: { esperar?: boolean; maxEsperaMs?: number; cadaMs?: number } = {},
): Promise<EstadoLote> {
  if (!pedidos.length) throw new ErrorClaude("lote vacío");
  if (entorno.modoSimulado()) {
    console.log("claude lote: modo simulado");
    return {
      id: `msgbatch_simulado_${pedidos.length}`,
      estado: "ended",
      simulado: true,
      resultados: pedidos.map((x) => {
        const r = simularRespuesta(x.pedido);
        return { custom_id: x.custom_id, tipo: "succeeded", contenido: r.contenido, texto: textoDe(r.contenido), uso: r.uso, costo_usd: 0 };
      }),
    };
  }
  const apiKey = entorno.apiKey();
  if (!apiKey) throw new ErrorClaude("falta ANTHROPIC_API_KEY");
  const modelos = new Map(pedidos.map((x) => [x.custom_id, x.pedido]));
  const requests = pedidos.map((x) => ({ custom_id: x.custom_id, params: armarCuerpo(x.pedido, true).cuerpo }));
  const r = await entorno.fetch(`${ANTHROPIC_URL}/messages/batches`, {
    method: "POST",
    headers: headers(apiKey, []),
    body: JSON.stringify({ requests }),
  });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) {
    const err = (j.error ?? {}) as { message?: string };
    throw new ErrorClaude(`lote HTTP ${r.status}: ${err.message ?? "error"}`, r.status);
  }
  let estado: EstadoLote = { id: String(j.id), estado: j.processing_status as EstadoLote["estado"], simulado: false };
  if (!opciones.esperar) return estado;
  const limite = Date.now() + (opciones.maxEsperaMs ?? 120_000);
  while (estado.estado !== "ended" && Date.now() < limite) {
    await entorno.dormir(opciones.cadaMs ?? 10_000);
    estado = await consultarLote(estado.id, modelos);
  }
  return estado;
}

/** Estado de un lote; si terminó, trae y parsea los resultados (JSONL). */
export async function consultarLote(id: string, modelos?: Map<string, PedidoClaude>): Promise<EstadoLote> {
  if (id.startsWith("msgbatch_simulado_")) return { id, estado: "ended", simulado: true, resultados: [] };
  const apiKey = entorno.apiKey();
  if (!apiKey) throw new ErrorClaude("falta ANTHROPIC_API_KEY");
  const r = await entorno.fetch(`${ANTHROPIC_URL}/messages/batches/${encodeURIComponent(id)}`, { headers: headers(apiKey, []) });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) throw new ErrorClaude(`consultar lote HTTP ${r.status}`, r.status);
  const estado = j.processing_status as EstadoLote["estado"];
  if (estado !== "ended" || typeof j.results_url !== "string") return { id, estado, simulado: false };
  const rr = await entorno.fetch(j.results_url, { headers: headers(apiKey, []) });
  if (!rr.ok) throw new ErrorClaude(`resultados lote HTTP ${rr.status}`, rr.status);
  const tabla = await entorno.precios();
  const resultados = parsearResultadosLote(await rr.text(), (cid) => modelos?.get(cid)?.modelo ?? null, tabla);
  return { id, estado, simulado: false, resultados };
}

/** JSONL de resultados → filas con costo (precio de lote). Puro: se prueba sin red. */
export function parsearResultadosLote(
  jsonl: string,
  modeloDe: (customId: string) => string | null,
  tabla: TablaPrecios | null,
): ResultadoLote[] {
  const out: ResultadoLote[] = [];
  for (const linea of jsonl.split("\n")) {
    if (!linea.trim()) continue;
    let fila: { custom_id?: string; result?: { type?: string; message?: Record<string, unknown>; error?: unknown } };
    try {
      fila = JSON.parse(linea);
    } catch {
      continue;
    }
    const tipo = (fila.result?.type ?? "errored") as ResultadoLote["tipo"];
    const msg = fila.result?.message;
    const contenido = (msg?.content ?? []) as Bloque[];
    const uso = usoDesdeApi(msg?.usage as Record<string, unknown> | undefined);
    const modelo = (msg?.model as string | undefined) ?? modeloDe(fila.custom_id ?? "") ?? "";
    out.push({
      custom_id: fila.custom_id ?? "",
      tipo,
      contenido,
      texto: textoDe(contenido),
      uso,
      costo_usd: calcularCostoUsd(uso, precioDe(modelo, tabla), { lote: true }) ?? 0,
      ...(tipo !== "succeeded" ? { error: JSON.stringify(fila.result?.error ?? tipo) } : {}),
    });
  }
  return out;
}
