// 12-10: oferta de pago con prioridad (prio:<id>) y avisos de entrega de pedidos ya pagados. Datos inventados.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  type Config,
  CONFIG_DEFECTO,
  configDesdeFilas,
  type Contexto,
  decidir,
  type Deps,
  type Envio,
  type Horario,
  procesarLote,
} from "./procesar.ts";

const AHORA = new Date("2026-10-12T15:00:00Z"); // lunes 12:00 en Asunción
const horario: Horario = {
  dentro: (d, c) => {
    const h = (d.getUTCHours() + 21) % 24;
    return h >= c.desde && h < c.hasta;
  },
  proxima: () => new Date("2026-10-13T11:00:00Z"),
};
const PP_ON = { activo: true, alias: "alias@ejemplo.com", titular: "Voltra E.A.S." };
const cfg = (x: Partial<Config> = {}): Config => ({ ...CONFIG_DEFECTO, pagoPrioridad: PP_ON, ...x });

const prio = (x: Partial<Envio> = {}): Envio => ({
  id: "p1",
  cliente_id: "c1",
  shopify_order_id: 1001,
  plantilla: "voltra_pago_prioridad",
  variables: { pedido: "#1001" },
  categoria: "utilidad",
  enviar_desde: AHORA.toISOString(),
  estado: "pendiente",
  clave_unica: "prio:1001",
  intentos: 0,
  ultimo_error: null,
  ...x,
});

const ctx = (pedido: Partial<NonNullable<Contexto["pedido"]>> = {}, x: Partial<Contexto> = {}): Contexto => ({
  cliente: { telefono: "+595981000000", wa_user_id: null, nombre: "Ana" },
  pedido: {
    shopify_order_id: 1001,
    nombre: "#1001",
    estado_confirmacion: "confirmado",
    tags: ["CONFIRMADO"],
    total: 129000,
    raw: { shipping_address: { first_name: "Ana", city: "Asunción" }, line_items: [{ title: "Tiras nasales", quantity: 1 }] },
    ...pedido,
  },
  consentimientoMarketing: null,
  ultimaEntrada: null,
  conversacionId: "conv1",
  ...x,
});
const ABIERTA = new Date("2026-10-12T10:00:00Z");

Deno.test("prio: ventana abierta → texto libre con el alias (palabras del dueño); no hace falta la plantilla", () => {
  const d = decidir(prio(), ctx({}, { ultimaEntrada: ABIERTA }), cfg(), AHORA, horario);
  assert(d.accion === "texto");
  assertEquals(d.texto, "📦 ¡Tu pedido ya está listo para salir!\nSi querés recibirlo antes, podés pagarlo ahora por transferencia y sale con prioridad en el primer despacho.\n💳 Alias: alias@ejemplo.com — Voltra E.A.S.\nSi preferís, pagás al recibir como siempre 👍");
  assertFalse(/descuento|menos|%|QR/.test(d.texto));
});

Deno.test("prio: ventana cerrada → plantilla voltra_pago_prioridad (pedido + alias) solo si está aprobada; si no, no sale", () => {
  const sin = decidir(prio(), ctx(), cfg(), AHORA, horario);
  assertEquals(sin, { accion: "cancelar", motivo: "ventana_cerrada_sin_plantilla_aprobada" });
  const con = decidir(prio(), ctx(), cfg({ plantillasActivas: { voltra_pago_prioridad: true } }), AHORA, horario);
  assert(con.accion === "plantilla");
  assertEquals(con.nombre, "voltra_pago_prioridad");
  assertEquals(con.componentes, [{ type: "body", parameters: [{ type: "text", text: "#1001" }, { type: "text", text: "alias@ejemplo.com" }] }]);
});

Deno.test("prio: apagada o sin alias → no sale nada (se cancela y no se repite)", () => {
  for (const pp of [{ activo: false, alias: "alias@ejemplo.com", titular: "Voltra E.A.S." }, { activo: false, alias: null, titular: "Voltra E.A.S." }]) {
    const d = decidir(prio(), ctx({}, { ultimaEntrada: ABIERTA }), cfg({ pagoPrioridad: pp, plantillasActivas: { voltra_pago_prioridad: true } }), AHORA, horario);
    assertEquals(d.accion, "cancelar", JSON.stringify(pp));
  }
});

Deno.test("prio: pagado, retiro, prueba, mayorista, cancelado, ya despachado u oferta vieja → no sale", () => {
  const casos: Partial<NonNullable<Contexto["pedido"]>>[] = [
    { tags: ["CONFIRMADO", "PAGADO"] },
    { tags: ["CONFIRMADO", "PAGO_VERIFICADO"] },
    { tags: ["CONFIRMADO", "PAGADO_QR"] },
    { raw: { financial_status: "paid" } },
    { tags: ["CONFIRMADO", "RETIRO_EN_CASA"] },
    { tags: ["PRUEBA_E2E"] },
    { tags: ["MAYORISTA"] },
    { estado_confirmacion: "cancelado_cliente" },
    { raw: { cancelled_at: "2026-10-12T10:00:00-03:00" } },
    { estado_envio: "DESPACHADO" },
    { tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"] },
  ];
  for (const p of casos) {
    const d = decidir(prio(), ctx(p, { ultimaEntrada: ABIERTA }), cfg(), AHORA, horario);
    assertEquals(d.accion, "cancelar", JSON.stringify(p));
  }
  // Pedido de WhatsApp (nace con OFERTA_PAGO_ANTICIPADO): sí sale.
  assertEquals(decidir(prio(), ctx({ tags: ["ORIGEN_WHATSAPP", "CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"] }, { ultimaEntrada: ABIERTA }), cfg(), AHORA, horario).accion, "texto");
});

Deno.test("prio: de noche se corre a las 8:00", () => {
  const noche = new Date("2026-10-13T01:30:00Z"); // lunes 22:30 en Asunción
  const d = decidir(prio(), ctx({}, { ultimaEntrada: new Date("2026-10-13T01:00:00Z") }), cfg(), noche, horario);
  assertEquals(d, { accion: "reprogramar", enviar_desde: new Date("2026-10-13T11:00:00Z"), motivo: "fuera_de_horario_avisos_envio" });
});

Deno.test("prio salió → se marca enviada y después tag OFERTA_PAGO_ANTICIPADO; si el tag falla, Telegram a Enrique", async () => {
  for (const tagOk of [true, false]) {
    const log = { cambios: [] as unknown[], textos: [] as string[], tags: [] as number[], avisos: [] as string[] };
    const d: Deps = {
      ahora: () => AHORA,
      cfg: cfg(),
      horario,
      reclamar: () => Promise.resolve([prio()]),
      contexto: () => Promise.resolve(ctx({}, { ultimaEntrada: ABIERTA })),
      actualizarEnvio: (_id, c) => (log.cambios.push(c), Promise.resolve()),
      enviarPlantilla: () => Promise.resolve({ ok: true }),
      enviarTexto: (_to, t) => (log.textos.push(t), Promise.resolve({ ok: true, wa_message_id: "wamid.P" })),
      enviarBotones: () => Promise.resolve({ ok: true }),
      retenerPedido: () => Promise.resolve({ ok: true }),
      cancelarPedidoSinRespuesta: () => Promise.resolve({ ok: true }),
      avisar: (t) => (log.avisos.push(t), Promise.resolve({ ok: true })),
      escapar: (x) => String(x ?? ""),
      marcarOfertaPrioridad: (id) => (log.tags.push(id), Promise.resolve(tagOk ? { ok: true } : { ok: false, error: "sin permiso" })),
    };
    const r = await procesarLote(d);
    assertEquals(r.enviados, 1);
    assertEquals(log.textos.length, 1);
    assertEquals(log.cambios, [{ estado: "enviado", intentos: 1, ultimo_error: null, wa_message_id: "wamid.P" }]);
    assertEquals(log.tags, [1001]);
    assertEquals(log.avisos.length, tagOk ? 0 : 1);
    if (!tagOk) assert(log.avisos[0].includes("OFERTA_PAGO_ANTICIPADO") && log.avisos[0].includes("sin permiso"));
  }
});

Deno.test("pedido ya pagado: 'ya salió' / 'hoy te llega' / víspera sin 'Tené Gs' (texto en la ventana); cerrada, no salen", () => {
  const pagado = { tags: ["CONFIRMADO", "PAGADO"] };
  const casos: [string, unknown, string][] = [
    ["voltra_pedido_despachado", { nombre: "Ana", productos: "1 Tiras nasales", courier: "Lucero del Este", plazo: "1 a 3 días hábiles", total: "129.000" },
      "Hola Ana, tu pedido de Voltra (1 Tiras nasales) ya salió con Lucero del Este.\nTe llega en 1 a 3 días hábiles. Ya está pagado ✅ no pagás nada al recibir."],
    ["voltra_entrega_hoy", { nombre: "Ana", total: "129.000" }, "Hola Ana, hoy te llega tu pedido de Voltra.\nYa está pagado ✅ no pagás nada al recibir."],
    ["voltra_entrega_manana", { nombre: "Ana", dia_entrega: "mañana martes 13/10", total: "129.000", fecha_entrega: "2026-10-13" },
      "Hola Ana, mañana martes 13/10 te llega tu pedido de Voltra 📦\nYa está pagado ✅ no pagás nada al recibir. El repartidor te contacta antes de salir."],
    ["voltra_entrega_proxima", { nombre: "Ana", total: "129.000" },
      "Hola Ana, tu pedido de Voltra ya está por llegar.\nYa está pagado ✅ no pagás nada al recibir. Tené el teléfono a mano para cuando te llame el repartidor."],
  ];
  for (const [plantilla, variables, texto] of casos) {
    const e = prio({ plantilla, variables, clave_unica: `courier:1001:${plantilla}` });
    const d = decidir(e, ctx(pagado, { ultimaEntrada: ABIERTA }), cfg(), AHORA, horario);
    assert(d.accion === "botones", plantilla);
    assertEquals(d.texto, texto);
    assertFalse(d.texto.includes("Gs"));
    assertEquals(d.botones.map((b) => b.id.split(":")[1]), d.botones.map(() => "1001"));
    // Ventana cerrada: no sale (mejor nada que pedirle plata a quien ya pagó).
    assertEquals(decidir(e, ctx(pagado), cfg(), AHORA, horario), { accion: "cancelar", motivo: "pedido_pagado_sin_ventana" });
    // Sin pagar: la plantilla de siempre, con el monto.
    const normal = decidir(e, ctx(), cfg(), AHORA, horario);
    assert(normal.accion === "plantilla" && normal.valores!.includes("129.000"), plantilla);
  }
});

Deno.test("config: pago_prioridad y plantillas_activas desde config_wa (objeto o lista); sin claves, apagado", () => {
  const c = configDesdeFilas([
    { clave: "pago_prioridad", valor: { activo: true, alias: "alias@ejemplo.com" } },
    { clave: "plantillas_activas", valor: { voltra_pago_prioridad: true, voltra_entrega_manana: false } },
  ]);
  assertEquals(c.pagoPrioridad, PP_ON);
  assertEquals(c.plantillasActivas, { voltra_pago_prioridad: true });
  assertEquals(configDesdeFilas([{ clave: "plantillas_activas", valor: ["pago_prioridad"] }]).plantillasActivas, { voltra_pago_prioridad: true });
  const vacia = configDesdeFilas([]);
  assertEquals([vacia.pagoPrioridad.activo, vacia.plantillasActivas], [false, {}]);
  assertEquals(configDesdeFilas([{ clave: "pago_prioridad", valor: { activo: true, alias: null } }]).pagoPrioridad.activo, false);
});
