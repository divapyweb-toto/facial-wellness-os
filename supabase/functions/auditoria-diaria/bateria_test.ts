// Tests de la batería de 50 conversaciones y del runner en modo simulado (sin red, sin procesos).
import { assert, assertEquals } from "@std/assert";
import {
  armarInforme,
  cargarCasos,
  correrBateria,
  ejecutarReferencia,
  recomendar,
  validarCaso,
} from "../../../scripts/probar-vendedor.mjs";
import { catalogoComoShopify, correrCaso, filasDeSemilla } from "../../vendedor/adaptador_vendedor.ts";
import { _configurarClaude } from "../_shared/claude.ts";

// deno-lint-ignore no-explicit-any
type Caso = any;

const { comun, casos } = cargarCasos();

Deno.test("hay 50 casos bien armados y con id único", () => {
  assertEquals(casos.length, 50);
  assertEquals(new Set(casos.map((c: Caso) => c.id)).size, 50);
  for (const c of casos) assertEquals(validarCaso(c), [], c.id);
});

Deno.test("los casos cubren todo lo pedido en el plan", () => {
  const cob = new Set(casos.flatMap((c: Caso) => c.cobertura));
  for (
    const k of [
      "compra_x1", "compra_x2", "compra_x3", "regateo", "pasame_na", "katu", "ndaje", "guau", "nde", "mbae",
      "audio_claro", "audio_confuso", "salud_promesa", "apnea", "embarazo", "medicacion", "garantia", "devolucion",
      "bot", "persona", "insultos", "denuncia", "mayorista", "injection", "producto_inexistente", "sin_telefono",
      "direccion_dudosa", "estado_pedido", "cambio_direccion", "reclamo_danado", "problema_uso", "sin_avance",
      "fuera_tema", "emojis", "mensaje_largo", "usted", "vos",
    ]
  ) assert(cob.has(k), `falta cobertura: ${k}`);
  assert(casos.filter((c: Caso) => c.cobertura.includes("injection")).length >= 5, "injection en varios estilos");
  const sinTel = casos.find((c: Caso) => c.cobertura.includes("sin_telefono"));
  assertEquals(sinTel.cliente.telefono, null);
});

Deno.test("los casos no traen datos reales (repo público)", () => {
  const texto = JSON.stringify(casos);
  const telefonos = texto.match(/\+?595\s?9\d{8}|09\d{8}/g) ?? [];
  for (const t of telefonos) assert(t.endsWith("981000000"), `teléfono que no es de prueba: ${t}`);
});

Deno.test("runner simulado: las 50 respuestas de referencia aprueban (sin red)", async () => {
  const { filas, resumen } = await correrBateria({ casos, comun, ejecutor: ejecutarReferencia });
  const malas = filas.filter((f: Caso) => !f.evaluacion.aprobado).map((f: Caso) => `${f.caso.id}: ${JSON.stringify(f.evaluacion.fallas)}`);
  assertEquals(malas, []);
  assertEquals(resumen.aprobados, 50);
  assertEquals(resumen.palabras_prohibidas, 0);
  assertEquals(resumen.precios_inventados, 0);
});

Deno.test("runner simulado: un vendedor malo reprueba los 50 y se cuentan prohibidas y precios", async () => {
  const malo = (caso: Caso) => ({
    turnos: caso.mensajes.map((entrada: string) => ({
      entrada,
      respuestas: ["Tiene garantía total y te lo dejo en Gs 50.000, ¿dale? ¿sí?"],
      herramientas: [],
    })),
  });
  const { resumen } = await correrBateria({ casos, comun, ejecutor: malo });
  assertEquals(resumen.aprobados, 0);
  assert(resumen.palabras_prohibidas >= 50);
  assert(resumen.precios_inventados >= 50);
  assert(resumen.no_deriva > 0);
});

Deno.test("runner: un vendedor que tira error no corta la batería", async () => {
  const roto = () => {
    throw new Error("se cayó");
  };
  const { resumen, filas } = await correrBateria({ casos: casos.slice(0, 3), comun, ejecutor: roto });
  assertEquals(resumen.casos, 3);
  assertEquals(resumen.aprobados, 0);
  assert(filas[0].evaluacion.fallas.some((f: Caso) => f.codigo === "error"));
});

const resumenBase = {
  casos: 50, aprobados: 50, palabras_prohibidas: 0, precios_inventados: 0, promesas_salud: 0, revela_instrucciones: 0,
  no_deriva: 0, tono_promedio: 4.4, tono_evaluados: 50, costo_total_usd: 1.5, costo_por_conversacion_usd: 0.03,
  costo_juez_usd: 0.2, latencia_promedio_ms: 1800, latencia_max_ms: 4000,
};

Deno.test("recomendación según la regla de Enrique", () => {
  const sonnet = { ...resumenBase, tono_promedio: 4.5, costo_por_conversacion_usd: 0.08 };
  assertEquals(recomendar({ haiku: resumenBase, sonnet }).modelo, "claude-haiku-4-5");
  const conProhibida = recomendar({ haiku: { ...resumenBase, palabras_prohibidas: 1 }, sonnet });
  assertEquals(conProhibida.modelo, "claude-sonnet-5-5");
  assert(conProhibida.texto.includes("USD 45"));
  assert(conProhibida.texto.includes("562"), conProhibida.texto); // 45 / 0,08
  assertEquals(recomendar({ haiku: { ...resumenBase, precios_inventados: 2 }, sonnet }).modelo, "claude-sonnet-5-5");
  assertEquals(recomendar({ haiku: { ...resumenBase, tono_promedio: 3.9 }, sonnet }).modelo, "claude-sonnet-5-5");
  assertEquals(recomendar({ haiku: { ...resumenBase, tono_promedio: null }, sonnet }).modelo, null);
  assertEquals(recomendar({ haiku: resumenBase }).modelo, null);
});

Deno.test("informe lado a lado", async () => {
  const r = await correrBateria({ casos: casos.slice(0, 2), comun, ejecutor: ejecutarReferencia });
  const md = armarInforme({ haiku: r, sonnet: r }, { texto: "Va Haiku" }, { modo: "real", vendedor: "G1" });
  assert(md.includes("| Métrica | haiku | sonnet |"));
  assert(md.includes("Precios inventados"));
  assert(md.includes("**Recomendación:** Va Haiku"));
});

Deno.test("adaptador: catálogo del caso como productos de Shopify con ofertas por cantidad", () => {
  const { productos, ofertas } = catalogoComoShopify(comun.catalogos.base);
  const tiras = productos.find((p) => p.handle === "tiras-nasales")!;
  assertEquals(tiras.variantes[0].price, 79000);
  assertEquals(ofertas["tiras-nasales"], { "2": 125000, "3": 155000 });
  assertEquals(productos.length, 4);
});

Deno.test("adaptador: lee la semilla de config_wa (comillas dobladas incluidas)", () => {
  const f = filasDeSemilla(`insert into x values ('vendedor', '{"modelo": "m", "nota": "it''s"}'::jsonb), ('envio', '{"costo_gs": 1}'::jsonb)`);
  assertEquals(f, { vendedor: { modelo: "m", nota: "it's" }, envio: { costo_gs: 1 } });
});

Deno.test("adaptador: el vendedor de G1 corre de punta a punta con su simulador (sin red)", async () => {
  _configurarClaude({ modoSimulado: () => true, apiKey: () => undefined, precios: () => Promise.resolve(null) });
  const log = console.log;
  console.log = () => {};
  try {
    for (const id of ["01_", "16_", "34_"]) {
      const caso = casos.find((c: Caso) => c.id.startsWith(id));
      const r = await correrCaso(caso, comun, "claude-haiku-4-5", {});
      assertEquals(r.turnos.length, caso.mensajes.length);
      for (const t of r.turnos) assertEquals(t.error, undefined, `${caso.id}: ${t.error}`);
    }
    const apnea = await correrCaso(casos.find((c: Caso) => c.id.startsWith("16_")), comun, "claude-haiku-4-5", {});
    assertEquals(apnea.turnos[0].derivado, true);
  } finally {
    console.log = log;
    _configurarClaude();
  }
});
