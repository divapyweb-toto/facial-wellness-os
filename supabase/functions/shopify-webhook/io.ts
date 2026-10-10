// I/O real (Supabase) para procesarPedido. Lo comparten shopify-webhook y shopify-conciliar.
import { db, guardarEventoCrudo } from "../_shared/db.ts";
import { normalizarTelefonoPY } from "../_shared/telefono.ts";
import { gql } from "../_shared/shopify.ts";
import { avisar } from "../_shared/telegram.ts";
import { configLead, enviarEventoLead } from "../_shared/meta_capi.ts";
import { type DepsLeadMeta, notificarLeadMeta } from "./lead_meta.ts";
import { type ConfigConfirmacion, configConfirmacionValida, type Deps } from "./procesar.ts";

/** I/O real del evento temprano a Meta (lead_meta.ts). */
export function depsLeadMetaReales(): DepsLeadMeta {
  const sb = db();
  return {
    config: () => configLead(),
    ahora: () => new Date(),
    async origenAnuncio(clienteId, desde, hasta) {
      // Mismo criterio que post-entrega: último mensaje entrante del cliente con referral.ctwa_clid.
      const { data, error } = await sb.from("wa_mensajes").select("contenido")
        .eq("cliente_id", clienteId).eq("direccion", "in")
        .not("contenido->referral->>ctwa_clid", "is", null)
        .gte("creado_en", desde).lte("creado_en", hasta)
        .order("creado_en", { ascending: false }).limit(1);
      if (error) throw new Error(`wa_mensajes: ${error.message}`);
      const ref = data?.[0]?.contenido?.referral;
      return ref?.ctwa_clid ? { ctwa_clid: String(ref.ctwa_clid) } : null;
    },
    reservar: (idExterno, payload) => guardarEventoCrudo("shopify", idExterno, payload),
    async registrar(idExterno, error) {
      const r = await sb.from("eventos_crudos").update({ procesado_en: new Date().toISOString(), error })
        .eq("fuente", "shopify").eq("id_externo", idExterno);
      if (r.error) throw new Error(`eventos_crudos: ${r.error.message}`);
    },
    enviar: (e, cfg) => enviarEventoLead(e, cfg, { timeoutMs: 5000 }),
  };
}

/** `leadMeta`: solo shopify-webhook manda el evento temprano a Meta (shopify-conciliar no). */
export function depsReales(opciones: { leadMeta?: boolean } = {}): Deps {
  const sb = db();
  return {
    ...(opciones.leadMeta
      ? {
        notificarPedidoMeta(p: Parameters<NonNullable<Deps["notificarPedidoMeta"]>>[0]) {
          const t = notificarLeadMeta(p, depsLeadMetaReales())
            .then((r) => console.log("meta_lead", p.shopifyOrderId, JSON.stringify(r)))
            .catch((e) => console.warn("meta_lead:", e instanceof Error ? e.message : e));
          // Sin frenar nada: la función sigue viva hasta que termine el envío.
          const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
          if (rt) rt.waitUntil(t);
          return t;
        },
      }
      : {}),
    normalizarTelefono: normalizarTelefonoPY,
    ahora: () => new Date(),

    async leerConfigConfirmacion() {
      const { data, error } = await sb.from("config_wa").select("valor").eq("clave", "confirmacion").maybeSingle();
      if (error) throw new Error(`config_wa: ${error.message}`);
      // 10-10: acepta la config nueva (recordatorio_min, aviso_enrique_h, ultimo_aviso_h) y la vieja (recordatorio_h, retener_h).
      if (!configConfirmacionValida(data?.valor)) throw new Error("config_wa.confirmacion falta o está incompleta");
      return data!.valor as ConfigConfirmacion;
    },

    async buscarPedido(id) {
      const { data, error } = await sb.from("shopify_pedidos")
        .select("estado_confirmacion, es_borrador, estado_envio").eq("shopify_order_id", id).maybeSingle();
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

    async revertirPreparado(orderId) {
      const d = await gql<{ order: { fulfillments: Array<{ id: string; status: string }> } | null }>(
        `query($id: ID!) { order(id: $id) { fulfillments(first: 10) { id status } } }`, { id: `gid://shopify/Order/${orderId}` });
      const activos = (d.order?.fulfillments ?? []).filter((f) => f.status === "SUCCESS" || f.status === "OPEN");
      for (const f of activos) {
        const r = await gql<{ fulfillmentCancel: { userErrors: Array<{ message: string }> } }>(
          `mutation($id: ID!) { fulfillmentCancel(id: $id) { userErrors { message } } }`, { id: f.id });
        const e = r.fulfillmentCancel.userErrors ?? [];
        if (e.length) return { ok: false, error: e.map((x) => x.message).join("; ") };
      }
      return { ok: true };
    },

    avisar: (texto) => avisar(texto),

    async courierDePedido(nombrePedido) {
      const n = String(nombrePedido ?? "").replace(/\D/g, "");
      if (!n) return null;
      const { data, error } = await sb.from("ventas").select("transportadora").eq("n_referencia", `VT-${n}`)
        .is("deleted_at", null).limit(1).maybeSingle();
      if (error) throw new Error(`ventas: ${error.message}`);
      return (data?.transportadora as string | undefined) ?? null;
    },

    async cancelarEnviosPendientes(id, opts) {
      // Los avisos de envío (courier:…, "ya salió" / "hoy te llega") no son de la confirmación: solo se cancelan
      // si el pedido se canceló.
      let q = sb.from("envios_programados").update({ estado: "cancelado" }).eq("shopify_order_id", id).eq("estado", "pendiente");
      if (!opts?.incluirAvisos) q = q.not("clave_unica", "like", "courier:%");
      // 10-10: el "dimos de baja tu pedido" (cmsg:) se programa justo DESPUÉS de cancelar en Shopify; el webhook
      // orders/updated de esa misma cancelación no lo tiene que frenar (procesar-envios lo manda solo si quedó
      // cancelado_sin_respuesta).
      q = q.or("clave_unica.is.null,clave_unica.not.like.cmsg:*");
      const { error } = await q;
      if (error) throw new Error(`cancelarEnviosPendientes: ${error.message}`);
    },
  };
}

export async function marcarEvento(idExterno: string, error: string | null) {
  await db().from("eventos_crudos")
    .update({ procesado_en: new Date().toISOString(), error })
    .eq("fuente", "shopify").eq("id_externo", idExterno);
}
