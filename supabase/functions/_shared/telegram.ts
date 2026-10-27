// _shared/telegram.ts · Dueño: D (Telegram)
// Única puerta a la Telegram Bot API. Secretos (los carga Enrique):
// TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET.
// Verificado contra core.telegram.org/bots/api (Bot API 10.3, 24-08-2026).
import { type BotonTelegram, htmlATextoPlano, LIMITE_LEYENDA_TELEGRAM, recortar } from "./telegram_formato.ts";
import { decidirRuta, inicioDiaPY, leerPolitica, type OpcionesAviso, type PoliticaLeida, type RutaAviso } from "./telegram_politica.ts";
import { db } from "./db.ts";

export type { BotonTelegram } from "./telegram_formato.ts";
export type { DestinoAviso, OpcionesAviso } from "./telegram_politica.ts";

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

// ─── 27-10: política de avisos (telegram_politica.ts) ───────────────────────
// Base mínima que usa avisar(); en las pruebas se reemplaza con depsAvisos.
export const depsAvisos = {
  /** config.telegram_politica (texto) o null si no se pudo leer. */
  async leerPoliticaCruda(): Promise<unknown> {
    const { data, error } = await db().from("config").select("valor").eq("clave", "telegram_politica").maybeSingle();
    if (error) throw new Error(error.message);
    return data?.valor ?? null;
  },
  async encolar(fila: { tipo: string; texto: string; pedido: string | null; destino: "admin" | "resumen"; clave: string | null }): Promise<string | null> {
    const { error } = await db().from("avisos_admin").insert(fila);
    return error ? error.message : null;
  },
  async registrar(fila: { tipo: string; ok: boolean; error: string | null; origen: string; pedido: string | null; clave: string | null }): Promise<void> {
    await db().from("telegram_enviados").insert(fila);
  },
  /** ¿Ya salió (o se encoló) este tipo + clave desde `desdeISO`? */
  async yaSalio(tipo: string, clave: string | null, desdeISO: string): Promise<boolean> {
    let qa = db().from("telegram_enviados").select("id").eq("tipo", tipo).eq("ok", true).gte("creado_en", desdeISO);
    let qb = db().from("avisos_admin").select("id").eq("tipo", tipo).gte("creado_en", desdeISO);
    qa = clave ? qa.eq("clave", clave) : qa.is("clave", null);
    qb = clave ? qb.eq("clave", clave) : qb.is("clave", null);
    const [a, b] = await Promise.all([qa.limit(1), qb.limit(1)]);
    return (a.data?.length ?? 0) > 0 || (b.data?.length ?? 0) > 0;
  },
  ahora: () => new Date(),
};

let politicaCache: { valor: PoliticaLeida; hasta: number } | null = null;

/** Política vigente (caché 60 s por instancia). Si la base falla → null: rige el destino del código. */
export async function politicaVigente(): Promise<PoliticaLeida> {
  const ahora = depsAvisos.ahora().getTime();
  if (politicaCache && politicaCache.hasta > ahora) return politicaCache.valor;
  let valor: PoliticaLeida = null;
  try { valor = leerPolitica(await depsAvisos.leerPoliticaCruda()); } catch (e) { console.warn("telegram_politica:", e instanceof Error ? e.message : e); }
  politicaCache = { valor, hasta: ahora + 60_000 };
  return valor;
}

/** Solo para pruebas. */
export function _limpiarCachePolitica() { politicaCache = null; }

async function registrarEnvio(opts: OpcionesAviso | undefined, r: ResultadoTelegram, origen: string) {
  try {
    await depsAvisos.registrar({ tipo: opts?.tipo ?? "sin_tipo", ok: r.ok, error: r.error ?? null, origen, pedido: opts?.pedido ?? null, clave: opts?.clave ?? null });
  } catch (e) { console.warn("telegram_enviados:", e instanceof Error ? e.message : e); }
}

/**
 * Decide la ruta antes de mandar. Devuelve el resultado si el aviso NO va a Telegram (cola, descarte o repetido)
 * o null si hay que mandarlo ya. Un aviso de Enrique nunca se pierde: si la cola falla, sale por Telegram.
 */
async function antesDeMandar(texto: string, opts?: OpcionesAviso): Promise<{ resultado: ResultadoTelegram | null; ruta: RutaAviso }> {
  if (!opts?.tipo) return { resultado: null, ruta: "telegram" };
  const ruta = decidirRuta(await politicaVigente(), opts);
  if (ruta === "descartar") return { resultado: { ok: true }, ruta };
  if (opts.unaVezPorDia) {
    try {
      if (await depsAvisos.yaSalio(opts.tipo, opts.clave ?? null, inicioDiaPY(depsAvisos.ahora()))) return { resultado: { ok: true }, ruta };
    } catch (e) { console.warn("unaVezPorDia:", e instanceof Error ? e.message : e); }
  }
  if (ruta === "telegram") return { resultado: null, ruta };
  let err: string | null;
  try {
    err = await depsAvisos.encolar({ tipo: opts.tipo, texto, pedido: opts.pedido ?? null, destino: ruta, clave: opts.clave ?? null });
  } catch (e) { err = e instanceof Error ? e.message : String(e); }
  if (!err) return { resultado: { ok: true }, ruta };
  // La cola falló: lo del resumen es de Enrique → sale inmediato; lo de administración queda en el log.
  console.error(`avisos_admin (${opts.tipo}):`, err);
  if (ruta === "resumen") return { resultado: null, ruta: "telegram" };
  return { resultado: { ok: false, error: `avisos_admin: ${err}` }, ruta };
}

/**
 * Manda un aviso a Enrique (TELEGRAM_CHAT_ID) en modo HTML.
 * `texto` ya tiene que venir escapado (usar los helpers de telegram_formato.ts).
 * `botones`: filas de botones; cada uno con `callback` (accion:id) o `url`.
 * `opts` (27-10): tipo y destino del aviso; la política decide si va a Telegram, al resumen o a avisos_admin.
 *   Sin `opts`, sale por Telegram como siempre.
 */
export async function avisar(texto: string, botones?: BotonTelegram[][], opts?: OpcionesAviso): Promise<ResultadoTelegram> {
  const previo = await antesDeMandar(texto, opts);
  if (previo.resultado) return previo.resultado;
  const r = await mandarTexto(texto, botones);
  await registrarEnvio(opts, r, "inmediato");
  return r;
}

/** Telegram directo, sin política (lo usan avisar() y el resumen agrupado). */
export async function mandarTexto(texto: string, botones?: BotonTelegram[][]): Promise<ResultadoTelegram> {
  const chatId = env("TELEGRAM_CHAT_ID");
  if (!chatId) return { ok: false, error: "Falta el secreto TELEGRAM_CHAT_ID" };
  const base = { chat_id: chatId, link_preview_options: { is_disabled: true }, reply_markup: aInlineKeyboard(botones) };
  let r = await llamarTelegram("sendMessage", { ...base, text: recortar(texto), parse_mode: "HTML" });
  // 23-10: si Telegram no entiende el HTML, el aviso sale igual en texto plano (antes se perdía entero).
  if (!r.ok && /can't parse entities/i.test(r.error ?? "")) {
    r = await llamarTelegram("sendMessage", { ...base, text: recortar(htmlATextoPlano(texto)) });
  }
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, message_id: (r.result as { message_id?: number })?.message_id };
}

/** 12-10: llamada con multipart/form-data (subir un archivo). Nunca tira excepción. */
export async function llamarTelegramArchivo(
  metodo: string,
  form: FormData,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return { ok: false, error: "Falta el secreto TELEGRAM_BOT_TOKEN" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, { method: "POST", body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) return { ok: false, error: j?.description ?? `HTTP ${r.status}` };
    return { ok: true, result: j.result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fotos que Telegram muestra como foto (sendPhoto); el resto (PDF, webp, …) va como documento. */
const MIME_FOTO = new Set(["image/jpeg", "image/jpg", "image/png"]);

/** sendPhoto o sendDocument según el tipo (10 MB máximo para fotos: más grande va como documento). */
export function metodoArchivo(mime: string, bytes: number): "sendPhoto" | "sendDocument" {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_FOTO.has(base) && bytes <= 10_000_000 ? "sendPhoto" : "sendDocument";
}

/**
 * 12-10: manda a Enrique (TELEGRAM_CHAT_ID) una foto o un documento con leyenda HTML (máx. 1024) y botones.
 * Lo usa el comprobante del pago con prioridad: Enrique ve la imagen y toca "Recibido".
 */
export async function avisarConArchivo(
  leyendaHtml: string,
  archivo: { bytes: Uint8Array; mime: string; nombre: string },
  botones?: BotonTelegram[][],
  opts?: OpcionesAviso,
): Promise<ResultadoTelegram> {
  // 27-10: misma política que avisar(); en la cola queda solo la leyenda (el archivo no se guarda).
  const previo = await antesDeMandar(leyendaHtml, opts);
  if (previo.resultado) return previo.resultado;
  const chatId = env("TELEGRAM_CHAT_ID");
  if (!chatId) return { ok: false, error: "Falta el secreto TELEGRAM_CHAT_ID" };
  const metodo = metodoArchivo(archivo.mime, archivo.bytes.byteLength);
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", recortar(leyendaHtml, LIMITE_LEYENDA_TELEGRAM));
  form.append("parse_mode", "HTML");
  const teclado = aInlineKeyboard(botones);
  if (teclado) form.append("reply_markup", JSON.stringify(teclado));
  const blob = new Blob([new Uint8Array(archivo.bytes)], { type: archivo.mime.split(";")[0].trim() || "application/octet-stream" });
  form.append(metodo === "sendPhoto" ? "photo" : "document", blob, archivo.nombre);
  const r = await llamarTelegramArchivo(metodo, form);
  const res: ResultadoTelegram = r.ok ? { ok: true, message_id: (r.result as { message_id?: number })?.message_id } : { ok: false, error: r.error };
  await registrarEnvio(opts, res, "archivo");
  return res;
}

/** 12-10: reemplaza la leyenda y los botones de un aviso con foto o documento (editMessageCaption). */
export async function editarLeyenda(
  chatId: number | string,
  messageId: number,
  leyendaHtml: string,
  botones?: BotonTelegram[][] | null,
): Promise<ResultadoTelegram> {
  const r = await llamarTelegram("editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption: recortar(leyendaHtml, LIMITE_LEYENDA_TELEGRAM),
    parse_mode: "HTML",
    reply_markup: aInlineKeyboard(botones) ?? { inline_keyboard: [] },
  });
  return { ok: r.ok, error: r.error };
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
