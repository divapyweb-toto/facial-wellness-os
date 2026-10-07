// Tests de anonimizar.ts. Datos inventados (repo público): teléfonos 0981 000 xxx, nombres ficticios.
import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { anonimizar, buscarDatosCrudos, type ContextoAnon, mapaVacio } from "./anonimizar.ts";

function sinDigitosLargos(t: string): boolean {
  const sinCodigos = t.replace(/\[(?:TEL|NOMBRE|DIR|DOC|PEDIDO|EMAIL|URL)_\d+\]/g, " ");
  return !/\d(?:[\s.\-()]*\d){5,}/.test(sinCodigos);
}

Deno.test("teléfonos en todos los formatos paraguayos → mismo [TEL_1]", () => {
  const formatos = [
    "0981 000 111",
    "0981000111",
    "+595981000111",
    "+595 981 000 111",
    "981-000-111",
    "981 000 111",
    "981000111",
    "595981000111",
    "00595981000111",
    "5950981000111",
    "(0981) 000-111",
    "0981.000.111",
    "0981-000111",
    "+595 (981) 000 111",
    "0981​000​111",
  ];
  const mapa = mapaVacio();
  for (const f of formatos) {
    const r = anonimizar(`mi número es ${f}, escribime`, { mapa });
    assertEquals(r.texto, "mi número es [TEL_1], escribime", `formato ${JSON.stringify(f)} → ${r.texto}`);
  }
});

Deno.test("dos teléfonos distintos, fijo y wa.me", () => {
  const r = anonimizar("llamá al 0982 000 222 o al 021 000 333, o wa.me/595981000111 y si no al 0981000111");
  assertStringIncludes(r.texto, "[TEL_1]");
  assertStringIncludes(r.texto, "[TEL_2]");
  assertStringIncludes(r.texto, "[URL_1]");
  assertFalse(r.texto.includes("0982"));
  assertFalse(r.texto.includes("021 000"));
  assert(sinDigitosLargos(r.texto), r.texto);
});

Deno.test("una cantidad pegada al teléfono no rompe la detección", () => {
  const r = anonimizar("quiero 2 0981 000 111 es mi cel");
  assertEquals(r.texto, "quiero 2 [TEL_1] es mi cel");
});

Deno.test("nombre del cliente en distintas mayúsculas y sin acentos → mismo código", () => {
  const ctx: ContextoAnon = { nombres: ["María José Benítez", "majo_benitez92"] };
  const casos = [
    "Hola soy María José Benítez",
    "hola soy maria jose benitez",
    "HOLA SOY MARÍA JOSÉ BENÍTEZ",
    "gracias maría",
    "Benitez, María",
    "mi usuario es majo_benitez92",
  ];
  const mapa = mapaVacio();
  for (const c of casos) {
    const r = anonimizar(c, { ...ctx, mapa });
    assertFalse(/mar[ií]a|jos[eé]|ben[ií]tez|majo/i.test(r.texto), `${c} → ${r.texto}`);
    assertStringIncludes(r.texto, "[NOMBRE_");
    assertEquals(buscarDatosCrudos(r.texto, ctx), [], r.texto);
  }
  assertEquals(mapa.contadores.NOMBRE, 2); // persona del nombre + usuario (otra clave) como mucho
});

Deno.test("nombres por frase aunque no estén en el contexto", () => {
  const a = anonimizar("me llamo ramona ficticia y vivo en CDE");
  assertEquals(a.texto, "me llamo [NOMBRE_1] y vivo en CDE");
  const b = anonimizar("A nombre de Juan Inventado Prueba por favor");
  assertEquals(b.texto, "A nombre de [NOMBRE_1] por favor");
  const c = anonimizar("Nombre: Celia Supuesta\nCiudad: Luque");
  assertMatch(c.texto, /^Nombre: \[NOMBRE_1\]\nCiudad: Luque$/);
});

Deno.test("direcciones: conocida y por palabras clave", () => {
  const ctx: ContextoAnon = { direcciones: ["Calle Inventada 1234 c/ Ficticia"] };
  const r1 = anonimizar("es en calle inventada 1234 c/ ficticia, portón negro", ctx);
  assertFalse(/inventada|ficticia|1234/i.test(r1.texto), r1.texto);
  assertStringIncludes(r1.texto, "[DIR_1]");

  const r2 = anonimizar("Mi dirección es Avda. Mcal. Imaginario 555 casi Tte. Nadie. Gracias!");
  assertFalse(/imaginario|555|nadie/i.test(r2.texto), r2.texto);
  assertStringIncludes(r2.texto, "Gracias");

  const r3 = anonimizar("Barrio San Supuesto, frente a la escuela Falsa\nme llega mañana?");
  assertFalse(/supuesto|falsa/i.test(r3.texto), r3.texto);
  assertStringIncludes(r3.texto, "me llega mañana?");

  const r4 = anonimizar("km 7 lado acaray, ruta 2 km 30, entre calles Uno y Dos");
  assertFalse(/acaray|uno y dos/i.test(r4.texto), r4.texto);

  const r5 = anonimizar("te paso mi ubicación -25.5097, -54.6111 o https://maps.app.goo.gl/abc123");
  assertFalse(/25\.5097|54\.6111|goo\.gl/.test(r5.texto), r5.texto);

  // La ciudad sola se conserva (sirve para el análisis).
  assertEquals(anonimizar("soy de Ciudad del Este").texto, "soy de Ciudad del Este");
});

Deno.test("CI y RUC con y sin puntos", () => {
  const casos = [
    ["mi CI es 4.567.891", "4.567.891"],
    ["cédula: 4567891", "4567891"],
    ["C.I. N° 4 567 891", "4 567 891"],
    ["RUC 80012345-6", "80012345"],
    ["mi ruc es 4567891-2", "4567891"],
    ["factura a 1234567-8 porfa", "1234567"],
    ["documento 3.456.789", "3.456.789"],
  ];
  for (const [texto, crudo] of casos) {
    const r = anonimizar(texto);
    assertFalse(r.texto.includes(crudo), `${texto} → ${r.texto}`);
    assertStringIncludes(r.texto, "[DOC_1]");
    assert(sinDigitosLargos(r.texto), r.texto);
  }
  // Un número largo suelto sin moneda también se tapa.
  assertEquals(anonimizar("es 4567891").texto, "es [DOC_1]");
});

Deno.test("emails", () => {
  const r = anonimizar("mandame a Persona.Falsa+voltra@ejemplo.com.py o a otra_cosa@mail.test");
  assertEquals(r.texto, "mandame a [EMAIL_1] o a [EMAIL_2]");
});

Deno.test("números de pedido", () => {
  const ctx: ContextoAnon = { pedidos: ["#1042", 5600000000001] };
  const r = anonimizar("mi pedido #1042 no llegó; el 1042 era. Pedido nro 1077, orden 1088, VT-2041 y FW 3001, id 5600000000001", ctx);
  for (const crudo of ["1042", "1077", "1088", "2041", "3001", "5600000000001"]) {
    assertFalse(r.texto.includes(crudo), `${crudo} en ${r.texto}`);
  }
  assertStringIncludes(r.texto, "[PEDIDO_1]");
});

Deno.test("los precios se conservan", () => {
  const t = "Sale Gs 129.000 + envío Gs 33.000 = Gs 162.000. El x2 a 199.000 gs, el x3 249 mil, o 1.250.000 Gs";
  assertEquals(anonimizar(t).texto, t);
  assertEquals(anonimizar("el de 129.000 me sirve").texto, "el de 129.000 me sirve");
  assertEquals(anonimizar("llega en 2 a 5 días hábiles, quiero 3").texto, "llega en 2 a 5 días hábiles, quiero 3");
  assertEquals(anonimizar("el 06/10/2026 a las 10:30").texto, "el 06/10/2026 a las 10:30");
});

Deno.test("mismo dato, mismo código en toda la conversación; códigos ya puestos no se re-procesan", () => {
  const ctx: ContextoAnon = { nombres: ["Lucía Prueba"], mapa: mapaVacio() };
  const a = anonimizar("Hola Lucía, ¿tu número es 0981 000 111?", ctx);
  const b = anonimizar("Sí, Lucía Prueba, el +595981000111", ctx);
  assertEquals(a.texto, "Hola [NOMBRE_1], ¿tu número es [TEL_1]?");
  assertEquals(b.texto, "Sí, [NOMBRE_1], el [TEL_1]");
  const c = anonimizar(b.texto, ctx);
  assertEquals(c.texto, b.texto);
});

Deno.test("mensaje mezclado: nada crudo sobrevive", () => {
  const ctx: ContextoAnon = {
    nombres: ["Rosalía Ejemplar Gómez"],
    telefonos: ["0981000555"],
    direcciones: ["Avda. Ficción 999 casi Inexistente", "portón verde al lado de la despensa Imaginaria"],
    pedidos: ["#1500"],
    documentos: ["4.000.555"],
  };
  const t = "Soy ROSALIA ejemplar gomez, CI 4000555, cel 981-000-555 (o +595 981 000 555), " +
    "vivo en avda ficcion 999 casi inexistente, portón verde al lado de la despensa imaginaria. " +
    "Mi pedido #1500 dice entregado pero no me llegó. Mail rosalia.ejemplar@correo.test. " +
    "Pagué Gs 199.000";
  const r = anonimizar(t, ctx);
  assertEquals(buscarDatosCrudos(r.texto, ctx), [], r.texto);
  assert(sinDigitosLargos(r.texto.replace("199.000", "")), r.texto);
  for (const crudo of ["rosal", "ejemplar", "gomez", "4000555", "981", "ficci", "999", "inexistente", "imaginaria", "1500", "@"]) {
    assertFalse(r.texto.toLowerCase().includes(crudo), `${crudo} en ${r.texto}`);
  }
  assertStringIncludes(r.texto, "Gs 199.000");
  assertStringIncludes(r.texto, "no me llegó");
});

Deno.test("buscarDatosCrudos detecta lo que quedó", () => {
  assert(buscarDatosCrudos("mi cel 0981000111").length > 0);
  assert(buscarDatosCrudos("x@y.com").length > 0);
  assert(buscarDatosCrudos("hola Ana", { nombres: ["Ana Ficticia"] }).length > 0);
  assertEquals(buscarDatosCrudos("sale Gs 129.000, [TEL_1] y [DOC_2]"), []);
});
