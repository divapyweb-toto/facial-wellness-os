// Pruebas de la lógica pura del webhook de Telegram (datos inventados).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { ResultadoPago } from "../_shared/shopify_pagos.ts";
import {
  botonesTrasDecision,
  type Dependencias,
  parsearCallback,
  type PedidoContexto,
  procesarUpdate,
  rellenar,
  type TgUpdate,
  TAG_PAGO_VERIFICADO,
  TAGS_PAGO_RECIBIDO,
  ventanaAbierta,
} from "./procesar.ts";

const CHAT = "111222333";
const AHORA = new Date("2026-10-06T15:00:00Z"); // 12:00 en Asunción

function pedidoBase(extra: Partial<PedidoContexto> = {}): PedidoContexto {
  return {
    shopify_order_id: 5001,
    nombre: "#1001",
    estado_confirmacion: "confirmado",
    estado_envio: null,
    cliente: {
      id: "c1",
      nombre: "Ana Prueba",
      telefono: "+595981000000",
      wa_user_id: null,
      wa_username: null,
    },
    conversacion: { id: "conv1", estado: "ia", ultima_entrada_en: "2026-10-06T10:00:00Z" },
    ...extra,
  };
}

function update(data: string, updateId = 1, chatId = Number(CHAT)): TgUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq${updateId}`,
      from: { id: chatId },
      data,
      message: {
        message_id: 77,
        date: 1700000000,
        chat: { id: chatId },
        text: "Te necesita un cliente · Producto dañado\nResumen <con signos> & más",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Reponer", callback_data: "reponer:5001" }, { text: "Le escribo yo", callback_data: "escribo:5001" }],
            [{ text: "Cancelar pedido", callback_data: "cancelar:5001" }],
            [{ text: "Abrir chat con el cliente", url: "https://wa.me/595981000000?text=hola" }],
          ],
        },
      },
    },
  };
}

function fakes(
  pedido: PedidoContexto | null = pedidoBase(),
  opciones: { shopifyOk?: boolean; textos?: boolean; pago?: ResultadoPago; tagsOk?: boolean } = {},
) {
  const tagsGuardados: { id: number; tags: string[] }[] = [];
  const eventos = new Set<string>();
  const candados = new Map<string, Record<string, unknown>>();
  const llamadas: string[] = [];
  const enviados: { destino: string; texto: string }[] = [];
  const ediciones: { html: string; botones: unknown }[] = [];
  const respuestas: string[] = [];
  const deps: Dependencias = {
    chatIdPermitido: CHAT,
    ahora: () => AHORA,
    guardarEventoCrudo: (id) => {
      if (eventos.has(id)) return Promise.resolve(false);
      eventos.add(id);
      return Promise.resolve(true);
    },
    marcarEventoProcesado: () => Promise.resolve(),
    reclamarAccion: (clave, payload) => {
      if (candados.has(clave)) return Promise.resolve(false);
      candados.set(clave, payload);
      return Promise.resolve(true);
    },
    liberarAccion: (clave) => {
      candados.delete(clave);
      return Promise.resolve();
    },
    obtenerPedido: () => Promise.resolve(pedido),
    cancelarEnShopify: (id) => {
      llamadas.push(`shopify:${id}`);
      return Promise.resolve(opciones.shopifyOk === false ? { ok: false, error: "boom" } : { ok: true });
    },
    marcarPedidoCancelado: (id, avisado) => {
      llamadas.push(`marcar:${id}:${avisado}`);
      return Promise.resolve();
    },
    cancelarEnviosPendientes: (id) => {
      llamadas.push(`envios:${id}`);
      return Promise.resolve();
    },
    pasarAHumano: (conv) => {
      llamadas.push(`humano:${conv}`);
      return Promise.resolve();
    },
    marcarPagadoEnShopify: (id) => {
      llamadas.push(`pagado:${id}`);
      return Promise.resolve(opciones.pago ?? { ok: true, estado_financiero: "PAID" });
    },
    agregarTagsShopify: (id, tags) => {
      llamadas.push(`tags:${id}:${tags.join(",")}`);
      return Promise.resolve(opciones.tagsOk === false ? { ok: false, error: "sin permiso" } : { ok: true });
    },
    guardarTagsPedido: (id, tags) => {
      tagsGuardados.push({ id, tags });
      return Promise.resolve();
    },
    textoCliente: (clave) =>
      Promise.resolve(opciones.textos === false ? null : `Hola {nombre}, texto ${clave} del pedido {pedido}.`),
    enviarTextoCliente: (_p, destino, texto) => {
      enviados.push({ destino, texto });
      return Promise.resolve({ ok: true });
    },
    responderCallback: (_id, texto) => {
      respuestas.push(texto);
      return Promise.resolve();
    },
    editarMensaje: (_c, _m, html, botones) => {
      ediciones.push({ html, botones });
      return Promise.resolve();
    },
  };
  return { deps, llamadas, enviados, ediciones, respuestas, candados, tagsGuardados };
}

Deno.test("parsearCallback acepta solo el formato del contrato", () => {
  assertEquals(parsearCallback("cancelar:5001"), { accion: "cancelar", id: 5001 });
  assertEquals(parsearCallback("reponer:12"), { accion: "reponer", id: 12 });
  assertEquals(parsearCallback("pagado:123"), { accion: "pagado", id: 123 });
  assertEquals(parsearCallback("pagado:"), null);
  assertEquals(parsearCallback("borrar:5001"), null);
  assertEquals(parsearCallback("cancelar:abc"), null);
  assertEquals(parsearCallback("cancelar:5001;drop"), null);
  assertEquals(parsearCallback(undefined), null);
});

Deno.test("ventanaAbierta: menos de 24 h abierta, más de 24 h cerrada", () => {
  assert(ventanaAbierta("2026-10-05T16:00:00Z", AHORA));
  assert(!ventanaAbierta("2026-10-05T14:00:00Z", AHORA));
  assert(!ventanaAbierta(null, AHORA));
});

Deno.test("rellenar usa el primer nombre y el número de pedido", () => {
  assertEquals(rellenar("Hola {nombre}, tu pedido {pedido}.", pedidoBase()), "Hola Ana, tu pedido #1001.");
  assertEquals(rellenar("Hola {nombre}, listo.", pedidoBase({ cliente: null })), "Hola, listo.");
});

Deno.test("rechaza callbacks de otro chat sin tocar nada", async () => {
  const f = fakes();
  const r = await procesarUpdate(update("cancelar:5001", 1, 999), f.deps);
  assertEquals(r.tipo, "ignorado");
  assertEquals(f.llamadas, []);
  assertEquals(f.respuestas, []);
});

Deno.test("cancelar: cancela en Shopify, frena envíos, avisa y edita el mensaje", async () => {
  const f = fakes();
  const r = await procesarUpdate(update("cancelar:5001"), f.deps);
  assertEquals(r.tipo, "hecho");
  assertEquals(f.llamadas, ["shopify:5001", "envios:5001", "marcar:5001:true"]);
  assertEquals(f.enviados.length, 1);
  assertEquals(f.enviados[0].destino, "+595981000000");
  assertStringIncludes(f.enviados[0].texto, "Hola Ana");
  assertEquals(f.ediciones.length, 1);
  assertStringIncludes(f.ediciones[0].html, "pedido cancelado");
  assertStringIncludes(f.ediciones[0].html, "&lt;con signos&gt; &amp; más"); // re-escapado
  // Solo queda el enlace wa.me
  assertEquals(f.ediciones[0].botones, [[{ texto: "Abrir chat con el cliente", url: "https://wa.me/595981000000?text=hola" }]]);
});

Deno.test("cancelar dos veces (dos toques) cancela una sola vez", async () => {
  const f = fakes();
  await procesarUpdate(update("cancelar:5001", 1), f.deps);
  const r2 = await procesarUpdate(update("cancelar:5001", 2), f.deps);
  assertEquals(r2.tipo, "ya_hecho");
  assertEquals(f.llamadas.filter((l) => l.startsWith("shopify")).length, 1);
  assertEquals(f.enviados.length, 1);
});

Deno.test("el mismo update reintentado por Telegram se descarta", async () => {
  const f = fakes();
  await procesarUpdate(update("reponer:5001", 7), f.deps);
  const r2 = await procesarUpdate(update("reponer:5001", 7), f.deps);
  assertEquals(r2.tipo, "repetido");
  assertEquals(f.enviados.length, 1);
});

Deno.test("cancelar con ventana cerrada: no escribe al cliente y lo anota", async () => {
  const f = fakes(pedidoBase({ conversacion: { id: "conv1", estado: "ia", ultima_entrada_en: "2026-10-01T10:00:00Z" } }));
  const r = await procesarUpdate(update("cancelar:5001"), f.deps);
  assertEquals(r.tipo, "hecho");
  assertEquals(f.enviados.length, 0);
  assert(f.llamadas.includes("marcar:5001:false"));
  assertStringIncludes(f.ediciones[0].html, "ventana de 24 h");
});

Deno.test("si Shopify falla, libera el candado y se puede reintentar", async () => {
  const f = fakes(pedidoBase(), { shopifyOk: false });
  const r = await procesarUpdate(update("cancelar:5001", 1), f.deps);
  assertEquals(r.tipo, "error");
  assertEquals(f.ediciones.length, 0);
  assertEquals(f.candados.size, 0);
  assertStringIncludes(f.respuestas[0], "No se pudo");
});

Deno.test("pedido ya cancelado: no vuelve a llamar a Shopify", async () => {
  const f = fakes(pedidoBase({ estado_confirmacion: "cancelado_cliente" }));
  const r = await procesarUpdate(update("cancelar:5001"), f.deps);
  assertEquals(r.tipo, "hecho");
  assertEquals(f.llamadas, []);
});

Deno.test("pedido inexistente: error y candado liberado", async () => {
  const f = fakes(null);
  const r = await procesarUpdate(update("reponer:5001"), f.deps);
  assertEquals(r.tipo, "error");
  assertEquals(f.candados.size, 0);
});

Deno.test("reponer: registra el reclamo en el candado y avisa al cliente", async () => {
  const f = fakes();
  const r = await procesarUpdate(update("reponer:5001"), f.deps);
  assertEquals(r.tipo, "hecho");
  assertEquals(f.candados.get("accion:reponer:5001")?.tipo, "reclamo_reposicion");
  assertStringIncludes(f.enviados[0].texto, "reposicion");
  // Quedan "Le escribo yo" y el enlace; se van "Reponer" y "Cancelar".
  assertEquals(f.ediciones[0].botones, [
    [{ texto: "Le escribo yo", callback: "escribo:5001" }],
    [{ texto: "Abrir chat con el cliente", url: "https://wa.me/595981000000?text=hola" }],
  ]);
});

Deno.test("reponer sin texto en config_wa: no inventa el mensaje", async () => {
  const f = fakes(pedidoBase(), { textos: false });
  await procesarUpdate(update("reponer:5001"), f.deps);
  assertEquals(f.enviados.length, 0);
  assertStringIncludes(f.ediciones[0].html, "config_wa");
});

Deno.test("escribo: pasa a humano y mantiene el enlace wa.me", async () => {
  const f = fakes();
  const r = await procesarUpdate(update("escribo:5001"), f.deps);
  assertEquals(r.tipo, "hecho");
  assertEquals(f.llamadas, ["humano:conv1"]);
  assertEquals(f.enviados.length, 0);
  const botones = f.ediciones[0].botones as { url?: string }[][];
  assert(botones.flat().some((b) => b.url?.startsWith("https://wa.me/595981000000")));
});

Deno.test("escribo con cliente sin teléfono: lo dice", async () => {
  const p = pedidoBase({
    cliente: { id: "c2", nombre: "Beto Prueba", telefono: null, wa_user_id: "PY.0000TEST", wa_username: null },
  });
  const f = fakes(p);
  const u = update("escribo:5001");
  u.callback_query!.message!.reply_markup = { inline_keyboard: [[{ text: "Le escribo yo", callback_data: "escribo:5001" }]] };
  await procesarUpdate(u, f.deps);
  assertStringIncludes(f.ediciones[0].html, "no tiene teléfono");
});

Deno.test("botonesTrasDecision tras cancelar deja solo enlaces", () => {
  const b = botonesTrasDecision(
    [[{ text: "Cancelar pedido", callback_data: "cancelar:1" }, { text: "Ver", url: "https://wa.me/1" }]],
    "cancelar",
  );
  assertEquals(b, [[{ texto: "Ver", url: "https://wa.me/1" }]]);
});

// ─── pagado:<id> (pago anticipado verificado en ueno) ─────────────

function updatePago(updateId = 1): TgUpdate {
  const u = update("pagado:5001", updateId);
  u.callback_query!.message!.text = "💸 #1001: el cliente mandó comprobante de pago anticipado (Gs 112.000).";
  u.callback_query!.message!.reply_markup = {
    inline_keyboard: [
      [{ text: "✅ Verifiqué el pago en ueno", callback_data: "pagado:5001" }],
      [{ text: "Le escribo yo", callback_data: "escribo:5001" }],
    ],
  };
  return u;
}

const pedidoPago = () => pedidoBase({ tags: ["OFERTA_PAGO_ANTICIPADO", "PAGO_ANTICIPADO_COMPROBANTE", "PRIORIDAD"] });

Deno.test("pagado: marca pagado en Shopify, agrega el tag, guarda tags, avisa y edita", async () => {
  const f = fakes(pedidoPago(), { textos: false }); // sin texto en config_wa → usa el texto por defecto
  const r = await procesarUpdate(updatePago(), f.deps);
  assertEquals(r.tipo, "hecho");
  // 12-10: PAGO_VERIFICADO (compatibilidad) + PRIORIDAD + PAGADO, en Shopify y en Voltra OS.
  assertEquals(TAGS_PAGO_RECIBIDO, ["PAGO_VERIFICADO", "PRIORIDAD", "PAGADO"]);
  assertEquals(f.llamadas, ["pagado:5001", "tags:5001:PAGO_VERIFICADO,PRIORIDAD,PAGADO"]);
  assertEquals(f.tagsGuardados, [{
    id: 5001,
    tags: ["OFERTA_PAGO_ANTICIPADO", "PAGO_ANTICIPADO_COMPROBANTE", "PRIORIDAD", TAG_PAGO_VERIFICADO, "PAGADO"],
  }]);
  assertEquals(f.enviados, [{
    destino: "+595981000000",
    texto: "Listo Ana, recibimos tu pago ✅ Tu pedido #1001 sale primero y no pagás nada al recibir.",
  }]);
  assertStringIncludes(f.ediciones[0].html, "pago verificado");
  assertStringIncludes(f.ediciones[0].html, "Marcado como pagado en Shopify.");
  // Se va el botón de pago; queda "Le escribo yo".
  assertEquals(f.ediciones[0].botones, [[{ texto: "Le escribo yo", callback: "escribo:5001" }]]);
  assertEquals(f.respuestas, ["Listo: pago verificado."]);
  assertEquals(f.candados.get("accion:pagado:5001")?.tipo, "decision_pagado");
});

Deno.test("pagado: con texto en config_wa usa ese texto", async () => {
  const f = fakes(pedidoPago());
  await procesarUpdate(updatePago(), f.deps);
  assertEquals(f.enviados[0].texto, "Hola Ana, texto pagado del pedido #1001.");
});

Deno.test("pagado: ya estaba pagado en Shopify → ok, igual agrega el tag", async () => {
  const f = fakes(pedidoPago(), { pago: { ok: true, ya_pagado: true, estado_financiero: "PAID" } });
  const r = await procesarUpdate(updatePago(), f.deps);
  assertEquals(r.tipo, "hecho");
  assert(f.llamadas.includes("tags:5001:PAGO_VERIFICADO,PRIORIDAD,PAGADO"));
  assertStringIncludes(f.ediciones[0].html, "Ya figuraba pagado en Shopify.");
});

Deno.test("pagado dos veces (dos toques): Shopify una sola vez", async () => {
  const f = fakes(pedidoPago());
  await procesarUpdate(updatePago(1), f.deps);
  const r2 = await procesarUpdate(updatePago(2), f.deps);
  assertEquals(r2.tipo, "ya_hecho");
  assertEquals(f.llamadas.filter((l) => l.startsWith("pagado")).length, 1);
  assertEquals(f.enviados.length, 1);
  assertEquals(f.respuestas[1], "Ese pago ya estaba verificado.");
});

Deno.test("pagado: si markAsPaid falla, responde el error, no agrega tag y libera el candado", async () => {
  const f = fakes(pedidoPago(), { pago: { ok: false, error: "Order cannot be marked as paid", estado_financiero: "PENDING" } });
  const r = await procesarUpdate(updatePago(), f.deps);
  assertEquals(r.tipo, "error");
  assertEquals(f.llamadas, ["pagado:5001"]);
  assertEquals(f.tagsGuardados, []);
  assertEquals(f.enviados, []);
  assertEquals(f.ediciones, []);
  assertEquals(f.candados.size, 0);
  assertStringIncludes(f.respuestas[0], "No se pudo: Shopify no lo marcó pagado (Order cannot be marked as paid)");
});

Deno.test("pagado con ventana cerrada: no escribe al cliente y lo anota", async () => {
  const f = fakes(pedidoBase({ conversacion: { id: "conv1", estado: "ia", ultima_entrada_en: "2026-10-01T10:00:00Z" } }));
  const r = await procesarUpdate(updatePago(), f.deps);
  assertEquals(r.tipo, "hecho");
  assertEquals(f.enviados.length, 0);
  assertEquals(f.tagsGuardados, [{ id: 5001, tags: ["PAGO_VERIFICADO", "PRIORIDAD", "PAGADO"] }]);
  assertStringIncludes(f.ediciones[0].html, "ventana de 24 h");
});

Deno.test("pagado: si falla el tag en Shopify, lo anota pero el pago queda hecho", async () => {
  const f = fakes(pedidoPago(), { tagsOk: false });
  const r = await procesarUpdate(updatePago(), f.deps);
  assertEquals(r.tipo, "hecho");
  assertEquals(f.candados.size, 1);
  assertStringIncludes(f.ediciones[0].html, "sin permiso");
});

// ─── 12-10: "Recibido" del pago con prioridad (aviso con la foto del comprobante) ─────────────

/** El aviso del comprobante llega como foto: Telegram manda `caption` y `photo`, sin `text`. */
function updateFoto(updateId = 1): TgUpdate {
  const u = updatePago(updateId);
  const m = u.callback_query!.message!;
  delete m.text;
  m.caption = "💸 #1001: el cliente mandó el comprobante del pago anticipado (prioridad).\nMonto a verificar: Gs 129.000 (total del pedido).";
  m.photo = [{ file_id: "FOTO" }];
  m.reply_markup = { inline_keyboard: [[{ text: "Recibido", callback_data: "pagado:5001" }], [{ text: "Le escribo yo", callback_data: "escribo:5001" }]] };
  return u;
}

const RAW_PREPARADO = {
  fulfillment_status: "fulfilled",
  financial_status: "pending",
  total_price: "129000.00",
  shipping_address: { first_name: "Ana", last_name: "Prueba", address1: "Calle Falsa 123", city: "Asunción" },
};

function fakesRecibido(pedido: PedidoContexto) {
  const f = fakes(pedido);
  const leyendas: { html: string; botones: unknown }[] = [];
  const avisos: string[] = [];
  const opciones: unknown[] = [];
  const ventas: string[] = [];
  f.deps.editarLeyenda = (_c, _m, html, botones) => (leyendas.push({ html, botones }), Promise.resolve());
  f.deps.avisar = (html, _b, o) => (avisos.push(html), opciones.push(o), Promise.resolve({ ok: true }));
  f.deps.marcarVentaPagada = (p) => (ventas.push(p.nombre ?? ""), Promise.resolve(1));
  return { ...f, leyendas, avisos, opciones, ventas };
}

Deno.test("Recibido en el aviso con foto: pagado + tags PRIORIDAD y PAGADO, venta pagada, cliente avisado y se edita la leyenda", async () => {
  const f = fakesRecibido(pedidoBase({ tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"] }));
  const r = await procesarUpdate(updateFoto(), f.deps);
  assertEquals(r.tipo, "hecho");
  assertEquals(f.llamadas, ["pagado:5001", "tags:5001:PAGO_VERIFICADO,PRIORIDAD,PAGADO"]);
  assertEquals(f.tagsGuardados, [{ id: 5001, tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO", "PAGO_VERIFICADO", "PRIORIDAD", "PAGADO"] }]);
  assertEquals(f.ventas, ["#1001"]);
  assertEquals(f.enviados.length, 1); // texto de siempre al cliente (ventana abierta)
  assertEquals(f.ediciones, []); // una foto no se edita con editMessageText
  assertEquals(f.leyendas.length, 1);
  assertStringIncludes(f.leyendas[0].html, "Monto a verificar: Gs 129.000");
  assertStringIncludes(f.leyendas[0].html, "pago verificado");
  assert(f.leyendas[0].html.length <= 1024);
  assertEquals(f.leyendas[0].botones, [[{ texto: "Le escribo yo", callback: "escribo:5001" }]]);
  assertEquals(f.avisos, []); // sin preparar todavía: no hace falta el texto para el courier
});

Deno.test("Recibido con el pedido ya preparado (fulfilled) o con el courier: texto para el courier con YA PAGADO y cobro 0", async () => {
  for (const extra of [
    { raw: RAW_PREPARADO, courier: "lucero" },
    { raw: { ...RAW_PREPARADO, fulfillment_status: null }, estado_envio: "DESPACHADO", courier: "pap" },
  ] as Partial<PedidoContexto>[]) {
    const f = fakesRecibido(pedidoBase({ tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"], telefono: "+595981000000", ...extra }));
    await procesarUpdate(updateFoto(), f.deps);
    assertEquals(f.avisos.length, 1, JSON.stringify(extra));
    const t = f.avisos[0];
    assertStringIncludes(t, extra.courier === "lucero" ? "Para reenviar a Lucero" : "Para reenviar a Punto a Punto");
    assertStringIncludes(t, "entregar SIN COBRAR (Gs 0)");
    assertStringIncludes(t, "YA PAGADO: no cobrar.");
    assert(!/Cobrar Gs/.test(t), t);
    assertStringIncludes(f.leyendas[0].html, "texto para el courier");
    // 27-10: el texto para el courier va a Enrique (Telegram), con tipo y pedido.
    assertEquals(f.opciones, [{ tipo: "pago_courier_no_cobrar", destino: "enrique", pedido: "#1001" }]);
  }
});

Deno.test("Recibido con el pedido ya ENTREGADO: no hay texto para el courier ni se toca la venta; avisa que puede haber pagado dos veces", async () => {
  const f = fakesRecibido(pedidoBase({ estado_envio: "ENTREGADO", raw: RAW_PREPARADO }));
  await procesarUpdate(updateFoto(), f.deps);
  assertEquals(f.avisos, []);
  assertEquals(f.ventas, []);
  assertStringIncludes(f.leyendas[0].html, "ya figura ENTREGADO");
});

Deno.test("Recibido: si falla la venta o el texto del courier, el pago queda hecho y se anota", async () => {
  const f = fakesRecibido(pedidoBase({ raw: RAW_PREPARADO }));
  f.deps.marcarVentaPagada = () => Promise.reject(new Error("db caída"));
  f.deps.avisar = () => Promise.resolve({ ok: false, error: "chat not found" });
  const r = await procesarUpdate(updateFoto(), f.deps);
  assertEquals(r.tipo, "hecho");
  assertStringIncludes(f.leyendas[0].html, "marcar la venta como pago anticipado");
  assertStringIncludes(f.leyendas[0].html, "avisale que NO cobre");
});

Deno.test("Le escribo yo en el aviso con foto: también edita la leyenda (no el texto)", async () => {
  const f = fakesRecibido(pedidoBase());
  const u = updateFoto();
  u.callback_query!.data = "escribo:5001";
  await procesarUpdate(u, f.deps);
  assertEquals(f.ediciones, []);
  assertEquals(f.leyendas.length, 1);
  assertStringIncludes(f.leyendas[0].html, "le escribo yo");
});

// ─── 29-10: "Es este" (transferencia ambigua) y factura al cobrar ───

function updateCandidatos(data: string, updateId = 900): TgUpdate {
  const u = update(data, updateId);
  u.callback_query!.message!.text = "💸 Transferencia de Gs 112.000 sin pedido claro: hay 17 pedidos esperando ese monto.";
  u.callback_query!.message!.reply_markup = {
    inline_keyboard: [
      [{ text: "Es este: #1001", callback_data: "es_este:5001:t2610291530" }],
      [{ text: "Es este: #1002", callback_data: "es_este:5002:t2610291530" }],
      [{ text: "Es este: #1003", callback_data: "es_este:5003:t2610291530" }],
    ],
  };
  return u;
}

function conFactura(f: ReturnType<typeof fakes>, falla = false) {
  const facturados: number[] = [];
  f.deps.facturarAlCobrar = (id) => {
    facturados.push(id);
    return falla ? Promise.reject(new Error("sifen-cola caída")) : Promise.resolve({ orderId: id, accion: "emitida" });
  };
  return facturados;
}

Deno.test("parsearCallback: es_este:<id>:<ref>", () => {
  assertEquals(parsearCallback("es_este:5001:t2610291530"), { accion: "es_este", id: 5001, ref: "t2610291530" });
  assertEquals(parsearCallback("es_este:5001"), null);
  assertEquals(parsearCallback("es_este:5001:a b"), null);
});

Deno.test("Es este: marca pagado como Recibido, dispara facturarAlCobrar y saca los otros botones", async () => {
  const f = fakes();
  const facturados = conFactura(f);
  const r = await procesarUpdate(updateCandidatos("es_este:5001:t2610291530"), f.deps);
  assertEquals(r.tipo, "hecho");
  assert(f.llamadas.includes("pagado:5001"));
  assert(f.llamadas.includes(`tags:5001:${TAGS_PAGO_RECIBIDO.join(",")}`));
  assertEquals(facturados, [5001]);
  assertEquals(f.enviados.length, 1); // cliente avisado (ventana abierta)
  assert(f.candados.has("accion:pagado:5001"));
  assertEquals(f.candados.get("accion:pagado:5001")?.via, "es_este");
  assertStringIncludes(f.ediciones[0].html, "pago asociado a este pedido");
  assertEquals(f.ediciones[0].botones, []); // ya no quedan "Es este"
  assertEquals(f.respuestas, ["Listo: pago asociado a este pedido."]);
});

Deno.test("Es este y después Recibido del mismo pedido: un solo pago y una sola factura", async () => {
  const f = fakes();
  const facturados = conFactura(f);
  await procesarUpdate(updateCandidatos("es_este:5001:t2610291530", 901), f.deps);
  const r = await procesarUpdate(update("pagado:5001", 902), f.deps);
  assertEquals(r.tipo, "ya_hecho");
  assertEquals(f.llamadas.filter((l) => l === "pagado:5001").length, 1);
  assertEquals(facturados, [5001]);
});

Deno.test("Recibido: dispara facturarAlCobrar; si falla, el botón igual responde Listo", async () => {
  const f = fakes();
  const facturados = conFactura(f, true);
  const r = await procesarUpdate(update("pagado:5001", 903), f.deps);
  assertEquals(r.tipo, "hecho");
  assertEquals(facturados, [5001]);
  assertEquals(f.respuestas, ["Listo: pago verificado."]);
});

Deno.test("Recibido: si Shopify no lo marca pagado, no se factura", async () => {
  const f = fakes(pedidoBase(), { pago: { ok: false, error: "boom" } as ResultadoPago });
  const facturados = conFactura(f);
  const r = await procesarUpdate(update("pagado:5001", 904), f.deps);
  assertEquals(r.tipo, "error");
  assertEquals(facturados, []);
});

Deno.test("facturarAlCobrar no bloquea el botón (no se espera su promesa)", async () => {
  const f = fakes();
  let resolver: () => void = () => {};
  f.deps.facturarAlCobrar = () => new Promise<void>((res) => { resolver = res; });
  const r = await procesarUpdate(update("pagado:5001", 905), f.deps);
  assertEquals(r.tipo, "hecho"); // terminó aunque la factura sigue pendiente
  resolver();
});
