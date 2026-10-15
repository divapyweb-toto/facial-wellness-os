// supabase/functions/importar-courier/index.ts
// ═══════════════════════════════════════════════════════════
// POST { courier: 'lucero'|'pap', filas: [{referencia, estado_crudo, telefono, fecha, extra}] }
// Las filas llegan YA parseadas por los parsers del navegador
// (src/lib/exportLucero.js, src/lib/importarPaP.js → src/lib/importarCourierWA.js).
// Requiere un usuario autenticado de Voltra OS (JWT de Supabase Auth).
// Devuelve { procesadas, avisos_programados, sin_pedido, repetidas, ... }.
// La lógica vive en procesar.ts; acá solo está el I/O.
// ═══════════════════════════════════════════════════════════
import { db, guardarEventoCrudo } from '../_shared/db.ts'
import { normalizarTelefonoPY } from '../_shared/telefono.ts'
import type { Courier } from '../_shared/estados_courier.ts'
import { type FilaCourier, procesarFilas } from './procesar.ts'
// 13-10: el repo y la config viven en repo.ts (los usan también pap-sync y lucero-seguimiento).
import { leerConfigCourier, repoCourier } from './repo.ts'

const MAX_FILAS = 3000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

async function sha256(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Usá POST' }, 405)

  // 1. Usuario autenticado (no basta la anon key).
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'Falta iniciar sesión en Voltra OS' }, 401)
  const { data: auth, error: authErr } = await db().auth.getUser(token)
  if (authErr || !auth?.user) return json({ error: 'Sesión vencida: volvé a entrar a Voltra OS' }, 401)

  // 2. Validar el cuerpo.
  const raw = await req.text()
  let body: { courier?: string; filas?: FilaCourier[] }
  try { body = JSON.parse(raw) } catch { return json({ error: 'El cuerpo no es JSON' }, 400) }
  const courier = body.courier as Courier
  if (courier !== 'lucero' && courier !== 'pap') return json({ error: "courier tiene que ser 'lucero' o 'pap'" }, 400)
  if (!Array.isArray(body.filas)) return json({ error: 'Faltan las filas' }, 400)
  if (body.filas.length > MAX_FILAS) return json({ error: `Máximo ${MAX_FILAS} filas por envío; partí el archivo` }, 413)

  try {
    // 3. Auditoría: el lote tal cual llegó (idempotente por hash del cuerpo).
    const idLote = await sha256(raw)
    await guardarEventoCrudo('courier', `${courier}:${idLote}`, { ...body, usuario: auth.user.id })
      .catch((e) => console.error('eventos_crudos', e))

    // 4. Procesar.
    const cfg = await leerConfigCourier()
    const resumen = await procesarFilas(courier, body.filas, repoCourier(), {
      ...cfg,
      ahora: new Date(),
      normalizarTelefono: normalizarTelefonoPY,
    })

    await db().from('eventos_crudos')
      .update({ procesado_en: new Date().toISOString(), error: resumen.errores.length ? resumen.errores.slice(0, 20).join(' | ') : null })
      .eq('fuente', 'courier').eq('id_externo', `${courier}:${idLote}`)

    return json(resumen)
  } catch (e) {
    console.error('importar-courier', e)
    return json({ error: `No se pudo importar: ${(e as Error)?.message ?? e}` }, 500)
  }
})
