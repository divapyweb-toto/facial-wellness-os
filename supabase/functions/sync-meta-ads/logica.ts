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
  /** Opcional: borra la fila de un conjunto (y sus repartos "<id>~...") de una fecha, antes de reescribirla repartida. */
  borrarConjunto?(tienda: Tienda, fecha: string, adsetId: string): Promise<void>;
  /** GET act_<id>?fields=currency. Si no es PYG, esa cuenta se frena (el gasto se guarda como guaraníes). */
  monedaCuenta?(cuentaId: string): Promise<string>;
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

/**
 * Conjuntos que mezclan productos ("WHATSAPP SUEÑO", "PACK TIRAS + PARCHES"): su fila queda sin producto.
 * Cada ANUNCIO sí nombra su producto ("IMG WHATSAPP PARCHES BUCALES 9"), así que el gasto del conjunto se
 * reparte por producto según el gasto de sus anuncios. Filas resultantes: adset_id "<id>~<producto|sin>".
 * La suma siempre da el gasto del conjunto (la diferencia de redondeo va al grupo "sin producto" o al mayor).
 * Devuelve { filas, repartidos } donde repartidos son las claves fecha|adset_id originales reemplazadas.
 */
export function repartirPorAnuncio(
  filas: FilaGasto[],
  anuncios: Array<Record<string, unknown>>,
  productos: Producto[],
): { filas: FilaGasto[]; repartidos: { fecha: string; adset_id: string }[] } {
  const nombreProd = new Map(productos.map((p) => [p.id, p.nombre]));
  const porConjunto = new Map<string, Array<Record<string, unknown>>>();
  for (const a of anuncios) {
    const k = `${a.date_start}|${a.adset_id}`;
    if (!porConjunto.has(k)) porConjunto.set(k, []);
    porConjunto.get(k)!.push(a);
  }
  const salida: FilaGasto[] = [];
  const repartidos: { fecha: string; adset_id: string }[] = [];
  for (const f of filas) {
    const ads = porConjunto.get(`${f.fecha}|${f.adset_id}`) ?? [];
    if (f.producto_id !== null || ads.length === 0) { salida.push(f); continue; }
    const grupos = new Map<string, number>(); // producto_id | "" (sin producto) → gasto
    for (const a of ads) {
      const g = gastoEntero(a.spend);
      if (g <= 0) continue;
      const prod = mapearProducto(String(a.ad_name ?? ""), String(a.campaign_name ?? ""), productos) ?? "";
      grupos.set(prod, (grupos.get(prod) ?? 0) + g);
    }
    const conProducto = [...grupos.keys()].filter((k) => k !== "");
    if (conProducto.length === 0) { salida.push(f); continue; } // nada que repartir
    // Ajuste para que la suma sea exactamente el gasto del conjunto.
    const suma = [...grupos.values()].reduce((x, y) => x + y, 0);
    const dif = f.gasto - suma;
    if (dif !== 0) {
      const destino = grupos.has("") ? "" : [...grupos.entries()].sort((a, b) => b[1] - a[1])[0][0];
      grupos.set(destino, (grupos.get(destino) ?? 0) + dif);
    }
    for (const [prod, gasto] of grupos) {
      if (gasto <= 0) continue;
      salida.push({
        ...f,
        adset_id: `${f.adset_id}~${prod || "sin"}`,
        adset_nombre: `${f.adset_nombre} · ${prod ? (nombreProd.get(prod) ?? "producto") : "sin producto"}`,
        producto_id: prod || null,
        gasto,
      });
    }
    repartidos.push({ fecha: f.fecha, adset_id: f.adset_id });
  }
  return { filas: salida, repartidos };
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
  /** Cuenta frenada sin escribir nada (p. ej. moneda distinta de PYG). */
  error?: string;
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
  const frenadas = new Set<string>();
  for (const cuenta of cuentas) {
    if (deps.monedaCuenta) {
      const moneda = (await deps.monedaCuenta(cuenta.id)).toUpperCase();
      if (moneda !== "PYG") {
        // No se convierte: se frena esta cuenta y se avisa (el resto sigue).
        frenadas.add(cuenta.id);
        lotes.push({ cuenta, filas: [], resumen: {
          cuenta: cuenta.id, tienda: cuenta.tienda, desde: r.since, hasta: r.until, filas: 0, gasto_total: 0, sin_mapear: [],
          error: `la cuenta act_${cuenta.id} está en ${moneda || "moneda desconocida"}, no en PYG: no se guardó su gasto`,
        } });
        continue;
      }
    }
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

  // Gasto por anuncio (se lee antes de escribir: sirve para repartir conjuntos mezclados por producto).
  const anuncios: { cuenta: string; filas: number; error?: string }[] = [];
  const crudasAnuncio = new Map<string, Array<Record<string, unknown>>>();
  if (deps.upsertAnuncios) {
    for (const cuenta of cuentas) {
      if (frenadas.has(cuenta.id)) continue;
      try {
        crudasAnuncio.set(cuenta.id, await traerInsights(deps, urlInsightsAnuncios(cuenta.id, r)) as unknown as Array<Record<string, unknown>>);
      } catch (e) {
        anuncios.push({ cuenta: cuenta.id, filas: 0, error: (e as Error)?.message ?? String(e) });
      }
    }
  }

  for (const l of lotes) {
    if (!l.filas.length) continue;
    const ads = crudasAnuncio.get(l.cuenta.id);
    if (ads && deps.borrarConjunto) {
      const rep = repartirPorAnuncio(l.filas, ads, productos);
      for (const x of rep.repartidos) await deps.borrarConjunto(l.cuenta.tienda, x.fecha, x.adset_id);
      l.filas = rep.filas;
      // Lo que sigue sin producto después del reparto (anuncios cuyo nombre no nombra un producto).
      const campanaDe = new Map(l.resumen.sin_mapear.map((x) => [`${x.fecha}|${x.adset}`, x.campana]));
      l.resumen.sin_mapear = l.filas.filter((f) => f.producto_id === null).map((f) => ({
        fecha: f.fecha, adset: f.adset_nombre, campana: campanaDe.get(`${f.fecha}|${f.adset_nombre.split(" · ")[0]}`) ?? "", gasto: f.gasto,
      }));
      l.resumen.filas = l.filas.length;
    }
    await deps.upsert(l.filas);
  }

  for (const [cuentaId, crudas] of crudasAnuncio) {
    const cuenta = cuentas.find((c) => c.id === cuentaId)!;
    try {
      const filas = filasAnuncio(crudas, cuenta.tienda);
      if (filas.length) await deps.upsertAnuncios!(filas);
      anuncios.push({ cuenta: cuentaId, filas: filas.length });
    } catch (e) {
      anuncios.push({ cuenta: cuentaId, filas: 0, error: (e as Error)?.message ?? String(e) });
    }
  }
  return { ok: true, cuentas: lotes.map((l) => l.resumen), anuncios };
}
