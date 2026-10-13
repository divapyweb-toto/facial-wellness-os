// 12-10: pago anticipado con prioridad. Los pedidos con tag PRIORIDAD (el cliente pagó por transferencia y Enrique
// tocó "Recibido") salen primero: en la lista de Despacho y en la cabecera / guías. Un pedido ya pagado (prepago)
// también va adelante, y siempre con importe a cobrar 0.
// Sin dependencias (lo usan DespachoPagina.jsx y su test).

/** Tags de Shopify (texto "A, B" o lista) → lista en minúsculas. */
export function listaTags(tags) {
  const l = Array.isArray(tags) ? tags : String(tags || '').split(',')
  return l.map(t => String(t).trim().toLowerCase()).filter(Boolean)
}

/** Pagado antes de la entrega según Shopify: estado "paid" o tag PAGO_VERIFICADO / PAGADO / PAGADO_QR. */
export function pagadoPorTags(tags, estadoFinanciero) {
  const t = listaTags(tags)
  return String(estadoFinanciero || '').toLowerCase() === 'paid' ||
    t.includes('pago_verificado') || t.includes('pagado') || t.includes('pagado_qr')
}

/** Tag PRIORIDAD (pago con prioridad recibido). */
export function tienePrioridad(tags) {
  return listaTags(tags).includes('prioridad')
}

/** Va primero: tag PRIORIDAD o ya pagado por adelantado. */
export function esPrioridad(p) {
  return !!(p && (p.prioridad || p.prepago))
}

/** Orden estable: primero los de prioridad, el resto como venía. No modifica la lista original. */
export function ordenarPorPrioridad(lista) {
  return (lista || [])
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (esPrioridad(b.p) - esPrioridad(a.p)) || (a.i - b.i))
    .map(x => x.p)
}

/** Para las guías: separadas por transportadora (pap, lucero, otra) y, dentro de cada una, prioridad primero. */
export function ordenarGuias(lista) {
  const orden = { pap: 0, lucero: 1, otra: 2 }
  return (lista || [])
    .map((p, i) => ({ p, i }))
    .sort((a, b) =>
      ((orden[a.p.transportadora] ?? 0) - (orden[b.p.transportadora] ?? 0)) ||
      (esPrioridad(b.p) - esPrioridad(a.p)) ||
      (a.i - b.i))
    .map(x => x.p)
}
