// recuperar-borradores · I/O real (Supabase y WhatsApp).
import { db } from "../_shared/db.ts";
import { enviarPlantilla } from "../_shared/wa.ts";
import {
  type Borrador,
  configRecuperacion,
  type ConsentimientoCliente,
  type DepsRecuperar,
  type EstadoConsentimiento,
  TAG_BORRADOR_RELEASIT,
} from "./logica.ts";

async function estadoVigente(clienteId: string, tipo: "utilidad" | "marketing"): Promise<EstadoConsentimiento> {
  const { data, error } = await db().from("wa_consentimientos").select("estado")
    .eq("cliente_id", clienteId).eq("tipo", tipo).order("creado_en", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`consentimiento: ${error.message}`);
  return (data?.estado as EstadoConsentimiento) ?? null;
}

export const depsReales: DepsRecuperar = {
  ahora: () => new Date(),
  config: async () => {
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", "ola4.recuperacion").maybeSingle();
    if (error) throw new Error(`config_wa ola4.recuperacion: ${error.message}`);
    if (!data) console.log("recuperar-borradores: falta config_wa['ola4.recuperacion'] → bandera apagada");
    return configRecuperacion(data?.valor);
  },
  borradores: async (limite) => {
    const sb = db();
    const desde = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const { data, error } = await sb.from("shopify_pedidos")
      .select("shopify_order_id,nombre,cliente_id,telefono,tags,raw,creado_en")
      .eq("es_borrador", true).contains("tags", [TAG_BORRADOR_RELEASIT]).gte("creado_en", desde)
      .order("creado_en", { ascending: true }).limit(limite);
    if (error) throw new Error(`borradores: ${error.message}`);
    const filas = (data ?? []) as Borrador[];
    if (!filas.length) return [];
    const { data: ya } = await sb.from("recuperacion_borradores").select("draft_id")
      .in("draft_id", filas.map((f) => f.shopify_order_id));
    const vistos = new Set((ya ?? []).map((r) => Number(r.draft_id)));
    return filas.filter((f) => !vistos.has(Number(f.shopify_order_id))).map((f) => ({ ...f, tags: f.tags ?? [] }));
  },
  consentimiento: async (clienteId): Promise<ConsentimientoCliente> => {
    if (!clienteId) return { utilidad: null, marketing: null };
    return { utilidad: await estadoVigente(clienteId, "utilidad"), marketing: await estadoVigente(clienteId, "marketing") };
  },
  hayPedidoPosterior: async (telefono, desde) => {
    const { data, error } = await db().from("shopify_pedidos").select("shopify_order_id")
      .eq("telefono", telefono).eq("es_borrador", false).gte("creado_en", desde.toISOString()).limit(1);
    if (error) throw new Error(`hayPedidoPosterior: ${error.message}`);
    return (data ?? []).length > 0;
  },
  contactadoReciente: async (clienteId, _telefono, desde) => {
    if (!clienteId) return false;
    const { data, error } = await db().from("recuperacion_borradores").select("draft_id")
      .eq("cliente_id", clienteId).gte("creado_en", desde.toISOString()).limit(1);
    if (error) throw new Error(`contactadoReciente: ${error.message}`);
    return (data ?? []).length > 0;
  },
  reclamar: async (b) => {
    const { data, error } = await db().from("recuperacion_borradores")
      .upsert({ draft_id: b.shopify_order_id, estado: "enviando", cliente_id: b.cliente_id }, { onConflict: "draft_id", ignoreDuplicates: true })
      .select("draft_id");
    if (error) throw new Error(`reclamar: ${error.message}`);
    return Array.isArray(data) && data.length > 0;
  },
  enviar: (telefono, plantilla, componentes, b) => enviarPlantilla(telefono, plantilla, "es", componentes, { clienteId: b.cliente_id }),
  cerrar: async (b, estado, extra) => {
    await db().from("recuperacion_borradores").update({
      estado,
      enviado_en: estado === "enviado" ? new Date().toISOString() : null,
      wa_message_id: extra.wa_message_id ?? null,
      error: extra.error ?? null,
    }).eq("draft_id", b.shopify_order_id);
  },
};
