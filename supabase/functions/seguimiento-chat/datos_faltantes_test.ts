import { assertEquals } from "jsr:@std/assert@1";
import { elegirParaPedirDatos, type PedidoFaltan } from "./datos_faltantes.ts";

const p = (id: number, extra: Partial<PedidoFaltan> = {}): PedidoFaltan => ({
  shopify_order_id: id, nombre: `#${id}`, cliente_id: "c", estado_confirmacion: "confirmado", tags: ["FALTAN_DATOS"], cancelado: false, primer_nombre: "ana", ...extra,
});

Deno.test("pedir datos (12-10): solo con candado del sistema, FALTAN_DATOS, sin cancelar ni retiro", () => {
  const todos = [p(1), p(2), p(3, { tags: ["FALTAN_DATOS", "RETIRO_EN_CASA"] }), p(4, { cancelado: true }), p(5, { estado_confirmacion: "cancelado_cliente" }), p(6, { tags: [] }), p(7, { cliente_id: null })];
  const r = elegirParaPedirDatos(todos, new Set([1, 3, 4, 5, 6, 7]));
  assertEquals(r.map((x) => x.shopify_order_id), [1]); // el 2 no tiene candado (etiqueta a mano)
});
