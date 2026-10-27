// telegram-webhook · Dueño: D (Telegram)
// Recibe los toques de Enrique en los botones de Telegram (callback_query).
// Seguridad: Telegram manda X-Telegram-Bot-Api-Secret-Token con el secret_token
// que se pasó en setWebhook; sin ese header correcto → 401. (verify_jwt = false
// en config.toml porque Telegram no manda JWT de Supabase.)
// Responde 200 enseguida y procesa con EdgeRuntime.waitUntil.
import { verificarSecretoTelegram } from "../_shared/telegram.ts";
import { procesarCallback, recibirUpdate, type TgUpdate } from "./procesar.ts";
import { dependencias } from "./dependencias.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function enSegundoPlano(p: Promise<unknown>) {
  const conLog = p.catch((e) => console.error("telegram-webhook:", e));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(conLog);
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
