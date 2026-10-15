import { assert, assertEquals } from "jsr:@std/assert@1";
import { esFinDeSemana, inicioDespacho, plazoPorCiudad } from "./plazo_zona.ts";

Deno.test("plazoPorCiudad: CDE, Asunción, Central y resto", () => {
  assertEquals(plazoPorCiudad("Ciudad del Este"), "hoy mismo o en 24 h");
  assertEquals(plazoPorCiudad("Minga Guazú"), "hoy mismo o en 24 h");
  assertEquals(plazoPorCiudad("Asunción"), "24 a 48 h");
  assertEquals(plazoPorCiudad("Luque centro"), "24 a 72 h");
  assertEquals(plazoPorCiudad("Lambaré"), "24 a 72 h");
  assertEquals(plazoPorCiudad("Encarnación"), null);
  assertEquals(plazoPorCiudad("Itauguá"), "24 a 72 h");
  assertEquals(plazoPorCiudad("Itapúa"), null); // "ita" solo cuenta como palabra entera
  assertEquals(plazoPorCiudad(""), null);
  // 12-10: Thompson y Loma Pytã (Lucero 24-48 h) ya no caen en "resto del país".
  assertEquals(plazoPorCiudad("Thompson"), "24 a 72 h");
  assertEquals(plazoPorCiudad("Loma Pytã"), "24 a 72 h");
});

Deno.test("inicioDespacho: sábado y domingo (hora de Asunción) → lunes 8:00; día hábil antes de las 15:00, igual", () => {
  assertEquals(inicioDespacho(new Date("2026-10-10T15:00:00Z")).toISOString(), "2026-10-12T11:00:00.000Z"); // sábado
  assertEquals(inicioDespacho(new Date("2026-10-11T23:00:00Z")).toISOString(), "2026-10-12T11:00:00.000Z"); // domingo 20 h
  // 12-10: viernes 23 h ya pasó el corte de las 15:00 → lunes 8:00 (antes devolvía el mismo instante).
  assertEquals(inicioDespacho(new Date("2026-10-10T02:00:00Z")).toISOString(), "2026-10-12T11:00:00.000Z");
  assertEquals(esFinDeSemana(new Date("2026-10-09T15:00:00Z")), false);
  assertEquals(esFinDeSemana(new Date("2026-10-10T02:00:00Z")), false); // viernes 23 h: pasó el corte, pero no es fin de semana
  assertEquals(esFinDeSemana(new Date("2026-10-10T15:00:00Z")), true);
});

Deno.test("12-10 corte 15:00: antes sale hoy; desde las 15:00 el próximo día hábil; viernes tarde, sábado y domingo → lunes", async () => {
  const { diaDespacho, fechaLocal } = await import("./plazo_zona.ts");
  const casos = [
    ["2026-10-12T17:59:00Z", "2026-10-12T17:59:00.000Z", "2026-10-12"], // lunes 14:59 → hoy (mismo instante)
    ["2026-10-12T18:00:00Z", "2026-10-13T11:00:00.000Z", "2026-10-13"], // lunes 15:00 → martes 8:00
    ["2026-10-13T19:30:00Z", "2026-10-14T11:00:00.000Z", "2026-10-14"], // martes 16:30 → miércoles
    ["2026-10-13T02:59:00Z", "2026-10-13T11:00:00.000Z", "2026-10-13"], // lunes 23:59 → martes
    ["2026-10-16T17:59:00Z", "2026-10-16T17:59:00.000Z", "2026-10-16"], // viernes 14:59 → hoy
    ["2026-10-16T18:30:00Z", "2026-10-19T11:00:00.000Z", "2026-10-19"], // viernes 15:30 → lunes
    ["2026-10-17T15:00:00Z", "2026-10-19T11:00:00.000Z", "2026-10-19"], // sábado
    ["2026-10-18T13:00:00Z", "2026-10-19T11:00:00.000Z", "2026-10-19"], // domingo 10:00
    ["2026-10-19T02:30:00Z", "2026-10-19T11:00:00.000Z", "2026-10-19"], // domingo 23:30
    ["2026-10-19T03:30:00Z", "2026-10-19T03:30:00.000Z", "2026-10-19"], // lunes 00:30 → hoy
  ] as const;
  for (const [iso, inicio, dia] of casos) {
    assertEquals(inicioDespacho(new Date(iso)).toISOString(), inicio, iso);
    assertEquals(fechaLocal(diaDespacho(new Date(iso))), dia, iso);
  }
});

Deno.test("plazos desde hoy: sábado, viernes y martes (sin entregas sábado/domingo)", async () => {
  const { diasHastaEntrega, textoDias, lineaPlazosHoy } = await import("./plazo_zona.ts");
  const sab = new Date("2026-10-10T15:00:00Z"); // sábado 12:00 Asunción
  assertEquals(diasHastaEntrega("cde", sab), [2, 3]);        // lunes o martes
  assertEquals(diasHastaEntrega("asuncion", sab), [3, 4]);   // martes o miércoles (rango por zona, sin courier)
  assertEquals(diasHastaEntrega("interior", sab), [4, 9]);   // lunes + 2 a 5 hábiles = miércoles a lunes siguiente
  const vie = new Date("2026-10-09T15:00:00Z"); // viernes
  assertEquals(diasHastaEntrega("cde", vie), [0, 3]);        // hoy o lunes
  assertEquals(diasHastaEntrega("asuncion", vie), [3, 4]);   // lunes o martes
  const mar = new Date("2026-10-13T15:00:00Z"); // martes
  assertEquals(textoDias(diasHastaEntrega("cde", mar)), "hoy o mañana");
  assertEquals(textoDias(diasHastaEntrega("asuncion", mar)), "mañana o pasado");
  // 12-10: después de las 15:00 el despacho pasa al día siguiente.
  const marTarde = new Date("2026-10-13T19:00:00Z"); // martes 16:00
  assertEquals(textoDias(diasHastaEntrega("cde", marTarde)), "mañana o pasado");
  // 12-10: la línea va por courier (Asunción por Lucero diaria: 1 a 2 días, decisión 12-10) y con el día concreto (antes "en 3 a 4 días").
  assert(/Asunción, San Lorenzo, [^:]*: el martes 13\/10 o el miércoles 14\/10\./.test(lineaPlazosHoy(sab)), lineaPlazosHoy(sab));
  assert(lineaPlazosHoy(sab).includes("Resto del país: en 2 a 5 días hábiles"));
});

// ---------- 12-10: día concreto de entrega ----------
// Fechas fijas: lunes 12/10/2026, viernes 16/10, sábado 17/10, domingo 18/10 (12:00 de Asunción = 15:00 UTC).
// 12-10 (ruteo oficial): Asunción, Lambaré y San Lorenzo van por Lucero diaria (24 h) → 1 a 2 días hábiles (decisión 12-10:
// no prometer de más); Luque por Lucero frecuente (24-48 h) → dos días (antes hasta el jueves).

Deno.test("diaEntrega: lunes → CDE hoy o mañana; Asunción mañana; Luque mañana o pasado; interior 2 a 5 hábiles con fechas", async () => {
  const { diaEntrega } = await import("./plazo_zona.ts");
  const lun = new Date("2026-10-12T15:00:00Z");
  assertEquals(diaEntrega("Ciudad del Este", lun).texto, "hoy o mañana martes 13/10");
  assertEquals(diaEntrega("Asunción", lun).texto, "mañana martes 13/10 o el miércoles 14/10");
  assertEquals(diaEntrega("Luque", lun).texto, "mañana martes 13/10 o el miércoles 14/10");
  assertEquals(diaEntrega("Encarnación", lun).texto, "en 2 a 5 días hábiles (entre el miércoles 14/10 y el lunes 19/10)");
  assertEquals(diaEntrega("Encarnación", lun).zona, "interior");
  const r = diaEntrega("Asunción", lun, "lucero");
  assertEquals([r.despacho, r.desde, r.hasta, r.courier], ["2026-10-12", "2026-10-13", "2026-10-14", "lucero"]);
});

Deno.test("diaEntrega: viernes → sin sábado ni domingo (CDE hoy o el lunes; interior hasta el viernes siguiente)", async () => {
  const { diaEntrega } = await import("./plazo_zona.ts");
  const vie = new Date("2026-10-16T15:00:00Z");
  assertEquals(diaEntrega("Hernandarias", vie).texto, "hoy o el lunes 19/10");
  assertEquals(diaEntrega("Asunción", vie).texto, "el lunes 19/10 o el martes 20/10");
  assertEquals(diaEntrega("Capiatá", vie).texto, "entre el lunes 19/10 y el miércoles 21/10");
  assertEquals(diaEntrega("Coronel Oviedo", vie).texto, "en 2 a 5 días hábiles (entre el martes 20/10 y el viernes 23/10)");
});

Deno.test("diaEntrega: sábado y domingo → se despacha el lunes (nunca dice 'sale el lunes')", async () => {
  const { diaEntrega } = await import("./plazo_zona.ts");
  const sab = new Date("2026-10-17T15:00:00Z");
  assertEquals(diaEntrega("Minga Guazú", sab).texto, "el lunes 19/10 o el martes 20/10");
  assertEquals(diaEntrega("Asunción", sab).texto, "el martes 20/10 o el miércoles 21/10");
  assertEquals(diaEntrega("San Lorenzo", sab).texto, "el martes 20/10 o el miércoles 21/10");
  assertEquals(diaEntrega("Encarnación", sab).texto, "en 2 a 5 días hábiles (entre el miércoles 21/10 y el lunes 26/10)");
  for (const dom of [new Date("2026-10-18T15:00:00Z"), new Date("2026-10-19T02:30:00Z")]) { // domingo 12:00 y 23:30 en Asunción
    assertEquals(diaEntrega("Ciudad del Este", dom).texto, "mañana lunes 19/10 o el martes 20/10");
    assertEquals(diaEntrega("Asunción", dom).texto, "el martes 20/10 o el miércoles 21/10");
    assertEquals(diaEntrega("Lambaré", dom).texto, "el martes 20/10 o el miércoles 21/10");
    assertEquals(diaEntrega("Pedro Juan Caballero", dom).despacho, "2026-10-19");
  }
  for (const t of ["2026-10-17T15:00:00Z", "2026-10-18T15:00:00Z"]) assert(!/sale/.test(diaEntrega("Asunción", new Date(t)).texto));
});

Deno.test("12-10 matriz: ciudad × momento (antes/después de las 15:00, viernes tarde, sábado, domingo)", async () => {
  const { diaEntrega } = await import("./plazo_zona.ts");
  const H = "en 2 a 5 días hábiles";
  const momentos = {
    "lunes 14:59": "2026-10-12T17:59:00Z",
    "lunes 15:00": "2026-10-12T18:00:00Z",
    "viernes 15:30": "2026-10-16T18:30:00Z",
    "sábado 12:00": "2026-10-17T15:00:00Z",
    "domingo 23:30": "2026-10-19T02:30:00Z",
  } as const;
  const esperado: Record<string, Record<keyof typeof momentos, string>> = {
    "Ciudad del Este": {
      "lunes 14:59": "hoy o mañana martes 13/10",
      "lunes 15:00": "mañana martes 13/10 o el miércoles 14/10",
      "viernes 15:30": "el lunes 19/10 o el martes 20/10",
      "sábado 12:00": "el lunes 19/10 o el martes 20/10",
      "domingo 23:30": "mañana lunes 19/10 o el martes 20/10",
    },
    "Asunción": { // Lucero diaria
      "lunes 14:59": "mañana martes 13/10 o el miércoles 14/10",
      "lunes 15:00": "el miércoles 14/10 o el jueves 15/10",
      "viernes 15:30": "el martes 20/10 o el miércoles 21/10",
      "sábado 12:00": "el martes 20/10 o el miércoles 21/10",
      "domingo 23:30": "el martes 20/10 o el miércoles 21/10",
    },
    "Capiatá": { // PaP (ruteo oficial 09-10), zona Central de PaP
      "lunes 14:59": "entre mañana martes 13/10 y el jueves 15/10",
      "lunes 15:00": "entre el miércoles 14/10 y el viernes 16/10",
      "viernes 15:30": "entre el martes 20/10 y el jueves 22/10",
      "sábado 12:00": "entre el martes 20/10 y el jueves 22/10",
      "domingo 23:30": "entre el martes 20/10 y el jueves 22/10",
    },
    "Itá": { // Lucero programada (1-2 viajes por semana): mismo rango y texto que el interior
      "lunes 14:59": `${H} (entre el miércoles 14/10 y el lunes 19/10)`,
      "lunes 15:00": `${H} (entre el jueves 15/10 y el martes 20/10)`,
      "viernes 15:30": `${H} (entre el miércoles 21/10 y el lunes 26/10)`,
      "sábado 12:00": `${H} (entre el miércoles 21/10 y el lunes 26/10)`,
      "domingo 23:30": `${H} (entre el miércoles 21/10 y el lunes 26/10)`,
    },
    "Fernando de la Mora": { // Lucero frecuente
      "lunes 14:59": "mañana martes 13/10 o el miércoles 14/10",
      "lunes 15:00": "el miércoles 14/10 o el jueves 15/10",
      "viernes 15:30": "el martes 20/10 o el miércoles 21/10",
      "sábado 12:00": "el martes 20/10 o el miércoles 21/10",
      "domingo 23:30": "el martes 20/10 o el miércoles 21/10",
    },
    "Encarnación": { // interior: siempre "2 a 5 días hábiles"
      "lunes 14:59": `${H} (entre el miércoles 14/10 y el lunes 19/10)`,
      "lunes 15:00": `${H} (entre el jueves 15/10 y el martes 20/10)`,
      "viernes 15:30": `${H} (entre el miércoles 21/10 y el lunes 26/10)`,
      "sábado 12:00": `${H} (entre el miércoles 21/10 y el lunes 26/10)`,
      "domingo 23:30": `${H} (entre el miércoles 21/10 y el lunes 26/10)`,
    },
  };
  for (const [ciudad, porMomento] of Object.entries(esperado)) {
    for (const [momento, texto] of Object.entries(porMomento)) {
      const r = diaEntrega(ciudad, new Date(momentos[momento as keyof typeof momentos]));
      assertEquals(r.texto, texto, `${ciudad} · ${momento}`);
      // Nunca una hora ni "sale el lunes".
      assert(!/\d{1,2}:\d{2}|\d\s*h(s|oras?)?\b|\bsale\b|despach/i.test(r.texto), r.texto);
    }
  }
});

Deno.test("12-10 rangoEntrega: courier del ruteo oficial + velocidad (y courier dado, si viene)", async () => {
  const { rangoEntrega } = await import("./plazo_zona.ts");
  const r = (c: string, courier?: string | null) => {
    const x = rangoEntrega(c, courier);
    return [x.courier, x.fuente, x.rango, x.habiles];
  };
  assertEquals(r("Ciudad del Este"), ["lucero", "CDE y alrededores", [0, 1], false]);
  assertEquals(r("Presidente Franco"), ["lucero", "CDE y alrededores", [0, 1], false]);
  assertEquals(r("Asunción"), ["lucero", "lucero diaria", [1, 2], false]);
  assertEquals(r("Fernando de la Mora"), ["lucero", "lucero frecuente", [1, 2], false]); // a Lucero desde el 09-10
  assertEquals(r("Itá"), ["lucero", "lucero programada", [2, 5], true]); // Itá sigue con Lucero
  for (const c of ["Capiatá", "Limpio", "Ñemby", "Areguá", "Itauguá"]) assertEquals(r(c), ["pap", "pap central", [1, 3], false], c);
  for (const c of ["Ypané", "J. Augusto Saldívar"]) assertEquals(r(c), ["pap", "pap interior1", [1, 4], false], c);
  assertEquals(r("Thompson"), ["lucero", "lucero frecuente", [1, 2], false]);
  assertEquals(r("Encarnación"), ["lucero", "interior", [2, 5], true]);
  assertEquals(r("Villarrica"), ["pap", "interior", [2, 5], true]);
  // Texto con signos: el ruteo lo reconoce igual.
  assertEquals(r("Asunción, barrio Sajonia"), ["lucero", "lucero diaria", [1, 2], false]);
  assertEquals(r("luque centro"), ["lucero", "lucero frecuente", [1, 2], false]);
  // Ciudad que el ruteo no conoce → reglas por zona de siempre.
  assertEquals(r("Central"), [null, "zona central", [1, 3], false]);
  assertEquals(r("Pueblo Inventado"), [null, "interior", [2, 5], true]);
  assertEquals(r(""), [null, "interior", [2, 5], true]);
  assertEquals(r(undefined as unknown as string), [null, "interior", [2, 5], true]);
  // Courier dado (el del pedido) manda sobre el ruteo; "otra" → por zona; CDE siempre hoy o mañana.
  assertEquals(r("Capiatá", "lucero"), ["lucero", "lucero programada", [2, 5], true]);
  assertEquals(r("Asunción", "PAP"), ["pap", "pap gran_asuncion", [1, 2], false]);
  assertEquals(r("Asunción", "Otra"), ["otra", "zona asuncion", [1, 2], false]);
  assertEquals(r("Ciudad del Este", "pap"), ["pap", "CDE y alrededores", [0, 1], false]);
  assertEquals(r("Capiatá", ""), ["pap", "pap central", [1, 3], false]); // vacío = no vino → ruteo oficial
});

Deno.test("12-10 idCourier y courierOficial (lista oficial, no la preferencia de lluvia del 12-10)", async () => {
  const { courierOficial, idCourier } = await import("./plazo_zona.ts");
  assertEquals(["lucero", "Lucero del Este", "LUCERO", "pap", "PAP", "Punto a Punto", "otra", "DHL", "", null, undefined].map(idCourier),
    ["lucero", "lucero", "lucero", "pap", "pap", "pap", "otra", "otra", null, null, null]);
  // sugerirTransportadora el 12-10 manda Capiatá por Lucero (lluvia); la promesa usa la lista oficial: PaP.
  assertEquals(courierOficial("Capiatá"), "pap");
  assertEquals(courierOficial("Itá"), "lucero");
  assertEquals(courierOficial("Fernando de la Mora"), "lucero");
  assertEquals(courierOficial("Pueblo Inventado"), null);
});

Deno.test("12-10 coherencia: vendedor (PLAZOS DESDE HOY), resumen (diaEntrega) y plantillas ({plazo}) dicen lo mismo, todo el día, dos semanas", async () => {
  const { diaEntrega, fechaLocal, lineaPlazosHoy, plazoDesdeHoy, plazoParaEn, plazoParaEnDesdeHoy, textoDias, diasHastaEntrega } =
    await import("./plazo_zona.ts");
  const enLinea = ["Ciudad del Este", "Asunción", "San Lorenzo", "Luque", "Capiatá", "Lambaré", "Fernando de la Mora", "Limpio", "Ñemby",
    "Mariano Roque Alonso", "Villa Elisa", "Itauguá", "Areguá", "San Antonio", "Itá", "Villeta", "Guarambaré", "Ypané",
    "J. Augusto Saldívar", "Ypacaraí", "Thompson", "Loma Pytã", "Central", "Encarnación"];
  const dias = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);
  for (let d = 10; d <= 23; d++) {
    for (const hora of ["11:00", "17:59", "18:00", "21:30", "02:30"]) { // 8:00, 14:59, 15:00, 18:30 y 23:30 del día anterior en Asunción
      const ahora = new Date(`2026-10-${String(d).padStart(2, "0")}T${hora}:00Z`);
      const linea = lineaPlazosHoy(ahora);
      for (const c of enLinea) {
        const r = diaEntrega(c, ahora);
        assert(linea.includes(`: ${r.texto}.`), `${c} ${ahora.toISOString()}: "${r.texto}" no está en la línea`);
        const hoy = fechaLocal(ahora);
        const rango: [number, number] = [dias(hoy, r.desde), dias(hoy, r.hasta)];
        if (r.texto.startsWith("en 2 a 5 días hábiles")) {
          assertEquals([plazoDesdeHoy(c, ahora), plazoParaEnDesdeHoy(c, ahora)], ["en 2 a 5 días hábiles", "2 a 5 días hábiles"], c);
        } else {
          assertEquals(plazoDesdeHoy(c, ahora), textoDias(rango), `${c} ${ahora.toISOString()}`);
          assertEquals(plazoParaEnDesdeHoy(c, ahora), plazoParaEn(rango), `${c} ${ahora.toISOString()}`);
        }
      }
      // Sin courier (ciudad fuera del ruteo) queda igual que el rango por zona de siempre.
      for (const [c, zona] of [["Ciudad del Este", "cde"], ["Central", "central"], ["Encarnación", "interior"]] as const) {
        const r = diaEntrega(c, ahora);
        const [a, b] = diasHastaEntrega(zona, ahora);
        const mas = (n: number) => fechaLocal(new Date(ahora.getTime() + n * 86_400_000));
        assertEquals([r.desde, r.hasta], [mas(a), mas(b)], `${c} ${ahora.toISOString()}`);
      }
    }
  }
  // Con el courier del pedido (wa-webhook), {plazo} y {dia} también coinciden.
  const lun = new Date("2026-10-12T15:00:00Z");
  assertEquals([plazoParaEnDesdeHoy("Capiatá", lun, "lucero"), diaEntrega("Capiatá", lun, "lucero").texto],
    ["2 a 5 días hábiles", "en 2 a 5 días hábiles (entre el miércoles 14/10 y el lunes 19/10)"]);
  assertEquals([plazoParaEnDesdeHoy("Capiatá", lun), diaEntrega("Capiatá", lun).texto], ["1 a 3 días", "entre mañana martes 13/10 y el jueves 15/10"]);
});

Deno.test("visperaEntrega: 18:00 del día de despacho con el próximo día hábil; viernes → el lunes; sábado → lunes 18:00", async () => {
  const { visperaEntrega } = await import("./plazo_zona.ts");
  const v = (iso: string) => {
    const r = visperaEntrega(new Date(iso));
    return [r.enviar.toISOString(), r.entrega, r.dia];
  };
  assertEquals(v("2026-10-12T13:00:00Z"), ["2026-10-12T21:00:00.000Z", "2026-10-13", "mañana martes 13/10"]); // lunes 10:00
  assertEquals(v("2026-10-16T13:00:00Z"), ["2026-10-16T21:00:00.000Z", "2026-10-19", "el lunes 19/10"]); // viernes 10:00
  assertEquals(v("2026-10-17T15:00:00Z"), ["2026-10-19T21:00:00.000Z", "2026-10-20", "mañana martes 20/10"]); // sábado
  // 12-10 corte 15:00: lunes 19:10 ya despacha el martes → aviso martes 18:00 por el miércoles (antes: lunes 19:10 por el martes).
  assertEquals(v("2026-10-12T22:10:00Z"), ["2026-10-13T21:00:00.000Z", "2026-10-14", "mañana miércoles 14/10"]);
  assertEquals(v("2026-10-12T17:59:00Z"), ["2026-10-12T21:00:00.000Z", "2026-10-13", "mañana martes 13/10"]); // lunes 14:59
  assertEquals(v("2026-10-16T18:30:00Z"), ["2026-10-19T21:00:00.000Z", "2026-10-20", "mañana martes 20/10"]); // viernes 15:30
});

Deno.test("alas8HabilDespues con inicioDespacho: el corte de las 15:00 corre el aviso un día hábil", async () => {
  const { alas8HabilDespues } = await import("./plazo_zona.ts");
  const a8 = (iso: string, n: number) => alas8HabilDespues(inicioDespacho(new Date(iso)), n).toISOString();
  assertEquals(a8("2026-10-12T17:59:00Z", 1), "2026-10-13T11:00:00.000Z"); // lunes 14:59 → martes 8:00
  assertEquals(a8("2026-10-12T18:00:00Z", 1), "2026-10-14T11:00:00.000Z"); // lunes 15:00 → despacho martes → miércoles 8:00
  assertEquals(a8("2026-10-16T18:30:00Z", 1), "2026-10-20T11:00:00.000Z"); // viernes 15:30 → despacho lunes → martes 8:00
  assertEquals(a8("2026-10-16T18:30:00Z", 2), "2026-10-21T11:00:00.000Z");
});

// ---------- 13-10: entrega programada ----------

Deno.test("13-10 fechaMinimaEntrega: primer día del rango, con el corte de las 15:00 y sin sábado ni domingo", async () => {
  const { fechaMinimaEntrega } = await import("./plazo_zona.ts");
  const lunes10 = new Date("2026-10-12T13:00:00Z"); // lunes 10:00 en Asunción
  const lunes16 = new Date("2026-10-12T19:00:00Z"); // lunes 16:00: pasó el corte
  const viernes16 = new Date("2026-10-16T19:00:00Z"); // viernes 16:00: sale el lunes
  assertEquals([fechaMinimaEntrega("Ciudad del Este", lunes10), fechaMinimaEntrega("Ciudad del Este", lunes16)], ["2026-10-12", "2026-10-13"]);
  assertEquals([fechaMinimaEntrega("Asunción", lunes10, "pap"), fechaMinimaEntrega("Asunción", lunes16, "lucero")], ["2026-10-13", "2026-10-14"]);
  assertEquals(fechaMinimaEntrega("Encarnación", lunes10), "2026-10-14");
  assertEquals([fechaMinimaEntrega("Ciudad del Este", viernes16), fechaMinimaEntrega("Asunción", viernes16)], ["2026-10-19", "2026-10-20"]);
  // El caso real: CDE confirmado el lunes, pide el viernes 16/10 → válido (≥ mínima).
  assert("2026-10-16" >= fechaMinimaEntrega("Ciudad del Este", lunes10));
});

Deno.test("13-10 diaDespachoParaEntrega: fecha menos el tránsito MÁXIMO del courier (CDE el mismo día), nunca antes de hoy", async () => {
  const { diaDespachoParaEntrega } = await import("./plazo_zona.ts");
  const lunes = new Date("2026-10-12T13:00:00Z");
  assertEquals(diaDespachoParaEntrega("2026-10-16", "Ciudad del Este", null, lunes), "2026-10-16");
  assertEquals(diaDespachoParaEntrega("2026-10-16", "Asunción", "pap", lunes), "2026-10-14"); // [1, 2] → 2 hábiles antes
  assertEquals(diaDespachoParaEntrega("2026-10-19", "Asunción", "lucero", lunes), "2026-10-15"); // lunes → jueves (sin finde)
  assertEquals(diaDespachoParaEntrega("2026-10-16", "Encarnación", null, lunes), "2026-10-12"); // [2, 5] → antes de hoy → hoy
});

Deno.test("13-10 textoFecha, textoEntregaProgramada y habilAnterior", async () => {
  const { habilAnterior, textoEntregaProgramada, textoFecha, alas8DeFecha } = await import("./plazo_zona.ts");
  assertEquals(textoFecha("2026-10-16"), "viernes 16/10");
  assertEquals(textoEntregaProgramada({ fecha: "2026-10-16", franja: "antes de las 12" }), "el viernes 16/10, antes de las 12");
  assertEquals(textoEntregaProgramada({ fecha: "2026-10-19", franja: null }), "el lunes 19/10");
  assertEquals([habilAnterior("2026-10-16"), habilAnterior("2026-10-19")], ["2026-10-15", "2026-10-16"]);
  assertEquals(alas8DeFecha("2026-10-16").toISOString(), "2026-10-16T11:00:00.000Z");
});

Deno.test("13-10 leerEntregaProgramada: REST (note_attributes) y GraphQL (customAttributes); fecha inválida o sin atributo → null", async () => {
  const { leerEntregaProgramada } = await import("./plazo_zona.ts");
  assertEquals(
    leerEntregaProgramada({ tags: "CONFIRMADO, ENTREGA_PROGRAMADA", note_attributes: [{ name: "entrega_programada", value: "2026-10-16" }, { name: "entrega_franja", value: "  antes de   las 12 " }] }),
    { fecha: "2026-10-16", franja: "antes de las 12" },
  );
  assertEquals(leerEntregaProgramada({ customAttributes: [{ key: "entrega_programada", value: "2026-10-19" }] }), { fecha: "2026-10-19", franja: null });
  assertEquals(leerEntregaProgramada({ tags: "ENTREGA_PROGRAMADA", note_attributes: [] }), null); // tag sin fecha
  assertEquals(leerEntregaProgramada({ note_attributes: [{ name: "entrega_programada", value: "2026-02-30" }] }), null);
  assertEquals(leerEntregaProgramada({ note_attributes: [{ name: "entrega_programada", value: "viernes" }] }), null);
  assertEquals([leerEntregaProgramada(null), leerEntregaProgramada({})], [null, null]);
});
