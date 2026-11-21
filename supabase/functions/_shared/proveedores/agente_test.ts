// 21-11 · Pruebas del agente de proveedores. Sin red: la IA es un doble inyectado o el modo simulado de claude.ts.
// Todos los datos son DEMO (proveedor, producto, precios inventados).
import { assert, assertEquals, assertMatch } from "@std/assert";
import { _configurarClaude, llamarClaude, type PedidoClaude, type RespuestaClaude } from "../claude.ts";
import {
  type ConfigProveedores,
  configProveedoresDesde,
  type DepsAgente,
  detectarPedidoProveedor,
  elegirIdioma,
  type EntradaAgente,
  normalizarCotizacion,
  parsearSalidaModelo,
  redactarPrimerContacto,
  responderProveedor,
  textoCompromete,
} from "./agente.ts";

const CFG: ConfigProveedores = {
  activo: true,
  tope_ia_usd_mes: 10,
  tope_plantillas_mes: 30,
  modelo: "claude-haiku-4-5",
  direccion_deposito: null,
  firma: "Voltra (Paraguay)",
};

function respuesta(texto: string, extra: Partial<RespuestaClaude> = {}): RespuestaClaude {
  return {
    contenido: [{ type: "text", text: texto }],
    stop_reason: "end_turn",
    uso: { entrada: 900, salida: 200, cache_lectura: 0, cache_escritura: 0 },
    costo_usd: 0.0019,
    simulado: false,
    modelo: "claude-haiku-4-5",
    ...extra,
  };
}

/** Doble de dependencias: cuenta llamadas y guarda el último pedido a la IA. */
function doble(opts: { texto?: string; simulado?: boolean; gasto?: number; cfg?: Partial<ConfigProveedores>; falla?: boolean } = {}) {
  const estado = { llamadas: 0, pedido: null as PedidoClaude | null };
  const deps: DepsAgente = {
    llamar: (p) => {
      estado.llamadas++;
      estado.pedido = p;
      if (opts.falla) return Promise.reject(new Error("HTTP 529 overloaded"));
      if (opts.simulado) return Promise.resolve(respuesta("¡Hola!", { simulado: true, costo_usd: 0 }));
      return Promise.resolve(respuesta(opts.texto ?? "{}"));
    },
    gastoMesUsd: () => Promise.resolve(opts.gasto ?? 0),
    config: () => Promise.resolve({ ...CFG, ...opts.cfg }),
  };
  return { deps, estado };
}

function entrada(texto: string, extra: Partial<EntradaAgente> = {}): EntradaAgente {
  return {
    canal: "email",
    proveedor: { id: "prov-demo", nombre: "Proveedor Demo", idioma: null, plataforma: "alibaba" },
    candidato: { id: "cand-demo", nombre: "Producto demo" },
    texto,
    historial: [],
    ahora: new Date("2026-11-21T15:00:00Z"),
    ...extra,
  };
}

const JSON_BUENO = JSON.stringify({
  traduccion_entrante_es: "Hola, el precio es USD 1,20 por unidad.",
  pide_compromiso: null,
  responder: true,
  respuesta: "Thank you. Could you share the packed weight, carton size and dispatch time?",
  respuesta_es: "Gracias. ¿Nos pasan el peso empacado, la caja y el plazo de despacho?",
  cotizacion: {
    moneda: "USD",
    escalones: [{ cantidad: 500, precio_unit: 1.2 }],
    moq: 500,
    peso_bruto_g: null,
    medidas_caja_cm: null,
    unidades_por_caja: null,
    plazo_dias: null,
    costo_muestra: null,
    incoterm: "FOB",
  },
});

// ---------- textoCompromete (doble freno sobre lo que sale) ----------

Deno.test("textoCompromete: frases que comprometen en inglés", () => {
  for (const t of [
    "We confirm the order of 1000 pcs.",
    "Please go ahead, we will place the order today.",
    "We will pay the deposit tomorrow.",
    "Payment sent, please check.",
    "We'd like to buy samples, please send the invoice.",
    "We accept exclusivity for Paraguay.",
    "We agree to your terms and will sign the contract.",
    "Our card number is 4111 1111 1111 1111.",
    "Our maximum budget is 2000 USD.",
    "We commit to order 2000 units per month.",
  ]) assert(textoCompromete(t) !== null, t);
});

Deno.test("textoCompromete: frases que comprometen en chino", () => {
  for (const t of ["我们确认订单。", "我们今天下单。", "已付款，请查收。", "定金明天转账。", "我们接受独家代理。", "我们愿意付样品费。", "我们可以签合同。", "我们的预算是两千美元。"]) {
    assert(textoCompromete(t) !== null, t);
  }
});

Deno.test("textoCompromete: frases que comprometen en español", () => {
  for (const t of [
    "Confirmamos el pedido de 500 unidades.",
    "Aceptamos los términos y firmamos el contrato.",
    "Te transferimos el depósito hoy.",
    "Compramos la muestra.",
    "Queremos exclusividad.",
    "Nuestro presupuesto máximo es 1000 USD.",
  ]) assert(textoCompromete(t) !== null, t);
});

Deno.test("textoCompromete: negociar normal NO frena (en, zh, es)", () => {
  for (const t of [
    "Thank you. Could you share the price for 300, 500 and 1000 units, the packed weight, carton size, units per carton and dispatch time? Quantities are for evaluation, not a commitment.",
    "Could you do 1.10 USD for 1000 pcs? Other suppliers offer a better price.",
    "Is the sample free? Can you send photos and the CE certificate?",
    "Please share your WhatsApp or email so we can talk faster.",
    "谢谢！请问300、500、1000个的价格，以及毛重、外箱尺寸和发货时间？数量仅用于评估，不是承诺。",
    "Gracias. ¿Nos pasan precio por 500 y 1000 unidades, peso, caja y días de despacho? Las cantidades son de evaluación.",
    "Thanks. That part is confirmed by the owner; we will get back to you soon.",
    "谢谢。这部分需要老板确认，我们会尽快回复您。",
    "Gracias. Eso lo confirma el dueño; te respondemos pronto.",
  ]) assertEquals(textoCompromete(t), null, t);
});

Deno.test("textoCompromete: el número del tope de presupuesto no puede salir", () => {
  assert(textoCompromete("Can you match 1,500?", { presupuestoMaxMinor: 1500 }) !== null);
  assertEquals(textoCompromete("Can you match 1,200?", { presupuestoMaxMinor: 1500 }), null);
});

// ---------- pedidos del proveedor que frenan ----------

Deno.test("detectarPedidoProveedor: compra, pago, muestra paga, exclusividad, términos y cuenta", () => {
  assertEquals(detectarPedidoProveedor("Please confirm the order and we start production."), "compra");
  assertEquals(detectarPedidoProveedor("Kindly arrange the payment of 30% deposit."), "pago");
  assertEquals(detectarPedidoProveedor("The sample fee is 25 USD, refundable."), "muestra_paga");
  assertEquals(detectarPedidoProveedor("We want an exclusive agreement for your country."), "exclusividad");
  assertEquals(detectarPedidoProveedor("Please sign the PI and send it back."), "terminos");
  assertEquals(detectarPedidoProveedor("Send me your card number please."), "datos_cuenta");
  assertEquals(detectarPedidoProveedor("请确认订单，我们安排生产。"), "compra");
  assertEquals(detectarPedidoProveedor("请先付款。"), "pago");
  assertEquals(detectarPedidoProveedor("样品费50元。"), "muestra_paga");
  assertEquals(detectarPedidoProveedor("Por favor transfiera el depósito."), "pago");
  // Una cotización con condiciones de pago no es un pedido de pagar.
  assertEquals(detectarPedidoProveedor("Price 1.20 USD, MOQ 500, payment terms: 30% T/T in advance."), null);
  assertEquals(detectarPedidoProveedor("Hello, thanks for your inquiry. What quantity do you need?"), null);
});

for (const [nombre, texto, idioma, motivo] of [
  ["compra (en)", "Please confirm the order today so we can start.", "en", "compra"],
  ["pago (zh)", "请先付款，我们马上发货。", "zh", "pago"],
  ["muestra paga (en)", "Sample fee is 30 USD, please pay for the sample.", "en", "muestra_paga"],
  ["exclusividad (es)", "Ofrecemos exclusividad si firman hoy.", "es", "exclusividad"],
] as const) {
  Deno.test(`entrante pide ${nombre}: frena y responde neutro en su idioma`, async () => {
    const { deps } = doble({ simulado: true });
    const s = await responderProveedor(entrada(texto), deps);
    assertEquals(s.frena, true);
    assertEquals(s.motivo, motivo);
    assertEquals(s.responder, true);
    assertEquals(s.idioma, idioma);
    assert(s.texto && s.texto.length > 0);
    assertEquals(textoCompromete(s.texto!), null);
    if (idioma === "zh") assertMatch(s.texto!, /老板/);
    if (idioma === "en") assertMatch(s.texto!, /owner/i);
    if (idioma === "es") assertMatch(s.texto!, /dueño/);
    assert(s.traduccion_es && /dueño/.test(s.traduccion_es));
  });
}

Deno.test("el modelo marca pide_compromiso aunque la regla no lo vea: frena con texto neutro", async () => {
  const { deps } = doble({
    texto: JSON.stringify({
      traduccion_entrante_es: "Para seguir necesitamos su compromiso.",
      pide_compromiso: "compra",
      responder: true,
      respuesta: "Sure, we will order now.",
      respuesta_es: "Sí, pedimos ya.",
      cotizacion: null,
    }),
  });
  const s = await responderProveedor(entrada("To move forward we need your commitment."), deps);
  assertEquals([s.frena, s.motivo, s.responder], [true, "compra", true]);
  assertMatch(s.texto!, /owner/i);
  assert(!/order now/.test(s.texto!));
});

// ---------- tope, interruptor, doble freno ----------

Deno.test("tope de IA alcanzado: no llama a la IA, no responde y frena con tope_ia", async () => {
  const { deps, estado } = doble({ texto: JSON_BUENO, gasto: 10 });
  const s = await responderProveedor(entrada("Hello, price is 1.2 USD"), deps);
  assertEquals(estado.llamadas, 0);
  assertEquals([s.responder, s.frena, s.motivo, s.texto, s.costo_usd], [false, true, "tope_ia", null, 0]);
  const p = await redactarPrimerContacto(
    { canal: "email", proveedor: entrada("").proveedor, candidato: { id: "c", nombre: "Demo" }, pedido: "precio", ahora: new Date() },
    deps,
  );
  assertEquals(estado.llamadas, 0);
  assertEquals([p.responder, p.motivo], [false, "tope_ia"]);
});

Deno.test("gasto ilegible: tampoco llama a la IA", async () => {
  const { deps, estado } = doble({ texto: JSON_BUENO });
  deps.gastoMesUsd = () => Promise.reject(new Error("base caída"));
  const s = await responderProveedor(entrada("Hello"), deps);
  assertEquals(estado.llamadas, 0);
  assertEquals([s.responder, s.frena], [false, true]);
});

Deno.test("interruptor apagado: no llama a la IA ni responde", async () => {
  const { deps, estado } = doble({ texto: JSON_BUENO, cfg: { activo: false } });
  const s = await responderProveedor(entrada("Hello"), deps);
  assertEquals(estado.llamadas, 0);
  assertEquals([s.responder, s.frena, s.motivo], [false, false, "apagado"]);
});

Deno.test("doble freno: si el modelo escribe algo que compromete, no sale", async () => {
  const { deps } = doble({
    texto: JSON.stringify({
      traduccion_entrante_es: "¿Cuántas quieren?",
      pide_compromiso: null,
      responder: true,
      respuesta: "We confirm the order of 1000 pcs, payment sent.",
      respuesta_es: "Confirmamos.",
      cotizacion: null,
    }),
  });
  const s = await responderProveedor(entrada("How many pcs do you want?"), deps);
  assertEquals([s.responder, s.frena, s.texto], [false, true, null]);
  assertMatch(s.motivo!, /^bloqueo_salida_/);
});

Deno.test("sin producto: arma el borrador pero no responde y frena con sin_producto", async () => {
  const { deps } = doble({ texto: JSON_BUENO });
  const s = await responderProveedor(entrada("Hello, price is 1.2 USD", { candidato: null }), deps);
  assertEquals([s.responder, s.frena, s.motivo], [false, true, "sin_producto"]);
  assert(s.texto);
});

Deno.test("respuesta normal: responde, traduce, carga la cotización y el costo", async () => {
  const { deps, estado } = doble({ texto: JSON_BUENO });
  const s = await responderProveedor(entrada("Hello, price is 1.2 USD for 500 pcs, FOB."), deps);
  assertEquals([s.responder, s.frena, s.motivo, s.idioma], [true, false, null, "en"]);
  assertMatch(s.texto!, /carton size/);
  assertEquals(s.traduccion_entrante_es, "Hola, el precio es USD 1,20 por unidad.");
  assertEquals(s.cotizacion?.escalones, [{ cantidad: 500, precio_unit_minor: 120 }]);
  assertEquals(s.cotizacion?.completa, false);
  assertEquals(s.costo_usd, 0.0019);
  assertEquals(s.modelo, "claude-haiku-4-5");
  // El prompt fijo no lleva datos variables; firma y producto van aparte; se pide JSON con esquema.
  const p = estado.pedido!;
  assert(Array.isArray(p.system) && p.system.length === 2);
  assert(!(p.system[0] as { text: string }).text.includes("Producto demo"));
  assert((p.system[1] as { text: string }).text.includes("Voltra (Paraguay)"));
  assert(p.esquemaJson);
  assertEquals(p.modelo, "claude-haiku-4-5");
});

Deno.test("la dirección del depósito sale de config y solo va en la parte variable", async () => {
  const { deps, estado } = doble({ texto: JSON_BUENO, cfg: { direccion_deposito: "DEPOSITO DEMO 123" } });
  await responderProveedor(entrada("Hello"), deps);
  const sys = estado.pedido!.system as Array<{ text: string }>;
  assert(!sys[0].text.includes("DEPOSITO DEMO 123"));
  assert(sys[1].text.includes("DEPOSITO DEMO 123"));
});

Deno.test("error de la IA: no responde, frena con error_ia y guarda el original como traducción", async () => {
  const { deps } = doble({ falla: true });
  const s = await responderProveedor(entrada("Hello, price?"), deps);
  assertEquals([s.responder, s.frena, s.motivo], [false, true, "error_ia"]);
  assertEquals(s.traduccion_entrante_es, "Hello, price?");
});

Deno.test("error de la IA con pedido de pago: igual sale el texto neutro", async () => {
  const { deps } = doble({ falla: true });
  const s = await responderProveedor(entrada("Please pay the deposit today."), deps);
  assertEquals([s.responder, s.frena, s.motivo], [true, true, "pago"]);
  assertMatch(s.texto!, /owner/i);
});

Deno.test("JSON ilegible del modelo: no responde y frena", async () => {
  const { deps } = doble({ texto: "Sure! Here is my answer: {respuesta: 'hi'" });
  const s = await responderProveedor(entrada("Hello"), deps);
  assertEquals([s.responder, s.frena, s.motivo], [false, true, "respuesta_ilegible"]);
});

// ---------- parseo robusto ----------

Deno.test("parsearSalidaModelo: basura, parcial, con cercas o texto alrededor", () => {
  assertEquals(parsearSalidaModelo(""), null);
  assertEquals(parsearSalidaModelo("no json here"), null);
  assertEquals(parsearSalidaModelo('{"respuesta": "hola", "responder": tr'), null);
  assertEquals(parsearSalidaModelo("[1,2,3]"), null);
  assertEquals(parsearSalidaModelo("null"), null);
  const a = parsearSalidaModelo("```json\n" + JSON_BUENO + "\n```");
  assertEquals(a?.responder, true);
  const b = parsearSalidaModelo("Here you go:\n" + JSON_BUENO + "\nThanks!");
  assertEquals(b?.respuesta_es, "Gracias. ¿Nos pasan el peso empacado, la caja y el plazo de despacho?");
  // Tipos raros: se corrigen o se descartan sin romper.
  const c = parsearSalidaModelo('{"responder": "yes", "respuesta": 5, "pide_compromiso": "cualquiera", "traduccion_entrante_es": null}');
  assertEquals(c?.responder, false);
  assertEquals(c?.respuesta, null);
  assertEquals(c?.pide_compromiso, null);
  assertEquals(c?.traduccion_entrante_es, null);
});

// ---------- idioma ----------

Deno.test("elegirIdioma: config del proveedor, si no detecta; desconocido → en", () => {
  assertEquals(elegirIdioma({ idioma: "zh", plataforma: null }, "Hello"), "zh");
  assertEquals(elegirIdioma({ idioma: null, plataforma: null }, "你好，价格是多少？"), "zh");
  assertEquals(elegirIdioma({ idioma: null, plataforma: null }, "Hello, what is the MOQ?"), "en");
  assertEquals(elegirIdioma({ idioma: null, plataforma: null }, "Hola, ¿cuánto cuesta el envío?"), "es");
  assertEquals(elegirIdioma({ idioma: null, plataforma: null }, "👍 123"), "en");
  assertEquals(elegirIdioma({ idioma: null, plataforma: null }, ""), "en");
  assertEquals(elegirIdioma({ idioma: null, plataforma: "1688" }, ""), "zh");
});

// ---------- cotización ----------

Deno.test("normalizarCotizacion: completa solo con precio + peso + caja + días", () => {
  const base = {
    moneda: "usd",
    escalones: [{ cantidad: 500, precio_unit: 1.2 }, { cantidad: 1000, precio_unit: 1.05 }],
    peso_bruto_g: 120,
    medidas_caja_cm: "40x30x20",
    unidades_por_caja: 100,
    plazo_dias: 7,
  };
  const c = normalizarCotizacion(base)!;
  assertEquals(c.completa, true);
  assertEquals(c.moneda, "USD");
  assertEquals(c.escalones, [{ cantidad: 500, precio_unit_minor: 120 }, { cantidad: 1000, precio_unit_minor: 105 }]);
  assertEquals(Object.keys(c).sort(), [
    "completa", "costo_muestra_minor", "escalones", "incoterm", "medidas_caja_cm", "moneda", "moq", "peso_bruto_g", "plazo_dias", "unidades_por_caja",
  ]);
  assertEquals(normalizarCotizacion({ ...base, escalones: [] })?.completa, false);
  assertEquals(normalizarCotizacion({ ...base, peso_bruto_g: null })?.completa, false);
  assertEquals(normalizarCotizacion({ ...base, medidas_caja_cm: null })?.completa, false);
  assertEquals(normalizarCotizacion({ ...base, plazo_dias: null })?.completa, false);
  // Moneda: RMB → CNY; guaraníes sin decimales.
  assertEquals(normalizarCotizacion({ ...base, moneda: "RMB", escalones: [{ cantidad: 100, precio_unit: 8.5 }] })?.escalones, [{ cantidad: 100, precio_unit_minor: 850 }]);
  assertEquals(normalizarCotizacion({ ...base, moneda: "PYG", escalones: [{ cantidad: 10, precio_unit: 15000 }] })?.escalones, [{ cantidad: 10, precio_unit_minor: 15000 }]);
  // Escalones inválidos se descartan; sin nada útil → null.
  assertEquals(normalizarCotizacion({ escalones: [{ cantidad: -1, precio_unit: 2 }, { cantidad: 10, precio_unit: "x" }] }), null);
  assertEquals(normalizarCotizacion(null), null);
  assertEquals(normalizarCotizacion("basura"), null);
});

// ---------- config ----------

Deno.test("configProveedoresDesde: ilegible → activo false; texto JSON o objeto", () => {
  for (const v of [null, undefined, "", "{no json", 42, [], "[]"]) assertEquals(configProveedoresDesde(v).activo, false, String(v));
  const c = configProveedoresDesde('{"activo": true, "tope_ia_usd_mes": 7, "tope_plantillas_mes": 20, "modelo": "claude-haiku-4-5", "direccion_deposito": " Demo 1 ", "firma": "Voltra"}');
  assertEquals(c, { activo: true, tope_ia_usd_mes: 7, tope_plantillas_mes: 20, modelo: "claude-haiku-4-5", direccion_deposito: "Demo 1", firma: "Voltra" });
  assertEquals(configProveedoresDesde({ activo: "true" }).activo, false);
  const d = configProveedoresDesde({ activo: true, tope_ia_usd_mes: -3 });
  assertEquals([d.activo, d.tope_ia_usd_mes, d.tope_plantillas_mes, d.modelo, d.direccion_deposito, d.firma], [true, 10, 30, "claude-haiku-4-5", null, "Voltra (Paraguay)"]);
});

// ---------- modo simulado real de claude.ts (sin red) ----------

Deno.test("modo simulado de llamarClaude: respuesta determinista y sin costo", async () => {
  _configurarClaude({ modoSimulado: () => true, fetch: () => Promise.reject(new Error("sin red en pruebas")) });
  try {
    const deps: DepsAgente = { llamar: llamarClaude, gastoMesUsd: () => Promise.resolve(0), config: () => Promise.resolve(CFG) };
    const a = await responderProveedor(entrada("你好，这个产品价格是多少？"), deps);
    const b = await responderProveedor(entrada("你好，这个产品价格是多少？"), deps);
    assertEquals(a, b);
    assertEquals([a.responder, a.frena, a.idioma, a.costo_usd], [true, false, "zh", 0]);
    assertEquals(textoCompromete(a.texto!), null);
    const p = await redactarPrimerContacto(
      { canal: "email", proveedor: { id: "p", nombre: null, idioma: "en", plataforma: "alibaba" }, candidato: { id: "c", nombre: "Producto demo" }, pedido: "Precio por 500 y 1000", ahora: new Date() },
      deps,
    );
    assertEquals([p.responder, p.frena, p.idioma, p.traduccion_entrante_es], [true, false, "en", ""]);
    assert(p.texto && p.traduccion_es);
  } finally {
    _configurarClaude();
  }
});

// 21-11: prueba real con Gmail: "Carton: 100 units, 8 kg" se guardó como 8000 g por unidad (la pantalla lo multiplica por
// las unidades: flete ×100). Ahora peso_bruto_g es siempre por unidad.
Deno.test("peso por unidad: el peso de la caja se divide por las unidades de la caja", async () => {
  const { normalizarCotizacion, pesoPorUnidad } = await import("./agente.ts");
  assertEquals(pesoPorUnidad({ peso_caja_kg: 8, unidades_por_caja: 100 }), 80);
  assertEquals(pesoPorUnidad({ peso_unidad_g: 85, peso_caja_kg: 8, unidades_por_caja: 100 }), 85);
  assertEquals(pesoPorUnidad({ peso_caja_kg: 8 }), null);
  const c = normalizarCotizacion({ moneda: "USD", escalones: [{ cantidad: 1000, precio_unit: 1.2 }], moq: 500, peso_unidad_g: null, peso_caja_kg: 8, unidades_por_caja: 100, medidas_caja_cm: "50x40x35", plazo_dias: 7, costo_muestra: null, incoterm: null });
  assertEquals(c?.peso_bruto_g, 80);
  assertEquals(c?.completa, true);
});
