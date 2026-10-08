import { assertEquals } from "jsr:@std/assert@1";
import { nombresDeRefs } from "./logica.ts";

Deno.test("nombresDeRefs: formas de VT- → #n, sin duplicados", () => {
  assertEquals(nombresDeRefs(["VT-1003", "#VT-1003", "vt1004", " VT-01005 "]), ["#1003", "#1004", "#1005"]);
});
Deno.test("nombresDeRefs: lo que no es de Voltra o no es lista se descarta", () => {
  assertEquals(nombresDeRefs(["2071", "FW-2071", "L-VT-9", "", null, 5]), []);
  assertEquals(nombresDeRefs("VT-1"), []);
  assertEquals(nombresDeRefs(undefined), []);
});
