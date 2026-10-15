// 13-10: rescate antes de cancelar. Ningún "Cancelar" cancela al primer toque: sale UNA respuesta con la oferta de
// programar otro día / horario / persona y los botones resc_prog / resc_cancel. Datos inventados (repo público).
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { type Deps, type EntradaVendedor, esPedidoCancelar, leerBotonRescate, type MensajeMeta, type Pedido, procesarMensaje } from "./procesar.ts";

const TEL = "595981000000";
const ID = "5550001";
const ID2 = "5550002";
const contacto = { profile: { name: "Ana Prueba" }, wa_id: TEL, user_id: "PY.1234567890123" };
const TEXTO_RESCATE = "Antes de cancelar: ¿te sirve que te lo llevemos otro día, en otro horario o que lo reciba otra persona? Decime y lo programamos 🙌";

const pedido = (x: Partial<Pedido> = {}): Pedido => ({
  shopify_order_id: ID,
  nombre: "#1001",
  cliente_id: "cli-1",
  telefono: `+${TEL}`,
  estado_confirmacion: "confirmado",
  tags: ["CONFIRMADO"],
  courier: "lucero",
  creado_en: "2026-10-12T12:00:00.000Z",
  total: 129000,
  raw: { shipping_address: { first_name: "Ana", city: "Ciudad del Este", address1: "Calle Falsa 123" }, line_items: [{ quantity: 1, title: "Tiras nasales" }] },
  ...x,
});

function mock(op: { estado?: string; pedidos?: Pedido[]; conVendedor?: boolean; ultimoTexto?: string } = {}) {
  let ahora = new Date("2026-10-13T15:00:00Z");
  const st = {
    pedidos: new Map((op.pedidos ?? [pedido()]).map((p) => [String(p.shopify_order_id), { ...p }])),
    enviados: [] as string[],
    botones: [] as { texto: string; botones: { id: string; titulo: string }[]; en: string }[],
    avisos: [] as { texto: string; botones?: unknown }[],
    pasados: [] as EntradaVendedor[],
    estados: [] as string[],
    tags: [] as [string, string[]][],
    cancelados: [] as [string, string[]][],
    ultimo: op.ultimoTexto ?? null as string | null,
    setAhora: (iso: string) => (ahora = new Date(iso)),
  };
  const deps: Deps = {
    ahora: () => ahora,
    config: () => Promise.resolve(null),
    guardarEventoCrudo: () => Promise.resolve(true),
    marcarEventoProcesado: () => Promise.resolve(),
    upsertCliente: () => Promise.resolve({ id: "cli-1", nombre: "Ana Prueba" }),
    conversacionActiva: () => Promise.resolve({ id: "conv-1", estado: op.estado ?? "ia" }),
    actualizarConversacion: (_id, c) => (c.estado && st.estados.push(c.estado), Promise.resolve()),
    insertarMensajeEntrante: () => Promise.resolve(true),
    completarContenidoMensaje: () => Promise.resolve(),
    estadoMensaje: () => Promise.resolve(undefined),
    actualizarMensaje: () => Promise.resolve(),
    copiarAudio: (_m, ruta) => Promise.resolve({ ok: true, ruta }),
    buscarPedido: (id) => Promise.resolve(st.pedidos.get(id) ?? null),
    pedidosPorEstado: (_c, _t, estado) => Promise.resolve([...st.pedidos.values()].filter((p) => p.estado_confirmacion === estado)),
    actualizarPedido: (id, c) => (Object.assign(st.pedidos.get(id)!, c), Promise.resolve()),
    cancelarEnviosPendientes: (id, patrones) => (st.cancelados.push([id, patrones]), Promise.resolve(1)),
    agregarTags: (gid, tags) => (st.tags.push([gid, tags]), Promise.resolve({ ok: true })),
    quitarTags: () => Promise.resolve({ ok: true }),
    avisar: (texto, botones) => (st.avisos.push({ texto, botones }), Promise.resolve({ ok: true })),
    enviarTexto: (_to, t) => (st.enviados.push(t), st.ultimo = t, Promise.resolve({ ok: true })),
    enviarBotones: (_to, texto, botones) => (st.botones.push({ texto, botones, en: ahora.toISOString() }), st.ultimo = texto, Promise.resolve({ ok: true })),
    consentimientoMarketing: () => Promise.resolve(null),
    registrarConsentimiento: () => Promise.resolve(),
    marcarLeidoYEscribiendo: () => Promise.resolve(),
    normalizarTelefono: (x) => (/^5959\d{8}$/.test(x) ? `+${x}` : null),
    ultimoTextoNuestro: () => Promise.resolve(st.ultimo),
    ofertaRescateDesde: (_conv, orderId, desde) =>
      Promise.resolve(st.botones.some((b) => b.botones[0]?.id === `resc_prog:${orderId}` && b.en >= desde)),
  };
  if (op.conVendedor !== false) deps.pasarAlVendedor = (d) => (st.pasados.push(d), Promise.resolve());
  return { deps, st };
}

let n = 0;
const boton = (payload: string): MensajeMeta => ({ from: TEL, id: `wamid.B${++n}`, timestamp: "1791900000", type: "button", button: { payload, text: "Cancelar pedido" } });
const interactivo = (id: string): MensajeMeta => ({ from: TEL, id: `wamid.I${++n}`, timestamp: "1791900000", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
const texto = (body: string): MensajeMeta => ({ from: TEL, id: `wamid.T${++n}`, timestamp: "1791900000", type: "text", text: { body } });

/** Respuestas al cliente (texto + botones): tiene que haber exactamente una por evento. */
const respuestas = (st: ReturnType<typeof mock>["st"]) => st.enviados.length + st.botones.length;

Deno.test("leerBotonRescate y esPedidoCancelar", () => {
  assertEquals(leerBotonRescate(interactivo(`resc_prog:${ID}`)), { accion: "resc_prog", orderId: ID });
  assertEquals(leerBotonRescate(interactivo(`resc_cancel:${ID}`)), { accion: "resc_cancel", orderId: ID });
  assertEquals(leerBotonRescate(interactivo(`conf_cancelar:${ID}`)), null);
  for (const t of ["Cancelar pedido", "cancelar", "Quiero cancelar mi pedido", "cancelámelo por favor", "Cancelen el pedido", "hola, quiero cancelar el pedido", "ya no lo quiero", "Cancelar igual", "anulá mi pedido"]) {
    assert(esPedidoCancelar(t), t);
  }
  for (const t of ["no lo cancelen", "no quiero cancelar", "¿cuándo llega?", "el viernes", "cancelar el pedido porque el repartidor no vino nunca y además me cobraron de más", "no"]) {
    assertFalse(esPedidoCancelar(t), t);
  }
  // Títulos de los botones ≤ 20 caracteres (límite de Meta).
  assert("Programar otro día".length <= 20 && "Cancelar igual".length <= 20);
});

Deno.test("botón 'Cancelar pedido' de la plantilla: UNA respuesta (oferta con 2 botones), nada se cancela, el vendedor no responde, chat en 'ia'", async () => {
  const { deps, st } = mock({ estado: "humano" });
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, deps);
  assertEquals(respuestas(st), 1);
  assertEquals(st.botones[0].texto, TEXTO_RESCATE);
  assertEquals(st.botones[0].botones, [{ id: `resc_prog:${ID}`, titulo: "Programar otro día" }, { id: `resc_cancel:${ID}`, titulo: "Cancelar igual" }]);
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "confirmado");
  assertEquals([st.tags.length, st.cancelados.length, st.pasados.length, st.avisos.length], [0, 0, 0, 0]);
  assertEquals(st.estados, ["ia"]);
});

Deno.test("pedido ya despachado: la oferta igual, y a Enrique un aviso (sin cancelar nada)", async () => {
  const { deps, st } = mock({ pedidos: [pedido({ raw: { ...pedido().raw, fulfillment_status: "fulfilled" } })] });
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, deps);
  assertEquals(respuestas(st), 1);
  assertEquals(st.avisos.length, 1);
  assert(st.avisos[0].texto.includes("ya despachado"));
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "confirmado");
});

Deno.test("'Programar otro día' → el vendedor recibe '[programar entrega pedido #1001] El cliente quiere otro día/horario.'; no respondemos nosotros", async () => {
  const { deps, st } = mock({ estado: "humano" });
  await procesarMensaje(interactivo(`resc_prog:${ID}`), contacto, deps);
  assertEquals(st.pasados.length, 1);
  assert(st.pasados[0].texto.includes("[programar entrega pedido #1001] El cliente quiere otro día/horario."));
  assert(st.pasados[0].texto.includes("programar_entrega"));
  assertEquals(respuestas(st), 0); // la única respuesta es la del vendedor
  assertEquals(st.estados, ["ia"]);
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "confirmado");
  // Sin vendedor: una respuesta fija.
  const s2 = mock({ conVendedor: false });
  await procesarMensaje(interactivo(`resc_prog:${ID}`), contacto, s2.deps);
  assertEquals(respuestas(s2.st), 1);
  assert(s2.st.enviados[0].includes("qué día"));
});

Deno.test("'Cancelar igual' → la cancelación de siempre (cancelado_cliente, tag, envíos, una respuesta, Telegram con botón)", async () => {
  const { deps, st } = mock();
  await procesarMensaje(interactivo(`resc_cancel:${ID}`), contacto, deps);
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "cancelado_cliente");
  assert(st.pedidos.get(ID)!.tags!.includes("CANCELADO_CLIENTE"));
  assertEquals(st.tags, [[`gid://shopify/Order/${ID}`, ["CANCELADO_CLIENTE"]]]);
  assertEquals(st.cancelados.length, 1);
  assertEquals(respuestas(st), 1);
  assert(st.enviados[0].startsWith("Entendido, cancelamos tu pedido."));
  assertEquals(st.pasados.length, 0);
  assertEquals(JSON.stringify(st.avisos[0].botones), JSON.stringify([[{ texto: "Cancelar pedido", callback: `cancelar:${ID}` }]]));
  // Despachado: el aviso le dice a Enrique que frene al courier.
  const s2 = mock({ pedidos: [pedido({ raw: { ...pedido().raw, fulfillment_status: "fulfilled" } })] });
  await procesarMensaje(interactivo(`resc_cancel:${ID}`), contacto, s2.deps);
  assert(s2.st.avisos[0].texto.includes("avisale al courier"));
});

Deno.test("segundo 'Cancelar pedido' dentro de las 24 h de la oferta → cancela; pasadas las 24 h → otra oferta", async () => {
  const { deps, st } = mock();
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, deps);
  st.setAhora("2026-10-14T10:00:00Z");
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, deps);
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "cancelado_cliente");
  assertEquals([st.botones.length, st.enviados.length], [1, 1]); // una respuesta por evento

  const s2 = mock();
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, s2.deps);
  s2.st.setAhora("2026-10-14T16:00:00Z"); // 25 h después
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, s2.deps);
  assertEquals(s2.st.pedidos.get(ID)!.estado_confirmacion, "confirmado");
  assertEquals(s2.st.botones.length, 2);
});

Deno.test("texto 'quiero cancelar mi pedido' → oferta (no va al vendedor); después 'cancelalo igual' o 'no' → cancela", async () => {
  for (const segundo of ["cancelalo igual", "no", "ya no lo quiero"]) {
    const { deps, st } = mock();
    await procesarMensaje(texto("Quiero cancelar mi pedido"), contacto, deps);
    assertEquals([respuestas(st), st.pasados.length], [1, 0], segundo);
    assertEquals(st.botones[0].botones[1].id, `resc_cancel:${ID}`);
    await procesarMensaje(texto(segundo), contacto, deps);
    assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "cancelado_cliente", segundo);
    assertEquals([respuestas(st), st.pasados.length], [2, 0], segundo);
  }
});

Deno.test("después de la oferta, un día o un horario va al vendedor (no cancela)", async () => {
  const { deps, st } = mock();
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, deps);
  await procesarMensaje(texto("el viernes antes de las 12"), contacto, deps);
  assertEquals(st.pasados.length, 1);
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "confirmado");
});

Deno.test("texto de cancelar con dos pedidos abiertos, en 'humano' o sin pedido → sigue al vendedor / a Enrique como siempre", async () => {
  const dos = mock({ pedidos: [pedido(), pedido({ shopify_order_id: ID2, nombre: "#1002" })] });
  await procesarMensaje(texto("cancelar pedido"), contacto, dos.deps);
  assertEquals([respuestas(dos.st), dos.st.pasados.length], [0, 1]);
  const humano = mock({ estado: "humano" });
  await procesarMensaje(texto("cancelar pedido"), contacto, humano.deps);
  assertEquals([respuestas(humano.st), humano.st.pasados.length], [0, 0]);
  const sin = mock({ pedidos: [] });
  await procesarMensaje(texto("cancelar pedido"), contacto, sin.deps);
  assertEquals([respuestas(sin.st), sin.st.pasados.length], [0, 1]);
});

Deno.test("'no' a la confirmación (pedido pendiente) → oferta de rescate, no cancela", async () => {
  const { deps, st } = mock({ pedidos: [pedido({ estado_confirmacion: "pendiente", tags: [] })], ultimoTexto: "[plantilla voltra_confirmacion_pedido_v3] ..." });
  await procesarMensaje(texto("no"), contacto, deps);
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "pendiente");
  assertEquals([st.botones.length, st.enviados.length, st.pasados.length], [1, 0, 0]);
});

Deno.test("pedido ya cancelado → se le dice UNA vez; entregado → nunca se cancela", async () => {
  const { deps, st } = mock({ pedidos: [pedido({ estado_confirmacion: "cancelado_cliente", tags: ["CANCELADO_CLIENTE"] })] });
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, deps);
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, deps);
  await procesarMensaje(interactivo(`resc_cancel:${ID}`), contacto, deps);
  assertEquals(st.enviados, ["Tu pedido #1001 ya está cancelado. Si lo querés de nuevo, escribime por acá y lo armamos 🙌"]);
  assertEquals([st.botones.length, st.tags.length, st.pasados.length], [0, 0, 0]);

  for (const ev of [boton(`conf_cancelar:${ID}`), interactivo(`resc_cancel:${ID}`), interactivo(`resc_prog:${ID}`)]) {
    const e = mock({ pedidos: [pedido({ estado_envio: "ENTREGADO" })] });
    await procesarMensaje(ev, contacto, e.deps);
    assertEquals(e.st.pedidos.get(ID)!.estado_confirmacion, "confirmado");
    assertEquals(respuestas(e.st), 1);
    assert(e.st.enviados[0].includes("ya figura entregado"));
    assertEquals([e.st.tags.length, e.st.pasados.length], [0, 0]);
  }
});

Deno.test("botón de rescate de un pedido de otro cliente → no se hace nada (aviso a Enrique)", async () => {
  const { deps, st } = mock({ pedidos: [pedido({ cliente_id: "otro", telefono: "+595981999999" })] });
  await procesarMensaje(interactivo(`resc_cancel:${ID}`), contacto, deps);
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "confirmado");
  assertEquals(respuestas(st), 0);
  assertEquals(st.avisos.length, 1);
});

Deno.test("si la oferta no sale, no se cancela nada y Enrique decide", async () => {
  const { deps, st } = mock();
  deps.enviarBotones = () => Promise.resolve({ ok: false, error: "131047" });
  await procesarMensaje(boton(`conf_cancelar:${ID}`), contacto, deps);
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "confirmado");
  assertEquals(st.avisos.length, 1);
  assert(st.avisos[0].texto.includes("No cancelé nada"));
});

Deno.test("respuesta única: el toque queda guardado como último entrante ANTES de responder (el turno del vendedor en curso se corta por 'agrupado')", async () => {
  const { deps } = mock();
  const orden: string[] = [];
  deps.insertarMensajeEntrante = (f) => (orden.push(`in:${f.wa_message_id}`), Promise.resolve(true));
  deps.enviarBotones = (_to, _t, _b) => (orden.push("respuesta"), Promise.resolve({ ok: true }));
  deps.pasarAlVendedor = () => (orden.push("vendedor"), Promise.resolve());
  const m = boton(`conf_cancelar:${ID}`);
  await procesarMensaje(m, contacto, deps);
  assertEquals(orden, [`in:${m.id}`, "respuesta"]);
});

Deno.test("contexto del vendedor: el pedido abierto con entrega programada dice el día pedido", async () => {
  const raw = { ...pedido().raw, note_attributes: [{ name: "entrega_programada", value: "2026-10-16" }, { name: "entrega_franja", value: "antes de las 12" }] };
  const { deps, st } = mock({ pedidos: [pedido({ raw, creado_en: "2026-10-12T12:00:00.000Z" })] });
  await procesarMensaje(texto("a qué hora llega?"), contacto, deps);
  assertEquals(st.pasados.length, 1);
  assert(st.pasados[0].texto.includes("ENTREGA PROGRAMADA el viernes 16/10, antes de las 12"));
});
