// pago-qr-webhook · I/O real. Además exporta `ofrecerCobroQR(orderId)` para wa-webhook (G1):
// crea (o reutiliza) el cobro del pedido y devuelve la URL y el texto de la oferta.

import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { agregarTags, orderGid } from "../_shared/shopify.ts";
import { crearCobroQR } from "../_shared/pago_qr.ts";
import { configQR, type ConfigOla4QR, type CobroQR, type DepsPagoQR, textoOfertaQR } from "./procesar.ts";

export async function leerConfigQR(): Promise<ConfigOla4QR> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "ola4.qr").maybeSingle();
  if (error) throw new Error(`config_wa ola4.qr: ${error.message}`);
  return configQR(data?.valor);
}

/** Guarda el webhook crudo antes de procesarlo. false si ya estaba (reintento del proveedor). */
export async function guardarEventoQR(proveedor: string, idEvento: string, payload: unknown): Promise<boolean> {
  const { data, error } = await db().from("cobros_qr_eventos")
    .upsert({ proveedor, id_evento: idEvento, payload }, { onConflict: "proveedor,id_evento", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`guardarEventoQR: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

export async function marcarEventoProcesado(proveedor: string, idEvento: string, error: string | null): Promise<void> {
  await db().from("cobros_qr_eventos").update({ procesado_en: new Date().toISOString(), error })
    .eq("proveedor", proveedor).eq("id_evento", idEvento);
}

export const depsReales: DepsPagoQR = {
  buscarCobro: async (proveedor, idExterno) => {
    const { data, error } = await db().from("cobros_qr").select("id,shopify_order_id,proveedor,estado,monto,id_externo")
      .eq("proveedor", proveedor).eq("id_externo", idExterno).order("creado_en", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`buscarCobro: ${error.message}`);
    return data as CobroQR | null;
  },
  cambiarEstado: async (id, estado, extra) => {
    const { data, error } = await db().from("cobros_qr").update({ estado, ...extra })
      .eq("id", id).neq("estado", "pagado").select("id");
    if (error) throw new Error(`cambiarEstado: ${error.message}`);
    return Array.isArray(data) && data.length > 0;
  },
  leerPedido: async (orderId) => {
    const { data } = await db().from("shopify_pedidos").select("nombre,courier").eq("shopify_order_id", orderId).maybeSingle();
    return data as { nombre: string | null; courier: string | null } | null;
  },
  agregarTag: async (orderId, tag) => {
    const r = await agregarTags(orderGid(orderId), [tag]);
    if (r.ok) {
      const sb = db();
      const { data } = await sb.from("shopify_pedidos").select("tags").eq("shopify_order_id", orderId).maybeSingle();
      const tags = new Set<string>((data?.tags as string[] | null) ?? []);
      tags.add(tag);
      await sb.from("shopify_pedidos").update({ tags: [...tags] }).eq("shopify_order_id", orderId);
    }
    return { ok: r.ok, error: r.error };
  },
  avisar: (t) => avisar(t),
  escapar: escaparHtml,
  ahora: () => new Date(),
};

/**
 * Para wa-webhook (G1), después de que el cliente toca "Confirmar":
 * crea el cobro QR del pedido (uno activo por pedido; si ya hay uno pendiente, lo reutiliza).
 * Con la bandera ola4.qr apagada no hace nada.
 */
export async function ofrecerCobroQR(orderId: number): Promise<
  { ok: true; url: string; texto: string; simulado: boolean; reutilizado: boolean } | { ok: false; motivo: string }
> {
  const cfg = await leerConfigQR();
  if (!cfg.activo) return { ok: false, motivo: "bandera_apagada" };
  const sb = db();
  const { data: previo } = await sb.from("cobros_qr").select("url,estado,simulado")
    .eq("shopify_order_id", orderId).in("estado", ["pendiente", "pagado"]).limit(1).maybeSingle();
  if (previo?.estado === "pagado") return { ok: false, motivo: "ya_pagado" };
  if (previo?.url) {
    return { ok: true, url: previo.url as string, texto: textoOfertaQR(cfg, previo.url as string), simulado: !!previo.simulado, reutilizado: true };
  }
  const { data: ped } = await sb.from("shopify_pedidos").select("nombre,total,estado_confirmacion").eq("shopify_order_id", orderId).maybeSingle();
  if (!ped) return { ok: false, motivo: "sin_pedido" };
  if (!Number(ped.total)) return { ok: false, motivo: "sin_total" };
  const r = await crearCobroQR(
    { shopify_order_id: orderId, nombre: ped.nombre as string | null, total: Number(ped.total) },
    { validezHoras: cfg.validez_horas, etiqueta: cfg.etiqueta.replace("{pedido}", String(ped.nombre ?? orderId)) },
  );
  if (!r.ok || !r.url || !r.id_externo) return { ok: false, motivo: r.error ?? "error_proveedor" };
  const { error } = await sb.from("cobros_qr").insert({
    shopify_order_id: orderId,
    proveedor: r.proveedor,
    estado: "pendiente",
    monto: Number(ped.total),
    url: r.url,
    qr_texto: r.qr_texto ?? null,
    id_externo: r.id_externo,
    simulado: r.simulado,
    vence_en: new Date(Date.now() + cfg.validez_horas * 3_600_000).toISOString(),
  });
  if (error) {
    // Carrera: otro proceso creó el cobro activo a la vez (índice único parcial) → se usa ese.
    const { data: otro } = await sb.from("cobros_qr").select("url,simulado").eq("shopify_order_id", orderId).eq("estado", "pendiente").maybeSingle();
    if (otro?.url) return { ok: true, url: otro.url as string, texto: textoOfertaQR(cfg, otro.url as string), simulado: !!otro.simulado, reutilizado: true };
    return { ok: false, motivo: `guardar cobro: ${error.message}` };
  }
  return { ok: true, url: r.url, texto: textoOfertaQR(cfg, r.url), simulado: r.simulado, reutilizado: false };
}
