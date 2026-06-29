// src/lib/contribucion.js
// ═══════════════════════════════════════════════════════════
// PIRÁMIDE DE RENTABILIDAD COD — análisis profit-first nivel empresa
//
// FILOSOFÍA: separar lo CERRADO de lo EN TRÁNSITO (como hace cualquier
// empresa seria). Nunca mezclar "lo que gané" con "lo que capaz gano".
//
// BLOQUE 1 — GANANCIA FIRME (resultado realizado, solo paquetes resueltos):
//   INGRESO COBRADO (entregados)
//   − Flete de los resueltos (entregados + devueltos pagaron flete)
//   − Costo del producto vendido (COGS, solo entregados)
//   = CONTRIBUCIÓN FIRME
//   − Gastos generales del mes
//   = GANANCIA FIRME  ← esto ya es tuyo, nadie te lo saca
//
// BLOQUE 2 — EN TRÁNSITO (resultado proyectado, paquetes en proceso):
//   Flete ya comprometido de los en-proceso
//   Ingreso potencial si se entregan (a la tasa de entrega histórica)
//   = proyección de cuánto puede mejorar (o costar) la ganancia firme
//
// REGLA CLAVE (confirmada con Enrique): el producto DEVUELTO vuelve al
// depósito y se revende → NO es pérdida. Solo se pierde el FLETE.
// ═══════════════════════════════════════════════════════════

const COSTO_PAP = 27000

// Normalización de referencia (alineada con el matcher de Entregas)
function normalizarRefSimple(ref) {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}

// Calcula COGS de una lista de paquetes usando costo real por referencia
// (con fallback a promedio cuando no hay match).
function calcularCOGS(paquetes, refCosto, cogsPromedio) {
  let cogs = 0, conReal = 0
  for (const p of paquetes) {
    const ref = normalizarRefSimple(p.n_referencia)
    if (ref && refCosto[ref] != null) { cogs += refCosto[ref]; conReal++ }
    else cogs += cogsPromedio
  }
  return { cogs, conReal, estimado: paquetes.length - conReal }
}

// ═══ FUNCIÓN PRINCIPAL ═══
// Calcula la pirámide completa: bloque firme + bloque en tránsito.
export function calcularPiramide(paquetes, refCosto = {}, cogsPromedio = 12000, gastosMes = 0) {
  const entregados = paquetes.filter(p => p.categoria === 'entregado')
  const devueltos = paquetes.filter(p => p.categoria === 'devuelto')
  const enProceso = paquetes.filter(p => p.categoria === 'en_proceso')
  const resueltos = entregados.length + devueltos.length

  // ── BLOQUE 1: GANANCIA FIRME (solo resueltos) ──
  const ingreso = entregados.reduce((s, p) => s + (p.importe || 0), 0)
  const fleteResueltos = resueltos * COSTO_PAP        // flete que YA pagaste de lo cerrado
  const fleteDevueltos = devueltos.length * COSTO_PAP  // el sangrado real (solo flete)
  const cogsCalc = calcularCOGS(entregados, refCosto, cogsPromedio)
  const cogs = cogsCalc.cogs

  const contribucionFirme = ingreso - fleteResueltos - cogs
  const gananciaFirme = contribucionFirme - gastosMes

  // ── BLOQUE 2: EN TRÁNSITO (en proceso) ──
  const fleteEnTransito = enProceso.length * COSTO_PAP  // flete ya comprometido
  const ingresoPotencialBruto = enProceso.reduce((s, p) => s + (p.importe || 0), 0)
  // Tasa de entrega histórica (de lo ya resuelto) para proyectar
  const tasaEntrega = resueltos ? (entregados.length / resueltos) : 0
  // Proyección: cuántos de los en-proceso se entregarían y cuánto sumarían
  const entregadosProyectados = Math.round(enProceso.length * tasaEntrega)
  const devueltosProyectados = enProceso.length - entregadosProyectados
  const ingresoProyectado = Math.round(ingresoPotencialBruto * tasaEntrega)
  // COGS proyectado de lo que se entregaría (estimado proporcional)
  const cogsProyectado = enProceso.length
    ? Math.round(calcularCOGS(enProceso, refCosto, cogsPromedio).cogs * tasaEntrega)
    : 0
  // Contribución que aportaría lo en tránsito si cierra a la tasa histórica
  const contribucionProyectada = ingresoProyectado - fleteEnTransito - cogsProyectado

  // ── MÉTRICAS CLAVE ──
  const contribPorEnvio = resueltos ? Math.round(contribucionFirme / resueltos) : 0
  const tasaDevolucion = resueltos ? Math.round(devueltos.length / resueltos * 100) : 0
  const tasaEntregaPct = resueltos ? Math.round(entregados.length / resueltos * 100) : 0

  return {
    // ═══ BLOQUE FIRME ═══
    ingreso,
    fleteResueltos,
    cogs,
    contribucionFirme,
    gastosMes,
    gananciaFirme,
    // compatibilidad con código viejo (alias)
    contribucionNeta: contribucionFirme,
    gananciaReal: gananciaFirme,

    // ═══ BLOQUE EN TRÁNSITO ═══
    fleteEnTransito,
    ingresoPotencialBruto,
    ingresoProyectado,
    cogsProyectado,
    contribucionProyectada,
    entregadosProyectados,
    devueltosProyectados,

    // ═══ CONTEOS ═══
    entregados: entregados.length,
    devueltos: devueltos.length,
    enProceso: enProceso.length,
    resueltos,
    total: paquetes.length,

    // ═══ MÉTRICAS ═══
    contribPorEnvio,
    tasaDevolucion,
    tasaEntrega: tasaEntregaPct,
    sangradoFlete: fleteDevueltos,
    fleteDevueltos,

    // ═══ CALIDAD DEL DATO ═══
    conCostoReal: cogsCalc.conReal,
    cogsEstimado: cogsCalc.estimado,
  }
}

// Construye el índice de costos por referencia a partir de las ventas.
export function indexarCostos(ventas) {
  const idx = {}
  for (const v of (ventas || [])) {
    const ref = normalizarRefSimple(v.n_referencia)
    if (ref && v.costo_prod != null) idx[ref] = v.costo_prod
  }
  return idx
}

export { COSTO_PAP }
