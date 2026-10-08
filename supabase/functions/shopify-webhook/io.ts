// I/O real (Supabase) para procesarPedido. Lo comparten shopify-webhook y shopify-conciliar.
import { db } from "../_shared/db.ts";
import { normalizarTelefonoPY } from "../_shared/telefono.ts";
import type { ConfigConfirmacion, Deps } from "./procesar.ts";

export function depsReales(): Deps {
  const sb = db();
  return {
    normalizarTelefono: normalizarTelefonoPY,
    ahora: () => new Date(),

    async leerConfigConfirmacion() {
      const { data, error } = await sb.from("config_wa").select("valor").eq("clave", "confirmacion").maybeSingle();
      if (error) throw new Error(`config_wa: ${error.message}`);
      const v = data?.valor as ConfigConfirmacion | undefined;
      if (!v || typeof v.recordatorio_h !== "number" || typeof v.retener_h !== "number" || typeof v.cancelar_h !== "number") {
        throw new Error("config_wa.confirmacion falta o está incompleta");
      }
      return v;
    },

    async buscarPedido(id) {
      const { data, error } = await sb.from("shopify_pedidos")
        .select("estado_confirmacion, es_borrador").eq("shopify_order_id", id).maybeSingle();
      if (error) throw new Error(`buscarPedido: ${error.message}`);
      return data ?? null;
    },

    async upsertCliente({ telefono, nombre }) {
      // No pisa un nombre ya guardado (puede venir del chat).
      const { data: ya, error: e1 } = await sb.from("wa_clientes").select("id, nombre").eq("telefono", telefono).maybeSingle();
      if (e1) throw new Error(`upsertCliente: ${e1.message}`);
      if (ya) {
        if (!ya.nombre && nombre) await sb.from("wa_clientes").update({ nombre }).eq("id", ya.id);
        return ya.id as string;
      }
      const { data, error } = await sb.from("wa_clientes")
        .upsert({ telefono, nombre }, { onConflict: "telefono" }).select("id").single();
      if (error) throw new Error(`upsertCliente: ${error.message}`);
      return data.id as string;
    },

    async upsertPedido(p) {
      const { error } = await sb.from("shopify_pedidos").upsert(p, { onConflict: "shopify_order_id" });
      if (error) throw new Error(`upsertPedido: ${error.message}`);
    },

    async programarEnvios(filas) {
      if (!filas.length) return;
      const { error } = await sb.from("envios_programados")
        .upsert(filas, { onConflict: "clave_unica", ignoreDuplicates: true });
      if (error) throw new Error(`programarEnvios: ${error.message}`);
    },

    async dispararEnvios() {
      // Misma puerta que el cron: JWT del proyecto (anon) para la entrada + llave propia x-cron-secret.
      const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), secreto = Deno.env.get("CRON_SECRET");
      if (!url || !anon || !secreto) return;
      const p = fetch(`${url}/functions/v1/procesar-envios`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, "x-cron-secret": secreto },
        body: JSON.stringify({ origen: "shopify-webhook" }),
      }).then(() => {}).catch((e) => console.warn("dispararEnvios:", e instanceof Error ? e.message : e));
      // Sin frenar la respuesta a Shopify: la función sigue viva hasta que termine el envío.
      const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
      if (rt) rt.waitUntil(p);
      else await p;
    },

    async cancelarEnviosPendientes(id) {
      const { error } = await sb.from("envios_programados")
        .update({ estado: "cancelado" }).eq("shopify_order_id", id).eq("estado", "pendiente");
      if (error) throw new Error(`cancelarEnviosPendientes: ${error.message}`);
    },
  };
}

export async function marcarEvento(idExterno: string, error: string | null) {
  await db().from("eventos_crudos")
    .update({ procesado_en: new Date().toISOString(), error })
    .eq("fuente", "shopify").eq("id_externo", idExterno);
}
