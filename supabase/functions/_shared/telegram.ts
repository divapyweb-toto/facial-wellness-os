// _shared/telegram.ts · Dueño: D (Telegram)
// Única puerta a la Telegram Bot API. Secretos (los carga Enrique):
// TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET.
// Verificado contra core.telegram.org/bots/api (Bot API 10.3, 24-08-2026).
import { type BotonTelegram, recortar } from "./telegram_formato.ts";

export type { BotonTelegram } from "./telegram_formato.ts";

export interface ResultadoTelegram {
  ok: boolean;
  message_id?: number;
  error?: string;
}

function env(nombre: string): string | undefined {
  return Deno.env.get(nombre) ?? undefined;
}

/** Convierte nuestros botones al formato inline_keyboard de la Bot API. */
export function aInlineKeyboard(botones?: BotonTelegram[][] | null) {
  if (!botones?.length) return undefined;
  return {
    inline_keyboard: botones
      .map((fila) =>
        fila.map((b) =>
          b.url ? { text: b.texto, url: b.url } : { text: b.texto, callback_data: b.callback ?? "" }
        )
      )
      .filter((fila) => fila.length > 0),
  };
}

/** Llamada genérica a un método de la Bot API. Nunca tira excepción. */
export async function llamarTelegram(
  metodo: string,
  cuerpo: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return { ok: false, error: "Falta el secreto TELEGRAM_BOT_TOKEN" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) return { ok: false, error: j?.description ?? `HTTP ${r.status}` };
    return { ok: true, result: j.result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Manda un aviso a Enrique (TELEGRAM_CHAT_ID) en modo HTML.
 * `texto` ya tiene que venir escapado (usar los helpers de telegram_formato.ts).
 * `botones`: filas de botones; cada uno con `callback` (accion:id) o `url`.
 */
export async function avisar(texto: string, botones?: BotonTelegram[][]): Promise<ResultadoTelegram> {
  const chatId = env("TELEGRAM_CHAT_ID");
  if (!chatId) return { ok: false, error: "Falta el secreto TELEGRAM_CHAT_ID" };
  const r = await llamarTelegram("sendMessage", {
    chat_id: chatId,
    text: recortar(texto),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: aInlineKeyboard(botones),
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, message_id: (r.result as { message_id?: number })?.message_id };
}

/** Comparación de tiempo constante, para no filtrar el secreto por timing. */
export function igualesSeguro(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let dif = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) dif |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return dif === 0;
}

/**
 * Valida el header X-Telegram-Bot-Api-Secret-Token contra TELEGRAM_WEBHOOK_SECRET
 * (el mismo valor que se pasó como secret_token en setWebhook).
 * Sin secreto configurado, rechaza todo.
 */
export function verificarSecretoTelegram(header: string | null | undefined): boolean {
  const secreto = env("TELEGRAM_WEBHOOK_SECRET");
  if (!secreto || !header) return false;
  return igualesSeguro(header, secreto);
}

/** Cierra el "cargando" del botón en Telegram (hay que hacerlo antes de 30 s). */
export async function responderCallback(callbackQueryId: string, texto?: string): Promise<ResultadoTelegram> {
  const r = await llamarTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(texto ? { text: texto.slice(0, 200) } : {}),
  });
  return { ok: r.ok, error: r.error };
}

/** Reemplaza texto y botones de un mensaje ya enviado (constancia de la decisión). */
export async function editarMensaje(
  chatId: number | string,
  messageId: number,
  textoHtml: string,
  botones?: BotonTelegram[][] | null,
): Promise<ResultadoTelegram> {
  const r = await llamarTelegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: recortar(textoHtml),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    // Sin botones: un teclado vacío los saca.
    reply_markup: aInlineKeyboard(botones) ?? { inline_keyboard: [] },
  });
  return { ok: r.ok, error: r.error };
}

/** Solo cambia los botones (editMessageReplyMarkup). */
export async function editarBotones(
  chatId: number | string,
  messageId: number,
  botones?: BotonTelegram[][] | null,
): Promise<ResultadoTelegram> {
  const r = await llamarTelegram("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: aInlineKeyboard(botones) ?? { inline_keyboard: [] },
  });
  return { ok: r.ok, error: r.error };
}
