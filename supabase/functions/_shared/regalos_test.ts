import { assertEquals } from "@std/assert";
import { regalosDe } from "./regalos.ts";

Deno.test("regalosDe: la etiqueta en mayúsculas o minúsculas da el inhalador una sola vez", () => {
  assertEquals(regalosDe(["REGALO_INHALADOR"]).map((r) => r.titulo), ["Inhalador de menta"]);
  assertEquals(regalosDe([" regalo_inhalador ", "REGALO_INHALADOR", "PRIORIDAD"]).length, 1);
  assertEquals(regalosDe(["REGALO_INHALADOR_X", "regalo", ""]).length, 0);
  assertEquals(regalosDe([]).length, 0);
});
