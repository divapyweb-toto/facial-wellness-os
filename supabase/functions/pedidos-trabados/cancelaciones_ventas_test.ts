import { assertEquals, assertStringIncludes } from "@std/assert";
import { opcionesAviso, textoAviso } from "./cancelaciones_ventas.ts";

Deno.test("21-10: aviso de cancelado con paquete en el courier y de reemplazo", () => {
  const a = textoAviso({ shopify_order_id: 1, nombre: "#1091", clase: "cancelado_en_courier", courier: "lucero" });
  assertEquals(a, "⚠ #1091 cancelado por el cliente pero ya está en Lucero: pedir que lo retengan o devuelvan");
  assertStringIncludes(textoAviso({ shopify_order_id: 2, nombre: "#1088", clase: "reemplazo_en_courier", courier: "pap" }), "ya está en PaP");
  assertStringIncludes(textoAviso({ shopify_order_id: 3, nombre: "#1", clase: "cancelado_en_courier", courier: "" }), "ya está en el courier");
});

Deno.test("27-10: cancelado en el courier = mismo tipo y clave que wa-webhook, una vez por día; reemplazo = Enrique", () => {
  assertEquals(opcionesAviso({ shopify_order_id: 5550001, nombre: "#1091", clase: "cancelado_en_courier", courier: "lucero" }),
    { tipo: "cancelado_en_courier", destino: "enrique", pedido: "#1091", clave: "5550001", unaVezPorDia: true });
  assertEquals(opcionesAviso({ shopify_order_id: 2, nombre: "#1088", clase: "reemplazo_en_courier", courier: "pap" }),
    { tipo: "reemplazo_en_courier", destino: "enrique", pedido: "#1088" });
});
