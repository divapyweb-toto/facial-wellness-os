// mejora-mensual/enlaces.ts · Integración (06-10-2026)
// Envolturas puras entre las firmas de M1 (datos, clasificar), M2 (sintetizar, proponer) y M3 (aprobacion).
// index.ts las usa; acá se prueban sin base ni red.
import type { Ciclo, Clasificacion } from "./aprobacion.ts";
import type { ConvClasificada, HallazgosSintesis } from "./sintetizar.ts";
import type { ConversacionParaAnalizar, RecoleccionMes } from "./tipos.ts";

/** M1 recolectarMes → lo que espera M3 (`total` es lo que se compara con min_conversaciones). */
export function recoleccionParaCiclo(r: RecoleccionMes): { conversaciones: ConversacionParaAnalizar[]; total: number } {
  return { conversaciones: r.conversaciones, total: r.total };
}

/** M2 sintetizar (costo adentro de los hallazgos) → {hallazgos, costo_usd} de M3. */
export function sintesisParaCiclo(h: HallazgosSintesis): { hallazgos: HallazgosSintesis; costo_usd: number } {
  const c = Number(h.costo_usd);
  return { hallazgos: h, costo_usd: Number.isFinite(c) && c > 0 ? c : 0 };
}

/** Ids del lote guardados por M3 en resumen.muestra_ids (corrida siguiente del cron). */
export function idsDelLote(ciclo: Pick<Ciclo, "resumen"> | null | undefined): string[] {
  const ids = ciclo?.resumen?.muestra_ids;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/** Conversaciones de la muestra que siguen en memoria (misma corrida); si no, [] y se usan los ids. */
export function convsDelLote(
  muestra: { mes: string; convs: ConversacionParaAnalizar[] } | null,
  ciclo: Pick<Ciclo, "mes">,
): ConversacionParaAnalizar[] {
  return muestra && muestra.mes === ciclo.mes ? muestra.convs : [];
}

type FilaResultado = { conversacion_id: string; resultado: ConvClasificada["resultado"]; derivado?: boolean | null };

/** Clasificaciones guardadas + vista conversacion_resultado → entrada de agregar() de M2. */
export function convsClasificadas(filas: Clasificacion[], resultados: FilaResultado[]): ConvClasificada[] {
  const porId = new Map(resultados.map((r) => [r.conversacion_id, r]));
  return filas.map((f) => ({
    conversacion_id: f.conversacion_id,
    etiquetas: f.etiquetas as ConvClasificada["etiquetas"],
    resultado: porId.get(f.conversacion_id)?.resultado ?? "sin_compra",
    derivado: !!porId.get(f.conversacion_id)?.derivado,
  }));
}

/** "Qué se aprendió" (hasta 3 líneas) desde los hallazgos de M2. */
export function aprendizajesDe(h: unknown): string[] {
  const x = h as Partial<HallazgosSintesis> | null;
  const ls = (x?.conclusiones ?? []).filter((s) => typeof s === "string" && s.trim());
  return (ls.length ? ls : x?.resumen ? [x.resumen] : []).slice(0, 3);
}
