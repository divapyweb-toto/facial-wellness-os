import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { armarPrompt, LLAVES_PROMPT, PLANTILLA_PROMPT } from "./prompt.ts";
import { armarConfigTurno } from "./config.ts";
import { extraerMontos, MULETILLAS_DEFAULT, NIEGA_IA_DEFAULT, revisarRespuesta, URGENCIA_DEFAULT } from "./filtro_salida.ts";
import { textoFichas } from "./prompt.ts";
import { RITMO_DEFAULT } from "./ritmo.ts";
import { RESPUESTAS_FIJAS_DEFAULT } from "./respuestas_fijas.ts";
import { MULETILLAS_BOT, NIEGA_IA, URGENCIA_INVENTADA } from "../../auditoria-diaria/reglas.ts";

Deno.test("prompt.ts es copia exacta de supabase/vendedor/prompt_sistema.md", async () => {
  const md = await Deno.readTextFile(new URL("../../../vendedor/prompt_sistema.md", import.meta.url));
  assertEquals(PLANTILLA_PROMPT, md);
});

Deno.test("prompt: tiene las 5 llaves, decisión del 6-oct y ningún precio", () => {
  for (const k of LLAVES_PROMPT) assert(PLANTILLA_PROMPT.includes(`{${k}}`), k);
  assert(PLANTILLA_PROMPT.includes("Atendés las 24 horas"));
  assert(PLANTILLA_PROMPT.includes("crear_pedido_cod"));
  assertFalse(PLANTILLA_PROMPT.includes("lo carga una persona"));
  assertFalse(PLANTILLA_PROMPT.includes("pasar_a_humano"));
  assertEquals(extraerMontos(PLANTILLA_PROMPT), []);
});

Deno.test("armarPrompt llena todas las llaves desde config", () => {
  const { cfg } = armarConfigTurno({
    vendedor_glosario: [{ escribe: "katu", significa: "dale", accion: "cerrar" }],
    vendedor_envio: { costo_gs: 33000, plazo: "2 a 5 días hábiles" },
    vendedor_afirmaciones: ["Pagás al recibir"],
    aceptaciones: ["si", "dale"],
  });
  const p = armarPrompt({
    glosario: cfg.glosario,
    fichas: [{ handle: "tiras-prueba", titulo: "Tiras de prueba", consejo_uso: "piel limpia y seca" }],
    envio: cfg.envio,
    afirmaciones: cfg.afirmaciones,
    aceptaciones: cfg.aceptaciones,
  });
  assertFalse(/\{(glosario|fichas_de_producto|envio_y_plazos|afirmaciones_permitidas|lista_de_aceptaciones)\}/.test(p));
  assert(p.includes('"katu" = dale → cerrar'));
  assert(p.includes("envío Gs 33.000 a todo el país, llega en 2 a 5 días hábiles, pagás al recibir"));
  assert(p.includes("\n- Tiras de prueba [tiras-prueba]. Consejo de uso: piel limpia y seca."));
  assert(p.includes('"si", "dale"'));
});

Deno.test("config: claves faltantes usan defaults y se informan", () => {
  const { cfg, faltantes } = armarConfigTurno({ vendedor: { modelo: "claude-sonnet-5-5" } });
  assertEquals(cfg.vendedor.modelo, "claude-sonnet-5-5");
  assertEquals(cfg.vendedor.max_turnos_conversacion, 20);
  assertEquals(cfg.vendedor.tope_mensual_usd, 45);
  assertEquals(cfg.envio.costo_gs, 33000);
  assert(faltantes.includes("vendedor_glosario"));
  assertFalse(faltantes.includes("vendedor"));
  assertFalse(faltantes.includes("vendedor_prompt"));
});

Deno.test("seed_vendedor.sql: JSON válido, glosario completo, modelo, topes y sin palabras prohibidas fuera de la lista de detección", async () => {
  const sql = await Deno.readTextFile(new URL("../../../seed_vendedor.sql", import.meta.url));
  const filas = new Map<string, unknown>();
  for (const m of sql.matchAll(/\('([a-z_]+)',\s*'((?:[^']|'')*)'::jsonb\)/g)) filas.set(m[1], JSON.parse(m[2].replaceAll("''", "'")));
  const v = filas.get("vendedor") as Record<string, unknown>;
  assertEquals(v.modelo, "claude-haiku-4-5-20251001");
  assertEquals(v.modelo_alternativo, "claude-sonnet-5-5");
  assertEquals(v.max_turnos_conversacion, 20);
  assertEquals(v.tope_mensual_usd, 45);
  assertEquals((filas.get("vendedor_glosario") as unknown[]).length, 17);
  assertEquals((filas.get("vendedor_envio") as Record<string, unknown>).costo_gs, 33000);
  const precios = filas.get("precios_claude") as Record<string, Record<string, number>>;
  assertEquals(precios["claude-haiku-4-5-20251001"].entrada, 1);
  assertEquals(precios["claude-sonnet-5-5"].salida, 10);
  const prohibidas = ["garantía", "devolución", "reembolso", "sin riesgo", "tratamiento"];
  for (const [clave, valor] of filas) {
    if (clave === "vendedor_promesas_salud") continue;
    const t = JSON.stringify(valor).toLowerCase();
    for (const p of prohibidas) assertFalse(t.includes(p), `${clave} contiene ${p}`);
  }
});

async function filasSemilla(): Promise<Map<string, unknown>> {
  const sql = await Deno.readTextFile(new URL("../../../seed_vendedor.sql", import.meta.url));
  const filas = new Map<string, unknown>();
  for (const m of sql.matchAll(/\('([a-z_]+)',\s*'((?:[^']|'')*)'::jsonb\)/g)) filas.set(m[1], JSON.parse(m[2].replaceAll("''", "'")));
  return filas;
}

Deno.test("prompt: diagnóstico y perfiles, estilo humano, cierre y honestidad explícitos", () => {
  for (
    const frase of [
      "DIAGNÓSTICO", "Apurado", "Desconfiado", "Curioso", "Precio (", "Regalo", "registrar_perfil", "PERFIL YA DETECTADO",
      "La primera línea engancha", "Una sola pregunta, al final", "Nada de listas, viñetas, negritas", "Nada de frases de bot",
      "\"¡Claro!\"", "No dudes en", "Ofrecé el ×2 una sola vez", "\"¿Qué te frena?\"", "no insistas", "Nunca inventes urgencia",
      "HONESTIDAD (no negociable)", "nunca digas que sos una persona", "no mientas: decí que sos el asistente virtual de Voltra",
      "ofrecé pasarlo con Enrique", "Si escribe varios mensajes seguidos", "monosílabos", "farmacia",
    ]
  ) assert(PLANTILLA_PROMPT.includes(frase), frase);
  for (const p of ["cura", "oxígeno", "garantía", "100 %", "clínicamente"]) assert(PLANTILLA_PROMPT.toLowerCase().includes(p), `PROHIBIDO menciona ${p}`);
});

Deno.test("seed: una ficha por producto real de Shopify, completa y sin promesas de salud ni palabras prohibidas", async () => {
  const fichas = (await filasSemilla()).get("vendedor_fichas") as Record<string, Record<string, unknown>>;
  assertEquals(Object.keys(fichas).sort(), [
    "botella-flexible-gudair-500-ml", "ejercitador-de-mandibula-3-niveles", "pack-gudair-tiras-nasales-parches-bucales",
    "parches-bucales-gudair-30-unidades", "raspador-de-lengua-de-acero-inoxidable", "tiras-nasales-gudair-30-unidades",
  ]);
  const prohibidas = /garant|devoluc|reembols|sin riesgo|\bcura|\bcurar|tratamiento|oxigen|ox[ií]geno|100 ?%|clinicamente|clínicamente|elimina|dejas de roncar|dejás de roncar/i;
  for (const [h, f] of Object.entries(fichas)) {
    for (const k of ["ficha", "para_quien", "como_se_usa", "consejo_uso"]) assert(typeof f[k] === "string" && (f[k] as string).length > 10, `${h}.${k}`);
    assertEquals((f.beneficios as string[]).length, 3, `${h}: 3 beneficios`);
    assert((f.objeciones as unknown[]).length >= 3, `${h}: objeciones`);
    const { precios_referencia: _p, ...texto } = f;
    assertFalse(prohibidas.test(JSON.stringify(texto)), `${h}: ${JSON.stringify(texto).match(prohibidas)?.[0]}`);
    assert(revisarRespuesta(JSON.stringify(texto), { catalogo: [], prohibidas: ["garantía", "devolución", "reembolso", "sin riesgo", "cura", "curar", "tratamiento", "oxígeno"], maxLineas: 99, maxPreguntas: 99, maxEmojis: 99 })
      .motivos.every((m) => !m.startsWith("palabra_prohibida") && !m.startsWith("promesa_salud") && !m.startsWith("precio")), h);
  }
  // Precios verificados por Enrique el 06-10 (control): no van al prompt.
  assertEquals((fichas["tiras-nasales-gudair-30-unidades"].precios_referencia as Record<string, number>), { x1: 79000, x2: 125000, x3: 155000 });
  assertEquals((fichas["pack-gudair-tiras-nasales-parches-bucales"].precios_referencia as Record<string, number>).pack, 120000);
  const enPrompt = textoFichas(Object.entries(fichas).map(([handle, f]) => ({ handle, titulo: handle, ...f })));
  assertEquals(extraerMontos(enPrompt), [], "las fichas del prompt no llevan precios");
  assert(enPrompt.includes("Objeciones: \"¿Funciona de verdad?\" →"));
});

Deno.test("seed: ofertas ×2/×3 de tiras y parches, envío, ritmo, fijas y estilo coherentes con el código", async () => {
  const f = await filasSemilla();
  const of = f.get("vendedor_ofertas") as Record<string, Record<string, number>>;
  assertEquals(of["tiras-nasales-gudair-30-unidades"], { "2": 125000, "3": 155000 });
  assertEquals(of["parches-bucales-gudair-30-unidades"], { "2": 125000, "3": 155000 });
  assertEquals((f.get("vendedor_envio") as Record<string, number>).costo_gs, 33000);
  const v = f.get("vendedor") as Record<string, unknown>;
  assertEquals(v.espera_agrupar_s, 8);
  assertEquals(v.historial_mensajes, 12);
  assertEquals(v.modelo, "claude-haiku-4-5-20251001");
  assertEquals(f.get("vendedor_ritmo"), RITMO_DEFAULT);
  const ritmo = f.get("vendedor_ritmo") as Record<string, number>;
  assertEquals([ritmo.min_s, ritmo.max_s, ritmo.noche_desde_hora, ritmo.noche_hasta_hora], [4, 25, 0, 7]);
  assertEquals(f.get("vendedor_respuestas_fijas"), RESPUESTAS_FIJAS_DEFAULT);
  const estilo = f.get("vendedor_estilo") as Record<string, string[]>;
  assertEquals(estilo.muletillas, MULETILLAS_DEFAULT);
  assertEquals(estilo.urgencia, URGENCIA_DEFAULT);
  assertEquals(estilo.niega_ia, NIEGA_IA_DEFAULT);
  // Mismas listas en el evaluador de la batería y la auditoría.
  assertEquals(MULETILLAS_BOT, MULETILLAS_DEFAULT);
  assertEquals(NIEGA_IA, NIEGA_IA_DEFAULT);
  assertEquals(URGENCIA_INVENTADA, URGENCIA_DEFAULT);
  const { cfg, faltantes } = armarConfigTurno(Object.fromEntries(f));
  assertEquals(faltantes.filter((k) => k !== "aceptaciones" && k !== "palabras_prohibidas"), []);
  assertEquals(cfg.ritmo.max_s, 25);
  assertEquals(cfg.fichas["tiras-nasales-gudair-30-unidades"].beneficios?.length, 3);
});

Deno.test("prompt + herramientas superan el mínimo cacheable de Haiku 4.5 (4.096 tokens) con las fichas reales", async () => {
  const { HERRAMIENTAS } = await import("./herramientas.ts");
  const f = await filasSemilla();
  const { cfg } = armarConfigTurno(Object.fromEntries(f));
  const p = armarPrompt({
    glosario: cfg.glosario,
    fichas: Object.entries(cfg.fichas).map(([handle, x]) => ({ handle, titulo: handle, ...x })),
    envio: cfg.envio,
    afirmaciones: cfg.afirmaciones,
    aceptaciones: cfg.aceptaciones,
  });
  // Estimación conservadora: ~3,6 caracteres por token en español y ~3 en JSON.
  const tokens = p.length / 3.6 + JSON.stringify(HERRAMIENTAS).length / 3;
  assert(tokens > 4096 * 1.1, `~${Math.round(tokens)} tokens: por debajo del mínimo la caché no se activa`);
});
