// pago-qr-webhook · lógica pura. Todo el I/O entra por `DepsPagoQR`.
//
// Al confirmarse un pago QR: cobros_qr → 'pagado' (una sola vez, update condicional), tag PAGADO_QR
// en Shopify y aviso a Telegram con lo que hay que decirle al courier para que NO cobre en la puerta.
// Si el monto no coincide con el cobro: 'monto_distinto', aviso y nada más (Enrique decide).

import type { EventoPagoQR, ProveedorQR } from "../_shared/pago_qr.ts";

export interface ConfigOla4QR {
  activo: boolean;
  validez_horas: number;
  etiqueta: string; // "Pedido Voltra {pedido}"
  tag_shopify: string;
  tolerancia_gs: number;
  texto_oferta: string; // "{url}" obligatorio
  aviso_courier: { lucero: string; pap: string };
}

export const CONFIG_OLA4_QR_DEFECTO: ConfigOla4QR = {
  activo: false,
  validez_horas: 48,
  etiqueta: "Pedido Voltra {pedido}",
  tag_shopify: "PAGADO_QR",
  tolerancia_gs: 0,
  texto_oferta: "Si querés, podés pagarlo ahora con QR y lo despachamos primero: {url}",
  aviso_courier: { lucero: "YA PAGADO - NO COBRAR", pap: "forma de pago: Pagado" },
};

export function configQR(valor: unknown): ConfigOla4QR {
  const v = valor && typeof valor === "object" ? valor as Partial<ConfigOla4QR> : {};
  return { ...CONFIG_OLA4_QR_DEFECTO, ...v, activo: v.activo === true };
}

export interface CobroQR {
  id: string;
  shopify_order_id: number;
  proveedor: ProveedorQR;
  estado: string; // pendiente | pagado | fallido | monto_distinto | vencido
  monto: number;
  id_externo: string;
}

export interface PedidoMin {
  nombre: string | null;
  courier: string | null;
}

export interface DepsPagoQR {
  buscarCobro(proveedor: ProveedorQR, idExterno: string): Promise<CobroQR | null>;
  /** update cobros_qr set estado=?, ... where id=? and estado <> 'pagado' returning → true si cambió. */
  cambiarEstado(id: string, estado: string, extra: Record<string, unknown>): Promise<boolean>;
  leerPedido(orderId: number): Promise<PedidoMin | null>;
  agregarTag(orderId: number, tag: string): Promise<{ ok: boolean; error?: string }>;
  avisar(textoHtml: string): Promise<unknown>;
  escapar(s: unknown): string;
  ahora(): Date;
}

export type AccionPagoQR = "cobro_desconocido" | "ya_pagado" | "no_pagado" | "monto_distinto" | "pagado";

export function formatoGs(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Texto para Telegram con la instrucción al courier según quién lleva el pedido. */
export function textoAvisoPago(p: PedidoMin | null, orderId: number, monto: number, proveedor: string, cfg: ConfigOla4QR, esc: (s: unknown) => string): string {
  const courier = (p?.courier ?? "").toLowerCase();
  const instruccion = courier.includes("lucero")
    ? `Lucero: marcar "${cfg.aviso_courier.lucero}".`
    : courier.includes("pap") || courier.includes("punto")
    ? `Punto a Punto: ${cfg.aviso_courier.pap}.`
    : `Avisá al courier que no cobre (Lucero: "${cfg.aviso_courier.lucero}"; Punto a Punto: ${cfg.aviso_courier.pap}).`;
  return `<b>Pago QR recibido</b> · pedido ${esc(p?.nombre ?? orderId)}\nGs ${formatoGs(monto)} · ${esc(proveedor)}\n${esc(instruccion)}`;
}

export async function procesarPagoQR(
  proveedor: ProveedorQR,
  ev: EventoPagoQR,
  cfg: ConfigOla4QR,
  deps: DepsPagoQR,
): Promise<{ accion: AccionPagoQR; orderId?: number }> {
  const cobro = await deps.buscarCobro(proveedor, ev.id_externo);
  if (!cobro) {
    await deps.avisar(`<b>Pago QR sin cobro conocido</b> · ${deps.escapar(proveedor)} ${deps.escapar(ev.id_externo)} (${deps.escapar(ev.estado_crudo)})`);
    return { accion: "cobro_desconocido" };
  }
  const orderId = cobro.shopify_order_id;
  if (cobro.estado === "pagado") return { accion: "ya_pagado", orderId };
  if (!ev.pagado) {
    // Estados intermedios: se registran, sin aviso.
    await deps.cambiarEstado(cobro.id, cobro.estado, { ultimo_estado_proveedor: ev.estado_crudo });
    return { accion: "no_pagado", orderId };
  }
  if (ev.monto !== null && Math.abs(ev.monto - Number(cobro.monto)) > cfg.tolerancia_gs) {
    const cambio = await deps.cambiarEstado(cobro.id, "monto_distinto", { ultimo_estado_proveedor: ev.estado_crudo, monto_pagado: ev.monto });
    if (cambio) {
      await deps.avisar(
        `<b>Pago QR con monto distinto</b> · pedido ${deps.escapar(orderId)}\nCobro Gs ${formatoGs(Number(cobro.monto))}, pagado Gs ${formatoGs(ev.monto)}. No se marcó como pagado.`,
      );
    }
    return { accion: "monto_distinto", orderId };
  }
  const cambio = await deps.cambiarEstado(cobro.id, "pagado", {
    pagado_en: deps.ahora().toISOString(),
    ultimo_estado_proveedor: ev.estado_crudo,
    monto_pagado: ev.monto ?? cobro.monto,
  });
  if (!cambio) return { accion: "ya_pagado", orderId };
  const tag = await deps.agregarTag(orderId, cfg.tag_shopify);
  const ped = await deps.leerPedido(orderId);
  let texto = textoAvisoPago(ped, orderId, ev.monto ?? Number(cobro.monto), proveedor, cfg, deps.escapar);
  if (!tag.ok) texto += `\nNo se pudo poner la tag ${deps.escapar(cfg.tag_shopify)} en Shopify: ${deps.escapar(tag.error ?? "")}`;
  await deps.avisar(texto);
  return { accion: "pagado", orderId };
}

/** Texto de la oferta de pago (lo manda wa-webhook dentro de la ventana de 24 h, tras "Confirmar"). */
export function textoOfertaQR(cfg: ConfigOla4QR, url: string): string {
  return cfg.texto_oferta.replace("{url}", url);
}

export interface DepsEventoQR {
  guardarEvento(): Promise<boolean>;
  procesar(): Promise<unknown>;
  marcarProcesado(error: string | null): Promise<void>;
  /** Borra la marca del evento para que el reintento del proveedor no quede como "repetido". */
  borrarEvento(): Promise<void>;
  avisar(textoHtml: string): Promise<unknown>;
  escapar(s: unknown): string;
}

/**
 * Orquesta un webhook ya verificado. Sin bandera: ola4.qr solo frena CREAR cobros (ofrecerCobroQR);
 * el pago de un cobro existente se registra siempre (si no, se cobra dos veces).
 * Si procesar falla: se borra la marca, aviso a Telegram y status 500 → el proveedor reintenta.
 */
export async function atenderEventoQR(
  d: DepsEventoQR,
  idEvento: string,
): Promise<{ status: number; cuerpo: Record<string, unknown> }> {
  const nuevo = await d.guardarEvento();
  if (!nuevo) return { status: 200, cuerpo: { ok: true, repetido: true } };
  try {
    await d.procesar();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await d.borrarEvento().catch(() => d.marcarProcesado(msg).catch(() => {}));
    await Promise.resolve(d.avisar(`<b>Pago QR: falló el registro</b> · evento ${d.escapar(idEvento)}\n${d.escapar(msg)}\nSe pidió reintento al proveedor.`)).catch(() => {});
    return { status: 500, cuerpo: { ok: false, error: "procesar" } };
  }
  await d.marcarProcesado(null).catch(() => {});
  return { status: 200, cuerpo: { ok: true } };
}
