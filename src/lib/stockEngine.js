// src/lib/stockEngine.js
// ═══════════════════════════════════════════════════════════
// MOTOR DE STOCK — descuento automático por estado de venta
//
// Reglas (definidas con Enrique):
//  - Toda venta NACE descontando stock (pendiente = ya despachado).
//  - Solo "devuelto" devuelve el stock.
//  - El campo venta.stock_descontado evita descontar/devolver dos veces.
//  - Si el producto es combo (es_combo), descuenta sus COMPONENTES,
//    no el combo en sí.
//
// Estados que MANTIENEN el stock descontado: pendiente, entregado, en_tramite
// Estado que DEVUELVE el stock: devuelto
// ═══════════════════════════════════════════════════════════
import { supabase } from './supabase'

// ¿Este estado implica que la mercadería está fuera del depósito?
export function estadoDescuenta(estado) {
  // devuelto = volvió al depósito → NO descontado
  // todo lo demás (pendiente, entregado, en_tramite) = fuera → descontado
  return estado !== 'devuelto'
}

// Resolver qué ítems físicos mueve una venta.
// Devuelve [{ producto_id, producto_nombre, cantidad }] — ya "explotado" si es combo.
async function resolverItemsFisicos(venta) {
  if (!venta.producto_id) return []
  const { data: prod } = await supabase
    .from('productos')
    .select('id, nombre, es_combo, componente_1_id, componente_1_qty, componente_2_id, componente_2_qty')
    .eq('id', venta.producto_id)
    .single()
  if (!prod) return []

  const cantVenta = venta.cantidad || 1

  if (prod.es_combo) {
    // Explotar el combo en sus componentes
    const items = []
    if (prod.componente_1_id) {
      const { data: c1 } = await supabase.from('productos').select('id, nombre').eq('id', prod.componente_1_id).single()
      if (c1) items.push({ producto_id: c1.id, producto_nombre: c1.nombre, cantidad: (prod.componente_1_qty || 1) * cantVenta })
    }
    if (prod.componente_2_id) {
      const { data: c2 } = await supabase.from('productos').select('id, nombre').eq('id', prod.componente_2_id).single()
      if (c2) items.push({ producto_id: c2.id, producto_nombre: c2.nombre, cantidad: (prod.componente_2_qty || 1) * cantVenta })
    }
    return items
  }

  // Producto simple
  return [{ producto_id: prod.id, producto_nombre: prod.nombre, cantidad: cantVenta }]
}

// Aplicar un delta de stock a un producto + registrar movimiento.
async function moverStock(producto_id, producto_nombre, delta, motivo) {
  if (!producto_id || delta === 0) return
  // Leer stock actual
  const { data: prod } = await supabase.from('productos').select('stock_actual').eq('id', producto_id).single()
  if (!prod) return
  const nuevo = (prod.stock_actual || 0) + delta
  await supabase.from('productos').update({ stock_actual: nuevo }).eq('id', producto_id)
  // Registrar movimiento (no crítico si falla)
  try {
    await supabase.from('stock_movimientos').insert({
      producto_id, producto_nombre,
      tipo: delta < 0 ? 'venta' : 'devolucion',
      cantidad: Math.abs(delta),
      motivo,
    })
  } catch (e) { /* el stock ya se aplicó */ }
}

// ═══════════════════════════════════════════════════════════
// API PRINCIPAL
// ═══════════════════════════════════════════════════════════

// Llamar al CREAR una venta nueva.
// Si la venta arranca en un estado que descuenta, descuenta y marca.
export async function aplicarStockNuevaVenta(venta) {
  if (!venta?.id) return
  const debeDescontar = estadoDescuenta(venta.estado)
  if (!debeDescontar) return // nació devuelta (raro): no descuenta

  const items = await resolverItemsFisicos(venta)
  for (const it of items) {
    await moverStock(it.producto_id, it.producto_nombre, -it.cantidad, `Venta #${venta.n_referencia || venta.id}`)
  }
  await supabase.from('ventas').update({ stock_descontado: true }).eq('id', venta.id)
}

// Llamar al CAMBIAR el estado de una venta existente.
// Compara el estado nuevo vs. el flag stock_descontado y ajusta solo si hace falta.
export async function aplicarStockCambioEstado(venta, nuevoEstado) {
  if (!venta?.id) return
  const estabaDescontado = venta.stock_descontado === true
  const deberiaDescontar = estadoDescuenta(nuevoEstado)

  if (deberiaDescontar === estabaDescontado) return // nada que hacer

  const items = await resolverItemsFisicos(venta)

  if (deberiaDescontar && !estabaDescontado) {
    // Devuelto → activo otra vez: volver a DESCONTAR
    for (const it of items) {
      await moverStock(it.producto_id, it.producto_nombre, -it.cantidad, `Reactivación venta #${venta.n_referencia || venta.id}`)
    }
    await supabase.from('ventas').update({ stock_descontado: true }).eq('id', venta.id)
  } else if (!deberiaDescontar && estabaDescontado) {
    // Activo → devuelto: DEVOLVER stock
    for (const it of items) {
      await moverStock(it.producto_id, it.producto_nombre, +it.cantidad, `Devolución venta #${venta.n_referencia || venta.id}`)
    }
    await supabase.from('ventas').update({ stock_descontado: false }).eq('id', venta.id)
  }
}

// Llamar al EDITAR una venta (cambió cantidad y/o producto).
// Estrategia simple y robusta: revertir lo viejo, aplicar lo nuevo.
export async function aplicarStockEdicion(ventaVieja, ventaNueva) {
  if (!ventaVieja?.id) return
  // 1) Si lo viejo estaba descontado, devolverlo
  if (ventaVieja.stock_descontado) {
    const itemsViejos = await resolverItemsFisicos(ventaVieja)
    for (const it of itemsViejos) {
      await moverStock(it.producto_id, it.producto_nombre, +it.cantidad, `Ajuste (edición) venta #${ventaVieja.n_referencia || ventaVieja.id}`)
    }
  }
  // 2) Si lo nuevo debe descontar, descontarlo
  const debeDescontar = estadoDescuenta(ventaNueva.estado)
  if (debeDescontar) {
    const itemsNuevos = await resolverItemsFisicos({ ...ventaNueva, id: ventaVieja.id })
    for (const it of itemsNuevos) {
      await moverStock(it.producto_id, it.producto_nombre, -it.cantidad, `Ajuste (edición) venta #${ventaNueva.n_referencia || ventaVieja.id}`)
    }
    await supabase.from('ventas').update({ stock_descontado: true }).eq('id', ventaVieja.id)
  } else {
    await supabase.from('ventas').update({ stock_descontado: false }).eq('id', ventaVieja.id)
  }
}

// Calcular stock disponible de un combo (para mostrarlo en pantalla).
// packs = mínimo entre (stock componente / qty) de cada componente.
export function calcularStockCombo(combo, productosById) {
  if (!combo?.es_combo) return combo?.stock_actual || 0
  const c1 = productosById[combo.componente_1_id]
  const c2 = productosById[combo.componente_2_id]
  const disp = []
  if (c1) disp.push(Math.floor((c1.stock_actual || 0) / (combo.componente_1_qty || 1)))
  if (c2) disp.push(Math.floor((c2.stock_actual || 0) / (combo.componente_2_qty || 1)))
  return disp.length ? Math.min(...disp) : 0
}
