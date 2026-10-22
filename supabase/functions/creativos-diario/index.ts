// creativos-diario · Edge Function (solo service role). 19-10-2026. SOLO LEE de Meta (GET de insights): no toca anuncios.
// Cron 06:00 PY: últimos 7 días (22-10: antes 3; una respuesta floja de Meta un día se corrige sola al siguiente). A mano: {desde:"2026-10-16", hasta:"2026-10-19"}.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { GRAPH_VERSION } from "../_shared/meta_capi.ts";
import { filaCreativo } from "./logica.ts";
import { avisar } from "../_shared/telegram.ts";
import { diasFueraDeRango, type FilaControl } from "./control.ts";

const CUENTA = "1829928881223795";
const CAMPOS = "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,inline_link_clicks,inline_link_click_ctr,actions,date_start";
const diaPY = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);


async function traer(token: string, desde: string, hasta: string) {
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
  return filas;
}

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { desde?: string; hasta?: string };
    const hoy = new Date();
    const hasta = b.hasta ?? diaPY(hoy), desde = b.desde ?? diaPY(new Date(hoy.getTime() - 6 * 86_400_000));
    const token = Deno.env.get("META_ADS_TOKEN") || Deno.env.get("META_CAPI_TOKEN");
    if (!token) throw new Error("Falta META_ADS_TOKEN");
    const filas = await traer(token, desde, hasta);
    if (filas.length) {
      const { error } = await db().from("creativos_diario").upsert(filas, { onConflict: "fecha,ad_id" });
      if (error) throw new Error(`creativos_diario: ${error.message}`);
    }
    // 22-10: control contra gasto_ads_anuncio_diario (la fuente de la pausa del socio). Solo días ya cerrados en las dos
    // tablas (hasta anteayer): ayer puede estar todavía sin cargar en la otra. Si no coincide (>2 %), se vuelve a pedir
    // a Meta esos días UNA vez; si sigue mal, Telegram una vez por día.
    const control = await controlar(token, hoy);
    console.log("creativos-diario", JSON.stringify({ desde, hasta, filas: filas.length, control }));
    return Response.json({ ok: true, desde, hasta, filas: filas.length, gasto: filas.reduce((s, f) => s + f.gasto, 0), control });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("creativos-diario:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));

async function leerControl(): Promise<FilaControl[]> {
  const { data, error } = await db().from("creativos_control_gasto").select("fecha,creativos,anuncio_diario");
  if (error) throw new Error(`creativos_control_gasto: ${error.message}`);
  return (data ?? []).map((x: Record<string, unknown>) => ({ fecha: String(x.fecha), creativos: Number(x.creativos) || 0, anuncio: x.anuncio_diario == null ? null : Number(x.anuncio_diario) }));
}

async function controlar(token: string, hoy: Date) {
  try {
    const limite = diaPY(new Date(hoy.getTime() - 2 * 86_400_000));
    const desdeControl = diaPY(new Date(hoy.getTime() - 9 * 86_400_000));
    const malos = (f: FilaControl[]) => diasFueraDeRango(f, desdeControl, limite);
    let fuera = malos(await leerControl());
    if (!fuera.length) return { fuera_de_rango: [] as string[] };
    const rec = await traer(token, fuera[0].fecha, fuera[fuera.length - 1].fecha);
    if (rec.length) await db().from("creativos_diario").upsert(rec, { onConflict: "fecha,ad_id" });
    fuera = malos(await leerControl());
    for (const f of fuera) {
      const id = `auto_creativos_control:${f.fecha}`;
      const { error } = await db().from("eventos_crudos").insert({ fuente: "shopify", id_externo: id, payload: { fecha: f.fecha }, procesado_en: new Date().toISOString() });
      if (!error) {
        await avisar(`⚠ El gasto del libro de creativos del ${f.fecha} (Gs ${f.creativos.toLocaleString("es-PY")}) no coincide con el gasto por anuncio (Gs ${(f.anuncio ?? 0).toLocaleString("es-PY")}). La pausa automática lee el libro: revisalo.`).catch(() => null);
      }
    }
    return { fuera_de_rango: fuera.map((f) => f.fecha), recargado: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
