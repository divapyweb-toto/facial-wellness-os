// src/lib/pedidosVoltra.js
// ═══════════════════════════════════════════════════════════
// PEDIDOS DE VOLTRA (Shopify) → mismas filas que el CSV de Shopify
//
// El webhook guarda cada pedido en `shopify_pedidos` con el JSON crudo de la
// API de Shopify. Despacho ya sabe leer el export CSV (`orders_export.csv`), así
// que acá se convierte ese JSON en filas con las MISMAS columnas del CSV y se
// pasa por el mismo camino: el CSV y el botón "Traer pedidos de Voltra" no
// pueden dar resultados distintos porque son literalmente la misma lógica.
// ═══════════════════════════════════════════════════════════

import { refVoltra } from './referencias'

const s = (v) => (v == null ? '' : String(v))

// 'Facturar a: 1540443-9 Miguel Soa' etc. viaja en note_attributes → 'Note
// Attributes' del CSV es un texto "nombre: valor" por línea.
// 13-10: también customAttributes ({ key, value }) del formato GraphQL: ahí
// viajan entrega_programada / entrega_franja de las entregas programadas.
function notaAtributos(raw) {
  const lista = [
    ...(Array.isArray(raw?.note_attributes) ? raw.note_attributes : []),
    ...(Array.isArray(raw?.customAttributes) ? raw.customAttributes : []),
  ]
  return lista.map(a => `${s(a?.name ?? a?.key)}: ${s(a?.value)}`).join('\n')
}

// 13-10: tags como en el CSV ("A, B"): REST los manda en texto y GraphQL en lista.
const textoTags = (tags) => (Array.isArray(tags) ? tags.map(s).join(', ') : s(tags))

// ¿Un pedido de Shopify se puede pasar a ventas? Borradores (checkout
// abandonado) y pruebas no. Los cancelados sí pasan: Despacho los marca como
// cancelados y no los despacha, igual que con el CSV.
export function esPedidoImportable(fila) {
  if (!fila || fila.es_borrador) return false
  const raw = fila.raw || {}
  if (raw.test === true) return false
  return Array.isArray(raw.line_items) && raw.line_items.length > 0
}

// fila de `shopify_pedidos` → N filas estilo CSV (una por producto).
export function filasCsvDesdePedidoShopify(fila) {
  const raw = fila?.raw || {}
  const dir = raw.shipping_address || raw.billing_address || {}
  const items = Array.isArray(raw.line_items) ? raw.line_items : []
  const vendor = s(items[0]?.vendor) || 'VOLTRA PARAGUAY'
  const base = {
    'Name': s(raw.name || fila?.nombre),
    'Id': s(raw.id || fila?.shopify_order_id),
    // 'created_at' ya viene con el huso de Paraguay (-03:00): la fecha del
    // pedido es la de los primeros 10 caracteres, sin conversión.
    'Created at': s(raw.created_at).replace('T', ' ').slice(0, 19),
    'Cancelled at': s(raw.cancelled_at),
    'Tags': textoTags(raw.tags),
    // 13-10: la nota del pedido (columna 'Notes' del CSV). Los pedidos
    // programados del formato viejo dicen ahí "ENTREGAR EL VIERNES 16/10 …".
    'Notes': s(raw.note),
    // 12-10: con estos dos se decide el pago anticipado igual que con el CSV
    // (antes el botón no los traía y el CSV tomaba 'paid' como prepago).
    'Financial Status': s(raw.financial_status),
    'Fulfillment Status': s(raw.fulfillment_status),
    'Note Attributes': notaAtributos(raw),
    'Total': s(raw.total_price),
    'Subtotal': s(raw.subtotal_price),
    'Shipping Name': s(dir.name),
    'Shipping City': s(dir.city),
    'Shipping Address1': [s(dir.address1), s(dir.address2)].filter(Boolean).join(', '),
    'Phone': s(dir.phone || raw.phone),
    'Vendor': vendor,
  }
  return items.map((it, i) => ({
    // Shopify deja en blanco los datos del pedido en las filas de continuación.
    ...(i === 0 ? base : { 'Name': base.Name }),
    'Lineitem name': s(it.name || it.title),
    'Lineitem quantity': s(it.quantity ?? 1),
    'Lineitem price': s(it.price),
    'Vendor': vendor,
  }))
}

// ─── Pago anticipado (12-10) ────────────────────────────────
// En contra entrega Shopify marca 'paid' AL ENTREGAR (VT-1007, VT-1014): 'paid'
// solo NO es prepago. Es pago anticipado si:
//   · tiene el tag PAGO_VERIFICADO (botón "Verifiqué el pago"), o
//   · mandó comprobante (PAGO_ANTICIPADO_COMPROBANTE) y figura 'paid', o
//   · figura 'paid' y todavía no se preparó el envío (sin fulfillment).
// Misma regla para el CSV y para "Traer pedidos de Voltra".
export function esPagoAnticipado({ financial, fulfillment, tags } = {}) {
  const t = s(tags).toLowerCase()
  if (t.includes('pago_verificado')) return true
  if (s(financial).trim().toLowerCase() !== 'paid') return false
  if (t.includes('pago_anticipado_comprobante')) return true
  const ff = s(fulfillment).trim().toLowerCase()
  return ff === '' || ff === 'unfulfilled' || ff === 'null'
}

// ─── Retiro en persona (12-10) ──────────────────────────────
// RETIRO_EN_CASA confirmado: es una venta, pero sin courier. Se guarda con
// transportadora 'otra' (la columna no acepta null), flete 0 y este método de
// envío, que es la marca para dejarla fuera de la planilla y las guías.
export const METODO_ENVIO_RETIRO = 'Retiro en persona'
export const esRetiroEnPersona = (venta) => venta?.metodo_envio_nombre === METODO_ENVIO_RETIRO

export function esRetiroConfirmado(tags, cancelledAt) {
  const t = s(tags).toLowerCase()
  if (cancelledAt || t.includes('cancelado') || t.includes('anterior_al_corte')) return false
  return t.includes('retiro_en_casa') && t.includes('confirmado')
}

// Estados de `shopify_pedidos.estado_envio` que significan "ya salió del
// depósito" (o ya terminó). EN_PREPARACION y CANCELADO no cuentan.
export const ENVIO_YA_SALIO = ['DESPACHADO', 'INTENTO_FALLIDO', 'ENTREGADO', 'NO_ENTREGADO_RESCATABLE', 'NO_ENTREGADO', 'RENDIDO']
export const envioEntregado = (fila) => ['ENTREGADO', 'RENDIDO'].includes(fila?.estado_envio) || !!fila?.entregado_en

// 21-10: pedido nuevo que REEMPLAZA a otro (etiqueta REEMPLAZA_A_#n). Map ref nueva → ref vieja, con refs en forma VT-n.
export function mapaReemplazos(filas) {
  const m = new Map()
  for (const f of filas || []) {
    const tags = Array.isArray(f?.raw?.tags) ? f.raw.tags : String(f?.raw?.tags || '').split(',')
    const t = tags.map(x => String(x).trim()).find(x => /^REEMPLAZA_A_#?\d+$/i.test(x))
    if (t) m.set(refVoltra(f.raw?.name || f.nombre), refVoltra(t.replace(/^REEMPLAZA_A_/i, '')))
  }
  return m
}

// Refs NUEVAS que no se cargan como envío aparte: la vieja existe en Ventas y su paquete ya está en el courier.
// ventasVivas / enCourier: Sets de refs VT-n.
export function reemplazosVinculados(mapa, ventasVivas, enCourier) {
  const out = new Set()
  for (const [nuevo, viejo] of mapa) if (ventasVivas.has(viejo) && enCourier.has(viejo)) out.add(nuevo)
  return out
}
