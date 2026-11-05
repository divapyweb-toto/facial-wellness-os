// 05-11: pago anticipado OBLIGATORIO al confirmar un pedido web (conf_si) si el cliente tiene devoluciones previas.
// Datos inventados (repo público).
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { type Deps, type MensajeMeta, type Pedido, procesarMensaje } from "./procesar.ts";

const TEL = "595981000111";
const ID = "5550009";
const contacto = { profile: { name: "Ana Prueba" }, wa_id: TEL, user_id: "PY.1234567890123" };
const PRIORIDAD_ON = { activo: true, alias: "alias@ejemplo.com", titular: "Voltra E.A.S." };
const TEXTO_OFERTA = "📦 ¡Tu pedido quedó confirmado!\nSi querés recibirlo antes, podés pagarlo ahora por transferencia y sale con prioridad en el primer despacho.\n💳 Transferí a: alias@ejemplo.com — Voltra E.A.S.\nSi preferís, pagás al recibir como siempre 👍";
const TEXTO_REQ = "📦 ¡Tu pedido #9001 quedó confirmado! Esta vez te pedimos pagarlo por adelantado por transferencia (Gs 129.000) y sale en el primer despacho.\n💳 Transferí a: alias@ejemplo.com — Voltra E.A.S.\nMandanos la foto del comprobante por acá 🙌";

const pedido = (x: Partial<Pedido> = {}): Pedido => ({
  shopify_order_id: ID,
  nombre: "#9001",
  cliente_id: "cli-1",
  telefono: `+${TEL}`,
  estado_confirmacion: "pendiente",
  tags: [],
  courier: "lucero",
  creado_en: "2026-10-12T12:00:00.000Z",
  total: 129000,
  raw: { phone: "0981 000 111", shipping_address: { first_name: "Ana", city: "Ciudad Prueba", address1: "Calle Inventada 123" }, line_items: [{ quantity: 1, title: "Producto prueba" }] },
  ...x,
});

type Op = { config?: Record<string, unknown>; pedido?: Partial<Pedido>; devoluciones?: number | Error; falla?: (t: string) => boolean; ahora?: Date };
function mock(op: Op = {}) {
  const st = {
    pedidos: new Map([[ID, pedido(op.pedido)]]),
    enviados: [] as string[],
    avisos: [] as string[],
    tags: [] as [string, string[]][],
    candados: [] as [string, Record<string, unknown>][],
    consultas: [] as { clienteId: string; telefonos: string[]; pedidoActual: unknown }[],
    orden: [] as string[],
    cierres: [] as boolean[],
  };
  const config: Record<string, unknown> = {
    pago_prioridad: PRIORIDAD_ON,
    pago_anticipado: { requerido: { activo: true, min_devoluciones: 1 } },
    ...(op.config ?? {}),
  };
  const deps: Deps = {
    ahora: () => op.ahora ?? new Date("2026-10-12T15:00:00Z"),
    config: (k) => Promise.resolve(config[k] ?? null),
    guardarEventoCrudo: () => Promise.resolve(true),
    marcarEventoProcesado: () => Promise.resolve(),
    upsertCliente: () => Promise.resolve({ id: "cli-1", nombre: "Ana Prueba" }),
    conversacionActiva: () => Promise.resolve({ id: "conv-1", estado: "ia" }),
    actualizarConversacion: () => Promise.resolve(),
    insertarMensajeEntrante: () => Promise.resolve(true),
    completarContenidoMensaje: () => Promise.resolve(),
    estadoMensaje: () => Promise.resolve(undefined),
    actualizarMensaje: () => Promise.resolve(),
    copiarAudio: (_m, ruta) => Promise.resolve({ ok: true, ruta }),
    buscarPedido: (id) => Promise.resolve(st.pedidos.get(id) ?? null),
    pedidosPorEstado: (_c, _t, estado) => Promise.resolve([...st.pedidos.values()].filter((p) => p.estado_confirmacion === estado)),
    actualizarPedido: (id, c) => (Object.assign(st.pedidos.get(id)!, c), Promise.resolve()),
    cancelarEnviosPendientes: () => Promise.resolve(1),
    agregarTags: (gid, tags) => (st.tags.push([gid, tags]), Promise.resolve({ ok: true })),
    quitarTags: () => Promise.resolve({ ok: true }),
    avisar: (t) => (st.avisos.push(t), Promise.resolve({ ok: true })),
    enviarTexto: (_to, t) => {
      if (t.startsWith("📦")) st.orden.push(t.startsWith("📦 ¡Tu pedido #") ? "envio:requerido" : "envio:oferta");
      if (op.falla?.(t)) return Promise.resolve({ ok: false, error: "131026: undeliverable" });
      st.enviados.push(t);
      return Promise.resolve({ ok: true, wa_message_id: "wamid.OUT" });
    },
    enviarBotones: () => Promise.resolve({ ok: true }),
    consentimientoMarketing: () => Promise.resolve("si"),
    registrarConsentimiento: () => Promise.resolve(),
    marcarLeidoYEscribiendo: () => Promise.resolve(),
    normalizarTelefono: (x) => (/^5959\d{8}$/.test(x) ? `+${x}` : null),
    reservarOfertaPrioridad: () => Promise.resolve(true),
    cerrarOfertaPrioridad: (_id, r) => (st.cierres.push(r.ok), Promise.resolve()),
    devolucionesPrevias: (q) => {
      st.consultas.push(q);
      return op.devoluciones instanceof Error ? Promise.reject(op.devoluciones) : Promise.resolve(op.devoluciones ?? 0);
    },
    registrarCandadoPagoRequerido: (id, p) => (st.orden.push("candado"), st.candados.push([id, p]), Promise.resolve()),
  };
  return { deps, st };
}
const boton = (payload: string): MensajeMeta => ({ from: TEL, id: "wamid.IN1", timestamp: "1791800000", type: "button", button: { payload, text: "x" } });
const ofertas = (st: ReturnType<typeof mock>["st"]) => st.enviados.filter((t) => t.startsWith("📦"));

Deno.test("requerido apagado (sin la clave, o activo false) → la oferta de siempre, sin contar devoluciones", async () => {
  for (const pa of [null, { texto_recibido: "x" }, { requerido: { activo: false, min_devoluciones: 1 } }]) {
    const { deps, st } = mock({ config: { pago_anticipado: pa }, devoluciones: 5 });
    await procesarMensaje(boton(`conf_si:${ID}`), contacto, deps);
    assertEquals(ofertas(st), [TEXTO_OFERTA], JSON.stringify(pa));
    assertEquals(st.consultas, []);
    assertEquals(st.candados, []);
    assertEquals(st.pedidos.get(ID)!.tags, ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"]);
  }
});

Deno.test("requerido: >= 1 devolución → texto obligatorio en lugar de la oferta; tags REQUERIDO + OFERTA (DB y Shopify); candado tras el envío", async () => {
  const { deps, st } = mock({ devoluciones: 2 });
  await procesarMensaje(boton(`conf_si:${ID}`), contacto, deps);
  assertEquals(ofertas(st), [TEXTO_REQ]);
  assertEquals(st.orden, ["envio:requerido", "candado"]);
  assertEquals(st.candados.length, 1);
  assertEquals(st.candados[0][0], ID);
  assertEquals(st.candados[0][1].devoluciones, 2);
  assertEquals(st.cierres, [true]);
  assertEquals(st.pedidos.get(ID)!.tags, ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO", "PAGO_ANTICIPADO_REQUERIDO"]);
  assertEquals(st.tags.at(-1), [`gid://shopify/Order/${ID}`, ["OFERTA_PAGO_ANTICIPADO", "PAGO_ANTICIPADO_REQUERIDO"]]);
  // Teléfonos del cliente y del pedido, sin el pedido actual.
  assertEquals(st.consultas[0].pedidoActual, { nombre: "#9001", shopifyOrderId: ID });
  const tels = st.consultas[0].telefonos;
  assert(tels.includes("0981 000 111") && tels.filter((t) => t.replace(/\D/g, "").endsWith("981000111")).length >= 2, JSON.stringify(tels));
  assert(st.avisos[0].includes("🔒") && st.avisos[0].includes("2 pedidos anteriores"), st.avisos[0]);
  assertFalse(/devol|no entreg/i.test(ofertas(st)[0]));
});

Deno.test("requerido: 0 devoluciones o no se pudo contar → oferta normal, sin candado ni tag REQUERIDO", async () => {
  for (const devoluciones of [0, new Error("db caída")]) {
    const { deps, st } = mock({ devoluciones });
    await procesarMensaje(boton(`conf_si:${ID}`), contacto, deps);
    assertEquals(ofertas(st), [TEXTO_OFERTA]);
    assertEquals(st.candados, []);
    assertFalse(st.pedidos.get(ID)!.tags!.includes("PAGO_ANTICIPADO_REQUERIDO"));
  }
});

Deno.test("requerido: ventana cerrada → no sale nada (como hoy) y no se etiqueta", async () => {
  const { deps, st } = mock({ devoluciones: 3, ahora: new Date("2026-10-14T15:00:00Z") });
  await procesarMensaje(boton(`conf_si:${ID}`), contacto, deps);
  assertEquals(ofertas(st), []);
  assertEquals(st.candados, []);
  assertFalse(st.pedidos.get(ID)!.tags!.includes("PAGO_ANTICIPADO_REQUERIDO"));
});

Deno.test("requerido: ya pagado o retiro → nada; SIN_COBERTURA → oferta de siempre, nada nuevo", async () => {
  for (const tags of [["PAGADO"], ["RETIRO_EN_CASA"]]) {
    const { deps, st } = mock({ devoluciones: 3, pedido: { tags } });
    await procesarMensaje(boton(`conf_si:${ID}`), contacto, deps);
    assertEquals(ofertas(st), [], tags[0]);
    assertEquals(st.candados, [], tags[0]);
  }
  const { deps, st } = mock({ devoluciones: 3, pedido: { tags: ["SIN_COBERTURA"] } });
  await procesarMensaje(boton(`conf_si:${ID}`), contacto, deps);
  assertEquals(ofertas(st), [TEXTO_OFERTA]);
  assertEquals(st.candados, []);
  assertFalse(st.pedidos.get(ID)!.tags!.includes("PAGO_ANTICIPADO_REQUERIDO"));
});

Deno.test("requerido: si el envío del obligatorio falla → ni tag REQUERIDO ni candado; sale la oferta normal y Enrique se entera", async () => {
  const { deps, st } = mock({ devoluciones: 2, falla: (t) => t.startsWith("📦 ¡Tu pedido #") });
  await procesarMensaje(boton(`conf_si:${ID}`), contacto, deps);
  assertEquals(st.orden, ["envio:requerido", "envio:oferta"]);
  assertEquals(ofertas(st), [TEXTO_OFERTA]);
  assertEquals(st.candados, []);
  assertEquals(st.pedidos.get(ID)!.tags, ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"]);
  assert(st.avisos[0].includes("Falla: pago anticipado obligatorio: 131026"), st.avisos[0]);
  assert(st.avisos[0].includes("💸 Se le ofreció pagar antes"), st.avisos[0]);
  // Fallan los dos: nada etiquetado, sin candado, cierre 'fallido'.
  const dos = mock({ devoluciones: 2, falla: (t) => t.startsWith("📦") });
  await procesarMensaje(boton(`conf_si:${ID}`), contacto, dos.deps);
  assertEquals(dos.st.candados, []);
  assertEquals(dos.st.pedidos.get(ID)!.tags, ["CONFIRMADO"]);
  assertEquals(dos.st.cierres, [false]);
});
