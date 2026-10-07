import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  _configurarClaude,
  armarCuerpo,
  calcularCostoUsd,
  ErrorClaude,
  llamarClaude,
  llamarClaudeLote,
  parsearResultadosLote,
  precioDe,
  simularRespuesta,
  type TablaPrecios,
} from "./claude.ts";

const PRECIOS: TablaPrecios = {
  "claude-haiku-4-5-20251001": { entrada: 1, salida: 5, cache_escritura_5m: 1.25, cache_escritura_1h: 2, cache_lectura: 0.1, lote: 0.5 },
  "claude-sonnet-5-5": { entrada: 2, salida: 10, cache_escritura_5m: 2.5, cache_escritura_1h: 4, cache_lectura: 0.2, lote: 0.5 },
};

Deno.test("costo: Haiku con caché de 1 h y lectura", () => {
  const c = calcularCostoUsd(
    { entrada: 1000, salida: 200, cache_lectura: 5000, cache_escritura: 4000, cache_escritura_1h: 4000, cache_escritura_5m: 0 },
    precioDe("claude-haiku-4-5-20251001", PRECIOS),
  );
  // 1000×1 + 200×5 + 5000×0.1 + 4000×2 = 10.500 / 1e6
  assertEquals(c, 0.0105);
});

Deno.test("costo: lote = mitad; sin precio = null; alias sin fecha encuentra el precio", () => {
  const uso = { entrada: 1_000_000, salida: 0, cache_lectura: 0, cache_escritura: 0 };
  assertEquals(calcularCostoUsd(uso, PRECIOS["claude-sonnet-5-5"], { lote: true }), 1);
  assertEquals(calcularCostoUsd(uso, null), null);
  assertEquals(precioDe("claude-haiku-4-5", PRECIOS)?.entrada, 1);
});

Deno.test("cuerpo: caché 1 h en herramientas y system, automática en la cola; Haiku sin effort", () => {
  const { cuerpo, betas } = armarCuerpo({
    modelo: "claude-haiku-4-5-20251001",
    system: [{ type: "text", text: "estable" }, { type: "text", text: "variable" }],
    mensajes: [{ role: "user", content: "hola" }],
    herramientas: [{ name: "a", description: "a", input_schema: { type: "object" } }, { name: "b", description: "b", input_schema: { type: "object" } }],
    cache: true,
    esfuerzo: "low",
    fallbackServidor: true,
  });
  const tools = cuerpo.tools as Array<Record<string, unknown>>;
  assertEquals(tools[0].cache_control, undefined);
  assertEquals(tools[1].cache_control, { type: "ephemeral", ttl: "1h" });
  const system = cuerpo.system as Array<Record<string, unknown>>;
  assertEquals(system[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assertEquals(system[1].cache_control, undefined);
  assertEquals(cuerpo.cache_control, { type: "ephemeral" });
  assertEquals(cuerpo.output_config, undefined);
  assertEquals(cuerpo.fallbacks, undefined);
  assertEquals(betas, []);
});

Deno.test("cuerpo: Sonnet 5.5 lleva effort y fallback del servidor (no en lote)", () => {
  const p = { modelo: "claude-sonnet-5-5", system: "s", mensajes: [{ role: "user" as const, content: "x" }], esfuerzo: "low" as const, fallbackServidor: true };
  const a = armarCuerpo(p);
  assertEquals(a.cuerpo.output_config, { effort: "low" });
  assertEquals(a.cuerpo.fallbacks, "default");
  assertEquals(a.betas, ["server-side-fallback-2026-07-01"]);
  const b = armarCuerpo(p, true);
  assertEquals(b.cuerpo.fallbacks, undefined);
});

Deno.test("cuerpo: esquemaJson va en output_config.format (junto al effort; en Haiku sin effort; también en lote)", () => {
  const esquema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  const m = [{ role: "user" as const, content: "x" }];
  const s = armarCuerpo({ modelo: "claude-sonnet-5-5", system: "s", mensajes: m, esfuerzo: "medium", esquemaJson: esquema });
  assertEquals(s.cuerpo.output_config, { effort: "medium", format: { type: "json_schema", schema: esquema } });
  const h = armarCuerpo({ modelo: "claude-haiku-4-5-20251001", system: "s", mensajes: m, esfuerzo: "low", esquemaJson: esquema }, true);
  assertEquals(h.cuerpo.output_config, { format: { type: "json_schema", schema: esquema } });
  assertEquals(h.betas, []);
});

function respuestaApi(status: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });
}

Deno.test("llamarClaude: manda headers correctos y calcula el costo con config", async () => {
  let pedido: RequestInit | undefined;
  _configurarClaude({
    modoSimulado: () => false,
    apiKey: () => "clave-de-prueba",
    precios: () => Promise.resolve(PRECIOS),
    fetch: (_u, init) => {
      pedido = init;
      return Promise.resolve(respuestaApi(200, {
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: "Hola" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }));
    },
  });
  try {
    const r = await llamarClaude({ modelo: "claude-haiku-4-5-20251001", system: "s", mensajes: [{ role: "user", content: "hola" }] });
    const h = pedido!.headers as Record<string, string>;
    assertEquals(h["anthropic-version"], "2023-06-01");
    assertEquals(h["x-api-key"], "clave-de-prueba");
    assertEquals(r.simulado, false);
    assertEquals(r.costo_usd, 0.00015);
    assertEquals(r.contenido[0], { type: "text", text: "Hola" });
  } finally {
    _configurarClaude();
  }
});

Deno.test("llamarClaude: reintenta una vez ante 529 y no reintenta ante 400", async () => {
  let llamadas = 0;
  _configurarClaude({
    modoSimulado: () => false,
    apiKey: () => "k",
    precios: () => Promise.resolve(PRECIOS),
    dormir: () => Promise.resolve(),
    fetch: () => {
      llamadas++;
      return Promise.resolve(llamadas === 1
        ? respuestaApi(529, { error: { type: "overloaded_error", message: "x" } })
        : respuestaApi(200, { content: [], stop_reason: "end_turn", usage: {} }));
    },
  });
  try {
    await llamarClaude({ modelo: "claude-haiku-4-5-20251001", system: "s", mensajes: [{ role: "user", content: "x" }] });
    assertEquals(llamadas, 2);
    llamadas = 10;
    _configurarClaude({
      modoSimulado: () => false,
      apiKey: () => "k",
      dormir: () => Promise.resolve(),
      fetch: () => (llamadas++, Promise.resolve(respuestaApi(400, { error: { type: "invalid_request_error", message: "mal" } }))),
    });
    await assertRejects(() => llamarClaude({ modelo: "m", system: "s", mensajes: [{ role: "user", content: "x" }] }), ErrorClaude);
    assertEquals(llamadas, 11);
  } finally {
    _configurarClaude();
  }
});

Deno.test("simulador determinista: salud → derivar; precio → catálogo; tool_result → texto con total", () => {
  const herramientas = [
    { name: "derivar_a_enrique", description: "", input_schema: {} },
    { name: "consultar_catalogo", description: "", input_schema: {} },
  ];
  const s1 = simularRespuesta({ modelo: "m", system: "", mensajes: [{ role: "user", content: "tengo apnea, me sirve?" }], herramientas });
  assertEquals((s1.contenido[0] as { name: string }).name, "derivar_a_enrique");
  const s2 = simularRespuesta({ modelo: "m", system: "", mensajes: [{ role: "user", content: "cuánto sale?" }], herramientas });
  assertEquals((s2.contenido[0] as { name: string }).name, "consultar_catalogo");
  const s3 = simularRespuesta({
    modelo: "m",
    system: "",
    herramientas,
    mensajes: [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: JSON.stringify({ envio_texto: "33.000", productos: [{ titulo: "Tiras", precio_texto: "79.000", total_texto: "112.000" }] }) }],
    }],
  });
  assert((s3.contenido[0] as { text: string }).text.includes("Gs 112.000"));
  assertEquals(s3.simulado, true);
  assertEquals(s3.costo_usd, 0);
});

Deno.test("lote: simulado responde al toque; JSONL de resultados se parsea con precio de lote", async () => {
  _configurarClaude({ modoSimulado: () => true });
  try {
    const r = await llamarClaudeLote([{ custom_id: "c1", pedido: { modelo: "claude-haiku-4-5-20251001", system: "", mensajes: [{ role: "user", content: "hola" }] } }]);
    assertEquals(r.estado, "ended");
    assertEquals(r.simulado, true);
    assertEquals(r.resultados?.[0].custom_id, "c1");
  } finally {
    _configurarClaude();
  }
  const jsonl = [
    JSON.stringify({ custom_id: "a", result: { type: "succeeded", message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1_000_000, output_tokens: 0 } } } }),
    JSON.stringify({ custom_id: "b", result: { type: "errored", error: { type: "invalid_request_error" } } }),
    "",
  ].join("\n");
  const res = parsearResultadosLote(jsonl, () => null, PRECIOS);
  assertEquals(res.length, 2);
  assertEquals(res[0].texto, "ok");
  assertEquals(res[0].costo_usd, 0.5);
  assertEquals(res[1].tipo, "errored");
});
