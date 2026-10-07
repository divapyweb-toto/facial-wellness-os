// Tests de proponer.ts (puro). Datos inventados.
import { assert, assertEquals } from "@std/assert";
import {
  agregarAjuste,
  ajustesDe,
  armarPromptVersion,
  MAX_AJUSTES,
  normalizarVersion,
  proponer,
  riesgoDeTipo,
  type VersionVendedor,
} from "./proponer.ts";
import type { Conclusion, HallazgosSintesis, Sugerencia } from "./sintetizar.ts";

const activa: VersionVendedor = {
  id: "v1",
  numero: 1,
  estado: "activa",
  prompt: "Sos el vendedor de prueba. PROHIBIDO: garantía, devolución.\nGlosario: {glosario}",
  ejemplos: [],
  faq: [],
  objeciones: ["no confío", "caro"],
  origen: "semilla",
};

let k = 0;
function concl(sugerencia: Sugerencia | null, p: Partial<Conclusion> = {}): Conclusion {
  return { id: `c${++k}`, dimension: "por_objecion", clave: "caro", texto: "El pack entrega más", n: 25, tasa_entrega: 0.7, dato_debil: false, sugerencia, ...p };
}

function hallazgos(analisis: Conclusion[], p: Partial<HallazgosSintesis> = {}): HallazgosSintesis {
  return {
    mes: "2026-09-01", n_conversaciones: 150, n_clasificadas: 150, tasa_entrega_global: 0.6,
    objeciones: [], respuestas_que_mueven: [], errores_bot: [],
    reclamos: { n: 0, por_tipo: [], por_paso: {}, resueltos_sin_devolucion: 0, debio_derivar_y_no: 0 },
    conclusiones: [], costo_usd: 0.1, resumen: "", analisis, descartadas: [], modelo: "claude-sonnet-5-5",
    simulado: false, sin_datos_suficientes: false, ...p,
  };
}

const ejemplo = (vendedor: string): Sugerencia => ({ tipo: "ejemplo", detalle: "modelo", contenido: { cliente: "muy caro che", vendedor } });

Deno.test("riesgo exacto del contrato", () => {
  for (const t of ["ejemplo", "orden_objeciones", "faq", "prompt_tono"] as const) assertEquals(riesgoDeTipo(t), "bajo");
  for (const t of ["precio", "afirmacion", "palabra_prohibida", "politica_reclamos", "derivacion"] as const) {
    assertEquals(riesgoDeTipo(t), "requiere_decision");
  }
});

Deno.test("cambios de riesgo bajo entran en una versión nueva; los requiere_decision se listan y no entran", () => {
  const h = hallazgos([
    concl(ejemplo("Con 2 bolsas pagás un solo envío.\n¿Te armo el de 2?")),
    concl({ tipo: "faq", detalle: "", contenido: { pregunta: "¿Llega al interior?", respuesta: "Sí, llega a todo el país y pagás al recibir." } }),
    concl({ tipo: "orden_objeciones", detalle: "", contenido: { orden: ["caro", "no confío"] } }),
    concl({ tipo: "prompt_tono", detalle: "", contenido: { linea: "Si el cliente dice que es caro, ofrecé el pack una sola vez." } }),
    concl({ tipo: "derivacion", detalle: "", contenido: { cuando: "reclamo" } }, { dimension: "debio_derivar", clave: "reclamo" }),
  ]);
  const p = proponer(h, activa);
  assert(p.version);
  assertEquals(p.version.numero, 2);
  assertEquals(p.version.estado, "propuesta");
  assertEquals(p.version.origen, "mejora_mensual");
  assertEquals(p.version.ejemplos.length, 1);
  assertEquals(p.version.faq.length, 1);
  assertEquals(p.version.objeciones, ["caro", "no confío"]);
  assertEquals(ajustesDe(p.version.prompt), ["Si el cliente dice que es caro, ofrecé el pack una sola vez."]);
  assertEquals(p.cambios.filter((c) => c.incluido_en_version).length, 4);
  const der = p.cambios.find((c) => c.tipo === "derivacion")!;
  assertEquals(der.riesgo, "requiere_decision");
  assertEquals(der.incluido_en_version, false);
  assert(p.cambios.every((c) => c.aplicado === false));
  assertEquals(activa.ejemplos.length, 0); // la activa no se toca
  assert(p.version.notas!.includes("1 para decidir"));
});

Deno.test("propuesta con palabra prohibida ⇒ descartada (nunca se agrega)", () => {
  const p = proponer(hallazgos([
    concl({ tipo: "faq", detalle: "", contenido: { pregunta: "¿Tiene garantia?", respuesta: "Sí, tiene garantía de 30 días." } }),
    concl(ejemplo("Si no te sirve hay reembolso.")),
  ]), activa);
  assertEquals(p.version, null);
  assertEquals(p.cambios, []);
  assertEquals(p.descartados.map((d) => d.motivo), ["palabra_prohibida", "palabra_prohibida"]);
});

Deno.test("cambio de precio ⇒ requiere_decision y no aplicado (también un ejemplo que trae un monto)", () => {
  const p = proponer(hallazgos([
    concl({ tipo: "precio", detalle: "bajar el x2", contenido: { detalle: "pack de 2 más barato" } }),
    concl(ejemplo("Te queda en Gs 79.000 + envío.\n¿Te lo armo?")),
  ]), activa);
  assertEquals(p.version, null); // nada de riesgo bajo
  assertEquals(p.cambios.length, 2);
  for (const c of p.cambios) {
    assertEquals(c.tipo, "precio");
    assertEquals(c.riesgo, "requiere_decision");
    assertEquals(c.aplicado, false);
    assertEquals(c.incluido_en_version, false);
  }
});

Deno.test("datos débiles ⇒ sin propuesta", () => {
  const p = proponer(hallazgos([
    concl(ejemplo("Con 2 bolsas pagás un solo envío."), { n: 7, dato_debil: true }),
    concl({ tipo: "faq", detalle: "", contenido: { pregunta: "a", respuesta: "b" } }, { n: 9 }),
  ]), activa);
  assertEquals(p.version, null);
  assertEquals(p.cambios, []);
  assertEquals(p.descartados.map((d) => d.motivo), ["dato_debil", "dato_debil"]);
  const sinDatos = proponer(hallazgos([], { sin_datos_suficientes: true }), activa);
  assertEquals(sinDatos.version, null);
});

Deno.test("compensar o reponer (pasos 3-5 de la escalera) ⇒ politica_reclamos, decide Enrique", () => {
  const p = proponer(hallazgos([
    concl({ tipo: "prompt_tono", detalle: "", contenido: { linea: "Si llegó dañado, ofrecé reponer sin cargo." } }),
  ]), activa);
  assertEquals(p.version, null);
  assertEquals(p.cambios[0].tipo, "politica_reclamos");
  assertEquals(p.cambios[0].riesgo, "requiere_decision");
});

Deno.test("promesa de salud ⇒ descartada; ejemplo fuera de estilo ⇒ descartado", () => {
  const p = proponer(hallazgos([
    concl(ejemplo("Con las tiras vas a dejar de roncar.")),
    concl(ejemplo("¿Querés 1? ¿O 2?")),
  ]), activa);
  assertEquals(p.version, null);
  assertEquals(p.descartados.map((d) => d.motivo), ["promesa_salud", "formato"]);
});

Deno.test("sin versión activa no se propone", () => {
  assertEquals(proponer(hallazgos([concl(ejemplo("Dale."))]), null).version, null);
});

Deno.test("prompt de la versión: secciones, sin llaves nuevas, ajustes con tope", () => {
  const v: VersionVendedor = {
    ...activa,
    ejemplos: [{ cliente: "hola {x}", vendedor: "Hola, ¿qué buscás?" }],
    faq: [{ pregunta: "¿Llega?", respuesta: "Sí." }],
  };
  const t = armarPromptVersion(v);
  assert(t.includes("{glosario}")); // las llaves del vendedor siguen
  assert(!t.includes("{x}"));
  assert(t.includes("PREGUNTAS FRECUENTES"));
  assert(t.includes("EJEMPLOS DE ESTILO"));
  assert(t.includes("ORDEN DE OBJECIONES"));
  let p = activa.prompt;
  for (let i = 0; i < MAX_AJUSTES + 3; i++) p = agregarAjuste(p, `regla ${i}`);
  p = agregarAjuste(p, `regla ${MAX_AJUSTES + 2}`); // repetida: no se duplica
  assertEquals(ajustesDe(p).length, MAX_AJUSTES);
  assertEquals(ajustesDe(p).at(-1), `regla ${MAX_AJUSTES + 2}`);
  assert(p.startsWith(activa.prompt.trimEnd()));
});

Deno.test("normalizarVersion: fila jsonb sin forma → versión usable", () => {
  const v = normalizarVersion({ id: "x", numero: 3, estado: "activa", prompt: "p", ejemplos: [{ cliente: "a", vendedor: "b" }, 5], faq: null, objeciones: ["caro", { clave: "envio" }], origen: "semilla" });
  assertEquals(v.ejemplos, [{ cliente: "a", vendedor: "b" }]);
  assertEquals(v.faq, []);
  assertEquals(v.objeciones, ["caro", "envio"]);
});
