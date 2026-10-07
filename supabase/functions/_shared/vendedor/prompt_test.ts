import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { armarPrompt, LLAVES_PROMPT, PLANTILLA_PROMPT } from "./prompt.ts";
import { armarConfigTurno } from "./config.ts";
import { extraerMontos } from "./filtro_salida.ts";

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
  assert(p.includes("Tiras de prueba. Consejo de uso: piel limpia y seca"));
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
