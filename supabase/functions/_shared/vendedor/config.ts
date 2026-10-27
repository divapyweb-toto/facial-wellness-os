// _shared/vendedor/config.ts · Dueño: G1 (ola 2)
// Arma la configuración de un turno a partir de las filas de config_wa (semilla: supabase/seed_vendedor.sql).
// Puro: si falta una clave usa el default del código y lo deja anotado en `faltantes` (el I/O lo loguea).
import { MULETILLAS_DEFAULT, NIEGA_IA_DEFAULT, PROMESAS_SALUD_DEFAULT, URGENCIA_DEFAULT } from "./filtro_salida.ts";
import type { EntradaGlosario } from "./prompt.ts";
import { type CfgRespuestasFijas, RESPUESTAS_FIJAS_DEFAULT } from "./respuestas_fijas.ts";
import { type CfgRitmo, RITMO_DEFAULT } from "./ritmo.ts";
import { CFG_VENDEDOR_DEFAULT, type CfgEstilo, type CfgVendedor, type ConfigTurno } from "./tipos.ts";

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
  "vendedor_ritmo",
  "vendedor_respuestas_fijas",
  "vendedor_estilo",
  "aceptaciones",
  "palabras_prohibidas",
  "pago_anticipado",
  "vendedor_retiro",
] as const;

export const ACEPTACIONES_DEFAULT = ["si", "sí", "ok", "okay", "dale", "ya", "katu", "mandame katu", "si luego", "confirmo"];
export const PROHIBIDAS_DEFAULT = ["garantía", "devolución", "reembolso", "sin riesgo", "cura", "curar", "tratamiento", "oxígeno"];
/** Envío por defecto (mismo valor que la semilla). [VERIFICAR] contra la tarifa vigente de los couriers. */
export const ENVIO_DEFAULT = { costo_gs: 33000, plazo: "2 a 5 días hábiles; interior, hasta 10" };

const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const listaStrings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : null;

/**
 * 19-10 (paquete 1): campos nuevos de config_wa.vendedor. Viven en la misma fila (el spread de `vendedor` los
 * conserva) pero se leen acá con su default, sin tocar CfgVendedor (tipos.ts).
 * - modelo_tope: modelo más barato al pasar tope_mensual_usd (antes pasaba todo a "humano"). Haiku 4.5 porque ya
 *   está en config_wa.precios_claude (un modelo sin precio no suma al gasto y el tope dejaría de medir).
 * - tope_duro_usd: recién acá deriva como antes. Default tope × 1,3; nunca menos que el tope.
 * - alertas_tope_pct: Telegram a Enrique al cruzar cada % del tope (una vez por mes).
 * - espera_agrupar_datos_s: espera para juntar mensajes mientras el cliente manda datos (dirección en partes).
 */
export type CfgVendedorExtra = {
  modelo_tope: string;
  tope_duro_usd: number;
  alertas_tope_pct: number[];
  espera_agrupar_datos_s: number;
  /** 21-10 (Enrique, 19-10): 2 productos distintos por el precio de 2 iguales con envío gratis, solo WhatsApp. */
  oferta_2_distintos: boolean;
  /** 21-10 (v38): "quiero", "me interesa", "mandame"… escrito = tocar "Quiero 1" (intencion.ts). Apagar: false. */
  intencion_escrita: boolean;
  /**
   * 26-10: primer mensaje por producto (handle → ajuste). sin_oferta_2: sin botón ni frase de "2 con envío gratis"
   * (el 2 se vende solo si lo pide); texto: el gancho fijo en vez del que escribe el modelo; media: "foto" | "video" | "uso"
   * de vendedor_media, entre el texto y el precio. Vacío = como siempre. Interruptor: sacar el producto de la lista.
   */
  primer_turno_producto: Record<string, PrimerTurnoProducto>;
  /** 26-10: ofertas extra después de la compra (oferta_extra.ts). Cada una con su `activo`; vacío = ninguna. */
  ofertas_extra: Record<string, OfertaExtraCfg>;
  /**
   * 26-10 (ventas perdidas de SUEÑO): reglas de venta que el vendedor lee en cada turno (contexto, no prompt), para los
   * casos que se perdían: retiro hoy, "para el lunes", motobol/transferencia, queja del envío, "¿llega antes?".
   * config_wa.vendedor.reglas_venta = { activo, reglas: [texto…] }. Interruptor: activo = false. [] = apagado.
   */
  reglas_venta: string[];
};

export type PrimerTurnoProducto = {
  sin_oferta_2?: boolean; texto?: string; media?: "foto" | "video" | "uso";
  /** 26-10: una línea después del precio de 1; {total_2} / {total_3} = totales del catálogo (JawFlex: kit de 3 niveles). */
  linea_precio?: string;
  /** 26-10: nota para Despacho según la cantidad del producto en el pedido ({"3": "KIT 3 NIVELES…"}). */
  notas_cantidad?: Record<string, string>;
};

/** 26-10: una oferta extra post-compra. Los montos y textos viven en config_wa.vendedor.ofertas_extra (nunca la IA). */
export type OfertaExtraCfg = {
  activo: boolean;
  /** Regex (sin mayúsculas) sobre el handle de las líneas del pedido: se ofrece si alguna coincide. */
  si_lleva: string;
  /** Regex: NO se ofrece si alguna línea coincide (ya lleva el extra o un pack). */
  no_si_lleva: string;
  /** Handle del producto extra. */
  extra: string;
  precio: number;
  /** Se ofrece solo con MÁS de este stock del extra en Shopify. */
  stock_min: number;
  /** Etiqueta del pedido que suma el extra. */
  tag: string;
  /** Texto de la oferta; {precio} se reemplaza por el precio de config. */
  texto: string;
};

function primerTurnoDe(v: unknown): Record<string, PrimerTurnoProducto> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, PrimerTurnoProducto> = {};
  for (const [h, x] of Object.entries(v as Record<string, unknown>)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    out[h] = {
      ...(o.sin_oferta_2 === true ? { sin_oferta_2: true } : {}),
      ...(typeof o.texto === "string" && o.texto.trim() ? { texto: o.texto.trim() } : {}),
      ...(o.media === "foto" || o.media === "video" || o.media === "uso" ? { media: o.media } : {}),
      ...(typeof o.linea_precio === "string" && o.linea_precio.trim() ? { linea_precio: o.linea_precio.trim() } : {}),
      ...(o.notas_cantidad && typeof o.notas_cantidad === "object" && !Array.isArray(o.notas_cantidad)
        ? { notas_cantidad: Object.fromEntries(Object.entries(o.notas_cantidad as Record<string, unknown>).filter(([k, t]) => /^\d+$/.test(k) && typeof t === "string" && t.trim()).map(([k, t]) => [k, (t as string).trim()])) }
        : {}),
    };
  }
  return out;
}

function reglasVentaDe(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  if (o.activo !== true || !Array.isArray(o.reglas)) return [];
  return (o.reglas as unknown[]).filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim()).slice(0, 20);
}

function ofertasExtraDe(v: unknown): Record<string, OfertaExtraCfg> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, OfertaExtraCfg> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const precio = Number(o.precio), stock = Number(o.stock_min);
    const str = (c: string) => (typeof o[c] === "string" ? (o[c] as string).trim() : "");
    if (!str("si_lleva") || !str("extra") || !str("tag") || !str("texto") || !(precio > 0)) continue; // incompleta: no se usa
    try {
      new RegExp(str("si_lleva"));
      if (str("no_si_lleva")) new RegExp(str("no_si_lleva"));
    } catch {
      continue;
    }
    out[k] = {
      activo: o.activo === true, si_lleva: str("si_lleva"), no_si_lleva: str("no_si_lleva"), extra: str("extra"),
      precio: Math.round(precio), stock_min: Number.isFinite(stock) && stock >= 0 ? stock : 10, tag: str("tag"), texto: str("texto"),
    };
  }
  return out;
}

export const MODELO_TOPE_DEFAULT = "claude-haiku-4-5-20251001";

export function extrasVendedor(v: CfgVendedor): CfgVendedorExtra {
  const x = v as CfgVendedor & Record<string, unknown>;
  const num = (k: string): number | null => (typeof x[k] === "number" && Number.isFinite(x[k] as number) && (x[k] as number) >= 0 ? x[k] as number : null);
  const tope = Number(v.tope_mensual_usd) || 0;
  const duro = num("tope_duro_usd");
  const pct = Array.isArray(x.alertas_tope_pct)
    ? (x.alertas_tope_pct as unknown[]).filter((n): n is number => typeof n === "number" && n > 0 && n < 100)
    : null;
  return {
    modelo_tope: typeof x.modelo_tope === "string" && x.modelo_tope.trim() ? x.modelo_tope.trim() : MODELO_TOPE_DEFAULT,
    tope_duro_usd: Math.max(tope, duro ?? Math.round(tope * 1.3 * 100) / 100),
    alertas_tope_pct: pct ?? [70, 90],
    espera_agrupar_datos_s: num("espera_agrupar_datos_s") ?? 18,
    oferta_2_distintos: x.oferta_2_distintos === true,
    intencion_escrita: x.intencion_escrita !== false,
    primer_turno_producto: primerTurnoDe(x.primer_turno_producto),
    ofertas_extra: ofertasExtraDe(x.ofertas_extra),
    reglas_venta: reglasVentaDe(x.reglas_venta),
  };
}

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
  // 21-10: retiro en CDE. El teléfono de Enrique vive solo en la base (repo público).
  const retiro = tomar<string | null>("vendedor_retiro", (v) => (typeof v === "string" && v.trim() ? v.trim() : esObj(v) && typeof v.texto === "string" ? v.texto : null), null);
  const promesasSalud = tomar("vendedor_promesas_salud", listaStrings, PROMESAS_SALUD_DEFAULT);
  const ofertas = tomar("vendedor_ofertas", (v) => (esObj(v) ? v as ConfigTurno["ofertas"] : null), {});
  const media = tomar("vendedor_media", (v) => (esObj(v) ? v as ConfigTurno["media"] : null), {});
  const textos = tomar("vendedor_textos", (v) => (esObj(v) ? v as Record<string, string> : null), {});
  const aceptaciones = tomar("aceptaciones", listaStrings, ACEPTACIONES_DEFAULT);
  const prohibidas = tomar("palabras_prohibidas", (v) => listaStrings(v) ?? (esObj(v) ? listaStrings(v.lista) : null), PROHIBIDAS_DEFAULT);
  const ritmo = tomar<CfgRitmo>("vendedor_ritmo", (v) => {
    if (!esObj(v)) return null;
    const r: CfgRitmo = { ...RITMO_DEFAULT };
    for (const k of Object.keys(RITMO_DEFAULT) as (keyof CfgRitmo)[]) {
      const x = v[k];
      if (typeof x === "number" && Number.isFinite(x) && x >= 0) r[k] = x;
    }
    return r;
  }, { ...RITMO_DEFAULT });
  const respuestasFijas = tomar<CfgRespuestasFijas>("vendedor_respuestas_fijas", (v) => {
    if (!esObj(v)) return null;
    const r: CfgRespuestasFijas = { ...RESPUESTAS_FIJAS_DEFAULT };
    for (const [k, x] of Object.entries(v)) {
      const l = listaStrings(x) ?? (typeof x === "string" && x.trim() ? [x] : null);
      if (l?.length) r[k] = l;
    }
    return r;
  }, { ...RESPUESTAS_FIJAS_DEFAULT });
  const estilo = tomar<CfgEstilo>("vendedor_estilo", (v) =>
    esObj(v)
      ? {
        muletillas: listaStrings(v.muletillas) ?? MULETILLAS_DEFAULT,
        urgencia: listaStrings(v.urgencia) ?? URGENCIA_DEFAULT,
        niega_ia: listaStrings(v.niega_ia) ?? NIEGA_IA_DEFAULT,
      }
      : null, { muletillas: MULETILLAS_DEFAULT, urgencia: URGENCIA_DEFAULT, niega_ia: NIEGA_IA_DEFAULT });
  // Cuenta para transferencias (la misma que usa el pago anticipado). Opcional: no cuenta como faltante.
  const pa = filas["pago_anticipado"];
  const b = esObj(pa) && esObj(pa.banco) ? pa.banco : null;
  const transferencia = b && typeof b.cuenta === "string" && b.cuenta.trim()
    ? [
      [b.entidad, b.tipo, b.cuenta].filter((x) => typeof x === "string" && x.trim()).join(" · "),
      [b.titular, typeof b.ruc === "string" && b.ruc ? `RUC ${b.ruc}` : null].filter((x) => typeof x === "string" && x.trim()).join(" · "),
      ...(typeof b.alias === "string" && b.alias.trim() ? [`Alias: ${b.alias.trim()}`] : []),
    ].filter(Boolean).join("\n")
    : null;
  const p = filas["vendedor_prompt"];
  const plantillaPrompt = typeof p === "string" && p.trim() ? p : null; // opcional: no cuenta como faltante

  return {
    cfg: {
      vendedor, envio, glosario, fichas, retiro, afirmaciones, aceptaciones, prohibidas, promesasSalud, ofertas, media, textos, plantillaPrompt,
      ritmo, respuestasFijas, estilo, transferencia,
    },
    faltantes: faltantes.filter((k) => k !== "vendedor_prompt" && k !== "pago_anticipado"),
  };
}
