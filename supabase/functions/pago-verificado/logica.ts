// pago-verificado/logica.ts · 27-10. Decide si una transferencia recibida (aviso de ueno en el Gmail de Voltra) se
// puede marcar como el botón "Recibido" del Telegram. Puro, sin red: index.ts trae el pedido y ejecuta.
// Reglas (pedido de administración, Enrique 27-10 "que el chat/sistema de whatsapp lo haga"):
//   - el pedido existe, no está cancelado ni reemplazado y todavía no está pagado;
//   - espera un pago: OFERTA_PAGO_ANTICIPADO, SIN_COBERTURA o SALDO_PENDIENTE;
//   - el monto es EXACTO a lo pendiente (saldo = SALDO_<monto>; si no, el total del pedido);
//   - y además hay coincidencia: comprobante en el chat (PAGO_ANTICIPADO_COMPROBANTE) o el titular que debita
//     coincide con el nombre del cliente. Si no, no se marca nada (administración se lo pasa a Enrique).

export interface PedidoPago {
  shopify_order_id: number;
  nombre: string | null;
  estado_envio: string | null;
  tags: string[] | null;
  total: number | null;
  cancelado: boolean;
  /** Nombres del cliente (Shopify, nota del pedido, WhatsApp): solo para comparar acá, nunca se devuelven. */
  nombresCliente: string[];
}

export type Motivo = "oferta_pago_anticipado" | "sin_cobertura" | "saldo_pendiente";

export type Decision =
  | { ok: true; motivo: Motivo; pendiente: number; coincidencia: "comprobante" | "nombre" }
  | { ok: false; error: "pedido_cancelado" | "ya_pagado" | "no_espera_pago" | "sin_monto_pendiente" | "monto_distinto" | "sin_coincidencia"; pendiente?: number; detalle: string };

const T = (tags: string[] | null) => (tags ?? []).map((t) => t.trim().toUpperCase());
export const ETIQUETAS_PAGADO = ["PAGADO", "PAGO_VERIFICADO", "PAGADO_QR"];

/** "#1135", "VT-1135" o "1135" → "#1135". */
export function nombrePedido(entrada: string): string | null {
  const m = /^\s*(?:#|VT-?)?\s*(\d{3,7})\s*$/i.exec(String(entrada ?? ""));
  return m ? `#${m[1]}` : null;
}

export function montoSaldo(tags: string[] | null): number | null {
  for (const t of T(tags)) {
    const m = /^SALDO_(\d+)$/.exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}

const palabras = (s: string) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/)
    .filter((w) => w.length >= 3 && !["DEL", "LOS", "LAS", "SRL", "EAS"].includes(w));

/** El titular coincide si comparte al menos 2 palabras (nombre y apellido) con alguno de los nombres del cliente. */
export function coincideNombre(titular: string | null | undefined, nombres: string[]): boolean {
  const a = new Set(palabras(titular ?? ""));
  if (a.size < 2) return false;
  return nombres.some((n) => palabras(n).filter((w) => a.has(w)).length >= 2);
}

export function decidir(p: PedidoPago, monto: number, titular?: string | null): Decision {
  const tags = T(p.tags);
  if (p.cancelado || String(p.estado_envio ?? "").toUpperCase() === "CANCELADO" || tags.some((t) => t.includes("CANCELADO") || t.startsWith("REEMPLAZADO_POR_"))) {
    return { ok: false, error: "pedido_cancelado", detalle: "el pedido está cancelado o reemplazado" };
  }
  if (tags.some((t) => ETIQUETAS_PAGADO.includes(t))) return { ok: false, error: "ya_pagado", detalle: "el pedido ya figura pagado" };
  const motivo: Motivo | null = tags.includes("SALDO_PENDIENTE") ? "saldo_pendiente"
    : tags.includes("SIN_COBERTURA") ? "sin_cobertura"
    : tags.includes("OFERTA_PAGO_ANTICIPADO") ? "oferta_pago_anticipado" : null;
  if (!motivo) return { ok: false, error: "no_espera_pago", detalle: "el pedido no espera una transferencia (sin oferta, sin cobertura ni saldo)" };
  const pendiente = motivo === "saldo_pendiente" ? montoSaldo(p.tags) : (p.total ?? null);
  if (!pendiente || pendiente <= 0) return { ok: false, error: "sin_monto_pendiente", detalle: motivo === "saldo_pendiente" ? "falta la etiqueta SALDO_<monto>" : "el pedido no tiene total" };
  if (Math.round(monto) !== Math.round(pendiente)) return { ok: false, error: "monto_distinto", pendiente, detalle: `transferencia Gs ${monto} y el pedido espera Gs ${pendiente}` };
  if (tags.includes("PAGO_ANTICIPADO_COMPROBANTE")) return { ok: true, motivo, pendiente, coincidencia: "comprobante" };
  if (coincideNombre(titular, p.nombresCliente)) return { ok: true, motivo, pendiente, coincidencia: "nombre" };
  return { ok: false, error: "sin_coincidencia", pendiente, detalle: "el monto coincide pero no hay comprobante en el chat ni el titular coincide con el cliente" };
}
