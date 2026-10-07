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

const s = (v) => (v == null ? '' : String(v))

// 'Facturar a: 1540443-9 Miguel Soa' etc. viaja en note_attributes → 'Note
// Attributes' del CSV es un texto "nombre: valor" por línea.
function notaAtributos(raw) {
  const lista = Array.isArray(raw?.note_attributes) ? raw.note_attributes : []
  return lista.map(a => `${s(a?.name)}: ${s(a?.value)}`).join('\n')
}

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
    'Tags': s(raw.tags),
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
