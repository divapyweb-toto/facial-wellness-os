// Horario para mandar el KuDE por WhatsApp: el mismo de los avisos de envío (config_wa.horario_avisos_envio).
import { dentroHorarioMarketing } from "../_shared/horario.ts";

export const HORARIO_AVISOS_DEFECTO = { desde: 8, hasta: 20 };

export function horarioAvisos(valor: unknown): { desde: number; hasta: number } {
  const v = (valor && typeof valor === "object" ? valor : {}) as { desde?: unknown; hasta?: unknown };
  return typeof v.desde === "number" && typeof v.hasta === "number" ? { desde: v.desde, hasta: v.hasta } : HORARIO_AVISOS_DEFECTO;
}

/** true si a esta hora (Asunción) se puede mandar el KuDE; si no, queda para una corrida posterior. */
export function puedeMandarKude(ahora: Date, h: { desde: number; hasta: number }): boolean {
  return dentroHorarioMarketing(ahora, h);
}
