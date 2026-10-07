// auditoria-diaria/logica.ts · Dueño: G3
// Lógica pura de la auditoría diaria del vendedor: qué día revisar, qué tiene de raro cada
// conversación, qué se le pregunta a Haiku y cómo queda el aviso de Telegram. Sin red ni base.
import { partesAsuncion } from "../_shared/horario.ts";
import { escaparAtributo, escaparHtml } from "../_shared/telegram_formato.ts";
import {
  clienteEnojado,
  extraerPrecios,
  type ItemCatalogo,
  type Motivo,
  mostroIntencionCompra,
  PROHIBIDAS_POR_DEFECTO,
  revisarTexto,
} from "./reglas.ts";

// ------------------------------------------------------------------ tipos

export interface MensajeAud {
  id: string;
  conversacion_id: string;
  cliente_id: string | null;
  direccion: "in" | "out";
  tipo: string | null;
  texto: string | null;
  creado_en: string;
}

export interface ConvInfo {
  id: string;
  estado: string | null;
  cliente_id: string | null;
  nombre: string | null;
  telefono: string | null;
  wa_username: string | null;
}

/** Fila de vendedor_turnos (migración 0004 de G1). Solo se usan estas columnas. */
export interface TurnoVend {
  conversacion_id: string;
  herramientas: unknown;
  derivado: boolean | null;
}

export interface PedidoCliente {
  cliente_id: string | null;
  total: number | null;
  creado_en: string;
}

export interface CfgAuditoria {
  /** Ej. "https://<usuario>.github.io/fw-os/#/bandeja". Sin esto el aviso trae el id de la conversación. */
  url_bandeja: string | null;
  /** Modelo del lote (Batch API). */
  modelo: string;
  /** Envío en guaraníes (para aceptar precio + envío). */
  envio: number;
  /** Montos válidos siempre (por ejemplo, precios de lista vigentes). */
  precios_extra: number[];
  /** Horas que se espera el lote antes de mandar solo lo de las reglas. */
  espera_lote_h: number;
  /** Máximo de conversaciones detalladas en un aviso. */
  max_en_aviso: number;
  prohibidas: string[];
}

export const CFG_POR_DEFECTO: CfgAuditoria = {
  url_bandeja: null,
  modelo: "claude-haiku-4-5",
  envio: 33000,
  precios_extra: [],
  espera_lote_h: 3,
  max_en_aviso: 15,
  prohibidas: PROHIBIDAS_POR_DEFECTO,
};

/** Une config_wa.auditoria + config_wa.palabras_prohibidas con los valores por defecto. */
export function leerCfgAuditoria(valor: unknown, prohibidas: unknown): { cfg: CfgAuditoria; faltantes: string[] } {
  const v = (valor ?? {}) as Partial<CfgAuditoria>;
  const faltantes: string[] = [];
  const cfg: CfgAuditoria = { ...CFG_POR_DEFECTO };
  if (typeof v.url_bandeja === "string" && v.url_bandeja.trim()) cfg.url_bandeja = v.url_bandeja.trim();
  else faltantes.push("auditoria.url_bandeja");
  if (typeof v.modelo === "string" && v.modelo) cfg.modelo = v.modelo;
  if (typeof v.envio === "number") cfg.envio = v.envio;
  else faltantes.push("auditoria.envio");
  if (Array.isArray(v.precios_extra)) cfg.precios_extra = v.precios_extra.filter((n) => typeof n === "number");
  if (typeof v.espera_lote_h === "number") cfg.espera_lote_h = v.espera_lote_h;
  if (typeof v.max_en_aviso === "number") cfg.max_en_aviso = v.max_en_aviso;
  if (Array.isArray(prohibidas) && prohibidas.length) cfg.prohibidas = prohibidas.map(String);
  else faltantes.push("palabras_prohibidas");
  return { cfg, faltantes };
}

// ------------------------------------------------------------------ fechas

/** Instante UTC de las 00:00 locales de Asunción del día (anio, mes, dia). */
export function medianocheAsuncion(anio: number, mes: number, dia: number): Date {
  const comoUTC = Date.UTC(anio, mes - 1, dia, 0, 0, 0);
  const desfase = (d: Date) => {
    const p = partesAsuncion(d);
    return Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - d.getTime();
  };
  let r = new Date(comoUTC - desfase(new Date(comoUTC)));
  const corr = new Date(comoUTC - desfase(r));
  if (corr.getTime() !== r.getTime()) r = corr;
  return r;
}

/** Día anterior (hora de Asunción) a `ahora`: {fecha 'YYYY-MM-DD', desde, hasta} en UTC. */
export function rangoDiaAnterior(ahora: Date): { fecha: string; desde: Date; hasta: Date } {
  const hoy = partesAsuncion(ahora);
  const hasta = medianocheAsuncion(hoy.anio, hoy.mes, hoy.dia);
  const ayer = new Date(Date.UTC(hoy.anio, hoy.mes - 1, hoy.dia - 1));
  const desde = medianocheAsuncion(ayer.getUTCFullYear(), ayer.getUTCMonth() + 1, ayer.getUTCDate());
  const pad = (n: number) => String(n).padStart(2, "0");
  return { fecha: `${ayer.getUTCFullYear()}-${pad(ayer.getUTCMonth() + 1)}-${pad(ayer.getUTCDate())}`, desde, hasta };
}

/** Rango de una fecha dada 'YYYY-MM-DD' (para reprocesar un día a mano). */
export function rangoDeFecha(fecha: string): { fecha: string; desde: Date; hasta: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) throw new Error(`fecha inválida: ${fecha}`);
  const [a, me, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const sig = new Date(Date.UTC(a, me - 1, d + 1));
  return {
    fecha,
    desde: medianocheAsuncion(a, me, d),
    hasta: medianocheAsuncion(sig.getUTCFullYear(), sig.getUTCMonth() + 1, sig.getUTCDate()),
  };
}

// ------------------------------------------------------------------ evaluación por conversación

export type Senal =
  | "palabra_prohibida"
  | "precio_dudoso"
  | "promesa_salud"
  | "revela_instrucciones"
  | "respuesta_dudosa"
  | "cliente_enojado"
  | "venta_perdida";

export const ETIQUETA_SENAL: Record<Senal, string> = {
  palabra_prohibida: "Palabra prohibida",
  precio_dudoso: "Precio dudoso",
  promesa_salud: "Promesa de salud",
  revela_instrucciones: "Reveló instrucciones",
  respuesta_dudosa: "Respuesta dudosa",
  cliente_enojado: "Cliente enojado",
  venta_perdida: "Venta perdida",
};

export interface EvalConversacion {
  conv: ConvInfo;
  mensajes: MensajeAud[];
  senales: Senal[];
  detalles: string[];
  /** Fallas de estilo (líneas, preguntas, emojis): se cuentan, no disparan aviso. */
  estilo: number;
  hubo_pedido: boolean;
  derivado: boolean;
  intencion_compra: boolean;
}

/** Todos los montos que aparecen en un JSON (resultados de herramientas del vendedor). */
export function montosEnJson(x: unknown, out: number[] = []): number[] {
  if (typeof x === "number" && x >= 1000 && x < 100_000_000) out.push(x);
  else if (typeof x === "string") out.push(...extraerPrecios(x));
  else if (Array.isArray(x)) x.forEach((y) => montosEnJson(y, out));
  else if (x && typeof x === "object") Object.values(x).forEach((y) => montosEnJson(y, out));
  return out;
}

/** true si el vendedor creó el pedido (crear_pedido_cod sin confirmar=false). */
export function usoCrearPedido(herramientas: unknown): boolean {
  const lista = Array.isArray(herramientas) ? herramientas : [];
  return lista.some((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const nombre = o.nombre ?? o.name;
    const input = (o.input ?? {}) as Record<string, unknown>;
    return nombre === "crear_pedido_cod" && input.confirmar !== false;
  });
}

export function evaluarConversacion(
  conv: ConvInfo,
  mensajes: MensajeAud[],
  turnos: TurnoVend[],
  pedidos: PedidoCliente[],
  cfg: CfgAuditoria,
): EvalConversacion {
  const ordenados = [...mensajes].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
  const salientes = ordenados.filter((m) => m.direccion === "out" && m.tipo !== "template" && (m.texto ?? "").trim());
  const entrantes = ordenados.filter((m) => m.direccion === "in" && (m.texto ?? "").trim()).map((m) => m.texto as string);

  const catalogo: ItemCatalogo[] = [];
  const extra = [...cfg.precios_extra, ...pedidos.map((p) => p.total).filter((n): n is number => typeof n === "number")];
  for (const t of turnos) extra.push(...montosEnJson(t.herramientas));
  const opciones = { catalogo, envio: cfg.envio, preciosExtra: extra, prohibidas: cfg.prohibidas };

  const senales = new Set<Senal>();
  const detalles: string[] = [];
  let estilo = 0;
  for (const m of salientes) {
    const r = revisarTexto(m.texto as string, opciones);
    for (const mot of r.motivos as Motivo[]) {
      const s = senalDeMotivo(mot.codigo);
      if (s) {
        senales.add(s);
        detalles.push(`${ETIQUETA_SENAL[s]}: ${mot.detalle}`);
      } else estilo++;
    }
  }
  const enojo = clienteEnojado(entrantes);
  if (enojo.length) {
    senales.add("cliente_enojado");
    detalles.push(`Cliente enojado: "${enojo[0]}"`);
  }
  // Pedido del cliente creado después de que empezó la conversación (los anteriores solo valen como montos).
  const inicio = ordenados[0]?.creado_en ?? "";
  const hubo_pedido = pedidos.some((p) => p.creado_en >= inicio) || turnos.some((t) => usoCrearPedido(t.herramientas));
  const derivado = conv.estado === "humano" || turnos.some((t) => t.derivado === true);
  return {
    conv,
    mensajes: ordenados,
    senales: [...senales],
    detalles: [...new Set(detalles)],
    estilo,
    hubo_pedido,
    derivado,
    intencion_compra: mostroIntencionCompra(entrantes),
  };
}

function senalDeMotivo(c: Motivo["codigo"]): Senal | null {
  if (c === "palabra_prohibida") return "palabra_prohibida";
  if (c === "precio_inventado") return "precio_dudoso";
  if (c === "promesa_salud") return "promesa_salud";
  if (c === "revela_instrucciones") return "revela_instrucciones";
  return null;
}

// ------------------------------------------------------------------ Haiku (Batch API)

export const SISTEMA_AUDITOR =
  "Revisás chats de WhatsApp de Voltra, una tienda paraguaya que vende contra entrega (tiras nasales, parches bucales). " +
  "VOLTRA es el vendedor automático; CLIENTE es el comprador (puede escribir en jopara). " +
  "Respondé SOLO un objeto JSON, sin texto alrededor, con estas claves: " +
  '{"enojado": boolean (el cliente terminó molesto, insultó o amenazó), ' +
  '"venta_perdida": boolean (el cliente quería comprar y el chat terminó sin pedido por algo que hizo o no hizo el vendedor), ' +
  '"problema": string o null (algo que el vendedor dijo mal: un precio raro, una promesa, un dato falso; null si nada), ' +
  '"resumen": string (una frase de qué pasó)}.';

export function transcripcion(ev: EvalConversacion, maxMensajes = 40, maxCar = 500): string {
  return ev.mensajes
    .slice(-maxMensajes)
    .filter((m) => (m.texto ?? "").trim())
    .map((m) => `${m.direccion === "in" ? "CLIENTE" : "VOLTRA"}: ${(m.texto as string).slice(0, maxCar)}`)
    .join("\n");
}

export interface PedidoLoteAud {
  custom_id: string;
  pedido: { modelo: string; system: string; mensajes: { role: "user"; content: string }[]; maxTokens: number };
}

/** custom_id de la Batch API: solo [a-zA-Z0-9_-], hasta 64. */
export function customId(conversacionId: string): string {
  return `c_${conversacionId.replace(/[^a-zA-Z0-9_-]/g, "")}`.slice(0, 64);
}

export function pedidosParaLote(evs: EvalConversacion[], modelo: string): PedidoLoteAud[] {
  return evs
    .filter((e) => e.mensajes.some((m) => m.direccion === "in"))
    .map((e) => ({
      custom_id: customId(e.conv.id),
      pedido: { modelo, system: SISTEMA_AUDITOR, mensajes: [{ role: "user", content: transcripcion(e) }], maxTokens: 400 },
    }));
}

export interface VeredictoHaiku {
  enojado: boolean;
  venta_perdida: boolean;
  problema: string | null;
  resumen: string | null;
}

/** Saca el JSON de la respuesta de Haiku; null si no se entiende. */
export function interpretarVeredicto(texto: string | null | undefined): VeredictoHaiku | null {
  if (!texto) return null;
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j !== "object" || j === null) return null;
    return {
      enojado: j.enojado === true,
      venta_perdida: j.venta_perdida === true,
      problema: typeof j.problema === "string" && j.problema.trim() ? j.problema.trim() : null,
      resumen: typeof j.resumen === "string" ? j.resumen.trim() : null,
    };
  } catch {
    return null;
  }
}

/**
 * Suma lo de Haiku a lo de las reglas. Sin veredicto de Haiku, "venta perdida" se infiere:
 * el cliente mostró intención de compra, no hubo pedido y el chat no pasó a Enrique.
 */
export function combinar(ev: EvalConversacion, v: VeredictoHaiku | null): EvalConversacion & { resumen: string | null } {
  const senales = new Set(ev.senales);
  const detalles = [...ev.detalles];
  if (v?.enojado && !senales.has("cliente_enojado")) {
    senales.add("cliente_enojado");
    detalles.push("Cliente enojado (según Haiku)");
  }
  const perdida = v ? v.venta_perdida && !ev.hubo_pedido : ev.intencion_compra && !ev.hubo_pedido && !ev.derivado;
  if (perdida) {
    senales.add("venta_perdida");
    detalles.push(v ? "Venta perdida (según Haiku)" : "Venta perdida: quiso comprar y no hubo pedido");
  }
  if (v?.problema) {
    senales.add("respuesta_dudosa");
    detalles.push(`Haiku: ${v.problema}`);
  }
  return { ...ev, senales: [...senales], detalles, resumen: v?.resumen ?? null };
}

// ------------------------------------------------------------------ aviso

export function enlaceBandeja(urlBandeja: string | null, conversacionId: string): string | null {
  if (!urlBandeja) return null;
  const sep = urlBandeja.includes("?") ? "&" : "?";
  return `${urlBandeja}${sep}c=${encodeURIComponent(conversacionId)}`;
}

function fechaCorta(fecha: string): string {
  const [a, m, d] = fecha.split("-");
  return `${d}/${m}/${a}`;
}

export function armarAviso(
  fecha: string,
  revisadas: number,
  raras: (EvalConversacion & { resumen: string | null })[],
  cfg: CfgAuditoria,
  notas: string[] = [],
): string {
  const l: string[] = [];
  l.push(`<b>Auditoría del vendedor · ${fechaCorta(fecha)}</b>`);
  l.push(`${revisadas} conversaciones revisadas, ${raras.length} con algo raro.`);
  const conteo = new Map<Senal, number>();
  for (const r of raras) for (const s of r.senales) conteo.set(s, (conteo.get(s) ?? 0) + 1);
  l.push([...conteo].map(([s, n]) => `${ETIQUETA_SENAL[s]}: ${n}`).join(" · "));
  l.push("");
  const orden: Senal[] = [
    "palabra_prohibida",
    "precio_dudoso",
    "promesa_salud",
    "revela_instrucciones",
    "respuesta_dudosa",
    "cliente_enojado",
    "venta_perdida",
  ];
  const peso = (r: { senales: Senal[] }) => Math.min(...r.senales.map((s) => orden.indexOf(s)));
  const lista = [...raras].sort((a, b) => peso(a) - peso(b));
  for (const r of lista.slice(0, cfg.max_en_aviso)) {
    const quien = r.conv.nombre || r.conv.wa_username || "Cliente sin nombre";
    const tel = r.conv.telefono ? ` · ${r.conv.telefono}` : "";
    l.push(`• <b>${escaparHtml(quien)}</b>${escaparHtml(tel)}`);
    for (const d of r.detalles.slice(0, 4)) l.push(`   ${escaparHtml(d.slice(0, 200))}`);
    if (r.resumen) l.push(`   <i>${escaparHtml(r.resumen.slice(0, 200))}</i>`);
    const url = enlaceBandeja(cfg.url_bandeja, r.conv.id);
    l.push(url ? `   <a href="${escaparAtributo(url)}">Abrir en la bandeja</a>` : `   Bandeja: conversación ${escaparHtml(r.conv.id)}`);
  }
  if (lista.length > cfg.max_en_aviso) l.push(`… y ${lista.length - cfg.max_en_aviso} más en la bandeja.`);
  for (const n of notas) l.push(`\n<i>${escaparHtml(n)}</i>`);
  return l.join("\n");
}
