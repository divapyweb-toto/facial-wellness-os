// telegram-webhook · Dueño: D (Telegram)
// Recibe los toques de Enrique en los botones de Telegram (callback_query).
// Seguridad: Telegram manda X-Telegram-Bot-Api-Secret-Token con el secret_token
// que se pasó en setWebhook; sin ese header correcto → 401. (verify_jwt = false
// en config.toml porque Telegram no manda JWT de Supabase.)
// Responde 200 enseguida y procesa con EdgeRuntime.waitUntil.
import { db, guardarEventoCrudo } from "../_shared/db.ts";
import { cancelarPedido, orderGid } from "../_shared/shopify.ts";
import { enviarTexto } from "../_shared/wa.ts";
import { editarMensaje, responderCallback, verificarSecretoTelegram } from "../_shared/telegram.ts";
import {
  type ClaveTextoCliente,
  type Dependencias,
  type PedidoContexto,
  procesarCallback,
  recibirUpdate,
  type TgUpdate,
} from "./procesar.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function enSegundoPlano(p: Promise<unknown>) {
  const conLog = p.catch((e) => console.error("telegram-webhook:", e));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(conLog);
}

async function obtenerPedido(id: number): Promise<PedidoContexto | null> {
  const { data: p, error } = await db()
    .from("shopify_pedidos")
    .select("shopify_order_id, nombre, estado_confirmacion, estado_envio, cliente_id")
    .eq("shopify_order_id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!p) return null;
  let cliente: PedidoContexto["cliente"] = null;
  let conversacion: PedidoContexto["conversacion"] = null;
  if (p.cliente_id) {
    const { data: c } = await db()
      .from("wa_clientes")
      .select("id, nombre, telefono, wa_user_id, wa_username")
      .eq("id", p.cliente_id)
      .maybeSingle();
    cliente = c ?? null;
    const { data: conv } = await db()
      .from("wa_conversaciones")
      .select("id, estado, ultima_entrada_en")
      .eq("cliente_id", p.cliente_id)
      .order("ultima_entrada_en", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    conversacion = conv ?? null;
  }
  return {
    shopify_order_id: Number(p.shopify_order_id),
    nombre: p.nombre,
    estado_confirmacion: p.estado_confirmacion,
    estado_envio: p.estado_envio,
    cliente,
    conversacion,
  };
}

function dependencias(chatId: string): Dependencias {
  return {
    chatIdPermitido: chatId,
    ahora: () => new Date(),
    guardarEventoCrudo: (idExterno, payload) => guardarEventoCrudo("telegram", idExterno, payload),
    marcarEventoProcesado: async (idExterno, error) => {
      await db()
        .from("eventos_crudos")
        .update({ procesado_en: new Date().toISOString(), error: error ?? null })
        .eq("fuente", "telegram")
        .eq("id_externo", idExterno);
    },
    reclamarAccion: (clave, payload) => guardarEventoCrudo("telegram", clave, payload),
    liberarAccion: async (clave) => {
      await db().from("eventos_crudos").delete().eq("fuente", "telegram").eq("id_externo", clave);
    },
    obtenerPedido,
    cancelarEnShopify: (id) => cancelarPedido(orderGid(id), "Cancelado por Enrique desde Telegram"),
    marcarPedidoCancelado: async (id, avisado) => {
      // estado_confirmacion no tiene un valor para "cancelado por Enrique":
      // se marca el envío como CANCELADO y queda el historial en pedido_estados.
      const { error } = await db()
        .from("shopify_pedidos")
        .update({ estado_envio: "CANCELADO", actualizado_en: new Date().toISOString() })
        .eq("shopify_order_id", id);
      if (error) throw new Error(error.message);
      const r = await db()
        .from("pedido_estados")
        .upsert(
          { shopify_order_id: id, estado: "CANCELADO", fuente: "telegram", notificado: avisado },
          { onConflict: "shopify_order_id,estado", ignoreDuplicates: true },
        );
      if (r.error) throw new Error(r.error.message);
    },
    cancelarEnviosPendientes: async (id) => {
      const { error } = await db()
        .from("envios_programados")
        .update({ estado: "cancelado", ultimo_error: "pedido cancelado desde Telegram" })
        .eq("shopify_order_id", id)
        .eq("estado", "pendiente");
      if (error) throw new Error(error.message);
    },
    pasarAHumano: async (conversacionId) => {
      const { error } = await db()
        .from("wa_conversaciones")
        .update({ estado: "humano", asignado_a: "enrique" })
        .eq("id", conversacionId);
      if (error) throw new Error(error.message);
    },
    textoCliente: async (clave: ClaveTextoCliente) => {
      const { data } = await db().from("config_wa").select("valor").eq("clave", "textos_decisiones").maybeSingle();
      const v = (data?.valor as Record<string, unknown> | undefined)?.[clave];
      return typeof v === "string" && v.trim() ? v : null;
    },
    enviarTextoCliente: (pedido, destino, texto) =>
      enviarTexto(destino, texto, {
        clienteId: pedido.cliente?.id ?? null,
        conversacionId: pedido.conversacion?.id ?? null,
      }),
    responderCallback: async (id, texto) => {
      await responderCallback(id, texto);
    },
    editarMensaje: async (chat, messageId, html, botones) => {
      const r = await editarMensaje(chat, messageId, html, botones);
      if (!r.ok) console.error("editMessageText:", r.error);
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("método no permitido", { status: 405 });
  if (!verificarSecretoTelegram(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return new Response("no autorizado", { status: 401 });
  }
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!chatId) return new Response("falta TELEGRAM_CHAT_ID", { status: 500 });

  let update: TgUpdate;
  try {
    update = await req.json();
  } catch {
    return new Response("ok", { status: 200 }); // basura: no hay nada que reintentar
  }
  const deps = dependencias(chatId);
  // Guardar en eventos_crudos ANTES de procesar; si la base falla → 500 y Telegram reintenta.
  let recibido;
  try {
    recibido = await recibirUpdate(update, deps);
  } catch (e) {
    console.error("telegram-webhook guardar:", e);
    return new Response("error guardando", { status: 500 });
  }
  if (recibido.tipo === "nuevo") {
    enSegundoPlano(procesarCallback(update, deps).then((r) => console.log("telegram-webhook:", JSON.stringify(r))));
  }
  return new Response("ok", { status: 200 });
});
