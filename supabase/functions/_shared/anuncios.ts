// _shared/anuncios.ts · Qué producto vio el cliente en el anuncio de Meta (click-to-WhatsApp).
// 07-10: 15 de 16 chats que entraron con "¡Hola! Quiero más información" recibieron "¿Qué producto viste?" y 9 se
// cortaron ahí. El webhook trae m.referral (source_id = id del anuncio, headline, body, source_url); el token del
// sistema no puede leer anuncios en la Graph API (sin ads_read), así que:
//   1) mapeo id → handle en config_wa.anuncios_producto (supabase/seed_anuncios.sql, lo arma scripts/mapear-anuncios.mjs);
//   2) si el id no está, se deduce por palabras clave del headline/body/source_url del referral.
// Puro: sin I/O y sin imports (lo usa también el script de Node).

/** Handles de Shopify de los productos que se publicitan → nombre legible para el vendedor. */
export const PRODUCTOS_ANUNCIO: Record<string, string> = {
  "tiras-nasales-gudair-30-unidades": "tiras nasales",
  "parches-bucales-gudair-30-unidades": "parches bucales",
  "pack-gudair-tiras-nasales-parches-bucales": "pack tiras nasales + parches bucales",
  "raspador-de-lengua-de-acero-inoxidable": "raspador de lengua",
  "botella-flexible-gudair-500-ml": "botella flexible",
  "ejercitador-de-mandibula-3-niveles": "ejercitador de mandíbula",
};

export type ReferralMeta = {
  source_id?: string;
  source_type?: string;
  source_url?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
  [k: string]: unknown;
};

export type ProductoAnuncio = { handle: string; nombre: string; fuente: "mapeo" | "palabras" };

const RE_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizar(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Producto por palabras clave (headline, body o URL del anuncio, o el nombre del anuncio en Meta).
 * El pack va primero: "PACK TIRAS + PARCHES" nombra los dos productos. null = no se reconoce ninguno.
 */
export function productoPorPalabras(texto: string): string | null {
  const t = normalizar(texto);
  if (!t.trim()) return null;
  // 19-10 (informe 02 §2b): "inhalador nasal" caía en tiras por la palabra "nasal". El inhalador todavía no se vende
  // por el bot (falta DINAVISA y precio): no se asigna a ningún producto.
  if (/inhalador/.test(t)) return null;
  const tiras = /\btiras?\b|nasal/.test(t);
  const parches = /parche|bucal/.test(t);
  if (/\bpack\b/.test(t) || (tiras && parches)) return "pack-gudair-tiras-nasales-parches-bucales";
  if (/ejercitador|mandibula|jaw\s?flex/.test(t)) return "ejercitador-de-mandibula-3-niveles";
  if (/raspador|lengua/.test(t)) return "raspador-de-lengua-de-acero-inoxidable";
  if (/botella/.test(t)) return "botella-flexible-gudair-500-ml";
  if (tiras) return "tiras-nasales-gudair-30-unidades";
  if (parches) return "parches-bucales-gudair-30-unidades";
  return null;
}

/** "tiras-nasales-gudair-30-unidades" → "tiras nasales" (nombre de la tabla o, si no está, el handle sin el relleno). */
export function nombreDeHandle(handle: string): string {
  return PRODUCTOS_ANUNCIO[handle] ??
    handle.replace(/-(gudair|de-acero-inoxidable|\d+-unidades|\d+-ml|3-niveles)\b/g, "").replace(/-/g, " ").trim();
}

/**
 * Producto del anuncio: primero el mapeo (config_wa.anuncios_producto = {"<ad_id>": "<handle>"}) con el id del
 * referral o el guardado en la conversación; si no, palabras clave del referral. null = no se sabe.
 */
export function deducirProductoAnuncio(d: { adId?: string | null; referral?: ReferralMeta | null; mapeo?: unknown }): ProductoAnuncio | null {
  const mapeo = d.mapeo && typeof d.mapeo === "object" && !Array.isArray(d.mapeo) ? d.mapeo as Record<string, unknown> : {};
  for (const id of [d.referral?.source_id, d.adId]) {
    if (typeof id !== "string" || !id.trim()) continue;
    const h = mapeo[id.trim()];
    if (typeof h === "string" && RE_HANDLE.test(h.trim())) return { handle: h.trim(), nombre: nombreDeHandle(h.trim()), fuente: "mapeo" };
  }
  const r = d.referral;
  if (!r) return null;
  const texto = [r.headline, r.body, r.source_url].filter((x) => typeof x === "string").join(" ");
  const h = productoPorPalabras(texto);
  return h ? { handle: h, nombre: nombreDeHandle(h), fuente: "palabras" } : null;
}

/**
 * Marca exacta que va antes del texto del cliente. CONTRATO con el prompt del vendedor: significa "arrancá con
 * ese producto y su precio, no preguntes qué producto vio".
 */
export function marcaAnuncio(p: { handle: string; nombre: string }): string {
  return `[vino del anuncio de ${p.nombre}, handle ${p.handle}]`;
}

/**
 * 21-10 (paquete 2, gancho según el anuncio): lo que prometió el anuncio que tocó el cliente, para que el primer
 * mensaje retome ESA promesa. Sin porcentajes ni asteriscos (no se pueden repetir sin respaldo, Ley 1334 art. 39) y
 * sin la parte de "Escribinos por WhatsApp…". null si el referral no trae texto útil.
 */
export function textoDelAnuncio(referral: ReferralMeta | null | undefined): string | null {
  const body = String(referral?.body ?? "").replace(/\s+/g, " ").trim();
  if (!body || /prueba e2e/i.test(body)) return null;
  const sinCierre = body.split(/escrib[ií]nos|pedilo por whatsapp|pagás al recibir/i)[0];
  const frases = sinCierre.split(/(?<=[.!?])\s+/).filter((f) => f.trim() && !/[%*]/.test(f));
  const t = frases.join(" ").trim().slice(0, 180);
  return t.length >= 8 ? t : null;
}

/** Segunda marca, debajo de la del anuncio: "[el anuncio decía: \"…\"]". */
export const marcaTextoAnuncio = (t: string) => `[el anuncio decía: "${t.replace(/"/g, "'")}"]`;

const RE_MARCA = /\[vino del anuncio de ([^\]]+?), handle ([a-z0-9-]+)\]/;

/** Lee la marca de un texto (null si no tiene). */
export function productoDeMarca(texto: string): { nombre: string; handle: string } | null {
  const r = RE_MARCA.exec(texto ?? "");
  return r ? { nombre: r[1].trim(), handle: r[2] } : null;
}

// ---------- seed_anuncios.sql (lo escribe scripts/mapear-anuncios.mjs) ----------

export type AnuncioMeta = { id: string; name: string };

/**
 * Mapeo nuevo a partir de los anuncios de Meta ([{id, name}], nomenclatura "IMG|VID WHATSAPP <PRODUCTO> <n> <fecha>").
 * Lo de antes se conserva; un id que ya estaba se actualiza con lo que diga su nombre. Los nombres que no se
 * reconocen quedan en `sinProducto` (no entran al mapeo).
 */
export function mapearAnuncios(
  anuncios: AnuncioMeta[],
  previo: { mapeo: Record<string, string>; nombres: Record<string, string> } = { mapeo: {}, nombres: {} },
): { mapeo: Record<string, string>; nombres: Record<string, string>; sinProducto: AnuncioMeta[] } {
  const mapeo = { ...previo.mapeo };
  const nombres = { ...previo.nombres };
  const sinProducto: AnuncioMeta[] = [];
  for (const a of anuncios) {
    const id = String(a?.id ?? "").trim();
    const name = String(a?.name ?? "").replace(/\s+/g, " ").trim();
    if (!/^\d{5,30}$/.test(id)) continue;
    const h = productoPorPalabras(name);
    if (!h) {
      sinProducto.push({ id, name });
      continue;
    }
    mapeo[id] = h;
    nombres[id] = name;
  }
  return { mapeo, nombres, sinProducto };
}

/** Lee el mapeo y los nombres de un seed_anuncios.sql existente (vacío si no se puede leer). */
export function leerSeedAnuncios(sql: string): { mapeo: Record<string, string>; nombres: Record<string, string> } {
  const mapeo: Record<string, string> = {};
  const nombres: Record<string, string> = {};
  const j = /'(\{[\s\S]*?\})'::jsonb/.exec(sql ?? "");
  if (j) {
    try {
      const o = JSON.parse(j[1]) as Record<string, unknown>;
      for (const [k, v] of Object.entries(o)) if (typeof v === "string" && RE_HANDLE.test(v)) mapeo[k] = v;
    } catch { /* seed roto: se arma de cero */ }
  }
  for (const m of (sql ?? "").matchAll(/^-- {3}(\d+) = (.+)$/gm)) nombres[m[1]] = m[2].trim();
  return { mapeo, nombres };
}

/** SQL del seed: ordenado por id, sin pisar lo que ya esté cargado en config_wa (lo existente gana, como seed_mejora_mensual). */
export function armarSeedAnuncios(mapeo: Record<string, string>, nombres: Record<string, string> = {}): string {
  const ids = Object.keys(mapeo).sort();
  const limpio = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/'/g, "").trim();
  const json = ["{", ...ids.map((id, i) => `    ${JSON.stringify(id)}: ${JSON.stringify(mapeo[id])}${i < ids.length - 1 ? "," : ""}`), "  }"].join("\n");
  const lineas = [
    "-- Anuncios de Meta → producto (config_wa.anuncios_producto = {\"<ad_id>\": \"<handle>\"}).",
    "-- Lo usa wa-webhook (procesar.ts) para saber qué producto vio el cliente que entra por un anuncio de WhatsApp",
    "-- y avisarle al vendedor con la marca \"[vino del anuncio de <producto>, handle <handle>]\" (no pregunta qué vio).",
    "-- Generado por scripts/mapear-anuncios.mjs (no editar a mano la lista; correr el script con los anuncios nuevos).",
    "-- Insert si no existe (on conflict do nothing) + merge que agrega los ids nuevos sin pisar los que ya están en la",
    "-- base (lo existente va a la DERECHA del ||, así gana). Para corregir uno:",
    "--   update public.config_wa set valor = valor || jsonb_build_object('<ad_id>', '<handle>') where clave = 'anuncios_producto';",
    "-- Nombres en Meta:",
    ...ids.map((id) => `--   ${id} = ${limpio(nombres[id] ?? "")}`.trimEnd()),
    "insert into public.config_wa (clave, valor) values",
    `  ('anuncios_producto', '${json}'::jsonb)`,
    "on conflict (clave) do nothing;",
    `update public.config_wa set valor = '${json}'::jsonb || valor`,
    "  where clave = 'anuncios_producto';",
    "",
  ];
  return lineas.join("\n");
}
