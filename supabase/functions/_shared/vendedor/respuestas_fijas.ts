// _shared/vendedor/respuestas_fijas.ts · Dueño: G1 (vendedor)
// Mensajes que NO necesitan al modelo (ahorro): un sticker o emoji suelto al empezar, un "gracias" suelto, o un
// "ok" / "dale" / sticker después de que el pedido ya quedó creado. Se responde con un texto corto y humano de
// config_wa.vendedor_respuestas_fijas (varias variantes por tipo, se elige una al azar y nunca la misma que el
// último mensaje). Si hay un resumen de pedido esperando el sí, nada de esto aplica: lo resuelve el modelo.
// Puro: sin I/O.

export type TipoFija = "sticker_inicio" | "gracias" | "post_pedido";

/** {tipo: [variantes]} */
export type CfgRespuestasFijas = Record<string, string[]>;

export const RESPUESTAS_FIJAS_DEFAULT: CfgRespuestasFijas = {
  sticker_inicio: [
    "Jaja buenísimo. ¿Lo buscás para dormir mejor o para el aliento?",
    "Jaja. Contame, ¿es para dormir mejor, para el aliento o para entrenar?",
  ],
  gracias: [
    "De nada. Cualquier cosa me escribís por acá.",
    "A vos. Cualquier duda, por acá estoy.",
  ],
  post_pedido: [
    "Perfecto. Cualquier novedad de tu pedido te escribimos por acá.",
    "Buenísimo. Te avisamos por acá cuando salga.",
  ],
};

function normalizar(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** Solo emojis, símbolos o un sticker sin texto. */
export function esStickerOEmoji(texto: string): boolean {
  const t = (texto ?? "").trim();
  if (!t) return false;
  if (/^\[sticker\]$/i.test(t)) return true;
  const sinEmojis = t.replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\s]/gu, "");
  return sinEmojis === "" && /\p{Extended_Pictographic}/u.test(t);
}

const RE_GRACIAS = /^(?:(?:muchas|mil|muchisimas) )?(?:gracias+|grax|grs|graciass+|thanks)(?: (?:che|nde|amigo|amiga|genio|crack|igual|nomas|eh|por todo|por la info|por la informacion))*$/u;
const RE_OK = /^(?:ok+|oki|okey|okay|dale|listo|perfecto|genial|buenisimo|joya|barbaro|de una|ya|si|sii+|bueno|bien|excelente|ok gracias|dale gracias|listo gracias|perfecto gracias|ya gracias)$/u;

function limpiar(texto: string): string {
  return normalizar(texto).replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[!.,¡¿?…]+/g, " ").replace(/\s+/g, " ").trim();
}

export function esGraciasSuelto(texto: string): boolean {
  return RE_GRACIAS.test(limpiar(texto));
}

export function esOkSuelto(texto: string): boolean {
  return RE_OK.test(limpiar(texto)) || esGraciasSuelto(texto);
}

export type EstadoParaFija = {
  /** El vendedor (o Voltra) ya le escribió antes en esta conversación. */
  hayMensajesNuestros: boolean;
  /** Último pedido del chat: null si no hubo. */
  estadoPedidoChat: "resumen" | "creado" | "fallido" | "cancelado" | null;
};

/** Qué respuesta fija corresponde (o null = hay que llamar al modelo). */
export function tipoRespuestaFija(texto: string, e: EstadoParaFija): TipoFija | null {
  if (e.estadoPedidoChat === "resumen") return null; // un "ok" puede ser el sí al resumen: lo ve el modelo
  const sticker = esStickerOEmoji(texto);
  if (e.estadoPedidoChat === "creado") {
    if (esGraciasSuelto(texto)) return "gracias";
    if (sticker || esOkSuelto(texto)) return "post_pedido";
    return null;
  }
  if (sticker && !e.hayMensajesNuestros) return "sticker_inicio";
  if (esGraciasSuelto(texto)) return "gracias";
  return null;
}

/**
 * Elige una variante al azar, distinta del último mensaje que mandamos. Si todas las variantes son iguales al
 * último mensaje, devuelve null (una persona no manda dos veces el mismo "de nada": mejor no responder).
 */
export function elegirVariante(tipo: TipoFija, cfg: CfgRespuestasFijas, ultimoNuestro: string | null, azar: number): string | null {
  const lista = (cfg[tipo]?.length ? cfg[tipo] : RESPUESTAS_FIJAS_DEFAULT[tipo]).filter((x) => typeof x === "string" && x.trim());
  const ultimo = normalizar(ultimoNuestro ?? "");
  const candidatas = lista.filter((x) => normalizar(x) !== ultimo);
  if (!candidatas.length) return null;
  // Tampoco se repite el mismo tipo seguido ("De nada" → "A vos" queda raro): si el último ya fue de este tipo, silencio.
  if (lista.some((x) => normalizar(x) === ultimo)) return null;
  return candidatas[Math.min(candidatas.length - 1, Math.floor(Math.max(0, azar) * candidatas.length))];
}
