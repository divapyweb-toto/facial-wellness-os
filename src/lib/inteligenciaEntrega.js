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
export function analizarEntregas(entregas, flete = 29000) {
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

export { TASA_CRITICA, TASA_VIGILAR, MIN_PEDIDOS }
