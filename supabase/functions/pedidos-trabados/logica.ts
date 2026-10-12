// pedidos-trabados · lógica pura (12-10-2026). Decide qué hay que corregir en Shopify para que Voltra OS y Shopify digan
// lo mismo y ningún pedido quede trabado en "no preparado". Los mensajes al cliente NO son de acá (chat de WhatsApp API).
//   1. Confirmado en Voltra OS sin etiqueta CONFIRMADO → agregarla (si no, Despacho lo ve "sin confirmar").
//   2. Cancelado por el cliente (cancelado_cliente) hace más de 2 h y abierto en Shopify → cancelarlo (sin aviso,
//      devolviendo stock). Las 2 h dan margen al "Lo quiero igual". Los "sin respuesta" ya los cancela procesar-envios.
//   3. Sin dirección utilizable → etiqueta FALTAN_DATOS. Dirección utilizable = calle (≥ 6 letras) O pin GPS (Enrique
//      12-10: con pin se entrega igual) + ciudad. Si después se completa, se saca la etiqueta, pero SOLO si la puso el
//      sistema (una puesta a mano no se toca).
// Cada acción se hace una sola vez por pedido (candado en eventos_crudos): si Enrique la deshace a mano, se respeta.

export type Accion = "agregar_confirmado" | "cancelar" | "agregar_faltan_datos" | "quitar_faltan_datos";

export interface PedidoAbierto {
  shopifyOrderId: number;
  nombre: string;
  estado: string | null; // estado_confirmacion
  tags: string[];
  actualizadoEn: string | null;
  direccion: string; // address1 + address2
  ciudad: string;
  notas: string; // note + note_attributes (para el pin)
}

export const MARGEN_CANCELACION_MS = 2 * 3_600_000;
const PIN = /-\d{1,2}\.\d{3,}\s*,\s*-\d{1,2}\.\d{3,}/;

export function tienePin(p: Pick<PedidoAbierto, "direccion" | "notas">): boolean {
  return PIN.test(p.direccion) || PIN.test(p.notas);
}

export function direccionUtilizable(p: Pick<PedidoAbierto, "direccion" | "notas" | "ciudad">): boolean {
  if (!p.ciudad.trim() || p.ciudad.trim() === "-") return false;
  const calle = p.direccion.replace(/pin de ubicaci[oó]n:?/gi, "").replace(PIN, "").replace(/https?:\/\/\S+/g, "").replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "");
  return calle.length >= 6 || tienePin(p);
}

const tiene = (p: PedidoAbierto, t: string) => p.tags.some((x) => x.toUpperCase() === t);

/** Acciones para un pedido. `puseFaltanDatos` = el sistema puso la etiqueta (candado). */
export function accionesPara(p: PedidoAbierto, ahora: Date, puseFaltanDatos: boolean): Accion[] {
  const a: Accion[] = [];
  const cancelado = p.estado === "cancelado_cliente" || p.estado === "cancelado_sin_respuesta" || tiene(p, "CANCELADO_CLIENTE");
  if (p.estado === "cancelado_cliente" || (tiene(p, "CANCELADO_CLIENTE") && p.estado !== "confirmado")) {
    const t = p.actualizadoEn ? Date.parse(p.actualizadoEn) : NaN;
    if (Number.isFinite(t) && ahora.getTime() - t >= MARGEN_CANCELACION_MS) a.push("cancelar");
    return a; // cancelado: nada más que hacer
  }
  if (cancelado) return a;
  if (p.estado === "confirmado" && !tiene(p, "CONFIRMADO")) a.push("agregar_confirmado");
  const ok = direccionUtilizable(p);
  if (!ok && !tiene(p, "FALTAN_DATOS") && !tiene(p, "RETIRO_EN_CASA")) a.push("agregar_faltan_datos");
  if (ok && tiene(p, "FALTAN_DATOS") && puseFaltanDatos) a.push("quitar_faltan_datos");
  return a;
}
