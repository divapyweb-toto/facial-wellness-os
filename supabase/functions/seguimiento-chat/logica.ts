// seguimiento-chat · lógica pura (07-10-2026, decisión de Enrique).
// Hasta 2 recontactos automáticos a clientes que dejaron en visto, SIEMPRE dentro de la ventana de 24 h de
// WhatsApp (gratis: texto libre o interactivos, nunca plantillas). El mensaje lo escribe el vendedor con IA con
// un turno de seguimiento (orquestador.ts, entrada "[seguimiento N]" con origen "seguimiento").
// 12-10 (plan de ventas por WhatsApp, fase 2): hasta 3 toques por conversación. El 3 es una plantilla de marketing
// (toque3.ts) dentro de las 72 h gratis del anuncio; los 1 y 2 siguen acá.
// 13-10: rescate de datos (rescate_datos.ts): tocó "Quiero …" y no terminó los datos → a los 10-20 min el vendedor le
// pide solo lo que falta. No cuenta para el tope de recontactos.
// 21-10 (regla de Enrique): si el cliente escribió en los últimos min_desde_cliente_min (120) minutos, o ya hay datos
// del pedido a medio armar (pin, resumen sin confirmar o datos mandados tras pedírselos: hayDatosPedidoParciales),
// NO sale ningún recontacto automático ni video. El seguimiento es solo para quien dejó de responder. Caso real 21-10:
// pidió 2, mandó nombre y pin, el bot armó el resumen y preguntó la entrega; a los 93 min salió el recontacto 1 con
// un video genérico y cortó la compra. Vale para los recontactos 1 y 2 y el toque 3; el rescate de datos solo frena
// por datos a medio armar (sigue a los 10-20 min del "Quiero"). El recontacto el día que cobra no cambia.
// 21-10 (Enrique, segunda vuelta): el que dejó datos a medias es el cliente más caliente, no queda sin recontacto. Con
// datos a medio armar y ≥ horas_contexto (3) h sin escribir: UN solo recontacto con contexto ("[seguimiento con datos]":
// nombra lo que ya hay y lo que falta, solo texto, nunca el video), en horario y en la ventana de 24 h; uno por silencio
// y aunque se haya llegado al tope. Al día siguiente, con permiso de avisos, el toque 3 (plantilla). Después, nada.
//
// Cuándo toca (config_wa.vendedor_seguimiento, hora de Asunción):
//   · Recontacto 1: el bot habló último, hace ≥ horas_1 (1,5 h; 2 h hasta el 12-10) que no responde y su última
//     entrada fue hace < ventana_1_h (23 h).
//   · Recontacto 2: ya se hizo el 1, el bot sigue hablando último, a las horas_2 (20 h) de la última entrada del
//     cliente, < ventana_max_h (23,5 h) y ≥ separacion_min_h (2 h) desde el recontacto 1 (momentoRecontacto2).
//     12-10: si esperar lo deja fuera de la ventana (ej.: escribió a las 3:00 → las 20 h caen a las 23:00), se
//     adelanta al último momento en horario que deja margen_2_h (0,5 h) para el cron, nunca antes de horas_2_min
//     (8 h) desde su última entrada. Si no hay ningún momento válido, el 2 se saltea.
//   · Fuera de [horario_desde, horario_hasta) = [12, 21) (8 a 21 hasta el 12-10) no se manda: se espera.
// Nunca si: la conversación no está en 'ia'; hay un pedido del cliente en los últimos 7 días (Shopify o chat);
// el cliente dijo que no (perfil_vendedor.rechazo); pidió la baja de ofertas; ya se hicieron `max` en el ciclo;
// la última respuesta del bot fue una derivación. El contador NO se reinicia cuando el cliente escribe: vuelve a
// cero solo si el último recontacto fue hace más de `dias_reinicio` (7) días.
// Sin I/O: todo entra por DepsSeguimiento (io.ts en producción).
import { partesAsuncion } from "../_shared/horario.ts";
import { type BotonTelegram, enlaceWaMe, escaparAtributo, escaparHtml, recortar } from "../_shared/telegram_formato.ts";
import { type EntradaTurno, type ResultadoTurno, TEXTO_SEGUIMIENTO_CONTEXTO, textoSeguimiento } from "../_shared/vendedor/orquestador.ts";
import { normalizarPerfil } from "../_shared/vendedor/perfil.ts";
import { diaLocalMas, instanteLocal } from "../recompra/calendario.ts";
import { correrToque3, type DepsToque3, type ResumenToque3 } from "./toque3.ts";
import { correrRescateDatos, type DepsRescateDatos, type ResumenRescateDatos } from "./rescate_datos.ts";
import { correrDerivaciones, type DepsDerivaciones, type ResumenDerivaciones } from "./derivaciones_plazo.ts";
import { esOkSuelto, esStickerOEmoji } from "../_shared/vendedor/respuestas_fijas.ts";

export type CfgSeguimiento = {
  activo: boolean;
  /** Horas sin respuesta (desde el último mensaje del bot) para el recontacto 1. */
  horas_1: number;
  /** Horas desde la última entrada del cliente para el recontacto 2. */
  horas_2: number;
  /** Recontactos por ciclo. */
  max: number;
  /** Recontacto 1 solo si la última entrada fue hace menos de esto. */
  ventana_1_h: number;
  /** Ningún recontacto si la última entrada fue hace esto o más (la ventana de WhatsApp es de 24 h). */
  ventana_max_h: number;
  /** Hora de Asunción desde la que se manda (inclusive). */
  horario_desde: number;
  /** Hora de Asunción hasta la que se manda (exclusive). */
  horario_hasta: number;
  /** Máximo de recontactos por corrida del cron. */
  lote_max: number;
  /** Horas mínimas entre un recontacto y el siguiente. */
  separacion_min_h: number;
  /** Días tras el último recontacto en que el contador vuelve a cero. */
  dias_reinicio: number;
  /** Días hacia atrás en que un pedido del cliente bloquea el recontacto. */
  dias_pedido: number;
  /** 12-10: el recontacto 2 adelantado nunca sale antes de estas horas desde la última entrada del cliente. */
  horas_2_min: number;
  /** 12-10: margen (horas) que tiene que quedar antes de que cierre la franja o la ventana (el cron corre cada 10 min). */
  margen_2_h: number;
  /**
   * 21-10: ningún recontacto (1, 2 ni toque 3) si el último mensaje del cliente fue hace menos de estos minutos
   * (120). 0 = apagado.
   */
  min_desde_cliente_min: number;
  /**
   * 21-10: true = ningún recontacto (1, 2, toque 3 ni rescate de datos) si hay datos del pedido a medio armar
   * (Candidato.datos_pedido_parciales).
   */
  frenar_medio_armado: boolean;
  /** 21-10: con datos a medio armar, horas sin escribir para el único recontacto con contexto (3). */
  horas_contexto: number;
};

// 12-10: horas_1 2 → 1,5 y horario_desde 8 → 12 (plan de ventas por WhatsApp, fase 2).
// 21-10: min_desde_cliente_min 120 y frenar_medio_armado true (regla de Enrique: no interrumpir una compra en curso).
export const CFG_SEGUIMIENTO_DEFAULT: CfgSeguimiento = {
  activo: true,
  horas_1: 1.5,
  horas_2: 20,
  max: 2,
  ventana_1_h: 23,
  ventana_max_h: 23.5,
  horario_desde: 12,
  horario_hasta: 21,
  lote_max: 20,
  separacion_min_h: 2,
  dias_reinicio: 7,
  dias_pedido: 7,
  horas_2_min: 8,
  margen_2_h: 0.5,
  min_desde_cliente_min: 120,
  frenar_medio_armado: true,
  horas_contexto: 3,
};

const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** config_wa.vendedor_seguimiento → config válida (lo que falte o venga raro toma el default). */
export function leerCfgSeguimiento(v: unknown): CfgSeguimiento {
  const c: CfgSeguimiento = { ...CFG_SEGUIMIENTO_DEFAULT };
  if (!esObj(v)) return c;
  if (typeof v.activo === "boolean") c.activo = v.activo;
  if (typeof v.frenar_medio_armado === "boolean") c.frenar_medio_armado = v.frenar_medio_armado;
  for (const k of Object.keys(CFG_SEGUIMIENTO_DEFAULT) as (keyof CfgSeguimiento)[]) {
    if (typeof CFG_SEGUIMIENTO_DEFAULT[k] !== "number") continue; // los booleanos se leen arriba
    const x = v[k];
    if (typeof x === "number" && Number.isFinite(x) && x >= 0) (c[k] as number) = x;
  }
  // La ventana de WhatsApp es de 24 h: nunca más allá (con margen para la demora del envío).
  c.ventana_max_h = Math.min(c.ventana_max_h, 23.75);
  c.ventana_1_h = Math.min(c.ventana_1_h, c.ventana_max_h);
  c.max = Math.floor(c.max);
  c.lote_max = Math.floor(c.lote_max);
  return c;
}

export function dentroHorario(ahora: Date, cfg: CfgSeguimiento): boolean {
  const { hora } = partesAsuncion(ahora);
  return hora >= cfg.horario_desde && hora < cfg.horario_hasta;
}

/**
 * 12-10: tramos en horario de Asunción dentro de [t0, t1) (ms), en orden. Mismo criterio que dentroHorario (horas
 * enteras: desde 12 = 12:00, hasta 21 = hasta las 20:59).
 */
export function franjasHorario(t0: number, t1: number, cfg: Pick<CfgSeguimiento, "horario_desde" | "horario_hasta">): Array<[number, number]> {
  const tramos: Array<[number, number]> = [];
  const desde = Math.ceil(cfg.horario_desde), hasta = Math.ceil(cfg.horario_hasta);
  if (!(t1 > t0) || desde >= hasta) return tramos;
  const dias = Math.ceil((t1 - t0) / (24 * H)) + 1;
  for (let n = -1; n <= dias; n++) {
    const dia = diaLocalMas(new Date(t0), n);
    const s = Math.max(instanteLocal(dia, desde).getTime(), t0);
    const e = Math.min(instanteLocal(dia, hasta).getTime(), t1);
    if (s < e) tramos.push([s, e]);
  }
  return tramos;
}

/**
 * 12-10: instante (ms) en que sale el recontacto 2, o null si no hay ningún momento válido (se saltea).
 *   · ideal = horas_2 desde la última entrada y ≥ separacion_min_h desde el recontacto anterior. Sale en el ideal
 *     (o en el primer momento en horario después) si quedan ≥ margen_2_h antes de que cierre la franja o la
 *     ventana de WhatsApp (ventana_max_h).
 *   · Si no: se adelanta al último momento en horario que deja margen_2_h, nunca antes de horas_2_min desde la
 *     última entrada ni de separacion_min_h desde el recontacto anterior.
 *   · Si ningún tramo en horario llega al margen: el más largo, desde que empieza.
 */
export function momentoRecontacto2(entradaMs: number, ultimoSegMs: number | null, cfg: CfgSeguimiento): number | null {
  const sep = ultimoSegMs != null && Number.isFinite(ultimoSegMs) ? ultimoSegMs + cfg.separacion_min_h * H : -Infinity;
  const piso = Math.max(entradaMs + cfg.horas_2_min * H, sep);
  const ideal = Math.max(entradaMs + cfg.horas_2 * H, sep);
  const techo = entradaMs + cfg.ventana_max_h * H;
  const margen = cfg.margen_2_h * H;
  const tramos = franjasHorario(piso, techo, cfg);
  for (const [s, e] of tramos) {
    const a = Math.max(s, ideal);
    if (e - a >= margen) return a;
  }
  let adelantado: number | null = null;
  for (const [s, e] of tramos) if (e - s >= margen) adelantado = e - margen; // en orden: queda el último
  if (adelantado != null) return adelantado;
  let mejor: [number, number] | null = null;
  for (const t of tramos) if (!mejor || t[1] - t[0] > mejor[1] - mejor[0]) mejor = t;
  return mejor ? mejor[0] : null;
}

/** Lo que hace falta saber de una conversación para decidir (lo arma io.ts). */
export type Candidato = {
  conversacion_id: string;
  cliente_id: string;
  estado: string;
  ultima_entrada_en: string | null;
  /** wa_conversaciones.perfil_vendedor (rechazo, seguimientos, ultimo_seguimiento_en). */
  perfil: unknown;
  /** Último mensaje no fallido de la conversación (entrante o saliente). `manual`: lo mandó Enrique desde la bandeja. */
  ultimo_mensaje: { direccion: "in" | "out"; creado_en: string; manual?: boolean } | null;
  /** La última respuesta del vendedor fue una derivación a Enrique. */
  ultima_respuesta_derivada: boolean;
  /** Hay un pedido del cliente en los últimos `dias_pedido` días (shopify_pedidos o wa_pedidos_chat creado). */
  pedido_reciente: boolean;
  /** El consentimiento de marketing vigente es 'baja'. */
  baja_marketing: boolean;
  // ── Para el aviso de intención de compra (08-10). Opcionales: los recontactos no los usan. ──
  /** wa_clientes.nombre / telefono (E.164). */
  nombre?: string | null;
  telefono?: string | null;
  /** Textos entrantes del cliente dentro de la ventana (los más nuevos primero). */
  entradas_recientes?: Array<{ texto: string; creado_en: string }>;
  /** Último pedido del cliente (Shopify no borrador o wa_pedidos_chat creado) en los últimos `dias_pedido` días. */
  ultimo_pedido_en?: string | null;
  // ── Para el toque 3 (12-10, toque3.ts). Opcionales: los recontactos 1 y 2 no los usan. ──
  /** wa_conversaciones.origen_anuncio_id: anuncio click-to-WhatsApp por el que entró. */
  origen_anuncio_id?: string | null;
  /** Primer mensaje saliente no fallido desde `desdeISO` (en una conversación nueva: la primera respuesta del bot). */
  primera_respuesta_en?: string | null;
  /** Nombres de las plantillas salientes no fallidas desde `desdeISO`. */
  plantillas_enviadas?: string[];
  /** Consentimiento de marketing vigente (la fila más reciente de wa_consentimientos), o null si no hay. */
  consentimiento_marketing?: "si" | "no" | "baja" | null;
  /** wa_clientes.wa_user_id (BSUID), para escribirle si no hay teléfono. */
  wa_user_id?: string | null;
  /** Handle del producto del anuncio (config_wa.anuncios_producto), si se sabe. */
  handle_anuncio?: string | null;
  // ── Para el rescate de datos (13-10, rescate_datos.ts). Opcionales: el resto no los usa. ──
  /** Último toque de un botón "Quiero …" (vend_p1:q1|q2|pack|pedir) desde `desdeISO`. */
  ultimo_quiero_en?: string | null;
  /** creado_en más reciente de wa_pedidos_chat en 'resumen' o 'creado' desde `desdeISO`. */
  ultimo_resumen_en?: string | null;
  /** Rescates de datos que le llegaron al cliente en los últimos `dias_reinicio` días (vendedor_turnos). */
  rescates_datos?: number;
  // ── 19-10 (v35, ítem 7): "Ok" al precio. Opcional: sin esto, que el cliente hable último frena el recontacto. ──
  /**
   * Entrantes del cliente posteriores a nuestro último saliente no fallido (del más viejo al más nuevo). Vacío o
   * ausente si hablamos últimos o si no hubo ningún saliente nuestro antes en la ventana.
   */
  bloque_cliente?: Array<{ texto: string | null; tipo: string }>;
  // ── 21-10: pedido a medio armar. Opcional: sin esto (ausente = false) no frena nada. ──
  /**
   * Hay datos del pedido a medio armar en la ventana leída (`desdeISO`): el cliente mandó un pin, hay un
   * wa_pedidos_chat en 'resumen' sin confirmar, o mandó un texto (no acuse, sin "?") después de que el bot le pidió
   * los datos (hayDatosPedidoParciales). Con cfg.frenar_medio_armado: solo el recontacto con contexto (horas_contexto)
   * y el toque 3 al día siguiente; nada de recontactos 1 y 2 comunes ni rescate.
   */
  datos_pedido_parciales?: boolean;
};

/** 21-10: mensaje mínimo para hayDatosPedidoParciales (del más viejo al más nuevo). */
export type MensajeDatosPedido = { direccion: "in" | "out"; tipo: string | null; texto: string | null; estado?: string | null };

/**
 * 21-10: saliente del bot que pide los datos del pedido ("Pasame tu nombre, tu ciudad y la calle o barrio", "Solo me
 * falta tu ciudad"). Sobre texto normalizado (minúsculas, sin tildes).
 */
const RE_PIDE_DATOS = /pasame (?:tu |el )?(?:nombre|ciudad|calle|barrio|direccion|ubicacion)|tu nombre,? (?:tu )?ciudad|nombre, (?:tu )?ciudad|solo me falta tu|me falta tu (?:ciudad|calle|barrio|nombre)/u;

export function pideDatosPedido(texto: string | null | undefined): boolean {
  return RE_PIDE_DATOS.test(norm(texto ?? ""));
}

/**
 * 21-10: ¿hay datos del pedido a medio armar? (mensajes del más viejo al más nuevo). true si:
 *   · hay un wa_pedidos_chat en 'resumen' sin confirmar (resumenPendiente);
 *   · el cliente mandó un pin (entrante tipo 'location');
 *   · el cliente mandó un texto que no es un acuse ("ok", "gracias", 👍) ni tiene "?" después de un saliente del bot
 *     que le pidió los datos (pideDatosPedido). Una pregunta ("¿cuánto tarda?") no cuenta: todavía no dio datos.
 */
export function hayDatosPedidoParciales(mensajes: MensajeDatosPedido[], resumenPendiente: boolean): boolean {
  if (resumenPendiente) return true;
  let pidio = false;
  for (const m of mensajes) {
    if (m.direccion === "in") {
      if (m.tipo === "location") return true;
      if (!pidio || m.tipo !== "text") continue;
      const t = (m.texto ?? "").trim();
      if (t && !/[?¿]/.test(t) && !esAcuseSuelto({ texto: t, tipo: m.tipo })) return true;
    } else if (m.estado !== "fallido" && pideDatosPedido(m.texto)) {
      pidio = true;
    }
  }
  return false;
}

/**
 * 19-10 (v35, ítem 7): "Ok", "👌", "Genial", "dale", un sticker o una reacción sueltos. El vendedor a veces no los
 * contesta (acuse tras un cierre nuestro) y, como el último mensaje es del cliente, los recontactos no salían: 3 chats
 * de anuncio el 10, 11 y 18-10 se perdieron así. Usa el detector del vendedor (respuestas_fijas.ts).
 */
export function esAcuseSuelto(m: { texto: string | null; tipo: string }): boolean {
  if (m.tipo === "sticker" || m.tipo === "reaction") return true;
  const t = (m.texto ?? "").trim();
  if (!t) return false;
  return esOkSuelto(t) || esStickerOEmoji(t);
}

/** Todo lo que mandó el cliente después de nuestro último mensaje es un acuse suelto (y hay al menos uno). */
export function bloqueEsAcuse(bloque: Candidato["bloque_cliente"]): boolean {
  return !!bloque?.length && bloque.every(esAcuseSuelto);
}

export type Decision =
  | {
    tipo: "seguimiento";
    numero: number;
    previo: { seguimientos: number; ultimo_seguimiento_en: string | null };
    /** 21-10: recontacto con contexto (pedido a medio armar): "[seguimiento con datos]", solo texto. */
    contexto?: boolean;
  }
  | { tipo: "nada"; motivo: string };

const H = 3_600_000;

/** Recontactos ya hechos en el ciclo vigente (0 si el último fue hace más de `dias_reinicio` días). */
export function seguimientosVigentes(perfil: unknown, ahora: Date, cfg: CfgSeguimiento): number {
  const p = normalizarPerfil(perfil);
  const n = p.seguimientos ?? 0;
  if (!n) return 0;
  const en = p.ultimo_seguimiento_en ? Date.parse(p.ultimo_seguimiento_en) : NaN;
  if (Number.isFinite(en) && ahora.getTime() - en > cfg.dias_reinicio * 24 * H) return 0;
  return n;
}

/** YYYY-MM-DD en Asunción. */
function fechaAsuncion(d: Date): string {
  const p = partesAsuncion(d);
  return `${p.anio}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/** 21-10: el cliente escribió hace menos de min_desde_cliente_min minutos (0 = regla apagada). entradaMs: su último mensaje. */
export function clienteEscribioHacePoco(entradaMs: number, cfg: Pick<CfgSeguimiento, "min_desde_cliente_min">, ahora: Date): boolean {
  return cfg.min_desde_cliente_min > 0 && Number.isFinite(entradaMs) && ahora.getTime() - entradaMs < cfg.min_desde_cliente_min * 60_000;
}

export function decidirSeguimiento(c: Candidato, cfg: CfgSeguimiento, ahora: Date): Decision {
  const nada = (motivo: string): Decision => ({ tipo: "nada", motivo });
  if (c.estado !== "ia") return nada("no_esta_en_ia");
  const entrada = c.ultima_entrada_en ? Date.parse(c.ultima_entrada_en) : NaN;
  if (!Number.isFinite(entrada)) return nada("sin_entrada_del_cliente");
  const hEntrada = (ahora.getTime() - entrada) / H;
  if (hEntrada >= cfg.ventana_max_h) return nada("ventana_cerrada");
  const perfil = normalizarPerfil(c.perfil);
  if (perfil.rechazo) return nada("rechazo");
  // 10-10: pidió que le escribamos otro día (recontactar_el a futuro) → los recontactos esperan esa fecha.
  if (perfil.recontactar_el && perfil.recontactar_el > fechaAsuncion(ahora)) return nada("espera_fecha_pedida");
  if (c.baja_marketing) return nada("baja_marketing");
  if (c.pedido_reciente) return nada("pedido_reciente");
  // 19-10 (v35, ítem 7): un "Ok"/👌 suelto antes del pedido no es un cierre: el recontacto sigue (las horas se
  // cuentan desde el acuse). Sin pedido (pedido_reciente) ni rechazo: eso ya cortó arriba.
  const acuse = c.ultimo_mensaje?.direccion === "in" && bloqueEsAcuse(c.bloque_cliente);
  if (!c.ultimo_mensaje || (c.ultimo_mensaje.direccion !== "out" && !acuse)) return nada("cliente_hablo_ultimo");
  if (c.ultima_respuesta_derivada) return nada("derivado");
  const n = seguimientosVigentes(c.perfil, ahora, cfg);
  // 21-10 (regla de Enrique): el seguimiento es solo para quien dejó de responder. ultima_entrada_en es el último
  // mensaje del cliente (también si fue un "Ok" suelto).
  if (clienteEscribioHacePoco(entrada, cfg, ahora)) return nada("cliente_escribio_hace_poco");
  const previo0 = { seguimientos: perfil.seguimientos ?? 0, ultimo_seguimiento_en: perfil.ultimo_seguimiento_en ?? null };
  // 21-10 (segunda vuelta): pedido a medio armar → UN recontacto con contexto por silencio, aunque se haya llegado al tope.
  if (cfg.frenar_medio_armado && c.datos_pedido_parciales) {
    const ultimoSeg = perfil.ultimo_seguimiento_en ? Date.parse(perfil.ultimo_seguimiento_en) : NaN;
    if (Number.isFinite(ultimoSeg) && ultimoSeg >= entrada) return nada("contexto_ya_enviado");
    if (hEntrada < cfg.horas_contexto) return nada("pedido_a_medio_armar");
    if (!dentroHorario(ahora, cfg)) return nada("fuera_de_horario");
    return { tipo: "seguimiento", numero: n + 1, previo: previo0, contexto: true };
  }
  if (n >= cfg.max) return nada("tope_seguimientos");
  if (!dentroHorario(ahora, cfg)) return nada("fuera_de_horario");
  const hBot = (ahora.getTime() - Date.parse(c.ultimo_mensaje.creado_en)) / H;
  if (!(hBot >= cfg.horas_1)) return nada("esperando");
  const previo = { seguimientos: perfil.seguimientos ?? 0, ultimo_seguimiento_en: perfil.ultimo_seguimiento_en ?? null };
  if (n === 0) {
    if (hEntrada >= cfg.ventana_1_h) return nada("ventana_1_cerrada");
    return { tipo: "seguimiento", numero: 1, previo };
  }
  // 12-10: horas_2 desde la entrada (o antes, si esperar lo deja fuera de la ventana o del horario).
  const ultimoSeg = perfil.ultimo_seguimiento_en ? Date.parse(perfil.ultimo_seguimiento_en) : NaN;
  const objetivo = momentoRecontacto2(entrada, Number.isFinite(ultimoSeg) ? ultimoSeg : null, cfg);
  if (objetivo == null) return nada("sin_momento_valido");
  if (ahora.getTime() < objetivo) return nada("esperando");
  return { tipo: "seguimiento", numero: n + 1, previo };
}

// ---------- corrida ----------

export type DepsSeguimiento = {
  /** config_wa.vendedor_seguimiento (crudo; null si no existe). */
  config(): Promise<unknown>;
  /** true si el gasto de IA del mes ya llegó a config_wa.vendedor.tope_mensual_usd. */
  topeGastoSuperado(ahora: Date): Promise<boolean>;
  /** Conversaciones en 'ia' con la última entrada en [desdeISO, hastaISO], las más viejas primero. */
  candidatos(desdeISO: string, hastaISO: string, cfg: CfgSeguimiento): Promise<Candidato[]>;
  /** Guarda el contador y la fecha en perfil_vendedor (merge atómico, no pisa el resto del perfil). */
  marcar(conversacionId: string, seguimientos: number, enISO: string | null): Promise<void>;
  /** Turno de seguimiento del vendedor (procesarTurno con origen "seguimiento"). */
  turno(entrada: EntradaTurno): Promise<ResultadoTurno>;
  avisar(textoHtml: string, botones?: BotonTelegram[][]): Promise<unknown>;
  /**
   * Guarda (enISO) o borra (null) perfil_vendedor.aviso_intencion_en sin pisar el resto del perfil.
   * Opcional: sin esta función no corre el aviso de intención de compra.
   */
  marcarAvisoIntencion?(conversacionId: string, enISO: string | null): Promise<void>;
  /**
   * Conversaciones en 'ia' con perfil_vendedor.recontactar_el <= hoyYMD (Asunción) y sin recontacto_cobro_en.
   * Opcional (junto con marcarCobro): sin estas funciones no corre el recontacto el día que cobra.
   */
  candidatosCobro?(hoyYMD: string, cfg: CfgSeguimiento): Promise<Candidato[]>;
  /** Guarda (enISO) o borra (null) perfil_vendedor.recontacto_cobro_en sin pisar el resto del perfil. */
  marcarCobro?(conversacionId: string, enISO: string | null): Promise<void>;
  ahora(): Date;
  /** Turnos en paralelo (default 4). */
  paralelo?: number;
} & Partial<DepsToque3> & Partial<DepsRescateDatos> & Partial<DepsDerivaciones>;

export type ResumenSeguimiento = {
  accion: "inactivo" | "fuera_de_horario" | "tope_gasto" | "corrido";
  candidatos?: number;
  elegibles?: number;
  enviados?: number;
  omitidos?: number;
  fallas?: number;
  motivos?: Record<string, number>;
  resultados?: Array<{ conversacion_id: string; numero: number; accion: string; motivo?: string }>;
  /** Aviso a Enrique de clientes listos para comprar que no mandaron los datos (corre aparte de los recontactos). */
  avisos_intencion?: ResumenAvisoIntencion;
  /** Recontacto el día que el cliente dijo que cobra (corre después del aviso de intención). */
  recontactos_cobro?: ResumenRecontactoCobro;
  /** 12-10: toque 3, plantilla de oferta dentro de las 72 h gratis del anuncio (toque3.ts). */
  toque3?: ResumenToque3;
  /** 13-10: rescate de datos a quien tocó "Quiero …" y no terminó los datos (rescate_datos.ts). */
  rescate_datos?: ResumenRescateDatos;
  /** 19-10: derivaciones con plazo (recordatorios a Enrique, retomar o mensaje fijo; derivaciones_plazo.ts). */
  derivaciones?: ResumenDerivaciones;
};

/** Resultado del turno que cuenta como falla (se avisa a Enrique, una vez por corrida). */
export function esFalla(r: ResultadoTurno): boolean {
  return r.accion === "error_envio" || (r.accion === "omitido" && (r.motivo ?? "").startsWith("sin_derivar:"));
}

export async function enLotes<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  const cola = [...items];
  const trabajadores = Array.from({ length: Math.max(1, Math.min(n, cola.length)) }, async () => {
    while (cola.length) await f(cola.shift()!);
  });
  await Promise.all(trabajadores);
}

/**
 * Recontactos + rescate de datos (13-10) + aviso de intención de compra + recontacto el día que cobra + toque 3. Los
 * últimos corren DESPUÉS (así leen el perfil ya guardado por los turnos) y una falla de uno no frena a los demás.
 */
export async function correrSeguimientos(deps: DepsSeguimiento): Promise<ResumenSeguimiento> {
  const crudo = await deps.config();
  const r: ResumenSeguimiento = await correrRecontactos(deps, crudo);
  const aparte = async <T>(nombre: string, f: () => Promise<T>, error: T): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`seguimiento-chat: ${nombre} falló:`, msg);
      await deps.avisar(`<b>${nombre}: la corrida falló</b>\n${escaparHtml(msg.slice(0, 500))}`).catch(() => {});
      return error;
    }
  };
  // 13-10: rescate de datos. Corre a cualquier hora (el cliente tocó "Quiero" hace minutos), aunque los recontactos
  // estén fuera de horario; si el recontacto de esta misma corrida ya le escribió, lo ve en el perfil y no sale.
  if (deps.candidatosRescateDatos && deps.marcarRescateDatos) {
    r.rescate_datos = await aparte<ResumenRescateDatos>("Rescate de datos", () => correrRescateDatos(deps, crudo), { accion: "error" });
  }
  // 19-10: derivaciones con plazo. A cualquier hora (los recordatorios y el plazo miran su propio horario). No mira el
  // tope de gasto: si el turno de retomar no sale, va el mensaje fijo (sin IA).
  if (deps.candidatosDerivacion && deps.marcarDerivacion && deps.cambiarEstado && deps.enviarTextoCliente) {
    const d: Parameters<typeof correrDerivaciones>[0] = {
      candidatosDerivacion: deps.candidatosDerivacion,
      marcarDerivacion: deps.marcarDerivacion,
      cambiarEstado: deps.cambiarEstado,
      enviarTextoCliente: deps.enviarTextoCliente,
      turno: deps.turno,
      avisar: deps.avisar,
      ahora: deps.ahora,
    };
    r.derivaciones = await aparte<ResumenDerivaciones>("Derivaciones con plazo", () => correrDerivaciones(d, crudo), { accion: "error" });
  }
  if (deps.marcarAvisoIntencion) {
    r.avisos_intencion = await aparte<ResumenAvisoIntencion>("Aviso de intención de compra", () => correrAvisosIntencion(deps, crudo), { accion: "error" });
  }
  if (deps.candidatosCobro && deps.marcarCobro) {
    r.recontactos_cobro = await aparte<ResumenRecontactoCobro>("Recontacto el día que cobra", () => correrRecontactosCobro(deps, crudo), { accion: "error" });
  }
  // 12-10: toque 3 (plantilla). No gasta IA: no mira el tope de gasto; se apaga con toque3.activo o con activo.
  if (deps.candidatosToque3 && deps.marcarToque3 && deps.enviarPlantilla) {
    r.toque3 = await aparte<ResumenToque3>("Toque 3 (plantilla de oferta)", () => correrToque3(deps, crudo, leerCfgSeguimiento(crudo)), { accion: "error" });
  }
  return r;
}

async function correrRecontactos(deps: DepsSeguimiento, crudo: unknown): Promise<ResumenSeguimiento> {
  const ahora = deps.ahora();
  const cfg = leerCfgSeguimiento(crudo);
  if (!cfg.activo || cfg.max <= 0 || cfg.lote_max <= 0) return { accion: "inactivo" };
  if (!dentroHorario(ahora, cfg)) return { accion: "fuera_de_horario" };
  if (await deps.topeGastoSuperado(ahora)) return { accion: "tope_gasto" };

  const desde = new Date(ahora.getTime() - cfg.ventana_max_h * H).toISOString();
  const hasta = new Date(ahora.getTime() - Math.min(cfg.horas_1, cfg.horas_2) * H).toISOString();
  const candidatos = await deps.candidatos(desde, hasta, cfg);

  const motivos: Record<string, number> = {};
  const elegidos: Array<{ c: Candidato; d: Extract<Decision, { tipo: "seguimiento" }> }> = [];
  for (const c of candidatos) {
    const d = decidirSeguimiento(c, cfg, ahora);
    if (d.tipo === "nada") motivos[d.motivo] = (motivos[d.motivo] ?? 0) + 1;
    else elegidos.push({ c, d });
  }
  const lote = elegidos.slice(0, cfg.lote_max);
  if (elegidos.length > lote.length) motivos.lote_lleno = elegidos.length - lote.length;

  const resultados: NonNullable<ResumenSeguimiento["resultados"]> = [];
  const fallas: string[] = [];
  let enviados = 0, omitidos = 0;
  await enLotes(lote, deps.paralelo ?? 4, async ({ c, d }) => {
    const id = c.conversacion_id;
    const enISO = deps.ahora().toISOString();
    try {
      // Se marca ANTES del turno: si dos corridas se pisan, la segunda ya ve el recontacto hecho.
      await deps.marcar(id, d.numero, enISO);
    } catch (e) {
      fallas.push(`${id}: no se pudo marcar (${e instanceof Error ? e.message : e})`);
      return;
    }
    let r: ResultadoTurno;
    try {
      r = await deps.turno({
        conversacion_id: id,
        wa_message_id: `seguimiento:${d.numero}:${id}:${enISO}`,
        texto: d.contexto ? TEXTO_SEGUIMIENTO_CONTEXTO : textoSeguimiento(d.numero),
        origen: "seguimiento",
      });
    } catch (e) {
      r = { accion: "error_envio", motivo: e instanceof Error ? e.message : String(e) };
    }
    resultados.push({ conversacion_id: id, numero: d.numero, accion: r.accion, ...(r.motivo ? { motivo: r.motivo } : {}) });
    if (r.accion === "respondido" || r.accion === "terminal" || r.accion === "derivado") enviados++;
    else omitidos++;
    if (esFalla(r)) fallas.push(`${id}: seguimiento ${d.numero} → ${r.accion}${r.motivo ? ` (${r.motivo})` : ""}`);
    // 19-10 (v35): un recontacto nunca deriva. Si pasa, es que el turno de seguimiento tenía derivar_a_enrique: se avisa.
    if (r.accion === "derivado") fallas.push(`${id}: seguimiento ${d.numero} derivó a Enrique (no debería)`);
    // No salió nada y no se gastó: se devuelve el contador a como estaba (se puede intentar en la próxima corrida).
    if (r.accion === "omitido" && !esFalla(r) && !(Number(r.costo_usd) > 0)) {
      await deps.marcar(id, d.previo.seguimientos, d.previo.ultimo_seguimiento_en)
        .catch((e) => fallas.push(`${id}: no se pudo devolver el contador (${e instanceof Error ? e.message : e})`));
    }
  });

  if (fallas.length) {
    const lista = fallas.slice(0, 10).map((f) => `• ${escaparHtml(f)}`).join("\n");
    await deps.avisar(
      `<b>Recontactos automáticos: ${fallas.length} con problemas</b>\n${lista}${fallas.length > 10 ? `\n… y ${fallas.length - 10} más` : ""}`,
    ).catch((e) => console.error("seguimiento-chat: no se pudo avisar:", e));
  }

  return {
    accion: "corrido",
    candidatos: candidatos.length,
    elegibles: elegidos.length,
    enviados,
    omitidos,
    fallas: fallas.length,
    motivos,
    resultados,
  };
}

// ---------- aviso de intención de compra (08-10-2026) ----------
// El 07-10 hubo 6 chats que dijeron "3 unidades", "voy a querer una tira", "te mando todo enseguida" y no
// terminaron en pedido. Cuando un cliente quedó listo para comprar y se calla ≥ aviso_intencion_min (15; 30 hasta el
// 12-10, plan de conversión: 27 interesados se perdieron al pedirles los datos; el cron corre cada 10 min) minutos
// sin pedido, se le avisa a Enrique por Telegram UNA vez (perfil_vendedor.aviso_intencion_en; no se repite en
// aviso_intencion_repetir_h = 24 h). Convive con los recontactos (no los reemplaza).
// Horario: puede salir a cualquier hora salvo 0-7 de Asunción; lo que se junte de noche sale a las 7 en un solo
// mensaje. No gasta IA: no mira el tope de gasto ni `activo` de los recontactos (se apaga con aviso_intencion_min: 0).

export type CfgAvisoIntencion = {
  /** Minutos sin mensaje del cliente para avisar. 0 = apagado. */
  aviso_intencion_min: number;
  /** Hora de Asunción desde la que se avisa (antes se junta). */
  aviso_intencion_desde: number;
  /** Horas en que no se repite el aviso para la misma conversación. */
  aviso_intencion_repetir_h: number;
  /** Solo chats cuya última entrada fue hace menos de esto (dentro de la ventana de 24 h de WhatsApp). */
  aviso_intencion_max_h: number;
};

export const CFG_AVISO_INTENCION_DEFAULT: CfgAvisoIntencion = {
  aviso_intencion_min: 15,
  aviso_intencion_desde: 7,
  aviso_intencion_repetir_h: 24,
  aviso_intencion_max_h: 23.5,
};

/** Lee las claves aviso_intencion_* del mismo config_wa.vendedor_seguimiento (lo que falte toma el default). */
export function leerCfgAvisoIntencion(v: unknown): CfgAvisoIntencion {
  const c: CfgAvisoIntencion = { ...CFG_AVISO_INTENCION_DEFAULT };
  if (!esObj(v)) return c;
  for (const k of Object.keys(CFG_AVISO_INTENCION_DEFAULT) as (keyof CfgAvisoIntencion)[]) {
    const x = v[k];
    if (typeof x === "number" && Number.isFinite(x) && x >= 0) c[k] = x;
  }
  return c;
}

function norm(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const NUM = "(?:\\d{1,2}|un[ao]?|dos|tres|cuatro|cinco|seis)";
/** Señales de compra en un texto del cliente (normalizado: minúsculas, sin tildes). */
const RE_SENAL: RegExp[] = [
  new RegExp(`\\b${NUM} ?(?:unidades?|u|tiras?|parches?|bolsas?|bolsitas?|packs?|paquetes?|cajas?|cajitas?|kits?|de esas?|de esos?)\\b`, "u"),
  /(?:^|\s)x ?\d\b/u,
  /\b(?:el|la|los|las) de (?:\d|dos|tres)\b/u,
  /\b(?:quiero|quisiera|queria|voy a querer|vamos a querer|me llevo|voy a llevar|lo llevo|la llevo|lo compro|la compro|quiero comprar)\b/u,
  // 10-10: "dale" solo cuenta como respuesta suelta ("dale", "si dale", "dale armalo"), no "dale te aviso".
  /^(?:si+ |ok )?dale(?: si+| nomas| armalo| mandalo| mandame| porfa| por favor)?[.! ]*$/u,
  /\b(?:mandame|mandamelo|mandamela|enviame|envialo|enviamelo|anotame|reservame|haceme el pedido)\b/u,
  /\bte (?:paso|mando|envio) (?:los |mis )?(?:datos|direccion|ubicacion|todo)\b/u,
  /\bkatu\b/u,
];
/** "No quiero", "todavía no" anulan la señal del mismo texto. */
const RE_NEGACION = /\b(?:no (?:lo |la )?(?:quiero|voy a querer|me llevo)|todavia no|ahora no|por ahora no|te aviso|despues|mas adelante|la semana que viene|el mes que viene|lo voy a pensar|lo pienso|cuando cobre|otro dia)\b/u;
/** "Quiero saber / info / consultar" es una pregunta, no una compra: se saca antes de buscar señales. */
// 10-10: también "quiero MÁS información" (el texto automático de los anuncios) y "me gustaría conseguir más información".
const RE_CONSULTA = /\b(?:quiero|quisiera|queria|me gustaria|necesito)(?: conseguir| tener| recibir| saber)? (?:(?:mas|un poco mas de|un poco de|algo de) )?(?:saber|info|informacion|consultar|preguntar|ver|averiguar|detalles|datos)\b/gu;

export function tieneSenalCompra(texto: string): boolean {
  const t = norm(texto);
  if (!t || RE_NEGACION.test(t)) return false;
  const limpio = t.replace(RE_CONSULTA, " ");
  return RE_SENAL.some((r) => r.test(limpio));
}

export type DecisionAviso =
  | { tipo: "avisar"; minutos: number; producto: string | null; cantidad: number | null; texto_senal: string }
  | { tipo: "nada"; motivo: string };

const MIN = 60_000;

/** aviso_intencion_en crudo del perfil (normalizarPerfil lo descarta: es una marca de esta función). */
export function avisoIntencionEn(perfil: unknown): string | null {
  const v = esObj(perfil) ? perfil.aviso_intencion_en : null;
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

export function decidirAvisoIntencion(c: Candidato, cfg: CfgAvisoIntencion, ahora: Date): DecisionAviso {
  const nada = (motivo: string): DecisionAviso => ({ tipo: "nada", motivo });
  if (c.estado !== "ia") return nada("no_esta_en_ia");
  const entrada = c.ultima_entrada_en ? Date.parse(c.ultima_entrada_en) : NaN;
  if (!Number.isFinite(entrada)) return nada("sin_entrada_del_cliente");
  const minutos = Math.floor((ahora.getTime() - entrada) / MIN);
  if (minutos < cfg.aviso_intencion_min) return nada("esperando");
  if (minutos >= cfg.aviso_intencion_max_h * 60) return nada("ventana_cerrada");
  const perfil = normalizarPerfil(c.perfil);
  if (perfil.rechazo) return nada("rechazo");
  if (c.ultima_respuesta_derivada) return nada("derivado");
  if (!perfil.producto && !perfil.cantidad) return nada("sin_producto_ni_cantidad");
  const previo = avisoIntencionEn(c.perfil);
  if (previo && ahora.getTime() - Date.parse(previo) < cfg.aviso_intencion_repetir_h * 60 * MIN) return nada("ya_avisado");
  const conSenal = (c.entradas_recientes ?? []).filter((e) => tieneSenalCompra(e.texto));
  if (!conSenal.length) return nada("sin_senal_de_compra");
  // Un pedido creado después de la primera señal de compra (o hasta 5 min antes) = ya compró.
  const primera = Math.min(...conSenal.map((e) => Date.parse(e.creado_en)).filter(Number.isFinite));
  const pedido = c.ultimo_pedido_en ? Date.parse(c.ultimo_pedido_en) : NaN;
  if (Number.isFinite(pedido) && (!Number.isFinite(primera) || pedido >= primera - 5 * MIN)) return nada("ya_hizo_pedido");
  return {
    tipo: "avisar",
    minutos,
    producto: perfil.producto ?? null,
    cantidad: perfil.cantidad ?? null,
    texto_senal: conSenal[0].texto,
  };
}

/** Una línea por cliente: "🛒 <nombre> quiere comprar (<producto> x<cantidad>) pero no mandó los datos hace <N> min." */
export function textoAvisoIntencion(c: Candidato, d: Extract<DecisionAviso, { tipo: "avisar" }>): string {
  const nombre = c.nombre?.trim() || c.telefono || "Un cliente";
  const que = [d.producto ?? "producto sin definir", d.cantidad ? `x${d.cantidad}` : null].filter(Boolean).join(" ");
  const l = [`🛒 <b>${escaparHtml(nombre)}</b> quiere comprar (${escaparHtml(que)}) pero no mandó los datos hace ${d.minutos} min.`];
  const enlace = enlaceWaMe(c.telefono);
  if (enlace) l.push(`Teléfono: ${escaparHtml(c.telefono)} · <a href="${escaparAtributo(enlace)}">escribirle</a>`);
  else l.push("Sin teléfono: respondele desde la bandeja de Voltra OS.");
  l.push(`Dijo: «${escaparHtml(d.texto_senal.replace(/\s+/g, " ").slice(0, 120))}»`);
  return l.join("\n");
}

export type ResumenAvisoIntencion = {
  accion: "inactivo" | "de_noche" | "corrido" | "error";
  candidatos?: number;
  avisados?: number;
  fallas?: number;
  motivos?: Record<string, number>;
};

/** Máximo de clientes por mensaje de Telegram (el resto sale en mensajes siguientes). */
const POR_MENSAJE = 10;

export async function correrAvisosIntencion(deps: DepsSeguimiento, crudo: unknown): Promise<ResumenAvisoIntencion> {
  const marcar = deps.marcarAvisoIntencion;
  const cfg = leerCfgAvisoIntencion(crudo);
  if (!marcar || cfg.aviso_intencion_min <= 0) return { accion: "inactivo" };
  const ahora = deps.ahora();
  if (partesAsuncion(ahora).hora < cfg.aviso_intencion_desde) return { accion: "de_noche" };
  const cfgSeg = leerCfgSeguimiento(crudo);
  const desde = new Date(ahora.getTime() - cfg.aviso_intencion_max_h * H).toISOString();
  const hasta = new Date(ahora.getTime() - cfg.aviso_intencion_min * MIN).toISOString();
  const candidatos = await deps.candidatos(desde, hasta, cfgSeg);

  const motivos: Record<string, number> = {};
  const elegidos: Array<{ c: Candidato; d: Extract<DecisionAviso, { tipo: "avisar" }> }> = [];
  for (const c of candidatos) {
    const d = decidirAvisoIntencion(c, cfg, ahora);
    if (d.tipo === "nada") motivos[d.motivo] = (motivos[d.motivo] ?? 0) + 1;
    else elegidos.push({ c, d });
  }

  // Se marca ANTES de avisar (si dos corridas se pisan, la segunda ya lo ve avisado); si Telegram falla, se desmarca.
  const enISO = ahora.toISOString();
  const marcados: typeof elegidos = [];
  let fallas = 0;
  for (const e of elegidos) {
    try {
      await marcar(e.c.conversacion_id, enISO);
      marcados.push(e);
    } catch (err) {
      fallas++;
      console.error("seguimiento-chat: no se pudo marcar aviso_intencion_en", e.c.conversacion_id, err);
    }
  }

  let avisados = 0;
  for (let i = 0; i < marcados.length; i += POR_MENSAJE) {
    const grupo = marcados.slice(i, i + POR_MENSAJE);
    const cuerpo = grupo.map(({ c, d }) => textoAvisoIntencion(c, d)).join("\n\n");
    // No hay pedido (por definición), así que "Le escribo yo" (escribo:<order_id>) no aplica: botón wa.me por cliente.
    const botones: BotonTelegram[][] = grupo.flatMap(({ c }) => {
      const url = enlaceWaMe(c.telefono);
      const quien = (c.nombre?.trim() || c.telefono || "cliente").slice(0, 30);
      return url ? [[{ texto: `Escribirle a ${quien}`, url }]] : [];
    });
    let ok = false;
    try {
      const r = await deps.avisar(recortar(cuerpo), botones.length ? botones : undefined) as { ok?: boolean } | undefined;
      ok = r?.ok !== false;
    } catch (err) {
      console.error("seguimiento-chat: Telegram falló en el aviso de intención:", err);
    }
    if (ok) {
      avisados += grupo.length;
      continue;
    }
    fallas += grupo.length;
    for (const { c } of grupo) {
      const previo = avisoIntencionEn(c.perfil);
      await marcar(c.conversacion_id, previo).catch(() => {});
    }
  }

  return { accion: "corrido", candidatos: candidatos.length, avisados, fallas, motivos };
}

// ---------- recontacto el día que cobra (08-10-2026) ----------
// El cliente dice "todavía no cobré, otro día te aviso": el vendedor le pregunta qué día cobra y lo guarda en
// perfil_vendedor.recontactar_el (YYYY-MM-DD de Asunción, registrar_perfil). Ese día (o después, si el cron no
// corrió) se lo recontacta UNA vez (marca perfil_vendedor.recontacto_cobro_en; se borra sola si cambia la fecha):
//   · Si su última entrada fue hace < ventana_max_h (23,5 h): escribe el bot (turno "[seguimiento cobro]", gratis
//     dentro de la ventana de 24 h de WhatsApp).
//   · Si no (o si el gasto de IA del mes llegó al tope): aviso a Enrique por Telegram para que le escriba él (fuera
//     de la ventana la API no deja mandar texto libre).
// Mismo horario que los recontactos [horario_desde, horario_hasta) y se apaga con `activo: false`.
// Nunca si: la conversación no está en 'ia', rechazo, baja de marketing o pedido reciente del cliente.
// 19-10 (v35, ítem 6): también cubre "te escribo el [día]" que promete el bot (si lo guarda en recontactar_el). El
// aviso a Enrique (fuera de la ventana) sale desde recontacto_aviso_desde (8) en vez de las 12, con contexto (lo último
// que dijo, la nota del perfil y si tiene permiso de ofertas). Con permiso de ofertas y fuera de la ventana igual va
// el aviso: no hay plantilla de recontacto (el toque 3 excluye a quien tiene fecha pedida).

/** Texto exacto de la entrada del turno de recontacto por cobro (contrato con el prompt del vendedor). */
export const TEXTO_SEGUIMIENTO_COBRO = "[seguimiento cobro]";

export type DecisionCobro =
  | { tipo: "turno" }
  | { tipo: "avisar" }
  | { tipo: "nada"; motivo: string };

/** 19-10: hora de Asunción desde la que sale el aviso a Enrique (el turno del bot sigue en [horario_desde, horario_hasta)). */
export const RECONTACTO_AVISO_DESDE_DEFAULT = 8;

/** config_wa.vendedor_seguimiento.recontacto_aviso_desde (fuera de CfgSeguimiento: la semilla no cambia). */
export function leerRecontactoAvisoDesde(v: unknown): number {
  const x = esObj(v) ? v.recontacto_aviso_desde : undefined;
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x < 24 ? x : RECONTACTO_AVISO_DESDE_DEFAULT;
}

export function decidirRecontactoCobro(c: Candidato, cfg: CfgSeguimiento, ahora: Date, avisoDesde = cfg.horario_desde): DecisionCobro {
  const nada = (motivo: string): DecisionCobro => ({ tipo: "nada", motivo });
  const { hora } = partesAsuncion(ahora);
  if (hora < Math.min(avisoDesde, cfg.horario_desde) || hora >= cfg.horario_hasta) return nada("fuera_de_horario");
  if (c.estado !== "ia") return nada("no_esta_en_ia");
  const perfil = normalizarPerfil(c.perfil);
  if (!perfil.recontactar_el) return nada("sin_fecha");
  if (perfil.recontactar_el > partesAsuncion(ahora).diaISO) return nada("todavia_no");
  if (perfil.recontacto_cobro_en) return nada("ya_recontactado");
  if (perfil.rechazo) return nada("rechazo");
  if (c.baja_marketing) return nada("baja_marketing");
  if (c.pedido_reciente) return nada("pedido_reciente");
  const entrada = c.ultima_entrada_en ? Date.parse(c.ultima_entrada_en) : NaN;
  if (Number.isFinite(entrada) && (ahora.getTime() - entrada) / H < cfg.ventana_max_h) {
    // Escribe el bot: solo en la franja de los recontactos.
    return dentroHorario(ahora, cfg) ? { tipo: "turno" } : nada("fuera_de_horario");
  }
  if (hora < avisoDesde) return nada("fuera_de_horario");
  return { tipo: "avisar" };
}

/** Un bloque por cliente para Telegram. `porTope`: el bot podía escribir pero el gasto de IA del mes llegó al tope. */
export function textoAvisoCobro(c: Candidato, porTope = false, ahora?: Date): string {
  const perfil = normalizarPerfil(c.perfil);
  const nombre = c.nombre?.trim() || c.telefono || "Un cliente";
  const que = [perfil.producto ?? "producto sin definir", perfil.cantidad ? `x${perfil.cantidad}` : null].filter(Boolean).join(" ");
  const por = porTope
    ? "El bot no le puede escribir (el gasto de IA del mes llegó al tope): escribile vos."
    : "Ya pasaron más de 24 h desde su último mensaje: escribile vos.";
  // 19-10: la fecha puede ser el día que cobra o un "te escribo el [día]" que prometió el bot.
  const l = [`📅 <b>${escaparHtml(nombre)}</b>: hoy quedamos en escribirle (${escaparHtml(que)}). ${por}`];
  const ultimo = c.entradas_recientes?.[0];
  if (ultimo?.texto) {
    const dias = ahora ? Math.floor((ahora.getTime() - Date.parse(ultimo.creado_en)) / (24 * H)) : NaN;
    const hace = Number.isFinite(dias) && dias >= 1 ? ` (hace ${dias} día${dias === 1 ? "" : "s"})` : "";
    l.push(`Lo último que dijo${hace}: «${escaparHtml(ultimo.texto.replace(/\s+/g, " ").slice(0, 120))}»`);
  }
  if (perfil.nota) l.push(`Nota: ${escaparHtml(perfil.nota)}`);
  if (!porTope && c.consentimiento_marketing === "si") l.push("Tiene permiso de ofertas: también podés mandarle una plantilla.");
  const enlace = enlaceWaMe(c.telefono);
  if (enlace) l.push(`Teléfono: ${escaparHtml(c.telefono)} · <a href="${escaparAtributo(enlace)}">escribirle</a>`);
  else l.push("Sin teléfono: respondele desde la bandeja de Voltra OS.");
  return l.join("\n");
}

export type ResumenRecontactoCobro = {
  accion: "inactivo" | "fuera_de_horario" | "corrido" | "error";
  candidatos?: number;
  /** Turnos del bot que salieron (respondido / terminal / derivado). */
  enviados?: number;
  omitidos?: number;
  /** Clientes avisados a Enrique por Telegram. */
  avisados?: number;
  fallas?: number;
  motivos?: Record<string, number>;
};

export async function correrRecontactosCobro(deps: DepsSeguimiento, crudo: unknown): Promise<ResumenRecontactoCobro> {
  const buscar = deps.candidatosCobro, marcar = deps.marcarCobro;
  const cfg = leerCfgSeguimiento(crudo);
  if (!buscar || !marcar || !cfg.activo) return { accion: "inactivo" };
  const ahora = deps.ahora();
  const avisoDesde = leerRecontactoAvisoDesde(crudo);
  const hora = partesAsuncion(ahora).hora;
  if (hora < Math.min(avisoDesde, cfg.horario_desde) || hora >= cfg.horario_hasta) return { accion: "fuera_de_horario" };
  const candidatos = await buscar(partesAsuncion(ahora).diaISO, cfg);

  const motivos: Record<string, number> = {};
  let turnos: Candidato[] = [];
  let avisos: Array<{ c: Candidato; porTope: boolean }> = [];
  for (const c of candidatos) {
    const d = decidirRecontactoCobro(c, cfg, ahora, avisoDesde);
    if (d.tipo === "nada") motivos[d.motivo] = (motivos[d.motivo] ?? 0) + 1;
    else if (d.tipo === "turno") turnos.push(c);
    else avisos.push({ c, porTope: false });
  }
  // Tope de gasto de IA: el bot no escribe; se le pasa a Enrique.
  if (turnos.length && await deps.topeGastoSuperado(ahora)) {
    avisos = [...avisos, ...turnos.map((c) => ({ c, porTope: true }))];
    turnos = [];
  }
  if (turnos.length > cfg.lote_max) {
    motivos.lote_lleno = turnos.length - cfg.lote_max;
    turnos = turnos.slice(0, cfg.lote_max);
  }

  const fallas: string[] = [];
  let enviados = 0, omitidos = 0;
  await enLotes(turnos, deps.paralelo ?? 4, async (c) => {
    const id = c.conversacion_id;
    const enISO = deps.ahora().toISOString();
    try {
      // Se marca ANTES del turno: si dos corridas se pisan, la segunda ya lo ve recontactado.
      await marcar(id, enISO);
    } catch (e) {
      fallas.push(`${id}: no se pudo marcar (${e instanceof Error ? e.message : e})`);
      return;
    }
    let r: ResultadoTurno;
    try {
      r = await deps.turno({ conversacion_id: id, wa_message_id: `seguimiento:cobro:${id}:${enISO}`, texto: TEXTO_SEGUIMIENTO_COBRO, origen: "seguimiento" });
    } catch (e) {
      r = { accion: "error_envio", motivo: e instanceof Error ? e.message : String(e) };
    }
    if (r.accion === "respondido" || r.accion === "terminal" || r.accion === "derivado") enviados++;
    else omitidos++;
    if (esFalla(r)) fallas.push(`${id}: recontacto por cobro → ${r.accion}${r.motivo ? ` (${r.motivo})` : ""}`);
    if (r.accion === "derivado") fallas.push(`${id}: recontacto por cobro derivó a Enrique (no debería)`);
    // No salió nada y no se gastó: se desmarca (se intenta en la próxima corrida).
    if (r.accion === "omitido" && !esFalla(r) && !(Number(r.costo_usd) > 0)) {
      await marcar(id, null).catch((e) => fallas.push(`${id}: no se pudo desmarcar (${e instanceof Error ? e.message : e})`));
    }
  });

  // Avisos a Enrique: se marca ANTES de mandar; si Telegram falla, se desmarca.
  const enISO = ahora.toISOString();
  const marcados: typeof avisos = [];
  for (const a of avisos) {
    try {
      await marcar(a.c.conversacion_id, enISO);
      marcados.push(a);
    } catch (e) {
      fallas.push(`${a.c.conversacion_id}: no se pudo marcar (${e instanceof Error ? e.message : e})`);
    }
  }
  let avisados = 0;
  for (let i = 0; i < marcados.length; i += POR_MENSAJE) {
    const grupo = marcados.slice(i, i + POR_MENSAJE);
    const cuerpo = grupo.map(({ c, porTope }) => textoAvisoCobro(c, porTope, ahora)).join("\n\n");
    const botones: BotonTelegram[][] = grupo.flatMap(({ c }) => {
      const url = enlaceWaMe(c.telefono);
      const quien = (c.nombre?.trim() || c.telefono || "cliente").slice(0, 30);
      return url ? [[{ texto: `Escribirle a ${quien}`, url }]] : [];
    });
    let ok = false;
    try {
      const r = await deps.avisar(recortar(cuerpo), botones.length ? botones : undefined) as { ok?: boolean } | undefined;
      ok = r?.ok !== false;
    } catch (err) {
      console.error("seguimiento-chat: Telegram falló en el recontacto por cobro:", err);
    }
    if (ok) {
      avisados += grupo.length;
      continue;
    }
    for (const { c } of grupo) {
      fallas.push(`${c.conversacion_id}: Telegram falló (sale en la próxima corrida)`);
      await marcar(c.conversacion_id, null).catch(() => {});
    }
  }

  if (fallas.length) {
    const lista = fallas.slice(0, 10).map((f) => `• ${escaparHtml(f)}`).join("\n");
    await deps.avisar(
      `<b>Recontacto el día que cobra: ${fallas.length} con problemas</b>\n${lista}${fallas.length > 10 ? `\n… y ${fallas.length - 10} más` : ""}`,
    ).catch((e) => console.error("seguimiento-chat: no se pudo avisar:", e));
  }

  return { accion: "corrido", candidatos: candidatos.length, enviados, omitidos, avisados, fallas: fallas.length, motivos };
}
