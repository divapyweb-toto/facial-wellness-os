import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { esIntencionEscrita, intencionEnBloque, lineaPrecioIntencion, notaIntencion, yaPidioDatos } from "./intencion.ts";
import type { ItemCatalogo } from "./herramientas.ts";

Deno.test("21-10 intención escrita: las frases de compra cuentan como el botón", () => {
  for (const t of ["Quiero", "quiero", "Lo quiero", "quiero 1", "Quiero 2!", "me interesa", "Me interesa 👍", "Cómo hago?", "como hago para pedir",
    "Mandame", "mandame 2", "pido", "Te pido uno", "Si quiero", "Hola quiero", "dale lo quiero", "quiero las tiras", "Quiero el pack", "kiero 1"]) {
    assert(esIntencionEscrita(t), t);
  }
});

Deno.test("21-10 intención escrita: preguntas, precargados del anuncio y pedidos de otra cosa NO cuentan", () => {
  for (const t of ["¡Hola! Quiero más información", "quiero saber el precio", "Me interesa, cuánto sale?", "Quiero que me llegue hoy",
    "Pero quiero gratis", "no lo quiero", "No me interesa", "cómo hago para pagar", "¡Hola! Me gustaría conseguir más información sobre esto",
    "quiero más info", "Mañana voy a viajar", "ok", "hola"]) {
    assertFalse(esIntencionEscrita(t), t);
  }
  // El precargado del anuncio con el producto ("Hola, quiero la botella flexible") no cuenta como primer mensaje.
  assertFalse(esIntencionEscrita("Hola, quiero la botella flexible", false));
  assert(esIntencionEscrita("quiero la botella", true));
});

Deno.test("21-10 intención en el bloque: caso real '1877' (precargado + 'Quiero' al segundo)", () => {
  const marca = "[vino del anuncio de raspador de lengua, handle raspador-prueba]\n[el anuncio decía: \"Lengua limpia\"]";
  const r = intencionEnBloque([`${marca}\n¡Hola! Quiero más información`, `${marca}\nQuiero`], false);
  assertEquals(r, { frase: "quiero", cantidad: null });
  assertEquals(intencionEnBloque([`${marca}\n¡Hola! Quiero más información`], false), null);
  assertEquals(intencionEnBloque([`${marca}\nHola, quiero el raspador de lengua`], false), null);
  // El toque de un botón lo maneja el prompt.
  assertEquals(intencionEnBloque(["[botón] Quiero 1 (vend_p1:q1:raspador-prueba)"], true), null);
  // "quiero" y después "2": gana la cantidad.
  assertEquals(intencionEnBloque(["quiero", "mandame 2"], true)?.cantidad, 2);
});

Deno.test("21-10 yaPidioDatos: el pedido de datos no se repite", () => {
  assert(yaPidioDatos("Genial! Pasame tu nombre, tu ciudad y la calle o barrio 🙌"));
  assert(yaPidioDatos("Solo me falta tu ciudad y la calle o el barrio 🙌"));
  assertFalse(yaPidioDatos("Sale 79.000 + 33.000 de envío (112.000 en total), pagás al recibir."));
});

const PROD: ItemCatalogo = {
  handle: "tiras-prueba", titulo: "Tiras Nasales", variante_id: "v", precio: 79000, precio_texto: "79.000", disponible: true, total: 112000,
  total_texto: "112.000", imagen: null, frase_precio: "", ofertas: [
    { cantidad: 2, precio: 125000, precio_texto: "125.000", total: 158000, total_texto: "158.000", ahorro: 33000, ahorro_texto: "33.000", frase_precio: "" },
  ],
};

Deno.test("21-10 línea de precio y nota: montos del catálogo, una línea, sin primer_turno", () => {
  assertEquals(lineaPrecioIntencion(PROD, null), "Sale 79.000 + 33.000 de envío (112.000 en total), pagás al recibir. Llevando 2 el envío te sale gratis: 158.000 por los 2.");
  assertEquals(lineaPrecioIntencion(PROD, 2), "Los 2 te salen 158.000 con envío gratis, pagás al recibir.");
  const n = notaIntencion({ frase: "quiero", cantidad: null }, PROD);
  assert(n.startsWith("[CONTROL INTERNO"));
  assert(n.includes("NO llames primer_turno") && n.includes("Pasame tu nombre, tu ciudad y la calle o barrio") && n.includes("112.000"), n);
  assert(notaIntencion({ frase: "quiero", cantidad: null }, null).includes("preguntalo en ese mismo mensaje"));
});
