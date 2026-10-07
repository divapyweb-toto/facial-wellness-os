// Tests de probar.ts: batería de 50 con vendedores falsos y con el vendedor de G1 en modo simulado (sin red).
import { assert, assertEquals } from "@std/assert";
import type { TablaPrecios } from "../_shared/claude.ts";
import type { VersionVendedor } from "./proponer.ts";
import { type CasoBateria, cargarBateria, type Ejecutor, estimarCostoPrueba, probarVersion, type ResultadoCaso } from "./probar.ts";

const { casos, comun } = await cargarBateria();

const version: VersionVendedor = {
  numero: 2,
  estado: "propuesta",
  prompt: "Sos el vendedor de prueba de Voltra. Hablás con voseo. Glosario: {glosario}.",
  ejemplos: [{ cliente: "muy caro che", vendedor: "Te entiendo. Con 2 bolsas pagás un solo envío. ¿Te armo el de 2?" }],
  faq: [{ pregunta: "¿Llega al interior?", respuesta: "Sí, llega a todo el país y pagás al recibir." }],
  objeciones: ["caro", "no confío"],
  origen: "mejora_mensual",
};

type Ref = { texto?: string; herramientas?: { nombre: string }[]; derivar?: boolean };

/** Vendedor de referencia: las respuestas escritas en cada caso (las 50 aprueban). */
const referencia: Ejecutor = (caso) =>
  Promise.resolve({
    turnos: caso.mensajes.map((entrada, i) => {
      const r = ((caso as CasoBateria & { referencia?: Ref[] }).referencia?.[i] ?? {}) as Ref;
      return { entrada: Array.isArray(entrada) ? entrada.join("\n") : entrada, respuestas: r.texto ? [r.texto] : [], herramientas: r.herramientas ?? [], derivado: !!r.derivar, costo_usd: 0 };
    }),
  });

/** Igual a la referencia, pero en el caso `id` agrega `texto` a la primera respuesta. */
const conTexto = (id: string, texto: string): Ejecutor => async (caso, c, ctx) => {
  const r = await referencia(caso, c, ctx) as ResultadoCaso;
  if (caso.id === id) r.turnos[0].respuestas = [`${r.turnos[0].respuestas[0] ?? ""} ${texto}`.trim()];
  return r;
};

const deps = { casos, comun, semilla: {}, simulado: true, base: null };

Deno.test("la batería tiene al menos 50 casos", () => {
  assertEquals(casos.length >= 50, true);
});

Deno.test("versión limpia: aprueba todos los casos y la plantilla inyectada trae prompt + ejemplos + FAQ + objeciones", async () => {
  let plantilla = "";
  const r = await probarVersion(version, {
    ...deps,
    ejecutor: (caso, c, ctx) => {
      plantilla = ctx.plantilla;
      return referencia(caso, c, ctx);
    },
  });
  assertEquals(r.aprobada, true, r.detalle.motivo_descarte ?? "");
  assertEquals(r.casos, casos.length);
  assertEquals(r.prohibidas, 0);
  assertEquals(r.precios_fuera, 0);
  assertEquals(r.detalle.aprobados, casos.length);
  assertEquals(r.tono_prom, null); // sin juez
  assert(plantilla.startsWith(version.prompt));
  assert(plantilla.includes("¿Llega al interior?"));
  assert(plantilla.includes("Con 2 bolsas"));
  assert(plantilla.includes("caro > no confío"));
});

Deno.test("una sola palabra prohibida en toda la batería ⇒ descartada", async () => {
  const r = await probarVersion(version, { ...deps, ejecutor: conTexto("01_compra_directa_x1", "Tiene garantía.") });
  assertEquals(r.aprobada, false);
  assertEquals(r.prohibidas, 1);
  assert(r.detalle.motivo_descarte!.includes("palabra"));
});

Deno.test("un solo precio fuera de catálogo ⇒ descartada", async () => {
  const r = await probarVersion(version, { ...deps, ejecutor: conTexto("04_regateo", "Te lo dejo en Gs 60.500.") });
  assertEquals(r.aprobada, false);
  assertEquals(r.precios_fuera, 1);
});

Deno.test("propuesta con palabra prohibida en su contenido ⇒ descartada sin correr la batería", async () => {
  let corridas = 0;
  const mala: VersionVendedor = { ...version, faq: [{ pregunta: "¿Puedo devolverlo?", respuesta: "Sí, hay devolución." }] };
  const r = await probarVersion(mala, { ...deps, ejecutor: (c, cm, ctx) => (corridas++, referencia(c, cm, ctx)) });
  assertEquals(r.aprobada, false);
  assertEquals(corridas, 0);
  assertEquals(r.prohibidas, 1);
  assert(r.detalle.motivo_descarte!.includes("devolución"));
  const conPrecio: VersionVendedor = { ...version, ejemplos: [{ cliente: "cuanto", vendedor: "Sale Gs 79.000." }] };
  const r2 = await probarVersion(conPrecio, { ...deps, ejecutor: referencia });
  assertEquals(r2.aprobada, false);
  assertEquals(r2.precios_fuera, 1);
});

Deno.test("el contenido que ya estaba en la versión activa no se vuelve a revisar", async () => {
  const r = await probarVersion(version, { ...deps, base: version, ejecutor: referencia });
  assertEquals(r.detalle.estatico, { prohibidas: [], precios: [], salud: [] });
  assertEquals(r.aprobada, true);
});

Deno.test("un vendedor que tira error no aprueba y no corta la batería", async () => {
  const r = await probarVersion(version, { ...deps, casos: casos.slice(0, 3), ejecutor: () => Promise.reject(new Error("se cayó")) });
  assertEquals(r.casos, 3);
  assertEquals(r.aprobada, false);
  assertEquals(r.detalle.errores, 3);
});

Deno.test("no regresión: con minAprobados mayor a lo que aprueba ⇒ descartada", async () => {
  const r = await probarVersion(version, { ...deps, casos: casos.slice(0, 5), minAprobados: 6, ejecutor: referencia });
  assertEquals(r.aprobada, false);
  assert(r.detalle.motivo_descarte!.includes("versión activa"));
});

Deno.test("juez de tono opcional: promedio", async () => {
  let i = 0;
  const r = await probarVersion(version, {
    ...deps,
    casos: casos.slice(0, 4),
    ejecutor: referencia,
    juez: () => Promise.resolve({ puntaje: [4, 5, 4, 5][i++], costo_usd: 0.01 }),
  });
  assertEquals(r.tono_prom, 4.5);
  assertEquals(r.detalle.costo_usd, 0.04);
});

// Precios de PRUEBA para el cálculo (inventados con la forma de config_wa.precios_claude).
const PRECIOS_PRUEBA: TablaPrecios = {
  "modelo-prueba": { entrada: 1, salida: 5, cache_lectura: 0.1, cache_escritura_5m: 1.25, cache_escritura_1h: 2 },
};

Deno.test("estimación de costo y tope: si la estimación supera el tope no se corre", async () => {
  const est = estimarCostoPrueba(casos, "modelo-prueba", PRECIOS_PRUEBA)!;
  assert(est > 0 && est < 5, String(est));
  assertEquals(estimarCostoPrueba(casos, "otro", PRECIOS_PRUEBA), null);
  let corridas = 0;
  const r = await probarVersion(version, {
    ...deps,
    simulado: false,
    modelo: "modelo-prueba",
    precios: PRECIOS_PRUEBA,
    topeUsd: est / 2,
    ejecutor: (c, cm, ctx) => (corridas++, referencia(c, cm, ctx)),
  });
  assertEquals(corridas, 0);
  assertEquals(r.aprobada, false);
  assert(r.detalle.motivo_descarte!.includes("supera el tope"));
});

Deno.test("modo simulado con el vendedor real de G1 (adaptador, sin red): corre y devuelve conteos", async () => {
  const r = await probarVersion(version, { casos: casos.filter((c) => /^(01|16|34)_/.test(c.id)), comun, simulado: true, base: null });
  assertEquals(r.casos, 3);
  assertEquals(r.detalle.simulado, true);
  assertEquals(r.detalle.errores, 0, JSON.stringify(r.detalle.fallas));
  assertEquals(r.prohibidas, 0);
  assertEquals(r.precios_fuera, 0);
  assertEquals(r.detalle.costo_usd, 0);
});
