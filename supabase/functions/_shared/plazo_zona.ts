// _shared/plazo_zona.ts · 08-10: plazo de entrega según la ciudad (el mismo que dice el vendedor en el prompt).
// Lo usa wa-webhook en la respuesta a "Confirmar pedido" (antes decía "2 a 5 días hábiles" a todos, Asunción incluida).
// 12-10: el rango sale del courier que asigna el ruteo OFICIAL (copia de src/lib/transportadoras.js generada por
// scripts/sincronizar-ruteo.mjs) y de la velocidad de ese courier en esa ciudad. Corte de despacho: 15:00 de Asunción.

import { ciudadLucero, cubre, ruteoOficial, velocidadLucero } from "./transportadoras.js";
import { zonaPaP } from "./cobranzaPaP.js";

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

const CDE = ["ciudad del este", "cde", "hernandarias", "minga guazu", "presidente franco", "pdte franco"];
// 12-10: + Thompson y Loma Pytã (Lucero las lleva en 24-48 h; antes caían en "resto del país"). Con tilde: es el
// nombre que lee el vendedor en PLAZOS DESDE HOY.
const CENTRAL_NOMBRES = [
  "San Lorenzo", "Luque", "Capiatá", "Lambaré", "Fernando de la Mora", "Limpio", "Ñemby", "Mariano Roque Alonso",
  "Villa Elisa", "Itauguá", "Areguá", "San Antonio", "Itá", "Villeta", "Guarambaré", "Ypané", "J. Augusto Saldívar",
  "Ypacaraí", "Thompson", "Loma Pytã",
];
const CENTRAL = [...CENTRAL_NOMBRES.map(norm), "augusto saldivar", "central"];

/** Plazo para la ciudad, o null si no se reconoce (el que llama usa su plazo general). */
export function plazoPorCiudad(ciudad: unknown): string | null {
  if (typeof ciudad !== "string" || !ciudad.trim()) return null;
  const c = ` ${norm(ciudad)} `;
  const tiene = (l: string[]) => l.some((x) => c.includes(` ${x} `));
  if (tiene(CDE)) return "hoy mismo o en 24 h";
  if (tiene(["asuncion"])) return "24 a 48 h";
  if (tiene(CENTRAL)) return "24 a 72 h";
  return null;
}

// ---------- fechas en Asunción (UTC−3); ancla: mediodía UTC de la fecha local ----------

const diaLocal = (d: Date) => new Date(d.getTime() - 3 * 3_600_000);
const finde = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const aFecha = (d: Date) => d.toISOString().slice(0, 10);
const DIA_MS = 86_400_000;
function sumarHabiles(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  let k = n;
  while (k > 0) {
    r.setUTCDate(r.getUTCDate() + 1);
    if (!finde(r)) k--;
  }
  return r;
}

// ---------- 12-10: corte de despacho ----------

/** Hora de Asunción desde la que un pedido ya no sale ese día. Los couriers no trabajan sábado ni domingo. */
export const HORA_CORTE = 15;

/**
 * 12-10: día de despacho de un pedido hecho en `ahora` (mediodía UTC de esa fecha de Asunción). Día hábil antes de
 * las 15:00 → ese mismo día; desde las 15:00, o sábado y domingo → el próximo día hábil (viernes 15:00 → lunes).
 */
export function diaDespacho(ahora: Date): Date {
  const d = diaLocal(ahora);
  const tarde = d.getUTCHours() >= HORA_CORTE;
  d.setUTCHours(12, 0, 0, 0);
  if (tarde) d.setUTCDate(d.getUTCDate() + 1);
  while (finde(d)) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * 09-10: los pedidos del sábado y domingo salen el lunes (cualquier ciudad). 12-10: también los de un día hábil desde
 * las 15:00, que salen el próximo día hábil. Si sale hoy devuelve `ahora`; si no, las 8:00 de Asunción del día de
 * despacho.
 */
export function inicioDespacho(ahora: Date): Date {
  const d = diaDespacho(ahora);
  if (aFecha(d) === aFecha(diaLocal(ahora))) return ahora;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11, 0, 0));
}

/** Sábado o domingo en Asunción. 12-10: ya no sale de inicioDespacho, que ahora también corre por el corte de las 15:00. */
export const esFinDeSemana = (ahora: Date) => finde(diaLocal(ahora));

// ---------- 10-10: plazo en días desde hoy (sin despacho ni entregas sábado y domingo) ----------

export type Zona = "cde" | "asuncion" | "central" | "interior";
/** Días hábiles después del día de despacho: [mínimo, máximo]. CDE puede llegar el mismo día. 12-10: es el respaldo
 *  cuando el ruteo no conoce la ciudad o no hay velocidad del courier (ver rangoEntrega). */
const RANGO_HABIL: Record<Zona, [number, number]> = { cde: [0, 1], asuncion: [1, 2], central: [1, 3], interior: [2, 5] };

export function zonaDeCiudad(ciudad: unknown): Zona {
  const p = plazoPorCiudad(ciudad);
  return p === "hoy mismo o en 24 h" ? "cde" : p === "24 a 48 h" ? "asuncion" : p === "24 a 72 h" ? "central" : "interior";
}

// ---------- 12-10: rango por courier (ruteo oficial + velocidad en esa ciudad) ----------
// Días hábiles DESPUÉS del día de despacho [mín, máx] (0 = el mismo día del despacho):
//   Lucero del Este (velocidad por ciudad en TARIFAS_LUCERO_INFO; retira en CDE, sus horas cuentan desde el despacho):
//     diaria 24 h → [1, 2] (12-10, Enrique: no prometer de más; con margen sube la tasa de entrega) · frecuente 24-48 h → [1, 2]
//     programada 48-72 h con 1-2 viajes por semana → [2, 5] (mínimo 2 días; el máximo cubre esperar el viaje)
//   Punto a Punto (zona de ZONAS_PAP en cobranzaPaP.js). PaP cuenta sus horas desde Asunción (para PaP, CDE es
//   "Interior 1"), así que el máximo suma 1 día por el tramo CDE → Asunción:
//     Gran Asunción 24 h → [1, 2] · Central 24/48 h → [1, 3] · Interior 1 24/72 h → [1, 4] · Interior 2 72/96 h → [3, 5]
//   Con cualquier courier: CDE y alrededores [0, 1] (se despacha desde CDE: "hoy o mañana" si sale hoy) e interior
//   (resto del país) [2, 5], dicho siempre "2 a 5 días hábiles" (10-10). Ciudad que el ruteo no conoce, courier
//   "otra" o sin dato de velocidad → el rango por zona de siempre (RANGO_HABIL).
export const RANGO_LUCERO: Record<string, [number, number]> = { diaria: [1, 2], frecuente: [1, 2], programada: [2, 5] };
export const RANGO_PAP: Record<string, [number, number]> = {
  gran_asuncion: [1, 2],
  central: [1, 3],
  interior1: [1, 4],
  interior2: [3, 5],
};

export type Courier = "lucero" | "pap" | "otra";

/** "Lucero", "LUCERO DEL ESTE", "pap", "Punto a Punto" → id; vacío → null; cualquier otro texto → "otra". */
export function idCourier(c: unknown): Courier | null {
  if (typeof c !== "string" || !c.trim()) return null;
  const n = norm(c);
  if (n.includes("lucero")) return "lucero";
  if (/(^| )pap( |$)/.test(n) || n.includes("punto a punto")) return "pap";
  return "otra";
}

/** El texto tal cual y sin signos ("Asunción, Sajonia" → "Asunción Sajonia"), para el emparejador del ruteo. */
const variantes = (ciudad: string) => [ciudad, ciudad.replace(/[^\p{L}\p{N}.'\s]/gu, " ").replace(/\s+/g, " ").trim()];

/**
 * 12-10: courier de la lista OFICIAL (ruteoOficial de transportadoras.js), si además cubre la ciudad; null si la
 * ciudad no está en la lista. No usa sugerirTransportadora: esa es la variante "de hoy" (preferencia por Lucero por
 * la lluvia del 12-10, regla de JawFlex y comparación de costo), y Enrique pidió el ruteo oficial.
 */
export function courierOficial(ciudad: unknown): "lucero" | "pap" | null {
  if (typeof ciudad !== "string" || !ciudad.trim()) return null;
  for (const v of variantes(ciudad)) {
    const c = ruteoOficial(v) as string | null;
    if (c === "lucero" || c === "pap") return cubre(c, v) ? c : null;
  }
  return null;
}

/** Velocidad de Lucero ('diaria'…) o zona de PaP ('central'…) en esa ciudad, o null si no hay dato. */
function velocidad(c: "lucero" | "pap", ciudad: string): string | null {
  for (const v of variantes(ciudad)) {
    const r = (c === "lucero" ? velocidadLucero(ciudadLucero(v)) : zonaPaP(v)) as string | null;
    if (r) return r;
  }
  return null;
}

export type RangoEntrega = {
  /** Días hábiles después del día de despacho: [mínimo, máximo]. */
  rango: [number, number];
  zona: Zona;
  /** Courier con el que se calculó (el dado o el del ruteo oficial); null si ninguno. */
  courier: Courier | null;
  /** De dónde salió el rango: "lucero diaria", "pap central", "zona central", "CDE y alrededores", "interior". */
  fuente: string;
  /** Se dice "2 a 5 días hábiles" (interior, o el mismo rango con Lucero programada). */
  habiles: boolean;
};

/** 12-10: rango de entrega de la ciudad con `courier`, o con el del ruteo oficial si no viene. */
export function rangoEntrega(ciudad: unknown, courier?: string | null): RangoEntrega {
  const zona = zonaDeCiudad(ciudad);
  const c = idCourier(courier) ?? courierOficial(ciudad);
  const de = (rango: [number, number], fuente: string): RangoEntrega => ({
    rango,
    zona,
    courier: c,
    fuente,
    habiles: zona === "interior" || (rango[0] === 2 && rango[1] === 5),
  });
  if (zona === "cde") return de(RANGO_HABIL.cde, "CDE y alrededores");
  if (zona === "interior") return de(RANGO_HABIL.interior, "interior");
  const vel = (c === "lucero" || c === "pap") && typeof ciudad === "string" ? velocidad(c, ciudad) : null;
  const r = vel ? (c === "lucero" ? RANGO_LUCERO[vel] : RANGO_PAP[vel]) : undefined;
  return r ? de(r, `${c} ${vel}`) : de(RANGO_HABIL[zona], `zona ${zona}`);
}

/** Días corridos desde hoy hasta la entrega [mín, máx] para un rango en días hábiles después del despacho. */
function diasDesdeHoy([a, b]: [number, number], ahora: Date): [number, number] {
  const hoy = diaLocal(ahora);
  hoy.setUTCHours(12, 0, 0, 0);
  const despacho = diaDespacho(ahora);
  const dias = (n: number) => Math.round((sumarHabiles(despacho, n).getTime() - hoy.getTime()) / DIA_MS);
  return [dias(a), dias(b)];
}

/** Días corridos desde hoy hasta la entrega [mín, máx] por zona (sin courier), con el corte de las 15:00. */
export const diasHastaEntrega = (zona: Zona, ahora: Date): [number, number] => diasDesdeHoy(RANGO_HABIL[zona], ahora);

/** "hoy o mañana", "mañana", "en 3 a 4 días", "en 2 días". */
export function textoDias([a, b]: [number, number]): string {
  if (a === 0 && b === 0) return "hoy mismo";
  if (a === 0 && b === 1) return "hoy o mañana";
  if (a === 0) return `hoy o en hasta ${b} días`;
  if (a === 1 && b === 1) return "mañana";
  if (a === 1 && b === 2) return "mañana o pasado";
  if (a === b) return `en ${a} días`;
  return `en ${a} a ${b} días`;
}

// 10-10: para el interior se dice siempre "2 a 5 días hábiles" (decisión de Enrique: convierte mejor que "4 a 9 días").
const INTERIOR = "2 a 5 días hábiles";

/** 12-10: con el courier de la ciudad (el dado o el del ruteo oficial) y el corte de las 15:00. */
export function plazoDesdeHoy(ciudad: unknown, ahora: Date, courier?: string | null): string {
  const r = rangoEntrega(ciudad, courier);
  return r.habiles ? `en ${INTERIOR}` : textoDias(diasDesdeHoy(r.rango, ahora));
}

/** Para plantillas que dicen "Te llega en {plazo}": "3 a 4 días", "el día o al siguiente", "hasta 3 días". */
export function plazoParaEn([a, b]: [number, number]): string {
  if (a === 0 && b <= 1) return "el día o al siguiente";
  if (a === 0) return `hasta ${b} días`;
  if (a === b) return `${a} ${a === 1 ? "día" : "días"}`;
  return `${a} a ${b} días`;
}
/** 12-10: con el courier de la ciudad (el dado o el del ruteo oficial) y el corte de las 15:00. */
export function plazoParaEnDesdeHoy(ciudad: unknown, ahora: Date, courier?: string | null): string {
  const r = rangoEntrega(ciudad, courier);
  return r.habiles ? INTERIOR : plazoParaEn(diasDesdeHoy(r.rango, ahora));
}

/**
 * 8:00 de Asunción (11:00 UTC) del n-ésimo día hábil después de `desde` (sábado y domingo no cuentan). 10-10.
 * `desde` es el despacho: pasalo por inicioDespacho (ahí está el corte de las 15:00).
 */
export function alas8HabilDespues(desde: Date, n: number): Date {
  const d = diaLocal(desde);
  d.setUTCHours(12, 0, 0, 0);
  const r = sumarHabiles(d, n);
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate(), 11, 0, 0));
}

// ---------- 12-10: día concreto de entrega ("mañana martes 13/10") ----------

const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const deFecha = (f: string) => new Date(`${f}T12:00:00Z`); // mediodía: el mismo ancla que usa el resto del módulo
const dd = (n: number) => String(n).padStart(2, "0");

/** Fecha en Asunción (UTC−3) como "2026-10-13". */
export const fechaLocal = (d: Date) => aFecha(diaLocal(d));

/** "2026-10-13" → "martes 13/10". */
export function nombreDia(fecha: string): string {
  const d = deFecha(fecha);
  return `${DIAS_SEMANA[d.getUTCDay()]} ${dd(d.getUTCDate())}/${dd(d.getUTCMonth() + 1)}`;
}

/** Cómo se nombra `fecha` visto desde `hoy`: "hoy", "mañana martes 13/10" o "el lunes 19/10". */
export function etiquetaDia(fecha: string, hoy: string): string {
  if (fecha === hoy) return "hoy";
  const manana = aFecha(new Date(deFecha(hoy).getTime() + DIA_MS));
  return fecha === manana ? `mañana ${nombreDia(fecha)}` : `el ${nombreDia(fecha)}`;
}

export type DiaEntrega = {
  /** Listo para el cliente: "hoy o mañana martes 13/10", "entre mañana martes 13/10 y el jueves 15/10",
   *  interior "en 2 a 5 días hábiles (entre el miércoles 14/10 y el lunes 19/10)". Nunca hora ni "sale el lunes". */
  texto: string;
  zona: Zona;
  /** 12-10: courier con el que se calculó (el dado o el del ruteo oficial); null si ninguno. */
  courier: Courier | null;
  /** Día de despacho, primer y último día posible de entrega ("2026-10-13"). */
  despacho: string;
  desde: string;
  hasta: string;
};

/**
 * 12-10: día concreto de entrega para el resumen del vendedor ("Te llega: …"), la confirmación v4 y la respuesta a
 * "Confirmar pedido". Rango de rangoEntrega (courier dado o el del ruteo oficial) contado desde el día de despacho
 * (diaDespacho: corte 15:00, sin sábado ni domingo).
 */
export function diaEntrega(ciudad: unknown, ahora: Date, courier?: string | null): DiaEntrega {
  const r = rangoEntrega(ciudad, courier);
  const hoy = fechaLocal(ahora);
  const despacho = diaDespacho(ahora);
  const [a, b] = r.rango;
  const desde = aFecha(sumarHabiles(despacho, a));
  const hasta = aFecha(sumarHabiles(despacho, b));
  const seguidos = aFecha(sumarHabiles(deFecha(desde), 1)) === hasta;
  const rango = desde === hasta
    ? (desde === hoy ? `hoy ${nombreDia(desde)}` : etiquetaDia(desde, hoy))
    : seguidos
    ? `${etiquetaDia(desde, hoy)} o ${etiquetaDia(hasta, hoy)}`
    : `entre ${etiquetaDia(desde, hoy)} y ${etiquetaDia(hasta, hoy)}`;
  // Interior (y Lucero programada, mismo rango): siempre "2 a 5 días hábiles" (10-10); las fechas van entre paréntesis.
  const texto = r.habiles ? `en ${INTERIOR} (${rango})` : rango;
  return { texto, zona: r.zona, courier: r.courier, despacho: aFecha(despacho), desde, hasta };
}

const enLista = (l: string[]) => l.length > 1 ? `${l.slice(0, -1).join(", ")} y ${l[l.length - 1]}` : l[0];

/**
 * Línea para el vendedor con los plazos ya calculados para este momento. 12-10: por courier (ruteo oficial) y con el
 * corte de las 15:00; cada texto es el mismo diaEntrega(ciudad, ahora).texto del resumen ("Te llega: …"), así el
 * vendedor y el resumen nunca dicen dos cosas distintas para la misma ciudad.
 */
export function lineaPlazosHoy(ahora: Date): string {
  const t = (ciudad: string) => diaEntrega(ciudad, ahora).texto;
  const grupos = new Map<string, string[]>();
  for (const c of ["Asunción", ...CENTRAL_NOMBRES]) {
    const texto = t(c);
    grupos.set(texto, [...(grupos.get(texto) ?? []), c]);
  }
  const partes = [
    `Ciudad del Este, Hernandarias, Minga Guazú y Pdte. Franco: ${t("Ciudad del Este")}`,
    ...[...grupos].map(([texto, ciudades]) => `${enLista(ciudades)}: ${texto}`),
    `Otras ciudades de Central: ${t("Central")}`,
    `Resto del país: ${t("Encarnación")}`,
  ];
  return `PLAZOS DESDE HOY (ya calculados con el día y la hora de ahora y el courier de cada ciudad; decí exactamente esto, sin agregar horas): ${partes.join(". ")}.`;
}

/**
 * 12-10: aviso de la víspera (Asunción y Central). Sale a las `hora` (18:00) de Asunción del día de despacho y dice
 * el próximo día hábil: "mañana martes 13/10", o "el lunes 19/10" si se despacha el viernes. Si ya pasó esa hora,
 * `enviar` es el momento del despacho (el que llama decide si todavía está en horario). El día de despacho tiene el
 * corte de las 15:00: marcado después, el aviso sale a las 18:00 del próximo día hábil.
 */
export function visperaEntrega(ahoraReal: Date, hora = 18): { enviar: Date; entrega: string; dia: string } {
  const inicio = inicioDespacho(ahoraReal);
  const desp = diaDespacho(ahoraReal);
  const entrega = aFecha(sumarHabiles(desp, 1));
  const aLaHora = new Date(Date.UTC(desp.getUTCFullYear(), desp.getUTCMonth(), desp.getUTCDate(), hora + 3, 0, 0));
  return { enviar: aLaHora.getTime() > inicio.getTime() ? aLaHora : inicio, entrega, dia: etiquetaDia(entrega, aFecha(desp)) };
}

/** Hora de Asunción (0-23) de un instante. */
export const horaLocal = (d: Date) => diaLocal(d).getUTCHours();

// ---------- 13-10: entrega programada (el cliente pide un día concreto) ----------
// Regla del dueño (13-10): se puede programar cualquier fecha FUTURA igual o posterior a la fecha mínima de entrega
// (el primer día del rango de diaEntrega para esa ciudad y courier, con el corte de las 15:00 y sin sábado ni
// domingo); nunca antes. El pedido sale el mismo día como cualquier otro: al courier se le pasa "Entregar el viernes
// 16/10 (antes de las 12). No entregar antes." En Shopify queda el tag ENTREGA_PROGRAMADA y los atributos
// entrega_programada = "YYYY-MM-DD" (fecha de Asunción) y entrega_franja = texto corto opcional ("antes de las 12").

export const TAG_ENTREGA_PROGRAMADA = "ENTREGA_PROGRAMADA";
export const ATRIBUTO_FECHA_PROGRAMADA = "entrega_programada";
export const ATRIBUTO_FRANJA_PROGRAMADA = "entrega_franja";

export type EntregaProgramada = { fecha: string; franja: string | null };

/** 13-10: primer día posible de entrega ("2026-10-14") para la ciudad y el courier, desde `ahora`. */
export function fechaMinimaEntrega(ciudad: unknown, ahora: Date, courier?: string | null): string {
  return diaEntrega(ciudad, ahora, courier).desde;
}

/**
 * 13-10: día hábil en que hay que darle el pedido al courier para que llegue el `fechaEntrega`: la fecha menos los días
 * hábiles MÁXIMOS de tránsito del courier en esa zona (rangoEntrega(...).rango[1]); CDE y alrededores: el mismo día
 * (el courier sale de CDE y entrega en el día). Se usa el máximo y no el mínimo para que llegue ese día y no después; si llega antes, el courier lo guarda
 * con la nota "No entregar antes". Nunca antes de hoy (con el corte de las 15:00: diaDespacho(ahora)).
 * Desde el 13-10 los pedidos programados salen el mismo día como cualquier otro: queda como dato para Despacho.
 */
export function diaDespachoParaEntrega(fechaEntrega: string, ciudad: unknown, courier?: string | null, ahora: Date = new Date()): string {
  const r = rangoEntrega(ciudad, courier);
  const max = r.zona === "cde" ? 0 : r.rango[1]; // CDE: el courier la lleva en el día; se le da ese mismo día
  const d = deFecha(fechaEntrega);
  while (finde(d)) d.setUTCDate(d.getUTCDate() - 1); // entrega sábado o domingo: se cuenta desde el viernes
  let k = max;
  while (k > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (!finde(d)) k--;
  }
  const hoy = aFecha(diaDespacho(ahora));
  return aFecha(d) < hoy ? hoy : aFecha(d);
}

/** 13-10: "2026-10-16" → "viernes 16/10". */
export const textoFecha = (fecha: string): string => nombreDia(fecha);

/** 13-10: "el viernes 16/10, antes de las 12" (franja opcional). */
export const textoEntregaProgramada = (p: EntregaProgramada): string => `el ${textoFecha(p.fecha)}${p.franja ? `, ${p.franja}` : ""}`;

const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** "2026-10-16" válida (no "2026-02-30"). */
export function esFechaValida(f: unknown): f is string {
  if (typeof f !== "string") return false;
  const m = FECHA_RE.exec(f.trim());
  if (!m) return false;
  return aFecha(deFecha(f.trim())) === f.trim();
}

/**
 * 13-10: entrega programada desde el pedido de Shopify guardado (shopify_pedidos.raw): REST (note_attributes
 * [{name, value}]) o GraphQL (customAttributes [{key, value}]). Manda el atributo entrega_programada con una fecha
 * válida; el tag ENTREGA_PROGRAMADA solo no alcanza (sin fecha no hay nada que respetar) y el atributo sin el tag
 * vale igual (Shopify puede mandar el orders/updated del atributo antes que el del tag). null si no hay.
 */
export function leerEntregaProgramada(raw: unknown): EntregaProgramada | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pares: Array<[string, unknown]> = [];
  for (const lista of [r.note_attributes, r.customAttributes]) {
    if (!Array.isArray(lista)) continue;
    for (const a of lista) {
      if (!a || typeof a !== "object") continue;
      const o = a as Record<string, unknown>;
      pares.push([String(o.name ?? o.key ?? "").trim().toLowerCase(), o.value]);
    }
  }
  const valor = (k: string) => {
    const p = pares.find(([n]) => n === k);
    return typeof p?.[1] === "string" && p[1].trim() ? p[1].trim() : null;
  };
  const fecha = valor(ATRIBUTO_FECHA_PROGRAMADA);
  if (!esFechaValida(fecha)) return null;
  const franja = valor(ATRIBUTO_FRANJA_PROGRAMADA);
  return { fecha, franja: franja ? franja.replace(/\s+/g, " ").slice(0, 60) : null };
}

/** 13-10: 8:00 de Asunción (11:00 UTC) de una fecha "YYYY-MM-DD". */
export const alas8DeFecha = (fecha: string): Date => new Date(`${fecha}T11:00:00Z`);

/** 13-10: día hábil anterior a `fecha` ("2026-10-19" lunes → "2026-10-16" viernes). */
export function habilAnterior(fecha: string): string {
  const d = deFecha(fecha);
  do d.setUTCDate(d.getUTCDate() - 1); while (finde(d));
  return aFecha(d);
}
