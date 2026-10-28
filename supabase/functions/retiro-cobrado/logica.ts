// retiro-cobrado/logica.ts · 28-10 (pedido de administración, caso #1089: se retiró y cobró en la oficina y nunca se
// registró). Puro: valida el pedido de Despacho y decide qué etiquetas van a Shopify.

export type Medio = "efectivo" | "transferencia";
export interface Entrada { pedido: string; fecha: string; medio: Medio }

/** "#1089" o "VT-1089" → "#1089". */
export function nombrePedido(v: unknown): string | null {
  const m = /^\s*(?:#|VT-?)?\s*(\d{3,7})\s*$/i.exec(String(v ?? ""));
  return m ? `#${m[1]}` : null;
}

export function validar(b: unknown, hoyPY: string): { ok: true; e: Entrada } | { ok: false; error: string } {
  const o = (b ?? {}) as Record<string, unknown>;
  const pedido = nombrePedido(o.pedido);
  if (!pedido) return { ok: false, error: "pedido inválido (usar #1089 o VT-1089)" };
  const fecha = String(o.fecha ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(`${fecha}T12:00:00Z`))) return { ok: false, error: "fecha inválida (AAAA-MM-DD)" };
  if (fecha > hoyPY) return { ok: false, error: "la fecha del retiro no puede ser futura" };
  const medio = String(o.medio ?? "");
  if (medio !== "efectivo" && medio !== "transferencia") return { ok: false, error: "medio de pago: efectivo o transferencia" };
  return { ok: true, e: { pedido, fecha, medio } };
}

/** Solo un retiro en persona confirmado, abierto y sin cerrar se puede marcar. */
export function motivoNoMarcar(p: { tags: string[]; cancelado: boolean; borrador: boolean } | null): string | null {
  if (!p) return "no encontré el pedido";
  if (p.borrador) return "es un borrador";
  if (p.cancelado) return "el pedido está cancelado";
  const t = p.tags.map((x) => x.toUpperCase());
  if (!t.includes("RETIRO_EN_CASA")) return "no es un retiro en persona (RETIRO_EN_CASA)";
  if (t.some((x) => x.startsWith("RETIRADO_"))) return "ya figura retirado";
  return null;
}

/** Etiquetas: pagado siempre; PAGO_VERIFICADO solo si fue transferencia (lo usa factura/Despacho); RETIRADO_<dd_mm>. */
export function etiquetas(e: Entrada): string[] {
  const [, mm, dd] = e.fecha.split("-");
  return ["PAGADO", ...(e.medio === "transferencia" ? ["PAGO_VERIFICADO"] : []), `RETIRADO_${dd}_${mm}`];
}
