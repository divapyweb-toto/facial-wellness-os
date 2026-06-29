// src/lib/contribucion.js
// ═══════════════════════════════════════════════════════════
// PIRÁMIDE DE RENTABILIDAD COD — el corazón del análisis profit-first
//
// Niveles (de arriba hacia abajo):
//   INGRESO COBRADO (solo entregados — devuelto no cobra)
//   − Flete de TODOS los resueltos (entregados + devueltos pagan flete)
//   − Costo del producto vendido (COGS, SOLO entregados)
//   ─────────────────────────────────
//   = CONTRIBUCIÓN NETA  (¿la operación logística gana plata?)
//   − Gastos generales del mes (ads, sueldos, etc. — de Finanzas)
//   ─────────────────────────────────
//   = GANANCIA REAL  (lo que queda libre de verdad)
//
// REGLA CLAVE (confirmada con Enrique): el producto DEVUELTO vuelve al
// depósito y se revende → NO es pérdida. Lo único que se pierde en una
// devolución es el FLETE (envío pagado que no se cobró).
// ═══════════════════════════════════════════════════════════

const COSTO_PAP = 27000

// Calcula la pirámide a partir de los paquetes (merged ya filtrado por mes)
// y un índice opcional de costos por referencia (refCosto[ref] = costo_prod real).
//
// paquetes: [{ categoria, importe, n_referencia, ... }]
// refCosto: { '1595': 5312, ... }  (costo real del producto de esa venta)
// cogsPromedio: fallback cuando no hay match de costo (estimado)
// gastosMes: total de gastos generales del mes (de Finanzas), para la ganancia real
export function calcularPiramide(paquetes, refCosto = {}, cogsPromedio = 12000, gastosMes = 0) {
  const entregados = paquetes.filter(p => p.categoria === 'entregado')
  const devueltos = paquetes.filter(p => p.categoria === 'devuelto')
  const enProceso = paquetes.filter(p => p.categoria === 'en_proceso')
  const resueltos = entregados.length + devueltos.length

  // 1) Ingreso: solo lo cobrado de entregados
  const ingreso = entregados.reduce((s, p) => s + (p.importe || 0), 0)

  // 2) Flete de TODOS los resueltos (cada paquete que PaP movió cobra flete)
  const fleteResueltos = resueltos * COSTO_PAP
  const fleteDevueltos = devueltos.length * COSTO_PAP  // lo que SÍ se pierde

  // 3) COGS: costo del producto SOLO de los entregados.
  //    (el producto de los devueltos vuelve al depósito → NO se cuenta)
  let cogs = 0
  let conCostoReal = 0
  for (const p of entregados) {
    const ref = normalizarRefSimple(p.n_referencia)
    if (ref && refCosto[ref] != null) {
      cogs += refCosto[ref]
      conCostoReal++
    } else {
      cogs += cogsPromedio  // fallback estimado
    }
  }

  // = CONTRIBUCIÓN NETA
  const contribucionNeta = ingreso - fleteResueltos - cogs

  // = GANANCIA REAL (después de gastos generales)
  const gananciaReal = contribucionNeta - gastosMes

  // Métricas derivadas
  const contribPorEnvio = resueltos ? Math.round(contribucionNeta / resueltos) : 0
  const tasaDevolucion = resueltos ? Math.round(devueltos.length / resueltos * 100) : 0
  const tasaEntrega = resueltos ? Math.round(entregados.length / resueltos * 100) : 0
  const sangradoFlete = fleteDevueltos  // costo real de las devoluciones (solo flete)

  return {
    // Pirámide (los niveles)
    ingreso,
    fleteResueltos,
    cogs,
    contribucionNeta,
    gastosMes,
    gananciaReal,
    // Conteos
    entregados: entregados.length,
    devueltos: devueltos.length,
    enProceso: enProceso.length,
    resueltos,
    total: paquetes.length,
    // Métricas
    contribPorEnvio,
    tasaDevolucion,
    tasaEntrega,
    sangradoFlete,
    fleteDevueltos,
    // Calidad del dato
    conCostoReal,        // cuántos entregados usaron costo real
    cogsEstimado: entregados.length - conCostoReal,  // cuántos usaron fallback
  }
}

// Normalización simple de referencia (alineada con el matcher de Entregas)
function normalizarRefSimple(ref) {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}

// Construye el índice de costos por referencia a partir de las ventas.
// ventas: [{ n_referencia, costo_prod }]
export function indexarCostos(ventas) {
  const idx = {}
  for (const v of (ventas || [])) {
    const ref = normalizarRefSimple(v.n_referencia)
    if (ref && v.costo_prod != null) idx[ref] = v.costo_prod
  }
  return idx
}

export { COSTO_PAP }
