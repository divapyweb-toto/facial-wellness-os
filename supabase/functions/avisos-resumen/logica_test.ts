import { assert, assertEquals } from "@std/assert";
import { armarResumenAvisos, franja, LIMITE_MENSAJE } from "./logica.ts";

const f = (id: number, tipo: string, texto: string) => ({ id, tipo, texto, pedido: null, creado_en: new Date(Date.UTC(2026, 9, 27, 10, id)).toISOString() });

Deno.test("sin avisos no hay mensaje", () => {
  assertEquals(armarResumenAvisos([], {}, new Date()), []);
});

Deno.test("agrupa por tipo con título y cuenta; todos los ids quedan en algún mensaje", () => {
  const m = armarResumenAvisos([f(1, "plazo_pap", "VT-1101 vence"), f(2, "sin_despachar_24h", "3 sin despachar"), f(3, "plazo_pap", "VT-1102 vence")],
    { plazo_pap: "Plazo PaP", sin_despachar_24h: "Sin despachar +24 h" }, new Date("2026-10-27T12:00:00Z"));
  assertEquals(m.length, 1);
  assert(m[0].texto.includes("Resumen de avisos · mañana"));
  assert(m[0].texto.includes("<b>Plazo PaP</b> (2)"));
  assert(m[0].texto.indexOf("VT-1101") < m[0].texto.indexOf("VT-1102"));
  assertEquals(m[0].ids.sort(), [1, 2, 3]);
});

Deno.test("parte en varios mensajes sin pasarse del límite y sin perder avisos", () => {
  const filas = Array.from({ length: 40 }, (_, i) => f(i + 1, "plazo_pap", "x".repeat(300)));
  const m = armarResumenAvisos(filas, {}, new Date("2026-10-27T18:00:00Z"));
  assert(m.length > 1);
  assert(m.every((x) => x.texto.length <= 4096));
  assertEquals(m.flatMap((x) => x.ids).length, 40);
  assert(m[1].texto.includes("tarde") && m[1].texto.includes("parte 2"));
  assert(LIMITE_MENSAJE < 4096);
});

Deno.test("franja: 09:00 PY mañana, 15:00 PY tarde", () => {
  assertEquals(franja(new Date("2026-10-27T12:00:00Z")), "mañana");
  assertEquals(franja(new Date("2026-10-27T18:00:00Z")), "tarde");
});
