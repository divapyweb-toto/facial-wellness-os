// src/lib/stockEngine.js
// ═══════════════════════════════════════════════════════════
// MOTOR DE STOCK — separa el ESTADO COMERCIAL del HECHO FÍSICO
//
// Regla central (Enrique, jul 2026):
//   El estado comercial NO mueve mercadería. La mercadería sale del depósito
//   cuando se despacha, y vuelve SOLO cuando la recibís físicamente (escaneo).
//
//   "Devuelto" según Punto a Punto significa que el cliente no la recibió,
//   pero la caja sigue en poder del courier — puede tardar semanas en volver.
//   Durante ese tiempo NO la tenés y NO la podés vender.
//
// Fuente de verdad del stock: el campo venta.reingresado_at
//   - reingresado_at = null  → la mercadería está FUERA (descontada)
//   - reingresado_at = fecha → volvió al depósito (stock devuelto)
//
// El flag venta.stock_descontado evita descontar/devolver dos veces.
// Si el producto es combo (es_combo), mueve sus COMPONENTES, no el combo.
// ═══════════════════════════════════════════════════════════
import { supabase } from './supabase'

// ¿La mercadería de esta venta está fuera del depósito?
// Está fuera mientras no se haya verificado su reingreso físico.
// Ojo: un "entregado" nunca reingresa (se vendió), así que queda fuera para siempre.
export function estaFueraDelDeposito(venta) {
  return !venta?.reingresado_at
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
// `tipo` describe QUÉ pasó de verdad. Si no se pasa, se infiere del signo
// (compatibilidad con las llamadas viejas de ventas/devoluciones).
async function moverStock(producto_id, producto_nombre, delta, motivo, tipo = null) {
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
      tipo: tipo || (delta < 0 ? 'venta' : 'devolucion'),
      cantidad: Math.abs(delta),
      motivo,
    })
  } catch (e) { /* el stock ya se aplicó */ }
}

// ═══════════════════════════════════════════════════════════
// API PRINCIPAL
// ═══════════════════════════════════════════════════════════

// Llamar al CREAR una venta nueva.
// Toda venta nueva descuenta stock: la mercadería se aparta para ese cliente.
export async function aplicarStockNuevaVenta(venta) {
  if (!venta?.id) return
  if (venta.stock_descontado === true) return // ya descontada
  if (!estaFueraDelDeposito(venta)) return    // nació ya reingresada (imposible en la práctica)

  const items = await resolverItemsFisicos(venta)
  for (const it of items) {
    await moverStock(it.producto_id, it.producto_nombre, -it.cantidad, `Venta #${venta.n_referencia || venta.id}`)
  }
  await supabase.from('ventas').update({ stock_descontado: true }).eq('id', venta.id)
}

// Llamar al CAMBIAR el estado de una venta existente.
// NO-OP a propósito: el estado comercial no mueve mercadería física.
//  - pendiente → entregado: la caja ya estaba afuera, sigue afuera (vendida).
//  - pendiente → devuelto:  la caja está con el courier, NO volvió todavía.
// El stock vuelve únicamente al registrar el reingreso físico (ver registrarReingresoLote).
export async function aplicarStockCambioEstado(_venta, _nuevoEstado) {
  return
}

// Llamar al BORRAR una venta (soft-delete).
// Acá SÍ vuelve el stock: la venta no existió, la mercadería es tuya de nuevo.
export async function devolverStockPorBorrado(venta) {
  if (!venta?.id) return
  if (venta.stock_descontado !== true) return // no estaba descontada, nada que devolver

  const items = await resolverItemsFisicos(venta)
  for (const it of items) {
    await moverStock(it.producto_id, it.producto_nombre, +it.cantidad, `Venta eliminada #${venta.n_referencia || venta.id}`)
  }
  await supabase.from('ventas').update({ stock_descontado: false }).eq('id', venta.id)
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
  const debeDescontar = estaFueraDelDeposito(ventaNueva)
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

// ═══════════════════════════════════════════════════════════
// STOCK EN LOTE (para importación masiva)
// ═══════════════════════════════════════════════════════════

// LÓGICA PURA (testeable): dado un conjunto de ventas + el catálogo de productos,
// agrega cuánto hay que descontar por cada producto FÍSICO (explotando combos).
// ventas: [{ producto_id, cantidad }] · prodById: { id → producto (con campos de combo) }
// → { producto_id: { nombre, cantidad } }
export function agregarDeltasStock(ventas, prodById) {
  const deltas = {}
  for (const v of (ventas || [])) {
    const prod = prodById[v.producto_id]
    if (!prod) continue
    const cant = v.cantidad || 1
    const items = []
    if (prod.es_combo) {
      if (prod.componente_1_id) items.push({ id: prod.componente_1_id, nombre: prodById[prod.componente_1_id]?.nombre, qty: (prod.componente_1_qty || 1) * cant })
      if (prod.componente_2_id) items.push({ id: prod.componente_2_id, nombre: prodById[prod.componente_2_id]?.nombre, qty: (prod.componente_2_qty || 1) * cant })
    } else {
      items.push({ id: prod.id, nombre: prod.nombre, qty: cant })
    }
    for (const it of items) {
      if (!it.id) continue
      if (!deltas[it.id]) deltas[it.id] = { nombre: it.nombre, cantidad: 0 }
      deltas[it.id].cantidad += it.qty
    }
  }
  return deltas
}

// Descuenta stock de un LOTE de ventas nuevas (importación), en pocas queries.
// Solo descuenta las que corresponden (estado que descuenta + con producto_id + no descontadas ya).
// Devuelve { descontadas, productos } para feedback.
export async function aplicarStockLoteNuevasVentas(ventas) {
  const aDescontar = (ventas || []).filter(v => v?.id && v?.producto_id && v?.stock_descontado !== true && estaFueraDelDeposito(v))
  if (!aDescontar.length) return { descontadas: 0, productos: 0 }

  // 1) Cargar los productos involucrados (con campos de combo) en una query
  const idsProducto = [...new Set(aDescontar.map(v => v.producto_id))]
  const { data: prods } = await supabase
    .from('productos')
    .select('id, nombre, es_combo, componente_1_id, componente_1_qty, componente_2_id, componente_2_qty')
    .in('id', idsProducto)
  const prodById = {}
  for (const p of (prods || [])) prodById[p.id] = p

  // 2) Cargar nombres de componentes de combos (para los movimientos)
  const compIds = new Set()
  for (const p of (prods || [])) {
    if (p.es_combo) { if (p.componente_1_id) compIds.add(p.componente_1_id); if (p.componente_2_id) compIds.add(p.componente_2_id) }
  }
  if (compIds.size) {
    const { data: comps } = await supabase.from('productos').select('id, nombre').in('id', [...compIds])
    for (const c of (comps || [])) if (!prodById[c.id]) prodById[c.id] = c
  }

  // 3) Agregar deltas por producto físico (LÓGICA PURA)
  const deltas = agregarDeltasStock(aDescontar, prodById)
  const fisicoIds = Object.keys(deltas)
  if (!fisicoIds.length) return { descontadas: 0, productos: 0 }

  // 4) Leer stock actual de los productos físicos afectados (una query)
  const { data: stocks } = await supabase.from('productos').select('id, stock_actual').in('id', fisicoIds)
  const stockById = {}
  for (const s of (stocks || [])) stockById[s.id] = s.stock_actual || 0

  // 5) Actualizar stock de cada producto + juntar movimientos
  const movimientos = []
  await Promise.all(fisicoIds.map(pid => {
    const d = deltas[pid]
    const nuevo = (stockById[pid] || 0) - d.cantidad
    movimientos.push({ producto_id: pid, producto_nombre: d.nombre, tipo: 'venta', cantidad: d.cantidad, motivo: `Importación masiva (${aDescontar.length} ventas)` })
    return supabase.from('productos').update({ stock_actual: nuevo }).eq('id', pid)
  }))

  // 6) Insertar movimientos (una query, no crítico si falla)
  if (movimientos.length) { try { await supabase.from('stock_movimientos').insert(movimientos) } catch (e) { /* stock ya aplicado */ } }

  // 7) Marcar las ventas como descontadas (una query)
  await supabase.from('ventas').update({ stock_descontado: true }).in('id', aDescontar.map(v => v.id))

  return { descontadas: aDescontar.length, productos: fisicoIds.length }
}

// ═══════════════════════════════════════════════════════════
// REINGRESO FÍSICO — la mercadería volvió al depósito (escaneo)
// Es el ÚNICO camino por el que el stock vuelve a subir por una devolución.
// ═══════════════════════════════════════════════════════════

// Registra el reingreso de una tanda de paquetes devueltos.
// ventas: filas completas de `ventas` (id, producto_id, cantidad, estado, stock_descontado, reingresado_at)
// Idempotente: las que ya tienen reingresado_at se saltean.
export async function registrarReingresoLote(ventas) {
  const aReingresar = (ventas || []).filter(v => v?.id && !v.reingresado_at)
  if (!aReingresar.length) return { reingresadas: 0, productos: 0, unidades: 0 }

  const ahora = new Date().toISOString()
  const conProducto = aReingresar.filter(v => v.producto_id && v.stock_descontado === true)

  let fisicoIds = []
  if (conProducto.length) {
    // Cargar productos involucrados (+ componentes de combos)
    const idsProducto = [...new Set(conProducto.map(v => v.producto_id))]
    const { data: prods } = await supabase
      .from('productos')
      .select('id, nombre, es_combo, componente_1_id, componente_1_qty, componente_2_id, componente_2_qty')
      .in('id', idsProducto)
    const prodById = {}
    for (const p of (prods || [])) prodById[p.id] = p

    const compIds = new Set()
    for (const p of (prods || [])) {
      if (p.es_combo) { if (p.componente_1_id) compIds.add(p.componente_1_id); if (p.componente_2_id) compIds.add(p.componente_2_id) }
    }
    if (compIds.size) {
      const { data: comps } = await supabase.from('productos').select('id, nombre').in('id', [...compIds])
      for (const c of (comps || [])) if (!prodById[c.id]) prodById[c.id] = c
    }

    // Agregar deltas (misma lógica pura que la importación, pero SUMANDO)
    const deltas = agregarDeltasStock(conProducto, prodById)
    fisicoIds = Object.keys(deltas)

    if (fisicoIds.length) {
      const { data: stocks } = await supabase.from('productos').select('id, stock_actual').in('id', fisicoIds)
      const stockById = {}
      for (const s of (stocks || [])) stockById[s.id] = s.stock_actual || 0

      const movimientos = []
      await Promise.all(fisicoIds.map(pid => {
        const d = deltas[pid]
        const nuevo = (stockById[pid] || 0) + d.cantidad // ← SUMA: la mercadería volvió
        movimientos.push({ producto_id: pid, producto_nombre: d.nombre, tipo: 'devolucion', cantidad: d.cantidad, motivo: `Reingreso verificado (${conProducto.length} paquetes)` })
        return supabase.from('productos').update({ stock_actual: nuevo }).eq('id', pid)
      }))
      if (movimientos.length) { try { await supabase.from('stock_movimientos').insert(movimientos) } catch (e) { /* stock ya aplicado */ } }
    }
  }

  // Marcar reingreso + liberar el flag de descontado (una query)
  const ids = aReingresar.map(v => v.id)
  await supabase.from('ventas').update({ reingresado_at: ahora, stock_descontado: false }).in('id', ids)

  // Los que PaP aún no reportó como devueltos: si volvieron físicamente, es una devolución.
  const pendientes = aReingresar.filter(v => v.estado === 'pendiente' || v.estado === 'en_tramite')
  if (pendientes.length) {
    await supabase.from('ventas').update({ estado: 'devuelto' }).in('id', pendientes.map(v => v.id))
  }

  const unidades = conProducto.reduce((s, v) => s + (v.cantidad || 1), 0)
  return { reingresadas: aReingresar.length, productos: fisicoIds.length, unidades }
}

// ═══════════════════════════════════════════════════════════
// CONTEO FÍSICO DE INVENTARIO
//
// Contás la mercadería con la mano y cargás el número. El sistema NO
// sobrescribe en silencio: calcula la diferencia y deja un movimiento
// tipo 'ajuste' con el antes y el después.
//
// Un ajuste NO es una compra ni una venta. Mezclarlos ensucia el historial
// y hace imposible saber por qué cambió el stock. Por eso tiene tipo propio.
//
// Los combos no se cuentan: no tienen stock propio, se arman de sus
// componentes. Contar un Pack Gudair sería contar dos veces.
// ═══════════════════════════════════════════════════════════

// LÓGICA PURA (testeable): compara lo contado contra lo que dice el sistema.
// productos: [{ id, nombre, stock_actual, costo_unit, es_combo }]
// conteos:   { [producto_id]: valorTipeado }  (string o número; vacío = no contado)
// → filas con delta y valorización, + resumen
export function calcularDiferencias(productos, conteos) {
  const filas = []
  for (const p of (productos || [])) {
    if (p.es_combo) continue // los combos se derivan, no se cuentan
    const bruto = conteos?.[p.id]
    const vacio = bruto === '' || bruto === null || bruto === undefined
    const n = vacio ? null : parseInt(bruto, 10)
    if (!vacio && (isNaN(n) || n < 0)) continue // basura tipeada: se ignora
    const sistema = p.stock_actual || 0
    filas.push({
      id: p.id,
      nombre: p.nombre,
      sistema,
      contado: vacio ? null : n,
      delta: vacio ? null : n - sistema,
      valorDelta: vacio ? 0 : (n - sistema) * (p.costo_unit || 0),
      costo_unit: p.costo_unit || 0,
    })
  }
  const contadas = filas.filter(f => f.contado !== null)
  const resumen = {
    productos: filas.length,
    contados: contadas.length,
    coinciden: contadas.filter(f => f.delta === 0).length,
    faltantes: contadas.filter(f => f.delta < 0).length,
    sobrantes: contadas.filter(f => f.delta > 0).length,
    unidadesFaltantes: contadas.filter(f => f.delta < 0).reduce((s, f) => s + Math.abs(f.delta), 0),
    unidadesSobrantes: contadas.filter(f => f.delta > 0).reduce((s, f) => s + f.delta, 0),
    valorNeto: contadas.reduce((s, f) => s + f.valorDelta, 0),
    hayCambios: contadas.some(f => f.delta !== 0),
  }
  return { filas, resumen }
}

// Aplica un conteo físico. Solo toca los productos con diferencia.
// Idempotente por naturaleza: si volvés a contar lo mismo, delta = 0 y no hace nada.
export async function aplicarConteoFisico(filas, motivo = 'Conteo físico') {
  const conDiferencia = (filas || []).filter(f => f.contado !== null && f.delta !== 0)
  if (!conDiferencia.length) return { ajustados: 0, unidades: 0 }

  const movimientos = []
  await Promise.all(conDiferencia.map(f => {
    movimientos.push({
      producto_id: f.id,
      producto_nombre: f.nombre,
      tipo: 'ajuste',
      cantidad: Math.abs(f.delta),
      motivo: `${motivo}: sistema ${f.sistema} → contado ${f.contado} (${f.delta > 0 ? '+' : '−'}${Math.abs(f.delta)})`,
    })
    return supabase.from('productos').update({ stock_actual: f.contado }).eq('id', f.id)
  }))

  if (movimientos.length) {
    try { await supabase.from('stock_movimientos').insert(movimientos) } catch (e) { /* stock ya aplicado */ }
  }
  return {
    ajustados: conDiferencia.length,
    unidades: conDiferencia.reduce((s, f) => s + Math.abs(f.delta), 0),
  }
}
