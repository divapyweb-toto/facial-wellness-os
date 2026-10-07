import { assertEquals } from "jsr:@std/assert@1";
import { contienePalabraProhibida } from "./filtro.ts";

const lista = ["garantía", "devolución", "reembolso", "sin riesgo", "cura", "curar", "tratamiento", "oxígeno"];

Deno.test("detecta con mayúsculas y tildes", () => {
  assertEquals(contienePalabraProhibida("Tiene Garantía de 30 días", lista), "garantía");
  assertEquals(contienePalabraProhibida("ACEPTAMOS DEVOLUCION", lista), "devolución");
  assertEquals(contienePalabraProhibida("garantia total", lista), "garantía");
  assertEquals(contienePalabraProhibida("Compra SIN   RIESGO", lista), "sin riesgo");
  assertEquals(contienePalabraProhibida("Te damos el reembolso.", lista), "reembolso");
  assertEquals(contienePalabraProhibida("Más OXIGENO para tu piel", lista), "oxígeno");
  assertEquals(contienePalabraProhibida("Esto cura el acné", lista), "cura");
  assertEquals(contienePalabraProhibida("un tratamiento facial", lista), "tratamiento");
});

Deno.test("plurales y derivados al inicio de palabra", () => {
  assertEquals(contienePalabraProhibida("sin garantías", lista), "garantía");
  assertEquals(contienePalabraProhibida("devoluciones gratis", lista), "devolución");
});

Deno.test("no da falsos positivos dentro de otras palabras", () => {
  assertEquals(contienePalabraProhibida("Procuramos entregar mañana", lista), null);
  assertEquals(contienePalabraProhibida("Es segura tu compra", lista), null);
  assertEquals(contienePalabraProhibida("Tu pedido #1001 sale hoy", lista), null);
});

Deno.test("entradas vacías", () => {
  assertEquals(contienePalabraProhibida("", lista), null);
  assertEquals(contienePalabraProhibida("garantía", []), null);
});
