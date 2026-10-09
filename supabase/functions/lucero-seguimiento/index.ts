// supabase/functions/lucero-seguimiento/index.ts · Dueño: W (09-10-2026)
// Cron 3 veces por día (migración 20261009000002). Solo service role / cron (_shared/auth_servicio.ts).
// Consulta la página pública de Lucero (envio.php?id=<EnvioID>) de las guías abiertas de Voltra y pasa
// los estados por el pipeline común de courier. Lógica en procesar.ts; I/O en io.ts.
// Config opcional: config_wa.lucero_seguimiento = {"activo": true, "tope": 30, "pausa_ms": 3000}.
// Responde enseguida (202) y procesa en segundo plano: 30 consultas × 3 s no entran en el timeout del cron.
import { conServiceRole } from '../_shared/auth_servicio.ts'
import { avisar } from '../_shared/telegram.ts'
import { escaparHtml } from '../_shared/telegram_formato.ts'
import { depsReales, leerConfig } from './io.ts'
import { correrSeguimiento } from './procesar.ts'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

async function correr(): Promise<unknown> {
  const cfg = await leerConfig()
  if (!cfg.activo) return { ok: true, omitido: 'config_wa.lucero_seguimiento.activo = false' }
  return await correrSeguimiento(depsReales(cfg.importar), cfg.seguimiento)
}

Deno.serve(conServiceRole(async () => {
  const tarea = correr()
    .then((r) => console.log('lucero-seguimiento', JSON.stringify(r)))
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('lucero-seguimiento:', msg)
      await avisar(`<b>Seguimiento Lucero: la corrida falló</b>\n${escaparHtml(msg.slice(0, 500))}`).catch(() => {})
    })
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(tarea)
  else await tarea
  return Response.json({ ok: true, aceptado: true }, { status: 202 })
}))
