// 26-10: guardia de la oferta extra (datos inventados).
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { colaInferior, colaSuperior, evaluarGuardia, GUARDIA_DEFAULT, guardiaDe } from "./guardia_extra.ts";

const ok = { base: { si: 47, n: 516 }, ahora: { si: 22, n: 240 } }; // 9,1% → 9,2%
const entregaOk = { base: { si: 32, n: 34 }, ahora: { si: 19, n: 20 } };

Deno.test("binomial: colas conocidas", () => {
  assertAlmostEquals(colaSuperior(10, 0.5, 5), 0.623046875, 1e-9);
  assertAlmostEquals(colaInferior(10, 0.5, 4), 0.376953125, 1e-9);
  assertEquals([colaSuperior(5, 0.3, 0), colaSuperior(5, 0.3, 6), colaSuperior(5, 0, 1), colaSuperior(5, 1, 5)], [1, 0, 0, 1]);
  assert(colaSuperior(500, 0.04, 40) < 0.01);
});

Deno.test("guardia: todo igual → no apaga", () => {
  const r = evaluarGuardia({ a: ok, b: { base: { si: 1, n: 24 }, ahora: { si: 1, n: 30 } }, c: entregaOk });
  assertEquals(r.apagar, false);
  assertEquals(r.detalle.length, 3);
});

Deno.test("guardia: (b) cancelaciones suben 5+ puntos con muestra y sin azar → apaga; con muestra chica no decide", () => {
  const malo = { base: { si: 1, n: 24 }, ahora: { si: 8, n: 40 } }; // 4,2% → 20%
  const r = evaluarGuardia({ a: ok, b: malo, c: entregaOk });
  assertEquals(r.apagar, true);
  assert(r.motivos[0].startsWith("(b) cancelados tras la oferta empeoró"), r.motivos[0]);
  const chico = evaluarGuardia({ a: ok, b: { base: { si: 1, n: 24 }, ahora: { si: 2, n: 10 } }, c: entregaOk });
  assertEquals(chico.apagar, false);
  assert(chico.detalle[1].includes("muestra chica"), chico.detalle[1]);
});

Deno.test("guardia: 5 puntos que pueden ser azar no apagan (falsa alarma); con la regla literal sí", () => {
  const d = { a: ok, b: { base: { si: 1, n: 24 }, ahora: { si: 3, n: 30 } }, c: entregaOk }; // 4,2% → 10%: +5,8 puntos
  assertEquals(evaluarGuardia(d).apagar, false); // azar ~13%
  assertEquals(evaluarGuardia(d, { ...GUARDIA_DEFAULT, alfa: 1, min_b: 1 }).apagar, true);
});

Deno.test("guardia: (a) conversión y (c) entrega que BAJAN 5+ puntos apagan", () => {
  const a = evaluarGuardia({ a: { base: { si: 47, n: 516 }, ahora: { si: 5, n: 300 } }, b: { base: { si: 1, n: 24 }, ahora: { si: 0, n: 5 } }, c: entregaOk });
  assertEquals(a.motivos.length, 1);
  assert(a.motivos[0].startsWith("(a)"));
  const c = evaluarGuardia({ a: ok, b: { base: { si: 1, n: 24 }, ahora: { si: 0, n: 5 } }, c: { base: { si: 95, n: 100 }, ahora: { si: 14, n: 20 } } });
  assert(c.motivos[0].startsWith("(c)"), c.motivos.join());
});

Deno.test("guardiaDe: defaults y valores fuera de rango", () => {
  assertEquals(guardiaDe(undefined), GUARDIA_DEFAULT);
  assertEquals(guardiaDe({ puntos: 3, alfa: 2, min_b: 0, min_a: 50 }), { ...GUARDIA_DEFAULT, puntos: 3, min_a: 50 });
});

Deno.test("guardia: base con 0 cancelados no apaga por 2 cancelaciones (suavizado); 7 de 30 sí", () => {
  const b0 = { base: { si: 0, n: 24 }, ahora: { si: 2, n: 30 } }; // 0% → 6,7%
  assertEquals(evaluarGuardia({ a: ok, b: b0, c: entregaOk }).apagar, false);
  assertEquals(evaluarGuardia({ a: ok, b: { base: { si: 0, n: 24 }, ahora: { si: 7, n: 30 } }, c: entregaOk }).apagar, true);
});
