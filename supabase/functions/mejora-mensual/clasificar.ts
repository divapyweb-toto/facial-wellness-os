// mejora-mensual/clasificar.ts · Dueño: M1
// Clasificación de conversaciones (ya anonimizadas) con Haiku 4.5 por Batch API.
//
// Verificado en la documentación oficial de Anthropic el 06-10-2026:
//   - Batch: POST /v1/messages/batches {requests:[{custom_id, params}]}; custom_id ^[a-zA-Z0-9_-]{1,64}$;
//     hasta 100.000 pedidos o 256 MB por lote; casi todos terminan en < 1 h, vencen a las 24 h;
//     resultados JSONL disponibles 29 días, en CUALQUIER orden (se cruzan por custom_id);
//     tipos succeeded | errored | canceled | expired (los tres últimos no se cobran). 50 % de descuento.
//   - Haiku 4.5 (claude-haiku-4-5-20251001): USD 1 / 5 por millón (entrada / salida); en lote 0,50 / 2,50.
//     Los precios NO van en el código: se leen de config_wa.precios_claude (con `lote: 0.5`).
//   - Salida estructurada (output_config.format json_schema, GA, también en Batch) en el primer intento:
//     ESQUEMA_ETIQUETAS. La validación estricta de acá sigue igual (largos, coherencia del reclamo).
//   - El reintento de las inválidas va SIN esquema y con prefill "{" (Haiku 4.5 acepta prefill; no se puede
//     combinar con el esquema): si el esquema fallara del lado de la API, el reintento usa el camino viejo.
//   - El prompt de clasificación (< 4.096 tokens) está por debajo del mínimo cacheable de Haiku 4.5: sin caché.
//
// Flujo (lo orquesta M3, reanudable entre corridas del cron):
//   armarLoteClasificacion(convs) → estimación + recorte por tope → enviarLoteClasificacion(lote) → lote_id
//   leerResultadosLote(lote_id, convs) → {validas, invalidas}; las inválidas del intento 1 →
//   armarLoteReintento(...) → enviarLoteClasificacion → leerResultadosLote; las que fallan otra vez se descartan.
import {
  type Bloque,
  consultarLote,
  esModoSimulado,
  type EstadoLote,
  llamarClaudeLote,
  type PedidoClaude,
  type PedidoLote,
  type PrecioModelo,
  type ResultadoLote,
} from "../_shared/claude.ts";
import {
  CFG_MEJORA_DEFAULT,
  type CfgMejora,
  type ConversacionParaAnalizar,
  EMOCIONES,
  ETAPAS,
  type Etiquetas,
  type PasoEscalera,
  presupuesto,
} from "./tipos.ts";

export class ErrorMejora extends Error {}

// ---------- prompt (corto y barato) ----------

export const PROMPT_CLASIFICACION = `Clasificás conversaciones de WhatsApp de una tienda paraguaya que vende con pago contra entrega. C = cliente, V = la tienda (IA o persona). Los datos personales están reemplazados por códigos como [TEL_1] o [NOMBRE_1]: ignoralos y nunca los copies.
Respondé SOLO un objeto JSON, sin texto antes ni después, con exactamente estas claves:
{"etapa":"consulta"|"interes"|"objecion"|"cierre"|"postventa"|"reclamo","objecion_principal":string|null,"respuesta_que_movio":string|null,"errores_bot":string[],"reclamo":{"hubo":boolean,"tipo":string|null,"paso_resuelto":1|2|3|4|5|null,"derivado":boolean},"emocion":"neutral"|"enojo"|"abandono"|"satisfecho","debio_derivar":boolean}
Reglas:
- etapa: la más avanzada a la que llegó la conversación.
- objecion_principal: la duda que frenó o demoró la compra, en 8 palabras o menos (ej. "precio alto", "desconfía del pago contra entrega", "demora del envío"); null si no hubo.
- respuesta_que_movio: la respuesta de V que hizo avanzar al cliente, resumida en 15 palabras o menos; null si ninguna.
- errores_bot: errores de V, máximo 3, de 8 palabras o menos cada uno (ej. "no respondió la pregunta", "dos preguntas juntas", "precio equivocado"); [] si no hubo.
- reclamo.tipo: producto, uso, danado, incompleto, equivocado, courier, demora, expectativa u otro.
- reclamo.paso_resuelto (escalera): 1 escuchar y pedir foto, 2 consejo de uso, 3 reposición, 4 compensación, 5 devolución; null si no se resolvió en la conversación.
- Si reclamo.hubo es false: tipo null, paso_resuelto null, derivado false.
- reclamo.derivado: true si el reclamo pasó a una persona.
- debio_derivar: true si hubo reclamo, enojo, tema de salud, pedido de hablar con una persona o 3 mensajes sin avance, y V no pasó el chat a una persona.`;

/** Esquema de Etiquetas para la salida estructurada (sin minLength/maxLength: los largos se validan acá). */
const TEXTO_O_NULL = { anyOf: [{ type: "string" }, { type: "null" }] };
export const ESQUEMA_ETIQUETAS: Record<string, unknown> = {
  type: "object",
  properties: {
    etapa: { type: "string", enum: [...ETAPAS] },
    objecion_principal: TEXTO_O_NULL,
    respuesta_que_movio: TEXTO_O_NULL,
    errores_bot: { type: "array", items: { type: "string" } },
    reclamo: {
      type: "object",
      properties: {
        hubo: { type: "boolean" },
        tipo: TEXTO_O_NULL,
        paso_resuelto: { anyOf: [{ type: "integer", enum: [1, 2, 3, 4, 5] }, { type: "null" }] },
        derivado: { type: "boolean" },
      },
      required: ["hubo", "tipo", "paso_resuelto", "derivado"],
      additionalProperties: false,
    },
    emocion: { type: "string", enum: [...EMOCIONES] },
    debio_derivar: { type: "boolean" },
  },
  required: ["etapa", "objecion_principal", "respuesta_que_movio", "errores_bot", "reclamo", "emocion", "debio_derivar"],
  additionalProperties: false,
};

/** Arranque de la respuesta (prefill) para Haiku en el reintento (sin esquema): fuerza que empiece el objeto JSON. */
export const PREFILL = "{";

const AVISO_REINTENTO =
  "Tu respuesta anterior no era un JSON válido con el formato pedido. Respondé SOLO el objeto JSON, con exactamente las claves indicadas.";

// ---------- custom_id ----------

const RE_CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** 'c1_<uuid>' (primer intento) o 'c2_<uuid>' (reintento). */
export function customIdDe(conversacionId: string, intento: 1 | 2): string {
  const id = `c${intento}_${conversacionId}`;
  if (!RE_CUSTOM_ID.test(id)) throw new ErrorMejora(`custom_id inválido para ${conversacionId}`);
  return id;
}

export function leerCustomId(cid: string): { conversacion_id: string; intento: 1 | 2 } | null {
  const m = /^c([12])_(.+)$/.exec(cid);
  return m ? { conversacion_id: m[2], intento: Number(m[1]) as 1 | 2 } : null;
}

// ---------- validación estricta ----------

const CLAVES = ["etapa", "objecion_principal", "respuesta_que_movio", "errores_bot", "reclamo", "emocion", "debio_derivar"];
const CLAVES_RECLAMO = ["hubo", "tipo", "paso_resuelto", "derivado"];
const MAX_OBJECION = 80;
const MAX_RESPUESTA = 160;
const MAX_ERRORES = 5;
const MAX_ERROR = 100;
const MAX_TIPO = 40;

function clavesExactas(o: Record<string, unknown>, esperadas: string[]): string | null {
  const k = Object.keys(o);
  const faltan = esperadas.filter((x) => !(x in o));
  const sobran = k.filter((x) => !esperadas.includes(x));
  if (faltan.length) return `faltan: ${faltan.join(",")}`;
  if (sobran.length) return `sobran: ${sobran.join(",")}`;
  return null;
}

function textoONull(x: unknown, max: number): x is string | null {
  return x === null || (typeof x === "string" && x.trim().length > 0 && x.length <= max);
}

export function validarEtiquetas(x: unknown): { ok: true; valor: Etiquetas } | { ok: false; motivo: string } {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, motivo: "no es objeto" };
  const o = x as Record<string, unknown>;
  const k = clavesExactas(o, CLAVES);
  if (k) return { ok: false, motivo: k };
  if (!(ETAPAS as readonly string[]).includes(o.etapa as string)) return { ok: false, motivo: "etapa" };
  if (!textoONull(o.objecion_principal, MAX_OBJECION)) return { ok: false, motivo: "objecion_principal" };
  if (!textoONull(o.respuesta_que_movio, MAX_RESPUESTA)) return { ok: false, motivo: "respuesta_que_movio" };
  if (
    !Array.isArray(o.errores_bot) || o.errores_bot.length > MAX_ERRORES ||
    !o.errores_bot.every((e) => typeof e === "string" && e.trim().length > 0 && e.length <= MAX_ERROR)
  ) return { ok: false, motivo: "errores_bot" };
  if (!(EMOCIONES as readonly string[]).includes(o.emocion as string)) return { ok: false, motivo: "emocion" };
  if (typeof o.debio_derivar !== "boolean") return { ok: false, motivo: "debio_derivar" };
  const r = o.reclamo;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, motivo: "reclamo" };
  const rr = r as Record<string, unknown>;
  const kr = clavesExactas(rr, CLAVES_RECLAMO);
  if (kr) return { ok: false, motivo: `reclamo ${kr}` };
  if (typeof rr.hubo !== "boolean" || typeof rr.derivado !== "boolean") return { ok: false, motivo: "reclamo.hubo/derivado" };
  if (!textoONull(rr.tipo, MAX_TIPO)) return { ok: false, motivo: "reclamo.tipo" };
  if (!(rr.paso_resuelto === null || (Number.isInteger(rr.paso_resuelto) && (rr.paso_resuelto as number) >= 1 && (rr.paso_resuelto as number) <= 5))) {
    return { ok: false, motivo: "reclamo.paso_resuelto" };
  }
  if (!rr.hubo && (rr.tipo !== null || rr.paso_resuelto !== null || rr.derivado)) {
    return { ok: false, motivo: "reclamo inconsistente (hubo=false con datos)" };
  }
  // Copia limpia (sin espacios de más); nunca referencias al objeto de entrada.
  const valor: Etiquetas = {
    etapa: o.etapa as Etiquetas["etapa"],
    objecion_principal: o.objecion_principal === null ? null : (o.objecion_principal as string).trim(),
    respuesta_que_movio: o.respuesta_que_movio === null ? null : (o.respuesta_que_movio as string).trim(),
    errores_bot: (o.errores_bot as string[]).map((e) => e.trim()),
    reclamo: {
      hubo: rr.hubo as boolean,
      tipo: rr.tipo === null ? null : (rr.tipo as string).trim().toLowerCase(),
      paso_resuelto: rr.paso_resuelto as PasoEscalera | null,
      derivado: rr.derivado as boolean,
    },
    emocion: o.emocion as Etiquetas["emocion"],
    debio_derivar: o.debio_derivar as boolean,
  };
  return { ok: true, valor };
}

/** Texto de la respuesta (con o sin el "{" del prefill, con o sin ```json) → objeto JSON. */
export function parsearRespuesta(texto: string): { ok: true; valor: unknown } | { ok: false; motivo: string } {
  let t = (texto ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!t) return { ok: false, motivo: "vacía" };
  if (!t.startsWith("{")) t = PREFILL + t;
  const fin = t.lastIndexOf("}");
  if (fin < 0) return { ok: false, motivo: "sin cierre" };
  try {
    return { ok: true, valor: JSON.parse(t.slice(0, fin + 1)) };
  } catch (e) {
    return { ok: false, motivo: `json: ${e instanceof Error ? e.message.slice(0, 80) : "error"}` };
  }
}

// ---------- pedidos ----------

export function armarPedidoClasificacion(conv: ConversacionParaAnalizar, cfg: CfgMejora, intento: 1 | 2 = 1): PedidoLote {
  const mensajes: PedidoClaude["mensajes"] = [
    { role: "user", content: `<conversacion>\n${conv.transcripcion}\n</conversacion>${intento === 2 ? `\n${AVISO_REINTENTO}` : ""}` },
  ];
  // Intento 1: salida estructurada. Intento 2: sin esquema y con prefill (solo Haiku lo acepta).
  const conEsquema = intento === 1;
  if (!conEsquema && /haiku/i.test(cfg.modelo_clasificacion)) mensajes.push({ role: "assistant", content: PREFILL });
  return {
    custom_id: customIdDe(conv.conversacion_id, intento),
    pedido: {
      modelo: cfg.modelo_clasificacion,
      system: PROMPT_CLASIFICACION,
      mensajes,
      maxTokens: cfg.max_tokens_clasificacion,
      cache: false,
      ...(conEsquema ? { esquemaJson: ESQUEMA_ETIQUETAS } : {}),
    },
  };
}

// ---------- estimación de costo y recorte ----------

/** Margen para el reintento de las inválidas (se reserva dentro del presupuesto). */
export const MARGEN_REINTENTO = 0.1;

export type Estimacion = { entrada_tokens: number; salida_tokens: number; usd: number };

/** Tokens y USD (precio de lote) de clasificar UNA conversación. Conservador: cobra max_tokens de salida. */
export function estimarConversacion(conv: ConversacionParaAnalizar, cfg: CfgMejora, precio: PrecioModelo): Estimacion {
  const chars = PROMPT_CLASIFICACION.length + conv.transcripcion.length + 40;
  const entrada = Math.ceil(chars / cfg.chars_por_token) + 10;
  const salida = cfg.max_tokens_clasificacion;
  const usd = ((entrada * precio.entrada + salida * precio.salida) / 1_000_000) * (precio.lote ?? 0.5);
  return { entrada_tokens: entrada, salida_tokens: salida, usd };
}

export function estimarLote(convs: ConversacionParaAnalizar[], cfg: CfgMejora, precio: PrecioModelo): Estimacion {
  const tot = { entrada_tokens: 0, salida_tokens: 0, usd: 0 };
  for (const c of convs) {
    const e = estimarConversacion(c, cfg, precio);
    tot.entrada_tokens += e.entrada_tokens;
    tot.salida_tokens += e.salida_tokens;
    tot.usd += e.usd;
  }
  return { ...tot, usd: Math.round(tot.usd * (1 + MARGEN_REINTENTO) * 1e6) / 1e6 };
}

/** Hash FNV-1a (determinista) para ordenar sin sesgo. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Muestra estratificada por (resultado, tuvo_reclamo), proporcional (mayor resto) y con al menos una por
 * estrato no vacío: así entregados, sin compra y reclamos quedan representados. Determinista por `semilla`.
 */
export function muestrear<T extends Pick<ConversacionParaAnalizar, "conversacion_id" | "resultado" | "tuvo_reclamo">>(
  convs: T[],
  n: number,
  semilla = "mejora",
): T[] {
  if (n >= convs.length) return [...convs];
  if (n <= 0) return [];
  const estratos = new Map<string, T[]>();
  for (const c of convs) {
    const k = `${c.resultado}|${c.tuvo_reclamo}`;
    if (!estratos.has(k)) estratos.set(k, []);
    estratos.get(k)!.push(c);
  }
  for (const lista of estratos.values()) lista.sort((a, b) => hash(semilla + a.conversacion_id) - hash(semilla + b.conversacion_id));
  const claves = [...estratos.keys()].sort();
  const cupo = new Map<string, number>();
  let asignado = 0;
  const minimo = n >= claves.length ? 1 : 0;
  const restos: { k: string; r: number }[] = [];
  for (const k of claves) {
    const exacto = (estratos.get(k)!.length / convs.length) * n;
    const base = Math.min(estratos.get(k)!.length, Math.max(minimo, Math.floor(exacto)));
    cupo.set(k, base);
    asignado += base;
    restos.push({ k, r: exacto - Math.floor(exacto) });
  }
  restos.sort((a, b) => b.r - a.r || a.k.localeCompare(b.k));
  // Ajuste: sumar por mayor resto o quitar a los estratos más grandes hasta llegar a n.
  let i = 0;
  while (asignado < n && i < restos.length * 4) {
    const k = restos[i % restos.length].k;
    if (cupo.get(k)! < estratos.get(k)!.length) {
      cupo.set(k, cupo.get(k)! + 1);
      asignado++;
    }
    i++;
  }
  while (asignado > n) {
    const k = claves.filter((x) => cupo.get(x)! > 1).sort((a, b) => cupo.get(b)! - cupo.get(a)!)[0] ?? claves.find((x) => cupo.get(x)! > 0)!;
    cupo.set(k, cupo.get(k)! - 1);
    asignado--;
  }
  const elegidas = new Set<string>();
  for (const k of claves) for (const c of estratos.get(k)!.slice(0, cupo.get(k))) elegidas.add(c.conversacion_id);
  return convs.filter((c) => elegidas.has(c.conversacion_id));
}

/**
 * Deja la muestra más grande que entra en `presupuestoUsd` (con margen de reintento).
 * Sin precio no se puede estimar: no recorta y lo avisa en `notas` (quien llama decide).
 */
export function recortarAlPresupuesto(
  convs: ConversacionParaAnalizar[],
  presupuestoUsd: number,
  cfg: CfgMejora,
  precio: PrecioModelo | null,
  semilla = "mejora",
): { incluidas: ConversacionParaAnalizar[]; excluidas: number; estimacion: Estimacion | null; notas: string[] } {
  if (!precio) return { incluidas: convs, excluidas: 0, estimacion: null, notas: ["sin precio del modelo en config_wa.precios_claude: no se pudo estimar"] };
  const total = estimarLote(convs, cfg, precio);
  if (total.usd <= presupuestoUsd) return { incluidas: convs, excluidas: 0, estimacion: total, notas: [] };
  // Primera aproximación por costo promedio; después se ajusta hacia abajo hasta que entre.
  let n = Math.max(0, Math.floor((presupuestoUsd / total.usd) * convs.length));
  let muestra = muestrear(convs, n, semilla);
  let est = estimarLote(muestra, cfg, precio);
  while (n > 0 && est.usd > presupuestoUsd) {
    n = Math.max(0, n - Math.max(1, Math.ceil(n * 0.02)));
    muestra = muestrear(convs, n, semilla);
    est = estimarLote(muestra, cfg, precio);
  }
  return {
    incluidas: muestra,
    excluidas: convs.length - muestra.length,
    estimacion: est,
    notas: [`estimación USD ${total.usd.toFixed(4)} supera el presupuesto de clasificación USD ${presupuestoUsd.toFixed(4)}: muestra recortada de ${convs.length} a ${muestra.length}`],
  };
}

// ---------- lote ----------

export type LoteClasificacion = {
  pedidos: PedidoLote[];
  incluidas: string[];
  excluidas: number;
  estimacion: Estimacion | null;
  presupuesto_usd: number;
  intento: 1 | 2;
  notas: string[];
};

/**
 * Arma el lote del primer intento: estima el costo ANTES de mandar y recorta la muestra si supera
 * la parte de clasificación del tope (config_wa.mejora_mensual.tope_usd × reparto, ~70 %).
 * Sin precio y fuera del modo simulado: no arma nada (ErrorMejora), para no gastar a ciegas.
 */
export function armarLoteClasificacion(
  convs: ConversacionParaAnalizar[],
  opciones: { cfg?: CfgMejora; precio?: PrecioModelo | null; semilla?: string; presupuestoUsd?: number; simulado?: boolean } = {},
): LoteClasificacion {
  const cfg = opciones.cfg ?? CFG_MEJORA_DEFAULT;
  const precio = opciones.precio ?? null;
  const simulado = opciones.simulado ?? esModoSimulado();
  if (!precio && !simulado) throw new ErrorMejora(`sin precio para ${cfg.modelo_clasificacion} en config_wa.precios_claude`);
  const presu = opciones.presupuestoUsd ?? presupuesto(cfg).clasificacion_usd;
  const r = recortarAlPresupuesto(convs, presu, cfg, precio, opciones.semilla);
  return {
    pedidos: r.incluidas.map((c) => armarPedidoClasificacion(c, cfg, 1)),
    incluidas: r.incluidas.map((c) => c.conversacion_id),
    excluidas: r.excluidas,
    estimacion: r.estimacion,
    presupuesto_usd: presu,
    intento: 1,
    notas: r.notas,
  };
}

/** Lote de reintento: solo las inválidas del intento 1 (una sola vez). */
export function armarLoteReintento(
  invalidas: { conversacion_id: string; intento: 1 | 2 }[],
  convs: ConversacionParaAnalizar[],
  cfg: CfgMejora,
  precio: PrecioModelo | null,
): LoteClasificacion {
  const porId = new Map(convs.map((c) => [c.conversacion_id, c]));
  const elegibles = invalidas.filter((x) => x.intento === 1).map((x) => porId.get(x.conversacion_id)).filter((c): c is ConversacionParaAnalizar => !!c);
  return {
    pedidos: elegibles.map((c) => armarPedidoClasificacion(c, cfg, 2)),
    incluidas: elegibles.map((c) => c.conversacion_id),
    excluidas: 0,
    estimacion: precio ? estimarLote(elegibles, cfg, precio) : null,
    presupuesto_usd: 0,
    intento: 2,
    notas: [],
  };
}

// ---------- simulador determinista (sin ANTHROPIC_API_KEY o MODO_SIMULADO=1) ----------

function norm(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function simularEtiquetas(conv: ConversacionParaAnalizar): Etiquetas {
  const cliente = norm(conv.mensajes.filter((m) => m.de === "C").map((m) => m.texto).join(" \n "));
  const reclamo = /no (me )?llego|roto|danad|no funciona|no pega|se despega|reclamo|incomplet|equivocad/.test(cliente);
  const enojo = /estafa|mal servicio|una verguenza|!!!|nunca mas/.test(cliente);
  const caro = /caro|precio|cuanto|descuento|rebaja/.test(cliente);
  const desconfia = /confi|estafa|gua'?u|mentira|seguro que/.test(cliente);
  const compra = conv.resultado !== "sin_compra";
  const tipo = /no pega|se despega/.test(cliente) ? "uso" : /no (me )?llego/.test(cliente) ? "courier" : /roto|danad/.test(cliente) ? "danado" : "otro";
  const etapa: Etiquetas["etapa"] = reclamo ? "reclamo" : compra ? (conv.resultado === "entregado" ? "postventa" : "cierre") : caro || desconfia ? "objecion" : conv.n_mensajes > 3 ? "interes" : "consulta";
  return {
    etapa,
    objecion_principal: desconfia ? "desconfía del pago contra entrega" : caro ? "precio alto" : null,
    respuesta_que_movio: compra ? "precio, envío y pago al recibir en un mensaje" : null,
    errores_bot: conv.mensajes.some((m) => m.de === "V" && (m.texto.match(/\?/g)?.length ?? 0) > 1) ? ["dos preguntas juntas"] : [],
    reclamo: reclamo
      ? { hubo: true, tipo, paso_resuelto: conv.paso_escalera ?? (tipo === "uso" ? 2 : null), derivado: conv.derivado }
      : { hubo: false, tipo: null, paso_resuelto: null, derivado: false },
    emocion: enojo ? "enojo" : compra ? "satisfecho" : conv.n_mensajes <= 2 ? "abandono" : "neutral",
    debio_derivar: (reclamo || enojo) && !conv.derivado,
  };
}

function resultadosSimulados(convs: ConversacionParaAnalizar[], intento: 1 | 2): ResultadoLote[] {
  return convs.map((c) => {
    const texto = JSON.stringify(simularEtiquetas(c)).slice(1); // como si viniera después del prefill "{"
    const contenido: Bloque[] = [{ type: "text", text: texto }];
    return {
      custom_id: customIdDe(c.conversacion_id, intento),
      tipo: "succeeded" as const,
      contenido,
      texto,
      uso: { entrada: 0, salida: 0, cache_lectura: 0, cache_escritura: 0 },
      costo_usd: 0,
    };
  });
}

const PREFIJO_SIMULADO = "msgbatch_simulado_mejora_";

// ---------- envío y lectura ----------

export type EnvioLote = { lote_id: string; simulado: boolean; estado: EstadoLote["estado"]; resultados?: ResultadoLote[] };

/** Manda el lote (no espera: el Batch tarda; M3 lo consulta en la próxima corrida del cron). */
export async function enviarLoteClasificacion(
  lote: LoteClasificacion,
  convs: ConversacionParaAnalizar[],
  deps: { crearLote?: typeof llamarClaudeLote; simulado?: boolean } = {},
): Promise<EnvioLote> {
  if (!lote.pedidos.length) throw new ErrorMejora("lote vacío");
  if (deps.simulado ?? esModoSimulado()) {
    console.log("mejora-mensual: clasificación en modo simulado");
    const ids = new Set(lote.incluidas);
    return {
      lote_id: `${PREFIJO_SIMULADO}${lote.intento}_${lote.pedidos.length}`,
      simulado: true,
      estado: "ended",
      resultados: resultadosSimulados(convs.filter((c) => ids.has(c.conversacion_id)), lote.intento),
    };
  }
  const e = await (deps.crearLote ?? llamarClaudeLote)(lote.pedidos, { esperar: false });
  return { lote_id: e.id, simulado: e.simulado, estado: e.estado, resultados: e.resultados };
}

export type ClasificacionValida = { conversacion_id: string; etiquetas: Etiquetas; intento: 1 | 2; costo_usd: number };
export type ClasificacionInvalida = { conversacion_id: string; intento: 1 | 2; motivo: string; costo_usd: number };

export type LecturaLote = {
  estado: EstadoLote["estado"];
  validas: ClasificacionValida[];
  invalidas: ClasificacionInvalida[];
  /** Inválidas del intento 2: se descartan (no hay tercer intento). */
  descartadas: ClasificacionInvalida[];
  costo_usd: number;
  simulado: boolean;
};

/** Puro: resultados del Batch → válidas / inválidas (para reintentar) / descartadas. */
export function procesarResultados(
  resultados: ResultadoLote[],
  idsEsperados?: Set<string>,
  intentoLote: 1 | 2 = 1,
): Omit<LecturaLote, "estado" | "simulado"> {
  const validas: ClasificacionValida[] = [];
  const invalidas: ClasificacionInvalida[] = [];
  const descartadas: ClasificacionInvalida[] = [];
  let costo = 0;
  const vistos = new Set<string>();
  for (const r of resultados) {
    const cid = leerCustomId(r.custom_id);
    if (!cid) continue;
    if (idsEsperados && !idsEsperados.has(cid.conversacion_id)) continue;
    if (vistos.has(r.custom_id)) continue;
    vistos.add(r.custom_id);
    costo += r.costo_usd || 0;
    let motivo: string | null = null;
    let etiquetas: Etiquetas | null = null;
    if (r.tipo !== "succeeded") {
      motivo = `lote:${r.tipo}`;
    } else {
      const p = parsearRespuesta(r.texto);
      if (!p.ok) motivo = p.motivo;
      else {
        const v = validarEtiquetas(p.valor);
        if (v.ok) etiquetas = v.valor;
        else motivo = v.motivo;
      }
    }
    if (etiquetas) validas.push({ conversacion_id: cid.conversacion_id, etiquetas, intento: cid.intento, costo_usd: r.costo_usd || 0 });
    else {
      const fila = { conversacion_id: cid.conversacion_id, intento: cid.intento, motivo: motivo ?? "desconocido", costo_usd: r.costo_usd || 0 };
      (cid.intento === 1 ? invalidas : descartadas).push(fila);
    }
  }
  // Pedidos sin fila en el JSONL (no debería pasar): cuentan como inválidos para reintentar.
  if (idsEsperados) {
    const conFila = new Set([...validas, ...invalidas, ...descartadas].map((x) => x.conversacion_id));
    for (const id of idsEsperados) {
      if (conFila.has(id)) continue;
      const fila = { conversacion_id: id, intento: intentoLote, motivo: "sin resultado", costo_usd: 0 };
      (intentoLote === 1 ? invalidas : descartadas).push(fila);
    }
  }
  return { validas, invalidas, descartadas, costo_usd: Math.round(costo * 1e8) / 1e8 };
}

/**
 * Lee un lote. Si todavía no terminó devuelve `estado: 'in_progress'` sin filas (M3 vuelve más tarde).
 * `convs`: SOLO las conversaciones de ese lote (para el simulador, el precio por modelo y detectar faltantes).
 * `deps.esperados`: ids del lote cuando no se tienen las convs (corrida siguiente del cron).
 * `intento`: 1 para el lote principal, 2 para el reintento (sus inválidas se descartan).
 */
export async function leerResultadosLote(
  lote: string | EnvioLote,
  convs: ConversacionParaAnalizar[] = [],
  cfg: CfgMejora = CFG_MEJORA_DEFAULT,
  deps: { consultar?: typeof consultarLote; intento?: 1 | 2; esperados?: string[] } = {},
): Promise<LecturaLote> {
  const id = typeof lote === "string" ? lote : lote.lote_id;
  // Ids del lote para detectar faltantes: las convs, o solo los ids (corrida siguiente del cron, sin convs).
  const idsEsperados = convs.length ? convs.map((c) => c.conversacion_id) : deps.esperados ?? [];
  const esperados = idsEsperados.length ? new Set(idsEsperados) : undefined;
  let resultados: ResultadoLote[] | undefined = typeof lote === "string" ? undefined : lote.resultados;
  let estado: EstadoLote["estado"] = typeof lote === "string" ? "in_progress" : lote.estado;
  const simulado = id.startsWith(PREFIJO_SIMULADO);
  const intentoLote: 1 | 2 = deps.intento ?? ((Number(/_(\d)_\d+$/.exec(id)?.[1]) || 1) === 2 ? 2 : 1);
  if (simulado && !resultados) {
    resultados = resultadosSimulados(convs, intentoLote);
    estado = "ended";
  }
  if (!resultados || estado !== "ended") {
    const modelos = new Map<string, PedidoClaude>();
    for (const c of convs) {
      for (const i of [1, 2] as const) modelos.set(customIdDe(c.conversacion_id, i), armarPedidoClasificacion(c, cfg, i).pedido);
    }
    const e = await (deps.consultar ?? consultarLote)(id, modelos);
    estado = e.estado;
    resultados = e.resultados;
  }
  if (estado !== "ended" || !resultados) {
    return { estado, validas: [], invalidas: [], descartadas: [], costo_usd: 0, simulado };
  }
  return { estado, simulado, ...procesarResultados(resultados, esperados, intentoLote) };
}
