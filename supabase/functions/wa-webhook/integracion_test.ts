// Integración olas 3-4 en wa-webhook: baja de marketing, botones de recompra (mk_*), oferta QR tras
// confirmar y 131050 en estados. Datos inventados (repo público).
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  contextoOfertaAceptada,
  type Deps,
  type EntradaVendedor,
  leerBotonMarketing,
  type MensajeMeta,
  type OfertaEnviada,
  type Pedido,
  procesarEstado,
  procesarMensaje,
} from "./procesar.ts";

const TEL = "595981000000";
const contacto = { profile: { name: "Ana Prueba" }, wa_id: TEL, user_id: "PY.1234567890123" };
const base = { from: TEL, id: "wamid.IN9", timestamp: "1791300000" };

function mock(op: {
  estado?: string;
  config?: Record<string, unknown>;
  oferta?: OfertaEnviada | null;
  pedidos?: Pedido[];
  qr?: { ok: true; texto: string } | { ok: false; motivo: string };
} = {}) {
  const st = {
    pasados: [] as EntradaVendedor[],
    enviados: [] as string[],
    avisos: [] as string[],
    bajas: [] as [string, string][],
    estadosConv: [] as string[],
    qrPedidos: [] as number[],
    ofertasBuscadas: [] as [string, string | null][],
    contenidos: new Map<string, Record<string, unknown>>(),
  };
  const pedidos = op.pedidos ?? [];
  const deps: Deps = {
    ahora: () => new Date("2026-10-06T15:00:00Z"),
    config: (k) => Promise.resolve(op.config?.[k] ?? null),
    guardarEventoCrudo: () => Promise.resolve(true),
    marcarEventoProcesado: () => Promise.resolve(),
    upsertCliente: () => Promise.resolve({ id: "cli-1", nombre: "Ana Prueba" }),
    conversacionActiva: () => Promise.resolve({ id: "conv-1", estado: op.estado ?? "ia" }),
    actualizarConversacion: (_id, c) => (c.estado && st.estadosConv.push(c.estado), Promise.resolve()),
    insertarMensajeEntrante: () => Promise.resolve(true),
    completarContenidoMensaje: (id, extra) => (st.contenidos.set(id, { ...(st.contenidos.get(id) ?? {}), ...extra }), Promise.resolve()),
    estadoMensaje: () => Promise.resolve("enviado"),
    actualizarMensaje: () => Promise.resolve(),
    copiarAudio: (_m, ruta) => Promise.resolve({ ok: true, ruta, mime: "audio/ogg" }),
    buscarPedido: (id) => Promise.resolve(pedidos.find((p) => String(p.shopify_order_id) === id) ?? null),
    pedidosPorEstado: (_c, _t, estado) => Promise.resolve(pedidos.filter((p) => p.estado_confirmacion === estado)),
    actualizarPedido: () => Promise.resolve(),
    cancelarEnviosPendientes: () => Promise.resolve(0),
    agregarTags: () => Promise.resolve({ ok: true }),
    quitarTags: () => Promise.resolve({ ok: true }),
    avisar: (t) => (st.avisos.push(t), Promise.resolve({ ok: true })),
    enviarTexto: (_to, t) => (st.enviados.push(t), Promise.resolve({ ok: true })),
    enviarBotones: (_to, t) => (st.enviados.push(t), Promise.resolve({ ok: true })),
    consentimientoMarketing: () => Promise.resolve("si"),
    registrarConsentimiento: () => Promise.resolve(),
    marcarLeidoYEscribiendo: () => Promise.resolve(),
    normalizarTelefono: (x) => `+${x.replace(/\D/g, "")}`,
    pasarAlVendedor: (d) => (st.pasados.push(d), Promise.resolve()),
    registrarBaja: (c, o) => (st.bajas.push([c, o]), Promise.resolve({ ok: true })),
    ofertaMarketing: (c, o) => (st.ofertasBuscadas.push([c, o]), Promise.resolve(op.oferta ?? null)),
    ofrecerCobroQR: (id) => (st.qrPedidos.push(id), Promise.resolve(op.qr ?? { ok: true, texto: "Pagá con QR: https://ejemplo.test/qr" })),
    clienteDeMensaje: () => Promise.resolve("cli-1"),
  };
  return { deps, st };
}

const botonPlantilla = (payload: string, text: string): MensajeMeta =>
  ({ ...base, type: "button", button: { payload, text } }) as MensajeMeta;
const texto = (body: string): MensajeMeta => ({ ...base, type: "text", text: { body } }) as MensajeMeta;

Deno.test("leerBotonMarketing: payload con y sin pedido, y el texto del botón de baja sin payload", () => {
  assertEquals(leerBotonMarketing(botonPlantilla("mk_pack:1001", "Quiero el pack")), { accion: "mk_pack", orderId: "1001" });
  assertEquals(leerBotonMarketing(botonPlantilla("mk_quiero:0", "Lo quiero")), { accion: "mk_quiero", orderId: null });
  assertEquals(leerBotonMarketing(botonPlantilla("No quiero ofertas", "No quiero ofertas")), { accion: "mk_baja", orderId: null });
  assertEquals(leerBotonMarketing(botonPlantilla("conf_si:1001", "Confirmar")), null);
  assertEquals(leerBotonMarketing(texto("mk_si:1")), null); // un texto escrito no es un botón
});

Deno.test("baja por botón mk_baja: registra con origen 'boton', confirma con el texto de config_wa y no va al vendedor", async () => {
  const { deps, st } = mock({ config: { textos_marketing: { baja_confirmada: "Listo, sin ofertas." } } });
  await procesarMensaje(botonPlantilla("mk_baja:1001", "No quiero ofertas"), contacto, deps);
  assertEquals(st.bajas, [["cli-1", "boton"]]);
  assertEquals(st.enviados, ["Listo, sin ofertas."]);
  assertEquals(st.pasados.length, 0);
});

Deno.test("baja por texto (BAJA, 'No quiero ofertas'): origen 'chat'; aunque Enrique tenga el chat", async () => {
  for (const t of ["BAJA", "No quiero ofertas.", "no quiero ofertas"]) {
    const { deps, st } = mock({ estado: "humano" });
    await procesarMensaje(texto(t), contacto, deps);
    assertEquals(st.bajas, [["cli-1", "chat"]], t);
    assertMatch(st.enviados[0], /no te vamos a mandar más ofertas/);
  }
  // Un texto que solo contiene la palabra no es baja: va al vendedor.
  const { deps, st } = mock();
  await procesarMensaje(texto("cómo es la baja del precio?"), contacto, deps);
  assertEquals([st.bajas.length, st.pasados.length], [0, 1]);
});

Deno.test("mk_luego: respuesta corta y nada más", async () => {
  const { deps, st } = mock();
  await procesarMensaje(botonPlantilla("mk_luego:1001", "Más adelante"), contacto, deps);
  assertEquals(st.enviados, ["Dale, sin problema. Cuando quieras, escribinos por acá."]);
  assertEquals([st.pasados.length, st.bajas.length, st.avisos.length], [0, 0, 0]);
});

Deno.test("mk_pack: pasa al vendedor con la oferta aceptada (variables del envío) para crear_pedido_cod", async () => {
  const oferta = { plantilla: "voltra_mk_pack", variables: ["Ana", "tiras nasales", "el pack de 2 bolsas", 125000] };
  const { deps, st } = mock({ oferta });
  await procesarMensaje(botonPlantilla("mk_pack:1001", "Quiero el pack"), contacto, deps);
  assertEquals(st.ofertasBuscadas, [["cli-1", "1001"]]);
  assertEquals(st.pasados.length, 1);
  const t = st.pasados[0].texto;
  assertMatch(t, /^\[oferta aceptada\] Tocó "Quiero el pack"/);
  assertMatch(t, /el pack de 2 bolsas de tiras nasales a Gs 125\.000/);
  assertMatch(t, /crear_pedido_cod/);
  assertEquals(st.contenidos.get("wamid.IN9")?.texto_vendedor, t);
  assertEquals(st.enviados.length, 0); // responde el vendedor, no el webhook
});

Deno.test("mk_si con el chat en 'humano': no se le saca a Enrique, le llega el aviso con la oferta", async () => {
  const { deps, st } = mock({ estado: "humano", oferta: { plantilla: "voltra_mk_reposicion", variables: ["Ana", "parches bucales", "otra bolsa", "79.000"] } });
  await procesarMensaje(botonPlantilla("mk_si:1001", "Sí, mandame"), contacto, deps);
  assertEquals([st.pasados.length, st.estadosConv.length], [0, 0]);
  assertMatch(st.avisos[0], /otra bolsa de parches bucales a Gs 79\.000/);
});

Deno.test("contextoOfertaAceptada: cruzada, lanzamiento, solo 1 bolsa y oferta no encontrada", () => {
  assertMatch(
    contextoOfertaAceptada("mk_quiero", { plantilla: "voltra_mk_cruzada", variables: ["Ana", "raspador", "parches bucales", "79000"] }),
    /quiere parches bucales a Gs 79\.000/,
  );
  assertMatch(
    contextoOfertaAceptada("mk_quiero", { plantilla: "voltra_mk_lanzamiento", variables: ["Botella", "99.000", "15 de octubre"] }),
    /quiere Botella a Gs 99\.000/,
  );
  const una = contextoOfertaAceptada("mk_una", { plantilla: "voltra_mk_pack", variables: ["Ana", "tiras nasales", "el pack de 2 bolsas", "125.000"] });
  assertMatch(una, /solo 1 bolsa de tiras nasales/);
  assert(!una.includes("125.000")); // no le pasa el precio del pack como si fuera el de 1 bolsa
  assertMatch(contextoOfertaAceptada("mk_si", null), /no encontré cuál/);
});

const pedidoPendiente: Pedido = {
  shopify_order_id: 1001,
  nombre: "#1001",
  cliente_id: "cli-1",
  telefono: `+${TEL}`,
  estado_confirmacion: "pendiente",
  tags: [],
  courier: "lucero",
};
const confSi = { ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "conf_si:1001", title: "Confirmar" } } } as MensajeMeta;

Deno.test("conf_si: la oferta QR sale solo con config_wa['ola4.qr'].activo", async () => {
  let m = mock({ pedidos: [{ ...pedidoPendiente }] });
  await procesarMensaje(confSi, contacto, m.deps);
  assertEquals([m.st.qrPedidos.length, m.st.enviados.length], [0, 1]);

  m = mock({ pedidos: [{ ...pedidoPendiente }], config: { "ola4.qr": { activo: true } } });
  await procesarMensaje(confSi, contacto, m.deps);
  assertEquals(m.st.qrPedidos, [1001]);
  assertEquals(m.st.enviados[1], "Pagá con QR: https://ejemplo.test/qr");

  // Si el proveedor falla, la confirmación igual quedó hecha y Enrique ve la falla.
  m = mock({ pedidos: [{ ...pedidoPendiente }], config: { "ola4.qr": { activo: true } }, qr: { ok: false, motivo: "error_proveedor" } });
  await procesarMensaje(confSi, contacto, m.deps);
  assertEquals(m.st.enviados.length, 1);
  assertMatch(m.st.avisos.at(-1)!, /oferta QR: error_proveedor/);
});

Deno.test("estado 'failed' con 131050: baja de marketing del cliente del mensaje", async () => {
  const { deps, st } = mock();
  await procesarEstado({ id: "wamid.OUT1", status: "failed", errors: [{ code: 131050, title: "opted out" }] }, deps);
  assertEquals(st.bajas, [["cli-1", "meta_131050"]]);
  const otro = mock();
  await procesarEstado({ id: "wamid.OUT2", status: "failed", errors: [{ code: 131026 }] }, otro.deps);
  assertEquals(otro.st.bajas.length, 0);
});
