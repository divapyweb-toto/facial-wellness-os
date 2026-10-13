// _shared/pago_anticipado.ts · 12-10 (decisión del dueño): pago anticipado OPCIONAL, SIN descuento, con PRIORIDAD.
// Nunca es obligatorio: si no paga antes, paga al recibir como siempre. El beneficio es salir primero en el despacho.
//
// Flujo (una sola oferta por pedido):
//   1. shopify-webhook: el pedido pasa a "preparado" (fulfilled en Shopify, Despacho) → programa `prio:<id>`
//      (envios_programados, clave única: nunca se repite) si el pedido no está pagado, ni es retiro, prueba,
//      mayorista o cancelado (motivoSinOfertaPrioridad).
//   2. procesar-envios: ventana de 24 h abierta → texto libre (textoOfertaPrioridad); cerrada → plantilla
//      voltra_pago_prioridad solo con config_wa.plantillas_activas.voltra_pago_prioridad = true; si no, no sale.
//      Si salió: tag OFERTA_PAGO_ANTICIPADO (Shopify + shopify_pedidos), así wa-webhook reconoce el comprobante.
//   3. wa-webhook: imagen o PDF del cliente → Telegram a Enrique con el archivo, el monto y el botón "Recibido"
//      (pagado:<id>). El pedido no cambia hasta que lo toca.
//   4. telegram-webhook (pagado:<id>): pagado en Shopify + tags PAGO_VERIFICADO, PRIORIDAD y PAGADO; si ya estaba
//      preparado, el texto para el courier con "YA PAGADO" (cobrar 0).
//
// Config (solo en Supabase, nunca en Git): config_wa['pago_prioridad'] =
//   {"activo": true, "alias": "<alias de la cuenta>", "titular": "Voltra E.A.S."}
// Apagado o sin alias: no sale nada. El descuento del 5% quedó retirado: ningún camino lo ofrece
// (config_wa.pago_anticipado_descuento ya no se lee).

export const CLAVE_CONFIG_PRIORIDAD = "pago_prioridad";
export const PLANTILLA_PAGO_PRIORIDAD = "voltra_pago_prioridad";

/** Se ofreció pagar antes (o el pedido nació en WhatsApp con la oferta): una imagen o PDF es comprobante. */
export const TAG_OFERTA_PAGO = "OFERTA_PAGO_ANTICIPADO";
/** Pagó por adelantado: sale primero en Despacho. */
export const TAG_PRIORIDAD = "PRIORIDAD";
/** Pagado (Enrique tocó "Recibido"): el courier no cobra. */
export const TAG_PAGADO = "PAGADO";
/** Transferencia verificada en el banco (se mantiene por compatibilidad: facturación y Despacho la leen). */
export const TAG_PAGO_VERIFICADO = "PAGO_VERIFICADO";
export const TAG_PAGADO_QR = "PAGADO_QR";
/** Flujo viejo (07-10): comprobante recibido. Ya no se pone; se respeta en pedidos de antes. */
export const TAG_COMPROBANTE_PAGO = "PAGO_ANTICIPADO_COMPROBANTE";

const TAGS_PAGADO = [TAG_PAGO_VERIFICADO, TAG_PAGADO, TAG_PAGADO_QR];

export type CfgPagoPrioridad = { activo: boolean; alias: string | null; titular: string };
export const TITULAR_DEFAULT = "Voltra E.A.S.";

type Obj = Record<string, unknown>;
const esObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const txt = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** config_wa['pago_prioridad'] → config usable. Sin clave, algo raro o sin alias: apagado (no se inventa nada). */
export function leerConfigPagoPrioridad(v: unknown): CfgPagoPrioridad {
  if (!esObj(v)) return { activo: false, alias: null, titular: TITULAR_DEFAULT };
  const alias = txt(v.alias);
  return { activo: v.activo === true && !!alias, alias, titular: txt(v.titular) ?? TITULAR_DEFAULT };
}

/** Texto de la oferta (palabras del dueño, 12-10). Solo dentro de la ventana de 24 h. */
export function textoOfertaPrioridad(cfg: Pick<CfgPagoPrioridad, "alias" | "titular">): string {
  return "📦 ¡Tu pedido ya está listo para salir!\n" +
    "Si querés recibirlo antes, podés pagarlo ahora por transferencia y sale con prioridad en el primer despacho.\n" +
    `💳 Alias: ${cfg.alias} — ${cfg.titular}\n` +
    "Si preferís, pagás al recibir como siempre 👍";
}

const tagsMayus = (tags: unknown): string[] =>
  (Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : []).map((t) => String(t).trim().toUpperCase());

/** Pagado antes de la entrega: tag PAGO_VERIFICADO / PAGADO / PAGADO_QR o Shopify "paid" (REST o GraphQL). */
export function pedidoPagado(p: { tags?: unknown; raw?: unknown }): boolean {
  const t = tagsMayus(p.tags);
  if (TAGS_PAGADO.some((x) => t.includes(x))) return true;
  const r = esObj(p.raw) ? p.raw : {};
  return txt(r.financial_status)?.toLowerCase() === "paid" || txt(r.displayFinancialStatus)?.toUpperCase() === "PAID";
}

/** Estados de envío en los que el paquete ya salió con el courier (o terminó): la oferta ya no tiene sentido. */
const ENVIO_YA_SALIO = new Set(["DESPACHADO", "INTENTO_FALLIDO", "ENTREGADO", "NO_ENTREGADO_RESCATABLE", "NO_ENTREGADO", "CANCELADO", "RENDIDO"]);

export type PedidoParaOferta = {
  tags?: unknown;
  raw?: unknown;
  estado_confirmacion?: string | null;
  estado_envio?: string | null;
};

/**
 * Por qué NO se ofrece pagar con prioridad (null = se ofrece). Ya pagado, retiro en persona, prueba del despliegue,
 * mayorista o sin mensajes, cancelado, ya salió con el courier, comprobante del flujo viejo, o la oferta vieja del
 * 07-10 ya enviada al confirmar (pedido web con OFERTA_PAGO_ANTICIPADO). Los pedidos de WhatsApp nacen con ese tag
 * (el vendedor lo pone al crearlos) y sí reciben la oferta.
 */
export function motivoSinOfertaPrioridad(p: PedidoParaOferta): string | null {
  const t = tagsMayus(p.tags);
  const r = esObj(p.raw) ? p.raw : {};
  if (r.cancelled_at || r.cancelledAt || String(p.estado_confirmacion ?? "").startsWith("cancelado")) return "cancelado";
  if (pedidoPagado(p)) return "ya_pagado";
  if (t.includes("RETIRO_EN_CASA")) return "retiro_en_casa";
  if (t.includes("PRUEBA_E2E")) return "prueba_e2e";
  if (t.includes("MAYORISTA") || t.includes("SIN_MENSAJES")) return "mayorista";
  if (p.estado_envio && ENVIO_YA_SALIO.has(String(p.estado_envio).toUpperCase())) return `envio_${String(p.estado_envio).toUpperCase()}`;
  if (t.includes(TAG_COMPROBANTE_PAGO)) return "comprobante_ya_recibido";
  if (t.includes(TAG_OFERTA_PAGO) && !t.includes("ORIGEN_WHATSAPP")) return "oferta_ya_enviada";
  return null;
}

/** Último fulfillment (no cancelado) del pedido, desde el raw REST (`fulfillments[].created_at`) o GraphQL (`createdAt`). */
export function ultimoFulfillment(raw: unknown): Date | null {
  const r = esObj(raw) ? raw : {};
  const lista = Array.isArray(r.fulfillments)
    ? r.fulfillments
    : esObj(r.fulfillments) && Array.isArray(r.fulfillments.nodes)
    ? r.fulfillments.nodes
    : [];
  let max: number | null = null;
  for (const f of lista) {
    if (!esObj(f)) continue;
    const estado = String(f.status ?? "").toLowerCase();
    if (estado === "cancelled" || estado === "failure" || estado === "error") continue;
    const t = Date.parse(String(f.created_at ?? f.createdAt ?? ""));
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max === null ? null : new Date(max);
}

/** Horas máximas desde que se marcó preparado: un orders/updated de un pedido viejo no dispara la oferta. */
export const OFERTA_PRIORIDAD_MAX_H = 12;

/** true si el pedido se marcó preparado hace menos de `maxH` horas (sin dato de fulfillment → false). */
export function preparadoReciente(raw: unknown, ahora: Date, maxH = OFERTA_PRIORIDAD_MAX_H): boolean {
  const f = ultimoFulfillment(raw);
  return !!f && ahora.getTime() - f.getTime() < maxH * 3_600_000 && f.getTime() <= ahora.getTime() + 5 * 60_000;
}
