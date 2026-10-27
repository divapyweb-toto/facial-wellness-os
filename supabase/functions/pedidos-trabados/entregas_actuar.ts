// pedidos-trabados · que nada quede parado (Enrique 21-10-2026). Lógica pura + orquestación con dependencias inyectadas
// (las reales están en entregas_actuar_io.ts). Fuentes: vistas pedidos_parados, entregas_para_actuar y rendicion_atrasada
// (migración 20261021000004). Cada aviso sale UNA vez por evento (candado en eventos_crudos); si Telegram falla 3 veces se
// suelta el candado y el cron lo reintenta a los 10 min (mismo patrón que cancelaciones_ventas.ts).
//   · Lucero "fallido": Telegram + (si la plantilla voltra_entrega_reprogramar está aprobada) mensaje al cliente para reprogramar.
//   · PaP custodio / inubicable / no gestionado / fuera de cobertura: PaP no reintenta → Telegram el mismo día ("última chance").
//   · Pedidos parados: un Telegram por día entre las 9:00 y las 12:00 de Paraguay, solo si hay.
//   · Rendición atrasada: Telegram una vez por entrega al cruzar el umbral.
import { escaparHtml } from "../_shared/telegram_formato.ts";
import type { OpcionesAviso } from "../_shared/telegram_politica.ts";
import { listaParados, type PedidoParado, type RendicionAtrasada } from "../resumen-diario/logica.ts";

export type TipoActuar = "lucero_fallido" | "pap_ultima_chance";
export interface FilaActuar { ref: string; courier: string; estado: string; motivo: string; fechaIngreso: string | null; tipo: TipoActuar }
export interface FilaRendicion extends RendicionAtrasada { fechaEntrega: string | null }
/** Config `reprogramar_lucero` (tabla config, JSON): la plantilla voltra_entrega_reprogramar figura aprobada en Meta. */
export interface CfgReprogramar { plantillaAprobada: boolean; maxDias: number }
export const CFG_REPROGRAMAR_APAGADA: CfgReprogramar = { plantillaAprobada: false, maxDias: 7 };
/** Un PaP con fecha_ingreso de hace más de esto, en la primera corrida, se registra en silencio (ya estaba). */
export const DIAS_LINEA_BASE_PAP = 3;
export const CANDADO_BASE_PAP = "auto_actuar_pap_base";
export const PLANTILLA_REPROGRAMAR = "voltra_entrega_reprogramar";
/** Ventana (hora de Paraguay) del Telegram diario de pedidos parados. */
export const HORA_PARADOS = { desde: 9, hasta: 12 };

export type ResultadoReprogramar =
  | "encolado" | "plantilla_sin_aprobar" | "evento_viejo" | "sin_telefono" | "sin_pedido" | "no_corresponde" | "error";

export interface DepsActuar {
  /** true = lo tomó ahora; false = ya existía. */
  tomarCandado(id: string, payload: Record<string, unknown>): Promise<boolean>;
  soltarCandado(id: string): Promise<void>;
  existeCandado(id: string): Promise<boolean>;
  avisar(texto: string, botones?: undefined, opts?: OpcionesAviso): Promise<{ ok: boolean; error?: string }>;
  /**
   * 27-10: texto listo para reenviar a Lucero ("volver a intentar"), armado con los datos del pedido. Opcional: sin
   * esto (o si falla) el aviso sale sin el bloque para el courier. Solo se pide si el aviso realmente va a salir.
   */
  textoCourierLucero?(f: FilaActuar): Promise<string | null>;
  /** Encola el mensaje al cliente (idempotente por clave_unica). Solo se llama si la plantilla figura aprobada. */
  encolarReprogramar?(f: FilaActuar): Promise<ResultadoReprogramar>;
  esperar(ms: number): Promise<void>;
}

// ── helpers puros ──
const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
export const normEstado = (s: string) => sinTildes(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "sin_estado";
/** Día AAAA-MM-DD y hora en Paraguay (UTC−3 fijo desde oct-2024). */
const pyMs = (d: Date) => d.getTime() - 3 * 3_600_000;
export const diaPy = (d: Date) => new Date(pyMs(d)).toISOString().slice(0, 10);
export const horaPy = (d: Date) => new Date(pyMs(d)).getUTCHours();
/** Días enteros entre una fecha AAAA-MM-DD y hoy (Paraguay); null si la fecha no es válida. */
export function diasDesde(fecha: string | null, ahora: Date): number | null {
  if (!fecha || !/^\d{4}-\d{2}-\d{2}/.test(fecha)) return null;
  return Math.floor((Date.parse(`${diaPy(ahora)}T00:00:00Z`) - Date.parse(`${fecha.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** 'VT-1135' → '#1135' (nombre del pedido en Shopify). */
export const pedidoDeRef = (ref: string) => `#${ref.replace(/^VT-/i, "")}`;
/** 27-10: clave común del aviso "no entregado: volver a intentar" (la usa también procesar-envios, con el mismo tipo). */
export const claveNoEntregado = (pedido: string) => pedido.replace(/^(#|VT-)/i, "");
/** Pedido a reenviar a Lucero (el mismo texto que procesar-envios para el reintento). */
export const PEDIDO_REINTENTO = "No se pudo entregar: volver a intentar el próximo día hábil. Coordinar día, hora y lugar con el cliente.";

/** 27-10: tipo y destino de cada aviso de esta corrida (telegram_politica.ts). */
export const opcionesActuar = (f: FilaActuar): OpcionesAviso =>
  f.tipo === "lucero_fallido"
    // #37 + #42: UN solo aviso por falla (con el texto para Lucero). Mismo tipo y clave que procesar-envios → si los dos
    // lo detectan el mismo día, sale uno.
    ? { tipo: "no_entregado_reintentar", destino: "enrique", pedido: pedidoDeRef(f.ref), unaVezPorDia: true, clave: claveNoEntregado(f.ref) }
    // #43: PaP no reintenta. Hoy el sistema NO le escribe al cliente desde acá → sigue para Enrique.
    : { tipo: "pap_ultima_chance", destino: "enrique", pedido: pedidoDeRef(f.ref) };

export const claveCandadoActuar = (f: FilaActuar) =>
  f.tipo === "lucero_fallido"
    ? `auto_actuar_lucero:${f.ref}:${normEstado(f.estado)}:${(f.fechaIngreso ?? "sin_fecha").slice(0, 10)}`
    : `auto_actuar_pap:${f.ref}:${normEstado(f.estado)}`;
export const claveCandadoRendicion = (r: FilaRendicion) => `auto_rendicion:${r.ref}:${(r.fechaEntrega ?? "sin_fecha").slice(0, 10)}`;
export const claveCandadoParados = (ahora: Date) => `auto_parados:${diaPy(ahora)}`;
/** Clave del mensaje al cliente en envios_programados: una por pedido y por evento de fallo. */
export const claveEnvioReprogramar = (shopifyOrderId: number, fechaIngreso: string | null) =>
  `courier:${shopifyOrderId}:FALLIDO:${(fechaIngreso ?? "sin_fecha").slice(0, 10)}`;

export function esLineaBasePap(f: FilaActuar, ahora: Date): boolean {
  const d = diasDesde(f.fechaIngreso, ahora);
  return f.tipo === "pap_ultima_chance" && d != null && d > DIAS_LINEA_BASE_PAP;
}

export function configReprogramar(valor: unknown): CfgReprogramar {
  try {
    const j = (typeof valor === "string" ? JSON.parse(valor) : valor) as Record<string, unknown> | null;
    const max = Number(j?.max_dias);
    return { plantillaAprobada: j?.plantilla_aprobada === true, maxDias: Number.isFinite(max) && max > 0 ? max : 7 };
  } catch {
    return CFG_REPROGRAMAR_APAGADA; // config inválida = apagado
  }
}

/** ¿Hay que escribirle al cliente? Solo Lucero fallido, con la plantilla aprobada y el evento reciente. */
export function decidirReprogramar(f: FilaActuar, cfg: CfgReprogramar, ahora: Date): "enviar" | "plantilla_sin_aprobar" | "evento_viejo" | "no_corresponde" {
  if (f.tipo !== "lucero_fallido") return "no_corresponde";
  if (!cfg.plantillaAprobada) return "plantilla_sin_aprobar";
  const d = diasDesde(f.fechaIngreso, ahora);
  if (d != null && d > cfg.maxDias) return "evento_viejo";
  return "enviar";
}

const NOTA_CLIENTE: Record<string, string> = {
  // 22-10 (Enrique): UN solo mensaje por falla, y sale de la importación del reporte de Lucero (importar-courier):
  // con la plantilla voltra_entrega_reprogramar aprobada reemplaza al aviso de reintento; mientras tanto, el de siempre.
  importacion_nuevo: "El cliente recibe UN solo mensaje por WhatsApp (Lucero reintenta el próximo día hábil y se le pide confirmar el horario).",
  importacion_reintento: "El cliente recibe el aviso de reintento habitual por WhatsApp.",
  encolado: "Le escribí al cliente por WhatsApp para coordinar la nueva entrega.",
  plantilla_sin_aprobar: "No le escribí al cliente: la plantilla de reprogramación todavía no está aprobada. Escribile vos.",
  evento_viejo: "No le escribí al cliente (el fallo es de hace varios días). Escribile vos.",
  sin_telefono: "No le escribí al cliente: el pedido no tiene teléfono.",
  sin_pedido: "No le escribí al cliente: no encontré el pedido en Shopify.",
  no_corresponde: "No le escribí al cliente (el pedido ya no corresponde). Revisalo.",
  error: "No pude escribirle al cliente. Escribile vos.",
};

export function textoLucero(f: FilaActuar, cliente: ResultadoReprogramar | "plantilla_sin_aprobar" | "evento_viejo" | "importacion_nuevo" | "importacion_reintento"): string {
  const motivo = f.motivo.trim() ? ` (${escaparHtml(f.motivo.trim())})` : "";
  return `⚠ <b>${escaparHtml(f.ref)}</b> · Lucero: entrega fallida${motivo}. Hay que reprogramar la entrega con el cliente. ${NOTA_CLIENTE[cliente] ?? NOTA_CLIENTE.error}`;
}
export function textoPap(f: FilaActuar): string {
  const estado = escaparHtml(f.estado.trim() || "sin estado"), motivo = f.motivo.trim() ? ` · ${escaparHtml(f.motivo.trim())}` : "";
  return `🚨 <b>${escaparHtml(f.ref)}</b> · PaP: ${estado}${motivo}. PaP no reintenta: es la última chance de llamar al cliente.`;
}
export function textoRendicion(r: FilaRendicion): string {
  const courier = r.courier === "pap" ? "PaP" : r.courier === "lucero" ? "Lucero" : escaparHtml(r.courier);
  return `💰 Rendición atrasada: ${courier} <b>${escaparHtml(r.ref)}</b> · entregado hace ${r.dias} días · Gs ${Math.round(r.montoNeto).toLocaleString("es-PY")} sin rendir. Reclamala al courier.`;
}
export function textoParados(ps: PedidoParado[], cpc?: Parameters<typeof listaParados>[1]): string {
  const { n, lista } = listaParados(ps, cpc);
  return `📦 ${n} pedido${n > 1 ? "s" : ""} sin despachar hace +24 h: ${lista}`;
}

/** 27-10: aviso de Lucero fallido + bloque para reenviar a Lucero (si se pudo armar). Nunca tira excepción. */
export async function textoLuceroCompleto(f: FilaActuar, cliente: Parameters<typeof textoLucero>[1], d: DepsActuar): Promise<string> {
  const base = textoLucero(f, cliente);
  const extra = d.textoCourierLucero ? await d.textoCourierLucero(f).catch(() => null) : null;
  return extra ? `${base}\n\n${extra}` : base;
}

// ── orquestación ──
export type ResultadoAviso = "avisado" | "ya_avisado" | "simulado" | `error: ${string}`;

/**
 * Toma el candado y manda el Telegram (3 intentos). Si falla, suelta el candado: el cron lo reintenta a los 10 min.
 * `simular`: no toca nada (solo dice si saldría).
 */
export async function avisarUnaVez(
  d: DepsActuar, id: string, payload: Record<string, unknown>, texto: string | (() => Promise<string>), simular: boolean,
  opts?: OpcionesAviso,
): Promise<ResultadoAviso> {
  if (simular) return (await d.existeCandado(id)) ? "ya_avisado" : "simulado";
  if (!(await d.tomarCandado(id, payload))) return "ya_avisado";
  // 27-10: el texto puede armarse recién acá (consulta a la base solo si el aviso va a salir).
  const t = typeof texto === "string" ? texto : await texto();
  let ultimo = "";
  for (let i = 0; i < 3; i++) {
    const r = await d.avisar(t, undefined, opts);
    if (r.ok) return "avisado";
    ultimo = r.error ?? "Telegram falló";
    if (i < 2) await d.esperar(1500);
  }
  await d.soltarCandado(id);
  return `error: Telegram: ${ultimo}`;
}

export interface HechoActuar { ref: string; evento: string; resultado: string; cliente?: string }

/** Lucero fallido y PaP última chance. `cfg` solo importa para Lucero. */
export async function procesarEntregasActuar(
  filas: FilaActuar[], ahora: Date, cfg: CfgReprogramar, d: DepsActuar, simular = false,
): Promise<HechoActuar[]> {
  const hechos: HechoActuar[] = [];
  // Línea base de PaP: la primera corrida real registra en silencio los que ya estaban hace días; después, todo aviso.
  const primeraVez = filas.some((f) => f.tipo === "pap_ultima_chance") && !(await d.existeCandado(CANDADO_BASE_PAP));
  let baseConsumida = false;
  for (const f of filas) {
    const id = claveCandadoActuar(f);
    if (f.tipo === "pap_ultima_chance") {
      if (primeraVez && esLineaBasePap(f, ahora)) {
        if (simular) { hechos.push({ ref: f.ref, evento: f.estado, resultado: "línea base (se registra sin avisar)" }); continue; }
        await d.tomarCandado(id, { ref: f.ref, estado: f.estado, base: true });
        baseConsumida = true;
        hechos.push({ ref: f.ref, evento: f.estado, resultado: "línea base (sin aviso)" });
        continue;
      }
      hechos.push({ ref: f.ref, evento: f.estado, resultado: await avisarUnaVez(d, id, { ref: f.ref, estado: f.estado }, textoPap(f), simular, opcionesActuar(f)) });
      continue;
    }
    // Lucero: el mensaje al cliente NO se manda desde acá (así nunca hay dos por falla): lo manda la importación del
    // reporte. Acá solo el Telegram, contando cuál de los dos mensajes recibe el cliente.
    const cliente = cfg.plantillaAprobada ? "importacion_nuevo" as const : "importacion_reintento" as const;
    hechos.push({
      ref: f.ref, evento: f.estado, cliente,
      resultado: await avisarUnaVez(d, id, { ref: f.ref, estado: f.estado, fecha_ingreso: f.fechaIngreso }, () => textoLuceroCompleto(f, cliente, d), simular, opcionesActuar(f)),
    });
  }
  if (primeraVez && !simular) await d.tomarCandado(CANDADO_BASE_PAP, { corrida: ahora.toISOString(), registrados: baseConsumida });
  return hechos;
}

/** Un Telegram por día entre las 9:00 y las 12:00 (Paraguay), solo si hay pedidos parados. */
export async function avisarParadosDiario(
  ps: PedidoParado[], ahora: Date, cpc: Parameters<typeof listaParados>[1], d: DepsActuar, simular = false,
): Promise<{ resultado: string; n: number }> {
  const h = horaPy(ahora);
  if (h < HORA_PARADOS.desde || h >= HORA_PARADOS.hasta) return { resultado: "fuera_de_hora", n: ps.length };
  if (!ps.length) return { resultado: "sin_parados", n: 0 };
  const r = await avisarUnaVez(d, claveCandadoParados(ahora), { dia: diaPy(ahora), n: ps.length }, textoParados(ps, cpc), simular,
    { tipo: "pedidos_sin_despachar_24h", destino: "enrique" });
  return { resultado: r, n: ps.length };
}

/** Rendición atrasada: Telegram una vez por entrega (ref + fecha de entrega). */
export async function avisarRendicionAtrasada(rs: FilaRendicion[], d: DepsActuar, simular = false): Promise<HechoActuar[]> {
  const hechos: HechoActuar[] = [];
  for (const r of rs) {
    hechos.push({ ref: r.ref, evento: "rendicion_atrasada", resultado: await avisarUnaVez(d, claveCandadoRendicion(r), { ref: r.ref, dias: r.dias }, textoRendicion(r), simular,
      { tipo: "rendicion_atrasada", destino: "enrique", pedido: pedidoDeRef(r.ref) }) });
  }
  return hechos;
}
