// _shared/telegram_formato.ts · Dueño: D (Telegram)
// Lógica pura: arma los textos y botones de los avisos a Enrique.
// Sin red ni base de datos, para poder probarla con `deno test`.
//
// Los avisos salen con parse_mode "HTML" de la Bot API. En ese modo solo hay
// que reemplazar <, > y & por &lt; &gt; &amp; (core.telegram.org/bots/api#html-style).
// Es más simple y seguro que MarkdownV2, que obliga a escapar 18 símbolos.
import { partesAsuncion } from "./horario.ts";

/** Un botón del teclado bajo el mensaje: o manda un callback, o abre un enlace. */
export interface BotonTelegram {
  texto: string;
  /** callback_data: 1 a 64 bytes (límite de la Bot API). */
  callback?: string;
  /** Enlace que se abre al tocarlo (por ejemplo wa.me). */
  url?: string;
}

/** Límite de texto de sendMessage / editMessageText: 4096 caracteres. */
export const LIMITE_TEXTO_TELEGRAM = 4096;
/** Límite de callback_data: 64 bytes. */
export const LIMITE_CALLBACK_BYTES = 64;

export function escaparHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Para valores dentro de un atributo href="...": además escapa comillas. */
export function escaparAtributo(s: unknown): string {
  return escaparHtml(s).replace(/"/g, "&quot;");
}

/** Recorta sin pasarse del límite de Telegram, avisando que se cortó. */
export function recortar(texto: string, limite = LIMITE_TEXTO_TELEGRAM): string {
  if (texto.length <= limite) return texto;
  const cola = "\n…(recortado)";
  return texto.slice(0, limite - cola.length) + cola;
}

/**
 * Enlace para que Enrique le escriba al cliente desde su WhatsApp.
 * https://wa.me/<teléfono sin +>?text=<resumen urlencoded>
 * Devuelve null si no hay teléfono utilizable (cliente que solo tiene user_id).
 */
export function enlaceWaMe(telefono: string | null | undefined, resumen?: string | null): string | null {
  const digitos = String(telefono ?? "").replace(/\D/g, "");
  if (digitos.length < 8) return null;
  const texto = String(resumen ?? "").trim();
  return texto ? `https://wa.me/${digitos}?text=${encodeURIComponent(texto)}` : `https://wa.me/${digitos}`;
}

/** Arma el callback_data `accion:shopify_order_id` y valida el límite de 64 bytes. */
export function callbackData(accion: AccionTelegram, shopifyOrderId: number | string): string {
  const data = `${accion}:${shopifyOrderId}`;
  if (new TextEncoder().encode(data).length > LIMITE_CALLBACK_BYTES) {
    throw new Error(`callback_data supera ${LIMITE_CALLBACK_BYTES} bytes: ${data}`);
  }
  return data;
}

export type AccionTelegram = "cancelar" | "reponer" | "escribo";

/** Texto fijo cuando el cliente no tiene teléfono (llegó con nombre de usuario). */
export function lineaSinTelefono(waUserId?: string | null, waUsername?: string | null): string {
  const quien = waUsername ? ` (usuario: ${escaparHtml(waUsername)})` : waUserId ? ` (id: ${escaparHtml(waUserId)})` : "";
  return `Este cliente no tiene teléfono${quien}: no hay enlace wa.me. Respondele desde la bandeja de Voltra OS.`;
}

export interface DatosCliente {
  nombre?: string | null;
  telefono?: string | null;
  wa_user_id?: string | null;
  wa_username?: string | null;
}

function lineasContacto(c: DatosCliente, resumenParaCliente?: string | null): { lineas: string[]; enlace: string | null } {
  const enlace = enlaceWaMe(c.telefono, resumenParaCliente);
  const lineas: string[] = [];
  if (c.nombre) lineas.push(`Cliente: ${escaparHtml(c.nombre)}`);
  if (enlace) {
    lineas.push(`Teléfono: ${escaparHtml(c.telefono)} · <a href="${escaparAtributo(enlace)}">escribirle</a>`);
  } else {
    lineas.push(lineaSinTelefono(c.wa_user_id, c.wa_username));
  }
  return { lineas, enlace };
}

export interface AvisoArmado {
  texto: string;
  botones: BotonTelegram[][];
}

// ─── Pedido nuevo ───────────────────────────────────────────
export interface DatosPedidoNuevo {
  shopify_order_id: number | string;
  nombre_pedido?: string | null; // '#1001'
  total?: number | null; // en guaraníes
  productos?: string[] | null; // "Tiras nasales x2"
  ciudad?: string | null;
  origen?: string | null; // 'web' | 'whatsapp'
  cliente: DatosCliente;
}

export function formatearGuaranies(n: number): string {
  return "₲" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function formatoPedidoNuevo(p: DatosPedidoNuevo): AvisoArmado {
  const titulo = `<b>Pedido nuevo ${escaparHtml(p.nombre_pedido ?? p.shopify_order_id)}</b>` +
    (p.origen ? ` · ${escaparHtml(p.origen)}` : "");
  const l = [titulo];
  if (p.total != null) l.push(`Total: ${formatearGuaranies(p.total)}`);
  if (p.productos?.length) l.push(`Productos: ${p.productos.map(escaparHtml).join(" · ")}`);
  if (p.ciudad) l.push(`Ciudad: ${escaparHtml(p.ciudad)}`);
  const { lineas, enlace } = lineasContacto(p.cliente);
  l.push(...lineas);

  const fila: BotonTelegram[] = [{ texto: "Cancelar pedido", callback: callbackData("cancelar", p.shopify_order_id) }];
  if (enlace) fila.push({ texto: "Escribirle", url: enlace });
  return { texto: recortar(l.join("\n")), botones: [fila] };
}

// ─── Chat que necesita a Enrique ────────────────────────────
export interface DatosChatEnrique {
  motivo: string; // "Producto dañado", "Pide hablar con una persona"...
  resumen: string; // resumen del caso (lo arma la IA o B)
  shopify_order_id?: number | string | null;
  nombre_pedido?: string | null;
  cliente: DatosCliente;
  /** Si es un reclamo de producto, se ofrecen "Reponer" y "Le escribo yo". */
  ofrecerReponer?: boolean;
}

export function formatoChatNecesitaEnrique(d: DatosChatEnrique): AvisoArmado {
  const l = [`<b>Te necesita un cliente</b> · ${escaparHtml(d.motivo)}`];
  if (d.shopify_order_id != null) l.push(`Pedido: ${escaparHtml(d.nombre_pedido ?? d.shopify_order_id)}`);
  const { lineas, enlace } = lineasContacto(d.cliente, d.resumen);
  l.push(...lineas);
  l.push("", "<b>Resumen</b>", escaparHtml(d.resumen));

  const botones: BotonTelegram[][] = [];
  if (d.shopify_order_id != null) {
    const id = d.shopify_order_id;
    const fila1: BotonTelegram[] = [];
    if (d.ofrecerReponer) fila1.push({ texto: "Reponer", callback: callbackData("reponer", id) });
    fila1.push({ texto: "Le escribo yo", callback: callbackData("escribo", id) });
    botones.push(fila1);
    botones.push([{ texto: "Cancelar pedido", callback: callbackData("cancelar", id) }]);
  }
  if (enlace) botones.push([{ texto: "Abrir chat con el cliente", url: enlace }]);
  return { texto: recortar(l.join("\n")), botones };
}

// ─── Fallas ─────────────────────────────────────────────────
export interface DatosFalla {
  titulo: string; // "Canal sordo", "Envío fallido"...
  detalles?: string[];
  queHacer?: string | null;
}

export function formatoFalla(f: DatosFalla): AvisoArmado {
  const l = [`<b>Atención: ${escaparHtml(f.titulo)}</b>`];
  for (const d of f.detalles ?? []) l.push(`• ${escaparHtml(d)}`);
  if (f.queHacer) l.push("", `Qué hacer: ${escaparHtml(f.queHacer)}`);
  return { texto: recortar(l.join("\n")), botones: [] };
}

// ─── Constancia de la decisión (cuando Enrique toca un botón) ──
/** Hora corta de Asunción, por ejemplo "06-10 14:32". */
export function horaCortaAsuncion(d: Date): string {
  const p = partesAsuncion(d);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${z(p.dia)}-${z(p.mes)} ${z(p.hora)}:${z(p.minuto)}`;
}

/**
 * Texto del mensaje original (llega sin formato en el callback) + la decisión.
 * Se re-escapa todo porque el mensaje editado vuelve a salir en modo HTML.
 */
export function textoConDecision(textoOriginal: string, decision: string, notas: string[], cuando: Date): string {
  const l = [escaparHtml(textoOriginal), "", `<b>Decisión (${horaCortaAsuncion(cuando)}):</b> ${escaparHtml(decision)}`];
  for (const n of notas) l.push(`• ${escaparHtml(n)}`);
  // Se recorta el original, nunca la decisión.
  const cola = l.slice(1).join("\n");
  const espacio = LIMITE_TEXTO_TELEGRAM - cola.length - 1;
  return recortar(l[0], Math.max(espacio, 0)) + "\n" + cola;
}
