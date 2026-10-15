// supabase/functions/importar-courier/repo.ts
// ═══════════════════════════════════════════════════════════
// 13-10: I/O con la base del pipeline común de couriers, en UN solo lugar. Antes había tres copias
// (importar-courier/index.ts, pap-sync/repo.ts y lucero-seguimiento/io.ts) porque index.ts arranca
// Deno.serve al importarlo. Las tres funciones (pantalla Entregas, pap-sync y lucero-seguimiento) usan
// este archivo: un cambio acá vale para los tres caminos.
// ═══════════════════════════════════════════════════════════
import { db } from '../_shared/db.ts'
import { agregarTags, crearEventoEnvio, orderGid } from '../_shared/shopify.ts'
import { type ConfigImport, type IntentoAvisado, type PedidoImport, prefijoIntento, type Repo } from './procesar.ts'

export const COLS_PEDIDO =
  'shopify_order_id, nombre, cliente_id, telefono, total, estado_confirmacion, estado_envio, tags, es_borrador, raw, creado_en, wa_clientes(nombre)'

// deno-lint-ignore no-explicit-any
export function aPedido(row: any): PedidoImport {
  const { wa_clientes, ...resto } = row ?? {}
  return { ...resto, cliente_nombre: wa_clientes?.nombre ?? null }
}

/** config_wa: prefijos_courier y plazos_courier. */
export async function leerConfigCourier(): Promise<Pick<ConfigImport, 'prefijos' | 'plazos'>> {
  const { data, error } = await db().from('config_wa').select('clave, valor')
    .in('clave', ['prefijos_courier', 'plazos_courier'])
  if (error) throw new Error(`config_wa: ${error.message}`)
  const m = Object.fromEntries((data ?? []).map((r) => [r.clave, r.valor]))
  return configCourierDesde(m.prefijos_courier, m.plazos_courier)
}

/** Arma prefijos/plazos desde los valores de config_wa (lucero-seguimiento los lee junto con su propia clave). */
export function configCourierDesde(prefijos: unknown, plazos: unknown): Pick<ConfigImport, 'prefijos' | 'plazos'> {
  const pre = (prefijos && typeof prefijos === 'object' ? prefijos : {}) as Record<string, unknown>
  const pla = (plazos && typeof plazos === 'object' ? plazos : {}) as Record<string, unknown>
  const arr = (x: unknown) => Array.isArray(x) ? x.map(String) : typeof x === 'string' ? [x] : []
  return {
    // Sin la clave cargada rige el contrato: Lucero usa Codigo = "FW-" + número.
    prefijos: {
      lucero: 'lucero' in pre ? arr(pre.lucero) : ['FW-'],
      pap: 'pap' in pre ? arr(pre.pap) : [],
    },
    plazos: { lucero: String(pla.lucero ?? ''), pap: String(pla.pap ?? '') },
  }
}

export function repoCourier(): Repo {
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
        .upsert({ shopify_order_id: orderId, estado, fuente }, { onConflict: 'shopify_order_id,estado', ignoreDuplicates: true })
        .select('id')
      if (error) throw new Error(`pedido_estados: ${error.message}`)
      return Array.isArray(data) && data.length > 0
    },
    async avisoPendiente(orderId, estado) {
      // Estado guardado pero cuyo aviso no salió (falla anterior): se reintenta en vez de contarlo como repetido.
      const { data, error } = await s.from('pedido_estados').select('notificado')
        .eq('shopify_order_id', orderId).eq('estado', estado).maybeSingle()
      if (error) throw new Error(`pedido_estados: ${error.message}`)
      return data?.notificado === false
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
    async intentosAvisados(orderId) {
      // 13-10: un aviso por intento fallido. LIKE trata "_" como comodín: se vuelve a filtrar por el prefijo exacto.
      const pre = prefijoIntento(orderId)
      const { data, error } = await s.from('envios_programados').select('clave_unica, creado_en')
        .eq('shopify_order_id', orderId).like('clave_unica', `${pre}%`)
      if (error) throw new Error(`envios_programados (intentos): ${error.message}`)
      return ((data ?? []) as IntentoAvisado[])
        .filter((f) => f.clave_unica === pre || f.clave_unica.startsWith(`${pre}:`))
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
