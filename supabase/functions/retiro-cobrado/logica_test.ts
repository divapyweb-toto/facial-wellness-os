import { assertEquals } from "@std/assert";
import { etiquetas, motivoNoMarcar, nombrePedido, validar } from "./logica.ts";

Deno.test("validar: pedido, fecha no futura y medio", () => {
  assertEquals(validar({ pedido: "VT-1089", fecha: "2026-10-20", medio: "transferencia" }, "2026-10-28"), { ok: true, e: { pedido: "#1089", fecha: "2026-10-20", medio: "transferencia" } });
  assertEquals(validar({ pedido: "#1089", fecha: "2026-10-30", medio: "efectivo" }, "2026-10-28").ok, false);
  assertEquals(validar({ pedido: "#1089", fecha: "20-10", medio: "efectivo" }, "2026-10-28").ok, false);
  assertEquals(validar({ pedido: "#1089", fecha: "2026-10-20", medio: "tarjeta" }, "2026-10-28").ok, false);
  assertEquals(validar({ pedido: "hola", fecha: "2026-10-20", medio: "efectivo" }, "2026-10-28").ok, false);
  assertEquals(nombrePedido("1089"), "#1089");
});

Deno.test("solo un retiro confirmado abierto y sin cerrar", () => {
  assertEquals(motivoNoMarcar({ tags: ["CONFIRMADO", "RETIRO_EN_CASA"], cancelado: false, borrador: false }), null);
  assertEquals(motivoNoMarcar({ tags: ["CONFIRMADO"], cancelado: false, borrador: false }), "no es un retiro en persona (RETIRO_EN_CASA)");
  assertEquals(motivoNoMarcar({ tags: ["RETIRO_EN_CASA", "RETIRADO_20_10"], cancelado: false, borrador: false }), "ya figura retirado");
  assertEquals(motivoNoMarcar({ tags: ["RETIRO_EN_CASA"], cancelado: true, borrador: false }), "el pedido está cancelado");
  assertEquals(motivoNoMarcar(null), "no encontré el pedido");
});

Deno.test("etiquetas: PAGO_VERIFICADO solo con transferencia; RETIRADO con día y mes", () => {
  assertEquals(etiquetas({ pedido: "#1089", fecha: "2026-10-20", medio: "transferencia" }), ["PAGADO", "PAGO_VERIFICADO", "RETIRADO_20_10"]);
  assertEquals(etiquetas({ pedido: "#1090", fecha: "2026-11-03", medio: "efectivo" }), ["PAGADO", "RETIRADO_03_11"]);
});
