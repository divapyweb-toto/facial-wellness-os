// Ola 2 (G1): paso de mensajes de conversaciones en 'ia' al vendedor con IA. Datos inventados (repo público).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type ActividadHumana,
  type Deps,
  type EntradaVendedor,
  motivoParaNoRetomar,
  type Pedido,
  procesarMensaje,
  textoParaVendedor,
  type Transcripcion,
} from "./procesar.ts";

const TEL = "595981000000";
const contacto = { profile: { name: "Ana Prueba" }, wa_id: TEL, user_id: "PY.1234567890123" };

function mock(op: {
  estado?: string;
  pedidos?: Pedido[];
  transcripcion?: Transcripcion | Error;
  conVendedor?: boolean;
  actividad?: Partial<ActividadHumana> | Error;
  cfgVendedor?: Record<string, unknown>;
} = {}) {
  const st = {
    pasados: [] as EntradaVendedor[],
    contenidos: new Map<string, Record<string, unknown>>(),
    telefonos: [] as [string, string][],
    enviados: [] as string[],
    avisos: [] as string[],
    transcritos: [] as string[],
    cambiosConv: [] as Record<string, unknown>[],
    consultasActividad: [] as { conversacionId: string; clienteId: string; desdeISO: string }[],
  };
  const pedidos = op.pedidos ?? [];
  const deps: Deps = {
    ahora: () => new Date("2026-10-06T15:00:00Z"),
    config: (clave) => Promise.resolve(clave === "vendedor" ? op.cfgVendedor ?? null : null),
    guardarEventoCrudo: () => Promise.resolve(true),
    marcarEventoProcesado: () => Promise.resolve(),
    upsertCliente: () => Promise.resolve({ id: "cli-1", nombre: "Ana Prueba" }),
    conversacionActiva: () => Promise.resolve({ id: "conv-1", estado: op.estado ?? "ia" }),
    actualizarConversacion: (_id, c) => (c.estado && st.cambiosConv.push(c), Promise.resolve()),
    insertarMensajeEntrante: () => Promise.resolve(true),
    completarContenidoMensaje: (id, extra) => (st.contenidos.set(id, { ...(st.contenidos.get(id) ?? {}), ...extra }), Promise.resolve()),
    estadoMensaje: () => Promise.resolve(undefined),
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
    consentimientoMarketing: () => Promise.resolve(null),
    registrarConsentimiento: () => Promise.resolve(),
    marcarLeidoYEscribiendo: () => Promise.resolve(),
    normalizarTelefono: (x) => {
      const d = x.replace(/\D/g, "");
      return /^5959\d{8}$/.test(d) ? `+${d}` : null;
    },
  };
  if (op.conVendedor !== false) {
    deps.pasarAlVendedor = (d) => (st.pasados.push(d), Promise.resolve());
    deps.transcribirAudio = (ruta) => {
      st.transcritos.push(ruta);
      return op.transcripcion instanceof Error ? Promise.reject(op.transcripcion) : Promise.resolve(op.transcripcion ?? { ok: true, texto: "pasame na el precio", confianza: 0.9 });
    };
    deps.guardarTelefonoCliente = (c, t) => (st.telefonos.push([c, t]), Promise.resolve());
  }
  if (op.actividad !== undefined) {
    const a = op.actividad;
    deps.actividadHumana = (d) => {
      st.consultasActividad.push(d);
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve({ salidasManuales: 0, escribo: false, derivaciones: [], entrantes: [], ...a });
    };
  }
  return { deps, st };
}

const base = { from: TEL, id: "wamid.IN1", timestamp: "1791300000" };

Deno.test("vendedor: texto en conversación 'ia' pasa al vendedor; en 'humano' no", async () => {
  const a = mock();
  await procesarMensaje({ ...base, type: "text", text: { body: "cuánto sale?" } }, contacto, a.deps);
  assertEquals(a.st.pasados, [{ conversacion_id: "conv-1", cliente_id: "cli-1", wa_message_id: "wamid.IN1", texto: "cuánto sale?" }]);
  const h = mock({ estado: "humano" });
  await procesarMensaje({ ...base, type: "text", text: { body: "cuánto sale?" } }, contacto, h.deps);
  assertEquals(h.st.pasados.length, 0);
});

Deno.test("vendedor: sin las dependencias de la ola 2 el webhook se comporta como en la ola 1", async () => {
  const a = mock({ conVendedor: false });
  await procesarMensaje({ ...base, type: "text", text: { body: "hola" } }, contacto, a.deps);
  assertEquals(a.st.pasados.length, 0);
  assertEquals(a.st.enviados.length, 0);
});

Deno.test("vendedor: audio se transcribe y pasa con la marca [audio]; si falla, pide que lo escriba", async () => {
  const a = mock();
  await procesarMensaje({ ...base, type: "audio", audio: { id: "MEDIA1", mime_type: "audio/ogg" } }, contacto, a.deps);
  assertEquals(a.st.transcritos, ["audio/cli-1/wamid.IN1.ogg"]);
  assertEquals(a.st.pasados[0].texto, "[audio] pasame na el precio");
  assertEquals(a.st.contenidos.get("wamid.IN1")?.texto_vendedor, "[audio] pasame na el precio");
  const b = mock({ transcripcion: new Error("scribe caído") });
  await procesarMensaje({ ...base, type: "audio", audio: { id: "MEDIA1" } }, contacto, b.deps);
  assert(b.st.pasados[0].texto.includes("no se pudo transcribir"));
  const c = mock({ transcripcion: { ok: true, texto: "ehh mba'e", confianza: 0.3, confianzaBaja: true } });
  await procesarMensaje({ ...base, type: "audio", audio: { id: "MEDIA1" } }, contacto, c.deps);
  assert(c.st.pasados[0].texto.includes("transcripción dudosa"));
});

Deno.test("vendedor: ubicación, formulario (Flow) y contacto llegan como texto con marca", async () => {
  const a = mock();
  await procesarMensaje({ ...base, type: "location", location: { latitude: -25.51, longitude: -54.61, name: "Casa" } }, contacto, a.deps);
  assert(a.st.pasados[0].texto.startsWith("[ubicación] -25.51,-54.61 · Casa"));
  assertEquals(a.st.contenidos.get("wamid.IN1")?.texto_vendedor, a.st.pasados[0].texto);

  const flow = textoParaVendedor({
    ...base,
    type: "interactive",
    interactive: {
      type: "nfm_reply",
      nfm_reply: { response_json: JSON.stringify({ flow_token: "pedido:conv-1", nombre: "Ana Prueba", ciudad: "Encarnación", direccion: "Calle 1", cantidad: "2" }) },
    },
  });
  assertEquals(flow, "[formulario] nombre: Ana Prueba · ciudad: Encarnación · dirección: Calle 1 · cantidad: 2");
});

Deno.test("vendedor: el número compartido con REQUEST_CONTACT_INFO se guarda si el cliente no tenía teléfono", async () => {
  const a = mock();
  const sinTel = { user_id: "PY.1234567890123", profile: { name: "Ana Prueba" } };
  await procesarMensaje({
    id: "wamid.IN9",
    from_user_id: "PY.1234567890123",
    type: "contacts",
    contacts: [{ origin: "contact_request", name: { formatted_name: "Ana Prueba" }, phones: [{ phone: "+595 981 000000", wa_id: TEL }] }],
  }, sinTel, a.deps);
  assertEquals(a.st.telefonos, [["cli-1", "+595981000000"]]);
  assert(a.st.pasados[0].texto.startsWith("[contacto] compartió su número"));
});

Deno.test("vendedor: botones de la ola 1 (conf_*) y la aceptación con pedido pendiente NO pasan al vendedor", async () => {
  const pedido: Pedido = { shopify_order_id: "5550001", nombre: "#1050", cliente_id: "cli-1", telefono: `+${TEL}`, estado_confirmacion: "pendiente", tags: [], courier: "pap", creado_en: "2026-10-06T14:00:00Z" };
  const a = mock({ pedidos: [{ ...pedido }] });
  await procesarMensaje({ ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "conf_si:5550001", title: "Confirmar" } } }, contacto, a.deps);
  assertEquals(a.st.pasados.length, 0);
  const b = mock({ pedidos: [{ ...pedido }] });
  await procesarMensaje({ ...base, type: "text", text: { body: "si dale" } }, contacto, b.deps);
  assertEquals(b.st.pasados.length, 0);
  assert(b.st.enviados[0].includes("confirmado"));
});

Deno.test("vendedor: los botones propios del vendedor (vend_conf) pasan con id para validar el sí", async () => {
  const a = mock();
  await procesarMensaje({ ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "vend_conf:pc-1", title: "Confirmar" } } }, contacto, a.deps);
  assertEquals(a.st.pasados[0].texto, "[botón] Confirmar (vend_conf:pc-1)");
});

// ---------- chat en 'humano' que nadie atiende ----------

const texto = (body: string) => ({ ...base, type: "text", text: { body } });

Deno.test("retomar: chat en 'humano' sin señales de Enrique en 3 h → vuelve a 'ia' y el mensaje pasa al vendedor", async () => {
  const a = mock({ estado: "humano", actividad: {} });
  await procesarMensaje(texto("Quiero 1"), contacto, a.deps);
  assertEquals(a.st.cambiosConv, [{ estado: "ia" }]);
  assertEquals(a.st.pasados.map((p) => p.texto), ["Quiero 1"]);
  assertEquals(a.st.consultasActividad, [{ conversacionId: "conv-1", clienteId: "cli-1", desdeISO: "2026-10-06T12:00:00.000Z" }]);
});

Deno.test("retomar: la derivación de venta (mayorista) no frena; la dura (reclamo) sí", async () => {
  const venta = mock({ estado: "humano", actividad: { derivaciones: ["mayorista", "pide_persona"] } });
  await procesarMensaje(texto("Mejor"), contacto, venta.deps);
  assertEquals(venta.st.pasados.length, 1);
  const dura = mock({ estado: "humano", actividad: { derivaciones: ["mayorista", "reclamo"] } });
  await procesarMensaje(texto("hola?"), contacto, dura.deps);
  assertEquals(dura.st.pasados.length, 0);
  assertEquals(dura.st.cambiosConv, []);
});

Deno.test("retomar: NO si Enrique escribió desde la bandeja o tocó 'Le escribo yo' en las últimas N horas", async () => {
  const manual = mock({ estado: "humano", actividad: { salidasManuales: 1 } });
  await procesarMensaje(texto("dale"), contacto, manual.deps);
  assertEquals(manual.st.pasados.length, 0);
  assertEquals(manual.st.cambiosConv, []);
  const escribo = mock({ estado: "humano", actividad: { escribo: true } });
  await procesarMensaje(texto("dale"), contacto, escribo.deps);
  assertEquals(escribo.st.pasados.length, 0);
});

Deno.test("retomar: NO si el cliente tocó un botón que pasa a humano (ayuda, corregir) en el período", async () => {
  const ayuda = { ...base, id: "wamid.B1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "ayuda:5550001", title: "Necesito ayuda" } } };
  const a = mock({ estado: "humano", actividad: { entrantes: [ayuda] } });
  await procesarMensaje(texto("hola"), contacto, a.deps);
  assertEquals(a.st.pasados.length, 0);
  const corregir = { ...base, type: "button", button: { payload: "conf_corregir:5550001", text: "Corregir" } };
  assertEquals(motivoParaNoRetomar({ salidasManuales: 0, escribo: false, derivaciones: [], entrantes: [corregir] }), "boton_a_humano");
  const bien = { ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "seg_bien:5550001", title: "Todo bien" } } };
  assertEquals(motivoParaNoRetomar({ salidasManuales: 0, escribo: false, derivaciones: [], entrantes: [bien] }), null);
});

Deno.test("retomar: horas desde config_wa.vendedor.retomar_humano_h; 0 = nunca; sin la dependencia o si falla, no retoma", async () => {
  const cinco = mock({ estado: "humano", actividad: {}, cfgVendedor: { retomar_humano_h: 5 } });
  await procesarMensaje(texto("hola"), contacto, cinco.deps);
  assertEquals(cinco.st.consultasActividad[0].desdeISO, "2026-10-06T10:00:00.000Z");
  const nunca = mock({ estado: "humano", actividad: {}, cfgVendedor: { retomar_humano_h: 0 } });
  await procesarMensaje(texto("hola"), contacto, nunca.deps);
  assertEquals(nunca.st.pasados.length, 0);
  assertEquals(nunca.st.consultasActividad.length, 0);
  const falla = mock({ estado: "humano", actividad: new Error("db caída") });
  await procesarMensaje(texto("hola"), contacto, falla.deps);
  assertEquals(falla.st.pasados.length, 0);
  assertEquals(falla.st.cambiosConv, []);
});

Deno.test("retomar: solo mensajes de texto; un audio en 'humano' sigue sin pasar", async () => {
  const a = mock({ estado: "humano", actividad: {} });
  await procesarMensaje({ ...base, type: "audio", audio: { id: "MEDIA1" } }, contacto, a.deps);
  assertEquals(a.st.pasados.length, 0);
  assertEquals(a.st.consultasActividad.length, 0);
});
