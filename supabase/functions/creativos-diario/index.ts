// creativos-diario · Edge Function (solo service role). 19-10-2026. SOLO LEE de Meta (GET de insights): no toca anuncios.
// Cron 06:00 PY: últimos 3 días. A mano: {desde:"2026-10-16", hasta:"2026-10-19"}.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { GRAPH_VERSION } from "../_shared/meta_capi.ts";
import { filaCreativo } from "./logica.ts";

const CUENTA = "1829928881223795";
const CAMPOS = "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,inline_link_clicks,inline_link_click_ctr,actions,date_start";
const diaPY = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { desde?: string; hasta?: string };
    const hoy = new Date();
    const hasta = b.hasta ?? diaPY(hoy), desde = b.desde ?? diaPY(new Date(hoy.getTime() - 2 * 86_400_000));
    const token = Deno.env.get("META_ADS_TOKEN") || Deno.env.get("META_CAPI_TOKEN");
    if (!token) throw new Error("Falta META_ADS_TOKEN");
    let url: string | null = `https://graph.facebook.com/${GRAPH_VERSION}/act_${CUENTA}/insights?level=ad&time_increment=1&limit=200&fields=${CAMPOS}&time_range=${encodeURIComponent(JSON.stringify({ since: desde, until: hasta }))}`;
    const filas = [];
    for (let i = 0; url && i < 20; i++) {
      if (!url.startsWith("https://graph.facebook.com/")) throw new Error("paginación inesperada");
      const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      const j = await r.json().catch(() => ({})) as { data?: Record<string, unknown>[]; paging?: { next?: string }; error?: { message?: string } };
      if (!r.ok || j.error) throw new Error(`Meta ${r.status}: ${j.error?.message ?? "sin mensaje"}`);
      filas.push(...(j.data ?? []).map(filaCreativo));
      url = j.paging?.next ?? null;
    }
    if (filas.length) {
      const { error } = await db().from("creativos_diario").upsert(filas, { onConflict: "fecha,ad_id" });
      if (error) throw new Error(`creativos_diario: ${error.message}`);
    }
    console.log("creativos-diario", JSON.stringify({ desde, hasta, filas: filas.length }));
    return Response.json({ ok: true, desde, hasta, filas: filas.length, gasto: filas.reduce((s, f) => s + f.gasto, 0) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("creativos-diario:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
