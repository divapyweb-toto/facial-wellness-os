// Marca como PREPARADO en Shopify los pedidos de Voltra que se acaban de despachar
// (Excel / guías). Nunca frena la descarga: si falla, solo avisa. Idempotente.
import { supabase } from './supabase'
import { esRefVoltra } from './referencias'

export function refsVoltra(pedidos) {
  return [...new Set((pedidos || []).map(p => String(p.n_referencia ?? p.ref ?? '')).filter(esRefVoltra))]
}

export async function prepararEnShopify(pedidos, avisar) {
  const refs = refsVoltra(pedidos)
  if (!refs.length) return null
  try {
    const { data, error } = await supabase.functions.invoke('preparar-pedidos', { body: { refs } })
    if (error) throw new Error(error.message)
    if (data?.errores?.length) avisar?.(`Shopify: no se pudo marcar preparado ${data.errores.join(' · ')}`, 'error')
    else if (data?.preparados) avisar?.(`Shopify: ${data.preparados} pedido(s) marcados como preparados`, 'success')
    return data
  } catch (e) {
    avisar?.(`No se pudo marcar preparado en Shopify (${e?.message || 'error'}). La descarga salió igual.`, 'error')
    return null
  }
}
