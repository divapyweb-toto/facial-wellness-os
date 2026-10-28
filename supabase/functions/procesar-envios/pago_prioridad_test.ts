// 12-10: oferta de pago con prioridad (prio:<id>, pedidos del bot recién confirmados) y avisos de entrega de pedidos ya
// pagados. Datos inventados.
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

Deno.test("prio: ventana abierta → texto libre con el alias (palabras del dueño: 'quedó confirmado')", () => {
  const d = decidir(prio(), ctx({}, { ultimaEntrada: ABIERTA }), cfg(), AHORA, horario);
  assert(d.accion === "texto");
  assertEquals(d.texto, "📦 ¡Tu pedido quedó confirmado!\nSi querés recibirlo antes, podés pagarlo ahora por transferencia y sale con prioridad en el primer despacho.\n💳 Alias: alias@ejemplo.com — Voltra E.A.S.\nSi preferís, pagás al recibir como siempre 👍");
  assertFalse(/descuento|menos|%|QR|listo para salir/.test(d.texto));
});

Deno.test("prio: ventana cerrada → no sale nada (la plantilla ya no se usa)", () => {
  assertEquals(decidir(prio(), ctx(), cfg(), AHORA, horario), { accion: "cancelar", motivo: "ventana_cerrada" });
  assertEquals(decidir(prio(), ctx({}, { ultimaEntrada: new Date("2026-10-11T14:00:00Z") }), cfg(), AHORA, horario).accion, "cancelar");
});

Deno.test("prio: apagada o sin alias → no sale nada (se cancela y no se repite)", () => {
  for (const pp of [{ activo: false, alias: "alias@ejemplo.com", titular: "Voltra E.A.S." }, { activo: false, alias: null, titular: "Voltra E.A.S." }]) {
    const d = decidir(prio(), ctx({}, { ultimaEntrada: ABIERTA }), cfg({ pagoPrioridad: pp }), AHORA, horario);
    assertEquals(d.accion, "cancelar", JSON.stringify(pp));
  }
});

Deno.test("prio: ya despachado (preparado, con el courier o entregado), pagado, retiro, prueba, mayorista, cancelado u oferta vieja → no sale", () => {
  const casos: Partial<NonNullable<Contexto["pedido"]>>[] = [
    { raw: { fulfillment_status: "fulfilled" } },
    { estado_envio: "DESPACHADO" },
    { estado_envio: "ENTREGADO" },
    { tags: ["CONFIRMADO", "PAGADO"] },
    { tags: ["CONFIRMADO", "PAGO_VERIFICADO"] },
    { tags: ["CONFIRMADO", "PAGADO_QR"] },
    { raw: { financial_status: "paid" } },
    { tags: ["CONFIRMADO", "RETIRO_EN_CASA"] },
    { tags: ["PRUEBA_E2E"] },
    { tags: ["MAYORISTA"] },
    { tags: ["SIN_MENSAJES"] },
    { estado_confirmacion: "cancelado_cliente" },
    { raw: { cancelled_at: "2026-10-12T10:00:00-03:00" } },
    { tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"] },
  ];
  for (const p of casos) {
    const d = decidir(prio(), ctx(p, { ultimaEntrada: ABIERTA }), cfg(), AHORA, horario);
    assertEquals(d.accion, "cancelar", JSON.stringify(p));
  }
  // Pedido de WhatsApp (nace con OFERTA_PAGO_ANTICIPADO): sí sale.
  assertEquals(decidir(prio(), ctx({ tags: ["ORIGEN_WHATSAPP", "CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"] }, { ultimaEntrada: ABIERTA }), cfg(), AHORA, horario).accion, "texto");
});

Deno.test("prio: sin horario (va pegada a la confirmación): de noche con la ventana abierta sale igual", () => {
  const noche = new Date("2026-10-13T01:30:00Z"); // lunes 22:30 en Asunción
  const d = decidir(prio(), ctx({}, { ultimaEntrada: new Date("2026-10-13T01:25:00Z") }), cfg(), noche, horario);
  assertEquals(d.accion, "texto");
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

Deno.test("config: pago_prioridad desde config_wa; sin clave o sin alias, apagado", () => {
  assertEquals(configDesdeFilas([{ clave: "pago_prioridad", valor: { activo: true, alias: "alias@ejemplo.com" } }]).pagoPrioridad, PP_ON);
  assertEquals(configDesdeFilas([]).pagoPrioridad.activo, false);
  assertEquals(configDesdeFilas([{ clave: "pago_prioridad", valor: { activo: true, alias: null } }]).pagoPrioridad.activo, false);
});

Deno.test("28-10 (#1027): pago parcial (SALDO_PENDIENTE / PAGO_PARCIAL) → no sale ningún aviso de entrega con monto", () => {
  const ruta = prio({ plantilla: "voltra_entrega_proxima", variables: { nombre: "María", total: "112.000" }, clave_unica: "courier:1001:EN_RUTA" });
  for (const tags of [["CONFIRMADO", "PAGO_PARCIAL", "SALDO_PENDIENTE", "SALDO_52000", "REENVIO_PAP"], ["CONFIRMADO", "SALDO_PENDIENTE"]]) {
    const d = decidir(ruta, ctx({ tags }, { ultimaEntrada: ABIERTA }), cfg(), AHORA, horario);
    assertEquals(d, { accion: "cancelar", motivo: "pago_parcial_aviso_con_monto" });
  }
  // Pagado del todo: sigue saliendo el texto sin monto (como antes).
  const pag = decidir(ruta, ctx({ tags: ["CONFIRMADO", "PAGADO", "PAGO_VERIFICADO"] }, { ultimaEntrada: ABIERTA }), cfg(), AHORA, horario);
  assert(pag.accion === "texto" || pag.accion === "botones");
});
