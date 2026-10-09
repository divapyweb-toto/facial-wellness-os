// supabase/functions/pap-sync/repo.ts
// I/O con la base para pap-sync.
//
// repoCourier() y leerConfigCourier() son COPIA de repoSupabase()/leerConfig() de
// importar-courier/index.ts: allá no están exportadas y ese archivo arranca Deno.serve al
// importarlo. Si cambian allá, cambiarlas acá. [Pendiente para el dueño de importar-courier:
// moverlas a importar-courier/repo.ts y que las dos funciones las importen.]
import { db } from '../_shared/db.ts'
import { agregarTags, crearEventoEnvio, orderGid } from '../_shared/shopify.ts'
import type { ConfigImport, PedidoImport, Repo } from '../importar-courier/procesar.ts'
import { ESTADO_INICIAL, type EstadoSync } from './logica.ts'
import type { TipoEvento } from './sync.ts'

const COLS_PEDIDO =
  'shopify_order_id, nombre, cliente_id, telefono, total, estado_confirmacion, estado_envio, tags, es_borrador, raw, creado_en, wa_clientes(nombre)'

// deno-lint-ignore no-explicit-any
function aPedido(row: any): PedidoImport {
  const { wa_clientes, ...resto } = row ?? {}
  return { ...resto, cliente_nombre: wa_clientes?.nombre ?? null }
}

export async function leerConfigCourier(): Promise<Pick<ConfigImport, 'prefijos' | 'plazos'>> {
  const { data, error } = await db().from('config_wa').select('clave, valor')
    .in('clave', ['prefijos_courier', 'plazos_courier'])
  if (error) throw new Error(`config_wa: ${error.message}`)
  const m = Object.fromEntries((data ?? []).map((r) => [r.clave, r.valor]))
  const pre = m.prefijos_courier ?? {}
  const arr = (x: unknown) => Array.isArray(x) ? x.map(String) : typeof x === 'string' ? [x] : []
  return {
    prefijos: {
      lucero: 'lucero' in pre ? arr(pre.lucero) : ['FW-'],
      pap: 'pap' in pre ? arr(pre.pap) : [],
    },
    plazos: { lucero: m.plazos_courier?.lucero ?? '', pap: m.plazos_courier?.pap ?? '' },
  }
}

export function repoCourier(): Repo {
  const s = db()
  return {
    async buscarPedidoPorNumero(numero) {
      const { data, error } = await s.from('shopify_pedidos').select(COLS_PEDIDO)
        .in('nombre', [`#${numero}`, numero]).eq('es_borrador', false).limit(2)
      if (error) throw new Error(`buscar pedido: ${error.message}`)
      return data && data.length === 1 ? aPedido(data[0]) : null
    },
    async buscarPedidosPorTelefono(tel) {
      const { data, error } = await s.from('shopify_pedidos').select(COLS_PEDIDO)
        .eq('telefono', tel).order('creado_en', { ascending: false }).limit(10)
      if (error) throw new Error(`buscar por teléfono: ${error.message}`)
      return (data ?? []).map(aPedido)
    },
    async avisoPendiente(orderId, estado) {
      // Estado guardado pero cuyo aviso no salió (falla anterior): se reintenta en vez de contarlo como repetido.
      const { data, error } = await s.from('pedido_estados').select('notificado')
        .eq('shopify_order_id', orderId).eq('estado', estado).maybeSingle()
      if (error) throw new Error(`pedido_estados: ${error.message}`)
      return data?.notificado === false
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

// ─── Estado del sincronizador (migración 20261009000003_pap_sync.sql) ──
const CAMPOS_ESTADO = Object.keys(ESTADO_INICIAL) as (keyof EstadoSync)[]

export const estadoSupabase = {
  async leer(): Promise<EstadoSync> {
    const { data, error } = await db().from('pap_sync_estado').select(CAMPOS_ESTADO.join(', ')).eq('id', 1).maybeSingle()
    if (error) throw new Error(`pap_sync_estado: ${error.message}`)
    return { ...ESTADO_INICIAL, ...((data ?? {}) as Partial<EstadoSync>) }
  },
  async guardar(e: EstadoSync): Promise<void> {
    const fila: Record<string, unknown> = { id: 1, actualizado_en: new Date().toISOString() }
    for (const k of CAMPOS_ESTADO) fila[k] = e[k]
    const { error } = await db().from('pap_sync_estado').upsert(fila, { onConflict: 'id' })
    if (error) throw new Error(`pap_sync_estado: ${error.message}`)
  },
  async registrarEvento(tipo: TipoEvento, detalle: Record<string, unknown>): Promise<void> {
    const { error } = await db().from('pap_sync_eventos').insert({ tipo, detalle })
    if (error) console.error('pap_sync_eventos', error.message)
  },
  async contarEventos(tipo: TipoEvento, desdeISO: string): Promise<number> {
    const { count, error } = await db().from('pap_sync_eventos').select('id', { count: 'exact', head: true })
      .eq('tipo', tipo).gte('creado_en', desdeISO)
    if (error) throw new Error(`pap_sync_eventos: ${error.message}`)
    return count ?? 0
  },
}
