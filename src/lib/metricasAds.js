// src/lib/metricasAds.js
// ═══════════════════════════════════════════════════════════
// MÉTRICAS DE META ADS conectadas a las ventas REALES.
//
// El único dato que se carga a mano es el GASTO (lo que Meta sabe y el sistema
// no). Todo lo demás sale de las ventas + entregas de PaP.
//
// La clave para COD: Meta cuenta pedidos HECHOS, pero lo que importa es lo
// ENTREGADO/COBRADO. Con ~70% de entrega, el CPA y ROAS reales son muy
// distintos a los de Meta. Este módulo calcula los dos y da un veredicto.
// ═══════════════════════════════════════════════════════════

// Umbral del veredicto: si la ganancia neta es al menos 10% del gasto → gana;
// si está cerca de cero (±10%) → ajustar; si es más negativa → pierde.
const BANDA_VEREDICTO = 0.10

// Resuelve el estado real de una venta (PaP primero, luego ventas.estado).
function estadoDe(v, estadoPaP) {
  const ref = normRef(v.n_referencia)
  const cat = estadoPaP?.[ref]
  if (cat) return cat
  if (v.estado === 'entregado') return 'entregado'
  if (v.estado === 'devuelto') return 'devuelto'
  return 'en_proceso'
}

function normRef(ref) {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}

// Calcula todas las métricas de una campaña/producto a partir de:
//   gasto: número (lo cargado a mano)
//   ventas: array de ventas del producto en el mes [{ total, n_referencia, estado, costo_prod, costo_envio }]
//   estadoPaP: { normRef → categoría } (opcional, más preciso)
//   cogsPromedio: costo de producto de respaldo si la venta no lo trae
export function calcularMetricasAds(gasto, ventas, estadoPaP = {}, cogsPromedio = 12000) {
  const g = Number(gasto) || 0
  let despachados = 0, entregados = 0, devueltos = 0, enProceso = 0
  let facturado = 0, cobrado = 0, cogs = 0, flete = 0

  for (const v of (ventas || [])) {
    const cat = estadoDe(v, estadoPaP)
    const total = Number(v.total) || 0
    const costoProd = Number(v.costo_prod) || cogsPromedio
    const costoEnvio = Number(v.costo_envio) || 29000
    despachados++
    facturado += total
    if (cat === 'entregado') {
      entregados++
      cobrado += total
      cogs += costoProd
      flete += costoEnvio // PaP cobra flete de los entregados
    } else if (cat === 'devuelto') {
      devueltos++
      flete += costoEnvio // y también de los devueltos (flete perdido)
    } else {
      enProceso++
    }
  }

  const resueltos = entregados + devueltos
  const tasaEntrega = resueltos ? entregados / resueltos : 0

  const cpaPedido = despachados ? g / despachados : 0     // comparable con Meta
  const cpaReal = entregados ? g / entregados : 0         // costo por cliente que paga
  const roasBruto = g ? facturado / g : 0                 // sobre facturado
  const roasReal = g ? cobrado / g : 0                    // sobre cobrado (el que decide)

  // Ganancia neta: lo cobrado menos gasto de ads, costo de producto y flete.
  const gananciaNeta = cobrado - g - cogs - flete

  // Veredicto según la ganancia neta relativa al gasto
  let veredicto = 'ajustar'
  if (g > 0) {
    if (gananciaNeta >= g * BANDA_VEREDICTO) veredicto = 'gana'
    else if (gananciaNeta < -g * BANDA_VEREDICTO) veredicto = 'pierde'
    else veredicto = 'ajustar'
  } else {
    veredicto = 'sin_gasto'
  }

  return {
    gasto: g,
    despachados, entregados, devueltos, enProceso,
    facturado, cobrado, cogs, flete,
    tasaEntrega,
    cpaPedido: Math.round(cpaPedido),
    cpaReal: Math.round(cpaReal),
    roasBruto: Number(roasBruto.toFixed(2)),
    roasReal: Number(roasReal.toFixed(2)),
    gananciaNeta: Math.round(gananciaNeta),
    veredicto,
  }
}

// Texto del veredicto para mostrar
export function textoVeredicto(m, nombreProducto = 'Esta campaña') {
  const fmt = (n) => Number(n || 0).toLocaleString('es-PY')
  if (m.veredicto === 'sin_gasto') return 'Cargá el gasto para ver el resultado.'
  if (m.veredicto === 'gana') return `${nombreProducto} deja Gs. ${fmt(m.gananciaNeta)} limpios. Rinde — se puede escalar.`
  if (m.veredicto === 'pierde') return `${nombreProducto} pierde Gs. ${fmt(Math.abs(m.gananciaNeta))}. Cortá o cambiá creativo/oferta.`
  return `${nombreProducto} está al límite (Gs. ${fmt(m.gananciaNeta)}). Ajustá para que rinda.`
}

export { BANDA_VEREDICTO }
