// resumen-diario · I/O: Supabase (solo lectura de negocio), Meta Graph API (solo GET) y Telegram (1 mensaje).
import { db } from "../_shared/db.ts";
import { GRAPH_VERSION } from "../_shared/meta_capi.ts";
import { CONJUNTO_PRUEBA, type CampanaMeta, type DatosMeta, DESDE_BOT_V33, type Pedido, sumarDias } from "./logica.ts";

export const CUENTA_VOLTRA = "1829928881223795";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
type Obj = Record<string, unknown>;
const n = (x: unknown) => Number(x) || 0;

export async function leerPedidos(desdeIso: string): Promise<Pedido[]> {
  const { data, error } = await db().from("shopify_pedidos")
    .select("nombre,creado_en,total,tags,es_borrador,estado_confirmacion,estado_envio,cliente_id,raw->>created_at,raw->>cancelled_at,raw->>note,raw->line_items")
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
  return { hoy: cHoy, ayer: cAyer, gasto7d: c7.reduce((s, c) => s + c.gasto, 0), prueba };
}
