// resumen-diario · I/O: Supabase (solo lectura de negocio), Meta Graph API (solo GET) y Telegram (1 mensaje).
import { db } from "../_shared/db.ts";
import { GRAPH_VERSION } from "../_shared/meta_capi.ts";
import { CONJUNTO_PRUEBA, type CampanaMeta, type DatosMeta, DESDE_BOT_V33, familia, type Pedido, type PedidoParado, type RendicionAtrasada, sumarDias } from "./logica.ts";

export const CUENTA_VOLTRA = "1829928881223795";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
type Obj = Record<string, unknown>;
const n = (x: unknown) => Number(x) || 0;

export async function leerPedidos(desdeIso: string): Promise<Pedido[]> {
  const { data, error } = await db().from("shopify_pedidos")
    .select("nombre,creado_en,total,tags,es_borrador,estado_confirmacion,estado_envio,cliente_id,raw->>created_at,raw->>cancelled_at,raw->>note,raw->shipping_address->>city,raw->line_items")
    .gte("creado_en", desdeIso);
  if (error) throw new Error(`shopify_pedidos: ${error.message}`);
  return (data ?? []).map((p: Obj) => ({
    nombre: String(p.nombre ?? ""),
    creadoEn: String(p.created_at ?? p.creado_en),
    total: n(p.total),
    tags: (p.tags ?? []) as string[],
    canceladoEn: (p.cancelled_at as string) || null,
    esBorrador: p.es_borrador === true,
    nota: String(p.note ?? ""),
    ciudad: String(p.city ?? ""),
    lineas: ((p.line_items ?? []) as Obj[]).map((l) => ({ titulo: String(l.title ?? l.name ?? ""), cantidad: n(l.quantity) || 1 })),
    estadoConfirmacion: (p.estado_confirmacion as string) ?? null,
    estadoEnvio: (p.estado_envio as string) ?? null,
    clienteId: (p.cliente_id as string) ?? null,
  }));
}

export async function chatsAnuncio(desdeIso: string): Promise<Array<{ clienteId: string | null }>> {
  const { data, error } = await db().from("wa_conversaciones").select("cliente_id").not("origen_anuncio_id", "is", null).gte("creado_en", desdeIso);
  if (error) throw new Error(`wa_conversaciones: ${error.message}`);
  return (data ?? []).map((c: Obj) => ({ clienteId: (c.cliente_id as string) ?? null }));
}

export async function chatsBotV33(): Promise<number> {
  const { count, error } = await db().from("wa_conversaciones").select("id", { count: "exact", head: true })
    .not("origen_anuncio_id", "is", null).gte("creado_en", DESDE_BOT_V33);
  if (error) throw new Error(`wa_conversaciones: ${error.message}`);
  return count ?? 0;
}

export async function stock(): Promise<Array<{ nombre: string; stock: number }>> {
  const { data, error } = await db().from("productos").select("nombre,stock_actual,es_combo").eq("activo", true);
  if (error) throw new Error(`productos: ${error.message}`);
  return (data ?? []).filter((p: Obj) => !p.es_combo).map((p: Obj) => ({ nombre: String(p.nombre), stock: n(p.stock_actual) }));
}

/** 19-10: regla de 3 grupos (vista pedidos_entrega). Tasa = ENTREGADO ÷ (ENTREGADO + PERDIDO) de los pedidos de los
 *  últimos 14 días (un COD tarda 2-4 días en resolverse). */
export async function entregaGrupos(desde14Iso: string): Promise<{ entregados: number; rechazados: number }> {
  const { data, error } = await db().from("pedidos_entrega").select("grupo").gte("fecha", desde14Iso.slice(0, 10)).in("grupo", ["ENTREGADO", "PERDIDO"]);
  if (error) throw new Error(`pedidos_entrega: ${error.message}`);
  const ent = (data ?? []).filter((x: Obj) => x.grupo === "ENTREGADO").length;
  return { entregados: ent, rechazados: (data ?? []).length - ent };
}

/** Pedidos de Lucero EN GESTIÓN con más de 3 días (incluye "Fallido"): todavía se pueden salvar reprogramando. */
export async function luceroEnGestion(): Promise<Array<{ ref: string; estado: string; dias: number }>> {
  const { data, error } = await db().from("pedidos_entrega").select("referencia,estado_courier,gestion_desde")
    .eq("transportadora", "lucero").eq("grupo", "EN_GESTION").lt("gestion_desde", new Date(Date.now() - 3 * 86_400_000).toISOString());
  if (error) throw new Error(`pedidos_entrega: ${error.message}`);
  return (data ?? []).map((x: Obj) => ({ ref: String(x.referencia), estado: String(x.estado_courier || "sin estado"),
    dias: Math.floor((Date.now() - Date.parse(String(x.gestion_desde))) / 86_400_000) })).sort((a, b) => b.dias - a.dias);
}

/** Pedidos de PaP en custodia, con la fecha de entrada (fin de custodia = causa n.º 1 de pérdida en PaP). */
export async function papCustodia(): Promise<Array<{ ref: string; desde: string }>> {
  const { data, error } = await db().from("pedidos_entrega").select("referencia,custodia_desde").eq("en_custodia", true);
  if (error) throw new Error(`pedidos_entrega: ${error.message}`);
  return (data ?? []).map((x: Obj) => ({ ref: String(x.referencia), desde: String(x.custodia_desde ?? "") }));
}

/** Resueltos de los últimos 7 días: ENTREGADO vs rechazados (CANCELADO / NO_ENTREGADO / DEVUELTO en pedido_estados,
 *  más las devoluciones de Lucero en entregas de pedidos de las últimas 2 semanas). Un pedido entregado no cuenta como rechazo. */
export async function entrega7d(desde7Iso: string, desde14Iso: string): Promise<{ entregados: number; rechazados: number }> {
  const s = db();
  const { data: est, error } = await s.from("pedido_estados").select("shopify_order_id,estado")
    .in("estado", ["ENTREGADO", "CANCELADO", "NO_ENTREGADO", "DEVUELTO"]).gte("creado_en", desde7Iso);
  if (error) throw new Error(`pedido_estados: ${error.message}`);
  const ent = new Set<string>(), rech = new Set<string>();
  for (const x of (est ?? []) as Obj[]) (x.estado === "ENTREGADO" ? ent : rech).add(String(x.shopify_order_id));
  const { data: dev } = await s.from("entregas").select("n_referencia").eq("tienda", "voltra").eq("categoria", "devuelto");
  const nums = ((dev ?? []) as Obj[]).map((d) => /^VT-(\d+)$/.exec(String(d.n_referencia))?.[1]).filter(Boolean).map((x) => `#${x}`);
  if (nums.length) {
    const { data: ped } = await s.from("shopify_pedidos").select("shopify_order_id").in("nombre", nums).gte("creado_en", desde14Iso);
    for (const p of (ped ?? []) as Obj[]) rech.add(String(p.shopify_order_id));
  }
  for (const id of ent) rech.delete(id);
  return { entregados: ent.size, rechazados: rech.size };
}

/** Anuncios marcados 'cansado' en el libro de creativos (vista libro_creativos). */
/** 20-10: equilibrio por producto (config equilibrio_producto, con flete real por courier y ciudad). */
export async function equilibrios(): Promise<Record<string, number>> {
  const { data } = await db().from("config").select("valor").eq("clave", "equilibrio_producto").maybeSingle();
  try {
    const j = JSON.parse(String(data?.valor ?? "{}")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v as number) && (v as number) > 0));
  } catch {
    return {};
  }
}

/** 20-10: PaP en los últimos 60 días (resueltos y tasa medida), de la vista tasa_entrega_courier. */
export async function pap60d(): Promise<{ resueltos: number; tasa: number | null } | null> {
  const { data, error } = await db().from("tasa_entrega_courier").select("resueltos,tasa_medida").eq("courier", "pap").maybeSingle();
  if (error || !data) return null;
  return { resueltos: Number(data.resueltos) || 0, tasa: data.tasa_medida == null ? null : Number(data.tasa_medida) };
}

export async function cansados(): Promise<Array<{ anuncio: string; canal: string; caidaPct: number | null }>> {
  const { data, error } = await db().from("libro_creativos").select("anuncio,canal,caida_pct").eq("estado", "cansado").order("gasto", { ascending: false }).limit(5);
  if (error) throw new Error(`libro_creativos: ${error.message}`);
  return (data ?? []).map((x: Obj) => ({ anuncio: String(x.anuncio), canal: String(x.canal), caidaPct: x.caida_pct == null ? null : Number(x.caida_pct) }));
}

// ── Estado: candados en eventos_crudos (fuente 'telegram') ──
export async function leerCandado(id: string): Promise<{ payload: Obj; error: string | null } | null> {
  const { data } = await db().from("eventos_crudos").select("payload,error").eq("fuente", "telegram").eq("id_externo", id).maybeSingle();
  return data ? { payload: (data.payload ?? {}) as Obj, error: (data.error as string) ?? null } : null;
}
export async function guardarCandado(id: string, payload: Obj, error: string | null): Promise<void> {
  const { error: e } = await db().from("eventos_crudos").upsert(
    { fuente: "telegram", id_externo: id, payload, procesado_en: new Date().toISOString(), error },
    { onConflict: "fuente,id_externo" },
  );
  if (e) console.warn("resumen-diario candado:", e.message);
}

// ── Meta (solo GET) ──
function token(): string {
  const t = Deno.env.get("META_ADS_TOKEN") || Deno.env.get("META_CAPI_TOKEN");
  if (!t) throw new Error("Falta META_ADS_TOKEN");
  return t;
}
async function get(url: string): Promise<Obj> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({})) as Obj;
  if (!r.ok || j.error) throw new Error(`Meta ${r.status}: ${(j.error as Obj)?.message ?? "sin mensaje"}`);
  return j;
}
const rango = (desde: string, hasta: string) => encodeURIComponent(JSON.stringify({ since: desde, until: hasta }));
const accion = (acts: unknown, tipos: string[]) =>
  Math.max(0, ...((acts ?? []) as Obj[]).filter((a) => tipos.includes(String(a.action_type))).map((a) => n(a.value)));

export async function leerMeta(hoy: string): Promise<DatosMeta> {
  const ayer = sumarDias(hoy, -1), desde7 = sumarDias(hoy, -6);
  // Presupuesto diario: de la campaña (presupuesto de campaña) o la suma de sus conjuntos activos.
  const camp = await get(`${GRAPH}/act_${CUENTA_VOLTRA}/campaigns?fields=id,name,daily_budget,adsets.limit(50){daily_budget,effective_status}&effective_status=${encodeURIComponent('["ACTIVE"]')}&limit=50`);
  const presupuesto = new Map<string, number | null>();
  for (const c of (camp.data ?? []) as Obj[]) {
    const propio = n(c.daily_budget);
    const conjuntos = (((c.adsets as Obj)?.data ?? []) as Obj[]).filter((a) => a.effective_status === "ACTIVE").reduce((s, a) => s + n(a.daily_budget), 0);
    presupuesto.set(String(c.id), propio || conjuntos || null);
  }
  const porCampana = async (desde: string, hasta: string): Promise<CampanaMeta[]> => {
    const r = await get(`${GRAPH}/act_${CUENTA_VOLTRA}/insights?level=campaign&fields=campaign_id,campaign_name,spend&time_range=${rango(desde, hasta)}&limit=100`);
    return ((r.data ?? []) as Obj[]).map((x) => ({ nombre: String(x.campaign_name), gasto: n(x.spend), presupuesto: presupuesto.get(String(x.campaign_id)) ?? null }));
  };
  const [cHoy, cAyer, c7] = await Promise.all([porCampana(hoy, hoy), porCampana(ayer, ayer), porCampana(desde7, hoy)]);
  let prueba: DatosMeta["prueba"] = null;
  try {
    const r = await get(`${GRAPH}/${CONJUNTO_PRUEBA}/insights?level=ad&fields=ad_name,spend,inline_link_click_ctr,actions&time_range=${rango(hoy, hoy)}&limit=100`);
    const ads = ((r.data ?? []) as Obj[]).map((a) => ({
      nombre: String(a.ad_name), gasto: n(a.spend), ctr: a.inline_link_click_ctr == null ? null : n(a.inline_link_click_ctr),
      inicios: accion(a.actions, ["initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout", "omni_initiated_checkout"]),
      compras: accion(a.actions, ["purchase", "offsite_conversion.fb_pixel_purchase", "omni_purchase"]),
    }));
    const gasto = ads.reduce((s, a) => s + a.gasto, 0);
    const mejor = [...ads].sort((a, b) => b.compras - a.compras || b.inicios - a.inicios || (b.ctr ?? 0) - (a.ctr ?? 0) || b.gasto - a.gasto)[0] ?? null;
    prueba = { gasto, mejor: mejor ? { nombre: mejor.nombre, ctr: mejor.ctr, inicios: mejor.inicios, compras: mejor.compras } : null };
  } catch (e) {
    console.warn("resumen-diario prueba de productos:", e instanceof Error ? e.message : e);
  }
  // 20-10: gasto de 3 días por producto (nombre del anuncio), para la alerta de CPA de JawFlex.
  let gasto3dPorProducto: Record<string, number> | undefined;
  let gasto3dPausadoPorProducto: Record<string, number> | undefined;
  try {
    const r = await get(`${GRAPH}/act_${CUENTA_VOLTRA}/insights?level=ad&fields=ad_id,ad_name,spend&time_range=${rango(sumarDias(hoy, -2), hoy)}&limit=500`);
    gasto3dPorProducto = {};
    const filas = (r.data ?? []) as Obj[];
    for (const a of filas) {
      const f = familia(String(a.ad_name));
      gasto3dPorProducto[f] = (gasto3dPorProducto[f] ?? 0) + n(a.spend);
    }
    // Anuncios activos hoy; el resto del gasto (pausados/archivados) se informa aparte. Si falla, no se separa.
    try {
      const act = await get(`${GRAPH}/act_${CUENTA_VOLTRA}/ads?fields=id&effective_status=${encodeURIComponent('["ACTIVE"]')}&limit=500`);
      const activos = new Set(((act.data ?? []) as Obj[]).map((x) => String(x.id)));
      gasto3dPausadoPorProducto = {};
      for (const a of filas) {
        if (activos.has(String(a.ad_id))) continue;
        const f = familia(String(a.ad_name));
        gasto3dPausadoPorProducto[f] = (gasto3dPausadoPorProducto[f] ?? 0) + n(a.spend);
      }
    } catch (e) {
      console.warn("resumen-diario anuncios activos:", e instanceof Error ? e.message : e);
    }
  } catch (e) {
    console.warn("resumen-diario gasto 3 días por producto:", e instanceof Error ? e.message : e);
  }
  return { hoy: cHoy, ayer: cAyer, gasto7d: c7.reduce((s, c) => s + c.gasto, 0), gasto3dPorProducto, gasto3dPausadoPorProducto, prueba };
}

/** 21-10: courier sugerido (rpc sugerir_courier) por cada ciudad distinta; null = sin cobertura o ciudad no reconocida. */
export async function couriersPorCiudad(ciudades: string[]): Promise<Record<string, { sugerido: string | null; lucero: boolean; pap: boolean }>> {
  const out: Record<string, { sugerido: string | null; lucero: boolean; pap: boolean }> = {};
  await Promise.all([...new Set(ciudades.filter(Boolean))].map(async (c) => {
    const { data, error } = await db().rpc("sugerir_courier", { p_ciudad: c, p_cod: true });
    if (error) return;
    const d = (data ?? {}) as Obj;
    const ops = (Array.isArray(d.opciones) ? d.opciones : []) as Obj[];
    const cobra = (k: string) => ops.some((o) => o.courier === k && o.valido === true);
    out[c] = { sugerido: (d.sugerido as string) ?? null, lucero: cobra("lucero"), pap: cobra("pap") };
  }));
  return out;
}

/** 21-10: vista pedidos_parados (confirmados de Voltra de +24 h que no salieron). Más viejo primero. */
export async function leerPedidosParados(): Promise<PedidoParado[]> {
  const { data, error } = await db().from("pedidos_parados").select("nombre,ciudad,horas,dias,etapa,courier,producto").order("horas", { ascending: false });
  if (error) throw new Error(`pedidos_parados: ${error.message}`);
  return (data ?? []).map((x: Obj) => ({
    nombre: String(x.nombre), ciudad: x.ciudad == null ? null : String(x.ciudad), horas: n(x.horas), dias: n(x.dias),
    etapa: String(x.etapa), courier: x.courier == null ? null : String(x.courier), producto: x.producto == null ? null : String(x.producto),
  }));
}

/** 21-10: vista rendicion_atrasada (entregados de Voltra sin rendir pasado el umbral del courier). */
export async function leerRendicionAtrasada(): Promise<RendicionAtrasada[]> {
  const { data, error } = await db().from("rendicion_atrasada").select("ref,courier,dias,monto_neto");
  if (error) throw new Error(`rendicion_atrasada: ${error.message}`);
  return (data ?? []).map((x: Obj) => ({ ref: String(x.ref), courier: String(x.courier), dias: n(x.dias), montoNeto: n(x.monto_neto) }));
}
