// src/lib/costoPonderado.js
// ═══════════════════════════════════════════════════════════
// COSTO PROMEDIO PONDERADO (weighted average cost)
//
// Cuando reponés stock a un costo distinto, el costo unitario del producto
// tiene que ser el promedio ponderado entre lo que ya tenías y lo nuevo.
//
// Ejemplo:
//   Tenés 100 uds a Gs. 10.000  (valor 1.000.000)
//   Comprás 200 uds a Gs. 9.000 (valor 1.800.000)
//   Nuevo costo = 2.800.000 / 300 = Gs. 9.333
//   Nuevo stock = 300
//
// Así el margen y la contribución siempre usan el costo real, no uno viejo.
// ═══════════════════════════════════════════════════════════

// Calcula el nuevo costo promedio y el nuevo stock tras una reposición.
//   stockActual, costoActual: lo que ya tenías
//   unidadesNuevas, costoNuevo: la compra que estás cargando
// Devuelve { nuevoStock, nuevoCosto, valorAnterior, valorNuevo, valorTotal }
export function calcularCostoPonderado(stockActual, costoActual, unidadesNuevas, costoNuevo) {
  const sa = Math.max(0, Number(stockActual) || 0)
  const ca = Math.max(0, Number(costoActual) || 0)
  const un = Math.max(0, Number(unidadesNuevas) || 0)
  const cn = Math.max(0, Number(costoNuevo) || 0)

  const nuevoStock = sa + un

  // Si no había stock (o era 0/negativo), el costo nuevo manda: no hay nada que promediar.
  if (sa <= 0) {
    return {
      nuevoStock,
      nuevoCosto: Math.round(cn),
      valorAnterior: 0,
      valorNuevo: un * cn,
      valorTotal: un * cn,
    }
  }

  // Si no se agregan unidades, no cambia nada.
  if (un <= 0) {
    return {
      nuevoStock: sa,
      nuevoCosto: Math.round(ca),
      valorAnterior: sa * ca,
      valorNuevo: 0,
      valorTotal: sa * ca,
    }
  }

  const valorAnterior = sa * ca
  const valorNuevo = un * cn
  const valorTotal = valorAnterior + valorNuevo
  const nuevoCosto = Math.round(valorTotal / nuevoStock)

  return { nuevoStock, nuevoCosto, valorAnterior, valorNuevo, valorTotal }
}

// Costo de un combo = suma del costo de sus componentes (por su cantidad).
//   combo: { es_combo, componente_1_id, componente_1_qty, componente_2_id, componente_2_qty }
//   costoPorId: { [id]: costo_unit }
// Devuelve el costo del combo (0 si no es combo o faltan datos).
export function calcularCostoCombo(combo, costoPorId = {}) {
  if (!combo?.es_combo) return combo?.costo_unit || 0
  const c1 = (Number(combo.componente_1_qty) || 0) * (Number(costoPorId[combo.componente_1_id]) || 0)
  const c2 = (Number(combo.componente_2_qty) || 0) * (Number(costoPorId[combo.componente_2_id]) || 0)
  return Math.round(c1 + c2)
}
