// supabase/functions/sync-meta-ads/io.ts · Dueño: A2 (09-10-2026)
// I/O real: Graph API de Meta (SOLO GET de insights) y Supabase (productos lectura, gasto_ads_diario upsert).
// Token: secreto META_ADS_TOKEN (usuario del sistema con ads_read); si no existe, META_CAPI_TOKEN.
// Config opcional en config_wa.sync_meta_ads = {"activo": true, "dias": 7,
//   "cuentas": [{"id": "1829928881223795", "tienda": "voltra"}, {"id": "1075263797491391", "tienda": "fw"}]}
import { db } from "../_shared/db.ts";
import {
  type Cuenta,
  CUENTAS_DEFECTO,
  type Deps,
  DIAS_DEFECTO,
  GRAPH_BASE,
  type Existente,
  type FilaGasto,
  type PaginaInsights,
  type Producto,
} from "./logica.ts";

const TIMEOUT_MS = 30_000;

export function tokenMeta(): string {
  const t = Deno.env.get("META_ADS_TOKEN") || Deno.env.get("META_CAPI_TOKEN");
  if (!t) throw new Error("Falta el secreto META_ADS_TOKEN (o META_CAPI_TOKEN)");
  return t;
}

/** Mensaje de error de Meta legible, con la pista del permiso cuando corresponde. Nunca incluye el token. */
export function errorMeta(status: number, cuerpo: unknown): string {
  // deno-lint-ignore no-explicit-any
  const e = (cuerpo as any)?.error ?? {};
  let m = `Meta ${status}: (#${e.code ?? "?"}/${e.error_subcode ?? "-"}) ${e.message ?? "sin mensaje"}`;
  if (e.code === 200 || e.code === 10 || (e.code === 100 && e.error_subcode === 33) || e.code === 190) {
    m += " → el token no tiene ads_read o la cuenta publicitaria no está asignada al usuario del sistema";
  }
  return m;
}

export function depsReales(token = tokenMeta()): Deps {
  const s = db();
  return {
    async traerPagina(url) {
      if (!url.startsWith("https://graph.facebook.com/")) throw new Error("URL de paginación inesperada");
      const r = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const cuerpo = await r.json().catch(() => ({}));
      if (!r.ok || (cuerpo as { error?: unknown }).error) throw new Error(errorMeta(r.status, cuerpo));
      return cuerpo as PaginaInsights;
    },
    async monedaCuenta(cuentaId) {
      const c = await this.traerPagina(`${GRAPH_BASE}/act_${cuentaId}?fields=currency`) as unknown as { currency?: string };
      return String(c.currency ?? "");
    },
    async leerProductos() {
      const { data, error } = await s.from("productos")
        .select("id, nombre, es_combo, componente_1_id, componente_2_id").eq("activo", true);
      if (error) throw new Error(`productos: ${error.message}`);
      return (data ?? []) as Producto[];
    },
    async leerExistentes(tienda, desde, hasta) {
      const { data, error } = await s.from("gasto_ads_diario").select("fecha, adset_id, producto_id")
        .eq("tienda", tienda).gte("fecha", desde).lte("fecha", hasta);
      if (error) throw new Error(`gasto_ads_diario (lectura): ${error.message}`);
      return (data ?? []) as Existente[];
    },
    async borrarConjunto(tienda, fecha, adsetId) {
      // La fila sin repartir y los repartos anteriores de ese conjunto ese día (se reescriben enseguida).
      const { error } = await s.from("gasto_ads_diario").delete()
        .eq("tienda", tienda).eq("fecha", fecha).or(`adset_id.eq.${adsetId},adset_id.like.${adsetId}~*`);
      if (error) throw new Error(`gasto_ads_diario (borrar conjunto): ${error.message}`);
    },
    async upsertAnuncios(filas) {
      const { error } = await s.from("gasto_ads_anuncio_diario").upsert(filas, { onConflict: "fecha,ad_id" });
      if (error) throw new Error(`gasto_ads_anuncio_diario (upsert): ${error.message}`);
      return filas.length;
    },
    async upsert(filas: FilaGasto[]) {
      const { error } = await s.from("gasto_ads_diario").upsert(filas, { onConflict: "fecha,adset_id" });
      if (error) throw new Error(`gasto_ads_diario (upsert): ${error.message}`);
      return filas.length;
    },
  };
}

export async function leerConfig(): Promise<{ activo: boolean; cuentas: Cuenta[]; dias: number }> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "sync_meta_ads").maybeSingle();
  if (error) throw new Error(`config_wa: ${error.message}`);
  // deno-lint-ignore no-explicit-any
  const v: any = data?.valor ?? {};
  const cuentas: Cuenta[] = Array.isArray(v.cuentas)
    ? v.cuentas
      // deno-lint-ignore no-explicit-any
      .filter((c: any) => /^\d+$/.test(String(c?.id ?? "")) && (c?.tienda === "fw" || c?.tienda === "voltra"))
      // deno-lint-ignore no-explicit-any
      .map((c: any) => ({ id: String(c.id), tienda: c.tienda }))
    : CUENTAS_DEFECTO;
  const dias = Number.isInteger(v.dias) && v.dias >= 1 && v.dias <= 30 ? v.dias : DIAS_DEFECTO;
  return { activo: v.activo !== false, cuentas: cuentas.length ? cuentas : CUENTAS_DEFECTO, dias };
}
