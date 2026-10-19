// 19-10 (#1072): el "sí" escrito confirma el pedido web solo si responde a la confirmación; marca del pedido abierto
// (regla de modificar_pedido, audios), botones vend_mod y pista de pedido con otro número. Datos inventados (repo público).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  conPedidoAbierto,
  type Deps,
  type EntradaVendedor,
  esAvisoDePedidoHecho,
  esConfirmacionNuestra,
  type Pedido,
  pedidoDeConfirmacion,
  PISTA_PEDIDO_OTRO_NUMERO,
  pideConfirmarTalCual,
  procesarMensaje,
  REGLA_CAMBIOS_PEDIDO,
  type Saliente,
  siConfirmaPedido,
} from "./procesar.ts";

const TEL = "595981000000";
const ORDER = "5550001";
const contacto = { profile: { name: "Ana Prueba" }, wa_id: TEL, user_id: "PY.1234567890123" };
const base = { from: TEL, id: "wamid.IN1", timestamp: "1791300000" };
const texto = (body: string, id = "wamid.IN1") => ({ ...base, id, type: "text", text: { body } });

const pedidoWeb = (over: Partial<Pedido> = {}): Pedido => ({
  shopify_order_id: ORDER,
  nombre: "#1900",
  cliente_id: "cli-1",
  telefono: `+${TEL}`,
  estado_confirmacion: "pendiente",
  tags: [],
  courier: "pap",
  creado_en: "2026-10-06T14:00:00Z",
  raw: { line_items: [{ quantity: 1, title: "Ejercitador de prueba" }], total_price: "112000", shipping_address: { address1: "Calle Falsa 123", city: "Asunción" } },
  ...over,
});

// Mensajes nuestros (como los guarda _shared/wa.ts en wa_mensajes).
const PLANTILLA_V4: Saliente = {
  tipo: "template",
  texto: "[plantilla voltra_confirmacion_pedido_v4] #1900 | Ana | 1 Ejercitador de prueba | Gs 112.000",
  contenido: {
    template: {
      name: "voltra_confirmacion_pedido_v4",
      components: [
        { type: "body", parameters: [{ type: "text", text: "#1900" }] },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `conf_si:${ORDER}` }] },
        { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `corregir:${ORDER}` }] },
      ],
    },
  },
};
const V4_EN_VENTANA: Saliente = {
  tipo: "interactive",
  texto: "Hola Ana, tu pedido #1900 …\n[Confirmo] [Corregir] [Cancelar pedido]",
  contenido: {
    interactive: {
      type: "button",
      body: { text: "Hola Ana, tu pedido #1900 …" },
      action: { buttons: [{ type: "reply", reply: { id: `conf_si:${ORDER}`, title: "Confirmo" } }, { type: "reply", reply: { id: `corregir:${ORDER}`, title: "Corregir" } }] },
    },
  },
};
const PREGUNTA_1072: Saliente = {
  tipo: "text",
  texto: "Los 2 salen 158.000 con envío gratis 🙌 ¿Te lo cambio a 2? Si es así, respondeme 'sí' y lo confirmo.",
};
const RESUMEN_MOD: Saliente = {
  tipo: "interactive",
  texto: "Tu pedido queda así: 2 Ejercitador de prueba, total Gs 158.000. ¿Confirmás?\n[Confirmo] [Corregir]",
  contenido: { interactive: { action: { buttons: [{ reply: { id: "vend_mod:pm-1", title: "Confirmo" } }, { reply: { id: "vend_modc:pm-1", title: "Corregir" } }] } } },
};

function mock(op: { pedidos?: Pedido[]; saliente?: Saliente | null | Error; sinDep?: boolean; estado?: string } = {}) {
  const st = {
    pasados: [] as EntradaVendedor[],
    enviados: [] as string[],
    avisos: [] as string[],
    cambiosPedido: [] as [string, Record<string, unknown>][],
    consultasSaliente: [] as string[],
    contenidos: new Map<string, Record<string, unknown>>(),
  };
  const pedidos = op.pedidos ?? [];
  const deps: Deps = {
    ahora: () => new Date("2026-10-06T15:00:00Z"),
    config: () => Promise.resolve(null),
    guardarEventoCrudo: () => Promise.resolve(true),
    marcarEventoProcesado: () => Promise.resolve(),
    upsertCliente: () => Promise.resolve({ id: "cli-1", nombre: "Ana Prueba" }),
    conversacionActiva: () => Promise.resolve({ id: "conv-1", estado: op.estado ?? "ia" }),
    actualizarConversacion: () => Promise.resolve(),
    insertarMensajeEntrante: () => Promise.resolve(true),
    completarContenidoMensaje: (id, extra) => (st.contenidos.set(id, { ...(st.contenidos.get(id) ?? {}), ...extra }), Promise.resolve()),
    estadoMensaje: () => Promise.resolve(undefined),
    actualizarMensaje: () => Promise.resolve(),
    copiarAudio: (_m, ruta) => Promise.resolve({ ok: true, ruta, mime: "audio/ogg" }),
    transcribirAudio: () => Promise.resolve({ ok: true, texto: "la dirección es la misma de siempre", confianza: 0.9 }),
    buscarPedido: (id) => Promise.resolve(pedidos.find((p) => String(p.shopify_order_id) === id) ?? null),
    pedidosPorEstado: (_c, _t, estado) => Promise.resolve(pedidos.filter((p) => p.estado_confirmacion === estado)),
    actualizarPedido: (id, c) => (st.cambiosPedido.push([String(id), c as Record<string, unknown>]), Promise.resolve()),
    cancelarEnviosPendientes: () => Promise.resolve(0),
    agregarTags: () => Promise.resolve({ ok: true }),
    quitarTags: () => Promise.resolve({ ok: true }),
    avisar: (t) => (st.avisos.push(t), Promise.resolve({ ok: true })),
    enviarTexto: (_to, t) => (st.enviados.push(t), Promise.resolve({ ok: true })),
    enviarBotones: (_to, t) => (st.enviados.push(t), Promise.resolve({ ok: true })),
    consentimientoMarketing: () => Promise.resolve(null),
    registrarConsentimiento: () => Promise.resolve(),
    marcarLeidoYEscribiendo: () => Promise.resolve(),
    normalizarTelefono: (x) => {
      const d = x.replace(/\D/g, "");
      return /^5959\d{8}$/.test(d) ? `+${d}` : null;
    },
    pasarAlVendedor: (d) => (st.pasados.push(d), Promise.resolve()),
  };
  if (!op.sinDep) {
    deps.ultimoSalienteCliente = (clienteId) => {
      st.consultasSaliente.push(clienteId);
      const s = op.saliente === undefined ? null : op.saliente;
      return s instanceof Error ? Promise.reject(s) : Promise.resolve(s);
    };
  }
  const confirmo = () => st.cambiosPedido.some(([, c]) => c.estado_confirmacion === "confirmado");
  return { deps, st, confirmo };
}

// ---------- 1. el "sí" escrito ----------

Deno.test("#1072: 'Si' que responde a '¿te lo cambio a 2?' NO confirma el pedido original: pasa al vendedor con la marca del pedido", async () => {
  const a = mock({ pedidos: [pedidoWeb()], saliente: PREGUNTA_1072 });
  await procesarMensaje(texto("Si"), contacto, a.deps);
  assertEquals(a.confirmo(), false);
  assertEquals(a.st.enviados.length, 0); // nada de "quedó confirmado" con 1 unidad
  assertEquals(a.st.pasados.length, 1);
  const t = a.st.pasados[0].texto;
  assert(t.startsWith("[pedido #1900 de la tienda, PENDIENTE DE CONFIRMAR"), t);
  assert(t.includes("modificar_pedido"), t);
  assert(t.endsWith("\nSi"), t);
  assertEquals(a.st.consultasSaliente, ["cli-1"]);
});

Deno.test("#1072 secuencia completa: plantilla → '2 x cuánto' (vendedor) → '¿te lo cambio a 2?' → 'Si' → vendedor; 'Ok' siguiente también", async () => {
  // Paso 1: "2 x cuánto" después de la plantilla no es aceptación → vendedor.
  const p1 = mock({ pedidos: [pedidoWeb()], saliente: PLANTILLA_V4 });
  await procesarMensaje(texto("2 x cuánto", "wamid.A1"), contacto, p1.deps);
  assertEquals(p1.confirmo(), false);
  assertEquals(p1.st.pasados.length, 1);
  // Paso 2: el bot propuso el cambio; "Si" → vendedor (que usará modificar_pedido).
  const p2 = mock({ pedidos: [pedidoWeb()], saliente: PREGUNTA_1072 });
  await procesarMensaje(texto("Si", "wamid.A2"), contacto, p2.deps);
  assertEquals(p2.confirmo(), false);
  assertEquals(p2.st.pasados.length, 1);
  // Paso 3: el vendedor mostró el resumen de modificar_pedido; un "Ok" escrito tampoco confirma el original.
  const p3 = mock({ pedidos: [pedidoWeb()], saliente: RESUMEN_MOD });
  await procesarMensaje(texto("Ok", "wamid.A3"), contacto, p3.deps);
  assertEquals(p3.confirmo(), false);
  assertEquals(p3.st.pasados.length, 1);
});

Deno.test("'sí' justo después de la plantilla de confirmación (o recordatorio / último aviso / v4 en ventana) confirma como siempre", async () => {
  const salientes: Saliente[] = [
    PLANTILLA_V4,
    V4_EN_VENTANA,
    { tipo: "template", texto: "[plantilla voltra_recordatorio_confirmacion] Ana | 1 Ejercitador de prueba" },
    { tipo: "template", texto: "[plantilla voltra_ultimo_aviso_confirmacion] Ana | 1 Ejercitador de prueba | 112.000" },
    { tipo: "template", texto: "[plantilla voltra_confirmacion_pedido_v3] #1900 | Ana" },
  ];
  for (const s of salientes) {
    const a = mock({ pedidos: [pedidoWeb()], saliente: s });
    await procesarMensaje(texto("Sii dale"), contacto, a.deps);
    assert(a.confirmo(), s.texto ?? "");
    assert(a.st.enviados[0].includes("confirmado"), s.texto ?? "");
    assertEquals(a.st.pasados.length, 0);
  }
});

Deno.test("'sí' después de que el vendedor pidió confirmar el pedido TAL CUAL confirma (el vendedor no tiene herramienta para eso)", async () => {
  const a = mock({ pedidos: [pedidoWeb()], saliente: { tipo: "text", texto: "Te llega el jueves 😊 ¿Me confirmás el pedido? Respondé \"sí\"" } });
  await procesarMensaje(texto("si"), contacto, a.deps);
  assert(a.confirmo());
  assertEquals(a.st.pasados.length, 0);
});

Deno.test("'sí' a otra pregunta del vendedor (sin pedir confirmar) o al resumen del vendedor (vend_conf) → vendedor", async () => {
  const preguntas: Saliente[] = [
    { tipo: "text", texto: "¿Querés que te mande también el gel? Sale 50.000" },
    { tipo: "text", texto: "¿Te sumo otra unidad y confirmamos? Respondé sí" },
    { tipo: "text", texto: "¿Preferís los 3 en vez de 1? respondé sí y lo confirmo" },
    { tipo: "interactive", texto: "Resumen: 1 gel…\n[Confirmar] [Corregir]", contenido: { interactive: { action: { buttons: [{ reply: { id: "vend_conf:pc-9", title: "Confirmar" } }] } } } },
    { tipo: "image", texto: "[image] Así se usa" },
  ];
  for (const s of preguntas) {
    const a = mock({ pedidos: [pedidoWeb()], saliente: s });
    await procesarMensaje(texto("dale"), contacto, a.deps);
    assertEquals(a.confirmo(), false, s.texto ?? "");
    assertEquals(a.st.pasados.length, 1, s.texto ?? "");
  }
});

Deno.test("'sí': sin la dependencia, si falla o si nunca le escribimos, se comporta como antes (confirma)", async () => {
  for (const op of [{ sinDep: true }, { saliente: new Error("db caída") }, { saliente: null }]) {
    const a = mock({ pedidos: [pedidoWeb()], ...op });
    await procesarMensaje(texto("ok"), contacto, a.deps);
    assert(a.confirmo(), JSON.stringify(op));
  }
});

Deno.test("'sí' a la confirmación de OTRO pedido (botón conf_si de otro id): no confirma el pendiente, lo ve el vendedor", async () => {
  const otro: Saliente = { ...V4_EN_VENTANA, contenido: { interactive: { action: { buttons: [{ reply: { id: "conf_si:5559999", title: "Confirmo" } }] } } } };
  const a = mock({ pedidos: [pedidoWeb()], saliente: otro });
  await procesarMensaje(texto("si"), contacto, a.deps);
  assertEquals(a.confirmo(), false);
  assertEquals(a.st.avisos.length, 0);
  assertEquals(a.st.pasados.length, 1);
});

Deno.test("dos pendientes y 'sí' tras otra pregunta: ya no avisa 'no confirmé ninguno', va al vendedor; tras la plantilla sí avisa", async () => {
  const dos = () => [pedidoWeb(), pedidoWeb({ shopify_order_id: "5550002", nombre: "#1901" })];
  const a = mock({ pedidos: dos(), saliente: PREGUNTA_1072 });
  await procesarMensaje(texto("si"), contacto, a.deps);
  assertEquals(a.st.avisos.length, 0);
  assertEquals(a.st.pasados.length, 1);
  const b = mock({ pedidos: dos(), saliente: { tipo: "template", texto: "[plantilla voltra_recordatorio_confirmacion] Ana" } });
  await procesarMensaje(texto("si"), contacto, b.deps);
  assert(b.st.avisos[0].includes("2 pedidos pendientes"));
  assertEquals(b.st.pasados.length, 0);
});

Deno.test("botón Confirmo de la plantilla (conf_si:<id>) sigue confirmando sin mirar el último mensaje", async () => {
  const a = mock({ pedidos: [pedidoWeb()], saliente: PREGUNTA_1072 });
  await procesarMensaje({ ...base, type: "button", button: { payload: `conf_si:${ORDER}`, text: "Confirmo" } }, contacto, a.deps);
  assert(a.confirmo());
  assertEquals(a.st.consultasSaliente, []);
  assertEquals(a.st.pasados.length, 0);
});

Deno.test("'no' tras la v4 en ventana (interactivo) o la plantilla → oferta de rescate; tras otra pregunta → vendedor", async () => {
  const a = mock({ pedidos: [pedidoWeb()], saliente: V4_EN_VENTANA });
  await procesarMensaje(texto("no"), contacto, a.deps);
  assertEquals(a.st.pasados.length, 0);
  assertEquals(a.st.enviados.length, 1);
  const b = mock({ pedidos: [pedidoWeb()], saliente: PREGUNTA_1072 });
  await procesarMensaje(texto("no"), contacto, b.deps);
  assertEquals(b.st.enviados.length, 0);
  assertEquals(b.st.pasados.length, 1);
});

Deno.test("funciones puras: confirmación nuestra, pedido de los botones y pedido de confirmar tal cual", () => {
  assert(esConfirmacionNuestra(PLANTILLA_V4));
  assert(esConfirmacionNuestra(V4_EN_VENTANA));
  assert(!esConfirmacionNuestra(PREGUNTA_1072));
  assert(!esConfirmacionNuestra(RESUMEN_MOD));
  assertEquals(pedidoDeConfirmacion(PLANTILLA_V4), ORDER);
  assertEquals(pedidoDeConfirmacion(V4_EN_VENTANA), ORDER);
  assertEquals(pedidoDeConfirmacion({ tipo: "template", texto: "[plantilla voltra_recordatorio_confirmacion] x" }), null);
  assert(!pideConfirmarTalCual(PREGUNTA_1072));
  assert(pideConfirmarTalCual({ tipo: "text", texto: "Perfecto, ¿confirmamos tu pedido?" }));
  assert(!pideConfirmarTalCual({ tipo: "text", texto: "¿Agrego el gel y lo confirmo?" }));
  assert(!pideConfirmarTalCual({ tipo: "text", texto: "Lo cambio a x2 y confirmás?" }));
  assert(!pideConfirmarTalCual({ tipo: "interactive", texto: "¿Confirmás?" }));
  assert(!siConfirmaPedido(RESUMEN_MOD));
});

// ---------- 2 y 4. marca del pedido abierto: regla de modificar_pedido y audios ----------

Deno.test("marca del pedido abierto: trae la regla de modificar_pedido (corta)", async () => {
  const a = mock({ pedidos: [pedidoWeb()] });
  const t = await conPedidoAbierto(a.deps, "cli-1", `+${TEL}`, "2 x cuánto");
  assert(t.includes(REGLA_CAMBIOS_PEDIDO), t);
  assert(REGLA_CAMBIOS_PEDIDO.includes("usá modificar_pedido (muestra un resumen con Confirmo)"));
  assert(REGLA_CAMBIOS_PEDIDO.includes("Nunca digas que lo cambiaste si la herramienta no lo hizo."));
  assert(REGLA_CAMBIOS_PEDIDO.length < 200);
});

Deno.test("audio con un pedido abierto: el vendedor recibe la marca del pedido (no le vuelve a pedir todo)", async () => {
  const a = mock({ pedidos: [pedidoWeb()] });
  await procesarMensaje({ ...base, type: "audio", audio: { id: "MEDIA1", mime_type: "audio/ogg" } }, contacto, a.deps);
  const t = a.st.pasados[0].texto;
  assert(t.startsWith("[pedido #1900 de la tienda, PENDIENTE DE CONFIRMAR"), t);
  assert(t.endsWith("\n[audio] la dirección es la misma de siempre"), t);
  assertEquals(a.st.contenidos.get("wamid.IN1")?.texto_vendedor, t);
  // Sin pedido, el audio va igual que antes.
  const b = mock();
  await procesarMensaje({ ...base, type: "audio", audio: { id: "MEDIA1" } }, contacto, b.deps);
  assertEquals(b.st.pasados[0].texto, "[audio] la dirección es la misma de siempre");
});

// ---------- 3. botones del resumen de modificar_pedido ----------

Deno.test("vend_mod: Confirmo / Corregir del resumen de modificar_pedido pasan al vendedor con el id, aunque haya un pedido pendiente", async () => {
  for (const [id, titulo] of [["vend_mod:pm-1", "Confirmo"], ["vend_mod:pm-1:corregir", "Corregir"]]) {
    const a = mock({ pedidos: [pedidoWeb()], saliente: RESUMEN_MOD });
    await procesarMensaje({ ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: titulo } } }, contacto, a.deps);
    assertEquals(a.confirmo(), false, id);
    assertEquals(a.st.enviados.length, 0, id);
    assertEquals(a.st.pasados.length, 1, id);
    assert(a.st.pasados[0].texto.endsWith(`[botón] ${titulo} (${id})`), a.st.pasados[0].texto);
  }
  // Igual que los del resumen de crear_pedido_cod.
  const b = mock();
  await procesarMensaje({ ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "vend_mod:pm-2", title: "Confirmo" } } }, contacto, b.deps);
  assertEquals(b.st.pasados[0].texto, "[botón] Confirmo (vend_mod:pm-2)");
});

// ---------- 5. pedido web con otro número ----------

Deno.test("'Acabo de hacer un pedido' sin pedido a este número → pista de buscar_pedido; con pedido, la marca normal", async () => {
  const a = mock();
  await procesarMensaje(texto("Hola! Acabo de hacer un pedido en Voltra"), contacto, a.deps);
  assertEquals(a.st.pasados[0].texto, `${PISTA_PEDIDO_OTRO_NUMERO}\nHola! Acabo de hacer un pedido en Voltra`);
  const b = mock({ pedidos: [pedidoWeb()] });
  await procesarMensaje(texto("acabo de hacer un pedido"), contacto, b.deps);
  assert(!b.st.pasados[0].texto.includes("buscar_pedido"));
  const c = mock();
  await procesarMensaje(texto("cuánto sale el ejercitador?"), contacto, c.deps);
  assertEquals(c.st.pasados[0].texto, "cuánto sale el ejercitador?");
});

Deno.test("esAvisoDePedidoHecho: variantes comunes sí; preguntas de compra no", () => {
  for (const t of ["Acabo de hacer un pedido en Voltra", "ya pedí por la web", "Hice un pedido ayer", "ya compré en la página", "pedí por la web recién"]) {
    assert(esAvisoDePedidoHecho(t), t);
  }
  for (const t of ["quiero hacer un pedido", "cómo hago un pedido?", "cuánto sale", "pedido"]) assert(!esAvisoDePedidoHecho(t), t);
});
