// salud-canal/salud.ts · Dueño: D (Telegram)
// Lógica pura del chequeo "canal sordo" (corre cada 15 min).
// Avisa por Telegram, solo dentro del horario (8 a 21 h Asunción), si:
//   1. no entró ningún mensaje en las últimas 3 h de horario,
//   2. hubo 3 o más envíos fallidos en la última hora,
//   3. llegó un webhook de calidad/estado del número (Meta).
// El mismo aviso no se repite más de una vez cada 3 h (estado en config_wa.salud_ultimo_aviso).
import { partesAsuncion } from "../_shared/horario.ts";
import { type AvisoArmado, formatoFalla } from "../_shared/telegram_formato.ts";

export interface CfgSalud {
  horas_sin_entrantes: number;
  fallidos_por_hora: number;
  repetir_cada_h: number;
}

/** Valores del contrato; config_wa.salud_canal puede pisarlos. */
export const CFG_SALUD_CONTRATO: CfgSalud = { horas_sin_entrantes: 3, fallidos_por_hora: 3, repetir_cada_h: 3 };

export interface HorarioCfg {
  desde: number;
  hasta: number;
}

/** Lo que se guarda en config_wa clave 'salud_ultimo_aviso'. */
export interface EstadoAvisos {
  sin_entrantes?: string; // ISO del último aviso de ese tipo
  fallidos?: string;
  calidad?: string;
  ultimo_evento_calidad_id?: number; // último evento de calidad ya avisado
}

export interface EventoCalidad {
  id: number;
  recibido_en: string;
  campo: string; // phone_number_quality_update | account_update
  evento: string; // FLAGGED, DOWNGRADE, THROUGHPUT_UPGRADE, ACCOUNT_RESTRICTION...
  detalle: string;
}

export type ClaveMotivo = "sin_entrantes" | "fallidos" | "calidad";
export interface Motivo {
  clave: ClaveMotivo;
  texto: string;
}

export interface EntradaSalud {
  ahora: Date;
  horario: HorarioCfg;
  cfg: CfgSalud;
  ultimaEntrada: string | null; // último wa_mensajes direccion 'in'
  fallidosUltimaHora: number;
  eventosCalidad: EventoCalidad[]; // ya filtrados por id > ultimo_evento_calidad_id
  estado: EstadoAvisos;
}

export interface ResultadoSalud {
  enHorario: boolean;
  motivos: Motivo[];
  /** Estado a guardar SOLO si el aviso salió bien. */
  nuevoEstado: EstadoAvisos;
}

const HORA = 3_600_000;

export function enHorario(d: Date, h: HorarioCfg): boolean {
  const { hora } = partesAsuncion(d);
  return hora >= h.desde && hora < h.hasta;
}

/** Instante de apertura (desde:00) del día de hoy en Asunción. */
export function aperturaDeHoy(d: Date, h: HorarioCfg): Date {
  const p = partesAsuncion(d);
  const desdeMedianoche = ((p.hora * 60 + p.minuto) * 60 + p.segundo) * 1000 + (d.getTime() % 1000);
  return new Date(d.getTime() - desdeMedianoche + h.desde * HORA);
}

/** Lee config_wa.salud_canal con los valores del contrato como base. */
export function leerCfgSalud(valor: unknown): CfgSalud {
  const v = (valor ?? {}) as Partial<Record<keyof CfgSalud, unknown>>;
  const num = (x: unknown, def: number) => (typeof x === "number" && x > 0 ? x : def);
  return {
    horas_sin_entrantes: num(v.horas_sin_entrantes, CFG_SALUD_CONTRATO.horas_sin_entrantes),
    fallidos_por_hora: num(v.fallidos_por_hora, CFG_SALUD_CONTRATO.fallidos_por_hora),
    repetir_cada_h: num(v.repetir_cada_h, CFG_SALUD_CONTRATO.repetir_cada_h),
  };
}

const CAMPOS_CALIDAD = new Set(["phone_number_quality_update", "account_update"]);

function deCambio(id: number, recibido_en: string, campo: unknown, valor: unknown): EventoCalidad | null {
  if (typeof campo !== "string" || !CAMPOS_CALIDAD.has(campo)) return null;
  const v = (valor ?? {}) as Record<string, unknown>;
  const evento = String(v.event ?? v.ban_info ?? "SIN_EVENTO");
  const partes: string[] = [];
  const limite = v.max_daily_conversations_per_business ?? v.current_limit;
  if (limite) partes.push(`límite actual: ${limite}`);
  if (v.old_limit) partes.push(`límite anterior: ${v.old_limit}`);
  const restr = v.restriction_info ?? v.violation_info ?? v.ban_info;
  if (restr) partes.push(`detalle: ${JSON.stringify(restr).slice(0, 300)}`);
  return { id, recibido_en, campo, evento, detalle: partes.join(" · ") };
}

/**
 * Busca webhooks de calidad del número en filas de eventos_crudos (fuente 'whatsapp').
 * Acepta el cuerpo completo de Meta ({entry:[{changes:[{field,value}]}]}),
 * un cambio suelto ({field, value}) o envuelto ({change:{field,value}}).
 */
export function extraerEventosCalidad(filas: { id: number; recibido_en: string; payload: unknown }[]): EventoCalidad[] {
  const out: EventoCalidad[] = [];
  for (const f of filas) {
    const p = (f.payload ?? {}) as Record<string, unknown>;
    const cambios: { field?: unknown; value?: unknown }[] = [];
    if (Array.isArray(p.entry)) {
      for (const e of p.entry as { changes?: unknown[] }[]) {
        for (const c of (e?.changes ?? []) as { field?: unknown; value?: unknown }[]) cambios.push(c);
      }
    }
    if (p.field) cambios.push(p as { field?: unknown; value?: unknown });
    if (p.change && typeof p.change === "object") cambios.push(p.change as { field?: unknown; value?: unknown });
    for (const c of cambios) {
      const ev = deCambio(f.id, f.recibido_en, c.field, c.value);
      if (ev) out.push(ev);
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

function recienteAviso(iso: string | undefined, ahora: Date, horas: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && ahora.getTime() - t < horas * HORA;
}

export function evaluarSalud(e: EntradaSalud): ResultadoSalud {
  const nuevoEstado: EstadoAvisos = { ...e.estado };
  if (!enHorario(e.ahora, e.horario)) return { enHorario: false, motivos: [], nuevoEstado };

  const motivos: Motivo[] = [];
  const ahoraIso = e.ahora.toISOString();
  const silenciado = (c: ClaveMotivo) => recienteAviso(e.estado[c], e.ahora, e.cfg.repetir_cada_h);

  // 1. Sin entrantes: se cuenta desde el último mensaje o desde la apertura de hoy,
  //    lo que sea más tarde (si no, a las 8:00 siempre saltaría por la noche).
  //    Sin ningún mensaje en la historia (canal sin estrenar) no se avisa.
  if (e.ultimaEntrada) {
    const ultima = Date.parse(e.ultimaEntrada);
    const desde = Math.max(ultima, aperturaDeHoy(e.ahora, e.horario).getTime());
    const horas = (e.ahora.getTime() - desde) / HORA;
    if (horas >= e.cfg.horas_sin_entrantes && !silenciado("sin_entrantes")) {
      const hace = Math.floor((e.ahora.getTime() - ultima) / HORA);
      motivos.push({
        clave: "sin_entrantes",
        texto: `No entró ningún mensaje de WhatsApp en ${e.cfg.horas_sin_entrantes} h de horario (el último, hace ${hace} h).`,
      });
      nuevoEstado.sin_entrantes = ahoraIso;
    }
  }

  // 2. Envíos fallidos en la última hora.
  if (e.fallidosUltimaHora >= e.cfg.fallidos_por_hora && !silenciado("fallidos")) {
    motivos.push({ clave: "fallidos", texto: `${e.fallidosUltimaHora} envíos fallidos en la última hora.` });
    nuevoEstado.fallidos = ahoraIso;
  }

  // 3. Calidad del número: cada evento nuevo se avisa una vez (no es "el mismo aviso").
  const nuevos = e.eventosCalidad.filter((x) => x.id > (e.estado.ultimo_evento_calidad_id ?? 0));
  if (nuevos.length) {
    const lista = nuevos.map((x) => `${x.campo}: ${x.evento}${x.detalle ? ` (${x.detalle})` : ""}`).join("; ");
    motivos.push({ clave: "calidad", texto: `Meta avisó un cambio en el número: ${lista}.` });
    nuevoEstado.calidad = ahoraIso;
    nuevoEstado.ultimo_evento_calidad_id = nuevos[nuevos.length - 1].id;
  }

  return { enHorario: true, motivos, nuevoEstado };
}

export function avisoSalud(motivos: Motivo[]): AvisoArmado {
  return formatoFalla({
    titulo: "posible canal sordo en WhatsApp",
    detalles: motivos.map((m) => m.texto),
    queHacer:
      "Mirá la bandeja de Voltra OS y los registros de wa-webhook en Supabase; revisá en Meta (WhatsApp Manager) el token, la tarjeta y la calidad del número.",
  });
}
