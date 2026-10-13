// 12-10: botones de entrega (ent_ok / reprogramar), Corregir de la confirmación v4 y el descuento retirado
// (ningún camino ofrece pagar con descuento). Datos inventados (repo público).
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { type Deps, type EntradaVendedor, leerBotonConfirmacion, leerBotonEntrega, type MensajeMeta, type Pedido, procesarMensaje } from "./procesar.ts";

const TEL = "595981000000";
const ID = "5550001";
const contacto = { profile: { name: "Ana Prueba" }, wa_id: TEL, user_id: "PY.1234567890123" };
const BANCO = { activo: true, banco: { entidad: "Banco Prueba", tipo: "caja de ahorro", cuenta: "0000000000", titular: "EMPRESA DE PRUEBA", ruc: "80000000-0" } };
const DESCUENTO_ON = { activo: true, descuento_pct: 5, metodos: ["alias", "qr"] };

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
  raw: { shipping_address: { first_name: "Ana", city: "Asunción", address1: "Calle Falsa 123" }, line_items: [{ quantity: 1, title: "Tiras nasales" }] },
  ...x,
});

function mock(op: { estado?: string; pedidos?: Pedido[]; config?: Record<string, unknown>; conVendedor?: boolean } = {}) {
  const st = {
    pedidos: new Map((op.pedidos ?? [pedido()]).map((p) => [String(p.shopify_order_id), { ...p }])),
    enviados: [] as string[],
    botones: [] as { texto: string; botones: { id: string; titulo: string }[] }[],
    avisos: [] as string[],
    pasados: [] as EntradaVendedor[],
    estados: [] as string[],
    tags: [] as [string, string[]][],
    cancelados: [] as [string, string[]][],
    contenidos: new Map<string, Record<string, unknown>>(),
  };
  const config: Record<string, unknown> = op.config ?? {};
  const deps: Deps = {
    ahora: () => new Date("2026-10-12T15:00:00Z"),
    config: (k) => Promise.resolve(config[k] ?? null),
    guardarEventoCrudo: () => Promise.resolve(true),
    marcarEventoProcesado: () => Promise.resolve(),
    upsertCliente: () => Promise.resolve({ id: "cli-1", nombre: "Ana Prueba" }),
    conversacionActiva: () => Promise.resolve({ id: "conv-1", estado: op.estado ?? "ia" }),
    actualizarConversacion: (_id, c) => (c.estado && st.estados.push(c.estado), Promise.resolve()),
    insertarMensajeEntrante: () => Promise.resolve(true),
    completarContenidoMensaje: (id, extra) => (st.contenidos.set(id, { ...(st.contenidos.get(id) ?? {}), ...extra }), Promise.resolve()),
    estadoMensaje: () => Promise.resolve(undefined),
    actualizarMensaje: () => Promise.resolve(),
    copiarAudio: (_m, ruta) => Promise.resolve({ ok: true, ruta }),
    buscarPedido: (id) => Promise.resolve(st.pedidos.get(id) ?? null),
    pedidosPorEstado: (_c, _t, estado) => Promise.resolve([...st.pedidos.values()].filter((p) => p.estado_confirmacion === estado)),
    actualizarPedido: (id, c) => (Object.assign(st.pedidos.get(id)!, c), Promise.resolve()),
    cancelarEnviosPendientes: (id, patrones) => (st.cancelados.push([id, patrones]), Promise.resolve(1)),
    agregarTags: (gid, tags) => (st.tags.push([gid, tags]), Promise.resolve({ ok: true })),
    quitarTags: () => Promise.resolve({ ok: true }),
    avisar: (t) => (st.avisos.push(t), Promise.resolve({ ok: true })),
    enviarTexto: (_to, t) => (st.enviados.push(t), Promise.resolve({ ok: true })),
    enviarBotones: (_to, texto, botones) => (st.botones.push({ texto, botones }), Promise.resolve({ ok: true })),
    consentimientoMarketing: () => Promise.resolve(null),
    registrarConsentimiento: () => Promise.resolve(),
    marcarLeidoYEscribiendo: () => Promise.resolve(),
    normalizarTelefono: (x) => (/^5959\d{8}$/.test(x) ? `+${x}` : null),
  };
  if (op.conVendedor !== false) deps.pasarAlVendedor = (d) => (st.pasados.push(d), Promise.resolve());
  return { deps, st };
}

const boton = (payload: string, wamid = "wamid.IN1"): MensajeMeta => ({ from: TEL, id: wamid, timestamp: "1791800000", type: "button", button: { payload, text: "x" } });
const interactivo = (id: string, wamid = "wamid.IN1"): MensajeMeta => ({ from: TEL, id: wamid, timestamp: "1791800000", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } });

Deno.test("leerBotonEntrega: ent_ok / reprogramar / corregir / pago_ant con el id del pedido; la confirmación no se confunde", () => {
  assertEquals(leerBotonEntrega(boton(`ent_ok:${ID}`)), { accion: "ent_ok", id: ID });
  assertEquals(leerBotonEntrega(boton(`reprogramar:${ID}`)), { accion: "reprogramar", id: ID });
  assertEquals(leerBotonEntrega(boton(`corregir:${ID}`)), { accion: "corregir", id: ID });
  assertEquals(leerBotonEntrega(interactivo(`pago_ant:${ID}`)), { accion: "pago_ant", id: ID });
  assertEquals(leerBotonEntrega(boton(`conf_corregir:${ID}`)), null);
  assertEquals(leerBotonEntrega(boton("reprogramar")), null);
  assertEquals(leerBotonConfirmacion(boton(`corregir:${ID}`)), null);
});

Deno.test("Ok, lo espero: solo 'Genial, gracias Ana!'; sin Telegram, sin vendedor, sin tocar el chat", async () => {
  const { deps, st } = mock({ estado: "humano" });
  await procesarMensaje(boton(`ent_ok:${ID}`), contacto, deps);
  assertEquals(st.enviados, ["Genial, gracias Ana!"]);
  assertEquals([st.avisos, st.pasados, st.estados, st.tags], [[], [], [], []]);
});

Deno.test("Reprogramar: el chat vuelve/queda con el bot y el vendedor recibe el contexto para coordinar; sin Telegram", async () => {
  const { deps, st } = mock({ estado: "humano" });
  await procesarMensaje(boton(`reprogramar:${ID}`), contacto, deps);
  assertEquals(st.estados, ["ia"]);
  assertEquals(st.pasados.length, 1);
  const t = st.pasados[0].texto;
  assert(t.includes("[reprogramar entrega pedido #1001] El cliente tocó Reprogramar en el aviso de entrega."), t);
  assert(t.includes("COORDINAR UNA ENTREGA"), t);
  assertEquals(st.contenidos.get("wamid.IN1")?.texto_vendedor, t);
  assertEquals([st.avisos, st.enviados, st.tags], [[], [], []]); // contesta el vendedor
  // Sin vendedor: pregunta el día él mismo, igual sin Telegram.
  const sin = mock({ conVendedor: false });
  await procesarMensaje(boton(`reprogramar:${ID}`), contacto, sin.deps);
  assertEquals(sin.st.enviados, ["Dale Ana, ¿qué día te queda mejor para recibirlo? El repartidor te contacta antes de salir para coordinar."]);
  assertEquals(sin.st.avisos, []);
});

Deno.test("Corregir (confirmación v4): el vendedor pregunta qué cambia; sigue pendiente, sin humano ni Telegram; no más recordatorio", async () => {
  const { deps, st } = mock({ pedidos: [pedido({ estado_confirmacion: "pendiente", tags: [] })] });
  await procesarMensaje(boton(`corregir:${ID}`), contacto, deps);
  assertEquals(st.pasados.length, 1);
  assert(st.pasados[0].texto.includes("[corregir pedido #1001] El cliente tocó Corregir"), st.pasados[0].texto);
  assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "pendiente");
  assertEquals(st.cancelados, [[ID, ["recordatorio"]]]);
  assertEquals([st.avisos, st.tags, st.estados], [[], [], []]);
});

Deno.test("botones de entrega de un pedido de otro cliente: no hace nada (ni Telegram)", async () => {
  const { deps, st } = mock({ pedidos: [pedido({ cliente_id: "otro", telefono: "+595981999999" })] });
  for (const a of ["ent_ok", "reprogramar", "pago_ant"]) await procesarMensaje(boton(`${a}:${ID}`, `wamid.${a}`), contacto, deps);
  assertEquals([st.enviados, st.avisos, st.pasados, st.tags], [[], [], [], []]);
});

Deno.test("Pagar ahora (descuento retirado 12-10): aunque la config vieja esté prendida, solo 'pagás al recibir'; nunca datos ni montos", async () => {
  for (const config of [{}, { pago_anticipado_descuento: DESCUENTO_ON, pago_anticipado: BANCO }, { pago_anticipado_descuento: DESCUENTO_ON }]) {
    const { deps, st } = mock({ config });
    await procesarMensaje(interactivo(`pago_ant:${ID}`), contacto, deps);
    assertEquals(st.enviados, ["Por ahora el pago es al recibir: pagás en efectivo cuando te llega tu pedido #1001 🙌"], JSON.stringify(config));
    assertEquals([st.tags, st.avisos, st.botones], [[], [], []]);
    assertEquals(st.pedidos.get(ID)!.tags, ["CONFIRMADO"]);
  }
  // Ya pagado (PAGO_VERIFICADO o PAGADO): que no paga nada.
  for (const t of ["PAGO_VERIFICADO", "PAGADO"]) {
    const pag = mock({ config: { pago_anticipado_descuento: DESCUENTO_ON, pago_anticipado: BANCO }, pedidos: [pedido({ tags: ["CONFIRMADO", t] })] });
    await procesarMensaje(interactivo(`pago_ant:${ID}`), contacto, pag.deps);
    assertEquals(pag.st.enviados, ["Tu pedido #1001 ya figura pagado ✅ No pagás nada al recibir."], t);
  }
});

Deno.test("conf_si con el descuento y la oferta vieja prendidos en config: ni descuento ni transferencia vieja; con pago_prioridad, solo esa oferta y sin QR", async () => {
  const base = { pago_anticipado_descuento: DESCUENTO_ON, pago_anticipado: BANCO, "ola4.qr": { activo: true } };
  for (const conPrioridad of [false, true]) {
    const { deps, st } = mock({
      config: conPrioridad ? { ...base, pago_prioridad: { activo: true, alias: "alias@ejemplo.com", titular: "Voltra E.A.S." } } : base,
      pedidos: [pedido({ estado_confirmacion: "pendiente", tags: [] })],
    });
    let qr = 0;
    deps.ofrecerCobroQR = () => (qr++, Promise.resolve({ ok: true, texto: "QR" }));
    await procesarMensaje(boton(`conf_si:${ID}`), contacto, deps);
    assertFalse(st.botones.some((b) => b.botones.some((x) => x.id.startsWith("pago_ant:"))));
    for (const t of [...st.enviados, ...st.botones.map((b) => b.texto), ...st.avisos]) {
      assertFalse(/menos|descuento|0000000000|Banco Prueba/i.test(t), t);
    }
    assertEquals(st.pedidos.get(ID)!.estado_confirmacion, "confirmado");
    if (conPrioridad) {
      assertEquals(st.enviados.length, 2); // respuesta + oferta con prioridad
      assert(st.enviados[1].startsWith("📦 ¡Tu pedido quedó confirmado!"), st.enviados[1]);
      assertEquals(qr, 0);
      assert(st.pedidos.get(ID)!.tags!.includes("OFERTA_PAGO_ANTICIPADO"));
    } else {
      assertEquals(st.enviados.length, 2); // respuesta + QR (sin pago_prioridad vuelve el QR de la ola 4)
      assertEquals(st.enviados[1], "QR");
      assertFalse(st.pedidos.get(ID)!.tags!.includes("OFERTA_PAGO_ANTICIPADO"));
    }
  }
});

Deno.test("comprobante de un pedido con el tag viejo PAGO_ANTICIPADO_ELEGIDO: el monto a verificar es el total (sin descuento)", async () => {
  const { deps, st } = mock({
    config: { pago_anticipado_descuento: DESCUENTO_ON, pago_anticipado: BANCO },
    pedidos: [pedido({ tags: ["CONFIRMADO", "PAGO_ANTICIPADO_ELEGIDO", "OFERTA_PAGO_ANTICIPADO"] })],
  });
  await procesarMensaje({ from: TEL, id: "wamid.IMG", timestamp: "1791800000", type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg" } }, contacto, deps);
  assertEquals(st.avisos.length, 1);
  assert(st.avisos[0].includes("Monto a verificar: Gs 129.000 (total del pedido)."), st.avisos[0]);
  assertFalse(/descuento|122\.500/.test(st.avisos[0]), st.avisos[0]);
});

Deno.test("respuesta de confirmación: {dia} disponible con el día concreto", async () => {
  const { deps, st } = mock({
    config: { respuestas_confirmacion: { confirmado: "Listo {nombre}, te llega {dia}." } },
    pedidos: [pedido({ estado_confirmacion: "pendiente", tags: [] })],
  });
  await procesarMensaje(boton(`conf_si:${ID}`), contacto, deps); // lunes 12/10 12:00, Asunción
  assertEquals(st.enviados[0], "Listo Ana, te llega mañana martes 13/10 o el miércoles 14/10.");
});
