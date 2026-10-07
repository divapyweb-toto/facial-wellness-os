// Tests de clasificar.ts y de la configuración (tipos.ts). Sin red: el Batch se simula o se inyecta.
import { assert, assertEquals, assertFalse, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { type EstadoLote, parsearResultadosLote, type PedidoLote, type PrecioModelo, type TablaPrecios } from "../_shared/claude.ts";
import {
  armarLoteClasificacion,
  armarLoteReintento,
  armarPedidoClasificacion,
  ESQUEMA_ETIQUETAS,
  customIdDe,
  enviarLoteClasificacion,
  ErrorMejora,
  estimarConversacion,
  estimarLote,
  leerCustomId,
  leerResultadosLote,
  muestrear,
  parsearRespuesta,
  PREFILL,
  procesarResultados,
  PROMPT_CLASIFICACION,
  recortarAlPresupuesto,
  simularEtiquetas,
  validarEtiquetas,
} from "./clasificar.ts";
import { CFG_MEJORA_DEFAULT, type ConversacionParaAnalizar, type Etiquetas, leerCfgMejora, presupuesto, type Resultado } from "./tipos.ts";

const HAIKU = "claude-haiku-4-5-20251001";
// Mismos valores que seed_vendedor.sql (verificados en la doc oficial el 06-10-2026). Solo para tests.
const PRECIO: PrecioModelo = { entrada: 1, salida: 5, cache_escritura_5m: 1.25, cache_escritura_1h: 2, cache_lectura: 0.1, lote: 0.5 };
const TABLA: TablaPrecios = { [HAIKU]: PRECIO };
const cfg = CFG_MEJORA_DEFAULT;

const ETIQ: Etiquetas = {
  etapa: "objecion",
  objecion_principal: "precio alto",
  respuesta_que_movio: "precio, envío y total en un mensaje",
  errores_bot: [],
  reclamo: { hubo: false, tipo: null, paso_resuelto: null, derivado: false },
  emocion: "neutral",
  debio_derivar: false,
};

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function conv(n: number, resultado: Resultado = "sin_compra", chars = 1200, reclamo = false): ConversacionParaAnalizar {
  const transcripcion = `C: hola cuánto sale\nV: Sale Gs 129.000 + envío Gs 33.000\n` + "C: " + "a".repeat(Math.max(0, chars - 60));
  return {
    conversacion_id: uuid(n),
    resultado,
    derivado: false,
    tuvo_reclamo: reclamo,
    paso_escalera: null,
    costo_ia_usd: 0,
    costo_mensajes_usd: 0,
    n_mensajes: 3,
    mensajes: [{ de: "C", texto: "hola cuánto sale" }, { de: "V", texto: "Sale Gs 129.000" }],
    transcripcion,
    recortada: false,
  };
}

// ---------- configuración ----------

Deno.test("leerCfgMejora: defaults, valores válidos y reparto 70/30", () => {
  const vacio = leerCfgMejora(null);
  assertEquals(vacio.cfg.tope_usd, 3);
  assertEquals(vacio.cfg.min_conversaciones, 100);
  assert(vacio.faltantes.includes("tope_usd"));
  const c = leerCfgMejora({ tope_usd: 2, min_conversaciones: -5, modelo_clasificacion: " " }).cfg;
  assertEquals(c.tope_usd, 2);
  assertEquals(c.min_conversaciones, 100);
  assertEquals(c.modelo_clasificacion, HAIKU);
  assertEquals(presupuesto(vacio.cfg), { clasificacion_usd: 2.1, sintesis_usd: 0.9 });
});

// ---------- validación ----------

Deno.test("validarEtiquetas acepta el JSON correcto y limpia espacios", () => {
  const v = validarEtiquetas({ ...ETIQ, objecion_principal: "  precio alto " });
  assert(v.ok);
  if (v.ok) assertEquals(v.valor.objecion_principal, "precio alto");
  const conReclamo = validarEtiquetas({ ...ETIQ, etapa: "reclamo", reclamo: { hubo: true, tipo: "Uso", paso_resuelto: 2, derivado: false } });
  assert(conReclamo.ok);
  if (conReclamo.ok) assertEquals(conReclamo.valor.reclamo.tipo, "uso");
});

Deno.test("validarEtiquetas rechaza todo lo que no es exactamente el tipo", () => {
  const malos: [string, unknown][] = [
    ["no objeto", "hola"],
    ["array", []],
    ["clave de más", { ...ETIQ, extra: 1 }],
    ["falta clave", (({ emocion: _e, ...r }) => r)(ETIQ)],
    ["etapa", { ...ETIQ, etapa: "compra" }],
    ["emocion", { ...ETIQ, emocion: "feliz" }],
    ["errores no array", { ...ETIQ, errores_bot: "ninguno" }],
    ["errores con número", { ...ETIQ, errores_bot: [1] }],
    ["demasiados errores", { ...ETIQ, errores_bot: ["a", "b", "c", "d", "e", "f"] }],
    ["objecion vacía", { ...ETIQ, objecion_principal: "" }],
    ["objecion larguísima", { ...ETIQ, objecion_principal: "x".repeat(200) }],
    ["debio_derivar string", { ...ETIQ, debio_derivar: "no" }],
    ["paso 6", { ...ETIQ, reclamo: { hubo: true, tipo: "uso", paso_resuelto: 6, derivado: false } }],
    ["paso 2.5", { ...ETIQ, reclamo: { hubo: true, tipo: "uso", paso_resuelto: 2.5, derivado: false } }],
    ["paso string", { ...ETIQ, reclamo: { hubo: true, tipo: "uso", paso_resuelto: "2", derivado: false } }],
    ["reclamo clave de más", { ...ETIQ, reclamo: { ...ETIQ.reclamo, nota: "x" } }],
    ["reclamo inconsistente", { ...ETIQ, reclamo: { hubo: false, tipo: "uso", paso_resuelto: null, derivado: false } }],
  ];
  for (const [nombre, x] of malos) assertFalse(validarEtiquetas(x).ok, nombre);
});

Deno.test("parsearRespuesta: con prefill, con ```json, con texto alrededor, basura", () => {
  const sinLlave = JSON.stringify(ETIQ).slice(1);
  const a = parsearRespuesta(sinLlave);
  assert(a.ok && validarEtiquetas(a.valor).ok);
  const b = parsearRespuesta("```json\n" + JSON.stringify(ETIQ) + "\n```");
  assert(b.ok && validarEtiquetas(b.valor).ok);
  assertFalse(parsearRespuesta("").ok);
  assertFalse(parsearRespuesta("no sé qué decirte").ok);
  assertFalse(parsearRespuesta('"etapa": "consulta"').ok);
});

// ---------- pedidos ----------

Deno.test("armarPedidoClasificacion: custom_id válido, esquema en el intento 1, prefill en el 2, sin caché", () => {
  const c = conv(1);
  const p = armarPedidoClasificacion(c, cfg);
  assertEquals(p.custom_id, `c1_${c.conversacion_id}`);
  assert(/^[a-zA-Z0-9_-]{1,64}$/.test(p.custom_id));
  assertEquals(p.pedido.modelo, HAIKU);
  assertEquals(p.pedido.system, PROMPT_CLASIFICACION);
  assertEquals(p.pedido.maxTokens, 300);
  assertEquals(p.pedido.cache, false);
  assertEquals(p.pedido.esquemaJson, ESQUEMA_ETIQUETAS);
  assertEquals(p.pedido.mensajes.length, 1); // salida estructurada: sin prefill
  assert(String(p.pedido.mensajes[0].content).includes(c.transcripcion));
  const r = armarPedidoClasificacion(c, cfg, 2);
  assertEquals(r.pedido.esquemaJson, undefined);
  assertEquals(r.pedido.mensajes.at(-1), { role: "assistant", content: PREFILL });
  assertEquals(r.custom_id, `c2_${c.conversacion_id}`);
  assert(String(r.pedido.mensajes[0].content).includes("no era un JSON válido"));
  assertEquals(leerCustomId(r.custom_id), { conversacion_id: c.conversacion_id, intento: 2 });
  assertEquals(leerCustomId("otro"), null);
  assertThrows(() => customIdDe("x".repeat(70), 1), ErrorMejora);
});

Deno.test("el prompt es corto (barato) y no tiene palabras prohibidas", () => {
  assert(PROMPT_CLASIFICACION.length < 2600, `largo ${PROMPT_CLASIFICACION.length}`);
  assertFalse(/garant[ií]a|reembolso|sin riesgo|cura|tratamiento|ox[ií]geno/i.test(PROMPT_CLASIFICACION));
});

// ---------- costo y recorte ----------

Deno.test("estimación: Haiku por lote, salida al máximo (conservador)", () => {
  const e = estimarConversacion(conv(1, "sin_compra", 3000), cfg, PRECIO);
  assertEquals(e.salida_tokens, 300);
  // (entrada × 1 + 300 × 5) / 1e6 × 0,5
  assertEquals(Math.round(e.usd * 1e9), Math.round(((e.entrada_tokens + 1500) / 1e6) * 0.5 * 1e9));
  const lote = estimarLote([conv(1), conv(2)], cfg, PRECIO);
  const suma = estimarConversacion(conv(1), cfg, PRECIO).usd + estimarConversacion(conv(2), cfg, PRECIO).usd;
  assertEquals(Math.round(lote.usd * 1e6), Math.round(suma * 1.1 * 1e6)); // +10 % de margen de reintento
});

Deno.test("costo por mes a 300 y 1000 conversaciones entra en el tope sin recortar", () => {
  for (const n of [300, 1000]) {
    const convs = Array.from({ length: n }, (_, i) => conv(i + 1, i % 3 ? "sin_compra" : "entregado", 2500));
    const r = recortarAlPresupuesto(convs, presupuesto(cfg).clasificacion_usd, cfg, PRECIO);
    assertEquals(r.excluidas, 0, `n=${n}`);
    assert(r.estimacion!.usd < 2.1, `n=${n} usd=${r.estimacion!.usd}`);
  }
});

Deno.test("si la estimación supera el presupuesto, recorta la muestra hasta que entra", () => {
  const convs = Array.from({ length: 400 }, (_, i) => conv(i + 1, (["entregado", "sin_compra", "cancelado"] as const)[i % 3], 4000, i % 50 === 0));
  const presu = 0.2;
  const r = recortarAlPresupuesto(convs, presu, cfg, PRECIO, "2026-09-01");
  assert(r.excluidas > 0);
  assert(r.estimacion!.usd <= presu, `${r.estimacion!.usd}`);
  assertEquals(r.incluidas.length + r.excluidas, 400);
  assert(r.notas[0].includes("recortada"));
  // estratos representados (incluido el de reclamos, que es chico)
  const estratos = new Set(r.incluidas.map((c) => `${c.resultado}|${c.tuvo_reclamo}`));
  assert(estratos.has("entregado|true") || estratos.has("sin_compra|true") || estratos.has("cancelado|true"));
  assert(estratos.has("entregado|false") && estratos.has("sin_compra|false") && estratos.has("cancelado|false"));
  // determinista
  const r2 = recortarAlPresupuesto(convs, presu, cfg, PRECIO, "2026-09-01");
  assertEquals(r2.incluidas.map((c) => c.conversacion_id), r.incluidas.map((c) => c.conversacion_id));
});

Deno.test("muestrear: tamaño exacto, sin repetidos, al menos una por estrato", () => {
  const convs = [
    ...Array.from({ length: 90 }, (_, i) => conv(i, "sin_compra")),
    ...Array.from({ length: 9 }, (_, i) => conv(100 + i, "entregado")),
    conv(200, "devuelto", 1200, true),
  ];
  const m = muestrear(convs, 10, "s");
  assertEquals(m.length, 10);
  assertEquals(new Set(m.map((c) => c.conversacion_id)).size, 10);
  assert(m.some((c) => c.resultado === "devuelto"));
  assert(m.some((c) => c.resultado === "entregado"));
  assertEquals(muestrear(convs, 1000).length, 100);
  assertEquals(muestrear(convs, 0).length, 0);
});

Deno.test("sin precio: fuera del modo simulado no arma el lote (no gasta a ciegas)", () => {
  assertThrows(() => armarLoteClasificacion([conv(1)], { cfg, precio: null, simulado: false }), ErrorMejora);
  const l = armarLoteClasificacion([conv(1)], { cfg, precio: null, simulado: true });
  assertEquals(l.pedidos.length, 1);
  assertEquals(l.estimacion, null);
});

Deno.test("armarLoteClasificacion usa ~70 % del tope y recorta", () => {
  const convs = Array.from({ length: 50 }, (_, i) => conv(i + 1, "sin_compra", 4000));
  const l = armarLoteClasificacion(convs, { cfg: { ...cfg, tope_usd: 0.05 }, precio: PRECIO });
  assertEquals(l.presupuesto_usd, 0.035);
  assert(l.estimacion!.usd <= 0.035);
  assert(l.pedidos.length < 50 && l.pedidos.length > 0);
  assertEquals(l.excluidas, 50 - l.pedidos.length);
});

// ---------- resultados ----------

function filaJsonl(customId: string, texto: string | null, tipo = "succeeded"): string {
  if (tipo !== "succeeded") return JSON.stringify({ custom_id: customId, result: { type: tipo, error: { type: "error", error: { type: "api_error" } } } });
  return JSON.stringify({
    custom_id: customId,
    result: {
      type: "succeeded",
      message: { model: HAIKU, content: [{ type: "text", text: texto }], usage: { input_tokens: 1000, output_tokens: 120 } },
    },
  });
}

Deno.test("procesarResultados: válidas, inválidas (reintento), errored, descartadas, faltantes", () => {
  const ids = [1, 2, 3, 4, 5].map(uuid);
  const jsonl = [
    filaJsonl(`c1_${ids[0]}`, JSON.stringify(ETIQ).slice(1)),
    filaJsonl(`c1_${ids[1]}`, "perdón, no puedo"),
    filaJsonl(`c1_${ids[2]}`, null, "errored"),
    filaJsonl(`c1_${ids[3]}`, JSON.stringify({ ...ETIQ, etapa: "otra" })),
    filaJsonl(`c1_${ids[0]}`, JSON.stringify(ETIQ)), // repetido: se ignora
    filaJsonl("c1_ajeno", JSON.stringify(ETIQ)), // no es de este lote
    "esto no es json",
  ].join("\n");
  const res = parsearResultadosLote(jsonl, () => HAIKU, TABLA);
  const p = procesarResultados(res, new Set(ids));
  assertEquals(p.validas.map((v) => v.conversacion_id), [ids[0]]);
  assertEquals(p.invalidas.map((v) => v.conversacion_id).sort(), [ids[1], ids[2], ids[3], ids[4]].sort());
  assertEquals(p.invalidas.find((x) => x.conversacion_id === ids[2])!.motivo, "lote:errored");
  assertEquals(p.invalidas.find((x) => x.conversacion_id === ids[4])!.motivo, "sin resultado");
  // 3 filas exitosas cobradas a precio de lote: (1000×1 + 120×5)/1e6 × 0,5 = 0,0008 c/u
  assertEquals(p.costo_usd, 0.0024);
  // intento 2: las inválidas se descartan
  const r2 = parsearResultadosLote(filaJsonl(`c2_${ids[1]}`, "otra vez texto"), () => HAIKU, TABLA);
  const p2 = procesarResultados(r2, new Set([ids[1]]), 2);
  assertEquals(p2.invalidas, []);
  assertEquals(p2.descartadas.map((d) => d.conversacion_id), [ids[1]]);
});

Deno.test("armarLoteReintento: solo inválidas del intento 1", () => {
  const convs = [conv(1), conv(2), conv(3)];
  const l = armarLoteReintento(
    [{ conversacion_id: uuid(1), intento: 1 }, { conversacion_id: uuid(2), intento: 2 }, { conversacion_id: "no-existe", intento: 1 }],
    convs,
    cfg,
    PRECIO,
  );
  assertEquals(l.pedidos.map((p) => p.custom_id), [`c2_${uuid(1)}`]);
  assertEquals(l.intento, 2);
});

Deno.test("flujo real con Batch inyectado: enviar, en curso, terminado, reintento", async () => {
  const convs = [conv(1), conv(2)];
  let enviados: PedidoLote[] = [];
  const crearLote = (p: PedidoLote[]): Promise<EstadoLote> => {
    enviados = p;
    return Promise.resolve({ id: "msgbatch_prueba", estado: "in_progress", simulado: false });
  };
  const lote = armarLoteClasificacion(convs, { cfg, precio: PRECIO, simulado: false });
  const envio = await enviarLoteClasificacion(lote, convs, { crearLote, simulado: false });
  assertEquals(envio.lote_id, "msgbatch_prueba");
  assertEquals(enviados.length, 2);

  let llamadas = 0;
  const consultar = (id: string): Promise<EstadoLote> => {
    llamadas++;
    assertEquals(id, "msgbatch_prueba");
    if (llamadas === 1) return Promise.resolve({ id, estado: "in_progress", simulado: false });
    const jsonl = [filaJsonl(`c1_${uuid(1)}`, JSON.stringify(ETIQ).slice(1)), filaJsonl(`c1_${uuid(2)}`, "{malo")].join("\n");
    return Promise.resolve({ id, estado: "ended", simulado: false, resultados: parsearResultadosLote(jsonl, () => HAIKU, TABLA) });
  };
  const enCurso = await leerResultadosLote("msgbatch_prueba", convs, cfg, { consultar });
  assertEquals(enCurso.estado, "in_progress");
  assertEquals(enCurso.validas.length, 0);
  const fin = await leerResultadosLote("msgbatch_prueba", convs, cfg, { consultar });
  assertEquals(fin.estado, "ended");
  assertEquals(fin.validas.length, 1);
  assertEquals(fin.invalidas.map((i) => i.conversacion_id), [uuid(2)]);
  const re = armarLoteReintento(fin.invalidas, convs, cfg, PRECIO);
  assertEquals(re.pedidos.length, 1);
});

Deno.test("modo simulado: etiquetas deterministas y válidas, sin llamar a la API", async () => {
  const reclamo: ConversacionParaAnalizar = {
    ...conv(9, "entregado"),
    mensajes: [{ de: "C", texto: "el parche se despega, no pega nada!!!" }, { de: "V", texto: "Uh, ¿me pasás una foto? ¿Cómo lo usás?" }],
  };
  const convs = [conv(1), conv(2, "entregado"), reclamo];
  for (const c of convs) assert(validarEtiquetas(simularEtiquetas(c)).ok);
  const s = simularEtiquetas(reclamo);
  assertEquals(s.etapa, "reclamo");
  assertEquals(s.reclamo.tipo, "uso");
  assertEquals(s.errores_bot, ["dos preguntas juntas"]);
  const lote = armarLoteClasificacion(convs, { cfg, precio: null, simulado: true });
  const envio = await enviarLoteClasificacion(lote, convs, {
    simulado: true,
    crearLote: () => {
      throw new Error("no debería llamarse");
    },
  });
  assert(envio.simulado);
  const lect = await leerResultadosLote(envio, convs, cfg);
  assertEquals(lect.validas.length, 3);
  assertEquals(lect.costo_usd, 0);
  // También por id (corrida siguiente del cron)
  const porId = await leerResultadosLote(envio.lote_id, convs, cfg);
  assertEquals(porId.validas.length, 3);
});

Deno.test("enviar un lote vacío falla", async () => {
  await assertRejects(() => enviarLoteClasificacion({ pedidos: [], incluidas: [], excluidas: 0, estimacion: null, presupuesto_usd: 0, intento: 1, notas: [] }, []), ErrorMejora);
});

Deno.test("ESQUEMA_ETIQUETAS: claves iguales a las que valida validarEtiquetas y todo objeto cerrado", () => {
  const props = (ESQUEMA_ETIQUETAS.properties ?? {}) as Record<string, Record<string, unknown>>;
  assertEquals(Object.keys(props).sort(), Object.keys(simularEtiquetas(conv(1))).sort());
  assertEquals(ESQUEMA_ETIQUETAS.additionalProperties, false);
  assertEquals(props.reclamo.additionalProperties, false);
  assertEquals((ESQUEMA_ETIQUETAS.required as string[]).length, Object.keys(props).length);
  // Sin restricciones que la API no acepta.
  const txt = JSON.stringify(ESQUEMA_ETIQUETAS);
  for (const k of ["minLength", "maxLength", "minimum", "maximum", "multipleOf"]) assert(!txt.includes(k), k);
});

Deno.test("leerResultadosLote: con solo los ids del lote (sin convs) detecta faltantes", async () => {
  const consultar = (id: string): Promise<EstadoLote> => {
    const jsonl = filaJsonl(`c1_${uuid(1)}`, JSON.stringify(ETIQ).slice(1));
    return Promise.resolve({ id, estado: "ended", simulado: false, resultados: parsearResultadosLote(jsonl, () => HAIKU, TABLA) });
  };
  const r = await leerResultadosLote("msgbatch_x", [], cfg, { consultar, esperados: [uuid(1), uuid(2)] });
  assertEquals(r.validas.length, 1);
  assertEquals(r.invalidas.map((i) => i.conversacion_id), [uuid(2)]);
  assertEquals(r.invalidas[0].motivo, "sin resultado");
});
