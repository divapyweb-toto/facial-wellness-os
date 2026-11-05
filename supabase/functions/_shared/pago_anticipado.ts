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
//   4. 29-10 (factura al cobrar): con el pago COMPLETO (pagadoCompleto) el trigger de la base llena
//      shopify_pedidos.pagado_en y se factura en ese momento (factura/io.ts facturarAlCobrar, o la cola de 10 min).
//      Pago parcial (SALDO_PENDIENTE / PAGO_PARCIAL): se factura al entregarse, como contra entrega.
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
    // 03-11 (ueno intervenido por el BCP): la cuenta es de Continental; "Transferí a" sirve para alias o cuenta.
    `💳 Transferí a: ${cfg.alias} — ${cfg.titular}\n` +
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

/** Tags de pago anticipado y de pago parcial. Las mismas listas usa el trigger shopify_pedidos_pagado_en (migración 20261029000001). */
export const TAGS_PAGADO_ANTICIPADO = TAGS_PAGADO;
export const TAGS_PAGO_PARCIAL = ["SALDO_PENDIENTE", "PAGO_PARCIAL"];

/**
 * 29-10 (factura al cobrar): cobrado POR COMPLETO por adelantado = tag PAGADO / PAGO_VERIFICADO / PAGADO_QR y sin
 * SALDO_PENDIENTE ni PAGO_PARCIAL. Solo por tags: el financial_status "paid" de Shopify no cuenta (post-entrega lo pone
 * al rendir el courier, y eso es contra entrega). Con esto se factura al pagarse, sin esperar la entrega.
 */
export function pagadoCompleto(p: { tags?: unknown }): boolean {
  const t = tagsMayus(p.tags);
  return TAGS_PAGADO.some((x) => t.includes(x)) && !pagoParcial(p);
}

/** Medio del pago anticipado, para el aviso de reembolso: QR, transferencia o "pago anticipado" sin detalle. */
export function medioPagoAnticipado(p: { tags?: unknown }): string {
  const t = tagsMayus(p.tags);
  if (t.includes(TAG_PAGADO_QR)) return "QR";
  if (t.includes(TAG_PAGO_VERIFICADO)) return "transferencia";
  return "pago anticipado (medio sin registrar)";
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

// ─── 05-11 (Enrique): pago anticipado OBLIGATORIO para clientes con devoluciones previas ───
// En el momento en que saldría la oferta de prioridad (wa-webhook al confirmar un pedido web; procesar-envios con el
// prio:<id> de un pedido del bot), si config_wa.pago_anticipado.requerido.activo y el cliente tiene
// >= min_devoluciones pedidos devueltos / no entregados (en Voltra o en FW: _shared/devoluciones_cliente.ts), sale EN
// LUGAR de la oferta el texto de pago obligatorio. Solo con la ventana de 24 h abierta (si no, nada cambia).
// Si el mensaje salió (y solo entonces, en ese momento): tags PAGO_ANTICIPADO_REQUERIDO + OFERTA_PAGO_ANTICIPADO (este
// último para que wa-webhook tome la foto como comprobante) y el candado eventos_crudos auto_pago_requerido:<id>, que
// es el reloj de 48 h con el que pedidos-trabados cancela si no pagó (igual que SIN_COBERTURA). Si el envío falla: ni
// tag ni candado, y sale la oferta de prioridad normal. Apagado (default): exactamente como antes.
// Nunca se le mencionan las devoluciones al cliente. Texto fijo del sistema (nunca IA).

/** Pedido al que se le exigió pagar por adelantado (lo lee pedidos-trabados con el candado). */
export const TAG_PAGO_REQUERIDO = "PAGO_ANTICIPADO_REQUERIDO";
/** config_wa['pago_anticipado'] (la misma fila que usa el comprobante); el interruptor va en `.requerido`. */
export const CLAVE_CONFIG_PAGO_ANTICIPADO = "pago_anticipado";

export type CfgPagoRequerido = { activo: boolean; min_devoluciones: number };
export const PAGO_REQUERIDO_DEFAULT: CfgPagoRequerido = { activo: false, min_devoluciones: 1 };

/** config_wa['pago_anticipado'] completo → `.requerido`. Sin clave o algo raro: apagado. */
export function leerConfigPagoRequerido(v: unknown): CfgPagoRequerido {
  const r = esObj(v) && esObj(v.requerido) ? v.requerido : null;
  if (!r) return { ...PAGO_REQUERIDO_DEFAULT };
  const min = Number(r.min_devoluciones);
  return {
    activo: r.activo === true,
    min_devoluciones: Number.isFinite(min) && min >= 1 ? Math.floor(min) : PAGO_REQUERIDO_DEFAULT.min_devoluciones,
  };
}

/** Candado en eventos_crudos (fuente 'shopify'): se inserta cuando el mensaje SALIÓ; arranca las 48 h. */
export const idCandadoPagoRequerido = (shopifyOrderId: number | string) => `auto_pago_requerido:${shopifyOrderId}`;

/** 125000 / "125000" → "125.000"; sin monto válido → null (sin total no se exige: el texto quedaría roto). */
export function montoGs(x: unknown): string | null {
  const n = Math.round(Number(x));
  return Number.isFinite(n) && n > 0 ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".") : null;
}

/** Texto del pago obligatorio (palabras del dueño, 05-11). No menciona devoluciones. */
export function textoPagoRequerido(cfg: Pick<CfgPagoPrioridad, "alias" | "titular">, p: { pedido: string; total: string }): string {
  return `📦 ¡Tu pedido ${p.pedido} quedó confirmado! Esta vez te pedimos pagarlo por adelantado por transferencia (Gs ${p.total}) y sale en el primer despacho.\n` +
    `💳 Transferí a: ${cfg.alias} — ${cfg.titular}\n` +
    "Mandanos la foto del comprobante por acá 🙌";
}

/**
 * Por qué NO se exige (null = se puede exigir), además de motivoSinOfertaPrioridad (pagado, retiro, cancelado…, que
 * ya cortan antes). SIN_COBERTURA tiene su propio flujo de pago anticipado; retiro en oficina paga al retirar.
 */
export function motivoSinPagoRequerido(p: { tags?: unknown }): string | null {
  const t = tagsMayus(p.tags);
  if (t.includes("SIN_COBERTURA")) return "sin_cobertura";
  if (t.includes("RETIRO_EN_CASA")) return "retiro_en_casa";
  if (t.includes(TAG_PAGO_REQUERIDO)) return "ya_requerido";
  return null;
}

/**
 * ¿Se exige pagar por adelantado? Interruptor prendido, pedido que corresponde, total conocido y devoluciones previas
 * >= mínimo. `devoluciones` null (no se pudo contar) → no se exige (ante la duda, la oferta normal).
 */
export function exigePagoRequerido(cfg: CfgPagoRequerido, devoluciones: number | null | undefined, p: { tags?: unknown; total?: unknown }): boolean {
  if (!cfg.activo || devoluciones == null || !Number.isFinite(devoluciones)) return false;
  if (motivoSinPagoRequerido(p) || !montoGs(p.total)) return false;
  return devoluciones >= cfg.min_devoluciones;
}
