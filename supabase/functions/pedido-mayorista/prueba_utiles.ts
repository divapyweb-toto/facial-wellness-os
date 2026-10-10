// Datos inventados para los tests de pedido-mayorista (repo público). No es un archivo de tests.
import { dvModulo11 } from "../_shared/sifen/cdc.ts";

export const RUC = "1234567";
export const DV = String(dvModulo11(RUC));

export function cuerpoValido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accion: "crear",
    clave_idempotencia: "11111111-2222-4333-8444-555555555555",
    cliente: { nombre: "Cliente Prueba", telefono: "0981 000000", direccion: "Calle Falsa 123", referencia: null, ciudad: "Ciudad del Este" },
    fiscal: { ruc: RUC, dv: DV, razon_social: "EMPRESA DE PRUEBA S.A.", email: null },
    items: [{ variant_id: "gid://shopify/ProductVariant/111", titulo: "Producto A", cantidad: 10, precio_unitario: 50000 }],
    envio: 30000,
    cobro: "contra_entrega",
    comprobante_ref: null,
    condicion: "contado",
    plazo_dias: null,
    anterior_al_corte: false,
    fecha_entrega: null,
    nota: null,
    ...extra,
  };
}
