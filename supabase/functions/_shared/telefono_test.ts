import { assertEquals } from "jsr:@std/assert@1";
import { normalizarTelefonoPY } from "./telefono.ts";

// Números de prueba ficticios (repo público): 0981000000 y variantes.
const OK = "+595981000000";

Deno.test("formatos válidos de celular PY", () => {
  for (const x of [
    "0981000000",
    "0981 000 000",
    "0981-000-000",
    "981000000",
    "+595981000000",
    "595981000000",
    "595 981 000 000",
    "+595 (981) 000-000",
    "00595981000000",
    "5950981000000",
    "+5950981000000",
    "  0981000000  ",
  ]) {
    assertEquals(normalizarTelefonoPY(x), OK, x);
  }
});

Deno.test("otros prefijos de celular", () => {
  assertEquals(normalizarTelefonoPY("0991 000 000"), "+595991000000");
  assertEquals(normalizarTelefonoPY("0971000000"), "+595971000000");
});

Deno.test("fijos, extranjeros e inválidos → null", () => {
  for (const x of [
    "021 000 000", // fijo Asunción
    "061 500 000", // fijo CDE
    "+595 21 000000",
    "+54 9 11 0000 0000", // Argentina
    "+55 45 90000 0000", // Brasil
    "0981 000 00", // corto
    "0981 000 0000", // largo
    "98100000",
    "",
    "hola",
    "+595",
  ]) {
    assertEquals(normalizarTelefonoPY(x), null, x);
  }
});
