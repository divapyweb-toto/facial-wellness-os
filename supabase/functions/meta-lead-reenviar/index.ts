// meta-lead-reenviar · Edge Function (solo service role).
// Cron cada 10 min (body {origen:"pg_cron"}): manda lo pendiente de LeadSubmitted y Purchase (logica.ts → automatico).
// A mano: {modo?: "listar"|"prueba"|"enviar", evento?: "LeadSubmitted"|"Purchase", test_event_code?, pedidos?: ["#1032"]}.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { depsReales } from "./io.ts";
import { automatico, type Modo, reenviar } from "./logica.ts";
import { EVENTO_PURCHASE } from "../_shared/meta_capi.ts";

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { modo?: Modo; evento?: string; test_event_code?: string; pedidos?: string[]; origen?: string };
    if (b.origen === "pg_cron") {
      const r = await automatico(depsReales());
      console.log("meta-lead-reenviar cron", JSON.stringify(r));
      return Response.json({ ok: true, ...r });
    }
    const evento = b.evento === EVENTO_PURCHASE ? EVENTO_PURCHASE : "LeadSubmitted";
    const modo: Modo = b.modo === "prueba" || b.modo === "enviar" ? b.modo : "listar";
    const r = await reenviar(modo, { testEventCode: b.test_event_code ?? null, pedidos: b.pedidos, evento }, depsReales());
    console.log("meta-lead-reenviar", JSON.stringify({ modo, filas: r.filas, prueba: r.prueba }));
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("meta-lead-reenviar:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
