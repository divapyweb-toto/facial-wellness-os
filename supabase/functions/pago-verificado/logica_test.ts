import { assertEquals } from "@std/assert";
import { comprobanteEnVentana, MARGEN_COMPROBANTE_PREVIO_MS } from "./logica.ts";

// 18-11 (caso tipo #1239, datos inventados): el comprobante llega segundos ANTES de que exista el pedido. Se acepta solo si
// seguimiento-chat lo marcó con ESE pedido (contenido.comprobante_pago_anticipado) y llegó hasta 30 min antes de crearse.
Deno.test("comprobanteEnVentana: después del pedido siempre; antes solo con la marca del pedido y dentro de 30 min", () => {
  const creado = Date.parse("2026-11-14T16:08:58Z");
  const iso = (msAntes: number) => new Date(creado - msAntes).toISOString();
  assertEquals(MARGEN_COMPROBANTE_PREVIO_MS, 30 * 60_000);
  assertEquals(comprobanteEnVentana(iso(-60_000), creado, null, "111"), true); // 1 min después, sin marca: como siempre
  assertEquals(comprobanteEnVentana(iso(22_000), creado, "111", "111"), true); // 22 s antes, marcado con este pedido
  assertEquals(comprobanteEnVentana(iso(29 * 60_000), creado, "111", "111"), true);
  assertEquals(comprobanteEnVentana(iso(31 * 60_000), creado, "111", "111"), false); // fuera de los 30 min
  assertEquals(comprobanteEnVentana(iso(22_000), creado, "222", "111"), false); // marcado con OTRO pedido
  assertEquals(comprobanteEnVentana(iso(22_000), creado, null, "111"), false); // sin marca: no
  assertEquals(comprobanteEnVentana("no-fecha", creado, "111", "111"), false);
});
