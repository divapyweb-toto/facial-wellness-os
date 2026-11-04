// 04-11: contrato de casos para el courier, formato de Enrique (datos inventados).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { guiaDe, lineaCaso, respuestaCaso, textoParaCourier, textoTelegramCasos } from "./casos_courier.ts";

const L = { guia: "L-VT-9001", ref: "VT-9001", nombre: "Ana Prueba", ciudad: "Luque", fechaIngreso: "2026-10-30", pide: "Esperó el martes 03/11 y no le llegó; llamó al repartidor y no contesta", esperaDesde: "2026-11-03" };

Deno.test("guía: Lucero L-VT; PaP 'Guía n · VT' o solo la referencia", () => {
  assertEquals(guiaDe("lucero", "VT-9001"), "L-VT-9001");
  assertEquals(guiaDe("pap", "VT-9001", " 12345 "), "Guía 12345 · VT-9001");
  assertEquals(guiaDe("pap", "VT-9001", null), "VT-9001");
});

Deno.test("línea con el formato de Enrique", () => {
  assertEquals(lineaCaso(L), "L-VT-9001 · Ana Prueba · Luque · ingresó el 30/10. Esperó el martes 03/11 y no le llegó; llamó al repartidor y no contesta.");
  assertEquals(lineaCaso({ ...L, pide: "Pide entrega al mediodía", horario: "de 12:00 a 15:00", fechaIngreso: null }), "L-VT-9001 · Ana Prueba · Luque. Pide entrega al mediodía. Horario: de 12:00 a 15:00.");
});

Deno.test("Lucero: no encontradas agrupadas primero con la pregunta, después cada caso, cierre con pregunta", () => {
  const t = textoParaCourier("lucero", [L, { ...L, guia: "L-VT-9002", tipo: "no_encontrada", pide: "" }, { ...L, guia: "L-VT-9003", tipo: "no_encontrada", pide: "El cliente dice que nadie lo contactó" }]);
  assertEquals(t.split("\n")[0], "Buenas, les escribo de Voltra (Facial Wellness). Necesito ayuda con estos envíos, los clientes nos están reclamando:");
  assert(t.includes('1) Estos 2 en su página aparecen como "No se encontró el envío solicitado". ¿Los recibieron? ¿En qué estado están?\n- L-VT-9002'), t);
  assert(t.includes("\n\n2) L-VT-9001 · Ana Prueba"), t);
  assert(t.endsWith("¿Me confirman qué día sale cada uno? Muchas gracias."));
});

Deno.test("PaP: guía, rendiciones en su propio punto y Telegram escapado", () => {
  const t = textoParaCourier("pap", [{ ...L, guia: guiaDe("pap", "VT-9001", "26483860"), tipo: "plazo", pide: 'Ingresó y sigue "Asignado a ruta"' }], [{ ref: "VT-9010", monto: 172500, fechaEntrega: "2026-10-27" }]);
  assert(t.startsWith("Buenas, les escribo de Voltra (Facial Wellness). Consulto por estos envíos:"));
  assert(t.includes("- Guía 26483860 · VT-9001 · Ana Prueba"), t);
  assert(t.includes("2) Quedan sin rendir VT-9010 (Gs. 172.500), entregados el 27/10. ¿Cuándo los depositan?"), t);
  const tg = textoTelegramCasos("lucero", [{ ...L, recibe: "<x>" }]);
  assert(tg.includes("<b>Para Lucero</b> · 1 caso") && tg.includes("&lt;x&gt;") && tg.includes("<pre>"));
  assertEquals(respuestaCaso("lucero", true), "Listo, se lo paso a Lucero para que te contacten hoy 🙌");
});
