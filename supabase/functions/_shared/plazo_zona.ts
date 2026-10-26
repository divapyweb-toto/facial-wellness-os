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

/**
 * 12-10: rango de entrega de la ciudad con `courier`, o con el del ruteo oficial si no viene.
 * 20-10: con la tabla de tarifas cargada (cargarTarifasCourier), los días hábiles salen de tarifas_courier_vigente:
 * del courier dado o, si no viene, del sugerido (misma regla que la rpc sugerir_courier). Sin tabla, ciudad que la
 * tabla no conoce, courier "otra" o sin días cargados → el cálculo de siempre (rangoBase).
 */
export function rangoEntrega(ciudad: unknown, courier?: string | null): RangoEntrega {
  const r = rangoDeTabla(ciudad, courier) ?? rangoBase(ciudad, courier);
  return r.zona === "interior" ? rangoInterior(r, ciudad, courier) : r;
}

/**
 * 26-10 (Enrique): en el interior, si va por Punto a Punto (Lucero no llega con cobranza), "3 a 7 días hábiles":
 * PaP tarda mediana 4,5-6 días desde la venta y 32% llega en 7 o más (26-10: 4 de 5 envíos PaP fuera de "2 a 5").
 * Con Lucero, o sin dato del courier, sigue "2 a 5". El courier es el dado o el de la rpc sugerir_courier
 * (consultarCourierCiudad), nunca una lista propia.
 */
export const RANGO_INTERIOR_PAP: [number, number] = [3, 7];
/** 26-10: interruptor config_wa.plazo_courier.pap_3a7 (lo lee cargarTarifasCourier; sin dato = prendido). false = "2 a 5" como antes. */
let plazoPap3a7 = true;
export const plazoPapActivo = (): boolean => plazoPap3a7;
/** Tests y cargarTarifasCourier. */
export function fijarPlazoPap(activo: boolean): void {
  plazoPap3a7 = activo;
}
function rangoInterior(r: RangoEntrega, ciudad: unknown, courier?: string | null): RangoEntrega {
  if (!plazoPap3a7) return r;
  const dado = idCourier(courier);
  const c = dado === "lucero" || dado === "pap" ? dado : courierDeLaCiudad(ciudad);
  const regla: RangoEntrega = c === "pap"
    ? { ...r, rango: RANGO_INTERIOR_PAP, courier: "pap", fuente: `${r.fuente} · pap 3 a 7`, habiles: true }
    : c ? { ...r, courier: c } : r;
  // 26-10 (Enrique): si la tabla de ese courier dice un máximo MÁS largo que la regla (Lucero con salida 1 vez por
  // semana: "3 a 9"), se promete el de la tabla. Nunca se acorta: un máximo igual o menor deja la regla.
  if (!c) return regla;
  const f = filaTarifa(c, ciudadNorm(ciudad));
  const a = numero(f?.dias_min), b = numero(f?.dias_max);
  if (a === null || b === null || a < 0 || b < a || b <= regla.rango[1]) return regla;
  return { ...regla, rango: [a, b], fuente: `tabla ${c} ${f!.ciudad} (más largo que la regla)`, habiles: true };
}

/** El rango de siempre (ruteo oficial + velocidad), sin la tabla de tarifas. */
function rangoBase(ciudad: unknown, courier?: string | null): RangoEntrega {
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

// ---------- 20-10: tarifas oficiales por courier y ciudad (tabla tarifas_courier, migración 20261020000001) ----------
// Caché por instancia, opcional: la carga cargarTarifasCourier(db) en los puntos de entrada (turno del vendedor,
// shopify-webhook). Se refresca cada 10 min; si la carga falla queda vacía y todo funciona como antes de la tabla.

export type FilaTarifaCourier = {
  courier: string;
  /** Clave normalizada (ciudad_norm). */
  ciudad: string;
  ciudad_nombre?: string | null;
  /** Otras grafías, ya normalizadas. */
  alias?: string[] | null;
  zona?: string | null;
  precio: number | string;
  tiempo?: string | null;
  dias_min: number | null;
  dias_max: number | null;
  aplica_cobranza: boolean;
  tiene_agencia?: boolean | null;
};
export type FilaTasaCourier = { courier: string; tasa_usada: number | string | null; pocos_datos?: boolean | null; resueltos?: number | null };

export type OpcionCourier = {
  courier: "pap" | "lucero";
  precio: number;
  cobranza: boolean;
  zona: string | null;
  tiempo: string | null;
  dias_min: number | null;
  dias_max: number | null;
  tasa: number | null;
  pocos_datos: boolean | null;
  costo_por_entregado: number | null;
  valido: boolean;
};
export type SugerenciaCourier = {
  sugerido: "pap" | "lucero" | null;
  /** Ningún courier de la tabla cobra contra entrega ahí (con cod = false: ninguno llega). */
  sin_cobertura: boolean;
  /** La ciudad está en la tabla de algún courier (false: typo o pueblo chico). */
  ciudad_reconocida: boolean;
  opciones: OpcionCourier[];
};

type CacheTarifas = { filas: FilaTarifaCourier[]; tasas: Map<string, { tasa: number | null; pocos_datos: boolean | null }>; cargadaEn: number };

export const REFRESCO_TARIFAS_MS = 10 * 60_000;
const REINTENTO_TARIFAS_MS = 60_000;
const TIMEOUT_TARIFAS_MS = 4_000;
let tarifas: CacheTarifas | null = null;
let ultimoIntentoTarifas = 0;
let cargaEnCurso: Promise<boolean> | null = null;

/** Misma normalización que public.ciudad_norm y scripts/tarifas-courier.mjs (`norm`). */
export const ciudadNorm = (t: unknown): string =>
  String(t ?? "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(cnel|cnl)\.?(\s|$)/g, "coronel ").replace(/\bgral\.?(\s|$)/g, "general ").replace(/\b(pdte|pte)\.?(\s|$)/g, "presidente ")
    .replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

const numero = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Carga la tabla en memoria a mano (tests; también la usa cargarTarifasCourier). Lista vacía = sin tabla. */
export function fijarTarifasCourier(filas: FilaTarifaCourier[], tasas: FilaTasaCourier[], ahoraMs = Date.now()): void {
  const validas = filas.filter((f) => (f.courier === "pap" || f.courier === "lucero") && typeof f.ciudad === "string" && f.ciudad);
  tarifas = validas.length
    ? {
      filas: validas,
      tasas: new Map(tasas.map((t) => [t.courier, { tasa: numero(t.tasa_usada), pocos_datos: t.pocos_datos ?? null }])),
      cargadaEn: ahoraMs,
    }
    : null;
}

/** Vacía la caché (tests). */
export function limpiarTarifasCourier(): void {
  tarifas = null;
  ultimoIntentoTarifas = 0;
  cargaEnCurso = null;
}

export const hayTarifasCourier = (): boolean => tarifas !== null;

type RespuestaSelect = { data: unknown; error: { message: string } | null };
/** Lo mínimo del cliente de Supabase que hace falta (db() de _shared/db.ts lo cumple). */
export type ClienteTarifas = { from(tabla: string): { select(columnas: string): PromiseLike<RespuestaSelect> } };

/**
 * 20-10: carga (o refresca, cada 10 min) tarifas_courier_vigente + tasa_entrega_courier. Nunca lanza: si falla o
 * tarda más de 4 s, la caché queda vacía (se reintenta al minuto) y rangoEntrega sigue como antes. true = hay tabla.
 */
export function cargarTarifasCourier(sb: ClienteTarifas, ahoraMs = Date.now()): Promise<boolean> {
  if (tarifas && ahoraMs - tarifas.cargadaEn < REFRESCO_TARIFAS_MS) return Promise.resolve(true);
  if (cargaEnCurso) return cargaEnCurso;
  if (!tarifas && ultimoIntentoTarifas && ahoraMs - ultimoIntentoTarifas < REINTENTO_TARIFAS_MS) return Promise.resolve(false);
  ultimoIntentoTarifas = ahoraMs;
  const carga = (async () => {
    let reloj: ReturnType<typeof setTimeout> | undefined;
    try {
      const vence = new Promise<never>((_, no) => {
        reloj = setTimeout(() => no(new Error(`más de ${TIMEOUT_TARIFAS_MS / 1000} s`)), TIMEOUT_TARIFAS_MS);
      });
      const [f, t, c] = await Promise.race([
        Promise.all([
          sb.from("tarifas_courier_vigente").select("courier,ciudad,ciudad_nombre,alias,zona,precio,tiempo,dias_min,dias_max,aplica_cobranza,tiene_agencia"),
          sb.from("tasa_entrega_courier").select("courier,tasa_usada,pocos_datos,resueltos"),
          sb.from("config_wa").select("clave,valor"), // 26-10: interruptor plazo_courier.pap_3a7
        ]),
        vence,
      ]);
      const pc = ((c.data ?? []) as { clave?: string; valor?: { pap_3a7?: unknown } }[]).find((x) => x.clave === "plazo_courier")?.valor;
      if (!c.error) fijarPlazoPap(pc?.pap_3a7 !== false);
      if (f.error) throw new Error(`tarifas_courier_vigente: ${f.error.message}`);
      if (t.error) throw new Error(`tasa_entrega_courier: ${t.error.message}`);
      fijarTarifasCourier((f.data ?? []) as FilaTarifaCourier[], (t.data ?? []) as FilaTasaCourier[], ahoraMs);
      return tarifas !== null;
    } catch (e) {
      tarifas = null;
      console.warn("plazo_zona: no se pudo cargar la tabla de tarifas, sigo sin ella:", e instanceof Error ? e.message : e);
      return false;
    } finally {
      if (reloj !== undefined) clearTimeout(reloj);
    }
  })();
  cargaEnCurso = carga.finally(() => {
    cargaEnCurso = null;
  });
  return cargaEnCurso;
}

/** Fila del courier para una ciudad escrita libre (misma regla que public.tarifa_courier, sin el respaldo por zona). */
function filaTarifa(courier: "pap" | "lucero", k: string): FilaTarifaCourier | null {
  if (!tarifas || !k) return null;
  const kk = ` ${k} `;
  let mejor: FilaTarifaCourier | null = null, mejorOrden = 2, mejorLargo = -1;
  for (const f of tarifas.filas) {
    if (f.courier !== courier) continue;
    const alias = (f.alias ?? []).filter((a) => typeof a === "string" && a);
    const exacto = f.ciudad === k || alias.includes(k);
    const aliasDentro = alias.filter((a) => kk.includes(` ${a} `));
    if (!exacto && !kk.includes(` ${f.ciudad} `) && !aliasDentro.length) continue;
    const orden = exacto ? 0 : 1;
    const largo = Math.max(f.ciudad.length, ...aliasDentro.map((a) => a.length));
    if (orden < mejorOrden || (orden === mejorOrden && largo > mejorLargo)) {
      mejor = f;
      mejorOrden = orden;
      mejorLargo = largo;
    }
  }
  return mejor;
}

/**
 * 20-10: courier sugerido con la tabla en memoria, misma regla que la rpc sugerir_courier: entre los que COBRAN
 * contra entrega en esa ciudad (con cod = false, también donde llegan sin cobranza), el de menor precio ÷ tasa de
 * entrega; empate → por nombre. null = no hay tabla cargada. Las opciones no incluyen el flete estimado por zona de PaP
 * (en la rpc nunca es válido ni cuenta para ciudad_reconocida).
 */
export function courierSugerido(ciudad: unknown, cod = true): SugerenciaCourier | null {
  if (!tarifas) return null;
  const k = ciudadNorm(ciudad);
  const opciones: OpcionCourier[] = [];
  for (const c of ["pap", "lucero"] as const) {
    const f = filaTarifa(c, k);
    if (!f) continue;
    const t = tarifas.tasas.get(c);
    const tasa = t?.tasa ?? null;
    const precio = numero(f.precio) ?? 0;
    opciones.push({
      courier: c,
      precio,
      cobranza: f.aplica_cobranza === true,
      zona: f.zona ?? null,
      tiempo: f.tiempo ?? null,
      dias_min: numero(f.dias_min),
      dias_max: numero(f.dias_max),
      tasa,
      pocos_datos: t?.pocos_datos ?? null,
      costo_por_entregado: tasa ? Math.round(precio / (tasa / 100)) : null,
      valido: !cod || f.aplica_cobranza === true,
    });
  }
  // order by costo_por_entregado (null al final, como en Postgres), courier
  const orden = (a: OpcionCourier, b: OpcionCourier) =>
    (a.costo_por_entregado ?? Infinity) - (b.costo_por_entregado ?? Infinity) || (a.courier < b.courier ? -1 : a.courier > b.courier ? 1 : 0);
  opciones.sort(orden);
  const validas = opciones.filter((o) => o.valido);
  return { sugerido: validas[0]?.courier ?? null, sin_cobertura: !validas.length, ciudad_reconocida: opciones.length > 0, opciones };
}

// ---------- 26-10: courier de la rpc sugerir_courier por ciudad (la regla vive en la base, no acá) ----------
// Quien decide el courier es public.sugerir_courier (la mantiene Voltra OS). Antes de prometer un plazo, los que
// tienen la ciudad a mano (resumen del vendedor, respuesta a "Confirmar pedido") la consultan con
// consultarCourierCiudad; queda en caché 10 min por ciudad. Sin consulta (o si falla) → la copia en memoria
// (courierSugerido); sin tabla tampoco → sin courier (plazo de siempre).
type SugerenciaRpc = { cod: "pap" | "lucero" | null; prepago: "pap" | "lucero" | null; en: number };
const sugerenciasRpc = new Map<string, SugerenciaRpc>();
const TIMEOUT_RPC_MS = 4_000;
type RespuestaRpc = { data: unknown; error: { message: string } | null };
/** Lo mínimo del cliente de Supabase para la rpc (db() de _shared/db.ts lo cumple). */
export type ClienteRpc = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<RespuestaRpc> };

const courierDe = (v: unknown): "pap" | "lucero" | null => {
  const s = (v as { sugerido?: unknown } | null)?.sugerido;
  return s === "pap" || s === "lucero" ? s : null;
};

/** Consulta sugerir_courier (contra entrega y pago anticipado) para la ciudad. Nunca lanza; true = quedó en caché. */
export async function consultarCourierCiudad(sb: ClienteRpc, ciudad: unknown, ahoraMs = Date.now()): Promise<boolean> {
  const k = ciudadNorm(ciudad);
  if (!k) return false;
  const previo = sugerenciasRpc.get(k);
  if (previo && ahoraMs - previo.en < REFRESCO_TARIFAS_MS) return true;
  let reloj: ReturnType<typeof setTimeout> | undefined;
  try {
    const vence = new Promise<never>((_, no) => {
      reloj = setTimeout(() => no(new Error(`más de ${TIMEOUT_RPC_MS / 1000} s`)), TIMEOUT_RPC_MS);
    });
    const [cod, prepago] = await Promise.race([
      Promise.all([
        sb.rpc("sugerir_courier", { p_ciudad: String(ciudad), p_cod: true }),
        sb.rpc("sugerir_courier", { p_ciudad: String(ciudad), p_cod: false }),
      ]),
      vence,
    ]);
    if (cod.error) throw new Error(cod.error.message);
    if (prepago.error) throw new Error(prepago.error.message);
    sugerenciasRpc.set(k, { cod: courierDe(cod.data), prepago: courierDe(prepago.data), en: ahoraMs });
    return true;
  } catch (e) {
    console.warn(`plazo_zona: sugerir_courier('${k}') falló, sigo con la tabla en memoria:`, e instanceof Error ? e.message : e);
    return false;
  } finally {
    if (reloj !== undefined) clearTimeout(reloj);
  }
}

/** Vacía la caché de la rpc (tests). */
export function limpiarCourierCiudad(): void {
  sugerenciasRpc.clear();
}

/**
 * Courier con el que sale un pedido a esa ciudad: el de la rpc (contra entrega; si nadie cobra ahí, el de pago
 * anticipado), si no la copia en memoria de la tabla; null = no se sabe.
 */
export function courierDeLaCiudad(ciudad: unknown): "pap" | "lucero" | null {
  const rpc = sugerenciasRpc.get(ciudadNorm(ciudad));
  if (rpc) return rpc.cod ?? rpc.prepago;
  return courierSugerido(ciudad, true)?.sugerido ?? courierSugerido(ciudad, false)?.sugerido ?? null;
}

/** Rango con los días de la tabla (courier dado o sugerido); null → se usa rangoBase. */
function rangoDeTabla(ciudad: unknown, courier?: string | null): RangoEntrega | null {
  if (!tarifas || typeof ciudad !== "string" || !ciudad.trim()) return null;
  const dado = idCourier(courier);
  if (dado === "otra") return null;
  const c = dado ?? courierSugerido(ciudad)?.sugerido ?? null;
  if (!c) return null;
  const f = filaTarifa(c, ciudadNorm(ciudad));
  const a = numero(f?.dias_min), b = numero(f?.dias_max);
  if (!f || a === null || b === null || a < 0 || b < a) return null;
  const zona = zonaDeCiudad(ciudad);
  // 20-10 (Enrique): la tabla solo manda en Asunción, Gran Asunción/Central y Alto Paraná (CDE, Hernandarias,
  // Pdte. Franco, Minga Guazú). El resto del interior queda en "2 a 5 días hábiles" sin acortar (12-10: no prometer de más).
  if (zona === "interior") return null;
  const habiles = a === 2 && b === 5;
  return { rango: [a, b], zona, courier: c, fuente: `tabla ${c} ${f.ciudad}`, habiles };
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

// 10-10: para el interior se dice "2 a 5 días hábiles" (decisión de Enrique: convierte mejor que "4 a 9 días").
// 26-10: por PaP, "3 a 7 días hábiles" (rangoInterior). El texto sale del rango.
const textoHabiles = ([a, b]: [number, number]) => `${a} a ${b} días hábiles`;

/** 12-10: con el courier de la ciudad (el dado o el del ruteo oficial) y el corte de las 15:00. */
export function plazoDesdeHoy(ciudad: unknown, ahora: Date, courier?: string | null): string {
  const r = rangoEntrega(ciudad, courier);
  return r.habiles ? `en ${textoHabiles(r.rango)}` : textoDias(diasDesdeHoy(r.rango, ahora));
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
  return r.habiles ? textoHabiles(r.rango) : plazoParaEn(diasDesdeHoy(r.rango, ahora));
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
  return diaEntregaDe(rangoEntrega(ciudad, courier), ahora);
}

function diaEntregaDe(r: RangoEntrega, ahora: Date): DiaEntrega {
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
  // Interior (y Lucero programada, mismo rango): "2 a 5 días hábiles" (10-10), por PaP "3 a 7" (26-10); fechas entre paréntesis.
  const texto = r.habiles ? `en ${textoHabiles(r.rango)} (${rango})` : rango;
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
    // 20-10: los dos genéricos no salen de la tabla de tarifas (una ciudad puntual no representa al resto).
    `Otras ciudades de Central: ${diaEntregaDe(rangoBase("Central"), ahora).texto}`,
    restoDelPais(ahora),
  ];
  return `PLAZOS DESDE HOY (ya calculados con el día y la hora de ahora y el courier de cada ciudad; decí exactamente esto, sin agregar horas): ${partes.join(". ")}.`;
}

/**
 * "Resto del país" de lineaPlazosHoy. 26-10: sin lista de ciudades (no entra en cada turno): con la tabla dice los dos
 * plazos del interior (Lucero 2 a 5, Punto a Punto 3 a 7); el de la ciudad del cliente va aparte (lineaPlazoCiudades).
 * Sin tabla, como siempre ("2 a 5").
 */
function restoDelPais(ahora: Date): string {
  const base = rangoBase("Encarnación");
  const lucero = diaEntregaDe(base, ahora).texto;
  if (!tarifas || !plazoPap3a7) return `Resto del país: ${lucero}`;
  // 26-10: sin números: si no sabe la ciudad, el bot los copiaba ("2 a 5 según tu ciudad"). El plazo va por ciudad.
  return "Resto del país: depende del courier y de la ciudad; el de la ciudad del cliente está en PLAZO PARA SU CIUDAD";
}

/** Palabras que también son ciudades: solo cuentan como ciudad después de "a", "en", "de", "desde" o "para". */
const CIUDADES_AMBIGUAS = new Set(["limpio", "altos", "central", "la paz", "naranjal", "barrero", "pastoreo"]);

/**
 * 26-10: ciudades de la tabla que nombró el cliente (de la más reciente a la más vieja, sin repetir, máximo `max`).
 * Busca la ciudad o un alias como palabra entera; si dos se pisan ("la mora" dentro de "fernando de la mora"), gana la
 * más larga. Devuelve el nombre de la tabla. Sin tabla, [].
 */
export function ciudadesMencionadas(textos: string[], max = 3): string[] {
  if (!tarifas) return [];
  const claves: { clave: string; nombre: string }[] = [];
  for (const f of tarifas.filas) {
    const nombre = f.ciudad_nombre || f.ciudad;
    for (const c of [f.ciudad, ...(f.alias ?? [])]) if (typeof c === "string" && c.length >= 3) claves.push({ clave: c, nombre });
  }
  claves.sort((a, b) => b.clave.length - a.clave.length);
  const out: string[] = [];
  for (const t of [...textos].reverse()) {
    let k = ` ${ciudadNorm(t)} `;
    const enEste: { pos: number; nombre: string }[] = [];
    for (const { clave, nombre } of claves) {
      const pos = k.indexOf(` ${clave} `);
      if (pos < 0) continue;
      if (CIUDADES_AMBIGUAS.has(clave) && !/ (a|en|de|desde|para) $/.test(k.slice(0, pos + 1))) continue;
      enEste.push({ pos, nombre });
      k = k.slice(0, pos + 1) + "#".repeat(clave.length) + k.slice(pos + 1 + clave.length); // la más corta no vuelve a contar
    }
    for (const { nombre } of enEste.sort((a, b) => b.pos - a.pos)) {
      if (!out.includes(nombre)) out.push(nombre);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * 26-10: línea "PLAZO PARA SU CIUDAD" del contexto del vendedor, con el mismo cálculo del resumen (diaEntrega con el
 * courier de sugerir_courier: quien llama consulta antes con consultarCourierCiudad). Sin ciudades → la instrucción de
 * preguntarla.
 */
export function lineaPlazoCiudades(ciudades: string[], ahora: Date): string {
  const otra = `Si dijo una ciudad del interior que no figura acá: ${plazoPap3a7 ? "3 a 7" : "2 a 5"} días hábiles.`;
  if (!ciudades.length) {
    return `PLAZO PARA SU CIUDAD: todavía no dijo una ciudad que conozcamos. Si pregunta cuándo llega, preguntale de qué ciudad es antes de darle un plazo. ${otra}`;
  }
  const partes = ciudades.map((c) => {
    const d = diaEntrega(c, ahora);
    const quien = d.courier === "lucero" ? " (Lucero del Este)" : d.courier === "pap" ? " (Punto a Punto)" : "";
    return `${c}: ${d.texto}${quien}`;
  });
  return `PLAZO PARA SU CIUDAD (ya calculado con su courier; decí exactamente esto): ${partes.join(". ")}. ${otra}`;
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
