// Tests de la lógica del webhook de WhatsApp. Datos inventados (repo público).
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  calcularCostoUsd,
  type Deps,
  esAceptacion,
  extraerEventos,
  leerBotonConfirmacion,
  leerBotonPostventa,
  manejarRequest,
  mediaDeComprobante,
  type MensajeMeta,
  PAGO_ANTICIPADO_DEFAULT,
  type Pedido,
  pedidoYaPagado,
  procesarEventos,
  recibirPayload,
  renderizar,
  siguienteEstado,
  TAG_COMPROBANTE_PAGO,
  TAG_OFERTA_PAGO,
  TAG_PRIORIDAD,
  esRespuestaAutomatica,
  leerBotonMarketing,
  contextoOfertaAceptada,
} from "./procesar.ts";

const TEL = "595981000000";
const BSUID = "PY.1234567890123";
const ORDER = "5550001112223";

// ---------- payloads de ejemplo (forma de la documentación de Meta) ----------

function payloadMensajes(mensajes: Record<string, unknown>[], contacto: Record<string, unknown> = { profile: { name: "Ana Prueba" }, wa_id: TEL, user_id: BSUID }) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550000000", phone_number_id: "PHONE_ID" },
          contacts: [contacto],
          messages: mensajes,
        },
      }],
    }],
  };
}

function payloadEstados(estados: Record<string, unknown>[]) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_ID", changes: [{ field: "messages", value: { messaging_product: "whatsapp", statuses: estados } }] }],
  };
}

const botonInteractivo = (id: string, wamid = "wamid.IN1"): Record<string, unknown> => ({
  from: TEL,
  from_user_id: BSUID,
  id: wamid,
  timestamp: "1791300000",
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id, title: "Confirmar" } },
});

// ---------- mock de Deps en memoria ----------

type Estado = {
  crudos: Set<string>;
  crudosPayload: Map<string, unknown>;
  botones: { to: string; texto: string; botones: { id: string; titulo: string }[] }[];
  consentimientos: { cliente_id: string; estado: string; origen: string }[];
  procesados: Map<string, string | null>;
  clientes: { id: string; wa_user_id: string | null; telefono: string | null; nombre: string | null }[];
  conversaciones: { id: string; cliente_id: string; estado: string }[];
  mensajes: Map<string, Record<string, unknown>>;
  pedidos: Map<string, Pedido>;
  envios: { id: string; shopify_order_id: string; plantilla: string; estado: string }[];
  tagsAgregados: [string, string[]][];
  tagsQuitados: [string, string[]][];
  avisos: { texto: string; botones?: unknown }[];
  enviados: { to: string; texto: string }[];
  leidos: string[];
  audios: string[];
  config: Record<string, unknown>;
};

function crearMock(over: Partial<Estado> = {}): { deps: Deps; st: Estado } {
  const st: Estado = {
    crudos: new Set(),
    crudosPayload: new Map(),
    botones: [],
    consentimientos: [],
    procesados: new Map(),
    clientes: [],
    conversaciones: [],
    mensajes: new Map(),
    pedidos: new Map(),
    envios: [],
    tagsAgregados: [],
    tagsQuitados: [],
    avisos: [],
    enviados: [],
    leidos: [],
    audios: [],
    config: {
      tarifas_usd: { utilidad: 0.0113, marketing: 0.074 },
      plazos_courier: { lucero: "1 a 3 días hábiles", pap: "2 a 5 días hábiles; interior, hasta 10" },
      confirmacion: { recordatorio_h: 4, retener_h: 48, cancelar_h: 72 },
      palabras_prohibidas: ["garantía"],
    },
    ...over,
  };
  let n = 0;
  const deps: Deps = {
    ahora: () => new Date("2026-10-06T15:00:00Z"),
    config: (k) => Promise.resolve(st.config[k] ?? null),
    guardarEventoCrudo: (id, payload) => {
      if (st.crudos.has(id)) return Promise.resolve(false);
      st.crudos.add(id);
      st.crudosPayload.set(id, payload);
      return Promise.resolve(true);
    },
    marcarEventoProcesado: (id, e) => (st.procesados.set(id, e), Promise.resolve()),
    upsertCliente: (d) => {
      let c = st.clientes.find((x) => (d.wa_user_id && x.wa_user_id === d.wa_user_id) || (d.telefono && x.telefono === d.telefono));
      if (!c) {
        c = { id: `cli-${++n}`, wa_user_id: d.wa_user_id, telefono: d.telefono, nombre: d.nombre };
        st.clientes.push(c);
      }
      c.wa_user_id ??= d.wa_user_id;
      c.telefono ??= d.telefono;
      return Promise.resolve({ id: c.id, nombre: c.nombre });
    },
    conversacionActiva: (clienteId) => {
      let c = st.conversaciones.find((x) => x.cliente_id === clienteId && x.estado !== "cerrada");
      if (!c) {
        c = { id: `conv-${++n}`, cliente_id: clienteId, estado: "ia" };
        st.conversaciones.push(c);
      }
      return Promise.resolve({ ...c });
    },
    actualizarConversacion: (id, cambios) => {
      const c = st.conversaciones.find((x) => x.id === id)!;
      if (cambios.estado) c.estado = cambios.estado;
      return Promise.resolve();
    },
    insertarMensajeEntrante: (fila) => {
      const id = fila.wa_message_id as string;
      if (st.mensajes.has(id)) return Promise.resolve(false);
      st.mensajes.set(id, { ...fila });
      return Promise.resolve(true);
    },
    completarContenidoMensaje: (id, extra) => {
      const m = st.mensajes.get(id)!;
      m.contenido = { ...(m.contenido as object), ...extra };
      return Promise.resolve();
    },
    estadoMensaje: (id) => Promise.resolve(st.mensajes.has(id) ? (st.mensajes.get(id)!.estado as string) : undefined),
    actualizarMensaje: (id, cambios) => (Object.assign(st.mensajes.get(id)!, cambios), Promise.resolve()),
    copiarAudio: (mediaId, ruta) => (st.audios.push(`${mediaId}->${ruta}`), Promise.resolve({ ok: true, ruta, mime: "audio/ogg" })),
    buscarPedido: (id) => Promise.resolve(st.pedidos.get(id) ?? null),
    pedidosPorEstado: (clienteId, telefono, estado, desde) =>
      Promise.resolve(
        [...st.pedidos.values()].filter((p) =>
          p.estado_confirmacion === estado &&
          (p.cliente_id === clienteId || (telefono && p.telefono === telefono)) &&
          (!desde || (p.creado_en ?? "") >= desde)
        ),
      ),
    actualizarPedido: (id, c) => (Object.assign(st.pedidos.get(id)!, c), Promise.resolve()),
    cancelarEnviosPendientes: (id, patrones) => {
      let k = 0;
      for (const e of st.envios) {
        if (e.shopify_order_id === id && e.estado === "pendiente" && patrones.some((p) => e.plantilla.includes(p))) {
          e.estado = "cancelado";
          k++;
        }
      }
      return Promise.resolve(k);
    },
    agregarTags: (gid, tags) => (st.tagsAgregados.push([gid, tags]), Promise.resolve({ ok: true })),
    quitarTags: (gid, tags) => (st.tagsQuitados.push([gid, tags]), Promise.resolve({ ok: true })),
    avisar: (texto, botones) => (st.avisos.push({ texto, botones }), Promise.resolve({ ok: true })),
    enviarTexto: (to, texto) => (st.enviados.push({ to, texto }), Promise.resolve({ ok: true, wa_message_id: `wamid.OUT${++n}` })),
    enviarBotones: (to, texto, botones) => (st.botones.push({ to, texto, botones }), Promise.resolve({ ok: true, wa_message_id: `wamid.OUT${++n}` })),
    consentimientoMarketing: (clienteId) => {
      const c = st.consentimientos.filter((x) => x.cliente_id === clienteId).at(-1);
      return Promise.resolve((c?.estado ?? null) as "si" | "no" | "baja" | null);
    },
    registrarConsentimiento: (clienteId, estado, origen) => (st.consentimientos.push({ cliente_id: clienteId, estado, origen }), Promise.resolve()),
    marcarLeidoYEscribiendo: (id) => (st.leidos.push(id), Promise.resolve({ ok: true })),
    normalizarTelefono: (x) => (/^5959\d{8}$/.test(x) ? `+${x}` : null),
  };
  return { deps, st };
}

function pedidoPendiente(extra: Partial<Pedido> = {}): Pedido {
  return {
    shopify_order_id: ORDER,
    nombre: "#1001",
    cliente_id: null,
    telefono: `+${TEL}`,
    estado_confirmacion: "pendiente",
    tags: [],
    courier: "lucero",
    creado_en: "2026-10-06T12:00:00.000Z",
    raw: { customer: { first_name: "Ana" } },
    ...extra,
  };
}

function enviosDelPedido() {
  return [
    { id: "e1", shopify_order_id: ORDER, plantilla: "voltra_recordatorio_confirmacion", estado: "pendiente" },
    { id: "e2", shopify_order_id: ORDER, plantilla: "accion:retener", estado: "pendiente" },
    { id: "e3", shopify_order_id: ORDER, plantilla: "accion:cancelar", estado: "pendiente" },
    { id: "e4", shopify_order_id: "999", plantilla: "voltra_recordatorio_confirmacion", estado: "pendiente" },
  ];
}

async function correr(deps: Deps, payload: unknown) {
  const r = await recibirPayload(payload, deps);
  await procesarEventos(r.nuevos, deps);
  return r;
}

// ---------- funciones puras ----------

Deno.test("leerBotonConfirmacion: interactivo y botón de plantilla", () => {
  assertEquals(leerBotonConfirmacion(botonInteractivo(`conf_si:${ORDER}`) as MensajeMeta), { accion: "conf_si", orderId: ORDER });
  assertEquals(
    leerBotonConfirmacion({ id: "x", type: "button", button: { payload: `conf_cancelar:${ORDER}`, text: "Cancelar" } }),
    { accion: "conf_cancelar", orderId: ORDER },
  );
  assertEquals(leerBotonConfirmacion({ id: "x", type: "button", button: { payload: "Unsubscribe" } }), null);
  assertEquals(leerBotonConfirmacion({ id: "x", type: "text", text: { body: `conf_si:${ORDER}` } }), null);
});

Deno.test("esAceptacion: sí/ok/dale/ya/katu, sin falsos positivos", () => {
  const l = ["si", "sí", "ok", "dale", "ya", "katu", "mandame katu", "si luego"];
  for (const t of ["Sí", "si!!", "OK", "dale", "Ya", "mandame katu", "si dale", "Si luego 👍"]) assert(esAceptacion(t, l), t);
  for (const t of ["no", "si pero cambien la dirección", "ya pagué", "", "🙂"]) assertFalse(esAceptacion(t, l), t);
});

Deno.test("siguienteEstado no retrocede y respeta fallido", () => {
  assertEquals(siguienteEstado("enviado", "delivered"), "entregado");
  assertEquals(siguienteEstado("leido", "delivered"), null);
  assertEquals(siguienteEstado("entregado", "failed"), "fallido");
  assertEquals(siguienteEstado("fallido", "read"), null);
  assertEquals(siguienteEstado(null, "sent"), "enviado");
});

Deno.test("calcularCostoUsd según pricing de Meta", () => {
  const t = { utilidad: 0.0113, marketing: 0.074 };
  assertEquals(calcularCostoUsd({ billable: true, type: "regular", category: "utility" }, t), 0.0113);
  assertEquals(calcularCostoUsd({ billable: true, type: "regular", category: "marketing_lite" }, t), 0.074);
  assertEquals(calcularCostoUsd({ billable: false, type: "free_customer_service", category: "utility" }, t), 0);
  assertEquals(calcularCostoUsd({ type: "free_entry_point", category: "service" }, t), 0);
  assertEquals(calcularCostoUsd({ billable: true, type: "regular", category: "service" }, t), 0.0113);
  assertEquals(calcularCostoUsd({ billable: true, type: "regular", category: "authentication" }, t), null);
});

Deno.test("renderizar con y sin nombre", () => {
  assertEquals(renderizar("Listo {nombre}, quedó. {plazo}", { nombre: "Ana", plazo: "1 a 3" }), "Listo Ana, quedó. 1 a 3");
  assertEquals(renderizar("Listo {nombre}, quedó.", { nombre: "" }), "Listo, quedó.");
});

Deno.test("extraerEventos: mensaje sin teléfono (solo user_id) se asocia a su contacto", () => {
  const p = payloadMensajes(
    [{ from_user_id: BSUID, id: "wamid.SOLOUSER", timestamp: "1791300000", type: "text", text: { body: "hola" } }],
    { profile: { name: "Ana Prueba", username: "@anaprueba" }, user_id: BSUID },
  );
  const ev = extraerEventos(p);
  assertEquals(ev.length, 1);
  assertEquals(ev[0].idExterno, "msg:wamid.SOLOUSER");
  assert(ev[0].clase === "mensaje" && ev[0].contacto?.user_id === BSUID);
});

// ---------- HTTP ----------

const envHttp = (firmaOk: boolean, tareas: Promise<unknown>[] = []) => ({
  verifyToken: "token-de-prueba",
  appSecret: "secreto-de-prueba",
  verificarFirma: () => Promise.resolve(firmaOk),
  enSegundoPlano: (p: Promise<unknown>) => void tareas.push(p),
});

Deno.test("GET de verificación devuelve hub.challenge solo con el token correcto", async () => {
  const { deps } = crearMock();
  const ok = await manejarRequest(
    new Request("https://x/wa-webhook?hub.mode=subscribe&hub.verify_token=token-de-prueba&hub.challenge=12345"),
    deps,
    envHttp(true),
  );
  assertEquals([ok.status, await ok.text()], [200, "12345"]);
  const mal = await manejarRequest(
    new Request("https://x/wa-webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=12345"),
    deps,
    envHttp(true),
  );
  assertEquals(mal.status, 403);
  await mal.body?.cancel();
});

Deno.test("POST con firma inválida → 401 y no guarda nada", async () => {
  const { deps, st } = crearMock();
  const r = await manejarRequest(
    new Request("https://x/wa-webhook", { method: "POST", body: JSON.stringify(payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)])) }),
    deps,
    envHttp(false),
  );
  assertEquals(r.status, 401);
  await r.body?.cancel();
  assertEquals(st.crudos.size, 0);
});

Deno.test("POST con firma válida → guarda crudo, 200 y procesa en segundo plano", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente());
  const tareas: Promise<unknown>[] = [];
  const r = await manejarRequest(
    new Request("https://x/wa-webhook", { method: "POST", body: JSON.stringify(payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)])) }),
    deps,
    envHttp(true, tareas),
  );
  assertEquals(r.status, 200);
  await r.body?.cancel();
  assert(st.crudos.has("msg:wamid.IN1"));
  await Promise.all(tareas);
  assertEquals(st.pedidos.get(ORDER)!.estado_confirmacion, "confirmado");
  assertEquals(st.procesados.get("msg:wamid.IN1"), null);
});

// ---------- flujo de botones ----------

Deno.test("conf_si: confirma, tag, respuesta con plazo del courier, Telegram y cancela pendientes", async () => {
  const { deps, st } = crearMock({ envios: enviosDelPedido() });
  st.pedidos.set(ORDER, pedidoPendiente());
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]));
  const p = st.pedidos.get(ORDER)!;
  assertEquals(p.estado_confirmacion, "confirmado");
  assertEquals(p.tags, ["CONFIRMADO"]);
  assertEquals(st.tagsAgregados, [[`gid://shopify/Order/${ORDER}`, ["CONFIRMADO"]]]);
  assertEquals(st.enviados.length, 1);
  assertEquals(st.enviados[0].to, `+${TEL}`);
  assertEquals(st.enviados[0].texto, "Listo Ana, quedó confirmado. Te llega en 1 a 3 días hábiles; te avisamos cuando lo preparemos.");
  assertEquals(st.leidos, ["wamid.IN1"]);
  assertEquals(st.avisos.length, 1);
  assert(st.avisos[0].texto.includes("#1001"));
  assertEquals(st.envios.map((e) => e.estado), ["cancelado", "cancelado", "cancelado", "pendiente"]);
});

Deno.test("conf_corregir: a_corregir, tag, pide el dato, chat a humano y aviso con botón", async () => {
  const { deps, st } = crearMock({ envios: enviosDelPedido() });
  st.pedidos.set(ORDER, pedidoPendiente());
  await correr(deps, payloadMensajes([botonInteractivo(`conf_corregir:${ORDER}`)]));
  assertEquals(st.pedidos.get(ORDER)!.estado_confirmacion, "a_corregir");
  assertEquals(st.tagsAgregados[0][1], ["A_CORREGIR"]);
  assert(st.enviados[0].texto.startsWith("Dale, escribime acá el dato correcto"));
  assertEquals(st.conversaciones[0].estado, "humano");
  assertEquals(JSON.stringify(st.avisos[0].botones), JSON.stringify([[{ texto: "Le escribo yo", callback: `escribo:${ORDER}` }]]));
  // No se tocan los programados (lo pidió así el contrato de B; ver reporte).
  assertEquals(st.envios.filter((e) => e.estado === "pendiente").length, 4);

  // El texto siguiente del cliente (el dato corregido) llega a Telegram.
  await correr(deps, payloadMensajes([{ from: TEL, from_user_id: BSUID, id: "wamid.IN2", timestamp: "1791300100", type: "text", text: { body: "Calle Falsa 123" } }]));
  assert(st.avisos[1].texto.includes("Calle Falsa 123"));
});

Deno.test("conf_cancelar: cancelado_cliente, tag, respuesta, aviso con botón cancelar y quita CONFIRMADO", async () => {
  const { deps, st } = crearMock({ envios: enviosDelPedido() });
  st.pedidos.set(ORDER, pedidoPendiente({ estado_confirmacion: "confirmado", tags: ["CONFIRMADO", "OTRA"] }));
  await correr(deps, payloadMensajes([botonInteractivo(`conf_cancelar:${ORDER}`)]));
  const p = st.pedidos.get(ORDER)!;
  assertEquals(p.estado_confirmacion, "cancelado_cliente");
  assertEquals(p.tags, ["OTRA", "CANCELADO_CLIENTE"]);
  assertEquals(st.tagsQuitados, [[`gid://shopify/Order/${ORDER}`, ["CONFIRMADO"]]]);
  assert(st.enviados[0].texto.startsWith("Entendido, cancelamos tu pedido."));
  assertEquals(JSON.stringify(st.avisos[0].botones), JSON.stringify([[{ texto: "Cancelar pedido", callback: `cancelar:${ORDER}` }]]));
});

Deno.test("botón de plantilla (type button, payload) también funciona", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente());
  await correr(deps, payloadMensajes([{ from: TEL, id: "wamid.TPL", timestamp: "1791300000", type: "button", button: { payload: `conf_si:${ORDER}`, text: "Confirmar" } }]));
  assertEquals(st.pedidos.get(ORDER)!.estado_confirmacion, "confirmado");
});

Deno.test("payload repetido: no duplica mensaje, tags, respuesta ni aviso", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente());
  const p = payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]);
  await correr(deps, p);
  const r2 = await correr(deps, p);
  assertEquals(r2.nuevos.length, 0);
  // Aunque el crudo se pierda, el mensaje repetido se corta por wa_message_id.
  st.crudos.clear();
  await correr(deps, p);
  assertEquals(st.mensajes.size, 1);
  assertEquals(st.tagsAgregados.length, 1);
  assertEquals(st.enviados.length, 1);
  assertEquals(st.avisos.length, 1);
});

Deno.test("toque repetido del mismo botón (otro wamid) no repite acciones", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente());
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`, "wamid.A")]));
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`, "wamid.B")]));
  assertEquals(st.tagsAgregados.length, 1);
  assertEquals(st.enviados.length, 1);
});

Deno.test("botón de un pedido de otro cliente: no hace nada y avisa", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ telefono: "+595981999999", cliente_id: "cli-otro" }));
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]));
  assertEquals(st.pedidos.get(ORDER)!.estado_confirmacion, "pendiente");
  assertEquals(st.enviados.length, 0);
  assert(st.avisos[0].texto.includes("otro cliente"));
});

// ---------- aceptación escrita ----------

Deno.test("'dale' escrito con un pedido pendiente reciente = conf_si (lista default si falta config)", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente());
  await correr(deps, payloadMensajes([{ from: TEL, id: "wamid.T1", timestamp: "1791300000", type: "text", text: { body: "Dale!" } }]));
  assertEquals(st.pedidos.get(ORDER)!.estado_confirmacion, "confirmado");
  assertEquals(st.tagsAgregados[0][1], ["CONFIRMADO"]);
});

Deno.test("'si' sin pedido pendiente reciente no confirma nada", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ creado_en: "2026-09-01T00:00:00.000Z" }));
  await correr(deps, payloadMensajes([{ from: TEL, id: "wamid.T2", timestamp: "1791300000", type: "text", text: { body: "si" } }]));
  assertEquals(st.pedidos.get(ORDER)!.estado_confirmacion, "pendiente");
  assertEquals(st.enviados.length, 0);
});

Deno.test("lista de aceptaciones desde config_wa reemplaza la default", async () => {
  const { deps, st } = crearMock();
  st.config.aceptaciones = ["confirmado"];
  st.pedidos.set(ORDER, pedidoPendiente());
  await correr(deps, payloadMensajes([{ from: TEL, id: "wamid.T3", timestamp: "1791300000", type: "text", text: { body: "dale" } }]));
  assertEquals(st.pedidos.get(ORDER)!.estado_confirmacion, "pendiente");
});

Deno.test("dos pedidos pendientes: no confirma solo, avisa", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente());
  st.pedidos.set("777", pedidoPendiente({ shopify_order_id: "777", nombre: "#1002" }));
  await correr(deps, payloadMensajes([{ from: TEL, id: "wamid.T4", timestamp: "1791300000", type: "text", text: { body: "ok" } }]));
  assertEquals([...st.pedidos.values()].map((p) => p.estado_confirmacion), ["pendiente", "pendiente"]);
  assert(st.avisos[0].texto.includes("2 pedidos pendientes"));
});

// ---------- cliente sin teléfono, audio y estados ----------

Deno.test("mensaje de cliente sin teléfono pero con user_id: crea cliente por BSUID y responde por recipient", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ telefono: null, cliente_id: null }));
  await correr(
    deps,
    payloadMensajes([{ ...botonInteractivo(`conf_si:${ORDER}`), from: undefined }], {
      profile: { name: "Ana Prueba", username: "@anaprueba" },
      user_id: BSUID,
    }),
  );
  assertEquals(st.clientes.length, 1);
  assertEquals(st.clientes[0].wa_user_id, BSUID);
  assertEquals(st.clientes[0].telefono, null);
  assertEquals(st.mensajes.get("wamid.IN1")!.cliente_id, st.clientes[0].id);
  assertEquals(st.enviados[0].to, BSUID);
});

Deno.test("audio: se copia a Storage wa-media y se guarda la ruta", async () => {
  const { deps, st } = crearMock();
  await correr(deps, payloadMensajes([{ from: TEL, id: "wamid.AUD", timestamp: "1791300000", type: "audio", audio: { id: "MEDIA1", mime_type: "audio/ogg; codecs=opus", voice: true } }]));
  assertEquals(st.audios, [`MEDIA1->audio/${st.clientes[0].id}/wamid.AUD.ogg`]);
  assertEquals((st.mensajes.get("wamid.AUD")!.contenido as Record<string, unknown>).storage_path, `audio/${st.clientes[0].id}/wamid.AUD.ogg`);
});

Deno.test("status con pricing: guarda categoría, costo y estado sin retroceder", async () => {
  const { deps, st } = crearMock();
  st.mensajes.set("wamid.OUTX", { estado: "enviado" });
  await correr(deps, payloadEstados([{
    id: "wamid.OUTX",
    status: "delivered",
    timestamp: "1791300000",
    recipient_id: TEL,
    pricing: { billable: true, pricing_model: "PMP", type: "regular", category: "utility" },
  }]));
  assertEquals(st.mensajes.get("wamid.OUTX"), { estado: "entregado", categoria_precio: "utility", costo_usd: 0.0113 });
  await correr(deps, payloadEstados([{ id: "wamid.OUTX", status: "sent", recipient_user_id: BSUID }]));
  assertEquals(st.mensajes.get("wamid.OUTX")!.estado, "entregado");
});

Deno.test("status de mensaje desconocido queda con error en eventos_crudos", async () => {
  const { deps, st } = crearMock();
  await correr(deps, payloadEstados([{ id: "wamid.NADA", status: "read" }]));
  assert((st.procesados.get("st:wamid.NADA:read") ?? "").includes("no está"));
});

// ---------- integración: botones post-venta, consentimiento y cambios de webhook ----------

const PROHIBIDAS = ["garantía", "devolución", "reembolso", "sin riesgo", "cura", "curar", "tratamiento", "oxígeno"];

Deno.test("leerBotonPostventa: pedido y consentimiento", () => {
  assertEquals(leerBotonPostventa(botonInteractivo(`ayuda:${ORDER}`) as MensajeMeta), { accion: "ayuda", id: ORDER });
  assertEquals(
    leerBotonPostventa({ id: "x", type: "button", button: { payload: `ne_direccion:${ORDER}` } }),
    { accion: "ne_direccion", id: ORDER },
  );
  const uuid = "0f8b6a1e-1111-4222-8333-444455556666";
  assertEquals(leerBotonPostventa(botonInteractivo(`cons_si:${uuid}`) as MensajeMeta), { accion: "cons_si", id: uuid });
  assertEquals(leerBotonPostventa(botonInteractivo(`conf_si:${ORDER}`) as MensajeMeta), null);
  assertEquals(leerBotonPostventa(botonInteractivo("ayuda:abc") as MensajeMeta), null);
});

Deno.test("ayuda: conversación a humano, respuesta y aviso con resumen", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ estado_confirmacion: "confirmado", estado_envio: "DESPACHADO" }));
  await correr(deps, payloadMensajes([botonInteractivo(`ayuda:${ORDER}`)]));
  assertEquals(st.conversaciones[0].estado, "humano");
  assertEquals(st.enviados.length, 1);
  assert(st.enviados[0].texto.includes("#1001"));
  assertEquals(st.avisos.length, 1);
  assert(st.avisos[0].texto.includes("Necesito ayuda") && st.avisos[0].texto.includes("DESPACHADO"));
  assert(JSON.stringify(st.avisos[0].botones).includes(`escribo:${ORDER}`));
});

Deno.test("ne_reintentar: aviso para coordinar con el courier, conversación sigue en ia", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ estado_confirmacion: "confirmado" }));
  await correr(deps, payloadMensajes([botonInteractivo(`ne_reintentar:${ORDER}`)]));
  assertEquals(st.conversaciones[0].estado, "ia");
  assertEquals(st.enviados.length, 1);
  assert(st.avisos[0].texto.includes("volver a intentar") && st.avisos[0].texto.includes("lucero"));
});

Deno.test("ne_direccion: pide la dirección, humano y aviso", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ estado_confirmacion: "confirmado" }));
  await correr(deps, payloadMensajes([botonInteractivo(`ne_direccion:${ORDER}`)]));
  assertEquals(st.conversaciones[0].estado, "humano");
  assert(st.enviados[0].texto.includes("dirección nueva"));
  assert(st.avisos[0].texto.includes("cambiar la dirección"));
});

Deno.test("ne_cancelar: aviso con botón cancelar:<id> y respuesta", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ estado_confirmacion: "confirmado" }));
  await correr(deps, payloadMensajes([botonInteractivo(`ne_cancelar:${ORDER}`)]));
  assertEquals(st.enviados.length, 1);
  assert(JSON.stringify(st.avisos[0].botones).includes(`cancelar:${ORDER}`));
});

Deno.test("seg_problema: reclamo, humano, botones reponer y escribo", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ estado_confirmacion: "confirmado", estado_envio: "ENTREGADO" }));
  await correr(deps, payloadMensajes([botonInteractivo(`seg_problema:${ORDER}`)]));
  assertEquals(st.conversaciones[0].estado, "humano");
  assert(st.avisos[0].texto.startsWith("⚠️ Reclamo"));
  const b = JSON.stringify(st.avisos[0].botones);
  assert(b.includes(`reponer:${ORDER}`) && b.includes(`escribo:${ORDER}`));
});

Deno.test("seg_bien sin consentimiento previo: pregunta con botones cons_si/cons_no; cons_si registra marketing por botón", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ estado_confirmacion: "confirmado" }));
  await correr(deps, payloadMensajes([botonInteractivo(`seg_bien:${ORDER}`)]));
  assertEquals(st.botones.length, 1);
  const cli = st.clientes[0].id;
  assertEquals(st.botones[0].botones.map((b) => b.id), [`cons_si:${cli}`, `cons_no:${cli}`]);
  assert(st.botones[0].botones.every((b) => b.titulo.length <= 20));
  assertEquals(st.avisos.length, 0);

  await correr(deps, payloadMensajes([botonInteractivo(`cons_si:${cli}`, "wamid.IN2")]));
  assertEquals(st.consentimientos, [{ cliente_id: cli, estado: "si", origen: "boton" }]);
  assertEquals(st.enviados.length, 1);

  // Otro "Todo bien" más adelante ya no vuelve a preguntar.
  await correr(deps, payloadMensajes([botonInteractivo(`seg_bien:${ORDER}`, "wamid.IN3")]));
  assertEquals(st.botones.length, 1);
  assertEquals(st.enviados.length, 2);
});

Deno.test("cons_no con cliente_id ajeno no registra nada y avisa", async () => {
  const { deps, st } = crearMock();
  await correr(deps, payloadMensajes([botonInteractivo("cons_no:0f8b6a1e-1111-4222-8333-444455556666")]));
  assertEquals(st.consentimientos.length, 0);
  assertEquals(st.avisos.length, 1);
});

Deno.test("botón post-venta de un pedido de otro cliente: no responde", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoPendiente({ telefono: "+595981000009", cliente_id: "otro" }));
  await correr(deps, payloadMensajes([botonInteractivo(`ayuda:${ORDER}`)]));
  assertEquals(st.enviados.length, 0);
  assert(st.avisos[0].texto.includes("otro cliente"));
});

Deno.test("textos por defecto de botones sin palabras prohibidas", async () => {
  const { TEXTOS_BOTONES_DEFAULT, RESPUESTAS_DEFAULT } = await import("./procesar.ts");
  const { contienePalabraProhibida } = await import("../_shared/filtro.ts");
  for (const t of [...Object.values(TEXTOS_BOTONES_DEFAULT), ...Object.values(RESPUESTAS_DEFAULT)]) {
    assertEquals(contienePalabraProhibida(t, PROHIBIDAS), null, t);
  }
});

Deno.test("respuestas_confirmacion con claves confirmado/a_corregir/cancelado y {plazo}", async () => {
  const { deps, st } = crearMock();
  st.config.respuestas_confirmacion = { confirmado: "OK {nombre}, llega en {plazo}.", a_corregir: "x", cancelado: "y" };
  st.pedidos.set(ORDER, pedidoPendiente());
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]));
  assertEquals(st.enviados[0].texto, "OK Ana, llega en 1 a 3 días hábiles.");
});

Deno.test("cambios que no son messages se guardan en eventos_crudos con id chg:<field>:<sha256>", async () => {
  const { deps, st } = crearMock();
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      time: 1791300000,
      changes: [
        { field: "phone_number_quality_update", value: { display_phone_number: "15550000000", event: "FLAGGED", current_limit: "TIER_1K" } },
        { field: "account_update", value: { event: "ACCOUNT_RESTRICTION" } },
        { field: "message_template_status_update", value: { event: "APPROVED", message_template_name: "voltra_entrega_hoy" } },
      ],
    }],
  };
  const r = await correr(deps, payload);
  const ids = [...st.crudos];
  assertEquals(ids.length, 3);
  for (const id of ids) {
    assert(/^chg:[a-z_]+:[0-9a-f]{64}$/.test(id), id);
    assertFalse(id.startsWith("msg:") || id.startsWith("st:"));
  }
  const q = ids.find((i) => i.startsWith("chg:phone_number_quality_update:"))!;
  assertEquals((st.crudosPayload.get(q) as { field: string }).field, "phone_number_quality_update");
  assertEquals((st.crudosPayload.get(q) as { value: { event: string } }).value.event, "FLAGGED");
  assertEquals(r.nuevos.length, 3);
  // Reintento de Meta con el mismo cuerpo: no se duplica.
  const r2 = await recibirPayload(payload, deps);
  assertEquals(r2.nuevos.length, 0);
});

// ---------- pago anticipado por transferencia (07-10) ----------

const PA = { activo: true }; // sin textos: usa PAGO_ANTICIPADO_DEFAULT

const imagen = (wamid = "wamid.IMG1", extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  from: TEL,
  from_user_id: BSUID,
  id: wamid,
  timestamp: "1791300200",
  type: "image",
  image: { id: "MEDIA_IMG", mime_type: "image/jpeg" },
  ...extra,
});

function pedidoConOferta(extra: Partial<Pedido> = {}): Pedido {
  return pedidoPendiente({ estado_confirmacion: "confirmado", tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"], total: 112000, ...extra });
}

Deno.test("pago anticipado: tras conf_si con activo true manda la oferta con el total formateado y deja el tag", async () => {
  const { deps, st } = crearMock();
  st.config.pago_anticipado = PA;
  st.pedidos.set(ORDER, pedidoPendiente({ total: "112000" }));
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]));
  assertEquals(st.enviados.length, 2);
  assertEquals(st.enviados[1].texto, PAGO_ANTICIPADO_DEFAULT.texto.replace("{total}", "112.000").replace("{pedido}", "#1001"));
  assert(st.enviados[1].texto.includes("Total: Gs 112.000"));
  assert(st.enviados[1].texto.includes("6193162880"));
  assertEquals(st.pedidos.get(ORDER)!.tags, ["CONFIRMADO", TAG_OFERTA_PAGO]);
  assertEquals(st.pedidos.get(ORDER)!.estado_confirmacion, "confirmado");
  assertEquals(st.tagsAgregados, [[`gid://shopify/Order/${ORDER}`, ["CONFIRMADO"]], [`gid://shopify/Order/${ORDER}`, [TAG_OFERTA_PAGO]]]);
  assertEquals(st.avisos.length, 1);
  assert(st.avisos[0].texto.includes("transferencia (Gs 112.000)"));
});

Deno.test("pago anticipado: texto de config con {nombre} y {pedido}", async () => {
  const { deps, st } = crearMock();
  st.config.pago_anticipado = { activo: true, texto: "Hola {nombre}, tu pedido {pedido} sale Gs {total}." };
  st.pedidos.set(ORDER, pedidoPendiente({ total: 249000 }));
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]));
  assertEquals(st.enviados[1].texto, "Hola Ana, tu pedido #1001 sale Gs 249.000.");
});

Deno.test("pago anticipado: no se manda con activo false, sin config, ya pagado o sin total", async () => {
  for (const caso of [
    { cfg: { activo: false }, extra: {} },
    { cfg: null, extra: {} },
    { cfg: PA, extra: { tags: ["PAGO_ANTICIPADO_COMPROBANTE"] } },
    { cfg: PA, extra: { tags: ["PAGADO_QR"] } },
  ]) {
    const { deps, st } = crearMock();
    if (caso.cfg) st.config.pago_anticipado = caso.cfg;
    st.pedidos.set(ORDER, pedidoPendiente({ total: 112000, ...caso.extra }));
    await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]));
    assertEquals(st.enviados.length, 1, JSON.stringify(caso));
    assertFalse(st.pedidos.get(ORDER)!.tags!.includes(TAG_OFERTA_PAGO));
    assertEquals(st.tagsAgregados.length, 1);
  }
  // Sin total: no se manda y Enrique se entera.
  const { deps, st } = crearMock();
  st.config.pago_anticipado = PA;
  st.pedidos.set(ORDER, pedidoPendiente());
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]));
  assertEquals(st.enviados.length, 1);
  assert(st.avisos[0].texto.includes("no tiene total"));
});

Deno.test("pago anticipado: conf_corregir y conf_cancelar no ofrecen pago", async () => {
  for (const accion of ["conf_corregir", "conf_cancelar"]) {
    const { deps, st } = crearMock();
    st.config.pago_anticipado = PA;
    st.pedidos.set(ORDER, pedidoPendiente({ total: 112000 }));
    await correr(deps, payloadMensajes([botonInteractivo(`${accion}:${ORDER}`)]));
    assertEquals(st.enviados.length, 1, accion);
  }
});

Deno.test("pago anticipado activo: la oferta QR no se manda (un solo ofrecimiento); apagado, vuelve el QR", async () => {
  const qr: number[] = [];
  let { deps, st } = crearMock();
  deps.ofrecerCobroQR = (id) => (qr.push(id), Promise.resolve({ ok: true, texto: "Pagá con QR: https://ejemplo.test/qr" }));
  st.config.pago_anticipado = PA;
  st.config["ola4.qr"] = { activo: true };
  st.pedidos.set(ORDER, pedidoPendiente({ total: 112000 }));
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]));
  assertEquals(qr, []);
  assertEquals(st.enviados.length, 2);
  assertFalse(st.enviados.some((e) => e.texto.includes("QR")));

  ({ deps, st } = crearMock());
  deps.ofrecerCobroQR = (id) => (qr.push(id), Promise.resolve({ ok: true, texto: "Pagá con QR: https://ejemplo.test/qr" }));
  st.config.pago_anticipado = { activo: false };
  st.config["ola4.qr"] = { activo: true };
  st.pedidos.set(ORDER, pedidoPendiente({ total: 112000 }));
  await correr(deps, payloadMensajes([botonInteractivo(`conf_si:${ORDER}`)]));
  assertEquals(qr, [Number(ORDER)]);
  assertEquals(st.enviados[1].texto, "Pagá con QR: https://ejemplo.test/qr");
});

Deno.test("comprobante: imagen tras la oferta → tags DB + Shopify, copia a Storage, respuesta y aviso; no va al vendedor", async () => {
  const { deps, st } = crearMock();
  const vendedor: string[] = [];
  const copias: string[] = [];
  deps.pasarAlVendedor = (d) => (vendedor.push(d.texto), Promise.resolve());
  deps.copiarMedia = (id, ruta) => (copias.push(`${id}->${ruta}`), Promise.resolve({ ok: true, ruta, mime: "image/jpeg" }));
  st.pedidos.set(ORDER, pedidoConOferta());
  await correr(deps, payloadMensajes([imagen()]));
  const p = st.pedidos.get(ORDER)!;
  assertEquals(p.tags, ["CONFIRMADO", TAG_OFERTA_PAGO, TAG_COMPROBANTE_PAGO, TAG_PRIORIDAD]);
  assertEquals(p.estado_confirmacion, "confirmado");
  assertEquals(st.tagsAgregados, [[`gid://shopify/Order/${ORDER}`, [TAG_COMPROBANTE_PAGO, TAG_PRIORIDAD]]]);
  const ruta = `comprobantes/${st.clientes[0].id}/wamid.IMG1.jpg`;
  assertEquals(copias, [`MEDIA_IMG->${ruta}`]);
  const contenido = st.mensajes.get("wamid.IMG1")!.contenido as Record<string, unknown>;
  assertEquals(contenido.storage_path, ruta);
  assertEquals(contenido.comprobante_pago_anticipado, ORDER);
  assertEquals(st.enviados.map((e) => e.texto), [PAGO_ANTICIPADO_DEFAULT.texto_recibido]);
  assertEquals(st.leidos, ["wamid.IMG1"]);
  assertEquals(st.avisos.length, 1);
  assert(st.avisos[0].texto.startsWith("💸 #1001: el cliente mandó comprobante de pago anticipado (Gs 112.000). Verificalo en ueno y despachalo primero."));
  assert(st.avisos[0].texto.includes(`wa-media/${ruta}`));
  assertEquals(vendedor, []);

  // Una segunda imagen ya no es comprobante (ya tiene PAGO_ANTICIPADO_COMPROBANTE): va al vendedor.
  await correr(deps, payloadMensajes([imagen("wamid.IMG2")]));
  assertEquals(st.avisos.length, 1);
  assertEquals(vendedor.length, 1);
});

Deno.test("comprobante: PDF sin copiarMedia → aviso con el media id; texto_recibido de config", async () => {
  const { deps, st } = crearMock();
  st.config.pago_anticipado = { activo: true, texto_recibido: "Gracias {nombre}, recibimos el de {pedido}." };
  st.pedidos.set(ORDER, pedidoConOferta());
  await correr(deps, payloadMensajes([imagen("wamid.PDF1", { type: "document", image: undefined, document: { id: "MEDIA_PDF", mime_type: "application/pdf", filename: "comprobante.pdf" } })]));
  assert(st.pedidos.get(ORDER)!.tags!.includes(TAG_COMPROBANTE_PAGO));
  assertEquals(st.enviados[0].texto, "Gracias Ana, recibimos el de #1001.");
  assert(st.avisos[0].texto.includes("MEDIA_PDF"));
});

Deno.test("comprobante con el chat en 'humano' que Enrique atiende: registra y avisa, sin responder al cliente", async () => {
  const { deps, st } = crearMock();
  st.pedidos.set(ORDER, pedidoConOferta());
  deps.actividadHumana = () => Promise.resolve({ salidasManuales: 1, escribo: false, derivaciones: [], entrantes: [] });
  await correr(deps, payloadMensajes([{ from: TEL, id: "wamid.T0", timestamp: "1791300100", type: "text", text: { body: "hola" } }]));
  st.conversaciones[0].estado = "humano";
  await correr(deps, payloadMensajes([imagen()]));
  assert(st.pedidos.get(ORDER)!.tags!.includes(TAG_PRIORIDAD));
  assertEquals(st.enviados.length, 0);
  assert(st.avisos.at(-1)!.texto.includes("no le respondí"));
});

Deno.test("imagen sin oferta previa, vieja o de pedido no confirmado: pasa al flujo normal", async () => {
  for (const ped of [
    pedidoPendiente({ estado_confirmacion: "confirmado", tags: ["CONFIRMADO"], total: 112000 }), // sin oferta
    pedidoConOferta({ creado_en: "2026-09-20T00:00:00.000Z" }), // más de 7 días
    pedidoConOferta({ estado_confirmacion: "cancelado_cliente" }),
    null, // sin pedidos
  ]) {
    const { deps, st } = crearMock();
    const vendedor: string[] = [];
    deps.pasarAlVendedor = (d) => (vendedor.push(d.texto), Promise.resolve());
    if (ped) st.pedidos.set(ORDER, ped);
    await correr(deps, payloadMensajes([imagen()]));
    assertEquals(vendedor.length, 1, JSON.stringify(ped?.tags));
    assertEquals(st.avisos.length, 0);
    assertEquals(st.enviados.length, 0);
    assertEquals(st.tagsAgregados.length, 0);
  }
});

Deno.test("mediaDeComprobante: imagen y PDF sí; audio y documento de otro tipo no", () => {
  assertEquals(mediaDeComprobante(imagen() as MensajeMeta), { id: "MEDIA_IMG", mime: "image/jpeg" });
  assertEquals(mediaDeComprobante({ id: "x", type: "document", document: { id: "D", mime_type: "application/pdf" } }), { id: "D", mime: "application/pdf" });
  assertEquals(mediaDeComprobante({ id: "x", type: "document", document: { id: "D", mime_type: "application/zip" } }), null);
  assertEquals(mediaDeComprobante({ id: "x", type: "audio", audio: { id: "A" } }), null);
  assert(pedidoYaPagado(["PAGO_ANTICIPADO_CONFIRMADO"]));
  assertFalse(pedidoYaPagado(["OFERTA_PAGO_ANTICIPADO", "CONFIRMADO"]));
});

Deno.test("seed_pago_anticipado.sql: JSON válido, activo, textos = defaults del código, banco y on conflict seguro", async () => {
  const sql = await Deno.readTextFile(new URL("../../seed_pago_anticipado.sql", import.meta.url));
  const json = /\('pago_anticipado',\s*'([\s\S]*?)'::jsonb\)/.exec(sql);
  assert(json);
  const v = JSON.parse(json[1]);
  assertEquals(v.activo, true);
  assertEquals(v.texto, PAGO_ANTICIPADO_DEFAULT.texto);
  assertEquals(v.texto_recibido, PAGO_ANTICIPADO_DEFAULT.texto_recibido);
  assertEquals(v.banco, { entidad: "ueno bank", tipo: "caja de ahorro", cuenta: "6193162880", titular: "VOLTRA E.A.S. UNIPERSONAL", ruc: "80177762-3" });
  assert(sql.includes("on conflict (clave) do nothing"));
  const { contienePalabraProhibida } = await import("../_shared/filtro.ts");
  for (const t of [v.texto, v.texto_recibido]) assertEquals(contienePalabraProhibida(t, PROHIBIDAS), null, t);
  assertFalse(/alta demanda|[uú]ltimas unidades|urgente/i.test(v.texto));
});

Deno.test("respuestas automáticas del WhatsApp Business del cliente: se detectan sin confundir mensajes reales", () => {
  for (const x of [
    "Que este sea un día lleno de bendiciones para ti y tu Familia. Si es algo urgente, por favor llámame. Me comunico a la brevedad posible.",
    "Gracias por comunicarte con nosotros!! Le Saluda Marcelo Asesor Inmobiliario, contamos con lotes en todo Encarnación",
    "Hola! En este momento no podemos atenderte, te responderemos apenas podamos.",
  ]) assert(esRespuestaAutomatica(x), x);
  for (const x of ["Gracias", "sí, mandame dos bolsas de tiras por favor", "cuánto sale el envío a Luque? gracias por responder rápido"]) {
    assertFalse(esRespuestaAutomatica(x), x);
  }
});

Deno.test("botón de recompra con el producto adentro (mk_si:p-<handle>): el vendedor sabe qué ofrecer", () => {
  const m = { id: "w", from: "595981000000", timestamp: "1", type: "button", button: { payload: "mk_si:p-tiras-nasales-gudair-30-unidades", text: "Sí, mandame" } };
  const b = leerBotonMarketing(m as never);
  assertEquals(b, { accion: "mk_si", orderId: null, producto: "tiras-nasales-gudair-30-unidades" });
  const t = contextoOfertaAceptada("mk_si", null, b!.producto);
  assert(t.includes("quiere otra bolsa de tiras nasales"), t);
  assertFalse(t.includes("no encontré cuál"));
});

Deno.test("bandeja: la imagen del cliente se copia a Storage y queda el storage_path; si falla, el chat sigue", async () => {
  const { deps, st } = crearMock();
  const copias: string[] = [];
  deps.copiarMediaChat = (id, ruta) => (copias.push(`${id}->${ruta}`), Promise.resolve({ ok: true, ruta, mime: "image/jpeg" }));
  await correr(deps, payloadMensajes([imagen("wamid.FOTO1")]));
  const ruta = `media/${st.clientes[0].id}/wamid.FOTO1.jpg`;
  assertEquals(copias, [`MEDIA_IMG->${ruta}`]);
  const c = st.mensajes.get("wamid.FOTO1")!.contenido as Record<string, unknown>;
  assertEquals(c.storage_path, ruta);

  const m2 = crearMock();
  m2.deps.copiarMediaChat = () => Promise.reject(new Error("Meta no responde"));
  await correr(m2.deps, payloadMensajes([imagen("wamid.FOTO2")]));
  const c2 = m2.st.mensajes.get("wamid.FOTO2")!.contenido as Record<string, unknown>;
  assertEquals(c2.storage_error, "Meta no responde");
  assertEquals(c2.storage_path, undefined);
});

Deno.test("bandeja: mediaDeChat reconoce imagen, sticker, video y documento (no texto ni audio)", async () => {
  const { mediaDeChat } = await import("./procesar.ts");
  assertEquals(mediaDeChat({ id: "a", type: "sticker", sticker: { id: "S1" } }), { id: "S1", mime: "image/webp" });
  assertEquals(mediaDeChat({ id: "a", type: "video", video: { id: "V1", mime_type: "video/mp4" } }), { id: "V1", mime: "video/mp4" });
  assertEquals(mediaDeChat({ id: "a", type: "document", document: { id: "D1", mime_type: "application/pdf" } }), { id: "D1", mime: "application/pdf" });
  assertEquals(mediaDeChat({ id: "a", type: "text", text: { body: "hola" } }), null);
  assertEquals(mediaDeChat({ id: "a", type: "audio", audio: { id: "A1" } }), null);
});
