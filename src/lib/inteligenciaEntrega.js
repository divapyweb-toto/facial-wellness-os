import { getFlete } from './config'
import { sanearEntrega } from './estadosPaP'
import { tasaEntregaRealista } from './tasaEntrega'
// src/lib/inteligenciaEntrega.js
// ═══════════════════════════════════════════════════════════
// INTELIGENCIA DE ENTREGA
//
// Analiza las entregas de PaP para mostrar DÓNDE se pierde plata por
// devoluciones, y SUGERIR (sin obligar) dónde conviene pedir pago anticipado.
//
// La tasa de entrega es la fuga #1 en COD: cada paquete devuelto igual paga
// flete. Este módulo convierte esa data en decisiones.
// ═══════════════════════════════════════════════════════════

// Categoriza una entrega en entregado / devuelto / en_proceso (misma lógica que Entregas).
export function categorizarEntrega(estado, motivo) {
  const e = (estado || '').toLowerCase()
  const m = (motivo || '').toLowerCase()
  if (e.includes('entregado')) return 'entregado'
  if (e.includes('devuelto')) return 'devuelto'
  if (m.includes('rechaz') || m.includes('inubicable') || m.includes('fuera de cobertura') ||
      m.includes('no desea') || m.includes('cancelad') || m.includes('no ingreso') ||
      m.includes('rehus') || m.includes('rechazado')) return 'devuelto'
  if (e.includes('devolucion') || m.includes('devolucion')) return 'devuelto'
  return 'en_proceso'
}

// Umbrales de sugerencia (no obligan nada, solo pintan el semáforo).
const TASA_CRITICA = 0.55   // < 55% entrega → conviene prepago
const TASA_VIGILAR = 0.70   // < 70% → vigilar
const MIN_PEDIDOS = 3       // menos de esto, no alcanza para sacar conclusión

// Sugerencia para un grupo (ciudad/producto/mensajero) según su tasa.
export function sugerenciaEntrega(entregados, devueltos) {
  const resueltos = entregados + devueltos
  if (resueltos < MIN_PEDIDOS) return { nivel: 'pocos', texto: 'Pocos datos' }
  const tasa = entregados / resueltos
  if (tasa < TASA_CRITICA) return { nivel: 'critico', texto: 'Conviene prepago acá' }
  if (tasa < TASA_VIGILAR) return { nivel: 'vigilar', texto: 'Vigilar' }
  return { nivel: 'ok', texto: 'Bien' }
}

// Agrupa entregas por una clave (ciudad, producto, mensajero) y calcula métricas.
//   entregas: [{ categoria, ciudad, producto, mensajero, flete }]
//   claveFn: (e) => string
function agrupar(entregas, claveFn, flete) {
  const map = {}
  for (const e of entregas) {
    const k = (claveFn(e) || '').trim() || '(sin dato)'
    if (!map[k]) map[k] = { clave: k, entregados: 0, devueltos: 0, enProceso: 0, fleteFallo: 0 }
    const g = map[k]
    if (e.categoria === 'entregado') g.entregados++
    else if (e.categoria === 'devuelto') { g.devueltos++; g.fleteFallo += (e.flete || flete) }
    else g.enProceso++
  }
  return Object.values(map).map(g => {
    const resueltos = g.entregados + g.devueltos
    return { ...g, resueltos, tasa: resueltos ? g.entregados / resueltos : 0, sugerencia: sugerenciaEntrega(g.entregados, g.devueltos) }
  })
}

// Análisis completo. entregas ya normalizadas: [{ categoria, ciudad, producto, mensajero, motivo, flete }]
// flete = costo de flete por defecto (de config) para estimar plata perdida.
// `flete` por defecto sale de la configuración: era un valor fijo que quedó
// desactualizado cuando el flete pasó a variar por transportadora y ciudad.
export function analizarEntregas(entregas, flete = getFlete()) {
  const lista = entregas || []

  // Totales
  let entregados = 0, devueltos = 0, enProceso = 0, fleteFallo = 0
  for (const e of lista) {
    if (e.categoria === 'entregado') entregados++
    else if (e.categoria === 'devuelto') { devueltos++; fleteFallo += (e.flete || flete) }
    else enProceso++
  }
  const resueltos = entregados + devueltos
  const tasaGeneral = resueltos ? entregados / resueltos : 0

  // Cuánto recuperarías subiendo la tasa a 75%
  const objetivo = 0.75
  const devueltosSiObjetivo = resueltos ? Math.round(resueltos * (1 - objetivo)) : 0
  const devolucionesEvitables = Math.max(0, devueltos - devueltosSiObjetivo)
  const ahorroPotencial = devolucionesEvitables * flete

  // Por ciudad / producto / mensajero, ordenados de peor a mejor tasa
  const porCiudad = agrupar(lista, e => e.ciudad, flete).sort((a, b) => a.tasa - b.tasa)
  const porProducto = agrupar(lista, e => e.producto, flete).sort((a, b) => a.tasa - b.tasa)
  const porMensajero = agrupar(lista, e => e.mensajero, flete).sort((a, b) => a.tasa - b.tasa)

  // Top motivos de devolución
  const motivosMap = {}
  for (const e of lista) {
    if (e.categoria !== 'devuelto') continue
    const m = (e.motivo || 'Sin motivo').trim() || 'Sin motivo'
    motivosMap[m] = (motivosMap[m] || 0) + 1
  }
  const motivos = Object.entries(motivosMap)
    .map(([motivo, cantidad]) => ({ motivo, cantidad, pct: devueltos ? cantidad / devueltos : 0 }))
    .sort((a, b) => b.cantidad - a.cantidad)

  return {
    entregados, devueltos, enProceso, resueltos,
    tasaGeneral,
    fleteFallo,          // plata ya perdida en fletes de devoluciones (del período)
    ahorroPotencial,     // lo que recuperarías llegando al 75%
    porCiudad, porProducto, porMensajero, motivos,
  }
}

// Serie temporal: tasa de entrega por mes (para ver tendencia).
// entregas: [{ categoria, fecha }] (fecha ISO)
export function tasaPorMes(entregas) {
  const map = {}
  for (const e of (entregas || [])) {
    if (!e.fecha) continue
    // Solo lo RESUELTO cuenta para la tasa. 'en_proceso' todavía no cerró y
    // 'no_despachado' nunca salió — ninguno debe crear un mes con 0%.
    if (e.categoria !== 'entregado' && e.categoria !== 'devuelto') continue
    const mes = String(e.fecha).slice(0, 7)
    if (!map[mes]) map[mes] = { mes, entregados: 0, devueltos: 0 }
    if (e.categoria === 'entregado') map[mes].entregados++
    else if (e.categoria === 'devuelto') map[mes].devueltos++
  }
  return Object.values(map)
    .map(m => ({ ...m, tasa: (m.entregados + m.devueltos) ? m.entregados / (m.entregados + m.devueltos) : 0 }))
    .sort((a, b) => a.mes.localeCompare(b.mes))
}

// ── Lectura de la base para Inteligencia (12-10) ─────────────
// Antes la pantalla filtraba por fecha_entrega: las filas de Lucero en
// tránsito y las devueltas/canceladas NO tienen esa fecha (solo la tienen las
// entregadas), así que Lucero salía con 100 % de entrega. Ahora:
//   · el período se filtra por fecha_ingreso (cuándo salió el paquete), que
//     tienen todas las filas;
//   · la categoría sale de sanearEntrega (fuente única): respeta la categoría
//     propia de Lucero (Cancelado = devuelto) y aplica las reglas de PaP;
//   · lo que nunca salió (borrador / no ingresó) se descarta: no es ni
//     entregado, ni devuelto, ni "en camino".
export const COLUMNAS_INTELIGENCIA = 'ciudad, producto, mensajero, motivo, estado_pap, categoria, transportadora, fecha_ingreso, fecha_entrega'
export const COLUMNA_FECHA_PERIODO = 'fecha_ingreso'

export function normalizarParaInteligencia(filas) {
  return (filas || [])
    .map(sanearEntrega)
    .filter(e => e.categoria !== 'no_despachado')
    .map(e => ({
      categoria: e.categoria,
      ciudad: e.ciudad, producto: e.producto, mensajero: e.mensajero,
      motivo: e.motivo, transportadora: e.transportadora,
      fecha: e.fecha_ingreso || e.fecha_entrega || null,
    }))
}

// Serie mensual con la regla común (por mes de INGRESO): entregados,
// devueltos, en camino y la tasa realista. El último mes casi siempre tiene
// mucho en camino; con muestra chica no sirve para marcar tendencia.
export function serieRealista(entregas, hist = null) {
  const map = {}
  for (const e of (entregas || [])) {
    if (!e.fecha) continue
    const mes = String(e.fecha).slice(0, 7)
    if (!map[mes]) map[mes] = { mes, entregados: 0, devueltos: 0, enCamino: 0 }
    if (e.categoria === 'entregado') map[mes].entregados++
    else if (e.categoria === 'devuelto') map[mes].devueltos++
    else map[mes].enCamino++
  }
  return Object.values(map)
    .map(m => ({ ...m, t: tasaEntregaRealista({ ...m, hist }) }))
    .sort((a, b) => a.mes.localeCompare(b.mes))
}

// Tendencia último mes vs anterior, solo si los dos tienen resueltos
// suficientes (si no, se compararían proyecciones). null = no mostrar.
export function tendenciaRealista(serie) {
  if (!serie || serie.length < 2) return null
  const ult = serie[serie.length - 1].t, prev = serie[serie.length - 2].t
  if (!ult || !prev || ult.muestraChica || prev.muestraChica || ult.esperada == null || prev.esperada == null) return null
  return { sube: ult.esperada >= prev.esperada, delta: Math.round(ult.esperada - prev.esperada) }
}

export { TASA_CRITICA, TASA_VIGILAR, MIN_PEDIDOS }
