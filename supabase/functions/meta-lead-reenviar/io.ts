// meta-lead-reenviar · I/O real (Supabase). La parte de Meta y el candado son los de shopify-webhook (depsLeadMetaReales).
import { db } from "../_shared/db.ts";
import { depsLeadMetaReales } from "../shopify-webhook/io.ts";
import type { Candidato, DepsReenvio } from "./logica.ts";

export function depsReales(): DepsReenvio {
  const sb = db();
  return {
    lead: depsLeadMetaReales(),
    async candidatos(desde) {
      const { data, error } = await sb.from("shopify_pedidos")
        .select("shopify_order_id,nombre,cliente_id,total,creado_en,tags,estado_confirmacion,raw->>created_at")
        .eq("es_borrador", false).not("cliente_id", "is", null).gte("creado_en", desde)
        .order("creado_en", { ascending: true });
      if (error) throw new Error(`shopify_pedidos: ${error.message}`);
      return (data ?? [])
        .filter((p) => !((p.tags ?? []) as string[]).some((t) => t.toUpperCase() === "PRUEBA_E2E"))
        .map((p): Candidato => ({
          shopifyOrderId: Number(p.shopify_order_id),
          nombre: String(p.nombre ?? p.shopify_order_id),
          clienteId: String(p.cliente_id),
          total: p.total === null ? null : Number(p.total),
          creadoEn: (p as { created_at?: string }).created_at ?? p.creado_en,
          confirmado: p.estado_confirmacion === "confirmado",
        }));
    },
    async existeCandado(id) {
      const { count, error } = await sb.from("eventos_crudos").select("id", { count: "exact", head: true })
        .eq("fuente", "shopify").eq("id_externo", id);
      if (error) throw new Error(`eventos_crudos: ${error.message}`);
      return (count ?? 0) > 0;
    },
  };
}
