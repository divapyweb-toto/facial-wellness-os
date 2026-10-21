import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { accionInventada, contarEmojis, extraerMontos, montosDeResultado, quitarFrasesConMontos, quitarPromesaRecontacto, revisarRespuesta } from "./filtro_salida.ts";

const PROHIBIDAS = ["garantía", "devolución", "reembolso", "sin riesgo", "cura", "curar", "tratamiento", "oxígeno"];
const CATALOGO = [79000, 33000, 112000, 125000, 158000];
const op = { catalogo: CATALOGO, prohibidas: PROHIBIDAS, afirmaciones: ["Pagás al recibir"] };

Deno.test("filtro: respuesta correcta pasa (precio, envío y total del catálogo)", () => {
  const r = revisarRespuesta("Las tiras salen Gs 79.000 + envío Gs 33.000 = Gs 112.000, pagás al recibir. ¿Te las preparo?", op);
  assertEquals(r, { ok: true, motivos: [] });
});

for (const [texto, palabra] of [
  ["Tiene garantía de 30 días, ¿te lo mando?", "garantía"],
  ["Si no te gusta hay devolución sin problema.", "devolución"],
  ["Te hacemos el reembolso si no funciona.", "reembolso"],
  ["Es una compra sin riesgo, pagás al recibir.", "sin riesgo"],
  ["Esto te cura el ronquido.", "cura"],
  ["No hay devoluciones, pero podés probarlo.", "devolución"],
] as const) {
  Deno.test(`filtro: bloquea "${palabra}"`, () => {
    const r = revisarRespuesta(texto, op);
    assertFalse(r.ok);
    assert(r.motivos.includes(`palabra_prohibida:${palabra}`), r.motivos.join());
  });
}

Deno.test("filtro: precio inventado con puntos, sin puntos, con Gs y en 'mil' se bloquea", () => {
  for (const t of ["Sale 70.000", "Sale 70000", "Sale Gs 70000", "Sale ₲70.000", "Te sale 70 mil nomás", "Son 70k"]) {
    const r = revisarRespuesta(t, op);
    assertFalse(r.ok, t);
    assert(r.motivos.some((m) => m.startsWith("precio_no_catalogo:70000")), `${t}: ${r.motivos}`);
  }
});

Deno.test("filtro: precio del catálogo escrito sin puntos o en 'mil' pasa", () => {
  assert(revisarRespuesta("Sale 79000, pagás al recibir.", op).ok);
  assert(revisarRespuesta("Sale 79 mil + 33 mil de envío.", op).ok);
  assert(revisarRespuesta("El de 2 sale 125,000.", op).ok);
});

Deno.test("filtro: teléfonos, años, horas, fechas, cantidades y pedidos no cuentan como precio", () => {
  assertEquals(extraerMontos("Escribime al 0981 000 000 o +595981000000"), []);
  assertEquals(extraerMontos("Llega el sábado 10/10/2026 a las 15:30"), []);
  assertEquals(extraerMontos("Tu pedido #1050 de 30 unidades x2"), []);
  assertEquals(extraerMontos("En 2026 lanzamos más productos"), []);
  assertEquals(extraerMontos("El ×3 155.000"), [155000]);
});

Deno.test("filtro: más de 3 líneas, más de 1 pregunta, más de 1 emoji", () => {
  const r1 = revisarRespuesta("Hola\nSale Gs 79.000\nEnvío Gs 33.000\nTotal Gs 112.000", op);
  assert(r1.motivos.some((m) => m.startsWith("mas_de_3_lineas")));
  const r2 = revisarRespuesta("¿Para vos? ¿Te lo mando?", op);
  assert(r2.motivos.some((m) => m.startsWith("mas_de_1_pregunta")));
  const r3 = revisarRespuesta("¡Dale! 😊🙌", op);
  assert(r3.motivos.some((m) => m.startsWith("mas_de_1_emoji")));
  assertEquals(contarEmojis("Listo 👍"), 1);
});

Deno.test("filtro: promesas de salud se bloquean; 'consultalo con tu médico' no", () => {
  const r = revisarRespuesta("Con esto dejás de roncar desde la primera noche.", op);
  assert(r.motivos.some((m) => m.startsWith("promesa_salud")));
  assert(revisarRespuesta("Eso te conviene consultarlo con tu médico. Te paso con Enrique.", op).ok);
});

Deno.test("filtro: respuesta vacía no pasa", () => {
  assertEquals(revisarRespuesta("   ", op), { ok: false, motivos: ["respuesta_vacia"] });
});

Deno.test("montosDeResultado junta números y montos escritos del resultado de una herramienta", () => {
  const m = montosDeResultado({ productos: [{ precio: 79000, total_texto: "112.000", ofertas: [{ precio: 125000 }] }], envio: 33000, cantidad: 2 });
  assertEquals(m.sort(), [112000, 125000, 33000, 79000].sort());
});

// ---------- que no suene a bot ----------

const motivosDe = (t: string, extra: Record<string, unknown> = {}) => revisarRespuesta(t, { ...op, ...extra }).motivos;

Deno.test("filtro: muletillas de bot se bloquean (con y sin tildes)", () => {
  for (
    const [t, m] of [
      ["¡Claro! Te paso el precio.", "¡claro"],
      ["Claro! Ya te digo.", "claro!"],
      ["Por supuesto, te lo mando.", "por supuesto"],
      ["Como asistente de Voltra te recomiendo las tiras.", "como asistente"],
      ["Estoy aquí para ayudarte con tu pedido.", "estoy aqui para ayudar"],
      ["No dudes en escribirme.", "no dudes en"],
      ["Listo. ¿Hay algo más en lo que pueda ayudarte?", "algo mas en lo que pueda ayudar"],
      ["Hola, ¿en qué puedo ayudarte?", "en que puedo ayudarte"],
      ["Entiendo tu preocupación, pagás al recibir.", "entiendo tu preocupacion"],
      ["Excelente pregunta: se usan de noche.", "excelente pregunta"],
    ] as const
  ) {
    assert(motivosDe(t).includes(`muletilla_bot:${m}`), `${t}: ${motivosDe(t)}`);
  }
  // Lo natural pasa.
  for (const t of ["Dale, te paso el precio. ¿Es para vos?", "Mirá, las tiras se ponen en segundos.", "Claro que sí llega a Encarnación."]) {
    assertEquals(motivosDe(t), [], t);
  }
});

Deno.test("filtro: markdown (negrita doble, viñetas, listas, títulos, enlaces) se bloquea; *una* palabra no", () => {
  assert(motivosDe("Las **tiras** son lo mejor.").includes("markdown:negrita_doble"));
  assert(motivosDe("Tenemos:\n- tiras\n- parches").includes("markdown:vinetas"));
  assert(motivosDe("Pasos:\n1. Limpiá la nariz\n2. Pegá la tira").some((m) => m.startsWith("markdown:")));
  assert(motivosDe("## Precios").includes("markdown:titulo"));
  assert(motivosDe("Mirá [el video](https://x.test)").includes("markdown:enlace_markdown"));
  assertFalse(motivosDe("Pagás *al recibir*.").some((m) => m.startsWith("markdown")));
});

Deno.test("filtro: saludo vacío como primera línea y '¡' al inicio de cada frase", () => {
  assertFalse(motivosDe("¡Hola!\n¿Buscás algo para dormir?").includes("saludo_vacio"));
  assertFalse(motivosDe("Buenas!\n¿Qué producto viste?").includes("saludo_vacio"));
  assert(motivosDe("Hola Ana 👋").includes("saludo_vacio"));
  assert(motivosDe("Holaa\nBuenas").includes("saludo_vacio"));
  assert(motivosDe("Buenas, ¿cómo estás?").includes("saludo_vacio"));
  assertFalse(motivosDe("Hola Ana, te llega en 2 a 5 días hábiles. ¿Es para vos?").includes("saludo_vacio"));
  assertFalse(motivosDe("Hola. Las tiras abren la nariz.").includes("saludo_vacio"));
  assert(motivosDe("¡Genial! ¡Te lo mando hoy!").includes("exclamaciones_de_bot"));
  assertFalse(motivosDe("¡Buenísimo! Te lo preparo.").includes("exclamaciones_de_bot"));
});

Deno.test("filtro: urgencia, stock o reseñas inventadas se bloquean", () => {
  for (const t of ["Quedan pocas, aprovechá.", "Son las últimas unidades.", "Solo por hoy a ese precio.", "Es el más vendido.", "Mirá las reseñas de clientes."]) {
    assert(motivosDe(t).some((m) => m.startsWith("urgencia_inventada")), t);
  }
});

Deno.test("filtro honestidad: nunca niega ser asistente; si preguntan lo dice; si no preguntan no se anuncia", () => {
  assert(motivosDe("No soy un bot, soy Ana.").some((m) => m.startsWith("niega_ser_asistente")));
  assert(motivosDe("Soy una persona del equipo.").some((m) => m.startsWith("niega_ser_asistente")));
  const honesta = "Soy el asistente virtual de Voltra. Si preferís, te paso con Enrique, ¿querés?";
  assertEquals(motivosDe(honesta, { preguntaBot: true }), []);
  assert(motivosDe("Soy Ana, del equipo. ¿Qué buscás?", { preguntaBot: true }).includes("honestidad:falta_asistente_virtual"));
  assert(motivosDe(honesta).some((m) => m.startsWith("se_anuncia_como_ia")));
});

Deno.test("filtro cierre: '¿qué te frena?' una sola vez por conversación", () => {
  assertEquals(motivosDe("Dale. ¿Qué te frena?"), []);
  assert(motivosDe("Dale. ¿Qué te frena?", { yaPreguntoFreno: true }).includes("insiste_que_te_frena"));
});

Deno.test("filtro: listas configurables desde config_wa.vendedor_estilo", () => {
  assert(motivosDe("Joya, te paso.", { muletillas: ["joya"] }).includes("muletilla_bot:joya"));
  assertEquals(motivosDe("¡Claro! Te paso.", { muletillas: [] }).filter((m) => m.startsWith("muletilla")), []);
});

// ---------- 19-10 (paquete 1, punto 2): acciones inventadas ----------

Deno.test("acción inventada: #1072 '¿Te lo cambio a 2?' sin herramienta → bloqueado; con modificar_pedido ok pasa", () => {
  const t = "Los 2 salen 158.000 con envío gratis. ¿Te lo cambio a 2?";
  const r = revisarRespuesta(t, { ...op, accionesHechas: [] });
  assertFalse(r.ok);
  assert(r.motivos.some((m) => m.startsWith("accion_inventada:cambio:")), r.motivos.join());
  assert(revisarRespuesta(t, { ...op, accionesHechas: ["modificar_pedido"] }).ok);
});

Deno.test("acción inventada: cambiar / agregar / cancelar / programar sin la herramienta que lo hace", () => {
  const casos: Array<[string, string, string]> = [
    ["Listo, ya lo cambié a 2 unidades.", "cambio", "modificar_pedido"],
    ["Ya quedó modificado tu pedido.", "cambio", "modificar_pedido"],
    ["Ya te agregué el raspador al pedido.", "agregado", "modificar_pedido"],
    ["Listo, lo agregué.", "agregado", "guardar_factura"],
    ["Ya lo cancelé, no te preocupes.", "cancelacion", "modificar_pedido"],
    ["Tu pedido quedó cancelado.", "cancelacion", "estado_pedido"],
    ["Quedó programado para el jueves.", "programacion", "programar_entrega"],
    ["Ya cambié la dirección.", "cambio", "actualizar_direccion"],
  ];
  for (const [t, accion, herr] of casos) {
    const inv = accionInventada(t, []);
    assert(inv?.startsWith(`${accion}:`), `${t} → ${inv}`);
    assertEquals(accionInventada(t, [herr]), null, `${t} con ${herr}`);
  }
});

Deno.test("acción inventada: 'quedó confirmado' solo con crear_pedido_cod confirmar=true, estado_pedido, pedido ya creado o marca del sistema", () => {
  const t = "Listo, quedó confirmado. Te llega el jueves.";
  assert(accionInventada(t, [])?.startsWith("confirmacion:"));
  assert(accionInventada(t, ["crear_pedido_cod"])?.startsWith("confirmacion:"), "el resumen (confirmar=false) no confirma nada");
  for (const h of ["crear_pedido_cod:confirmar", "estado_pedido", "pedido_ya_creado", "pedido_confirmado_sistema"]) {
    assertEquals(accionInventada(t, [h]), null, h);
  }
});

Deno.test("acción inventada: negaciones, ofertas de confirmar y frases normales no se marcan", () => {
  for (const t of [
    "No lo cambié todavía: eso lo ve Enrique.",
    "Eso no lo puedo cambiar desde acá, pero te armo un pedido nuevo con 2. ¿Te parece?",
    "¿Te lo confirmo así?",
    "Las tiras salen Gs 79.000, pagás al recibir.",
    "Cambiar la dirección lo hace Enrique; te paso con él.",
  ]) {
    assertEquals(accionInventada(t, []), null, t);
  }
});

Deno.test("acción inventada: sin accionesHechas (textos fijos, tests viejos) no se revisa", () => {
  assert(revisarRespuesta("Ya lo cambié.", op).ok);
});

Deno.test("19-10 promesa de recontacto otro día → bloqueada; avisos del pedido y 'cuando quieras' no", () => {
  const op = { preciosValidos: [], palabrasProhibidas: [], promesasSalud: [] } as unknown as Parameters<typeof revisarRespuesta>[1];
  for (const t of ["Dale, tranqui. El viernes 30/10 te escribo y te lo armo.", "Dale, el jueves 5/11 te escribo.", "Mañana te escribo para armarlo.", "Te escribo el lunes y lo vemos."]) {
    assert(revisarRespuesta(t, op).motivos.some((m) => m.startsWith("promesa_recontacto:")), t);
  }
  for (const t of ["Cuando estés listo escribime por acá y lo armamos.", "Te avisamos por acá cuando salga.", "Llega en unos días, te aviso."]) {
    assertFalse(revisarRespuesta(t, op).motivos.some((m) => m.startsWith("promesa_recontacto:")), t);
  }
});

Deno.test("19-10 quitarPromesaRecontacto: saca solo la frase de la promesa", () => {
  assertEquals(quitarPromesaRecontacto("Dale, tranqui. El viernes 30/10 te escribo y te lo armo."), "Dale, tranqui.");
  assertEquals(quitarPromesaRecontacto("Mañana te escribo."), "Cuando estés listo escribime por acá y lo armamos.");
});

Deno.test("21-10 quitarFrasesConMontos: saca solo las frases con los montos frenados", () => {
  assertEquals(quitarFrasesConMontos("Genial! Pasame tu ciudad. Te ahorrás 40.000. Los 2 salen 158.000.", [40000]), "Genial! Pasame tu ciudad. Los 2 salen 158.000.");
  assertEquals(quitarFrasesConMontos("Te ahorrás 40 mil.", [40000]), "");
});
