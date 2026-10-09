// supabase/functions/sync-gastos/index.ts · Dueño: A1 (09-10-2026)
// ═══════════════════════════════════════════════════════════
// Carga el gasto REAL facturado de Claude (Anthropic), WhatsApp (Meta) y ElevenLabs en
// public.gastos_proveedor_diario. Cron diario 06:30 de Asunción (migración 20261009000010).
// Resincroniza siempre los últimos 7 días (upsert por PK: idempotente). Cada proveedor aislado.
// Secretos (los carga Enrique; nunca se loguean): ANTHROPIC_ADMIN_KEY, WA_TOKEN, WA_WABA_ID,
// ELEVENLABS_API_KEY. Solo la service role o el cron con su llave pueden llamarla (conServiceRole).
// ═══════════════════════════════════════════════════════════
import { conServiceRole } from '../_shared/auth_servicio.ts'
import { depsReales } from './io.ts'
import { ejecutarSync } from './logica.ts'

Deno.serve(conServiceRole(async () => {
  try {
    const r = await ejecutarSync(depsReales())
    // Solo estados y conteos: nada de claves.
    console.log('sync-gastos', JSON.stringify(r.resultados.map(({ proveedor, estado, filas, total_usd }) => ({ proveedor, estado, filas, total_usd }))))
    return Response.json(r, { status: r.ok ? 200 : 502 })
  } catch (e) {
    console.error('sync-gastos', (e as Error)?.message ?? e)
    return Response.json({ ok: false, error: (e as Error)?.message ?? String(e) }, { status: 500 })
  }
}))
