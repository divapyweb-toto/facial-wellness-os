// 13-10: testimonios después de la entrega (foto, video o comentario) + permiso + hitos de 5 en 5.
// Datos inventados (repo público).
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  conPedidoAbierto,
  type Deps,
  type EntradaVendedor,
  esComentarioTestimonio,
  hitoTestimonios,
  leerBotonTestimonio,
  type MensajeMeta,
  type Pedido,
  procesarMensaje,
  TEXTOS_BOTONES_DEFAULT,
  type TestimonioNuevo,
} from "./procesar.ts";

const TEL = "595981000000";
const contacto = { profile: { name: "Ana Prueba" }, wa_id: TEL, user_id: "PY.1234567890123" };
const AHORA = new Date("2026-10-13T15:00:00Z");
const ID1 = "0b6c2f7e-1111-4a2b-9c3d-000000000001";

const PEDIDO: Pedido = {
  shopify_order_id: 7001, nombre: "#1701", cliente_id: "cli-1", telefono: "+595981000000",
  estado_confirmacion: "confirmado", estado_envio: "ENTREGADO",
  raw: { line_items: [{ quantity: 1, title: "Tiras nasales Gudair" }], shipping_address: { first_name: "Ana" } },
};

let nMsg = 0;
const msg = (x: Partial<MensajeMeta>): MensajeMeta => ({ from: TEL, id: `wamid.T${++nMsg}`, timestamp: "1", type: "text", ...x }) as MensajeMeta;
const boton = (payload: string): MensajeMeta => msg({ type: "button", button: { payload, text: "x" } });

function mock(op: { conTabla?: boolean; autorizadosPrevios?: number } = {}) {
  const st = {
    pasados: [] as EntradaVendedor[],
    enviados: [] as string[],
    botones: [] as { texto: string; botones: { id: string; titulo: string }[] }[],
    avisos: [] as string[],
    testimonios: [] as (TestimonioNuevo & { id: string; autorizado: boolean | null })[],
    hitos: new Set<number>(),
  };
  const perfil: Record<string, unknown> = {};
  const deps: Deps = {
    ahora: () => AHORA,
    config: () => Promise.resolve(null),
    guardarEventoCrudo: () => Promise.resolve(true),
    marcarEventoProcesado: () => Promise.resolve(),
    upsertCliente: () => Promise.resolve({ id: "cli-1", nombre: "Ana Prueba" }),
    conversacionActiva: () => Promise.resolve({ id: "conv-1", estado: "ia" }),
    actualizarConversacion: () => Promise.resolve(),
    insertarMensajeEntrante: () => Promise.resolve(true),
    completarContenidoMensaje: () => Promise.resolve(),
    estadoMensaje: () => Promise.resolve("enviado"),
    actualizarMensaje: () => Promise.resolve(),
    copiarAudio: (_m, ruta) => Promise.resolve({ ok: true, ruta, mime: "audio/ogg" }),
    copiarMediaChat: (_m, ruta) => Promise.resolve({ ok: true, ruta, mime: "image/jpeg" }),
    buscarPedido: (id) => Promise.resolve(String(PEDIDO.shopify_order_id) === id ? PEDIDO : null),
    pedidosPorEstado: () => Promise.resolve([]),
    actualizarPedido: () => Promise.resolve(),
    cancelarEnviosPendientes: () => Promise.resolve(0),
    agregarTags: () => Promise.resolve({ ok: true }),
    quitarTags: () => Promise.resolve({ ok: true }),
    avisar: (t) => (st.avisos.push(t), Promise.resolve({ ok: true })),
    enviarTexto: (_to, t) => (st.enviados.push(t), Promise.resolve({ ok: true })),
    enviarBotones: (_to, t, b) => (st.botones.push({ texto: t, botones: b }), Promise.resolve({ ok: true })),
    consentimientoMarketing: () => Promise.resolve("si"),
    registrarConsentimiento: () => Promise.resolve(),
    marcarLeidoYEscribiendo: () => Promise.resolve(),
    normalizarTelefono: (x) => `+${x.replace(/\D/g, "")}`,
    pasarAlVendedor: (d) => (st.pasados.push(d), Promise.resolve()),
    perfilConversacion: () => Promise.resolve({ ...perfil }),
    marcarPerfil: (_c, k, v) => {
      if (v === null) delete perfil[k];
      else perfil[k] = v;
      return Promise.resolve();
    },
  };
  if (op.conTabla !== false) {
    for (let i = 0; i < (op.autorizadosPrevios ?? 0); i++) {
      st.testimonios.push({
        id: `prev-${i}`, cliente_id: "otro", shopify_order_id: null, tipo: "foto", ruta_storage: null, texto: null,
        producto: null, wa_message_id: `prev-${i}`, autorizado: true,
      });
    }
    deps.guardarTestimonio = (t) => {
      if (st.testimonios.some((x) => x.wa_message_id === t.wa_message_id)) return Promise.resolve(null);
      const id = st.testimonios.length === (op.autorizadosPrevios ?? 0) ? ID1 : crypto.randomUUID();
      st.testimonios.push({ ...t, id, autorizado: null });
      return Promise.resolve({ id });
    };
    deps.responderPermisoTestimonio = (id, cliente, aut) => {
      const t = st.testimonios.find((x) => x.id === id && x.cliente_id === cliente && x.autorizado === null);
      if (!t) return Promise.resolve(false);
      t.autorizado = aut;
      return Promise.resolve(true);
    };
    deps.contarTestimoniosAutorizados = () => Promise.resolve(st.testimonios.filter((x) => x.autorizado === true).length);
    deps.registrarHitoTestimonios = (h) => {
      if (st.hitos.has(h)) return Promise.resolve(false);
      st.hitos.add(h);
      return Promise.resolve(true);
    };
  }
  return { deps, st, perfil };
}

/** "Todo bien" en el seguimiento del pedido 7001 → queda el pedido de testimonio en el perfil. */
async function todoBien(deps: Deps) {
  await procesarMensaje(boton("seg_bien:7001"), contacto, deps);
}

Deno.test("13-10: 'Todo bien' pide foto, video o comentario y recuerda el pedido", async () => {
  const { deps, st, perfil } = mock();
  await todoBien(deps);
  assertMatch(st.enviados.at(-1)!, /foto o un video cortito usándolo, o nos contás en una frase/);
  assertEquals(perfil.testimonio_pedido, "7001");
  assert(typeof perfil.pidio_testimonio_en === "string");
});

Deno.test("13-10: foto → se guarda con la copia de Storage, pedido y producto; se pide permiso con 2 botones (≤ 20)", async () => {
  const { deps, st, perfil } = mock();
  await todoBien(deps);
  await procesarMensaje(msg({ type: "image", image: { id: "img1", mime_type: "image/jpeg", caption: "Re buenas" } }), contacto, deps);
  assertEquals(st.pasados.length, 0, "no va al vendedor");
  assertEquals(st.testimonios.length, 1);
  const t = st.testimonios[0];
  assertEquals([t.tipo, t.shopify_order_id, t.producto, t.texto, t.cliente_id], ["foto", 7001, "1 Tiras nasales Gudair", "Re buenas", "cli-1"]);
  assertMatch(t.ruta_storage!, /^media\/cli-1\/wamid\.T\d+\.jpg$/);
  const b = st.botones.at(-1)!;
  assertMatch(b.texto, /¿Podemos mostrar tu foto en nuestras redes\? Va sin tu nombre ni tu número/);
  assertEquals(b.botones, [{ id: `tst_si:${ID1}`, titulo: "Sí, podés usarla" }, { id: `tst_no:${ID1}`, titulo: "No, prefiero que no" }]);
  assert(b.botones.every((x) => x.titulo.length <= 20));
  assertEquals(perfil.pidio_testimonio_en, undefined);
  assertEquals(st.avisos.length, 0, "ya no hay aviso por cada foto (solo los hitos)");
});

Deno.test("13-10: comentario corto → testimonio de texto; una pregunta o un 'no' siguen al vendedor", async () => {
  const { deps, st } = mock();
  await todoBien(deps);
  await procesarMensaje(msg({ text: { body: "¿Cuándo llega mi otro pedido?" } }), contacto, deps);
  await procesarMensaje(msg({ text: { body: "no, después te mando" } }), contacto, deps);
  assertEquals(st.pasados.length, 2);
  assertEquals(st.testimonios.length, 0);
  await procesarMensaje(msg({ text: { body: "Muy buenas las tiras, ya duermo mucho mejor" } }), contacto, deps);
  assertEquals(st.pasados.length, 2);
  assertEquals(st.testimonios.map((t) => [t.tipo, t.texto]), [["texto", "Muy buenas las tiras, ya duermo mucho mejor"]]);
  assertMatch(st.botones.at(-1)!.texto, /tu comentario/);
  // Después del testimonio, otro texto ya va al vendedor.
  await procesarMensaje(msg({ text: { body: "Gracias por todo, muy buena atención" } }), contacto, deps);
  assertEquals(st.pasados.length, 3);
});

Deno.test("13-10: sin pedido de testimonio (o vencido) la foto y el texto van al vendedor", async () => {
  const { deps, st, perfil } = mock();
  await procesarMensaje(msg({ type: "image", image: { id: "img1", mime_type: "image/jpeg" } }), contacto, deps);
  perfil.pidio_testimonio_en = new Date(AHORA.getTime() - 8 * 86_400_000).toISOString();
  await procesarMensaje(msg({ text: { body: "Muy buenas las tiras, ya duermo mucho mejor" } }), contacto, deps);
  assertEquals([st.pasados.length, st.testimonios.length], [2, 0]);
});

Deno.test("13-10: permiso Sí/No: solo el dueño y una sola vez; responde corto", async () => {
  const { deps, st } = mock();
  await todoBien(deps);
  await procesarMensaje(msg({ type: "video", video: { id: "v1", mime_type: "video/mp4" } }), contacto, deps);
  assertEquals(st.testimonios[0].tipo, "video");
  await procesarMensaje(boton(`tst_si:${ID1}`), contacto, deps);
  assertEquals(st.testimonios[0].autorizado, true);
  assertMatch(st.enviados.at(-1)!, /Va sin tu nombre ni tu número/);
  await procesarMensaje(boton(`tst_no:${ID1}`), contacto, deps); // segundo toque: no lo da vuelta
  assertEquals(st.testimonios[0].autorizado, true);
  assertEquals(st.pasados.length, 0);
  assertEquals(st.avisos.length, 0, "1 autorizado: sin aviso");
});

Deno.test("13-10: al llegar a 5 autorizados avisa UNA vez; el 6 no; el 10 sí", async () => {
  const { deps, st } = mock({ autorizadosPrevios: 4 });
  await todoBien(deps);
  await procesarMensaje(msg({ type: "image", image: { id: "img1", mime_type: "image/jpeg" } }), contacto, deps);
  await procesarMensaje(boton(`tst_si:${ID1}`), contacto, deps);
  assertEquals(st.avisos.length, 1);
  assertMatch(st.avisos[0], /5 testimonios/);
  // Hito ya avisado: aunque el conteo vuelva a dar 5 (uno revocado a mano y otro nuevo), no se repite.
  assertEquals(await deps.registrarHitoTestimonios!(5), false);
  assertEquals([hitoTestimonios(4), hitoTestimonios(5), hitoTestimonios(6), hitoTestimonios(10), hitoTestimonios(12)], [null, 5, 5, 10, 10]);
});

Deno.test("13-10: sin la tabla (deps viejas) queda como el 09-10: gracias + aviso", async () => {
  const { deps, st } = mock({ conTabla: false });
  await todoBien(deps);
  await procesarMensaje(msg({ type: "image", image: { id: "img1", mime_type: "image/jpeg" } }), contacto, deps);
  assertMatch(st.enviados.at(-1)!, /Gracias/);
  assertMatch(st.avisos.at(-1)!, /testimonio/);
});

Deno.test("13-10: esComentarioTestimonio y leerBotonTestimonio", () => {
  for (const t of ["Me encantaron, muy buena calidad", "Ya no ronco, mi señora feliz jaja"]) assert(esComentarioTestimonio(t), t);
  for (const t of ["ok", "gracias!", "dale", "No me llegó todavía", "quiero otra bolsa por favor", "cuanto sale el pack", "todavía no lo usé bien"]) {
    assert(!esComentarioTestimonio(t), t);
  }
  assertEquals(leerBotonTestimonio(boton(`tst_si:${ID1}`)), { autorizado: true, id: ID1 });
  assertEquals(leerBotonTestimonio(boton(`tst_no:${ID1.toUpperCase()}`)), { autorizado: false, id: ID1 });
  assertEquals(leerBotonTestimonio(boton("tst_si:123")), null);
  for (const k of ["permiso_testimonio_si", "permiso_testimonio_no"]) assert(TEXTOS_BOTONES_DEFAULT[k].length <= 20, k);
});

Deno.test("13-10: el vendedor recibe el contexto del intento fallido para coordinar día y dirección", async () => {
  const { deps } = mock();
  const viejo = new Date(AHORA.getTime() - 15 * 86_400_000).toISOString();
  deps.pedidosPorEstado = (_c, _t, estado) => Promise.resolve(estado === "confirmado" ? [{
    shopify_order_id: 7002, nombre: "#1702", estado_confirmacion: "confirmado", estado_envio: "INTENTO_FALLIDO", creado_en: viejo,
    raw: { fulfillment_status: "fulfilled", total_price: "129000", line_items: [{ quantity: 1, title: "Tiras" }], shipping_address: { address1: "Calle 1", city: "Luque" } },
  }] : []);
  const t = await conPedidoAbierto(deps, "cli-1", null, "mañana a la tarde");
  assertMatch(t, /^\[pedido #1702 de la tienda, INTENTO DE ENTREGA FALLIDO/);
  assertMatch(t, /actualizar_direccion/);
  assertMatch(t, /No prometas una hora ni ofrezcas cancelar/);
  assertMatch(t, /mañana a la tarde$/);
  // Un confirmado viejo (15 días) que NO está en reintento no se usa.
  deps.pedidosPorEstado = (_c, _t, estado) => Promise.resolve(estado === "confirmado" ? [{
    shopify_order_id: 7003, nombre: "#1703", estado_confirmacion: "confirmado", estado_envio: "DESPACHADO", creado_en: viejo, raw: {},
  }] : []);
  assertEquals(await conPedidoAbierto(deps, "cli-1", null, "hola"), "hola");
});
