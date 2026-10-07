// Horario en America/Asuncion. Marketing solo dentro de [desde, hasta) hora local.
// El horario (desde/hasta) viene de config_wa.horario_marketing.
import type { HorarioMarketingCfg } from "./tipos.ts";

export const ZONA = "America/Asuncion";

export interface PartesAsuncion {
  /** Instante real (UTC) */
  fecha: Date;
  anio: number;
  mes: number; // 1-12
  dia: number;
  hora: number; // 0-23
  minuto: number;
  segundo: number;
  /** 'YYYY-MM-DD' local de Asunción */
  diaISO: string;
}

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONA,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Hora local de Asunción para un instante dado. */
export function partesAsuncion(d: Date): PartesAsuncion {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt.formatToParts(d)) {
    if (type !== "literal") p[type] = Number(value);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    fecha: d,
    anio: p.year,
    mes: p.month,
    dia: p.day,
    hora: p.hour,
    minuto: p.minute,
    segundo: p.second,
    diaISO: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
  };
}

/** Ahora, en hora local de Asunción. `.fecha` es el Date real. */
export function ahoraAsuncion(): PartesAsuncion {
  return partesAsuncion(new Date());
}

/** true si `d` cae dentro del horario de marketing (desde inclusivo, hasta exclusivo). */
export function dentroHorarioMarketing(d: Date, cfg: HorarioMarketingCfg): boolean {
  const { hora } = partesAsuncion(d);
  return hora >= cfg.desde && hora < cfg.hasta;
}

/** Diferencia (ms) entre la hora local de Asunción y UTC en el instante `d`. */
function offsetMs(d: Date): number {
  const p = partesAsuncion(d);
  const comoUTC = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoUTC - Math.floor(d.getTime() / 1000) * 1000;
}

/**
 * Próximo instante en que se puede mandar marketing.
 * Si `d` ya está dentro del horario, devuelve `d`; si no, las `desde`:00 locales
 * de hoy (si todavía no llegó) o de mañana.
 */
export function proximaAperturaMarketing(d: Date, cfg: HorarioMarketingCfg): Date {
  if (dentroHorarioMarketing(d, cfg)) return d;
  const p = partesAsuncion(d);
  const diaExtra = p.hora >= cfg.desde ? 1 : 0;
  const localComoUTC = Date.UTC(p.anio, p.mes - 1, p.dia + diaExtra, cfg.desde, 0, 0);
  let objetivo = new Date(localComoUTC - offsetMs(d));
  // Corrige si el desfase cambió entre `d` y el objetivo (cambio de hora).
  const corregido = new Date(localComoUTC - offsetMs(objetivo));
  if (corregido.getTime() !== objetivo.getTime()) objetivo = corregido;
  return objetivo;
}
