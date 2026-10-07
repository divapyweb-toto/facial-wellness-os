import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { contarEmojis, extraerMontos, montosDeResultado, revisarRespuesta } from "./filtro_salida.ts";

const PROHIBIDAS = ["garantía", "devolución", "reembolso", "sin riesgo", "cura", "curar", "tratamiento", "oxígeno"];
const CATALOGO = [79000, 33000, 112000, 125000, 158000];
const op = { catalogo: CATALOGO, prohibidas: PROHIBIDAS, afirmaciones: ["Pagás al recibir"] };

Deno.test("filtro: respuesta correcta pasa (precio, envío y total del catálogo)", () => {
  const r = revisarRespuesta("Las tiras salen Gs 79.000 + envío Gs 33.000 = Gs 112.000, pagás al recibir. ¿Te las preparo?", op);
  assertEquals(r, { ok: true, motivos: [] });
});

for (const [texto, palabra] of [
  ["Tiene garantía de 30 días, ¿te lo mando?", "garantía"],
  ["Si no te gusta hay devolución sin problema.", "devolución"],
  ["Te hacemos el reembolso si no funciona.", "reembolso"],
  ["Es una compra sin riesgo, pagás al recibir.", "sin riesgo"],
  ["Esto te cura el ronquido.", "cura"],
  ["No hay devoluciones, pero podés probarlo.", "devolución"],
] as const) {
  Deno.test(`filtro: bloquea "${palabra}"`, () => {
    const r = revisarRespuesta(texto, op);
    assertFalse(r.ok);
    assert(r.motivos.includes(`palabra_prohibida:${palabra}`), r.motivos.join());
  });
}

Deno.test("filtro: precio inventado con puntos, sin puntos, con Gs y en 'mil' se bloquea", () => {
  for (const t of ["Sale 70.000", "Sale 70000", "Sale Gs 70000", "Sale ₲70.000", "Te sale 70 mil nomás", "Son 70k"]) {
    const r = revisarRespuesta(t, op);
    assertFalse(r.ok, t);
    assert(r.motivos.some((m) => m.startsWith("precio_no_catalogo:70000")), `${t}: ${r.motivos}`);
  }
});

Deno.test("filtro: precio del catálogo escrito sin puntos o en 'mil' pasa", () => {
  assert(revisarRespuesta("Sale 79000, pagás al recibir.", op).ok);
  assert(revisarRespuesta("Sale 79 mil + 33 mil de envío.", op).ok);
  assert(revisarRespuesta("El de 2 sale 125,000.", op).ok);
});

Deno.test("filtro: teléfonos, años, horas, fechas, cantidades y pedidos no cuentan como precio", () => {
  assertEquals(extraerMontos("Escribime al 0981 000 000 o +595981000000"), []);
  assertEquals(extraerMontos("Llega el sábado 10/10/2026 a las 15:30"), []);
  assertEquals(extraerMontos("Tu pedido #1050 de 30 unidades x2"), []);
  assertEquals(extraerMontos("En 2026 lanzamos más productos"), []);
  assertEquals(extraerMontos("El ×3 155.000"), [155000]);
});

Deno.test("filtro: más de 3 líneas, más de 1 pregunta, más de 1 emoji", () => {
  const r1 = revisarRespuesta("Hola\nSale Gs 79.000\nEnvío Gs 33.000\nTotal Gs 112.000", op);
  assert(r1.motivos.some((m) => m.startsWith("mas_de_3_lineas")));
  const r2 = revisarRespuesta("¿Para vos? ¿Te lo mando?", op);
  assert(r2.motivos.some((m) => m.startsWith("mas_de_1_pregunta")));
  const r3 = revisarRespuesta("¡Dale! 😊🙌", op);
  assert(r3.motivos.some((m) => m.startsWith("mas_de_1_emoji")));
  assertEquals(contarEmojis("Listo 👍"), 1);
});

Deno.test("filtro: promesas de salud se bloquean; 'consultalo con tu médico' no", () => {
  const r = revisarRespuesta("Con esto dejás de roncar desde la primera noche.", op);
  assert(r.motivos.some((m) => m.startsWith("promesa_salud")));
  assert(revisarRespuesta("Eso te conviene consultarlo con tu médico. Te paso con Enrique.", op).ok);
});

Deno.test("filtro: respuesta vacía no pasa", () => {
  assertEquals(revisarRespuesta("   ", op), { ok: false, motivos: ["respuesta_vacia"] });
});

Deno.test("montosDeResultado junta números y montos escritos del resultado de una herramienta", () => {
  const m = montosDeResultado({ productos: [{ precio: 79000, total_texto: "112.000", ofertas: [{ precio: 125000 }] }], envio: 33000, cantidad: 2 });
  assertEquals(m.sort(), [112000, 125000, 33000, 79000].sort());
});
