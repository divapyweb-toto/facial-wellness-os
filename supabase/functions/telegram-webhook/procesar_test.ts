// Pruebas de la lógica pura del webhook de Telegram (datos inventados).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  botonesTrasDecision,
  type Dependencias,
  parsearCallback,
  type PedidoContexto,
  procesarUpdate,
  rellenar,
  type TgUpdate,
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

function fakes(pedido: PedidoContexto | null = pedidoBase(), opciones: { shopifyOk?: boolean; textos?: boolean } = {}) {
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
  return { deps, llamadas, enviados, ediciones, respuestas, candados };
}

Deno.test("parsearCallback acepta solo el formato del contrato", () => {
  assertEquals(parsearCallback("cancelar:5001"), { accion: "cancelar", id: 5001 });
  assertEquals(parsearCallback("reponer:12"), { accion: "reponer", id: 12 });
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
