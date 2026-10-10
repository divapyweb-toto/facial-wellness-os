// src/lib/costoPorAnuncio.js
// ═══════════════════════════════════════════════════════════
// COSTO POR ANUNCIO (Meta → pedidos → entregados), para Reportes.
//
// El gasto viene por ANUNCIO y por día (gasto_ads_anuncio_diario, lo carga
// sync-meta-ads). Cada pedido trae de qué anuncio vino (pedidos_origen_anuncio):
//   · web      → "UTM content" = nombre del anuncio (a veces su ID)
//   · WhatsApp → el anuncio de origen del chat (ID)
// Se cruza por nombre (sin mayúsculas ni espacios de más) o por ID.
// Costo por pedido = solo pedidos VÁLIDOS: los cancelados (por el cliente o
// "cayó sin respuesta") no cuentan. Los sin respuesta se muestran aparte.
// ═══════════════════════════════════════════════════════════

import { fetchAll } from './fetchAll'

const clave = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
const esId = (s) => /^\d{6,}$/.test(String(s ?? '').trim())
const CANCELADOS = new Set(['cancelado_cliente', 'cancelado_sin_respuesta'])

export function armarCostoPorAnuncio({ gastoAnuncios = [], pedidos = [] } = {}) {
  // Gasto agrupado por nombre de anuncio; índice ID → nombre.
  const nombrePorId = new Map()
  const filas = new Map()
  const fila = (k, nombre) => {
    if (!filas.has(k)) filas.set(k, { anuncio: nombre, campana: '', gasto: 0, pedidos: 0, entregados: 0, sinRespuesta: 0, canal: '' })
    return filas.get(k)
  }
  for (const g of gastoAnuncios) {
    const nombre = String(g.ad_nombre || '').trim()
    if (!nombre) continue
    if (g.ad_id) nombrePorId.set(String(g.ad_id), clave(nombre))
    const f = fila(clave(nombre), nombre)
    f.gasto += Number(g.gasto) || 0
    if (!f.campana && g.campana_nombre) f.campana = g.campana_nombre
  }

  let sinAnuncio = 0
  for (const p of pedidos) {
    const ref = String(p.utm_content || p.anuncio_wa || '').trim()
    const estado = p.estado_confirmacion || ''
    if (!ref) { if (!CANCELADOS.has(estado)) sinAnuncio++; continue }
    const k = esId(ref) ? (nombrePorId.get(ref) || ref) : clave(ref)
    const f = fila(k, esId(ref) && !nombrePorId.has(ref) ? `Anuncio ${ref}` : ref)
    if (p.origen === 'whatsapp') f.canal = 'WhatsApp'
    if (estado === 'cancelado_sin_respuesta') f.sinRespuesta++
    if (CANCELADOS.has(estado)) continue
    f.pedidos++
    if (p.entregado) f.entregados++
  }

  const lista = [...filas.values()].map(f => ({
    ...f,
    canal: f.canal || (/whatsapp/i.test(f.anuncio) || /whatsapp/i.test(f.campana) ? 'WhatsApp' : 'Web'),
    costoPedido: f.pedidos ? Math.round(f.gasto / f.pedidos) : null,
    costoEntregado: f.entregados ? Math.round(f.gasto / f.entregados) : null,
    tasaEntrega: f.pedidos ? Math.round((f.entregados / f.pedidos) * 100) : null,
  })).sort((a, b) => b.gasto - a.gasto || b.pedidos - a.pedidos)

  const total = lista.reduce((t, f) => ({
    gasto: t.gasto + f.gasto, pedidos: t.pedidos + f.pedidos, entregados: t.entregados + f.entregados,
    sinRespuesta: t.sinRespuesta + f.sinRespuesta,
  }), { gasto: 0, pedidos: 0, entregados: 0, sinRespuesta: 0 })
  total.costoPedido = total.pedidos ? Math.round(total.gasto / total.pedidos) : null
  total.costoEntregado = total.entregados ? Math.round(total.gasto / total.entregados) : null

  return { filas: lista, total, sinAnuncio, conPedidos: lista.filter(f => f.pedidos > 0 || f.sinRespuesta > 0).length }
}

// Lee lo del período. Si las tablas/vistas no existen todavía, devuelve vacío (no rompe Reportes).
export async function cargarCostoPorAnuncio(cliente, { inicio, fin }) {
  // Paginado con fetchAll: `.limit(20000)` no pasa el tope de 1.000 filas de
  // Supabase y cortaba en silencio. Orden por clave única de cada fuente.
  const seguro = async (fn) => { try { return await fn() } catch { return [] } }
  const rango = (q) => q.gte('creado_en', `${inicio}T00:00:00-03:00`).lte('creado_en', `${fin}T23:59:59-03:00`)
  const COLS = 'shopify_order_id, creado_en, utm_content, anuncio_wa, origen, entregado'
  // pedidos_origen_anuncio ya EXCLUYE los cancelados (cliente y sin respuesta).
  // Para contar "cayeron sin respuesta" hace falta pedidos_origen_anuncio_todos
  // (misma vista sin ese filtro + estado_confirmacion). Si todavía no existe,
  // se usa la de siempre y la columna queda en "—" (sinRespuestaDisponible=false).
  const pedidosTodos = async () => {
    try {
      return await fetchAll(() => rango(cliente.from('pedidos_origen_anuncio_todos').select(`${COLS}, estado_confirmacion`)), { columnaOrden: 'shopify_order_id' })
    } catch { return null }
  }
  const [gastoAnuncios, todos] = await Promise.all([
    // Único por (fecha, ad_id).
    seguro(() => fetchAll(() => cliente.from('gasto_ads_anuncio_diario').select('fecha, ad_id, ad_nombre, campana_nombre, gasto')
      .eq('tienda', 'voltra').gte('fecha', inicio).lte('fecha', fin).order('ad_id'), { columnaOrden: 'fecha' })),
    pedidosTodos(),
  ])
  // Una fila por pedido de Shopify.
  // Si la vista nueva no devuelve nada, se confirma con la de siempre (mismo resultado si está vacía de verdad).
  const pedidos = todos?.length ? todos : await seguro(() => fetchAll(() => rango(cliente.from('pedidos_origen_anuncio').select(COLS)), { columnaOrden: 'shopify_order_id' }))
  return { ...armarCostoPorAnuncio({ gastoAnuncios, pedidos }), sinRespuestaDisponible: todos !== null }
}
