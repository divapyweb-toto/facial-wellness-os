// _shared/comprobante.ts · 29-10 (Enrique: "arregla lo del comprobante de pago"). Dos avisos de "mandó el comprobante"
// del 29-10 no eran comprobantes (#1162: captura de nuestro anuncio; #1125: captura del chat con el repartidor).
// 1) Antes de tratar una imagen como comprobante, Claude (modelo barato) dice si es un comprobante de pago (banco o
//    billetera, monto, fecha u operación). No → la imagen sigue al vendedor como cualquier otra, sin aviso.
// 2) Si es comprobante, a Enrique no se le avisa enseguida: la tarea voltra-verificar-pagos-ueno (cada 30 min, 7 a 21 h)
//    cruza el correo de ueno y lo marca pagado. seguimiento-chat avisa solo si a los `espera_min` (40) sigue sin pagar.
// Lógica pura salvo clasificarComprobante, que recibe la llamada a Claude por parámetro.
import type { Bloque, PedidoClaude, RespuestaClaude } from "./claude.ts";
import { textoDe } from "./claude.ts";

export const MODELO_CLASIFICADOR = "claude-haiku-4-5-20251001";
export const ESPERA_MIN_DEFAULT = 40;
/** Horario en que corre la verificación automática (hora de Asunción): fuera de eso no se puede esperar el cruce. */
export const VERIFICADOR_DESDE_H = 7;
export const VERIFICADOR_HASTA_H = 21;

export type Clasificacion = { es: boolean | null; monto: number | null; motivo: string; datos?: DatosComprobante };

/**
 * 29-10 (agente F): lo que se lee del comprobante para asociarlo solo a la transferencia del aviso de ueno
 * (_shared/pagos_ranking.ts). Va en wa_mensajes.contenido.comprobante_datos. Solo para comparar: nunca a Telegram.
 */
export type DatosComprobante = {
  nro_transaccion: string | null;
  /** Otros números de operación o referencia que figuren (SIPAP, comprobante, etc.). */
  referencias: string[];
  /** Quien paga (titular de la cuenta origen). */
  titular: string | null;
  /** Banco o billetera de origen. */
  banco: string | null;
  /** Fecha y hora que figura en el comprobante, en ISO con hora de Asunción (−03:00). */
  fecha: string | null;
};

export const PROMPT_COMPROBANTE =
  "Mirá la imagen que mandó un cliente por WhatsApp. ¿Es un comprobante de un pago o transferencia ya hecha " +
  "(captura o foto de una app de banco o billetera, o un ticket, con monto y algún dato de la operación: fecha, " +
  "número, titular o banco)? NO lo es: una captura de un anuncio o de un producto, un chat, una foto del producto o " +
  "del paquete, una dirección o un mapa, una cédula, o una pantalla para hacer un pago que todavía no se hizo. " +
  'Respondé solo con JSON: {"es_comprobante": true|false, "monto": número en guaraníes o null, "motivo": "en 5 palabras", ' +
  '"nro_transaccion": "número de transacción u operación" o null, "referencias": [otros números de referencia], ' +
  '"titular": "nombre de quien paga (cuenta origen)" o null, "banco": "banco o billetera de origen" o null, ' +
  '"fecha_hora": "AAAA-MM-DD HH:MM" como figura en el comprobante o null}. Copiá los datos tal cual, sin inventar.';

const textoCorto = (v: unknown, max: number): string | null => {
  const t = typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim() : "";
  return t && !/^(null|n\/a|ninguno|-)$/i.test(t) ? t.slice(0, max) : null;
};

/** "2026-10-29 15:30" (hora de Asunción) → ISO; también "29/10/2026 15:30". Cualquier otra cosa → null. */
export function fechaComprobante(v: unknown): string | null {
  const t = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(t);
  let y: string, mo: string, d: string, h: string, mi: string;
  if (m) [, y, mo, d, h, mi] = m;
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})/.exec(t);
    if (!m) return null;
    [, d, mo, y, h, mi] = m;
  }
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:00-03:00`;
  return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
}

/** Datos del JSON del modelo; undefined si no trae ninguno. */
export function interpretarDatos(j: Record<string, unknown>): DatosComprobante | undefined {
  const refs = Array.isArray(j.referencias) ? j.referencias.map((r) => textoCorto(r, 40)).filter((r): r is string => !!r).slice(0, 5) : [];
  const d: DatosComprobante = {
    nro_transaccion: textoCorto(j.nro_transaccion, 40),
    referencias: refs,
    titular: textoCorto(j.titular, 80),
    banco: textoCorto(j.banco, 60),
    fecha: fechaComprobante(j.fecha_hora),
  };
  return d.nro_transaccion || d.referencias.length || d.titular || d.banco || d.fecha ? d : undefined;
}

/** Texto de Claude → clasificación. Cualquier cosa que no se entienda = null (se trata como hasta el 28-10). */
export function interpretarClasificacion(texto: string): Clasificacion {
  const m = /\{[\s\S]*\}/.exec(texto ?? "");
  if (!m) return { es: null, monto: null, motivo: "respuesta_sin_json" };
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const es = typeof j.es_comprobante === "boolean" ? j.es_comprobante : null;
    const n = Number(String(j.monto ?? "").replace(/[^\d]/g, ""));
    const datos = interpretarDatos(j);
    return { es, monto: Number.isFinite(n) && n > 0 ? n : null, motivo: String(j.motivo ?? "").slice(0, 80), ...(datos ? { datos } : {}) };
  } catch {
    return { es: null, monto: null, motivo: "json_invalido" };
  }
}

/** Clasifica un bloque de imagen (base64). Si Claude falla, es=null: el llamador sigue como antes (comprobante). */
export async function clasificarComprobante(
  imagen: Bloque,
  llamar: (p: PedidoClaude) => Promise<RespuestaClaude>,
): Promise<Clasificacion & { costo_usd: number }> {
  try {
    const r = await llamar({
      modelo: MODELO_CLASIFICADOR,
      system: "Clasificás imágenes para una tienda de Paraguay. Respondés solo JSON.",
      mensajes: [{ role: "user", content: [imagen, { type: "text", text: PROMPT_COMPROBANTE }] }],
      maxTokens: 350,
    });
    return { ...interpretarClasificacion(textoDe(r.contenido)), costo_usd: r.costo_usd };
  } catch (e) {
    return { es: null, monto: null, motivo: `error_clasificador: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120), costo_usd: 0 };
  }
}

/** Hora de Asunción (UTC−3, sin horario de verano desde 2024). */
const horaPy = (d: Date) => (d.getUTCHours() + 24 - 3) % 24;

/**
 * Cuándo vence la espera del cruce automático: `espera_min` después de llegar. Si eso cae fuera del horario del
 * verificador (7 a 21 h de Asunción), se corre a las 7:00 + espera del día siguiente (o del mismo día de madrugada):
 * de noche Enrique tampoco lo vería.
 */
export function venceEspera(llego: Date, esperaMin = ESPERA_MIN_DEFAULT): Date {
  const vence = new Date(llego.getTime() + esperaMin * 60_000);
  const h = horaPy(vence);
  if (h >= VERIFICADOR_DESDE_H && h < VERIFICADOR_HASTA_H) return vence;
  // Fecha de Asunción (UTC−3) del vencimiento; si ya pasó la hora de corte, el día siguiente.
  const py = new Date(vence.getTime() - 3 * 3_600_000);
  if (h >= VERIFICADOR_HASTA_H) py.setUTCDate(py.getUTCDate() + 1);
  // 07:00 de Asunción = 10:00 UTC del mismo día de Asunción.
  const base = Date.UTC(py.getUTCFullYear(), py.getUTCMonth(), py.getUTCDate(), VERIFICADOR_DESDE_H + 3);
  return new Date(base + esperaMin * 60_000);
}

export type EstadoEspera = "pagado" | "avisar" | "esperar";

/** Comprobante en espera: ya pagado (lo cruzó el verificador o lo tocó Enrique) → nada; vencido → aviso; si no, esperar. */
export function decidirEspera(d: { pagado: boolean; vence: Date; ahora: Date }): EstadoEspera {
  if (d.pagado) return "pagado";
  return d.ahora.getTime() >= d.vence.getTime() ? "avisar" : "esperar";
}
