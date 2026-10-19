import { assertEquals } from "@std/assert";
import { filaCreativo } from "./logica.ts";

Deno.test("insights de Meta → fila del libro (canal por campaña, acciones por tipo)", () => {
  const f = filaCreativo({
    ad_id: "1", ad_name: "VID JAWFLEX V4", campaign_name: "CAMPAÑA VENTAS WEB", spend: "34505", impressions: "4000", inline_link_clicks: "61",
    inline_link_click_ctr: "1.52", date_start: "2026-10-16",
    actions: [{ action_type: "landing_page_view", value: "40" }, { action_type: "offsite_conversion.fb_pixel_initiate_checkout", value: "6" },
      { action_type: "initiate_checkout", value: "6" }, { action_type: "offsite_conversion.fb_pixel_purchase", value: "3" }],
  });
  assertEquals([f.canal, f.gasto, f.clics, f.visitas, f.formularios, f.compras, f.conversaciones], ["web", 34505, 61, 40, 6, 3, 0]);
  const w = filaCreativo({ ad_id: "2", campaign_name: "CAMPAÑA VENTAS VOLTRA WHATSAPP", date_start: "2026-10-16",
    actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "9" }] });
  assertEquals([w.canal, w.conversaciones], ["whatsapp", 9]);
});
