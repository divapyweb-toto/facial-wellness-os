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

// 18-11: el courier ahora lee el texto directo por WhatsApp. Caso real (datos inventados): el horario salía 3 veces
// (2 frases casi iguales en "pide" + el renglón "Horario:") y la referencia podía repetirse. Va una sola vez cada cosa.
Deno.test("línea del caso: sin frases repetidas ni horario o referencia duplicados", () => {
  const base = { ...L, guia: "L-VT-9248", nombre: "Cliente Demo", ciudad: "Encarnación", fechaIngreso: "2026-11-16" };
  const pide = "Puede recibir de 8 a 12 o de 14 a 18; el sábado el local está abierto de 8 a 12. Pide que el repartidor le escriba por WhatsApp antes de la entrega. Puede recibir de 8 a 12 y de 14 a 18; sábado de 8 a 12 el local está abierto.";
  const t = lineaCaso({ ...base, pide, horario: "de 8 a 12 y de 14 a 18; sábado de 8 a 12", referencia: "Calle Demo casi Otra, Local Demo, Encarnación" });
  assertEquals(t, "L-VT-9248 · Cliente Demo · Encarnación · ingresó el 16/11. Puede recibir de 8 a 12 o de 14 a 18; el sábado el local está abierto de 8 a 12. " +
    "Pide que el repartidor le escriba por WhatsApp antes de la entrega. Referencia: Calle Demo casi Otra, Local Demo, Encarnación.");
  assertEquals((t.match(/de 14 a 18/g) ?? []).length, 1);
  // referencia ya dicha en "pide" → no se repite
  const r = lineaCaso({ ...base, pide: "Dejar en Calle Demo casi Otra, Local Demo, Encarnación.", horario: null, referencia: "Calle Demo casi Otra, Local Demo, Encarnación" });
  assertEquals((r.match(/Calle Demo/g) ?? []).length, 1);
  // horario distinto del que dice "pide" → se mantiene (es información nueva)
  const h = lineaCaso({ ...base, pide: "Puede recibir de 8 a 12.", horario: "de 15:00 a 19:00", referencia: null });
  assertEquals(h, "L-VT-9248 · Cliente Demo · Encarnación · ingresó el 16/11. Puede recibir de 8 a 12. Horario: de 15:00 a 19:00.");
});

// 19-11: el courier lee el texto al día siguiente (caso L-VT-1242: creado 18/11 20:38, salió 19/11 07:03). "hoy",
// "ayer" y "mañana" se escriben como fecha, tomando como base el día en que se creó el caso.
Deno.test("fechas absolutas: hoy/ayer/mañana pasan a fecha del día del caso; 'a la mañana' no se toca", async () => {
  const { fechasAbsolutas } = await import("./casos_courier.ts");
  const d = "2026-11-18";
  assertEquals(fechasAbsolutas("Esperaba el pedido hoy 18/11, no le llegó", d), "Esperaba el pedido el 18/11, no le llegó");
  assertEquals(fechasAbsolutas("Lo necesita hoy sin falta", d), "Lo necesita el 18/11 sin falta");
  assertEquals(fechasAbsolutas("Hoy no está en casa. Mañana sí.", d), "El 18/11 no está en casa. El 19/11 sí.");
  assertEquals(fechasAbsolutas("Le dijeron que llegaba ayer", d), "Le dijeron que llegaba el 17/11");
  assertEquals(fechasAbsolutas("Puede recibir pasado mañana", d), "Puede recibir el 20/11");
  assertEquals(fechasAbsolutas("Puede recibir a la mañana o de mañana temprano", d), "Puede recibir a la mañana o de mañana temprano");
  assertEquals(fechasAbsolutas("Hoy no", null), "Hoy no"); // sin día del caso no se adivina
  // en la línea: el pedido del cliente y el aviso de urgente, con fecha
  const t = lineaCaso({ ...L, guia: "L-VT-9242", urgente: true, esperaDesde: d, fechaIngreso: "2026-11-14", pide: "Esperaba el pedido hoy 18/11, no le llegó" });
  assertEquals(t, "L-VT-9242 · Ana Prueba · Luque · ingresó el 14/11. URGENTE: el cliente lo necesita desde el 18/11. Esperaba el pedido el 18/11, no le llegó.");
  assert(!/\bhoy\b/i.test(t));
});
