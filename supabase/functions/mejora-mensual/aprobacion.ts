// mejora-mensual/aprobacion.ts · Dueño: M3 (ciclo mensual de mejora del vendedor)
// Lógica pura: máquina de estados del ciclo, mensaje corto de Telegram y decisiones
// (Aplicar / Descartar / Ver detalle / Volver a la versión N). Todo el I/O entra por
// dependencias: index.ts las conecta a Supabase, Claude y Telegram; los tests, a dobles
// en memoria. No importa los módulos de M1/M2 (datos, clasificar, sintetizar, proponer,
// probar): los recibe como funciones, así telegram-webhook puede importar este archivo
// sin arrastrarlos.
//
// Estados (mejora_ciclos.estado):
//   recolectando → clasificando (Batch de Haiku; se espera en corridas siguientes del cron)
//   → sintetizando (síntesis + propuesta) → probando (batería de 50) → esperando_aprobacion
//   → aplicado | descartado.  Atajos: sin_datos_suficientes (umbral), error (tope de costo).
// Idempotente y reanudable: cada paso guarda su resultado antes de pasar al siguiente; una
// corrida que encuentra el ciclo en un estado final no hace nada.
import { type BotonTelegram, escaparHtml, horaCortaAsuncion, recortar } from "../_shared/telegram_formato.ts";
import { partesAsuncion } from "../_shared/horario.ts";

// ─── Tipos mínimos (estructurales; los de M1/M2 son compatibles) ──────────────
export type EstadoCiclo =
  | "recolectando"
  | "clasificando"
  | "sintetizando"
  | "probando"
  | "esperando_aprobacion"
  | "aplicado"
  | "descartado"
  | "sin_datos_suficientes"
  | "error";

export const ESTADOS_FINALES: EstadoCiclo[] = ["esperando_aprobacion", "aplicado", "descartado", "sin_datos_suficientes", "error"];

export type EstadoVersion = "activa" | "propuesta" | "descartada" | "archivada";

export interface Ciclo {
  id: string;
  mes: string; // 'YYYY-MM-01'
  estado: EstadoCiclo;
  n_conversaciones: number | null;
  lote_id: string | null;
  costo_usd: number | null;
  resumen: ResumenCiclo | null;
  hallazgos: unknown;
  propuesta_version_id: string | null;
  prueba: PruebaResultado | null;
  telegram_message_id: number | null;
  error: string | null;
  actualizado_en: string;
}

export interface ResumenCiclo {
  total?: number;
  muestra?: number;
  recortado?: boolean;
  costo_estimado_usd?: number;
  invalidas?: number;
  clasificadas?: number;
  lote_simulado?: boolean;
  aprendizajes?: string[];
  cambios_bajo?: number;
  cambios_decision?: number;
  cambios_lista?: { tipo: string; riesgo: string; motivo: string }[];
  version_numero?: number;
  version_activa_numero?: number | null;
  motivo?: string;
  error_avisado?: boolean;
  errores?: number;
  costos?: Record<string, number>;
  /** Conversaciones mandadas al lote (para que una corrida siguiente detecte las que no volvieron). */
  muestra_ids?: string[];
}

export interface CambioMin {
  tipo: string;
  riesgo: "bajo" | "requiere_decision" | string;
  antes?: unknown;
  despues?: unknown;
  motivo?: string | null;
}

export interface PruebaResultado {
  aprobada: boolean;
  casos: number;
  prohibidas: number;
  precios_fuera: number;
  tono_prom: number | null;
  detalle?: unknown;
  costo_usd?: number;
}

export interface VersionMin {
  id: string;
  numero: number;
  estado: EstadoVersion;
}

export interface EstadoLoteMin {
  id: string;
  estado: "in_progress" | "canceling" | "ended";
  simulado?: boolean;
  /** Ids de las conversaciones del lote: se guardan en resumen.muestra_ids para detectar faltantes después. */
  ids?: string[];
  [k: string]: unknown;
}

export interface Clasificacion {
  conversacion_id: string;
  etiquetas: unknown;
}

export interface ConfigMejora {
  tope_usd: number;
  min_conversaciones: number;
  /** Reserva para síntesis (Sonnet) + prueba; lo que queda del tope va a la clasificación. */
  reserva_usd: number;
  /** Costo estimado por conversación clasificada (Haiku 4.5 en Batch). */
  usd_por_conversacion: number;
  /** Corte de tiempo por corrida: lo que falte lo sigue el próximo cron. */
  presupuesto_ms: number;
}

export const CONFIG_POR_DEFECTO: ConfigMejora = {
  tope_usd: 3,
  min_conversaciones: 100,
  reserva_usd: 0.75,
  // ~2.500 tokens de entrada + 250 de salida por conversación, Haiku 4.5 en Batch
  // (USD 0,50 / 2,50 por millón): ~0,0019. Se redondea hacia arriba.
  usd_por_conversacion: 0.002,
  presupuesto_ms: 110_000,
};

/** Mezcla config_wa.mejora_mensual con los valores por defecto (descarta lo inválido). */
export function leerConfig(valor: unknown): ConfigMejora {
  const v = (valor && typeof valor === "object" ? valor : {}) as Record<string, unknown>;
  const num = (k: keyof ConfigMejora, min = 0) => {
    const x = Number(v[k]);
    return Number.isFinite(x) && x >= min && v[k] !== null && v[k] !== "" ? x : CONFIG_POR_DEFECTO[k];
  };
  return {
    tope_usd: num("tope_usd", 0.01),
    min_conversaciones: num("min_conversaciones", 1),
    reserva_usd: num("reserva_usd"),
    usd_por_conversacion: num("usd_por_conversacion", 0.000001),
    presupuesto_ms: num("presupuesto_ms", 1000),
  };
}

// ─── Dependencias del ciclo ───────────────────────────────────────────────────
export interface ResultadoAviso {
  ok: boolean;
  message_id?: number;
  error?: string;
}

export interface DepsCiclo<Conv = unknown, Version = Record<string, unknown>> {
  ahora(): Date;
  config(): Promise<ConfigMejora>;
  obtenerCiclo(mes: string): Promise<Ciclo | null>;
  /** Inserta el ciclo del mes si no existe (on conflict do nothing) y lo devuelve. */
  crearCiclo(mes: string): Promise<Ciclo>;
  /**
   * Actualiza el ciclo solo si `actualizado_en` sigue siendo `visto` (compare-and-set: dos
   * corridas a la vez no hacen el mismo paso). Devuelve la fila nueva o null si otra la tocó.
   */
  actualizarCiclo(id: string, cambios: Partial<Ciclo>, visto: string): Promise<Ciclo | null>;
  /** M1 · datos.ts: conversaciones del mes ya anonimizadas + total real del mes. */
  recolectar(mes: string, opciones: { topeUsd: number }): Promise<{ conversaciones: Conv[]; total: number }>;
  /** Estimación previa del costo de clasificar (opcional; si falta, usd_por_conversacion). */
  estimarCostoClasificacion?(convs: Conv[]): number;
  /** M1 · clasificar.ts: arma y manda el lote de Haiku. */
  crearLote(convs: Conv[]): Promise<EstadoLoteMin>;
  /** `ciclo` trae resumen.muestra_ids (las conversaciones del lote) para detectar faltantes. */
  consultarLote(id: string, ciclo: Ciclo): Promise<EstadoLoteMin>;
  /** M1 · clasificar.ts: resultados válidos (con el reintento de las inválidas adentro). */
  leerResultados(lote: EstadoLoteMin, ciclo: Ciclo): Promise<{ clasificaciones: Clasificacion[]; costo_usd: number; invalidas?: number }>;
  guardarClasificaciones(cicloId: string, filas: Clasificacion[]): Promise<void>;
  /** Agregados del ciclo (conteos y tasas contra ENTREGADO) a partir de las clasificaciones guardadas. */
  agregados(cicloId: string): Promise<unknown>;
  /** M2 · sintetizar.ts */
  sintetizar(agregados: unknown): Promise<{ hallazgos: unknown; costo_usd: number }>;
  /** Líneas cortas de "qué se aprendió" (hasta 3). */
  aprendizajes(hallazgos: unknown): string[];
  versionActiva(): Promise<(VersionMin & Version) | null>;
  /** M2 · proponer.ts */
  proponer(hallazgos: unknown, versionActiva: (VersionMin & Version) | null): Promise<{ version: Version | null; cambios: CambioMin[]; costo_usd?: number }>;
  /** Inserta la versión 'propuesta' (o devuelve la que ya existe para el ciclo) y sus cambios. */
  guardarPropuesta(cicloId: string, version: Version, cambios: CambioMin[]): Promise<VersionMin>;
  /** Guarda en mejora_cambios los cambios de un ciclo sin versión (solo requiere_decision). Opcional. */
  guardarPropuestaSoloCambios?(cicloId: string, cambios: CambioMin[]): Promise<void>;
  obtenerVersion(id: string): Promise<(VersionMin & Version) | null>;
  /** M2 · probar.ts */
  probar(version: VersionMin & Version, ctx: { restanteUsd: number }): Promise<PruebaResultado>;
  marcarVersion(id: string, estado: EstadoVersion): Promise<void>;
  avisar(html: string, botones?: BotonTelegram[][]): Promise<ResultadoAviso>;
}

export type ResultadoCiclo =
  | { tipo: "fuera_de_fecha"; mes: string }
  | { tipo: "ya_terminado"; mes: string; estado: EstadoCiclo }
  | { tipo: "ocupado"; mes: string; estado: EstadoCiclo }
  | { tipo: "esperando_lote"; mes: string; lote_id: string }
  | { tipo: "sigue_luego"; mes: string; estado: EstadoCiclo }
  | { tipo: "terminado"; mes: string; estado: EstadoCiclo; costo_usd: number }
  | { tipo: "fallo"; mes: string; estado: EstadoCiclo; error: string; avisado: boolean };

// ─── Utilidades puras ─────────────────────────────────────────────────────────
/** Primer día del mes anterior en Asunción ('YYYY-MM-01'). */
export function mesAnterior(ahora: Date): string {
  const p = partesAsuncion(ahora);
  const anio = p.mes === 1 ? p.anio - 1 : p.anio;
  const mes = p.mes === 1 ? 12 : p.mes - 1;
  return `${anio}-${String(mes).padStart(2, "0")}-01`;
}

/** El cron solo arranca un ciclo nuevo del 1 (desde las 9:00 de Asunción) al 3 del mes. */
export function dentroVentanaArranque(ahora: Date): boolean {
  const p = partesAsuncion(ahora);
  if (p.dia === 1) return p.hora >= 9;
  return p.dia === 2 || p.dia === 3;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function nombreMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return `${MESES[(m || 1) - 1]} ${a}`;
}

export function usd(n: number | null | undefined): string {
  return `USD ${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace(".", ",")}`;
}

function miles(n: number | null | undefined): string {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const redondear = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Cuántas conversaciones entran en el tope: lo que sobra después de la reserva, dividido
 * por el costo por conversación. Nunca menos que el mínimo del umbral.
 */
export function maximoPorTope(cfg: ConfigMejora, usdPorConv: number): number {
  const disponible = Math.max(cfg.tope_usd - cfg.reserva_usd, 0);
  return Math.max(Math.floor(disponible / Math.max(usdPorConv, 1e-9)), cfg.min_conversaciones);
}

/** Muestra determinista y repartida (una de cada k), para que no queden solo las del día 1. */
export function muestraPareja<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  const paso = xs.length / n;
  for (let i = 0; i < n; i++) out.push(xs[Math.floor(i * paso)]);
  return out;
}

export function esBajo(c: CambioMin): boolean {
  return c.riesgo === "bajo";
}

/** Saca hasta 3 líneas de "qué se aprendió" de unos hallazgos de forma desconocida. */
export function aprendizajesGenericos(h: unknown): string[] {
  if (!h || typeof h !== "object") return typeof h === "string" && h.trim() ? [h.trim()] : [];
  const o = h as Record<string, unknown>;
  for (const k of ["aprendizajes", "resumen", "lineas", "conclusiones", "hallazgos_clave", "principales"]) {
    const v = o[k];
    if (Array.isArray(v)) {
      const ls = v.map((x) => (typeof x === "string" ? x : (x as Record<string, unknown>)?.texto ?? (x as Record<string, unknown>)?.resumen))
        .filter((x): x is string => typeof x === "string" && !!x.trim());
      if (ls.length) return ls.slice(0, 3);
    }
    if (typeof v === "string" && v.trim()) return v.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  }
  return [];
}

// ─── Mensajes de Telegram ─────────────────────────────────────────────────────
export function callbackMejora(accion: "mej_aplicar" | "mej_descartar" | "mej_detalle", cicloId: string): string;
export function callbackMejora(accion: "mej_volver", numero: number): string;
export function callbackMejora(accion: AccionMejora, arg: string | number): string {
  const data = `${accion}:${arg}`;
  if (new TextEncoder().encode(data).length > 64) throw new Error(`callback_data supera 64 bytes: ${data}`);
  return data;
}

export function botonesPropuesta(cicloId: string): BotonTelegram[][] {
  return [
    [
      { texto: "Aplicar", callback: callbackMejora("mej_aplicar", cicloId) },
      { texto: "Descartar", callback: callbackMejora("mej_descartar", cicloId) },
    ],
    [{ texto: "Ver detalle", callback: callbackMejora("mej_detalle", cicloId) }],
  ];
}

function lineaPrueba(p: PruebaResultado | null): string {
  if (!p) return "sin prueba";
  const tono = p.tono_prom == null ? "" : ` · tono ${String(Math.round(p.tono_prom * 10) / 10).replace(".", ",")}`;
  return `${p.aprobada ? "pasó" : "NO pasó"} · ${p.casos} casos · ${p.prohibidas} palabras prohibidas · ${p.precios_fuera} precios fuera de catálogo${tono}`;
}

function lineaCosto(c: Ciclo, cfg: ConfigMejora): string {
  const r = c.resumen ?? {};
  const muestra = r.recortado && r.muestra != null && r.total != null
    ? ` · muestra de ${miles(r.muestra)} de ${miles(r.total)} conversaciones (recortada por el tope)`
    : "";
  return `${usd(c.costo_usd)} (tope ${usd(cfg.tope_usd)})${muestra}`;
}

/** Mensaje corto con la propuesta (o con el motivo por el que no hay nada que aplicar). */
export function mensajePropuesta(c: Ciclo, cfg: ConfigMejora): { texto: string; botones: BotonTelegram[][] } {
  const r = c.resumen ?? {};
  const l = [`<b>Mejora mensual del vendedor · ${escaparHtml(nombreMes(c.mes))}</b>`];
  l.push(`${miles(r.total ?? c.n_conversaciones)} conversaciones${r.lote_simulado ? " · <i>clasificación simulada (sin clave de Claude)</i>" : ""}`);
  l.push("", "<b>Qué se aprendió</b>");
  const ap = (r.aprendizajes ?? []).slice(0, 3);
  if (ap.length) for (const a of ap) l.push(`• ${escaparHtml(recortar(a, 160))}`);
  else l.push("• (la síntesis no dejó conclusiones claras)");

  l.push("", "<b>Qué se propone</b>");
  const bajos = (r.cambios_lista ?? []).filter((x) => x.riesgo === "bajo");
  const dec = (r.cambios_lista ?? []).filter((x) => x.riesgo !== "bajo");
  if (r.version_numero != null && bajos.length) {
    l.push(`Versión ${r.version_numero} con ${bajos.length} cambio${bajos.length === 1 ? "" : "s"} de riesgo bajo:`);
    for (const b of bajos.slice(0, 3)) l.push(`• ${escaparHtml(b.tipo)}: ${escaparHtml(recortar(b.motivo || "-", 110))}`);
    if (bajos.length > 3) l.push(`• y ${bajos.length - 3} más (Ver detalle)`);
  } else {
    l.push("Nada para aplicar automáticamente.");
  }
  if (dec.length) {
    l.push(`${dec.length} cambio${dec.length === 1 ? "" : "s"} requiere${dec.length === 1 ? "" : "n"} tu decisión (precio, política, etc.): no se aplica${dec.length === 1 ? "" : "n"} con el botón; están en Ver detalle.`);
  }

  l.push("", `<b>Prueba (batería):</b> ${escaparHtml(lineaPrueba(c.prueba))}`);
  l.push(`<b>Costo del ciclo:</b> ${escaparHtml(lineaCosto(c, cfg))}`);
  if (c.estado === "descartado" && r.motivo) l.push("", `<b>Quedó descartada:</b> ${escaparHtml(r.motivo)}`);

  const botones: BotonTelegram[][] = c.estado === "esperando_aprobacion"
    ? botonesPropuesta(c.id)
    : (r.cambios_lista?.length ? [[{ texto: "Ver detalle", callback: callbackMejora("mej_detalle", c.id) }]] : []);
  return { texto: recortar(l.join("\n")), botones };
}

export function mensajeSinDatos(c: Ciclo, cfg: ConfigMejora, total: number): string {
  return [
    `<b>Mejora mensual del vendedor · ${escaparHtml(nombreMes(c.mes))}</b>`,
    `Hubo ${miles(total)} conversaciones; hacen falta ${miles(cfg.min_conversaciones)} para sacar conclusiones confiables.`,
    "No se propone ningún cambio este mes: el vendedor sigue con la versión actual.",
    `Costo del ciclo: ${usd(c.costo_usd)}.`,
  ].join("\n");
}

export function mensajeError(mes: string, estado: EstadoCiclo, error: string): string {
  return [
    `<b>Atención: falló la mejora mensual del vendedor (${escaparHtml(nombreMes(mes))})</b>`,
    `• Paso: ${escaparHtml(estado)}`,
    `• Error: ${escaparHtml(recortar(error, 600))}`,
    "",
    "Qué hacer: el cron lo reintenta cada 30 min hasta el día 3; este aviso no se repite. Si sigue trabado, revisá mejora_ciclos en Supabase.",
  ].join("\n");
}

// ─── Máquina de estados ───────────────────────────────────────────────────────
export interface OpcionesCiclo {
  /** 'YYYY-MM-01' para correr un mes a mano (saltea la ventana del 1 al 3). */
  mes?: string;
}

class ErrorTope extends Error {}

export async function ejecutarCiclo<Conv, Version extends Record<string, unknown>>(
  deps: DepsCiclo<Conv, Version>,
  op: OpcionesCiclo = {},
): Promise<ResultadoCiclo> {
  const inicio = deps.ahora().getTime();
  const mes = op.mes ?? mesAnterior(deps.ahora());
  const cfg = await deps.config();

  let ciclo = await deps.obtenerCiclo(mes);
  if (!ciclo) {
    if (!op.mes && !dentroVentanaArranque(deps.ahora())) return { tipo: "fuera_de_fecha", mes };
    ciclo = await deps.crearCiclo(mes);
  }
  if (ESTADOS_FINALES.includes(ciclo.estado)) return { tipo: "ya_terminado", mes, estado: ciclo.estado };

  // Guarda el paso con compare-and-set. null → otra corrida lo tomó.
  const guardar = async (cambios: Partial<Ciclo>): Promise<Ciclo | null> => {
    const nuevo = await deps.actualizarCiclo(ciclo!.id, cambios, ciclo!.actualizado_en);
    if (nuevo) ciclo = nuevo;
    return nuevo;
  };
  const resumen = (extra: Partial<ResumenCiclo>): ResumenCiclo => ({ ...(ciclo!.resumen ?? {}), ...extra });
  const sumarCosto = (paso: string, n: number | undefined) => {
    const c = Number(n) || 0;
    const costos = { ...(ciclo!.resumen?.costos ?? {}) };
    costos[paso] = redondear((costos[paso] ?? 0) + c);
    return { costo_usd: redondear((Number(ciclo!.costo_usd) || 0) + c), costos };
  };

  try {
    for (let vuelta = 0; vuelta < 10; vuelta++) {
      const estado: EstadoCiclo = ciclo.estado;
      if (ESTADOS_FINALES.includes(estado)) {
        return { tipo: "terminado", mes, estado, costo_usd: Number(ciclo.costo_usd) || 0 };
      }
      if (vuelta > 0 && deps.ahora().getTime() - inicio > cfg.presupuesto_ms) {
        return { tipo: "sigue_luego", mes, estado };
      }

      if (estado === "recolectando") {
        const { conversaciones, total } = await deps.recolectar(mes, { topeUsd: cfg.tope_usd });
        if (total < cfg.min_conversaciones) {
          const listo = await guardar({
            estado: "sin_datos_suficientes",
            n_conversaciones: total,
            resumen: resumen({ total, muestra: conversaciones.length }),
          });
          if (!listo) return { tipo: "ocupado", mes, estado };
          const r = await deps.avisar(mensajeSinDatos(ciclo, cfg, total));
          if (r.ok && r.message_id != null) await guardar({ telegram_message_id: r.message_id });
          continue;
        }
        // Tope duro: la estimación previa decide cuántas entran; si no entran todas, se recorta.
        const porConv = deps.estimarCostoClasificacion && conversaciones.length
          ? deps.estimarCostoClasificacion(conversaciones) / conversaciones.length
          : cfg.usd_por_conversacion;
        const maximo = maximoPorTope(cfg, porConv);
        const muestra = muestraPareja(conversaciones, maximo);
        const recortado = muestra.length < total;
        const estimado = redondear(muestra.length * porConv + cfg.reserva_usd);
        if (estimado > cfg.tope_usd) {
          throw new ErrorTope(`la estimación (${usd(estimado)}) supera el tope (${usd(cfg.tope_usd)}) aun con la muestra mínima`);
        }
        const lote = await deps.crearLote(muestra);
        const ok = await guardar({
          estado: "clasificando",
          n_conversaciones: total,
          lote_id: lote.id,
          resumen: resumen({
            total,
            muestra: muestra.length,
            recortado,
            costo_estimado_usd: estimado,
            lote_simulado: !!lote.simulado,
            ...(lote.ids?.length ? { muestra_ids: lote.ids } : {}),
          }),
        });
        if (!ok) return { tipo: "ocupado", mes, estado };
        if (lote.estado === "ended") {
          await procesarLote(lote);
          continue;
        }
        return { tipo: "esperando_lote", mes, lote_id: lote.id };
      }

      if (estado === "clasificando") {
        if (!ciclo.lote_id) throw new Error("el ciclo está clasificando sin lote_id");
        const lote = await deps.consultarLote(ciclo.lote_id, ciclo);
        if (lote.estado !== "ended") return { tipo: "esperando_lote", mes, lote_id: ciclo.lote_id };
        if (!(await procesarLote(lote))) return { tipo: "ocupado", mes, estado };
        continue;
      }

      if (estado === "sintetizando") {
        let versionId = ciclo.propuesta_version_id;
        if (!versionId) {
          let hallazgos = ciclo.hallazgos;
          if (hallazgos == null) {
            const ag = await deps.agregados(ciclo.id);
            const s = await deps.sintetizar(ag);
            hallazgos = s.hallazgos;
            const { costo_usd, costos } = sumarCosto("sintesis", s.costo_usd);
            if (costo_usd > cfg.tope_usd) throw new ErrorTope(`la síntesis llevó el costo a ${usd(costo_usd)} (tope ${usd(cfg.tope_usd)})`);
            const ok = await guardar({
              hallazgos,
              costo_usd,
              resumen: resumen({ costos, aprendizajes: deps.aprendizajes(hallazgos).slice(0, 3) }),
            });
            if (!ok) return { tipo: "ocupado", mes, estado };
          }
          const activa = await deps.versionActiva();
          const p = await deps.proponer(hallazgos, activa);
          const { costo_usd, costos } = sumarCosto("propuesta", p.costo_usd);
          const cambios_lista = p.cambios.map((c) => ({ tipo: c.tipo, riesgo: String(c.riesgo), motivo: String(c.motivo ?? "") }));
          const bajos = p.cambios.filter(esBajo);
          const base = {
            costo_usd,
            resumen: resumen({
              costos,
              cambios_lista,
              cambios_bajo: bajos.length,
              cambios_decision: p.cambios.length - bajos.length,
              version_activa_numero: activa?.numero ?? null,
            }),
          };
          if (!p.version || bajos.length === 0) {
            // Nada aplicable con el botón: se informa y se cierra (los requiere_decision van al detalle).
            const ok = await guardar({
              ...base,
              estado: "descartado",
              resumen: { ...base.resumen, motivo: "no hubo cambios de riesgo bajo para aplicar" },
            });
            if (!ok) return { tipo: "ocupado", mes, estado };
            if (p.cambios.length) await deps.guardarPropuestaSoloCambios?.(ciclo.id, p.cambios);
            await enviarMensaje();
            continue;
          }
          const v = await deps.guardarPropuesta(ciclo.id, p.version, p.cambios);
          versionId = v.id;
          const ok = await guardar({
            ...base,
            propuesta_version_id: v.id,
            estado: "probando",
            resumen: { ...base.resumen, version_numero: v.numero },
          });
          if (!ok) return { tipo: "ocupado", mes, estado };
          continue;
        }
        const ok = await guardar({ estado: "probando" });
        if (!ok) return { tipo: "ocupado", mes, estado };
        continue;
      }

      if (estado === "probando") {
        if (!ciclo.propuesta_version_id) throw new Error("el ciclo está probando sin propuesta_version_id");
        let prueba = ciclo.prueba;
        if (!prueba) {
          const v = await deps.obtenerVersion(ciclo.propuesta_version_id);
          if (!v) throw new Error("no encontré la versión propuesta");
          prueba = await deps.probar(v, { restanteUsd: Math.max(cfg.tope_usd - (Number(ciclo.costo_usd) || 0), 0) });
          const { costo_usd, costos } = sumarCosto("prueba", prueba.costo_usd);
          const ok = await guardar({ prueba, costo_usd, resumen: resumen({ costos }) });
          if (!ok) return { tipo: "ocupado", mes, estado };
        }
        if (!prueba.aprobada) {
          await deps.marcarVersion(ciclo.propuesta_version_id, "descartada");
          const motivos: string[] = [];
          if (prueba.prohibidas > 0) motivos.push(`${prueba.prohibidas} palabra(s) prohibida(s)`);
          if (prueba.precios_fuera > 0) motivos.push(`${prueba.precios_fuera} precio(s) fuera de catálogo`);
          const ok = await guardar({
            estado: "descartado",
            resumen: resumen({ motivo: `no pasó la prueba${motivos.length ? ` (${motivos.join(", ")})` : ""}; sigue la versión actual` }),
          });
          if (!ok) return { tipo: "ocupado", mes, estado };
        } else {
          const ok = await guardar({ estado: "esperando_aprobacion" });
          if (!ok) return { tipo: "ocupado", mes, estado };
        }
        await enviarMensaje();
        continue;
      }

      throw new Error(`estado desconocido: ${estado}`);
    }
    return { tipo: "sigue_luego", mes, estado: ciclo.estado };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const estado = ciclo.estado;
    const yaAvisado = !!ciclo.resumen?.error_avisado;
    let avisado = false;
    if (!yaAvisado) {
      const r = await deps.avisar(mensajeError(mes, estado, msg)).catch(() => ({ ok: false }) as ResultadoAviso);
      avisado = r.ok;
    }
    // Tope de costo → estado final 'error'. El resto queda en el paso donde estaba y lo
    // reintenta el próximo cron (el aviso sale una sola vez por ciclo).
    await deps.actualizarCiclo(ciclo.id, {
      ...(e instanceof ErrorTope ? { estado: "error" as EstadoCiclo } : {}),
      error: recortar(msg, 1000),
      resumen: resumen({ error_avisado: yaAvisado || avisado, errores: (ciclo.resumen?.errores ?? 0) + 1 }),
    }, ciclo.actualizado_en).catch(() => null);
    return { tipo: "fallo", mes, estado: e instanceof ErrorTope ? "error" : estado, error: msg, avisado };
  }

  async function procesarLote(lote: EstadoLoteMin): Promise<boolean> {
    const r = await deps.leerResultados(lote, ciclo!);
    await deps.guardarClasificaciones(ciclo!.id, r.clasificaciones);
    const { costo_usd, costos } = sumarCosto("clasificacion", r.costo_usd);
    if (costo_usd > cfg.tope_usd) throw new ErrorTope(`la clasificación llevó el costo a ${usd(costo_usd)} (tope ${usd(cfg.tope_usd)})`);
    return !!(await guardar({
      estado: "sintetizando",
      costo_usd,
      resumen: resumen({ costos, clasificadas: r.clasificaciones.length, invalidas: r.invalidas ?? 0 }),
    }));
  }

  async function enviarMensaje() {
    if (ciclo!.telegram_message_id != null) return; // ya salió en una corrida anterior
    const m = mensajePropuesta(ciclo!, cfg);
    const r = await deps.avisar(m.texto, m.botones);
    if (!r.ok) throw new Error(`no salió el mensaje de Telegram (${r.error ?? "error"})`);
    if (r.message_id != null) await guardar({ telegram_message_id: r.message_id });
  }
}

// ─── Decisiones desde Telegram (mej_*) ────────────────────────────────────────
export type AccionMejora = "mej_aplicar" | "mej_descartar" | "mej_detalle" | "mej_volver";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsearCallbackMejora(
  data: string | undefined,
): { accion: "mej_aplicar" | "mej_descartar" | "mej_detalle"; ciclo: string } | { accion: "mej_volver"; numero: number } | null {
  const m = /^(mej_aplicar|mej_descartar|mej_detalle|mej_volver):(.+)$/.exec(data ?? "");
  if (!m) return null;
  if (m[1] === "mej_volver") {
    if (!/^\d{1,9}$/.test(m[2])) return null;
    const numero = Number(m[2]);
    return numero > 0 ? { accion: "mej_volver", numero } : null;
  }
  if (!UUID.test(m[2])) return null;
  return { accion: m[1] as "mej_aplicar" | "mej_descartar" | "mej_detalle", ciclo: m[2].toLowerCase() };
}

export interface CicloDecision {
  id: string;
  mes: string;
  estado: EstadoCiclo;
  propuesta_version_id: string | null;
  n_conversaciones: number | null;
  costo_usd: number | null;
  prueba: PruebaResultado | null;
  resumen: ResumenCiclo | null;
}

export interface CambioGuardado extends CambioMin {
  aplicado?: boolean;
}

export interface DepsDecision {
  ahora(): Date;
  obtenerCiclo(id: string): Promise<CicloDecision | null>;
  versionPorId(id: string): Promise<VersionMin | null>;
  versionPorNumero(numero: number): Promise<VersionMin | null>;
  versionActiva(): Promise<VersionMin | null>;
  /**
   * Activa la versión en una transacción (la activa pasa a 'archivada'). Solo si su estado
   * está en `permitidos`; si ya era la activa, ya_activa=true y no toca nada.
   */
  activarVersion(versionId: string, permitidos: EstadoVersion[]): Promise<{ ok: boolean; ya_activa?: boolean; anterior?: number | null; error?: string }>;
  marcarVersion(id: string, estado: EstadoVersion): Promise<void>;
  /** mejora_cambios.aplicado = true SOLO en los de riesgo 'bajo' del ciclo. */
  marcarCambiosAplicados(cicloId: string): Promise<void>;
  actualizarEstadoCiclo(id: string, estado: EstadoCiclo): Promise<void>;
  listarCambios(cicloId: string): Promise<CambioGuardado[]>;
  /** Candado en eventos_crudos; false si ya estaba. */
  reclamar(clave: string, payload: Record<string, unknown>): Promise<boolean>;
  liberar(clave: string): Promise<void>;
  enviarMensaje(html: string, botones?: BotonTelegram[][]): Promise<ResultadoAviso>;
}

export interface ResultadoDecision {
  tipo: "hecho" | "ya_hecho" | "no_corresponde" | "error";
  /** Texto corto para answerCallbackQuery. */
  aviso: string;
  /** Si viene, se edita el mensaje original con esto. */
  edicion?: { html: string; botones: BotonTelegram[][] };
  error?: string;
}

function constancia(textoOriginal: string, decision: string, notas: string[], cuando: Date): string {
  const l = [escaparHtml(textoOriginal), "", `<b>Decisión (${horaCortaAsuncion(cuando)}):</b> ${escaparHtml(decision)}`];
  for (const n of notas) l.push(`• ${escaparHtml(n)}`);
  const cola = l.slice(1).join("\n");
  return recortar(l[0], Math.max(4096 - cola.length - 1, 0)) + "\n" + cola;
}

function botonVolver(numero: number): BotonTelegram[][] {
  return [[{ texto: `Volver a la versión ${numero}`, callback: callbackMejora("mej_volver", numero) }]];
}

function jsonCorto(v: unknown, max = 220): string {
  if (v == null) return "-";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return recortar(s, max);
}

export function mensajeDetalle(c: CicloDecision, cambios: CambioGuardado[], numeroPropuesta: number | null): string {
  const l = [`<b>Detalle · mejora mensual ${escaparHtml(nombreMes(c.mes))}</b>`];
  if (numeroPropuesta != null) l.push(`Versión propuesta: ${numeroPropuesta} · estado del ciclo: ${escaparHtml(c.estado)}`);
  const bajos = cambios.filter(esBajo);
  const dec = cambios.filter((x) => !esBajo(x));
  l.push("", `<b>Se aplican con el botón (${bajos.length})</b>`);
  if (!bajos.length) l.push("• ninguno");
  bajos.forEach((b, i) => {
    l.push(`${i + 1}. <b>${escaparHtml(b.tipo)}</b>: ${escaparHtml(b.motivo ?? "")}`);
    l.push(`   antes: ${escaparHtml(jsonCorto(b.antes))}`);
    l.push(`   después: ${escaparHtml(jsonCorto(b.despues))}`);
  });
  l.push("", `<b>Requieren tu decisión (${dec.length}) · NO se aplican con el botón</b>`);
  if (!dec.length) l.push("• ninguno");
  dec.forEach((b, i) => {
    l.push(`${i + 1}. <b>${escaparHtml(b.tipo)}</b>: ${escaparHtml(b.motivo ?? "")}`);
    l.push(`   propuesta: ${escaparHtml(jsonCorto(b.despues))}`);
  });
  l.push("", `<b>Prueba:</b> ${escaparHtml(lineaPrueba(c.prueba))}`);
  if (c.prueba?.detalle != null) l.push(escaparHtml(jsonCorto(c.prueba.detalle, 600)));
  l.push(`<b>Costo del ciclo:</b> ${escaparHtml(usd(c.costo_usd))}`);
  return recortar(l.join("\n"));
}

/**
 * Ejecuta una decisión de Telegram. Idempotente:
 * - aplicar y descartar comparten el candado `accion:mej_decision:<ciclo>`: la primera gana,
 *   la segunda (o un doble toque) responde "ya decidido" sin tocar nada;
 * - la activación es transaccional y no hace nada si la versión ya es la activa;
 * - volver no usa candado (se puede ir y volver varias veces): si la versión ya es la activa, no hace nada.
 */
export async function decidirMejora(
  data: string | undefined,
  textoOriginal: string,
  deps: DepsDecision,
): Promise<ResultadoDecision> {
  const cb = parsearCallbackMejora(data);
  if (!cb) return { tipo: "no_corresponde", aviso: "Botón desconocido." };
  const ahora = deps.ahora();

  if (cb.accion === "mej_volver") {
    const v = await deps.versionPorNumero(cb.numero);
    if (!v) return { tipo: "error", aviso: `No existe la versión ${cb.numero}.`, error: "versión inexistente" };
    if (v.estado === "activa") return { tipo: "ya_hecho", aviso: `La versión ${v.numero} ya es la activa.` };
    const r = await deps.activarVersion(v.id, ["archivada"]);
    if (!r.ok) return { tipo: "error", aviso: `No se pudo: ${r.error ?? "error"}`, error: r.error };
    if (r.ya_activa) return { tipo: "ya_hecho", aviso: `La versión ${v.numero} ya es la activa.` };
    const notas = [`El vendedor vuelve a usar la versión ${v.numero}.`];
    if (r.anterior != null) notas.push(`La versión ${r.anterior} quedó archivada.`);
    return {
      tipo: "hecho",
      aviso: `Listo: versión ${v.numero} activa.`,
      edicion: { html: constancia(textoOriginal, `volver a la versión ${v.numero}`, notas, ahora), botones: r.anterior != null ? botonVolver(r.anterior) : [] },
    };
  }

  const ciclo = await deps.obtenerCiclo(cb.ciclo);
  if (!ciclo) return { tipo: "error", aviso: "No encontré ese ciclo de mejora.", error: "ciclo inexistente" };

  if (cb.accion === "mej_detalle") {
    const cambios = await deps.listarCambios(ciclo.id);
    const v = ciclo.propuesta_version_id ? await deps.versionPorId(ciclo.propuesta_version_id) : null;
    const botones = ciclo.estado === "esperando_aprobacion" ? botonesPropuesta(ciclo.id) : [];
    const r = await deps.enviarMensaje(mensajeDetalle(ciclo, cambios, v?.numero ?? null), botones);
    if (!r.ok) return { tipo: "error", aviso: `No salió el detalle: ${r.error ?? "error"}`, error: r.error };
    return { tipo: "hecho", aviso: "Te mandé el detalle." };
  }

  // Aplicar o descartar.
  if (ciclo.estado === "aplicado") return { tipo: "ya_hecho", aviso: "Esta propuesta ya estaba aplicada." };
  if (ciclo.estado === "descartado") return { tipo: "ya_hecho", aviso: "Esta propuesta ya estaba descartada." };
  if (ciclo.estado !== "esperando_aprobacion" || !ciclo.propuesta_version_id) {
    return { tipo: "no_corresponde", aviso: `El ciclo está en '${ciclo.estado}': no hay nada para decidir.` };
  }
  const clave = `accion:mej_decision:${ciclo.id}`;
  const reclamado = await deps.reclamar(clave, {
    tipo: `mejora_${cb.accion === "mej_aplicar" ? "aplicar" : "descartar"}`,
    ciclo_id: ciclo.id,
    decidido_en: ahora.toISOString(),
    origen: "telegram",
  });
  if (!reclamado) return { tipo: "ya_hecho", aviso: "Esta propuesta ya estaba decidida." };

  try {
    const propuesta = await deps.versionPorId(ciclo.propuesta_version_id);
    if (!propuesta) throw new Error("no encontré la versión propuesta");

    if (cb.accion === "mej_descartar") {
      if (propuesta.estado === "propuesta") await deps.marcarVersion(propuesta.id, "descartada");
      await deps.actualizarEstadoCiclo(ciclo.id, "descartado");
      return {
        tipo: "hecho",
        aviso: "Listo: propuesta descartada.",
        edicion: {
          html: constancia(textoOriginal, "propuesta descartada", ["El vendedor sigue con la versión actual."], ahora),
          botones: [],
        },
      };
    }

    const r = await deps.activarVersion(propuesta.id, ["propuesta"]);
    if (!r.ok) throw new Error(r.error ?? "no se pudo activar la versión");
    // Desde acá la versión ya está activa: lo que falle se anota, no se libera el candado.
    const notas = [`El vendedor usa la versión ${propuesta.numero}.`];
    try {
      await deps.marcarCambiosAplicados(ciclo.id);
      await deps.actualizarEstadoCiclo(ciclo.id, "aplicado");
    } catch (e) {
      notas.push(`Falló marcar el ciclo como aplicado (${e instanceof Error ? e.message : e}); revisalo en Supabase.`);
    }
    const dec = ciclo.resumen?.cambios_decision ?? 0;
    if (dec > 0) notas.push(`${dec} cambio(s) que requieren tu decisión NO se aplicaron (ver detalle).`);
    if (r.anterior != null) notas.push(`La versión ${r.anterior} quedó archivada.`);
    return {
      tipo: "hecho",
      aviso: `Listo: versión ${propuesta.numero} activa.`,
      edicion: {
        html: constancia(textoOriginal, `aplicada la versión ${propuesta.numero}`, notas, ahora),
        botones: r.anterior != null ? botonVolver(r.anterior) : [],
      },
    };
  } catch (e) {
    await deps.liberar(clave);
    const msg = e instanceof Error ? e.message : String(e);
    return { tipo: "error", aviso: `No se pudo: ${msg}`, error: msg };
  }
}
