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
/** 12-10: límite de la leyenda de sendPhoto / sendDocument / editMessageCaption: 1024 caracteres. */
export const LIMITE_LEYENDA_TELEGRAM = 1024;
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

/** Etiquetas que acepta el modo HTML de la Bot API (las que hay que cerrar si el corte las deja abiertas). */
const ETIQUETAS_TELEGRAM = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "span", "tg-spoiler", "tg-emoji", "blockquote",
]);

/** Etiquetas que quedan abiertas al final de `html`, en orden de apertura. */
export function etiquetasAbiertas(html: string): string[] {
  const pila: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^<>]*>/g)) {
    const nombre = m[2].toLowerCase();
    if (!ETIQUETAS_TELEGRAM.has(nombre)) continue;
    if (!m[1]) pila.push(nombre);
    else {
      const i = pila.lastIndexOf(nombre);
      if (i >= 0) pila.splice(i, 1);
    }
  }
  return pila;
}

/**
 * Corta `texto` en `n` caracteres sin dejar basura: prefiere el último salto de línea (si no pierde
 * más de la mitad), y saca una etiqueta a medio escribir ("<a href=..."), una entidad partida ("&am")
 * y medio emoji (par sustituto).
 */
function cortarSeguro(texto: string, n: number): string {
  let s = texto.slice(0, Math.max(0, n));
  const salto = s.lastIndexOf("\n");
  if (salto >= n / 2) s = s.slice(0, salto);
  const menor = s.lastIndexOf("<");
  if (menor > s.lastIndexOf(">") && /^<\/?([a-zA-Z][^<>]*)?$/.test(s.slice(menor))) s = s.slice(0, menor);
  s = s.replace(/&[#a-zA-Z0-9]{0,10}$/, "");
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  return s;
}

/**
 * Recorta sin pasarse del límite de Telegram, avisando que se cortó.
 * 23-10: a prueba de HTML. Antes cortaba a ciegas y dejaba un <i> sin cerrar: Telegram rechazaba el
 * aviso entero ("can't parse entities") y la auditoría del 22-10 nunca llegó.
 */
export function recortar(texto: string, limite = LIMITE_TEXTO_TELEGRAM): string {
  if (texto.length <= limite) return texto;
  const cola = "\n…(recortado)";
  let n = limite - cola.length;
  while (n > 0) {
    const cuerpo = cortarSeguro(texto, n);
    const cierres = etiquetasAbiertas(cuerpo).reverse().map((t) => `</${t}>`).join("");
    const salida = cuerpo + cierres + cola;
    if (salida.length <= limite) return salida;
    n -= salida.length - limite;
  }
  return cola.slice(1, limite + 1);
}

/** HTML de Telegram → texto plano (para reintentar un aviso sin parse_mode). */
export function htmlATextoPlano(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => `${txt} (${href})`)
    .replace(/<\/?[a-zA-Z][\w-]*[^<>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Parte un aviso largo en varios mensajes que entran en el límite, cortando solo entre líneas y, si
 * se puede, antes de una línea que empieza con "• " (un caso no queda partido en dos mensajes).
 * Cada línea del aviso tiene que traer sus etiquetas cerradas. Una línea más larga que el límite se recorta.
 */
export function partirAviso(texto: string, limite = LIMITE_TEXTO_TELEGRAM): string[] {
  if (texto.length <= limite) return [texto];
  const reserva = 20; // para el "(sigue 2/3)" de arriba
  const max = limite - reserva;
  const bloques: string[] = [];
  for (const linea of texto.split("\n")) {
    if (bloques.length && !linea.startsWith("• ")) bloques[bloques.length - 1] += "\n" + linea;
    else bloques.push(linea);
  }
  const partes: string[] = [];
  let actual = "";
  const meter = (b: string) => {
    if (!actual) actual = b;
    else if (actual.length + 1 + b.length <= max) actual += "\n" + b;
    else {
      partes.push(actual);
      actual = b;
    }
  };
  for (const b of bloques) {
    if (b.length <= max) meter(b);
    else for (const l of b.split("\n")) meter(recortar(l, max));
  }
  if (actual) partes.push(actual);
  return partes.length === 1 ? partes : partes.map((p, i) => (i === 0 ? p : `<i>(sigue ${i + 1}/${partes.length})</i>\n${p}`));
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

// 26-10 (administrador): JawFlex ×3 = el kit de los 3 niveles. Misma regla que src/lib/armado.js (Despacho y guías).
export const NOTA_ARMADO_JAWFLEX = "ARMAR: 1 suave + 1 medio + 1 duro";
export function notaArmado(titulo: string, cantidad: number): string {
  return /jaw|mand[ií]bula|ejercitador/i.test(titulo) && cantidad === 3 ? NOTA_ARMADO_JAWFLEX : "";
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
  if (p.productos?.some((x) => notaArmado(x.replace(/\s*x\d+\s*$/, ""), Number(/x(\d+)\s*$/.exec(x)?.[1] ?? 1)))) {
    l.push(`<b>${NOTA_ARMADO_JAWFLEX}</b>`);
  }
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
export function textoConDecision(
  textoOriginal: string,
  decision: string,
  notas: string[],
  cuando: Date,
  limite = LIMITE_TEXTO_TELEGRAM, // 12-10: LIMITE_LEYENDA_TELEGRAM para un aviso con foto o documento
): string {
  const l = [escaparHtml(textoOriginal), "", `<b>Decisión (${horaCortaAsuncion(cuando)}):</b> ${escaparHtml(decision)}`];
  for (const n of notas) l.push(`• ${escaparHtml(n)}`);
  // Se recorta el original, nunca la decisión (salvo que la decisión sola ya no entre en el límite).
  const cola = l.slice(1).join("\n");
  const espacio = limite - cola.length - 1;
  const original = espacio >= 20 ? recortar(l[0], espacio) : "";
  return recortar(original + "\n" + cola, limite);
}
