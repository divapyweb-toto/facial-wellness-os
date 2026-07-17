// src/lib/comparador.js
// ═══════════════════════════════════════════════════════════
// COMPARADOR DE MESES
//
// Compara dos meses de forma HONESTA, evitando dos trampas típicas:
//
// 1. MES INCOMPLETO vs MES COMPLETO
//    Comparar 30 días de abril contra 10 de mayo no tiene sentido. Cuando uno
//    de los meses es el mes en curso, se recortan AMBOS al mismo día.
//
// 2. VENTAS QUE TODAVÍA NO CERRARON
//    En COD, una venta de hace 3 días sigue "volando": no sabés si se entrega
//    o se devuelve. Si comparás la ganancia del mes actual (mitad sin cerrar)
//    contra un mes viejo (todo cerrado), el mes actual SIEMPRE parece un
//    desastre. Por eso hay dos modos:
//      · ACTIVIDAD   → pedidos, ventas brutas, gasto en ads (ya ocurrieron)
//      · RESULTADO   → solo ventas MADURAS, con días suficientes para cerrar
//
// La ventana de maduración NO se inventa: se calcula del propio historial
// (percentil 90 de los días que tardan las entregas).
// ═══════════════════════════════════════════════════════════

import { sumarFlete } from './flete'

// Traduce el estado y motivo que reporta Punto a Punto a una categoría simple:
// 'entregado' | 'devuelto' | 'en_proceso'. Es la misma lógica que usa Rendición.
export function categorizarPaP(estado, motivo) {
  const e = (estado || '').toLowerCase(); const m = (motivo || '').toLowerCase()
  if (e.includes('entregado')) return 'entregado'
  if (e.includes('devuelto')) return 'devuelto'
  if (m.includes('rechaz') || m.includes('inubicable') || m.includes('fuera de cobertura') ||
      m.includes('fin de custodia') || m.includes('problema de direccion') || m.includes('no desea') ||
      m.includes('cancelad') || m.includes('no ingreso') || m.includes('rehus')) return 'devuelto'
  if (e.includes('devolucion') || m.includes('devolucion')) return 'devuelto'
  return 'en_proceso'
}

// Normaliza una referencia para cruzar ventas ⋈ entregas
export function normRef(ref) {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}

const dias = (desde, hasta) => {
  if (!desde || !hasta) return null
  const a = new Date(String(desde).slice(0, 10) + 'T00:00:00')
  const b = new Date(String(hasta).slice(0, 10) + 'T00:00:00')
  if (isNaN(a) || isNaN(b)) return null
  return Math.round((b - a) / 86400000)
}

// ── VENTANA DE MADURACIÓN ──
// Percentil 90 de (fecha_entrega − fecha_venta), calculado del historial.
// Si a los P90 días el 90% de las ventas ya se entregaron, entonces una venta
// con esa antigüedad ya "cerró" a efectos prácticos.
// entregasPorRef: { refNormalizada: fecha_entrega }
export function calcularMaduracion(ventas, entregasPorRef, percentil = 0.9) {
  const difs = []
  for (const v of (ventas || [])) {
    const fe = entregasPorRef[normRef(v.n_referencia)]
    const d = dias(v.fecha, fe)
    if (d != null && d >= 0 && d <= 120) difs.push(d)
  }
  if (difs.length < 10) {
    // Pocos datos para un percentil confiable: usar un default prudente.
    return { dias: 15, muestra: difs.length, confiable: false }
  }
  difs.sort((a, b) => a - b)
  const idx = Math.min(difs.length - 1, Math.floor(percentil * difs.length))
  return { dias: difs[idx], muestra: difs.length, confiable: true }
}

// ── RECORTE HASTA LA FECHA (MTD) ──
// Si un mes es el actual, ambos meses se recortan al día de corte.
// Devuelve { diaCorte, esActual } — diaCorte = null significa mes completo.
export function calcularCorte(mesA, mesB, hoy = new Date()) {
  const mesActual = hoy.toISOString().slice(0, 7)
  const algunoEsActual = mesA === mesActual || mesB === mesActual
  if (!algunoEsActual) return { diaCorte: null, esActual: false }
  // Recortar ambos al día de hoy (número de día del mes)
  return { diaCorte: hoy.getDate(), esActual: true }
}

// Filtra ventas de un mes, opcionalmente recortadas al día de corte (MTD)
function ventasDeMes(ventas, mes, diaCorte) {
  return (ventas || []).filter(v => {
    const f = String(v.fecha || '').slice(0, 10)
    if (f.slice(0, 7) !== mes) return false
    if (diaCorte != null) {
      const dia = parseInt(f.slice(8, 10), 10)
      if (dia > diaCorte) return false
    }
    return true
  })
}

// ── MÉTRICAS DE ACTIVIDAD ──
// Hechos que ya ocurrieron: no dependen de si la venta cerró.
export function metricasActividad(ventas, mes, diaCorte, gastoAds = 0) {
  const vs = ventasDeMes(ventas, mes, diaCorte)
  const pedidos = vs.length
  const ventasBrutas = vs.reduce((s, v) => s + (v.total || 0), 0)
  return {
    mes,
    pedidos,
    ventasBrutas,
    ticketPromedio: pedidos ? Math.round(ventasBrutas / pedidos) : 0,
    gastoAds,
    cpa: pedidos ? Math.round(gastoAds / pedidos) : 0, // costo por pedido generado
  }
}

// ── MÉTRICAS DE RESULTADO ──
// Solo ventas MADURAS (con antigüedad ≥ ventana de maduración a la fecha de
// corte). Así se comparan peras con peras: ventas que tuvieron tiempo de cerrar.
export function metricasResultado(ventas, mes, diaCorte, ventanaDias, refCosto, cogsPromedio, hoy = new Date(), estadoPaP = {}) {
  const vs = ventasDeMes(ventas, mes, diaCorte)

  // Una venta es "madura" si pasaron ≥ ventanaDias desde que se hizo, contados
  // hasta HOY. Para meses pasados, hoy está muy lejos, así que todas maduran.
  // Para el mes en curso con corte, hoy es el propio día de corte.
  const referencia = hoy

  const maduras = vs.filter(v => {
    const d = dias(v.fecha, referencia.toISOString())
    return d != null && d >= ventanaDias
  })

  // Estado REAL de cada venta: primero lo que dice PaP (más confiable), y si PaP
  // todavía no tiene datos de esa referencia, se cae a ventas.estado.
  const estadoDe = (v) => {
    const cat = estadoPaP?.[normRef(v.n_referencia)]
    if (cat) return cat
    if (v.estado === 'entregado') return 'entregado'
    if (v.estado === 'devuelto') return 'devuelto'
    return 'en_proceso'
  }

  const entregados = maduras.filter(v => estadoDe(v) === 'entregado')
  const devueltos = maduras.filter(v => estadoDe(v) === 'devuelto')
  const resueltos = entregados.length + devueltos.length
  const enTransito = maduras.length - resueltos // maduras que aún no cerraron

  const ingreso = entregados.reduce((s, v) => s + (v.total || 0), 0)
  const cogs = entregados.reduce((s, v) => {
    const c = refCosto?.[normRef(v.n_referencia)]
    return s + (c != null ? c : cogsPromedio)
  }, 0)
  const fleteResueltos = sumarFlete([...entregados, ...devueltos])
  const sangradoFlete = sumarFlete(devueltos)
  const contribucion = ingreso - fleteResueltos - cogs

  return {
    mes,
    madurasTotal: maduras.length,
    entregados: entregados.length,
    devueltos: devueltos.length,
    resueltos,
    enTransito,
    ingreso,
    cogs,
    fleteResueltos,
    sangradoFlete,
    contribucion,
    contribPorEnvio: resueltos ? Math.round(contribucion / resueltos) : 0,
    tasaEntrega: resueltos ? Math.round(entregados.length / resueltos * 100) : 0,
    tasaDevolucion: resueltos ? Math.round(devueltos.length / resueltos * 100) : 0,
  }
}

// ── PUENTE DE VARIACIÓN (variance bridge) ──
// Descompone el cambio de contribución entre dos meses en tres efectos:
//   · VOLUMEN     → vendiste más/menos envíos (a la eficiencia vieja)
//   · EFICIENCIA  → cada envío rinde más/menos (al volumen nuevo)
//   · GASTOS      → gastaste más/menos en ads
// La suma de los tres es EXACTAMENTE el cambio total (probado).
export function puenteVariacion(resA, resB, gastoA = 0, gastoB = 0) {
  const Ra = resA.resueltos, Rb = resB.resueltos
  const ca = resA.contribPorEnvio, cb = resB.contribPorEnvio
  const contribA = resA.contribucion - gastoA
  const contribB = resB.contribucion - gastoB

  const efVolumen = (Rb - Ra) * ca
  const efEficiencia = Rb * (cb - ca)
  const efGastos = -(gastoB - gastoA)

  return {
    contribA,
    contribB,
    cambioTotal: contribB - contribA,
    efVolumen,
    efEficiencia,
    efGastos,
    // Verificación interna: la suma debe cuadrar con el cambio (salvo redondeo)
    cuadra: Math.abs((efVolumen + efEficiencia + efGastos) - (contribB - contribA)) <= (Rb + 2),
  }
}

// Etiqueta legible: "2026-06" → "Junio 2026"
export function etiquetaMes(ym) {
  if (!ym) return ''
  const [y, m] = ym.split('-')
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
  return `${meses[parseInt(m, 10) - 1]} ${y}`
}
