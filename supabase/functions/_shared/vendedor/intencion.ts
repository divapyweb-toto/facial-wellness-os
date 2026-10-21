// _shared/vendedor/intencion.ts · 21-10-2026 (v38, Enrique) · Dueño: G1 (vendedor)
// "Quiero", "lo quiero", "quiero 1", "me interesa", "cómo hago", "mandame", "pido"… ESCRITOS valen lo mismo que tocar el
// botón "Quiero 1": el vendedor pasa directo a pedir nombre, ciudad y calle o barrio, con el precio en una línea. El
// 21-10 un cliente escribió "Quiero" apenas abrió el chat y el bot le mandó el gancho y el precio como si nada; se fue.
// Solo mensajes que son ENTEROS una señal de compra: "quiero saber el precio", "me interesa, ¿cuánto sale?" o
// "quiero que me llegue hoy" no cuentan (los resuelve el modelo). El texto precargado del anuncio ("¡Hola! Quiero más
// información", "Hola, quiero la botella flexible") tampoco: en el primer mensaje del chat no se aceptan nombres de
// producto ni saludos con "información".
// Puro: sin I/O.
import { cuerpoPrimerTurno, gs, type ItemCatalogo } from "./herramientas.ts";

export type IntencionEscrita = {
  /** El mensaje del cliente que la disparó (limpio, para la nota interna). */
  frase: string;
  /** Cantidad si la dijo ("quiero 2", "mandame dos"); null = no dijo. */
  cantidad: number | null;
};

function limpiar(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[!.,;:¡¿?…"'()]+/g, " ").replace(/\s+/g, " ").trim();
}

const SALUDO = String.raw`(?:hola+|holis|buenas|buen dia|buenos dias|buenas tardes|buenas noches|ok|okey|dale|si|sii+|bueno|listo|perfecto|genial|ya|entonces|che|ah)`;
const VERBO = String.raw`(?:(?:yo )?(?:si )?(?:lo |la |los |las )?(?:quiero|quisiera|kiero|qiero|quero)(?: (?:pedir|comprar|encargar|pedirlo|pedirla|comprarlo|comprarla|llevar|llevarlo))?|me interesa|me interesan|como hago(?: para (?:pedir|comprar|pedirlo|comprarlo|encargar))?|como (?:lo )?pido|como (?:lo )?compro|mandame(?:lo|la|los|las)?|mandamelo|enviame(?:lo|la)?|(?:lo |te )?pido|me (?:lo |la )?llevo|lo compro|lo encargo)`;
const CANT = String.raw`(?:un|uno|una|1|2|dos|3|tres|4|cuatro|5|cinco)`;
const RELLENO = String.raw`(?:unidad|unidades|nomas|por favor|porfa|porfavor|pls|si|ya|ahora|de una|eso|ese|esa|esos|esas|el|la|los|las|de|del|pack|combo|oferta|promo|con|envio|gratis|entonces|che|nde|amigo|amiga|hermano|para|mi|casa|manana|hoy|y|o|pero|bueno|dale)`;
const PRODUCTO = String.raw`(?:raspador|raspadores|lengua|tiras?|nasal|nasales|parches?|bucal|bucales|botella|botellas|flexible|ejercitador|ejercitadores|mandibula|jawflex|jaw|flex)`;

const RE_SIN_PRODUCTO = new RegExp(`^(?:${SALUDO} )*${VERBO}(?: (?:${CANT}|${RELLENO}))*$`);
const RE_CON_PRODUCTO = new RegExp(`^(?:${SALUDO} )*${VERBO}(?: (?:${CANT}|${RELLENO}|${PRODUCTO}))*$`);

/** Marcas del sistema ("[vino del anuncio…]", "[el anuncio decía…]", "[botón] …", "[ubicación] …") fuera. */
function sinMarcas(t: string): string {
  return String(t ?? "").split("\n").filter((l) => !/^\s*\[/.test(l)).join(" ").trim();
}

function cantidadDe(t: string): number | null {
  const m = /\b(1|un|uno|una|2|dos|3|tres|4|cuatro|5|cinco)\b/.exec(t);
  if (!m) return null;
  const n = ({ un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 } as Record<string, number>)[m[1]] ?? Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/** Un mensaje suelto es una señal de compra escrita. `conProducto`: acepta nombres de producto ("quiero las tiras"). */
export function esIntencionEscrita(texto: string, conProducto = true): IntencionEscrita | null {
  const t = limpiar(sinMarcas(texto));
  if (!t || t.length > 70) return null;
  if (!(conProducto ? RE_CON_PRODUCTO : RE_SIN_PRODUCTO).test(t)) return null;
  return { frase: t, cantidad: cantidadDe(t) };
}

/**
 * Señal de compra escrita en los mensajes pendientes del cliente (bloquePendiente, en orden). `hayNuestrosAntes`: ya le
 * habíamos escrito en este chat. Sin eso, el primer mensaje es el precargado del anuncio o el saludo: ahí no se aceptan
 * nombres de producto. Devuelve la última señal (si dijo "quiero" y después "2", gana la que tenga cantidad).
 */
export function intencionEnBloque(bloque: string[], hayNuestrosAntes: boolean): IntencionEscrita | null {
  let mejor: IntencionEscrita | null = null;
  bloque.forEach((texto, i) => {
    if (/^\s*\[bot[oó]n\]/i.test(texto)) return; // un toque de botón ya lo entiende el prompt
    const r = esIntencionEscrita(texto, hayNuestrosAntes || i > 0);
    if (r && (!mejor || r.cantidad != null || mejor.cantidad == null)) mejor = r;
  });
  return mejor;
}

/** Nuestro último mensaje ya pidió los datos: no se repite el pedido (regla del prompt). */
export function yaPidioDatos(textoNuestro: string | null | undefined): boolean {
  const t = limpiar(textoNuestro ?? "");
  return /pasame tu nombre|tu nombre (?:tu )?ciudad|nombre (?:tu )?ciudad y|solo me falta tu|me falta tu (?:ciudad|calle|barrio|nombre)/.test(t);
}

/** Línea de precio según la cantidad (montos del catálogo, nunca del modelo). */
export function lineaPrecioIntencion(prod: ItemCatalogo, cantidad: number | null): string {
  const oferta = cantidad && cantidad > 1 ? prod.ofertas.find((o) => o.cantidad === cantidad) : undefined;
  if (oferta) {
    const gratis = oferta.total <= cantidad! * prod.precio;
    return `Los ${cantidad} te salen ${gs(oferta.total)}${gratis ? " con envío gratis" : " en total"}, pagás al recibir.`;
  }
  return cuerpoPrimerTurno(prod);
}

/** Nota interna para el modelo (no la ve el cliente). */
export function notaIntencion(i: IntencionEscrita, prod: ItemCatalogo | null): string {
  const cant = i.cantidad ?? 1;
  const base = `[CONTROL INTERNO, no lo ve el cliente] El cliente ESCRIBIÓ que lo quiere ("${i.frase}"): es lo mismo que tocar ` +
    `"Quiero ${cant}". NO llames primer_turno, no mandes video ni foto y no vuelvas a explicar el producto. `;
  if (!prod) {
    return base + `Anotá la cantidad con registrar_perfil y en UN solo mensaje de texto pedí los datos: "Genial! Pasame tu nombre, tu ciudad ` +
      `y la calle o barrio 🙌 El repartidor te llama antes de ir. Pagás al recibir." Si no sabés qué producto quiere, preguntalo en ese mismo mensaje.`;
  }
  return base + `Anotá producto (${prod.titulo}) y cantidad (${cant}) con registrar_perfil y respondé en UN solo mensaje de texto: ` +
    `"Genial! Pasame tu nombre, tu ciudad y la calle o barrio 🙌 El repartidor te llama antes de ir." y abajo, en UNA línea, el precio tal cual: ` +
    `"${lineaPrecioIntencion(prod, i.cantidad)}" Si además preguntó algo, respondelo corto en el mismo mensaje.`;
}
