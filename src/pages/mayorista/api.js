// src/pages/mayorista/api.js
// I/O de la pantalla "Pedido mayorista": Edge Function pedido-mayorista (catálogo y crear) y la lista
// (shopify_pedidos con tag MAYORISTA + pedido_datos_fiscales + facturas + facturas_retenidas).
import { supabase } from '../../lib/supabase'

/** Llama a la función y devuelve { status, body }. Nunca tira por un 4xx/5xx: el cuerpo trae el motivo. */
async function invocar(body) {
  const { data, error } = await supabase.functions.invoke('pedido-mayorista', { body })
  if (!error) return { status: 200, body: data || {} }
  let status = error.context?.status ?? 0
  let cuerpo = null
  try { cuerpo = await error.context?.json() } catch { /* sin cuerpo */ }
  if (!cuerpo) {
    const m = String(error.message || '')
    const sinFuncion = /not found|404|Failed to send|fetch/i.test(m)
    cuerpo = { ok: false, error: sinFuncion ? 'La función pedido-mayorista todavía no está desplegada (o no hay conexión).' : m }
    if (sinFuncion && !status) status = 404
  }
  return { status, body: cuerpo }
}

export async function cargarCatalogo() {
  const r = await invocar({ accion: 'catalogo' })
  if (!r.body?.ok) throw new Error(r.body?.error || 'No se pudo leer el catálogo de Shopify')
  return r.body.productos || []
}

/** { status, body: { ok, shopify_order_id, nombre, total, repetido, avisos, error, errores, reintentable } } */
export const crearPedido = (payload) => invocar(payload)

/** config_wa.sifen.facturar_desde (corte de facturación) o null. */
export async function leerCorte() {
  const { data, error } = await supabase.from('config_wa').select('valor').eq('clave', 'sifen').maybeSingle()
  if (error) return null
  const v = data?.valor?.facturar_desde
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

const porId = (filas) => {
  const m = new Map()
  for (const f of filas || []) {
    const k = Number(f.shopify_order_id)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(f)
  }
  return m
}

export async function cargarListaMayoristas() {
  const { data: pedidos, error } = await supabase.from('shopify_pedidos')
    .select('shopify_order_id, nombre, total, tags, estado_confirmacion, estado_envio, creado_en, entregado_en, telefono, dir_rest:raw->shipping_address, dir_gql:raw->shippingAddress')
    .contains('tags', ['MAYORISTA'])
    .order('creado_en', { ascending: false })
    .limit(200)
  if (error) throw error
  const ids = (pedidos || []).map(p => p.shopify_order_id)
  if (!ids.length) return []
  const [fis, fac, ret] = await Promise.all([
    supabase.from('pedido_datos_fiscales').select('shopify_order_id, ruc, dv, razon_social, condicion, plazo_dias, origen').in('shopify_order_id', ids),
    supabase.from('facturas').select('shopify_order_id, tipo_documento, estado, ambiente, numero_completo').in('shopify_order_id', ids),
    supabase.from('facturas_retenidas').select('shopify_order_id, motivo, liberado_en').in('shopify_order_id', ids),
  ])
  // Las tablas de facturas pueden no existir todavía (migraciones de P1): la lista se muestra igual.
  const mFis = porId(fis.error ? [] : fis.data)
  const mFac = porId(fac.error ? [] : fac.data)
  const mRet = porId(ret.error ? [] : ret.data)
  return pedidos.map(p => {
    const dir = p.dir_rest || p.dir_gql || {}
    const id = Number(p.shopify_order_id)
    return {
      ...p,
      cliente: dir.name || [dir.first_name || dir.firstName, dir.last_name || dir.lastName].filter(Boolean).join(' ') || null,
      ciudad: dir.city || null,
      fiscal: mFis.get(id)?.[0] || null,
      facturas: mFac.get(id) || [],
      retenida: mRet.get(id)?.[0] || null,
    }
  })
}
