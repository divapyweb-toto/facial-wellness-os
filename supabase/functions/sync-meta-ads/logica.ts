// supabase/functions/sync-meta-ads/logica.ts · Dueño: A2 (09-10-2026)
// Lógica pura del sync de gasto de Meta Ads → gasto_ads_diario. Sin red ni base: todo entra por Deps.
// Reemplaza al LaunchAgent de la Mac (.claude/agents/sync-ads-fw.md + scripts/sync-ads-fw-daily.sh) con
// las MISMAS reglas de mapeo de producto. SOLO LECTURA sobre Meta: únicamente GET de insights.

export const GRAPH_VERSION = "v25.0"; // verificado en la doc "Insights API" el 09-10-2026
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const CAMPOS = "adset_id,adset_name,campaign_id,campaign_name,spend,date_start";

export type Tienda = "fw" | "voltra";
export interface Cuenta { id: string; tienda: Tienda }

/** Cuentas por defecto (config_wa.sync_meta_ads.cuentas las reemplaza). FW (1075263797491391) sin campañas desde oct-2026. */
export const CUENTAS_DEFECTO: Cuenta[] = [{ id: "1829928881223795", tienda: "voltra" }];
export const DIAS_DEFECTO = 7;

export interface Producto {
  id: string;
  nombre: string;
  es_combo?: boolean | null;
  componente_1_id?: string | null;
  componente_2_id?: string | null;
}

export interface FilaInsight {
  adset_id: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string | number;
  date_start: string;
}

export interface PaginaInsights { data?: FilaInsight[]; paging?: { next?: string } }

export interface FilaGasto {
  fecha: string;
  adset_id: string;
  adset_nombre: string;
  producto_id: string | null;
  gasto: number;
  plataforma: "meta";
  tienda: Tienda;
}

/** Gasto por ANUNCIO (para cruzar con el "UTM content" de cada pedido, que trae el nombre del anuncio). */
export interface FilaAnuncio {
  fecha: string;
  ad_id: string;
  ad_nombre: string;
  adset_id: string | null;
  campana_nombre: string;
  gasto: number;
  tienda: Tienda;
}

export interface Existente { fecha: string; adset_id: string; producto_id: string | null }

export interface Deps {
  /** GET a la Graph API (el token lo pone io.ts en el header). Lanza Error con el mensaje de Meta si falla. */
  traerPagina(url: string): Promise<PaginaInsights>;
  leerProductos(): Promise<Producto[]>;
  leerExistentes(tienda: Tienda, desde: string, hasta: string): Promise<Existente[]>;
  upsert(filas: FilaGasto[]): Promise<number>;
  /** Opcional: gasto por anuncio. Si falta (o falla), el gasto por conjunto se guarda igual. */
  upsertAnuncios?(filas: FilaAnuncio[]): Promise<number>;
}

// ---------- fechas (Paraguay, UTC-3 fijo) ----------

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Hoy en Asunción. */
export function hoyPY(ahora: Date): string {
  return new Date(ahora.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
}

/** Últimos `dias` días cerrados: desde hoy-dias hasta ayer (hoy no cerró). */
export function rango(ahora: Date, dias = DIAS_DEFECTO): { since: string; until: string } {
  const hoy = hoyPY(ahora);
  return { since: sumarDias(hoy, -dias), until: sumarDias(hoy, -1) };
}

export function urlInsights(cuentaId: string, r: { since: string; until: string }): string {
  const p = new URLSearchParams({
    level: "adset",
    time_increment: "1",
    time_range: JSON.stringify(r),
    fields: CAMPOS,
    limit: "500",
  });
  return `${GRAPH_BASE}/act_${cuentaId}/insights?${p}`;
}

/** Mismo rango, a nivel ANUNCIO (solo GET). */
export function urlInsightsAnuncios(cuentaId: string, r: { since: string; until: string }): string {
  const p = new URLSearchParams({
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify(r),
    fields: "ad_id,ad_name,adset_id,campaign_name,spend,date_start",
    limit: "500",
  });
  return `${GRAPH_BASE}/act_${cuentaId}/insights?${p}`;
}

/** Filas de insights por anuncio → FilaAnuncio (sin gasto 0; una fila por fecha+anuncio). */
export function filasAnuncio(crudas: Array<Record<string, unknown>>, tienda: Tienda): FilaAnuncio[] {
  const m = new Map<string, FilaAnuncio>();
  for (const f of crudas) {
    const gasto = gastoEntero(f.spend);
    const ad = f.ad_id ? String(f.ad_id) : "";
    const fecha = f.date_start ? String(f.date_start) : "";
    if (gasto <= 0 || !ad || !fecha) continue;
    m.set(`${fecha}|${ad}`, {
      fecha, ad_id: ad, ad_nombre: String(f.ad_name ?? ""), adset_id: f.adset_id ? String(f.adset_id) : null,
      campana_nombre: String(f.campaign_name ?? ""), gasto, tienda,
    });
  }
  return [...m.values()];
}

// ---------- gasto ----------

/** spend de Meta llega como string ("12345" o "12345.00"). PYG no tiene decimales → entero. */
export function gastoEntero(spend: unknown): number {
  const n = typeof spend === "number" ? spend : Number(String(spend ?? "").trim());
  if (!Number.isFinite(n) || n < 0 || String(spend ?? "").trim() === "") {
    throw new Error(`gasto inválido de Meta: ${JSON.stringify(spend)}`);
  }
  return Math.round(n);
}

// ---------- mapeo de producto (reglas de .claude/agents/sync-ads-fw.md, paso 4) ----------

/** minúsculas, sin tildes, sin signos, y cada palabra en singular. */
export function normalizar(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean)
    .map((w) => {
      if (w.length > 4 && /[lnrdz]es$/.test(w)) return w.slice(0, -2); // nasales→nasal, bucales→bucal
      if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1); // tiras→tira, parches→parche
      return w;
    }).join(" ");
}

/**
 * Sinónimos de Meta → producto. `producto`: texto que tiene que estar en productos.nombre (normalizado).
 * Ampliar acá cuando aparezca un nombre nuevo en un conjunto/campaña. Ante duda NO agregar: queda NULL.
 */
export const ALIAS: { producto: string; claves: string[] }[] = [
  { producto: "raspador de lengua", claves: ["raspador de lengua", "limpiador de lengua", "raspador lengua"] },
  { producto: "tira nasal", claves: ["tira nasal"] },
  { producto: "parche bucal", claves: ["parche bucal"] },
  { producto: "ejercitador de mandibula", claves: ["ejercitador", "jawflex", "jaw flex", "mandibula"] },
  { producto: "limpiador de oido", claves: ["limpiador de oido", "bebird", "oido"] },
  { producto: "botella flexible", claves: ["botella"] },
  { producto: "gudair", claves: ["gudair"] },
];

function contieneFrase(texto: string, frase: string): boolean {
  return ` ${texto} `.includes(` ${frase} `);
}

function clavesDe(p: Producto, productos: Producto[]): string[] {
  const n = normalizar(p.nombre);
  const c = new Set<string>([n]);
  const simples = productos.filter((x) => !x.es_combo).map((x) => normalizar(x.nombre));
  for (const a of ALIAS) {
    const frase = normalizar(a.producto);
    if (!contieneFrase(n, frase)) continue;
    // Un combo no hereda los sinónimos de sus componentes ("tira nasal" es de Tiras nasales, no del Pack).
    if (p.es_combo && simples.some((s) => contieneFrase(s, frase))) continue;
    a.claves.forEach((k) => c.add(normalizar(k)));
  }
  return [...c];
}

export type Coincidencia = { tipo: "ninguno" } | { tipo: "uno"; id: string } | { tipo: "varios"; ids: string[] };

/** Productos nombrados en un texto. Un combo absorbe a sus componentes (ej. "Pack Gudair tiras + parches"). */
export function buscarProductos(texto: string, productos: Producto[]): Coincidencia {
  const t = normalizar(texto);
  let ids = productos.filter((p) => clavesDe(p, productos).some((k) => contieneFrase(t, k))).map((p) => p.id);
  const combos = productos.filter((p) => p.es_combo && ids.includes(p.id));
  if (combos.length === 1) {
    const comp = [combos[0].componente_1_id, combos[0].componente_2_id].filter(Boolean);
    ids = ids.filter((id) => !comp.includes(id));
  }
  ids = [...new Set(ids)];
  if (ids.length === 0) return { tipo: "ninguno" };
  if (ids.length === 1) return { tipo: "uno", id: ids[0] };
  return { tipo: "varios", ids };
}

/** Conjunto primero; si no nombra producto, campaña. Distintos o varios → NULL. */
export function mapearProducto(adset: string, campana: string, productos: Producto[]): string | null {
  const a = buscarProductos(adset, productos);
  const c = buscarProductos(campana, productos);
  if (a.tipo === "varios") return null;
  if (a.tipo === "uno") {
    if (c.tipo === "uno" && c.id !== a.id) return null;
    if (c.tipo === "varios" && !c.ids.includes(a.id)) return null;
    return a.id;
  }
  return c.tipo === "uno" ? c.id : null;
}

// ---------- corrida ----------

export interface ResumenCuenta {
  cuenta: string;
  tienda: Tienda;
  desde: string;
  hasta: string;
  filas: number;
  gasto_total: number;
  sin_mapear: { fecha: string; adset: string; campana: string; gasto: number }[];
}

export async function traerInsights(deps: Deps, url: string, maxPaginas = 50): Promise<FilaInsight[]> {
  const filas: FilaInsight[] = [];
  let siguiente: string | undefined = url;
  for (let i = 0; siguiente && i < maxPaginas; i++) {
    const pag: PaginaInsights = await deps.traerPagina(siguiente);
    filas.push(...(pag.data ?? []));
    siguiente = pag.paging?.next;
  }
  if (siguiente) throw new Error(`insights: más de ${maxPaginas} páginas, corte de seguridad`);
  return filas;
}

export async function sincronizar(
  deps: Deps,
  opciones: { cuentas?: Cuenta[]; dias?: number; ahora?: Date } = {},
): Promise<{ ok: true; cuentas: ResumenCuenta[]; anuncios: { cuenta: string; filas: number; error?: string }[] }> {
  const cuentas = opciones.cuentas?.length ? opciones.cuentas : CUENTAS_DEFECTO;
  const r = rango(opciones.ahora ?? new Date(), opciones.dias ?? DIAS_DEFECTO);

  // Regla del agente: 0 productos activos = consulta rota, no realidad → frenar sin escribir nada.
  const productos = await deps.leerProductos();
  if (productos.length === 0) throw new Error("productos activos: 0 filas — se frena sin escribir en gasto_ads_diario");

  // Primero se lee TODO de Meta (todas las cuentas); recién después se escribe.
  const lotes: { cuenta: Cuenta; filas: FilaGasto[]; resumen: ResumenCuenta }[] = [];
  for (const cuenta of cuentas) {
    const crudas = await traerInsights(deps, urlInsights(cuenta.id, r));
    const existentes = await deps.leerExistentes(cuenta.tienda, r.since, r.until);
    const previo = new Map(existentes.map((e) => [`${e.fecha}|${e.adset_id}`, e.producto_id]));
    const resumen: ResumenCuenta = {
      cuenta: cuenta.id, tienda: cuenta.tienda, desde: r.since, hasta: r.until, filas: 0, gasto_total: 0, sin_mapear: [],
    };
    const porClave = new Map<string, FilaGasto>();
    for (const f of crudas) {
      const gasto = gastoEntero(f.spend);
      if (gasto <= 0 || !f.adset_id || !f.date_start) continue;
      const adset = f.adset_name ?? "";
      const campana = f.campaign_name ?? "";
      let producto_id = mapearProducto(adset, campana, productos);
      // Un mapeo hecho a mano antes no se pisa con NULL.
      if (producto_id === null) producto_id = previo.get(`${f.date_start}|${f.adset_id}`) ?? null;
      if (producto_id === null) resumen.sin_mapear.push({ fecha: f.date_start, adset, campana, gasto });
      porClave.set(`${f.date_start}|${f.adset_id}`, {
        fecha: f.date_start, adset_id: String(f.adset_id), adset_nombre: adset, producto_id, gasto,
        plataforma: "meta", tienda: cuenta.tienda,
      });
    }
    const filas = [...porClave.values()];
    resumen.filas = filas.length;
    resumen.gasto_total = filas.reduce((s, x) => s + x.gasto, 0);
    lotes.push({ cuenta, filas, resumen });
  }

  for (const l of lotes) if (l.filas.length) await deps.upsert(l.filas);

  // Gasto por anuncio: aparte y sin frenar lo anterior si falla.
  const anuncios: { cuenta: string; filas: number; error?: string }[] = [];
  if (deps.upsertAnuncios) {
    for (const cuenta of cuentas) {
      try {
        const crudas = await traerInsights(deps, urlInsightsAnuncios(cuenta.id, r)) as unknown as Array<Record<string, unknown>>;
        const filas = filasAnuncio(crudas, cuenta.tienda);
        if (filas.length) await deps.upsertAnuncios(filas);
        anuncios.push({ cuenta: cuenta.id, filas: filas.length });
      } catch (e) {
        anuncios.push({ cuenta: cuenta.id, filas: 0, error: (e as Error)?.message ?? String(e) });
      }
    }
  }
  return { ok: true, cuentas: lotes.map((l) => l.resumen), anuncios };
}
