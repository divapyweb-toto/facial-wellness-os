// src/lib/referencias.js
// ═══════════════════════════════════════════════════════════
// NORMALIZACIÓN DE REFERENCIAS Y TELÉFONOS — FUENTE ÚNICA
//
// Estas funciones son las que CRUZAN datos entre tablas: una venta con su
// entrega, una entrega con su rendición, un cliente con sus compras previas.
// Si dos partes del sistema normalizan distinto, el cruce falla en silencio —
// no tira error, simplemente no encuentra nada y el cálculo sale mal.
//
// Antes de este archivo, `normalizarRef` estaba COPIADA en 4 lugares y solo
// una manejaba el prefijo 'FW-' de Lucero. Las otras tres convertían
// 'FW-2025' en 'FW2025', que nunca cruza contra la venta guardada como '2025'.
// Consecuencias que eso tenía:
//   · contribucion.js  → los pedidos de Lucero no encontraban su costo real
//                        de producto y usaban un promedio (ganancia mal).
//   · RecompraPage     → un cliente con código 'FW-' no contaba como recompra.
//   · conciliacionRendicion → las rendiciones no cruzaban con guías prefijadas.
//
// Es el mismo patrón que causó el bug del categorizador duplicado en 5
// archivos. Si mañana cambia una regla, se cambia ACÁ y vale para todo.
// ═══════════════════════════════════════════════════════════

// Referencia de pedido, normalizada para poder cruzar entre tablas.
//
//   '#1985'    → '1985'    (quita el # de Shopify)
//   '00123'    → '123'     (quita ceros a la izquierda: PaP los agrega)
//   'FW-2025'  → '2025'    (quita el prefijo que le mandamos a Lucero)
//   'L-2025'   → '2025'    (quita nuestra clave interna de entregas)
//   'WA-0007'  → '7'       (pedidos cargados por WhatsApp)
//   'ABCD'     → 'ABCD'    (texto sin números: se deja tal cual)
export function normalizarRef(ref) {
  if (!ref) return ''
  // Quitar #, espacios y cualquier separador
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  // Prefijo de transportadora o de canal (FW-, L-, WA-). Los códigos que
  // mandamos a Lucero van prefijados para no chocar con los de otros clientes
  // suyos; al volver hay que sacarlo para cruzar con la venta, que guarda el
  // número pelado.
  const conPrefijo = r.match(/^[A-Za-z]{1,4}0*(\d+)$/)
  if (conPrefijo) return String(parseInt(conPrefijo[1], 10))
  // Puramente numérico: quitar ceros a la izquierda ('00123' = '123')
  if (/^\d+$/.test(r)) return String(parseInt(r, 10))
  return r
}

// Solo los dígitos de la referencia. Se usa donde hace falta una clave simple
// (mapas de cruce) y no importa distinguir 'FW-2025' de '2025' — son el mismo
// pedido. Equivale al viejo `.replace(/[^0-9]/g,'')` que había suelto.
export const soloDigitos = (ref) => String(ref ?? '').replace(/\D/g, '')

// ─── Teléfono en formato local paraguayo ────────────────────
// Normaliza a '09XXXXXXXX' sin importar cómo lo escribió el cliente:
//   '+595 981 639332' → '0981639332'
//   '595981639332'    → '0981639332'
//   '981639332'       → '0981639332'
// Se usa para cruzar clientes entre ventas (detectar recompra y riesgo).
export function limpiarTel(tel) {
  if (!tel) return ''
  let t = String(tel).replace(/[\s\-()]/g, '')
  if (t.startsWith('+5950')) t = '0' + t.slice(5)
  else if (t.startsWith('+595')) t = '0' + t.slice(4)
  else if (t.startsWith('5950')) t = '0' + t.slice(4)
  else if (t.startsWith('595')) t = '0' + t.slice(3)
  if (t && !t.startsWith('0')) t = '0' + t
  return t
}

// Alias histórico: `normalizarTel` y `limpiarTel` hacían lo mismo con nombres
// distintos en archivos distintos. Se mantiene el nombre para no romper
// imports existentes, pero apunta a la misma implementación.
export const normalizarTel = limpiarTel
