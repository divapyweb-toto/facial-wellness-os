// _shared/vendedor/ritmo.ts · Dueño: G1 (vendedor)
// Ritmo humano "sano": cuánto tarda en responder (tiempo de leer el mensaje del cliente + tiempo de escribir la
// respuesta, con variación aleatoria, entre un mínimo y un máximo; de noche un poco más lento) y cómo partir un
// mensaje largo en 2 burbujas como haría una persona. Los parámetros viven en config_wa.vendedor_ritmo
// (supabase/seed_vendedor.sql); acá solo están los valores por defecto si falta la clave.
// Puro: el azar y la hora entran por parámetro.
import { partesAsuncion } from "../horario.ts";

export type CfgRitmo = {
  /** Tiempo fijo de "abrir el chat y leer" (ms). */
  leer_base_ms: number;
  /** Tiempo de lectura por cada carácter del cliente (ms). */
  leer_ms_por_caracter: number;
  /** Tope del tiempo de lectura (un mensaje larguísimo no se lee en 2 minutos). */
  leer_max_ms: number;
  /** Tiempo fijo de "empezar a escribir" (ms). */
  escribir_base_ms: number;
  /** Tiempo de escritura por cada carácter de la respuesta (ms). */
  escribir_ms_por_caracter: number;
  /** Variación aleatoria: ±fracción del total (0,2 = ±20 %). */
  variacion: number;
  min_s: number;
  max_s: number;
  /** De noche (Asunción) se multiplica la demora y se usa este máximo. */
  noche_desde_hora: number;
  noche_hasta_hora: number;
  factor_noche: number;
  max_noche_s: number;
  /** Respuestas más largas que esto (caracteres) se parten en 2 burbujas. */
  partir_desde_caracteres: number;
  /** Pausa antes de la segunda burbuja (se calcula con el tiempo de escribir y se acota a este rango). */
  pausa_burbuja_min_s: number;
  pausa_burbuja_max_s: number;
  /** El indicador "escribiendo…" de WhatsApp dura ~25 s: se renueva cada tanto en demoras largas. */
  renovar_escribiendo_s: number;
};

export const RITMO_DEFAULT: CfgRitmo = {
  leer_base_ms: 1500,
  leer_ms_por_caracter: 35,
  leer_max_ms: 8000,
  escribir_base_ms: 1500,
  escribir_ms_por_caracter: 55,
  variacion: 0.2,
  min_s: 4,
  max_s: 25,
  noche_desde_hora: 0,
  noche_hasta_hora: 7,
  factor_noche: 1.3,
  max_noche_s: 32,
  partir_desde_caracteres: 90,
  pausa_burbuja_min_s: 1.5,
  pausa_burbuja_max_s: 7,
  renovar_escribiendo_s: 20,
};

const acotar = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function esNoche(ahora: Date, r: CfgRitmo): boolean {
  const h = partesAsuncion(ahora).hora;
  return r.noche_desde_hora <= r.noche_hasta_hora
    ? h >= r.noche_desde_hora && h < r.noche_hasta_hora
    : h >= r.noche_desde_hora || h < r.noche_hasta_hora;
}

/** Variación simétrica: `azar` ∈ [0,1) → factor ∈ [1−v, 1+v). */
function variar(ms: number, v: number, azar: number): number {
  return ms * (1 - v + 2 * v * acotar(azar, 0, 1));
}

/**
 * Demora total antes de mandar la primera burbuja (ms): leer + escribir, ± variación, acotada a [min, max]
 * (de noche, × factor y acotada a [min, max_noche]). Al resultado el orquestador le descuenta lo que ya pasó
 * (espera de agrupación + lo que tardó el modelo).
 */
export function calcularDemoraMs(p: { textoCliente: string; textoRespuesta: string; ahora: Date; ritmo: CfgRitmo; azar: number }): number {
  const r = p.ritmo;
  const leer = Math.min(r.leer_max_ms, r.leer_base_ms + (p.textoCliente?.length ?? 0) * r.leer_ms_por_caracter);
  const escribir = r.escribir_base_ms + (p.textoRespuesta?.length ?? 0) * r.escribir_ms_por_caracter;
  let ms = variar(leer + escribir, r.variacion, p.azar);
  let max = r.max_s;
  if (esNoche(p.ahora, r)) {
    ms *= r.factor_noche;
    max = r.max_noche_s;
  }
  return Math.round(acotar(ms, r.min_s * 1000, max * 1000));
}

/** Pausa antes de la segunda burbuja: el tiempo de escribirla, ± variación, acotado. */
export function pausaBurbujaMs(texto: string, ritmo: CfgRitmo, azar: number): number {
  const ms = variar(texto.length * ritmo.escribir_ms_por_caracter, ritmo.variacion, azar);
  return Math.round(acotar(ms, ritmo.pausa_burbuja_min_s * 1000, ritmo.pausa_burbuja_max_s * 1000));
}

/**
 * Parte una respuesta en 1 o 2 burbujas como haría una persona: si es corta va entera; si es larga, la última
 * línea (normalmente la pregunta) va sola. Una sola línea larga se corta en la última oración. Nunca más de 2.
 */
export function partirEnBurbujas(texto: string, desde: number): string[] {
  const t = (texto ?? "").trim();
  if (!t) return [];
  if (t.length <= desde) return [t];
  const lineas = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lineas.length >= 2) return [lineas.slice(0, -1).join("\n"), lineas[lineas.length - 1]];
  // Una línea: corte en el último fin de oración que deje dos partes con contenido.
  const cortes = [...t.matchAll(/[.!?…]\s+(?=[¿¡A-ZÁÉÍÓÚÑ0-9])/gu)].map((m) => m.index! + m[0].length);
  const corte = cortes.reverse().find((i) => i >= 15 && t.length - i >= 8);
  if (corte === undefined) return [t];
  return [t.slice(0, corte).trim(), t.slice(corte).trim()];
}
