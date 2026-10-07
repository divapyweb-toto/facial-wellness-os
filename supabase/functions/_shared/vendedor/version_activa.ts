// _shared/vendedor/version_activa.ts · Integración (06-10-2026)
// El vendedor usa la versión ACTIVA de public.vendedor_versiones (la que aplica el ciclo mensual de mejora
// desde Telegram) como plantilla del prompt: prompt + orden de objeciones + FAQ + ejemplos. Si no hay
// versión activa, la tabla no existe todavía o la versión no trae las llaves del prompt, se usa la
// plantilla del archivo (prompt.ts = supabase/vendedor/prompt_sistema.md).
// Precedencia: versión activa > config_wa.vendedor_prompt > prompt del archivo.
// La versión se lee con caché en memoria de 5 minutos (no se consulta la base en cada mensaje).
import { LLAVES_PROMPT } from "./prompt.ts";

export type EjemploVersion = { cliente: string; vendedor: string };
export type FaqVersion = { pregunta: string; respuesta: string };
export type ContenidoVersion = { prompt: string; ejemplos: EjemploVersion[]; faq: FaqVersion[]; objeciones: string[] };
/** Fila de vendedor_versiones tal como viene de la base (jsonb sin tipar). */
export type FilaVersion = { numero?: number | null; prompt?: unknown; ejemplos?: unknown; faq?: unknown; objeciones?: unknown };

export const TTL_VERSION_MS = 5 * 60_000;
/** Tras un error de lectura se reintenta antes (sin martillar la base en cada mensaje). */
export const TTL_ERROR_MS = 60_000;

const sinLlaves = (s: string) => s.replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"));
const texto = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

/**
 * Plantilla completa de una versión: prompt + ejemplos + FAQ + orden de objeciones. Las llaves del prompt
 * ({glosario}, {fichas_de_producto}, …) quedan para armarPrompt; en los agregados se neutralizan las llaves.
 * Es la misma que usa mejora-mensual (proponer.ts → armarPromptVersion) para la batería.
 */
export function armarPlantillaVersion(v: ContenidoVersion): string {
  const partes = [v.prompt.trimEnd()];
  if (v.objeciones.length) {
    partes.push(`ORDEN DE OBJECIONES (las más frecuentes primero): ${v.objeciones.map(sinLlaves).join(" > ")}.`);
  }
  if (v.faq.length) {
    partes.push(
      "PREGUNTAS FRECUENTES (respuestas modelo; los montos siempre de consultar_catalogo):\n" +
        v.faq.map((f) => `- "${sinLlaves(f.pregunta)}" → "${sinLlaves(f.respuesta)}"`).join("\n"),
    );
  }
  if (v.ejemplos.length) {
    partes.push(
      "EJEMPLOS DE ESTILO (no los copies textual; los montos siempre de consultar_catalogo):\n" +
        v.ejemplos.map((e) => `Cliente: "${sinLlaves(e.cliente)}"\nVos: "${sinLlaves(e.vendedor)}"`).join("\n"),
    );
  }
  return partes.join("\n\n") + "\n";
}

/** jsonb de la base → contenido tipado (descarta entradas mal formadas). null si no hay prompt. */
export function normalizarFilaVersion(f: FilaVersion | null | undefined): ContenidoVersion | null {
  if (!f || !texto(f.prompt)) return null;
  const lista = (x: unknown): Record<string, unknown>[] =>
    Array.isArray(x) ? x.filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e)) : [];
  return {
    prompt: f.prompt,
    ejemplos: lista(f.ejemplos).filter((e) => texto(e.cliente) && texto(e.vendedor))
      .map((e) => ({ cliente: e.cliente as string, vendedor: e.vendedor as string })),
    faq: lista(f.faq).filter((e) => texto(e.pregunta) && texto(e.respuesta))
      .map((e) => ({ pregunta: e.pregunta as string, respuesta: e.respuesta as string })),
    objeciones: Array.isArray(f.objeciones) ? f.objeciones.filter(texto) : [],
  };
}

/** Plantilla lista para config_wa.vendedor_prompt, o null (con motivo) si hay que usar la del archivo. */
export function plantillaDeVersion(f: FilaVersion | null | undefined): { plantilla: string | null; motivo: string | null } {
  const v = normalizarFilaVersion(f);
  if (!v) return { plantilla: null, motivo: f ? "versión activa sin prompt" : null };
  const faltan = LLAVES_PROMPT.filter((k) => !v.prompt.includes(`{${k}}`));
  if (faltan.length) return { plantilla: null, motivo: `versión ${f?.numero ?? "?"} sin las llaves ${faltan.join(", ")}` };
  return { plantilla: armarPlantillaVersion(v), motivo: null };
}

export type CacheVersion = { obtener(): Promise<string | null>; limpiar(): void };

/**
 * Caché en memoria de la plantilla de la versión activa. `cargar` lee la fila (null = no hay activa);
 * si falla, se usa el prompt del archivo y se reintenta a los TTL_ERROR_MS.
 */
export function crearCacheVersion(
  cargar: () => Promise<FilaVersion | null>,
  o: { ttlMs?: number; ahora?: () => number; log?: (m: string) => void } = {},
): CacheVersion {
  const ttl = o.ttlMs ?? TTL_VERSION_MS;
  const ahora = o.ahora ?? Date.now;
  const log = o.log ?? ((m: string) => console.warn(m));
  let cache: { plantilla: string | null; hasta: number } | null = null;
  return {
    async obtener() {
      if (cache && cache.hasta > ahora()) return cache.plantilla;
      try {
        const { plantilla, motivo } = plantillaDeVersion(await cargar());
        if (motivo) log(`vendedor: ${motivo}; uso el prompt del archivo`);
        cache = { plantilla, hasta: ahora() + ttl };
      } catch (e) {
        log(`vendedor: no pude leer vendedor_versiones (${e instanceof Error ? e.message : e}); uso el prompt del archivo`);
        cache = { plantilla: null, hasta: ahora() + Math.min(TTL_ERROR_MS, ttl) };
      }
      return cache.plantilla;
    },
    limpiar() {
      cache = null;
    },
  };
}
