// creativos-diario · lógica pura: fila de insights de Meta (nivel anuncio, por día) → fila de creativos_diario.
type Obj = Record<string, unknown>;
const n = (x: unknown) => Number(x) || 0;
export const accion = (acts: unknown, tipos: string[]) =>
  Math.max(0, ...((acts ?? []) as Obj[]).filter((a) => tipos.includes(String(a.action_type))).map((a) => n(a.value)));

export function filaCreativo(x: Obj) {
  const campana = String(x.campaign_name ?? "");
  return {
    fecha: String(x.date_start),
    ad_id: String(x.ad_id),
    ad_nombre: String(x.ad_name ?? ""),
    adset_id: String(x.adset_id ?? ""),
    adset_nombre: String(x.adset_name ?? ""),
    campana_id: String(x.campaign_id ?? ""),
    campana_nombre: campana,
    canal: /WHATSAPP/i.test(campana) ? "whatsapp" : "web",
    gasto: n(x.spend),
    impresiones: n(x.impressions),
    clics: n(x.inline_link_clicks),
    ctr: x.inline_link_click_ctr == null ? null : n(x.inline_link_click_ctr),
    visitas: accion(x.actions, ["landing_page_view", "omni_landing_page_view"]),
    formularios: accion(x.actions, ["initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout", "omni_initiated_checkout"]),
    compras: accion(x.actions, ["purchase", "offsite_conversion.fb_pixel_purchase", "omni_purchase"]),
    conversaciones: accion(x.actions, ["onsite_conversion.messaging_conversation_started_7d"]),
    actualizado_en: new Date().toISOString(),
  };
}
