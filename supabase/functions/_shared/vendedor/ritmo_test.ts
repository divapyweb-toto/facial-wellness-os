import { assert, assertEquals } from "jsr:@std/assert@1";
import { calcularDemoraMs, esNoche, partirEnBurbujas, pausaBurbujaMs, RITMO_DEFAULT } from "./ritmo.ts";

const DIA = new Date("2026-10-06T17:00:00Z"); // 14:00 Asunción
const NOCHE = new Date("2026-10-07T05:00:00Z"); // 02:00 Asunción
const R = RITMO_DEFAULT;
const demora = (cliente: string, resp: string, azar = 0.5, ahora = DIA) => calcularDemoraMs({ textoCliente: cliente, textoRespuesta: resp, ahora, ritmo: R, azar });

Deno.test("ritmo: mínimo ~4 s aunque todo sea corto y máximo ~25 s aunque sea larguísimo", () => {
  assertEquals(demora("ok", "Dale", 0), 4000);
  assertEquals(demora("x".repeat(2000), "y".repeat(2000), 0.99), 25000);
});

Deno.test("ritmo: proporcional a leer (mensaje del cliente) + escribir (respuesta)", () => {
  const corto = demora("hola", "Te llega en 2 a 5 días hábiles.");
  const leerMas = demora("hola ".repeat(30), "Te llega en 2 a 5 días hábiles.");
  const escribirMas = demora("hola", "Te llega en 2 a 5 días hábiles y pagás al recibir, sin adelantar nada. ¿Es para vos?");
  assert(leerMas > corto && escribirMas > corto, `${corto} ${leerMas} ${escribirMas}`);
  // leer tiene tope: un testamento no se lee en 2 minutos
  assertEquals(demora("x".repeat(5000), "ok"), demora("x".repeat(3000), "ok"));
});

Deno.test("ritmo: variación aleatoria acotada (±20 %) y siempre dentro de 4-25 s", () => {
  const base = demora("cuanto sale el pack?", "El pack sale con las tiras y los parches juntos. ¿Te paso el total?", 0.5);
  const bajo = demora("cuanto sale el pack?", "El pack sale con las tiras y los parches juntos. ¿Te paso el total?", 0);
  const alto = demora("cuanto sale el pack?", "El pack sale con las tiras y los parches juntos. ¿Te paso el total?", 0.999);
  assert(bajo < base && base < alto);
  assert(Math.abs(bajo / base - 0.8) < 0.01 && Math.abs(alto / base - 1.2) < 0.01, `${bajo} ${base} ${alto}`);
  for (let i = 0; i < 50; i++) {
    const d = demora("x".repeat(i * 20), "y".repeat(i * 15), Math.random());
    assert(d >= 4000 && d <= 25000, String(d));
  }
});

Deno.test("ritmo: de noche (00-07 Asunción) un poco más lento, con su propio tope, pero responde", () => {
  assert(esNoche(NOCHE, R));
  assertEquals(esNoche(DIA, R), false);
  assertEquals(esNoche(new Date("2026-10-06T10:00:00Z"), R), false); // 07:00 ya es de día
  const d = demora("cuanto sale?", "Las tiras salen con envío incluido en el total. ¿Te armo 1?", 0.5, DIA);
  const n = demora("cuanto sale?", "Las tiras salen con envío incluido en el total. ¿Te armo 1?", 0.5, NOCHE);
  assertEquals(n, Math.round(d * R.factor_noche));
  assertEquals(demora("x".repeat(2000), "y".repeat(2000), 0.99, NOCHE), R.max_noche_s * 1000);
});

Deno.test("burbujas: una línea corta va entera; una línea larga → corta en la última oración (2 burbujas)", () => {
  assertEquals(partirEnBurbujas("Dale, te paso el precio. ¿Es para vos?", 90), ["Dale, te paso el precio. ¿Es para vos?"]);
  assertEquals(
    partirEnBurbujas("Las tiras abren la nariz para que entre más aire y se ponen en segundos antes de dormir. ¿Es para vos o para regalar?", 90),
    ["Las tiras abren la nariz para que entre más aire y se ponen en segundos antes de dormir.", "¿Es para vos o para regalar?"],
  );
  const sinCorte = "x".repeat(120);
  assertEquals(partirEnBurbujas(sinCorte, 90), [sinCorte]);
  assertEquals(partirEnBurbujas("  ", 90), []);
});

Deno.test("burbujas: con saltos de línea cada línea es una burbuja (aunque sea corta), máximo 3", () => {
  assertEquals(partirEnBurbujas("Hola Ana.\n¿Es para vos?", 90), ["Hola Ana.", "¿Es para vos?"]);
  assertEquals(
    partirEnBurbujas("Las tiras abren la nariz para que entre más aire.\nTe llega en 2 a 5 días hábiles y pagás al recibir.\n¿Te armo 1?", 90),
    ["Las tiras abren la nariz para que entre más aire.", "Te llega en 2 a 5 días hábiles y pagás al recibir.", "¿Te armo 1?"],
  );
  // Líneas vacías y espacios no cuentan.
  assertEquals(partirEnBurbujas("  Dale.\n\n\n  ¿A qué ciudad?  \n", 90), ["Dale.", "¿A qué ciudad?"]);
  // Más de 3 líneas: las sobrantes van juntas en la tercera.
  assertEquals(partirEnBurbujas("a.\nb.\nc.\nd " + "x".repeat(100), 90), ["a.", "b.", "c.\nd " + "x".repeat(100)]);
  for (let n = 1; n <= 8; n++) assert(partirEnBurbujas(Array.from({ length: n }, (_, i) => `línea ${i}`).join("\n"), 90).length <= 3);
});

Deno.test("burbujas: la pausa antes de cada burbuja extra está acotada", () => {
  assertEquals(pausaBurbujaMs("¿Sí?", R, 0), R.pausa_burbuja_min_s * 1000);
  assertEquals(pausaBurbujaMs("x".repeat(1000), R, 0.9), R.pausa_burbuja_max_s * 1000);
});
