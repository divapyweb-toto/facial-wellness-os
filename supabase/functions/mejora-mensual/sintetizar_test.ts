// Tests de sintetizar.ts (sin red: Claude falso o modo determinista). Datos inventados.
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { PedidoClaude, RespuestaClaude } from "../_shared/claude.ts";
import {
  agregar,
  type ConvClasificada,
  ESQUEMA_SINTESIS,
  extraerJson,
  hayDatosSuficientes,
  pareceDatoPersonal,
  sintetizar,
  validarSalida,
} from "./sintetizar.ts";
import type { Etiquetas, Resultado } from "./tipos.ts";

export function etq(p: Partial<Etiquetas> = {}): Etiquetas {
  return {
    etapa: "objecion",
    objecion_principal: null,
    respuesta_que_movio: null,
    errores_bot: [],
    reclamo: { hubo: false, tipo: null, paso_resuelto: null, derivado: false },
    emocion: "neutral",
    debio_derivar: false,
    ...p,
  };
}

let n = 0;
export function conv(resultado: Resultado, e: Partial<Etiquetas> = {}, extra: Partial<ConvClasificada> = {}): ConvClasificada {
  return { conversacion_id: `c${++n}`, resultado, etiquetas: etq(e), ...extra };
}

/** Mes fuerte: 30 "caro" (20 → "pack de 2"), 12 "no confío", 4 "lo pienso" (débil). */
export function mesFuerte(): ConvClasificada[] {
  const out: ConvClasificada[] = [];
  for (let i = 0; i < 20; i++) out.push(conv(i < 14 ? "entregado" : "rechazado", { objecion_principal: "caro", respuesta_que_movio: "pack de 2" }));
  for (let i = 0; i < 10; i++) out.push(conv(i < 3 ? "entregado" : "sin_compra", { objecion_principal: "caro", respuesta_que_movio: "envio incluido" }));
  for (let i = 0; i < 12; i++) out.push(conv(i < 6 ? "entregado" : "sin_compra", { objecion_principal: "no confío", respuesta_que_movio: "video real" }));
  for (let i = 0; i < 4; i++) out.push(conv("entregado", { objecion_principal: "lo pienso" }));
  for (let i = 0; i < 11; i++) out.push(conv("sin_compra", { etapa: "reclamo", debio_derivar: true }));
  return out;
}

const respuesta = (texto: string, costo = 0.05): RespuestaClaude => ({
  contenido: [{ type: "text", text: texto }],
  stop_reason: "end_turn",
  uso: { entrada: 1000, salida: 500, cache_lectura: 0, cache_escritura: 0 },
  costo_usd: costo,
  simulado: false,
  modelo: "claude-sonnet-5-5",
});

Deno.test("agregar: tasa contra ENTREGADO (no venta), en_curso fuera del denominador, dato débil < 10", () => {
  const convs = [
    ...Array.from({ length: 8 }, () => conv("entregado", { objecion_principal: "Caro " })),
    ...Array.from({ length: 2 }, () => conv("rechazado", { objecion_principal: "caro" })),
    ...Array.from({ length: 5 }, () => conv("en_curso", { objecion_principal: "caro" })),
    conv("devuelto", { objecion_principal: "envio" }),
  ];
  const a = agregar(convs, { mes: "2026-09-01" });
  assertEquals(a.mes, "2026-09-01");
  assertEquals(a.n_conversaciones, 16);
  const caro = a.por_objecion["caro"];
  assertEquals(caro.n, 15);
  assertEquals(caro.entregados, 8);
  assertEquals(caro.tasa_entrega, 0.8); // 8 / (15 − 5 en curso); un rechazado cuenta como NO entregado
  assertEquals(caro.dato_debil, false);
  assertEquals(a.por_objecion["envio"].dato_debil, true);
  assertEquals(a.tasa_entrega_global, Math.round((8 / 11) * 1000) / 1000);
});

Deno.test("agregar: reclamos por paso, casos que debieron derivarse y errores del bot", () => {
  const a = agregar([
    conv("entregado", { etapa: "reclamo", reclamo: { hubo: true, tipo: "se despega", paso_resuelto: 2, derivado: false } }),
    conv("entregado", { etapa: "reclamo", reclamo: { hubo: true, tipo: "dañado", paso_resuelto: null, derivado: true } }),
    conv("sin_compra", { debio_derivar: true, etapa: "reclamo" }),
    conv("sin_compra", { debio_derivar: true, etapa: "reclamo" }, { derivado: true }), // sí se derivó: no cuenta
    conv("sin_compra", { errores_bot: ["dos preguntas", "dos preguntas", "lista larga"] }),
  ]);
  assertEquals(a.reclamos.total, 2);
  assertEquals(a.reclamos.por_paso["2"].n, 1);
  assertEquals(a.reclamos.por_paso["sin_resolver"].n, 1);
  assertEquals(a.reclamos.derivados, 1);
  assertEquals(a.debio_derivar["reclamo"].n, 1);
  assertEquals(a.errores_bot["dos preguntas"].n, 1); // una vez por conversación
});

Deno.test("ejemplos: cortos y sin datos personales (defensa extra sobre anonimizar)", () => {
  assert(pareceDatoPersonal("mi número es 0981 000 000"));
  assert(pareceDatoPersonal("escribime a cliente@ejemplo.test"));
  assert(!pareceDatoPersonal("soy [NOMBRE_1], mi tel [TEL_1], pedido [PEDIDO_1]"));
  const largo = "a".repeat(500);
  const a = agregar([
    conv("entregado", { objecion_principal: "caro" }, { ejemplo: { cliente: "llamame al 0981000000", vendedor: "dale" } }),
    conv("entregado", { objecion_principal: "caro" }, { ejemplo: { cliente: largo, vendedor: "Te entiendo, [NOMBRE_1]." } }),
  ]);
  assertEquals(a.por_objecion["caro"].ejemplos.length, 1);
  assert(a.por_objecion["caro"].ejemplos[0].cliente.length <= 160);
});

Deno.test("datos débiles: sin ningún grupo ≥ 10 no se llama a Claude y no hay conclusiones", async () => {
  const a = agregar(Array.from({ length: 9 }, () => conv("entregado", { objecion_principal: "caro", respuesta_que_movio: "pack" })));
  assertEquals(hayDatosSuficientes(a), false);
  let llamadas = 0;
  const h = await sintetizar(a, { llamar: () => (llamadas++, Promise.resolve(respuesta("{}"))) });
  assertEquals(llamadas, 0);
  assertEquals(h.sin_datos_suficientes, true);
  assertEquals(h.analisis, []);
  assertEquals(h.costo_usd, 0);
});

Deno.test("sintetizar con Claude falso: n y tasa salen de los agregados; dato débil ⇒ sin sugerencia; grupo inventado ⇒ descartado", async () => {
  const a = agregar(mesFuerte());
  let pedido: PedidoClaude | null = null;
  const salida = {
    resumen: "El pack de 2 entrega más.",
    conclusiones: [
      { dimension: "por_objecion_respuesta", clave: "caro → pack de 2", texto: "El pack entrega 70 %", n: 999, sugerencia: { tipo: "ejemplo", detalle: "modelo", contenido: { cliente: "muy caro", vendedor: "Con 2 bolsas pagás un solo envío. ¿Te armo el de 2?" } } },
      { dimension: "por_objecion", clave: "lo pienso", texto: "pocos casos", sugerencia: { tipo: "faq", detalle: "x", contenido: { pregunta: "p", respuesta: "r" } } },
      { dimension: "por_objecion", clave: "no existe", texto: "inventado", sugerencia: null },
    ],
  };
  const h = await sintetizar(a, {
    llamar: (p) => {
      pedido = p;
      return Promise.resolve(respuesta("```json\n" + JSON.stringify(salida) + "\n```", 0.08));
    },
  });
  assertEquals(pedido!.modelo, "claude-sonnet-5-5");
  // Nunca conversaciones crudas: solo el JSON de agregados.
  const enviado = String(pedido!.mensajes[0].content);
  assert(enviado.startsWith("Agregados del mes (JSON):"));
  assert(!enviado.includes("transcripcion"));
  assertEquals(h.analisis.length, 2);
  assertEquals(h.analisis[0].n, 20); // del agregado, no el 999 del modelo
  assertEquals(h.analisis[0].tasa_entrega, 0.7);
  assert(h.analisis[0].sugerencia !== null);
  assertEquals(h.analisis[1].dato_debil, true);
  assertEquals(h.analisis[1].sugerencia, null);
  assertEquals(h.descartadas.map((d) => d.motivo), ["grupo_inexistente"]);
  assert(h.conclusiones[1].startsWith("[dato débil]"));
  assertEquals(h.costo_usd, 0.08);
  assertEquals(h.objeciones[0].clave, "caro"); // campos de Hallazgos (tipos.ts)
  assertEquals(h.reclamos.debio_derivar_y_no, 11);
});

Deno.test("sintetizar: JSON inválido ⇒ un reintento; dos inválidos ⇒ error con el costo", async () => {
  const a = agregar(mesFuerte());
  const textos = ["no es json", JSON.stringify({ resumen: "ok", conclusiones: [] })];
  let i = 0;
  const h = await sintetizar(a, { llamar: () => Promise.resolve(respuesta(textos[i++], 0.05)) });
  assertEquals(i, 2);
  assertEquals(h.costo_usd, 0.1);
  await assertRejects(() => sintetizar(a, { llamar: () => Promise.resolve(respuesta("nada")) }), Error, "2 intentos");
});

Deno.test("modo simulado: síntesis determinista sin red (orden de objeciones y derivación)", async () => {
  const h = await sintetizar(agregar(mesFuerte()), { simulado: true });
  assertEquals(h.simulado, true);
  assertEquals(h.costo_usd, 0);
  const tipos = h.analisis.map((c) => c.sugerencia?.tipo ?? null);
  assert(tipos.includes("orden_objeciones"));
  assert(tipos.includes("derivacion"));
  const orden = h.analisis.find((c) => c.sugerencia?.tipo === "orden_objeciones")!.sugerencia!.contenido.orden;
  assertEquals(orden, ["caro", "no confío"]); // "lo pienso" es dato débil
});

Deno.test("extraerJson y validarSalida toleran ruido y rechazan formas malas", () => {
  assertEquals(extraerJson('Acá va: {"a": 1} listo'), { a: 1 });
  assertEquals(extraerJson("nada"), null);
  const a = agregar(mesFuerte());
  assertEquals(validarSalida({ resumen: "x" }, a), null);
  const v = validarSalida({ conclusiones: [{ dimension: "por_objecion", clave: "caro", texto: "t", sugerencia: { tipo: "inventado" } }] }, a)!;
  assertEquals(v.analisis[0].sugerencia, null);
  assertEquals(v.descartadas[0].motivo, "sugerencia_invalida");
});

Deno.test("sintetizar: pide salida estructurada y, si la API rechaza el esquema (400), sigue sin él", async () => {
  const { ErrorClaude } = await import("../_shared/claude.ts");
  const a = agregar(mesFuerte());
  const pedidos: PedidoClaude[] = [];
  const h = await sintetizar(a, {
    llamar: (p) => {
      pedidos.push(p);
      if (p.esquemaJson) return Promise.reject(new ErrorClaude("HTTP 400 invalid_request_error: schema", 400));
      return Promise.resolve(respuesta(JSON.stringify({ resumen: "ok", conclusiones: [] }), 0.01));
    },
  });
  assertEquals(pedidos.length, 2);
  assertEquals(pedidos[0].esquemaJson, ESQUEMA_SINTESIS);
  assertEquals(pedidos[1].esquemaJson, undefined);
  assertEquals(h.resumen, "ok");
  const txt = JSON.stringify(ESQUEMA_SINTESIS);
  for (const k of ["minLength", "maxLength", "minimum", "maximum"]) assertEquals(txt.includes(k), false, k);
});
