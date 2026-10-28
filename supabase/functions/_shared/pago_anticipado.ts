// _shared/pago_anticipado.ts · 12-10 (decisión del dueño): pago anticipado OPCIONAL, SIN descuento, con PRIORIDAD.
// Nunca es obligatorio: si no paga antes, paga al recibir como siempre. El beneficio es salir primero en el despacho.
//
// Flujo (una sola oferta por pedido; 12-10 tarde: al CONFIRMAR, ya no al pasar a "preparado"):
//   1a. Pedido web: el cliente confirma (conf_si / "Confirmo" de la v4) → wa-webhook responde la confirmación y
//       enseguida la oferta como texto libre (la ventana de 24 h está abierta porque el cliente acaba de escribir).
//       Reserva `prio:<id>` en envios_programados (ya 'enviado') para que nunca se repita.
//   1b. Pedido del bot de WhatsApp (nace confirmado: ORIGEN_WHATSAPP + CONFIRMADO): shopify-webhook programa
//       `prio:<id>` al llegar el pedido recién creado y procesar-envios lo manda como texto libre si la ventana está
//       abierta. Ventana cerrada → no sale (la plantilla voltra_pago_prioridad ya no se usa).
//   En los dos: no se ofrece si está pagado, es retiro, prueba, mayorista, cancelado o ya preparado / despachado
//   (motivoSinOfertaPrioridad). Al salir: tag OFERTA_PAGO_ANTICIPADO, así wa-webhook reconoce el comprobante.
//   2. wa-webhook: imagen o PDF del cliente → Telegram a Enrique con el archivo, el monto y el botón "Recibido"
//      (pagado:<id>). El pedido no cambia hasta que lo toca.
//   3. telegram-webhook (pagado:<id>): pagado en Shopify + tags PAGO_VERIFICADO, PRIORIDAD y PAGADO; si ya estaba
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

/** Clave única de la oferta en envios_programados: una sola por pedido, venga por donde venga. */
export const claveOfertaPrioridad = (shopifyOrderId: number | string) => `prio:${shopifyOrderId}`;

/** Texto de la oferta (palabras del dueño, 12-10). Solo dentro de la ventana de 24 h (texto libre). */
export function textoOfertaPrioridad(cfg: Pick<CfgPagoPrioridad, "alias" | "titular">): string {
  return "📦 ¡Tu pedido quedó confirmado!\n" +
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

/**
 * 28-10 (#1027): pago parcial (pagó una parte y el saldo lo transfiere: SALDO_PENDIENTE / PAGO_PARCIAL). No es "pagado"
 * (falta el saldo) pero el courier tampoco cobra el total: ningún aviso de entrega con monto tiene que salir.
 */
export function pagoParcial(p: { tags?: unknown }): boolean {
  const t = tagsMayus(p.tags);
  return t.includes("SALDO_PENDIENTE") || t.includes("PAGO_PARCIAL");
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
 * mayorista o sin mensajes, cancelado, ya preparado en Shopify (fulfilled) o con el courier / entregado, comprobante
 * del flujo viejo, o la oferta vieja del
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
  // 12-10: ya despachado (preparado en Shopify) → no se ofrece.
  if (txt(r.fulfillment_status)?.toLowerCase() === "fulfilled" || txt(r.displayFulfillmentStatus)?.toUpperCase() === "FULFILLED") return "ya_preparado";
  if (t.includes(TAG_COMPROBANTE_PAGO)) return "comprobante_ya_recibido";
  if (t.includes(TAG_OFERTA_PAGO) && !t.includes("ORIGEN_WHATSAPP")) return "oferta_ya_enviada";
  return null;
}
