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

import { sumarFlete, costoFleteActual } from './flete'
import { normalizarRef } from './referencias'

// Tarifa vigente hoy (para compatibilidad con quien importe COSTO_PAP)
const COSTO_PAP = costoFleteActual()


// Calcula COGS de una lista de paquetes. Orden de preferencia:
//   1. costo_prod de la PROPIA línea (cada producto de un pedido tiene el suyo)
//   2. índice por referencia (respaldo, cuando la línea no trae costo)
//   3. promedio
// Antes se usaba solo el índice por referencia: en un pedido multiproducto
// todas las líneas tomaban el costo de UNA de ellas y el COGS salía mal.
function calcularCOGS(paquetes, refCosto, cogsPromedio) {
  let cogs = 0, conReal = 0
  for (const p of paquetes) {
    if (p.costo_prod != null) { cogs += Number(p.costo_prod) || 0; conReal++; continue }
    const ref = normalizarRef(p.n_referencia)
    if (ref && refCosto[ref] != null) { cogs += refCosto[ref]; conReal++ }
    else cogs += cogsPromedio
  }
  return { cogs, conReal, estimado: paquetes.length - conReal }
}

// ═══ CONTEOS POR PEDIDO (no por línea) ═══
// Un pedido de 2 productos son 2 filas en `ventas`. Contarlas como 2 pedidos
// inflaba entregados/devueltos y movía las tasas. Mismo criterio que
// metricasAds.js: se agrupa por referencia normalizada + fecha; una línea sin
// referencia con números cuenta como pedido propio. Las SUMAS de plata siguen
// por línea (ahí vive cada monto); esto es solo para contar.
export function clavePedido(v, i) {
  const r = normalizarRef(v?.n_referencia)
  return (r && /\d/.test(r)) ? `${r}|${v.fecha || ''}` : `__linea_${i}`
}

// Si las líneas de un pedido tienen estados distintos, gana entregado (la
// caja llegó), después devuelto, después el primero que aparezca.
const RANGO_CAT = { entregado: 2, devuelto: 1 }

// lineas: filas de venta/paquete. catDe: cómo sacar la categoría de cada línea.
// Devuelve { total, entregados, devueltos, enProceso, resueltos, porCat }.
export function contarPedidos(lineas, catDe = (l) => l.categoria) {
  const cat = new Map()
  ;(lineas || []).forEach((l, i) => {
    const k = clavePedido(l, i)
    const c = catDe(l) || 'en_proceso'
    const prev = cat.get(k)
    if (prev == null || (RANGO_CAT[c] || 0) > (RANGO_CAT[prev] || 0)) cat.set(k, c)
  })
  const porCat = {}
  for (const c of cat.values()) porCat[c] = (porCat[c] || 0) + 1
  const entregados = porCat.entregado || 0
  const devueltos = porCat.devuelto || 0
  return { total: cat.size, entregados, devueltos, enProceso: cat.size - entregados - devueltos, resueltos: entregados + devueltos, porCat }
}

// Categoría de una venta según su estado (para contarPedidos sobre `ventas`).
export const categoriaVenta = (v) => (v.estado === 'entregado' ? 'entregado' : v.estado === 'devuelto' ? 'devuelto' : (v.estado || 'en_proceso'))

// ═══ FUNCIÓN PRINCIPAL ═══
// Calcula la pirámide completa: bloque firme + bloque en tránsito.
export function calcularPiramide(paquetes, refCosto = {}, cogsPromedio = 12000, gastosMes = 0) {
  const entregados = paquetes.filter(p => p.categoria === 'entregado')
  const devueltos = paquetes.filter(p => p.categoria === 'devuelto')
  const enProceso = paquetes.filter(p => p.categoria === 'en_proceso')
  // Conteos y tasas por PEDIDO; la plata (abajo) sigue sumándose por línea.
  const ped = contarPedidos(paquetes)
  const resueltos = ped.resueltos

  // ── BLOQUE 1: GANANCIA FIRME (solo resueltos) ──
  const ingreso = entregados.reduce((s, p) => s + (p.importe || 0), 0)
  // Flete a la tarifa vigente en la FECHA de cada envío (histórico exacto).
  const fleteResueltos = sumarFlete([...entregados, ...devueltos])
  const fleteDevueltos = sumarFlete(devueltos)  // el sangrado real (solo flete)
  const cogsCalc = calcularCOGS(entregados, refCosto, cogsPromedio)
  const cogs = cogsCalc.cogs

  const contribucionFirme = ingreso - fleteResueltos - cogs
  const gananciaFirme = contribucionFirme - gastosMes

  // ── BLOQUE 2: EN TRÁNSITO (en proceso) ──
  const fleteEnTransito = sumarFlete(enProceso)  // flete ya comprometido
  const ingresoPotencialBruto = enProceso.reduce((s, p) => s + (p.importe || 0), 0)
  // Tasa de entrega histórica (de lo ya resuelto) para proyectar
  const tasaEntrega = resueltos ? (ped.entregados / resueltos) : 0
  // Proyección: cuántos de los en-proceso se entregarían y cuánto sumarían
  const entregadosProyectados = Math.round(ped.enProceso * tasaEntrega)
  const devueltosProyectados = ped.enProceso - entregadosProyectados
  const ingresoProyectado = Math.round(ingresoPotencialBruto * tasaEntrega)
  // COGS proyectado de lo que se entregaría (estimado proporcional)
  const cogsProyectado = enProceso.length
    ? Math.round(calcularCOGS(enProceso, refCosto, cogsPromedio).cogs * tasaEntrega)
    : 0
  // Contribución que aportaría lo en tránsito si cierra a la tasa histórica
  const contribucionProyectada = ingresoProyectado - fleteEnTransito - cogsProyectado

  // ── MÉTRICAS CLAVE ──
  const contribPorEnvio = resueltos ? Math.round(contribucionFirme / resueltos) : 0
  const tasaDevolucion = resueltos ? Math.round(ped.devueltos / resueltos * 100) : 0
  const tasaEntregaPct = resueltos ? Math.round(ped.entregados / resueltos * 100) : 0

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
    // Por pedido (un pedido de 2 líneas cuenta 1).
    entregados: ped.entregados,
    devueltos: ped.devueltos,
    enProceso: ped.enProceso,
    resueltos,
    total: ped.total,

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
// Es solo RESPALDO (calcularCOGS usa primero el costo_prod de cada línea).
// Guarda el PROMEDIO por línea de cada referencia: antes guardaba el de la
// última línea, que pisaba a las demás. Con el promedio, sumar las N líneas de
// un pedido da exactamente el costo total del pedido (lo que necesita Entregas,
// que pasa las líneas sin su costo_prod).
export function indexarCostos(ventas) {
  const acc = {}
  for (const v of (ventas || [])) {
    const ref = normalizarRef(v.n_referencia)
    if (!ref || v.costo_prod == null) continue
    const a = acc[ref] || (acc[ref] = { suma: 0, n: 0 })
    a.suma += Number(v.costo_prod) || 0
    a.n++
  }
  const idx = {}
  for (const [ref, a] of Object.entries(acc)) idx[ref] = a.suma / a.n
  return idx
}

export { COSTO_PAP }
