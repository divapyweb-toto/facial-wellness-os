// _shared/casos_courier.ts · 04-11 (Enrique: "cuando son casos de reclamo de envio o coordinar, el bot puede coordinar
// y/o tomar reclamo y luego por telegram ya se me manda mensaje para lucero y/o pap"). CONTRATO común:
//   · el vendedor guarda el caso (herramienta caso_courier) en public.casos_courier en vez de pasarle el chat a Enrique;
//   · pedidos-trabados junta los pendientes y le manda a Enrique UN Telegram por courier, listo para copiar y pegar en el
//     WhatsApp de Lucero o PaP: lun–sáb a las 08:30 y a las 14:00 (Paraguay); un caso urgente ("lo necesito hoy") sale ya.
// Lógica pura (sin red): tipos, guía, textos.
import { escaparHtml } from "./telegram_formato.ts";

export type CourierCaso = "lucero" | "pap";
export type TipoCaso = "reclamo" | "coordinar" | "no_encontrada" | "plazo";
export type OrigenCaso = "bot" | "sistema";
export type EstadoCaso = "pendiente" | "enviado" | "cerrado";

/** Fila de public.casos_courier (migración 20261104000001_casos_courier.sql). */
export interface CasoCourier {
  id: string;
  creado_en: string;
  shopify_order_id: number;
  /** "VT-1172". */
  ref: string;
  courier: CourierCaso;
  origen: OrigenCaso;
  tipo: TipoCaso;
  /** Qué pide el cliente (o qué detectó el sistema), en una frase corta y sin datos de pago. */
  pide: string;
  horario: string | null;
  referencia: string | null;
  recibe: string | null;
  urgente: boolean;
  estado: EstadoCaso;
  enviado_en: string | null;
  /** Clave del Telegram en que salió ("2026-11-04:am:lucero", "urgente:<id>"). */
  lote: string | null;
  cliente_id: string | null;
  conversacion_id: string | null;
}

/** Una línea del mensaje al courier (datos ya cruzados con el pedido y el courier). */
export interface LineaCaso {
  /** Lucero "L-VT-1172"; PaP "Guía 26483860 · VT-1027" (ver guiaDe). */
  guia: string;
  ref: string;
  /** Nombre del envío (como figura en la guía). */
  nombre: string;
  ciudad: string;
  /** Fecha de ingreso al courier AAAA-MM-DD, o null si no se sabe. */
  fechaIngreso: string | null;
  /** Qué pasa o qué pide el cliente, con sus palabras resumidas ("Esperó el martes 03/11 y no le llegó"). */
  pide: string;
  horario?: string | null;
  referencia?: string | null;
  recibe?: string | null;
  /** Desde cuándo espera el cliente (fecha del caso) AAAA-MM-DD. No va en el texto: ordena y sirve para reenviar. */
  esperaDesde: string | null;
  urgente?: boolean;
  /** 04-11: los del sistema (no_encontrada, plazo) van agrupados en su propio punto con la pregunta al principio. */
  tipo?: TipoCaso;
  origen?: OrigenCaso;
}

/** Rendición pendiente de PaP (va en su propio punto, solo si hay). */
export interface RendicionPendiente { ref: string; monto: number; fechaEntrega: string | null }

export const NOMBRE_COURIER: Record<CourierCaso, string> = { lucero: "Lucero", pap: "Punto a Punto" };

/** Guía para el courier: Lucero "L-VT-xxxx"; PaP "Guía <número> · VT-xxxx" (sin número, solo la referencia). */
export function guiaDe(courier: CourierCaso, ref: string, guiaPap?: string | null): string {
  if (courier === "lucero") return `L-${ref}`;
  return guiaPap?.trim() ? `Guía ${guiaPap.trim()} · ${ref}` : ref;
}

/** Respuesta fija al cliente cuando el caso quedó guardado (la escribe el sistema, nunca la IA). */
export const respuestaCaso = (courier: CourierCaso, urgente: boolean) =>
  `Listo, se lo paso a ${NOMBRE_COURIER[courier]} para que te contacten${urgente ? " hoy" : ""} 🙌`;

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const ddmm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;

const sumarDias = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/**
 * 19-11: el courier puede leer el texto otro día (un urgente de la noche sale a las 07:00). "hoy", "ayer", "mañana" y
 * "pasado mañana" pasan a fecha, con base en el día en que se creó el caso (`dia`, AAAA-MM-DD). Si ya viene la fecha
 * ("hoy 18/11") queda "el 18/11". "a la mañana", "de mañana", "por la mañana" (= a la mañana) no se tocan. Sin día, igual.
 */
export function fechasAbsolutas(texto: string, dia: string | null | undefined): string {
  if (!dia || !/^\d{4}-\d{2}-\d{2}/.test(dia)) return texto;
  const re = /(?<!\b(?:la|de|esta|toda|por)\s)\b(pasado\s+ma[ñn]ana|hoy|ma[ñn]ana|ayer)\b(\s+(?:el\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?/giu;
  return texto.replace(re, (_m, palabra: string, fecha: string | undefined, pos: number, todo: string) => {
    const k = palabra.toLowerCase().replace(/\s+/g, " ");
    const n = k === "hoy" ? 0 : k === "ayer" ? -1 : k.startsWith("pasado") ? 2 : 1;
    const valor = fecha ? fecha.trim().replace(/^el\s+/i, "") : ddmm(sumarDias(dia, n));
    const inicio = pos === 0 || /[.!?]\s*$/.test(todo.slice(0, pos));
    return `${inicio ? "El" : "el"} ${valor}`;
  });
}
export const fechaConDia = (f: string) => `${DIAS[new Date(`${f.slice(0, 10)}T12:00:00Z`).getUTCDay()]} ${ddmm(f)}`;
const punto = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const gs = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** "L-VT-9001 · Ana Prueba · Ciudad Inventada · ingresó el 30/10. <qué pasa>. Horario: de 12 a 15." (formato de Enrique, 04-11). */
// 18-11: el courier lee el texto directo por WhatsApp; nada repetido. "pide" puede traer la misma frase dos veces
// (con "o"/"y" o el orden cambiado) y repetir el horario o la referencia que vienen en sus campos.
const normalizar = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const palabras = (s: string) => new Set(normalizar(s).split(" ").filter(Boolean));
const numeros = (s: string) => new Set(normalizar(s).split(" ").filter((w) => /^\d+$/.test(w)));
const parecido = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let comun = 0;
  for (const w of a) if (b.has(w)) comun++;
  return comun / (a.size + b.size - comun);
};
const tieneHorario = (s: string) => /\bde \d{1,2}(:\d{2})? a \d{1,2}\b/.test(normalizar(s).replace(/(\d+) (\d{2})\b/g, "$1:$2"));
/** Frases de "pide" sin las casi repetidas (se queda la primera). */
export function frasesSinRepetir(texto: string): string[] {
  const frases = texto.split(/(?<=[.!?])\s+/).map((f) => f.trim()).filter(Boolean);
  const quedan: string[] = [];
  for (const f of frases) if (!quedan.some((q) => parecido(palabras(q), palabras(f)) >= 0.6)) quedan.push(f);
  return quedan;
}
/** ¿El horario del campo ya está dicho en alguna frase con horario (mismas horas)? */
const horarioDicho = (frases: string[], horario: string) => {
  const hs = numeros(horario);
  return hs.size > 0 && frases.some((f) => tieneHorario(f) && [...hs].every((n) => numeros(f).has(n)));
};
/** ¿La referencia ya está dicha (casi todas sus palabras en una frase)? */
const referenciaDicha = (frases: string[], ref: string) => {
  const rs = palabras(ref);
  return rs.size > 0 && frases.some((f) => { const fs = palabras(f); return [...rs].filter((w) => fs.has(w)).length / rs.size >= 0.8; });
};

export function lineaCaso(l: LineaCaso): string {
  const partes = [`${l.guia} · ${l.nombre} · ${l.ciudad}${l.fechaIngreso ? ` · ingresó el ${ddmm(l.fechaIngreso)}` : ""}.`];
  // 19-11: con fecha (el courier puede leerlo al día siguiente); "hoy" del cliente también pasa a fecha.
  if (l.urgente) partes.push(l.esperaDesde ? `URGENTE: el cliente lo necesita desde el ${ddmm(l.esperaDesde)}.` : "URGENTE: el cliente lo necesita cuanto antes.");
  const frases = l.pide.trim() ? frasesSinRepetir(fechasAbsolutas(l.pide, l.esperaDesde)) : [];
  if (frases.length) partes.push(punto(frases.join(" ")));
  if (l.horario?.trim() && !horarioDicho(frases, l.horario)) partes.push(punto(`Horario: ${l.horario.trim()}`));
  if (l.referencia?.trim() && !referenciaDicha(frases, l.referencia)) partes.push(punto(`Referencia: ${l.referencia.trim()}`));
  if (l.recibe?.trim()) partes.push(punto(`Recibe: ${l.recibe.trim()}`));
  return partes.join(" ");
}

const ENCABEZADO: Record<CourierCaso, string> = {
  lucero: "Buenas, les escribo de Voltra (Facial Wellness). Necesito ayuda con estos envíos, los clientes nos están reclamando:",
  pap: "Buenas, les escribo de Voltra (Facial Wellness). Consulto por estos envíos:",
};

/** Pregunta del punto agrupado de los casos del sistema. */
function preguntaGrupo(tipo: "no_encontrada" | "plazo", ls: LineaCaso[]): string {
  const n = ls.length;
  if (tipo === "no_encontrada") {
    return `${n === 1 ? "Este" : `Estos ${n}`} en su página ${n === 1 ? "aparece" : "aparecen"} como "No se encontró el envío solicitado". ¿${n === 1 ? "Lo recibieron" : "Los recibieron"}? ¿En qué estado ${n === 1 ? "está" : "están"}?`;
  }
  return `${n === 1 ? "Este sigue" : `Estos ${n} siguen`} sin moverse. ¿Me confirman cuándo ${n === 1 ? "sale" : "salen"} a reparto?`;
}

/**
 * Texto para pegar en el WhatsApp del courier (sin HTML), con el formato de Enrique del 04-11: encabezado; los casos del
 * sistema agrupados en su propio punto (pregunta primero, un envío por línea con "- "); cada caso de cliente en su punto;
 * en PaP las rendiciones pendientes en su propio punto (solo si hay); cierre con pregunta concreta.
 */
export function textoParaCourier(courier: CourierCaso, lineas: LineaCaso[], rendiciones: RendicionPendiente[] = []): string {
  const puntos: string[] = [];
  for (const tipo of ["no_encontrada", "plazo"] as const) {
    const ls = lineas.filter((l) => l.tipo === tipo);
    if (ls.length) puntos.push(`${preguntaGrupo(tipo, ls)}\n${ls.map((l) => `- ${lineaCaso(l)}`).join("\n")}`);
  }
  for (const l of lineas.filter((x) => x.tipo !== "no_encontrada" && x.tipo !== "plazo")) puntos.push(lineaCaso(l));
  if (courier === "pap" && rendiciones.length) {
    const r = rendiciones.map((x) => `${x.ref} (Gs. ${gs(x.monto)})`).join(", ");
    const f = rendiciones.find((x) => x.fechaEntrega)?.fechaEntrega;
    puntos.push(`Quedan sin rendir ${r}${f ? `, entregados el ${ddmm(f)}` : ""}. ¿Cuándo los depositan?`);
  }
  const cuerpo = puntos.map((p, i) => `${i + 1}) ${p}`).join("\n\n");
  // 19-11: a Lucero sin pedirle confirmación de salida (el estado está en su sistema); solo las incidencias.
  const cierre = lineas.length && courier !== "lucero" ? "¿Me confirman qué día sale cada uno? Muchas gracias." : "Muchas gracias.";
  return `${ENCABEZADO[courier]}\n\n${cuerpo}\n\n${cierre}`;
}

/** Telegram para Enrique: encabezado + bloque copiable (<pre>, un toque para copiar en Telegram). */
export function textoTelegramCasos(courier: CourierCaso, lineas: LineaCaso[], urgente = false, rendiciones: RendicionPendiente[] = []): string {
  const n = lineas.length;
  return `${urgente ? "🚨" : "📦"} <b>Para ${NOMBRE_COURIER[courier]}</b> · ${n} ${n === 1 ? "caso" : "casos"}. Copiá y pegá en su WhatsApp:\n\n` +
    `<pre>${escaparHtml(textoParaCourier(courier, lineas, rendiciones))}</pre>`;
}
