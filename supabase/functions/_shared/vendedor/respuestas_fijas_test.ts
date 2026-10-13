import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { elegirVariante, esGraciasSuelto, esOkSuelto, esStickerOEmoji, RESPUESTAS_FIJAS_DEFAULT, tipoRespuestaFija } from "./respuestas_fijas.ts";
import { revisarRespuesta } from "./filtro_salida.ts";

Deno.test("fijas: reconoce sticker/emoji suelto, 'gracias' y 'ok' sueltos (y nada más)", () => {
  for (const t of ["[sticker]", "👍", "😂😂", "🙏🏽"]) assert(esStickerOEmoji(t), t);
  for (const t of ["[sticker] jaja", "👍 cuánto sale?", "ok", ""]) assertFalse(esStickerOEmoji(t), t);
  for (const t of ["gracias", "Gracias!!", "muchas gracias che", "graciass 🙏", "mil gracias"]) assert(esGraciasSuelto(t), t);
  for (const t of ["gracias, cuánto sale?", "gracias pero está caro", "no gracias"]) assertFalse(esGraciasSuelto(t), t);
  for (const t of ["ok", "Dale!", "listo", "perfecto gracias", "okey"]) assert(esOkSuelto(t), t);
  assertFalse(esOkSuelto("ok, y cuánto tarda?"));
});

Deno.test("fijas: qué tipo corresponde según el estado de la conversación", () => {
  const nuevo = { hayMensajesNuestros: false, estadoPedidoChat: null };
  const charlando = { hayMensajesNuestros: true, estadoPedidoChat: null };
  const resumen = { hayMensajesNuestros: true, estadoPedidoChat: "resumen" as const };
  const creado = { hayMensajesNuestros: true, estadoPedidoChat: "creado" as const };
  assertEquals(tipoRespuestaFija("[sticker]", nuevo), "sticker_inicio");
  assertEquals(tipoRespuestaFija("[sticker]", charlando), null); // a mitad de la venta lo ve el modelo
  assertEquals(tipoRespuestaFija("gracias", charlando), "gracias");
  assertEquals(tipoRespuestaFija("ok", charlando), null);
  assertEquals(tipoRespuestaFija("ok", resumen), null); // puede ser el sí al resumen
  assertEquals(tipoRespuestaFija("gracias", resumen), null);
  assertEquals(tipoRespuestaFija("ok", creado), "post_pedido");
  assertEquals(tipoRespuestaFija("👍", creado), "post_pedido");
  assertEquals(tipoRespuestaFija("gracias!", creado), "gracias");
  assertEquals(tipoRespuestaFija("y cuándo llega?", creado), null);
});

Deno.test("fijas: elige variante al azar, nunca repite la última y si ya contestó ese tipo se calla", () => {
  const cfg = RESPUESTAS_FIJAS_DEFAULT;
  assertEquals(elegirVariante("gracias", cfg, null, 0), cfg.gracias[0]);
  assertEquals(elegirVariante("gracias", cfg, null, 0.99), cfg.gracias[1]);
  assertEquals(elegirVariante("gracias", cfg, cfg.gracias[0], 0), null);
  assertEquals(elegirVariante("post_pedido", { post_pedido: [] }, null, 0), RESPUESTAS_FIJAS_DEFAULT.post_pedido[0]);
});

Deno.test("fijas: los textos por defecto pasan el filtro de salida (humanos, sin muletillas)", () => {
  for (const lista of Object.values(RESPUESTAS_FIJAS_DEFAULT)) {
    for (const t of lista) assertEquals(revisarRespuesta(t, { catalogo: [], prohibidas: ["garantía"] }).motivos, [], t);
  }
});

Deno.test("esCierreNuestro + acuses: 'ok' tras 'cuando quieras escribime' no se contesta; tras una pregunta sí (09-10)", async () => {
  const { esCierreNuestro, esOkSuelto } = await import("./respuestas_fijas.ts");
  assert(esCierreNuestro("Cuando se te acaben, escribime y te la armo."));
  assert(esCierreNuestro("Perfecto, tu pedido #1015 quedó confirmado."));
  assertFalse(esCierreNuestro("Te armo 1 y pagás al recibir, ¿te lo mando?"));
  assertFalse(esCierreNuestro("Sale 79.000 + 33.000 de envío = 112.000"));
  for (const t of ["Correcto", "Ok", "dale", "bueno gracias", "entendido"]) assert(esOkSuelto(t), t);
});
