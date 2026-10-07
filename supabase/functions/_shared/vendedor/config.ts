// _shared/vendedor/config.ts · Dueño: G1 (ola 2)
// Arma la configuración de un turno a partir de las filas de config_wa (semilla: supabase/seed_vendedor.sql).
// Puro: si falta una clave usa el default del código y lo deja anotado en `faltantes` (el I/O lo loguea).
import { PROMESAS_SALUD_DEFAULT } from "./filtro_salida.ts";
import type { EntradaGlosario } from "./prompt.ts";
import { CFG_VENDEDOR_DEFAULT, type CfgVendedor, type ConfigTurno } from "./tipos.ts";

export const CLAVES_CONFIG_VENDEDOR = [
  "vendedor",
  "vendedor_envio",
  "vendedor_glosario",
  "vendedor_fichas",
  "vendedor_afirmaciones",
  "vendedor_promesas_salud",
  "vendedor_ofertas",
  "vendedor_media",
  "vendedor_textos",
  "vendedor_prompt",
  "aceptaciones",
  "palabras_prohibidas",
] as const;

export const ACEPTACIONES_DEFAULT = ["si", "sí", "ok", "okay", "dale", "ya", "katu", "mandame katu", "si luego", "confirmo"];
export const PROHIBIDAS_DEFAULT = ["garantía", "devolución", "reembolso", "sin riesgo", "cura", "curar", "tratamiento", "oxígeno"];
/** Envío por defecto (mismo valor que la semilla). [VERIFICAR] contra la tarifa vigente de los couriers. */
export const ENVIO_DEFAULT = { costo_gs: 33000, plazo: "2 a 5 días hábiles; interior, hasta 10" };

const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const listaStrings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : null;

export function armarConfigTurno(filas: Record<string, unknown>): { cfg: ConfigTurno; faltantes: string[] } {
  const faltantes: string[] = [];
  const tomar = <T>(clave: string, validar: (v: unknown) => T | null, porDefecto: T): T => {
    const v = filas[clave];
    const ok = v === undefined || v === null ? null : validar(v);
    if (ok === null) {
      faltantes.push(clave);
      return porDefecto;
    }
    return ok;
  };

  const vendedor = tomar<CfgVendedor>(
    "vendedor",
    (v) => (esObj(v) ? { ...CFG_VENDEDOR_DEFAULT, ...(v as Partial<CfgVendedor>) } : null),
    { ...CFG_VENDEDOR_DEFAULT },
  );
  const envio = tomar("vendedor_envio", (v) => {
    if (!esObj(v) || typeof v.costo_gs !== "number") return null;
    return { costo_gs: v.costo_gs, plazo: typeof v.plazo === "string" ? v.plazo : ENVIO_DEFAULT.plazo, ...(typeof v.texto === "string" ? { texto: v.texto } : {}) };
  }, { ...ENVIO_DEFAULT });
  const glosario = tomar<EntradaGlosario[]>("vendedor_glosario", (v) =>
    Array.isArray(v)
      ? v.filter(esObj).map((x) => ({ escribe: String(x.escribe ?? ""), significa: String(x.significa ?? ""), accion: String(x.accion ?? "") }))
        .filter((x) => x.escribe)
      : null, []);
  const fichas = tomar("vendedor_fichas", (v) => (esObj(v) ? v as ConfigTurno["fichas"] : null), {});
  const afirmaciones = tomar("vendedor_afirmaciones", listaStrings, []);
  const promesasSalud = tomar("vendedor_promesas_salud", listaStrings, PROMESAS_SALUD_DEFAULT);
  const ofertas = tomar("vendedor_ofertas", (v) => (esObj(v) ? v as ConfigTurno["ofertas"] : null), {});
  const media = tomar("vendedor_media", (v) => (esObj(v) ? v as ConfigTurno["media"] : null), {});
  const textos = tomar("vendedor_textos", (v) => (esObj(v) ? v as Record<string, string> : null), {});
  const aceptaciones = tomar("aceptaciones", listaStrings, ACEPTACIONES_DEFAULT);
  const prohibidas = tomar("palabras_prohibidas", (v) => listaStrings(v) ?? (esObj(v) ? listaStrings(v.lista) : null), PROHIBIDAS_DEFAULT);
  const p = filas["vendedor_prompt"];
  const plantillaPrompt = typeof p === "string" && p.trim() ? p : null; // opcional: no cuenta como faltante

  return {
    cfg: { vendedor, envio, glosario, fichas, afirmaciones, aceptaciones, prohibidas, promesasSalud, ofertas, media, textos, plantillaPrompt },
    faltantes: faltantes.filter((k) => k !== "vendedor_prompt"),
  };
}
