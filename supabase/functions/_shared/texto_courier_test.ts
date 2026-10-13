import { assert, assertEquals } from "jsr:@std/assert@1";
import { avisoParaCourier, datosCourierDesdeRaw, textoParaCourier } from "./texto_courier.ts";

Deno.test("texto para el courier: datos del pedido, pin de la nota, cobro o ya pagado (10-10)", () => {
  const raw = { total_price: "112000", note: "Ubicación: -25.3581,-57.4447", shipping_address: { first_name: "Ana", last_name: "Prueba", address1: "Calle 1", address2: "Reja negra", city: "Capiatá" } };
  const d = datosCourierDesdeRaw("#1099", raw, "+595981000000");
  const t = textoParaCourier(d, "Volver a intentar la entrega.");
  assert(t.includes("Pedido #1099 de Voltra"));
  assert(t.includes("Cliente: Ana Prueba · 0981000000"));
  assert(t.includes("Dirección: Calle 1, Reja negra, Capiatá"));
  assert(t.includes("https://maps.google.com/?q=-25.3581,-57.4447"));
  assert(t.includes("Cobrar Gs 112.000."));
  assert(textoParaCourier({ ...d, pagado: true }, "x").includes("YA PAGADO"));
  assert(avisoParaCourier(d, "x", "lucero").startsWith("📦 <b>Para reenviar a Lucero</b>"));
  assertEquals(datosCourierDesdeRaw("#1", {}, null).ciudad, "?");
});
