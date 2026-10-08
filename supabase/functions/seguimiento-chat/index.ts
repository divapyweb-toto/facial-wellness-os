// seguimiento-chat · Edge Function de cron (cada 10 min, migración 20261007000015). Solo service role / cron.
// Hasta 2 recontactos automáticos a clientes que dejaron en visto, dentro de la ventana de 24 h de WhatsApp.
// Config: config_wa.vendedor_seguimiento (semilla supabase/seed_seguimiento.sql). Lógica en logica.ts.
// Responde enseguida y procesa en segundo plano (cada turno del vendedor tarda varios segundos).
// Aviso por Telegram solo si algo falla (una vez por corrida).
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { depsReales } from "./io.ts";
import { correrSeguimientos } from "./logica.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve(conServiceRole(async () => {
  const tarea = correrSeguimientos(depsReales)
    .then((r) => console.log("seguimiento-chat", JSON.stringify(r)))
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("seguimiento-chat:", msg);
      await avisar(`<b>Recontactos automáticos: la corrida falló</b>\n${escaparHtml(msg.slice(0, 500))}`).catch(() => {});
    });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(tarea);
  else await tarea;
  return Response.json({ ok: true, aceptado: true }, { status: 202 });
}));
