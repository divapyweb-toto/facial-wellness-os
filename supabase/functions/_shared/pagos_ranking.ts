// _shared/pagos_ranking.ts · 29-10-2026. Ranking puro de "¿a qué pedido corresponde esta transferencia?".
// Caso que lo originó: una transferencia de Gs 112.000 (29-10 15:30 PY, sin número ni titular) no se asoció a #1164
// porque había 17 pedidos esperando ese monto, aunque el cliente de #1164 mandó el comprobante por WhatsApp ese mismo
// minuto. Sin red: quien lo use trae los candidatos (vista pagos_candidatos + datos para comparar) y ejecuta.
//
// Orden de señales (cada una achica la lista; si queda UNO, es ese):
//   1. telefono:    el teléfono del chat que mandó el comprobante = teléfono del pedido;
//   2. comprobante: el chat del pedido mandó un comprobante (foto/PDF, wa_mensajes.contenido.comprobante_pago_anticipado)
//                   cerca de la hora de la transferencia (por defecto de 3 h antes a 1 h después);
//   3. titular:     el titular del comprobante comparte al menos 2 palabras con el nombre del cliente
//                   (sin tildes, sin mayúsculas, en cualquier orden).
// El "más reciente con OFERTA_PAGO_ANTICIPADO" solo ordena la lista (no alcanza para marcar plata solo).
// Si no queda uno solo con señal → ambiguo: aviso a Enrique con los 3 más probables y un botón "Es este" en cada uno
// (callback es_este:<orderId>:<ref>, telegram-webhook lo trata igual que "Recibido").
// Nada de datos personales hacia afuera: nombres y teléfonos solo se comparan acá; el aviso lleva pedido, total,
// ciudad y hace cuánto.

import { normalizarTelefonoPY } from "./telefono.ts";
import { type BotonTelegram, escaparHtml, formatearGuaranies, horaCortaAsuncion, LIMITE_CALLBACK_BYTES } from "./telegram_formato.ts";

export interface TransferenciaRecibida {
  monto: number;
  /** Hora de la transferencia (ISO). */
  fecha: string;
  /** Número de transacción (si el aviso lo trae). */
  nro_transaccion?: string | null;
  /** Titular de la cuenta que debita (si el aviso o el comprobante lo trae). */
  titular?: string | null;
  /** Teléfono del chat de WhatsApp que mandó el comprobante (si llegó por ahí). */
  telefonoChat?: string | null;
  banco?: string | null;
}

export interface CandidatoPago {
  shopify_order_id: number;
  /** "#1164" */
  pedido: string;
  /** Lo que espera cobrar (total o SALDO_<monto>). */
  monto_pendiente: number;
  total: number | null;
  ciudad: string | null;
  creado_en: string;
  tags: string[];
  /** Solo para comparar; nunca sale de acá. */
  telefono?: string | null;
  /** Solo para comparar; nunca sale de acá. */
  nombresCliente?: string[];
  /** Último comprobante que mandó el chat de este pedido (ISO), si hubo. */
  comprobanteChatEn?: string | null;
}

export type SenalPago = "telefono" | "comprobante" | "titular";

export interface CandidatoRankeado {
  candidato: CandidatoPago;
  senales: SenalPago[];
  puntaje: number;
}

export type ResultadoRanking =
  | { tipo: "unico"; candidato: CandidatoPago; senales: SenalPago[]; top: CandidatoRankeado[]; total: number }
  | { tipo: "ambiguo"; top: CandidatoRankeado[]; total: number }
  | { tipo: "ninguno" };

export interface OpcionesRanking {
  /** Minutos antes de la transferencia en los que un comprobante del chat cuenta (default 180). */
  comprobanteAntesMin?: number;
  /** Minutos después (el cliente a veces manda la captura un rato más tarde; default 60). */
  comprobanteDespuesMin?: number;
  /** Cuántos candidatos lleva el aviso (default 3). */
  maxTop?: number;
}

const ETIQUETAS_PAGADO = ["PAGADO", "PAGO_VERIFICADO", "PAGADO_QR"];
const VACIAS = new Set(["DEL", "LOS", "LAS", "SRL", "EAS", "SAE"]);
const MIN = 60_000;

/** Palabras de un nombre: sin tildes, en mayúsculas, solo letras, de 3+ letras y sin conectores. */
export function palabrasNombre(s: string | null | undefined): string[] {
  return [
    ...new Set(
      String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/)
        .filter((w) => w.length >= 3 && !VACIAS.has(w)),
    ),
  ];
}

/** Cuántas palabras del titular aparecen en los nombres del cliente (en cualquier orden). */
export function palabrasEnComun(titular: string | null | undefined, nombres: string[]): number {
  const cliente = new Set(nombres.flatMap((n) => palabrasNombre(n)));
  return palabrasNombre(titular).filter((w) => cliente.has(w)).length;
}

/** Mismo celular de Paraguay (normalizado a +5959…). */
export function mismoTelefono(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = a ? normalizarTelefonoPY(a) : null;
  const y = b ? normalizarTelefonoPY(b) : null;
  return !!x && x === y;
}

function comprobanteCerca(c: CandidatoPago, t: TransferenciaRecibida, o: Required<OpcionesRanking>): number | null {
  if (!c.comprobanteChatEn) return null;
  const dif = (Date.parse(c.comprobanteChatEn) - Date.parse(t.fecha)) / MIN; // < 0: el comprobante llegó antes
  if (!Number.isFinite(dif)) return null;
  return dif >= -o.comprobanteAntesMin && dif <= o.comprobanteDespuesMin ? Math.abs(dif) : null;
}

function evaluar(c: CandidatoPago, t: TransferenciaRecibida, o: Required<OpcionesRanking>): CandidatoRankeado {
  const senales: SenalPago[] = [];
  let puntaje = 0;
  if (t.telefonoChat && mismoTelefono(t.telefonoChat, c.telefono)) {
    senales.push("telefono");
    puntaje += 1000;
  }
  const cerca = comprobanteCerca(c, t, o);
  if (cerca !== null) {
    senales.push("comprobante");
    puntaje += 500 - Math.min(cerca, 240); // más cerca de la hora, más arriba
  }
  const comunes = palabrasEnComun(t.titular, c.nombresCliente ?? []);
  if (comunes >= 2) {
    senales.push("titular");
    puntaje += 200 + comunes * 10;
  } else if (comunes === 1) puntaje += 20; // una sola palabra no alcanza, pero ordena
  const tags = c.tags.map((x) => x.toUpperCase());
  if (tags.includes("OFERTA_PAGO_ANTICIPADO")) puntaje += 5;
  // Desempate: el más reciente primero (fracción < 1 para no pisar las señales).
  const edadH = Math.max(0, (Date.parse(t.fecha) - Date.parse(c.creado_en)) / 3_600_000);
  puntaje += 1 / (1 + (Number.isFinite(edadH) ? edadH : 1e6));
  return { candidato: c, senales, puntaje };
}

/**
 * Candidatos de la transferencia, ordenados. "unico" = un solo pedido con señal fuerte (se asocia como hoy);
 * "ambiguo" = hay pedidos con ese monto pero ninguno se destaca solo (aviso con botones); "ninguno" = nadie espera
 * ese monto.
 */
export function rankearCandidatos(t: TransferenciaRecibida, candidatos: CandidatoPago[], opciones: OpcionesRanking = {}): ResultadoRanking {
  const o: Required<OpcionesRanking> = { comprobanteAntesMin: 180, comprobanteDespuesMin: 60, maxTop: 3, ...opciones };
  const monto = Math.round(t.monto);
  const exactos = candidatos.filter((c) =>
    Math.round(c.monto_pendiente) === monto && !c.tags.some((x) => ETIQUETAS_PAGADO.includes(x.toUpperCase()))
  );
  if (!exactos.length) return { tipo: "ninguno" };
  const evaluados = exactos.map((c) => evaluar(c, t, o)).sort((a, b) => b.puntaje - a.puntaje);
  const top = evaluados.slice(0, o.maxTop);
  let grupo = evaluados;
  for (const s of ["telefono", "comprobante", "titular"] as SenalPago[]) {
    const con = grupo.filter((e) => e.senales.includes(s));
    if (con.length === 1) return { tipo: "unico", candidato: con[0].candidato, senales: con[0].senales, top, total: exactos.length };
    if (con.length > 1) grupo = con; // la señal no alcanza sola: la siguiente desempata entre estos
  }
  // Los que tienen señal ya quedan arriba por puntaje.
  return { tipo: "ambiguo", top, total: exactos.length };
}

// ---------- aviso a Enrique ----------

export const ACCION_ES_ESTE = "es_este";

/** Referencia corta del pago para el botón: el nro. de transacción (últimos 20) o la hora "t2610291530". */
export function refTransferencia(t: TransferenciaRecibida): string {
  const nro = String(t.nro_transaccion ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (nro) return nro.slice(-20);
  const d = new Date(Date.parse(t.fecha) - 3 * 3_600_000); // hora de Paraguay (UTC−3)
  if (Number.isNaN(d.getTime())) return "sinref";
  const z = (n: number) => String(n).padStart(2, "0");
  return `t${String(d.getUTCFullYear()).slice(2)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}`;
}

/** es_este:<orderId>:<ref> (Telegram admite 64 bytes de callback_data). */
export function callbackEsEste(orderId: number, ref: string): string {
  const limpio = String(ref).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30) || "sinref";
  const cb = `${ACCION_ES_ESTE}:${orderId}:${limpio}`;
  return new TextEncoder().encode(cb).length <= LIMITE_CALLBACK_BYTES ? cb : cb.slice(0, LIMITE_CALLBACK_BYTES);
}

/** "hace 6 min", "hace 3 h", "hace 2 días". */
export function haceCuanto(desdeISO: string, ahora: Date): string {
  const m = Math.max(0, Math.round((ahora.getTime() - Date.parse(desdeISO)) / MIN));
  if (!Number.isFinite(m)) return "";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

const SENAL_TEXTO: Record<SenalPago, string> = {
  telefono: "mismo teléfono que el chat",
  comprobante: "mandó comprobante por WhatsApp",
  titular: "titular coincide",
};

/** Aviso HTML (escapado) para Telegram cuando la transferencia es ambigua: los más probables con "Es este". */
export function avisoCandidatos(
  t: TransferenciaRecibida,
  r: { top: CandidatoRankeado[]; total: number },
  ahora: Date,
): { texto: string; botones: BotonTelegram[][] } {
  const ref = refTransferencia(t);
  const tx = t.nro_transaccion ? `tx …${escaparHtml(String(t.nro_transaccion).slice(-3))}` : "sin nro. de transacción";
  const banco = t.banco ? `, ${escaparHtml(t.banco)}` : "";
  const cab = `💸 Transferencia de Gs ${formatearGuaranies(t.monto).replace("₲", "")} (${horaCortaAsuncion(new Date(t.fecha))}, ${tx}${banco}) sin pedido claro: ` +
    `${r.total === 1 ? "hay 1 pedido" : `hay ${r.total} pedidos`} esperando ese monto.`;
  const lineas = [cab, r.top.length > 1 ? `Los ${r.top.length} más probables:` : "El más probable:"];
  r.top.forEach((e, i) => {
    const c = e.candidato;
    const partes = [
      `<b>${escaparHtml(c.pedido)}</b>`,
      `Gs ${formatearGuaranies(c.total ?? c.monto_pendiente).replace("₲", "")}`,
      c.ciudad ? escaparHtml(c.ciudad) : "sin ciudad",
      haceCuanto(c.creado_en, ahora),
      ...e.senales.map((s) => SENAL_TEXTO[s]),
    ].filter(Boolean);
    lineas.push(`${i + 1}. ${partes.join(" · ")}`);
  });
  lineas.push("Verificalo en el banco y tocá el que corresponda (hace lo mismo que Recibido).");
  const botones: BotonTelegram[][] = r.top.map((e) => [{ texto: `Es este: ${e.candidato.pedido}`, callback: callbackEsEste(e.candidato.shopify_order_id, ref) }]);
  return { texto: lineas.join("\n"), botones };
}
