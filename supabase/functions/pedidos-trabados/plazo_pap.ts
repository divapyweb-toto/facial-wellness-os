// pedidos-trabados · alerta de plazo PaP (Enrique 26-10-2026). Lógica pura; la lectura está en plazo_pap_io.ts.
// Pedido PaP en "En Oficina", "Asignado a ruta" o "Borrador" con MÁS de 5 días hábiles (lun–vie, Paraguay; sin feriados)
// desde la fecha de la VENTA → un Telegram por pedido, una sola vez en la vida (candado auto_plazo_pap:<ref> en
// eventos_crudos, mismo avisarUnaVez de entregas_actuar.ts). El texto va listo para reenviar a PaP: sin nombre ni teléfono.
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { avisarUnaVez, type DepsActuar, diaPy } from "./entregas_actuar.ts";

export interface FilaPlazoPap { ref: string; ciudad: string | null; estado: string; fechaVenta: string; guia?: string | null }
export interface HechoPlazoPap { ref: string; estado: string; dias: number; resultado: string }

export const UMBRAL_DIAS_HABILES_PAP = 5;
const ESTADOS = ["en oficina", "asignado a ruta", "borrador"];
const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** ¿El estado de PaP es uno de los que cuentan plazo? (sin importar mayúsculas, tildes ni espacios). */
export const estadoPlazoPap = (estado: string | null | undefined) =>
  ESTADOS.includes(sinTildes(String(estado ?? "")).toLowerCase().replace(/\s+/g, " ").trim());

/** Días hábiles (lun–vie) DESPUÉS de la fecha de venta y hasta hoy en Paraguay, inclusive. Venta hoy = 0. */
export function diasHabilesDesde(fecha: string | null, ahora: Date): number | null {
  if (!fecha || !/^\d{4}-\d{2}-\d{2}/.test(fecha)) return null;
  const desde = Date.parse(`${fecha.slice(0, 10)}T00:00:00Z`), hasta = Date.parse(`${diaPy(ahora)}T00:00:00Z`);
  if (!Number.isFinite(desde)) return null;
  let n = 0;
  for (let t = desde + 86_400_000; t <= hasta; t += 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return n;
}

export const claveCandadoPlazoPap = (ref: string) => `auto_plazo_pap:${ref}`;
const fechaLinda = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

/** Telegram: encabezado para Enrique + texto listo para reenviar a PaP. Solo ref, ciudad, estado, guía y fechas. */
export function textoPlazoPap(f: FilaPlazoPap, dias: number): string {
  const ref = escaparHtml(f.ref), estado = escaparHtml(f.estado.trim()), ciudad = escaparHtml((f.ciudad ?? "").trim() || "ciudad sin cargar");
  const guia = f.guia?.trim() ? ` (guía ${escaparHtml(f.guia.trim())})` : "";
  return `⏳ <b>${ref}</b> · PaP: ${dias} días hábiles en "${estado}". Reenviale esto a PaP:\n\n` +
    `Hola, consulto por el pedido ${ref}${guia}, destino ${ciudad}. Figura "${estado}" y la venta es del ${fechaLinda(f.fechaVenta)} ` +
    `(${dias} días hábiles). ¿Me confirman cuándo sale a reparto? Gracias.`;
}

/** Avisa los que pasaron el umbral (una vez por pedido). Los que no, no se tocan: se reevalúan en la próxima corrida. */
export async function procesarPlazoPap(filas: FilaPlazoPap[], ahora: Date, d: DepsActuar, simular = false): Promise<HechoPlazoPap[]> {
  const hechos: HechoPlazoPap[] = [];
  for (const f of filas) {
    if (!estadoPlazoPap(f.estado)) continue;
    const dias = diasHabilesDesde(f.fechaVenta, ahora);
    if (dias == null || dias <= UMBRAL_DIAS_HABILES_PAP) continue;
    const r = await avisarUnaVez(d, claveCandadoPlazoPap(f.ref), { ref: f.ref, estado: f.estado, dias }, textoPlazoPap(f, dias), simular);
    hechos.push({ ref: f.ref, estado: f.estado, dias, resultado: r });
  }
  return hechos;
}
