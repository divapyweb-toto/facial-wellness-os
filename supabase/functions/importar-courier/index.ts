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
import { agregarTags, crearEventoEnvio, orderGid } from '../_shared/shopify.ts'
import type { Courier } from '../_shared/estados_courier.ts'
import { type ConfigImport, type FilaCourier, type PedidoImport, procesarFilas, type Repo } from './procesar.ts'

const MAX_FILAS = 3000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const COLS_PEDIDO =
  'shopify_order_id, nombre, cliente_id, telefono, total, estado_confirmacion, estado_envio, tags, es_borrador, raw, creado_en, wa_clientes(nombre)'

// deno-lint-ignore no-explicit-any
function aPedido(row: any): PedidoImport {
  const { wa_clientes, ...resto } = row ?? {}
  return { ...resto, cliente_nombre: wa_clientes?.nombre ?? null }
}

async function sha256(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function leerConfig(): Promise<Pick<ConfigImport, 'prefijos' | 'plazos'>> {
  const { data, error } = await db().from('config_wa').select('clave, valor')
    .in('clave', ['prefijos_courier', 'plazos_courier'])
  if (error) throw new Error(`config_wa: ${error.message}`)
  const m = Object.fromEntries((data ?? []).map((r) => [r.clave, r.valor]))
  const pre = m.prefijos_courier ?? {}
  const arr = (x: unknown) => Array.isArray(x) ? x.map(String) : typeof x === 'string' ? [x] : []
  return {
    // Sin la clave cargada rige el contrato: Lucero usa Codigo = "FW-" + número.
    prefijos: {
      lucero: 'lucero' in pre ? arr(pre.lucero) : ['FW-'],
      pap: 'pap' in pre ? arr(pre.pap) : [],
    },
    plazos: { lucero: m.plazos_courier?.lucero ?? '', pap: m.plazos_courier?.pap ?? '' },
  }
}

function repoSupabase(): Repo {
  const s = db()
  return {
    async buscarPedidoPorNumero(numero) {
      const { data, error } = await s.from('shopify_pedidos').select(COLS_PEDIDO)
        .in('nombre', [`#${numero}`, numero]).eq('es_borrador', false).limit(2)
      if (error) throw new Error(`buscar pedido: ${error.message}`)
      // Dos pedidos con el mismo nombre no deberían existir; si pasa, no se adivina.
      return data && data.length === 1 ? aPedido(data[0]) : null
    },
    async buscarPedidosPorTelefono(tel) {
      const { data, error } = await s.from('shopify_pedidos').select(COLS_PEDIDO)
        .eq('telefono', tel).order('creado_en', { ascending: false }).limit(10)
      if (error) throw new Error(`buscar por teléfono: ${error.message}`)
      return (data ?? []).map(aPedido)
    },
    async insertarEstado(orderId, estado, fuente) {
      const { data, error } = await s.from('pedido_estados')
        .upsert({ shopify_order_id: orderId, estado, fuente },
          { onConflict: 'shopify_order_id,estado', ignoreDuplicates: true })
        .select('id')
      if (error) throw new Error(`pedido_estados: ${error.message}`)
      return Array.isArray(data) && data.length > 0
    },
    async marcarNotificado(orderId, estado) {
      const { error } = await s.from('pedido_estados').update({ notificado: true })
        .eq('shopify_order_id', orderId).eq('estado', estado)
      if (error) throw new Error(`marcar notificado: ${error.message}`)
    },
    async actualizarEstadoEnvio(orderId, estado, courier) {
      const { error } = await s.from('shopify_pedidos').update({ estado_envio: estado, courier })
        .eq('shopify_order_id', orderId)
      if (error) throw new Error(`estado_envio: ${error.message}`)
    },
    async programarEnvio(envio) {
      const { data, error } = await s.from('envios_programados')
        .upsert(envio, { onConflict: 'clave_unica', ignoreDuplicates: true }).select('id')
      if (error) throw new Error(`envios_programados: ${error.message}`)
      return Array.isArray(data) && data.length > 0
    },
    async enviarARevision(courier, referencia, fila, motivo) {
      const { error } = await s.from('courier_revision').insert({ courier, referencia, fila, motivo })
      if (error) throw new Error(`courier_revision: ${error.message}`)
    },
    async crearEventoEnvio(orderId, estado) {
      const r = await crearEventoEnvio(orderGid(orderId), estado)
      return { ok: r.ok, error: r.error }
    },
    async agregarTags(orderId, tags) {
      const r = await agregarTags(orderGid(orderId), tags)
      return { ok: r.ok, error: r.error }
    },
  }
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
    const cfg = await leerConfig()
    const resumen = await procesarFilas(courier, body.filas, repoSupabase(), {
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
