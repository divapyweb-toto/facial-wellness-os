import { getFlete } from './config'
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
  let facturado = 0, cobrado = 0, cogs = 0, flete = 0

  // Los CONTEOS son por PEDIDO, no por línea: un pedido de 2 productos son 2
  // filas en `ventas`, y contarlas como 2 pedidos abarataba el CPA a la mitad.
  // Las sumas de plata sí van por línea, que es donde vive cada monto.
  const pedidosDespachados = new Set()
  const pedidosEntregados = new Set()
  const pedidosDevueltos = new Set()
  const pedidosEnProceso = new Set()
  const clavePedido = (v, i) => {
    const r = normRef(v.n_referencia)
    // Sin referencia utilizable no se puede agrupar: cuenta como pedido propio.
    return (r && /\d/.test(r)) ? `${r}|${v.fecha || ''}` : `__linea_${i}`
  }

  ;(ventas || []).forEach((v, i) => {
    const cat = estadoDe(v, estadoPaP)
    const total = Number(v.total) || 0
    const costoProd = Number(v.costo_prod) || cogsPromedio
    // Respaldo solo si la venta no tiene el flete congelado. Sale de config,
    // no de un número fijo: con dos transportadoras el flete ya no es único.
    // OJO: con `||` un flete de 0 caía al valor por defecto, y las líneas
    // secundarias de un pedido multiproducto van justamente en 0 (una caja,
    // un solo flete). Eso inventaba flete que nadie pagó.
    const costoEnvio = v.costo_envio == null ? getFlete() : (Number(v.costo_envio) || 0)
    const k = clavePedido(v, i)
    pedidosDespachados.add(k)
    facturado += total
    if (cat === 'entregado') {
      pedidosEntregados.add(k)
      cobrado += total
      cogs += costoProd
      flete += costoEnvio // PaP cobra flete de los entregados
    } else if (cat === 'devuelto') {
      pedidosDevueltos.add(k)
      flete += costoEnvio // y también de los devueltos (flete perdido)
    } else {
      pedidosEnProceso.add(k)
    }
  })

  // Un pedido con una línea entregada y otra devuelta cuenta UNA vez, y como
  // entregado: la caja llegó. Sin esta desambiguación se sumaría en los dos y
  // la tasa de entrega daría más de 100%.
  const despachados = pedidosDespachados.size
  const entregados = pedidosEntregados.size
  const devueltos = [...pedidosDevueltos].filter(k => !pedidosEntregados.has(k)).length
  const enProceso = [...pedidosEnProceso]
    .filter(k => !pedidosEntregados.has(k) && !pedidosDevueltos.has(k)).length

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
