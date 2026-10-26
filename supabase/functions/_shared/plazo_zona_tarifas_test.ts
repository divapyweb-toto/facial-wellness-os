// 20-10: plazos y courier sugerido con la tabla de tarifas en memoria. Precios INVENTADOS (el repo es público).
import { assertEquals } from "jsr:@std/assert@1";
import {
  cargarTarifasCourier,
  type ClienteRpc,
  type ClienteTarifas,
  ciudadNorm,
  consultarCourierCiudad,
  courierDeLaCiudad,
  courierSugerido,
  diaEntrega,
  type FilaTarifaCourier,
  type FilaTasaCourier,
  fijarTarifasCourier,
  hayTarifasCourier,
  limpiarCourierCiudad,
  limpiarTarifasCourier,
  lineaPlazosHoy,
  plazoDesdeHoy,
  plazoParaEnDesdeHoy,
  rangoEntrega,
  REFRESCO_TARIFAS_MS,
} from "./plazo_zona.ts";

const f = (courier: string, ciudad: string, dias: [number, number] | [null, null], precio: number, cobranza = true, alias: string[] = []): FilaTarifaCourier => ({
  courier, ciudad, ciudad_nombre: ciudad, alias, zona: null, precio, tiempo: null, dias_min: dias[0], dias_max: dias[1], aplica_cobranza: cobranza, tiene_agencia: null,
});
const CDE_ALIAS = ["cuidad del este", "cde"];
const FILAS: FilaTarifaCourier[] = [
  f("lucero", "ciudad del este", [0, 1], 1000, true, CDE_ALIAS),
  f("pap", "ciudad del este", [1, 3], 900, true, CDE_ALIAS),
  // 1800 / 0,90 = 2000 y 1500 / 0,75 = 2000: empate → lucero (por nombre, como la rpc)
  f("lucero", "asuncion", [1, 2], 1800),
  f("pap", "asuncion", [1, 2], 1500),
  f("pap", "san juan nepomuceno", [3, 5], 3000, false),
  f("pap", "villarrica", [2, 4], 2000),
  f("lucero", "villarrica", [2, 5], 3000),
  f("pap", "encarnacion", [1, 3], 2000),
  f("lucero", "san lorenzo", [1, 2], 1900),
  f("pap", "san lorenzo", [1, 3], 1900),
  f("lucero", "coronel oviedo", [2, 5], 2500),
  f("pap", "fernando de la mora", [1, 2], 1500, true, ["fdo de la mora"]),
  f("pap", "la mora", [3, 5], 100), // inventada: la clave más larga contenida tiene que ganar
  f("lucero", "sin dias", [null, null], 1000),
];
const TASAS: FilaTasaCourier[] = [{ courier: "lucero", tasa_usada: "90.0", pocos_datos: false }, { courier: "pap", tasa_usada: 75, pocos_datos: true }];

/** Corre `fn` con la tabla cargada y la vacía al final (el estado del módulo es compartido entre tests). */
function conTabla(fn: () => void | Promise<void>) {
  return async () => {
    fijarTarifasCourier(FILAS, TASAS);
    try {
      await fn();
    } finally {
      limpiarTarifasCourier();
    }
  };
}

const LUNES_10 = new Date("2026-10-19T13:00:00Z"); // lunes 19/10, 10:00 de Asunción (sale hoy)

Deno.test("ciudadNorm: igual que public.ciudad_norm", () => {
  assertEquals(ciudadNorm("Cnel. Oviedo"), "coronel oviedo");
  assertEquals(ciudadNorm("Pdte. Franco"), "presidente franco");
  assertEquals(ciudadNorm("Gral. Artigas"), "general artigas");
  assertEquals(ciudadNorm("Asunción (Capital), barrio Sajonia"), "asuncion barrio sajonia");
  assertEquals(ciudadNorm("Juan E. O'Leary"), "juan e o'leary");
  assertEquals(ciudadNorm("  ÑEMBY  "), "nemby");
  assertEquals(ciudadNorm(null), "");
});

Deno.test("sin tabla: courierSugerido null y rangoEntrega exactamente igual que antes", () => {
  limpiarTarifasCourier();
  assertEquals(hayTarifasCourier(), false);
  assertEquals(courierSugerido("Asunción"), null);
  const ciudades = ["Ciudad del Este", "Asunción", "San Lorenzo", "Villarrica", "Encarnación", "Pueblo Inventado", ""];
  const antes = ciudades.flatMap((c) => [rangoEntrega(c), rangoEntrega(c, "pap"), rangoEntrega(c, "Lucero del Este")]);
  fijarTarifasCourier(FILAS, TASAS);
  limpiarTarifasCourier();
  assertEquals(ciudades.flatMap((c) => [rangoEntrega(c), rangoEntrega(c, "pap"), rangoEntrega(c, "Lucero del Este")]), antes);
});

Deno.test("courierSugerido: misma regla que la rpc sugerir_courier", conTabla(() => {
  const cde = courierSugerido("Cuidad del Este")!;
  assertEquals([cde.sugerido, cde.sin_cobertura, cde.ciudad_reconocida], ["lucero", false, true]);
  assertEquals(cde.opciones.map((o) => [o.courier, o.costo_por_entregado]), [["lucero", 1111], ["pap", 1200]]);
  // empate de costo por entregado → lucero; "barrio Sajonia" no molesta (clave contenida como palabras)
  assertEquals(courierSugerido("Asunción, barrio Sajonia")?.sugerido, "lucero");
  // PaP llega pero NO cobra: sin cobertura contra entrega, ciudad reconocida; con pago anticipado sí sirve
  const sj = courierSugerido("San Juan Nepomuceno")!;
  assertEquals([sj.sugerido, sj.sin_cobertura, sj.ciudad_reconocida, sj.opciones[0].valido], [null, true, true, false]);
  assertEquals(courierSugerido("San Juan Nepomuceno", false)?.sugerido, "pap");
  assertEquals(courierSugerido("Villarrica")?.sugerido, "pap"); // 2667 contra 3333
  const nada = courierSugerido("Pueblo Inventado")!;
  assertEquals([nada.sugerido, nada.sin_cobertura, nada.ciudad_reconocida, nada.opciones.length], [null, true, false, 0]);
  // alias contenido y clave más larga
  assertEquals(courierSugerido("barrio obrero, cde")?.sugerido, "lucero");
  assertEquals(courierSugerido("Fernando de la Mora zona norte")?.opciones[0].dias_max, 2);
  assertEquals(courierSugerido("Fdo. de la Mora")?.opciones[0].dias_max, 2);
  assertEquals(courierSugerido("Cnel. Oviedo")?.sugerido, "lucero");
  // solo palabras enteras: "asuncionero" no es "asuncion"
  assertEquals(courierSugerido("Asuncionero")?.ciudad_reconocida, false);
}));

Deno.test("rangoEntrega con tabla: courier dado, sugerido, 'otra' y ciudad desconocida", conTabla(() => {
  assertEquals(rangoEntrega("San Lorenzo", "Punto a Punto").rango, [1, 3]);
  assertEquals(rangoEntrega("San Lorenzo", "lucero").fuente, "tabla lucero san lorenzo");
  assertEquals(rangoEntrega("San Lorenzo").courier, "lucero"); // 2111 contra 2533
  assertEquals(rangoEntrega("Ciudad del Este", "pap").rango, [1, 3]); // PaP cuenta desde Asunción
  assertEquals(rangoEntrega("Ciudad del Este").rango, [0, 1]);
  // 20-10 (Enrique): el interior NO usa los días de la tabla. 26-10: por Lucero "2 a 5", por PaP "3 a 7" (courier sugerido).
  const v = rangoEntrega("Villarrica"); // sugerido PaP (2667 contra 3333)
  assertEquals([v.rango, v.zona, v.habiles, v.fuente, v.courier], [[3, 7], "interior", true, "interior · pap 3 a 7", "pap"]);
  assertEquals(rangoEntrega("Villarrica", "lucero").rango, [2, 5]); // courier dado manda
  const e = rangoEntrega("Encarnación"); // en la tabla de ejemplo solo PaP
  assertEquals([e.rango, e.habiles, e.courier], [[3, 7], true, "pap"]);
  const co = rangoEntrega("Coronel Oviedo"); // solo Lucero
  assertEquals([co.rango, co.habiles, co.fuente, co.courier], [[2, 5], true, "interior", "lucero"]);
  // Sin cobertura contra entrega y sin courier dado → no hay sugerido → el de siempre
  limpiarTarifasCourier();
  const sjBase = rangoEntrega("San Juan Nepomuceno"), otraBase = rangoEntrega("Asunción", "Aex"), sdBase = rangoEntrega("Sin Dias", "lucero");
  const pBase = rangoEntrega("Pueblo Inventado", "pap"), lpBase = rangoEntrega("Luque", "pap");
  fijarTarifasCourier(FILAS, TASAS);
  // Sin cobertura contra entrega: sale con pago anticipado por PaP (sugerido con cod = false) → "3 a 7"
  assertEquals(sjBase.rango, [2, 5]);
  assertEquals(rangoEntrega("San Juan Nepomuceno").rango, [3, 7]);
  assertEquals(rangoEntrega("San Juan Nepomuceno", "pap").rango, [3, 7]);
  assertEquals(rangoEntrega("Asunción", "Aex"), otraBase);
  assertEquals(rangoEntrega("Sin Dias", "lucero"), sdBase); // fila sin días cargados
  assertEquals(rangoEntrega("Pueblo Inventado", "pap").rango, [3, 7]); // courier dado PaP en el interior
  assertEquals(pBase.rango, [3, 7]);
  assertEquals(rangoEntrega("Pueblo Inventado").rango, [2, 5]); // sin courier conocido: el de siempre
  assertEquals(rangoEntrega("Luque", "pap"), lpBase); // la tabla de ejemplo no tiene Luque
}));

Deno.test("textos con tabla: interior por Lucero igual que sin tabla (2 a 5); por PaP 3 a 7; metro con fechas del courier", conTabla(() => {
  limpiarTarifasCourier();
  const coBase = diaEntrega("Coronel Oviedo", LUNES_10);
  fijarTarifasCourier(FILAS, TASAS);
  const co = diaEntrega("Coronel Oviedo", LUNES_10);
  assertEquals([co.desde, co.hasta, co.texto], [coBase.desde, coBase.hasta, coBase.texto]);
  assertEquals(co.texto, "en 2 a 5 días hábiles (entre el miércoles 21/10 y el lunes 26/10)");
  const d = diaEntrega("Villarrica", LUNES_10);
  assertEquals([d.desde, d.hasta, d.texto], ["2026-10-22", "2026-10-28", "en 3 a 7 días hábiles (entre el jueves 22/10 y el miércoles 28/10)"]);
  assertEquals(plazoDesdeHoy("Villarrica", LUNES_10), "en 3 a 7 días hábiles");
  assertEquals(plazoParaEnDesdeHoy("Villarrica", LUNES_10), "3 a 7 días hábiles");
  assertEquals(plazoParaEnDesdeHoy("Coronel Oviedo", LUNES_10), "2 a 5 días hábiles");
  assertEquals(diaEntrega("San Lorenzo", LUNES_10, "pap").texto, "entre mañana martes 20/10 y el jueves 22/10");
}));

Deno.test("lineaPlazosHoy: 'Otras de Central' no sale de la tabla; 26-10: interior separado en Lucero (2 a 5) y PaP (3 a 7)", () => {
  limpiarTarifasCourier();
  const sin = lineaPlazosHoy(LUNES_10);
  fijarTarifasCourier(FILAS, TASAS);
  try {
    const con = lineaPlazosHoy(LUNES_10);
    const tramo = (l: string, k: string) => l.split(". ").find((x) => x.startsWith(k));
    assertEquals(tramo(sin, "Resto del país"), "Resto del país: en 2 a 5 días hábiles (entre el miércoles 21/10 y el lunes 26/10).");
    assertEquals(tramo(con, "Resto del país"), undefined);
    // Villarrica sale por PaP (sugerido) → no está en la lista de Lucero
    assertEquals(tramo(con, "Interior con Lucero"), "Interior con Lucero del Este (coronel oviedo, sin dias): en 2 a 5 días hábiles (entre el miércoles 21/10 y el lunes 26/10)");
    assertEquals(tramo(con, "Cualquier otra ciudad del interior"),
      "Cualquier otra ciudad del interior (va por Punto a Punto): en 3 a 7 días hábiles (entre el jueves 22/10 y el miércoles 28/10).");
    assertEquals(tramo(con, "Otras ciudades de Central"), tramo(sin, "Otras ciudades de Central"));
  } finally {
    limpiarTarifasCourier();
  }
});

/** Cliente falso de Supabase: cuenta las lecturas y responde lo que se le diga. */
function clienteFalso(r: () => { filas: unknown; tasas: unknown; error?: string } | Promise<never>) {
  const llamadas: string[] = [];
  const sb: ClienteTarifas = {
    from(tabla: string) {
      return {
        select(_c: string) {
          llamadas.push(tabla);
          return (async () => {
            const x = await r();
            if (x.error) return { data: null, error: { message: x.error } };
            return { data: tabla === "tarifas_courier_vigente" ? x.filas : x.tasas, error: null };
          })();
        },
      };
    },
  };
  return { sb, llamadas };
}

Deno.test("cargarTarifasCourier: carga, no repite antes de 10 min, refresca después, junta llamadas simultáneas", async () => {
  limpiarTarifasCourier();
  try {
    const { sb, llamadas } = clienteFalso(() => ({ filas: FILAS, tasas: TASAS }));
    const [a, b] = await Promise.all([cargarTarifasCourier(sb, 1_000_000), cargarTarifasCourier(sb, 1_000_000)]);
    assertEquals([a, b, llamadas.length], [true, true, 2]); // una sola carga (2 vistas)
    assertEquals(courierSugerido("Villarrica")?.sugerido, "pap");
    assertEquals(await cargarTarifasCourier(sb, 1_000_000 + REFRESCO_TARIFAS_MS - 1), true);
    assertEquals(llamadas.length, 2);
    assertEquals(await cargarTarifasCourier(sb, 1_000_000 + REFRESCO_TARIFAS_MS), true);
    assertEquals(llamadas.length, 4);
  } finally {
    limpiarTarifasCourier();
  }
});

Deno.test("cargarTarifasCourier: si falla queda vacía (todo como antes), no lanza y reintenta al minuto", async () => {
  limpiarTarifasCourier();
  const warn = console.warn;
  console.warn = () => {};
  try {
    let falla = false;
    const { sb, llamadas } = clienteFalso(() => falla ? { filas: null, tasas: null, error: "sin red" } : { filas: FILAS, tasas: TASAS });
    assertEquals(await cargarTarifasCourier(sb, 0 + 5), true);
    falla = true;
    assertEquals(await cargarTarifasCourier(sb, 5 + REFRESCO_TARIFAS_MS), false); // refresco falla → vacía
    assertEquals(hayTarifasCourier(), false);
    assertEquals(courierSugerido("Villarrica"), null);
    const n = llamadas.length;
    assertEquals(await cargarTarifasCourier(sb, 5 + REFRESCO_TARIFAS_MS + 30_000), false); // no insiste antes del minuto
    assertEquals(llamadas.length, n);
    falla = false;
    assertEquals(await cargarTarifasCourier(sb, 5 + REFRESCO_TARIFAS_MS + 60_000), true);
    // una excepción del cliente tampoco sale
    const roto: ClienteTarifas = { from() { throw new Error("cliente roto"); } };
    limpiarTarifasCourier();
    assertEquals(await cargarTarifasCourier(roto, 10), false);
    // tabla vacía = sin tabla
    limpiarTarifasCourier();
    assertEquals(await cargarTarifasCourier(clienteFalso(() => ({ filas: [], tasas: TASAS })).sb, 10), false);
  } finally {
    console.warn = warn;
    limpiarTarifasCourier();
  }
});

// ─── 26-10: el courier sale de la rpc sugerir_courier (consultarCourierCiudad), no de una lista propia ───
/** Cliente falso de la rpc: responde según la ciudad y cuenta las llamadas. */
function rpcFalsa(resp: (ciudad: string, cod: boolean) => unknown, error?: string) {
  const llamadas: string[] = [];
  const sb: ClienteRpc = {
    rpc(fn: string, args: Record<string, unknown>) {
      llamadas.push(`${fn}:${args.p_ciudad}:${args.p_cod}`);
      return Promise.resolve(error ? { data: null, error: { message: error } } : { data: resp(String(args.p_ciudad), args.p_cod === true), error: null });
    },
  };
  return { sb, llamadas };
}

Deno.test("consultarCourierCiudad: la rpc manda sobre la copia en memoria y queda en caché 10 min", conTabla(async () => {
  limpiarCourierCiudad();
  try {
    assertEquals(rangoEntrega("Villarrica").rango, [3, 7]); // copia en memoria: PaP
    // Regla nueva de la base (Lucero donde llega con cobranza) → Lucero → 2 a 5
    const { sb, llamadas } = rpcFalsa(() => ({ sugerido: "lucero", sin_cobertura: false }));
    assertEquals(await consultarCourierCiudad(sb, "Villarrica", 1_000_000), true);
    assertEquals(llamadas, ["sugerir_courier:Villarrica:true", "sugerir_courier:Villarrica:false"]);
    assertEquals([rangoEntrega("Villarrica").rango, courierDeLaCiudad("villarrica")], [[2, 5], "lucero"]);
    assertEquals(await consultarCourierCiudad(sb, "VILLARRICA", 1_000_000 + REFRESCO_TARIFAS_MS - 1), true);
    assertEquals(llamadas.length, 2); // misma ciudad normalizada, en caché
    await consultarCourierCiudad(sb, "Villarrica", 1_000_000 + REFRESCO_TARIFAS_MS);
    assertEquals(llamadas.length, 4); // vencida: vuelve a consultar
  } finally {
    limpiarCourierCiudad();
  }
}));

Deno.test("consultarCourierCiudad: PaP → 3 a 7; sin cobertura → el de pago anticipado; falla → copia en memoria; nunca lanza", conTabla(async () => {
  limpiarCourierCiudad();
  try {
    const pap = rpcFalsa(() => ({ sugerido: "pap" }));
    await consultarCourierCiudad(pap.sb, "Coronel Oviedo", 1);
    assertEquals(rangoEntrega("Coronel Oviedo").rango, [3, 7]);
    const sinCob = rpcFalsa((_c, cod) => (cod ? { sugerido: null, sin_cobertura: true } : { sugerido: "pap" }));
    await consultarCourierCiudad(sinCob.sb, "Ayolas", 1);
    assertEquals([courierDeLaCiudad("Ayolas"), rangoEntrega("Ayolas").rango], ["pap", [3, 7]]);
    const nadie = rpcFalsa(() => ({ sugerido: null }));
    await consultarCourierCiudad(nadie.sb, "Pueblo Inventado", 1);
    assertEquals(rangoEntrega("Pueblo Inventado").rango, [2, 5]); // nadie llega: el de siempre
    const rota = rpcFalsa(() => null, "timeout");
    assertEquals(await consultarCourierCiudad(rota.sb, "Villarrica", 1), false);
    assertEquals(rangoEntrega("Villarrica").rango, [3, 7]); // sigue con la copia en memoria
    assertEquals(await consultarCourierCiudad(rota.sb, "", 1), false);
    assertEquals(rota.llamadas.length, 2); // ciudad vacía: no consulta
  } finally {
    limpiarCourierCiudad();
  }
}));

Deno.test("26-10: CDE, Asunción y Central no cambian aunque vayan por PaP", conTabla(() => {
  assertEquals(rangoEntrega("Asunción", "pap").rango, [1, 2]);
  assertEquals(rangoEntrega("Ciudad del Este", "pap").rango, [1, 3]);
  assertEquals(rangoEntrega("San Lorenzo", "pap").rango, [1, 3]);
}));
