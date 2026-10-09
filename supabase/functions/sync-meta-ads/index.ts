// supabase/functions/sync-meta-ads/index.ts · Dueño: A2 (09-10-2026)
// Cron diario 10:00 de Asunción (migración 20261009000011). Solo service role / cron (_shared/auth_servicio.ts).
// Resincroniza SIEMPRE los últimos 7 días cerrados del gasto de Meta por conjunto → gasto_ads_diario.
// Lógica en logica.ts; I/O en io.ts. SOLO LECTURA sobre Meta.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { depsReales, leerConfig } from "./io.ts";
import { sincronizar } from "./logica.ts";

Deno.serve(conServiceRole(async () => {
  try {
    const cfg = await leerConfig();
    if (!cfg.activo) return Response.json({ ok: true, omitido: "config_wa.sync_meta_ads.activo = false" });
    const r = await sincronizar(depsReales(), { cuentas: cfg.cuentas, dias: cfg.dias });
    console.log("sync-meta-ads", JSON.stringify(r));
    const frenadas = r.cuentas.filter((c) => c.error);
    if (frenadas.length) {
      await avisar(`<b>Sync gasto Meta Ads: cuenta frenada</b>\n${frenadas.map((c) => escaparHtml(c.error)).join("\n")}`).catch(() => {});
    }
    return Response.json(r);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("sync-meta-ads:", msg);
    await avisar(`<b>Sync gasto Meta Ads: falló</b>\n${escaparHtml(msg.slice(0, 500))}`).catch(() => {});
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
