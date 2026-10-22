// meta-lead-reenviar · PedidoConfirmado (web) a Meta (Enrique 22-10-2026). Corre en el cron de 10 min de esta función.
// Un pedido web (no ORIGEN_WHATSAPP) que pasa a confirmado → UN evento PedidoConfirmado al dataset de campañas web, con
// event_time = confirmado_en y los mismos datos de cliente que PedidoEntregado. Candado en eventos_crudos
// 'meta_confirmado:<id>'; si Meta falla, se suelta y se reintenta (Meta además deduplica por event_id). Nunca PRUEBA,
// nunca cancelados antes de enviarse, nunca con más de 7 días (Meta los rechaza).
import { db } from "../_shared/db.ts";
import {
  armarPayloadConfirmado, datosClienteDesdeRaw, dentroDePlazo, enviarAlDatasetPrincipal, type ResultadoEnvio,
} from "../_shared/meta_capi.ts";

export interface PedidoConfirmadoWeb {
  shopify_order_id: number; nombre: string; tags: string[]; estado_confirmacion: string | null; confirmado_en: string | null;
  cancelado: boolean; total: number; telefono: string | null; cliente_id: string | null; raw: Record<string, unknown> | null;
}

/** ¿Corresponde mandar PedidoConfirmado? (puro) */
export function motivoNoEnviar(p: PedidoConfirmadoWeb, ahora: Date): string | null {
  const tags = p.tags.map((t) => String(t).toUpperCase());
  if (!/^#\d+$/.test(p.nombre)) return "no_es_pedido";
  if (tags.includes("ORIGEN_WHATSAPP")) return "whatsapp";
  if (/prueba/i.test(p.nombre) || tags.some((t) => t.includes("PRUEBA"))) return "prueba";
  if (p.estado_confirmacion !== "confirmado" || !p.confirmado_en) return "sin_confirmar";
  if (p.cancelado) return "cancelado";
  if (!dentroDePlazo(p.confirmado_en, ahora)) return "mas_de_7_dias";
  return null;
}

export interface DepsConfirmado {
  candidatos(desdeIso: string): Promise<PedidoConfirmadoWeb[]>;
  tomarCandado(id: string): Promise<boolean>;
  soltarCandado(id: string): Promise<void>;
  registrar(id: string, r: ResultadoEnvio): Promise<void>;
  enviar(payload: unknown): Promise<ResultadoEnvio>;
}

export async function enviarConfirmadosWeb(d: DepsConfirmado, ahora = new Date(), opc: { simular?: boolean; testEventCode?: string | null } = {}) {
  const hechos: Array<{ pedido: string; resultado: string }> = [];
  const lista = await d.candidatos(new Date(ahora.getTime() - 7 * 86_400_000).toISOString());
  for (const p of lista) {
    const motivo = motivoNoEnviar(p, ahora);
    if (motivo) continue;
    const id = `meta_confirmado:${p.shopify_order_id}`;
    if (opc.simular) { hechos.push({ pedido: p.nombre, resultado: "se_enviaría" }); continue; }
    if (!(await d.tomarCandado(id))) continue; // ya enviado
    const payload = await armarPayloadConfirmado({
      pedido: { shopify_order_id: p.shopify_order_id, nombre: p.nombre, cliente_id: p.cliente_id },
      telefonoE164: p.telefono, valor: p.total, moneda: "PYG", cliente: datosClienteDesdeRaw(p.raw), confirmado_en: p.confirmado_en!,
    }, { ahora, testEventCode: opc.testEventCode ?? null });
    const r = await d.enviar(payload);
    if (!r.ok) await d.soltarCandado(id); else await d.registrar(id, r);
    hechos.push({ pedido: p.nombre, resultado: r.ok ? "enviado" : `error: ${r.error}` });
  }
  return hechos;
}

type Obj = Record<string, unknown>;
export const depsReales: DepsConfirmado = {
  async candidatos(desdeIso) {
    const { data, error } = await db().from("shopify_pedidos")
      .select("shopify_order_id,nombre,tags,estado_confirmacion,confirmado_en,total,telefono,cliente_id,raw")
      .eq("es_borrador", false).eq("estado_confirmacion", "confirmado").gte("confirmado_en", desdeIso);
    if (error) throw new Error(`shopify_pedidos: ${error.message}`);
    return (data ?? []).map((x: Obj) => ({
      shopify_order_id: Number(x.shopify_order_id), nombre: String(x.nombre ?? ""), tags: (x.tags ?? []) as string[],
      estado_confirmacion: (x.estado_confirmacion as string) ?? null, confirmado_en: (x.confirmado_en as string) ?? null,
      cancelado: !!(x.raw as Obj | null)?.cancelled_at, total: Number(x.total) || 0,
      telefono: (x.telefono as string) ?? null, cliente_id: (x.cliente_id as string) ?? null, raw: (x.raw as Obj) ?? null,
    }));
  },
  async tomarCandado(id) {
    const { error } = await db().from("eventos_crudos").insert({ fuente: "shopify", id_externo: id, payload: { evento: "PedidoConfirmado" } });
    if (!error) return true;
    if (error.code === "23505") return false;
    throw new Error(`eventos_crudos: ${error.message}`);
  },
  async soltarCandado(id) { await db().from("eventos_crudos").delete().eq("fuente", "shopify").eq("id_externo", id); },
  async registrar(id, r) {
    await db().from("eventos_crudos").update({ procesado_en: new Date().toISOString(), payload: { evento: "PedidoConfirmado", respuesta: r.respuesta ?? null } })
      .eq("fuente", "shopify").eq("id_externo", id);
  },
  enviar: (payload) => enviarAlDatasetPrincipal(payload),
};
