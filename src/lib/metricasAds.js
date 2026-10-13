import { getFlete } from './config'
import { tasaEntregaRealista, REFERENCIA_TASA } from './tasaEntrega'
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
//   opciones.hist: { entregados, resueltos } de otros períodos para proyectar lo
//     que está en camino (12-10). Sin hist se usa la tasa del propio período si
//     tiene ≥20 resueltos, y si no la referencia del 80% (ver tasaEntrega.js).
export function calcularMetricasAds(gasto, ventas, estadoPaP = {}, cogsPromedio = 12000, { hist = null } = {}) {
  const g = Number(gasto) || 0
  let facturado = 0, cobrado = 0, cogs = 0, flete = 0
  // Plata de lo que todavía está en camino (12-10): para proyectar el resultado.
  let caminoTotal = 0, caminoCogs = 0, caminoFlete = 0

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
      caminoTotal += total
      caminoCogs += costoProd
      caminoFlete += costoEnvio
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

  // ── Lo que está en camino (12-10) ──
  // Antes el veredicto restaba TODO el gasto del mes contra lo ya cobrado: con
  // 4 cobrados y 23 en tránsito decía "Pierde, cortá" cuando la mayor parte de
  // lo que pagó ese gasto todavía no llegó. Ahora:
  //   - Muestra chica (<20 resueltos) Y algo en camino → 'esperar' (neutro), sin
  //     veredicto de cortar ni escalar. Si no hay nada en camino, el resultado
  //     ya es plata cerrada y el veredicto se da igual.
  //   - Muestra suficiente → el veredicto usa la ganancia PROYECTADA: lo firme
  //     + lo en camino × tasa (el flete se paga igual; lo devuelto vuelve al
  //     stock, así que su mercadería no se pierde). Misma fórmula que Reportes.
  const tasa = tasaEntregaRealista({
    entregados, devueltos, enCamino: enProceso,
    hist: hist || { entregados, resueltos },
  })
  const contribEnCamino = enProceso
    ? tasa.tasaUsada * (caminoTotal - caminoCogs) - caminoFlete
    : 0
  const gananciaProyectada = gananciaNeta + contribEnCamino
  const esperar = tasa.muestraChica && enProceso > 0

  // Veredicto según la ganancia (proyectada) relativa al gasto
  let veredicto = 'ajustar'
  if (g > 0) {
    if (esperar) veredicto = 'esperar'
    else if (gananciaProyectada >= g * BANDA_VEREDICTO) veredicto = 'gana'
    else if (gananciaProyectada < -g * BANDA_VEREDICTO) veredicto = 'pierde'
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
    // 12-10: proyección de lo en camino y tasa realista (~esperada, rango, en camino)
    gananciaProyectada: Math.round(gananciaProyectada),
    contribEnCamino: Math.round(contribEnCamino),
    tasa,
    veredicto,
  }
}

// Texto del veredicto para mostrar
// 12-10: con lo en camino, el resultado que decide es el PROYECTADO y se dice.
export function textoVeredicto(m, nombreProducto = 'Esta campaña') {
  const fmt = (n) => Number(n || 0).toLocaleString('es-PY')
  if (m.veredicto === 'sin_gasto') return 'Sin gasto de Meta este mes para este producto.'
  if (m.veredicto === 'esperar') {
    const res = m.entregados + m.devueltos
    return `Esperá: ${m.enProceso} en camino y solo ${res} resuelto${res === 1 ? '' : 's'} (muestra chica). `
      + `Hasta hoy: Gs. ${fmt(m.gananciaNeta)}. No cortes ni escales todavía.`
  }
  const proy = m.gananciaProyectada ?? m.gananciaNeta
  const nota = m.enProceso > 0 && m.tasa
    ? ` (incluye ${m.enProceso} en camino proyectados al ${Math.round(m.tasa.tasaUsada * 100)}%${m.tasa.fuente === 'historica' ? '' : ' de referencia'})`
    : ''
  if (m.veredicto === 'gana') return `${nombreProducto} deja Gs. ${fmt(proy)} limpios${nota}. Rinde — se puede escalar.`
  if (m.veredicto === 'pierde') return `${nombreProducto} pierde Gs. ${fmt(Math.abs(proy))}${nota}. Cortá o cambiá creativo/oferta.`
  return `${nombreProducto} está al límite (Gs. ${fmt(proy)}${nota}). Ajustá para que rinda.`
}

// ── Gasto cargado a mano en Campañas (campanas_ads) — 12-10 ──
// Suma por familia (en "Todas" hay filas de las dos tiendas con la misma
// familia: antes la segunda pisaba a la primera). Solo cuenta como carga
// manual si hay gasto > 0, igual que gastosAutomaticos (mesesConCampanas).
export function leerCampanasManual(filas = []) {
  const suma = {}
  let modo = 'producto'
  for (const c of (filas || [])) {
    const fam = c.nombre || c.familia || 'total'
    suma[fam] = (suma[fam] || 0) + (Number(c.gasto) || 0)
    if (fam === 'total') modo = 'total'
  }
  const gastos = Object.fromEntries(Object.entries(suma).map(([f, g]) => [f, g ? String(g) : '']))
  const hayManual = Object.values(suma).some(g => g > 0)
  return { gastos, modo, hayManual }
}

// Qué filas de campanas_ads reemplaza el botón Guardar de Meta Ads (12-10):
// SOLO las de la tienda que escribe y SOLO las familias que la pantalla
// muestra (+ 'total'). Antes borraba todo el mes, de las dos tiendas, y
// también filas que la pantalla no muestra (ej. 'sin_atribuir').
export function filtroBorradoCampanas({ mes, tienda, familias = [] }) {
  if (!mes || !tienda || tienda === 'todas') return null // en "Todas" no se guarda
  return { mes, tienda, nombres: [...familias, 'total'] }
}

// Gasto efectivo de la pantalla Meta Ads (12-10). La carga manual de un mes
// manda; si no hay, se usa Meta sincronizado (gasto_ads_diario). En "Todas",
// `meta` ya viene sin las tiendas que tienen carga manual (armarGastosAutomaticos
// con mesesConCampanas), así que sumar las dos no cuenta nada dos veces.
//   meta: { porFamilia, total } | null
export function gastoEfectivoAds({ modo = 'producto', gastos = {}, familias = [], meta = null, usaMeta = false }) {
  const m = usaMeta && meta ? meta : { porFamilia: {}, total: 0 }
  const porFamilia = {}
  for (const f of familias) porFamilia[f] = (Number(gastos[f]) || 0) + (Number(m.porFamilia?.[f]) || 0)
  const manual = modo === 'total'
    ? (Number(gastos.total) || 0)
    : familias.reduce((s, f) => s + (Number(gastos[f]) || 0), 0)
  const metaTotal = Number(m.total) || 0
  const metaSinFamilia = Math.max(0, metaTotal - familias.reduce((s, f) => s + (Number(m.porFamilia?.[f]) || 0), 0))
  return { porFamilia, total: manual + metaTotal, manual, metaTotal, metaSinFamilia }
}

// ── Salida total del mes en Finanzas (12-10) ──
// Misma fórmula que Dashboard/Reportes: gastos cargados (sin doble conteo de
// Publicidad) + ads (Campañas a mano + Meta sincronizado) + automáticos
// (WhatsApp, Claude, ElevenLabs, fijos). Antes Finanzas sumaba solo `gastos` y
// `campanas_ads` y en Voltra daba 0 aunque Meta tuviera gasto sincronizado.
//   gastosSinDoble: resultado de gastosSinDobleAds(gastos, adsManual + metaSync)
//   auto: resultado de armarGastosAutomaticos (o null si no se pudo leer)
export function resumenSalidaMes({ gastosBruto = 0, gastosSinDoble = null, adsManual = 0, auto = null }) {
  const metaSync = Number(auto?.metaTotal) || 0
  const totalAds = (Number(adsManual) || 0) + metaSync
  const totalGastos = gastosSinDoble ? gastosSinDoble.totalGastos : (Number(gastosBruto) || 0)
  const automaticos = Number(auto?.totalGs) || 0
  return {
    gastosBruto: Number(gastosBruto) || 0,
    totalGastos, adsManual: Number(adsManual) || 0, metaSync, totalAds,
    automaticos,
    whatsappGs: Number(auto?.whatsappGs) || 0,
    claudeGs: Number(auto?.claudeGs) || 0,
    elevenlabsGs: Number(auto?.elevenlabsGs) || 0,
    fijosGs: Number(auto?.fijosGs) || 0,
    posibleDoble: !!gastosSinDoble?.posibleDoble,
    gastoPublicidad: Number(gastosSinDoble?.gastoPublicidad) || 0,
    faltaTipoCambio: !!auto?.faltaTipoCambio,
    salidaTotal: totalGastos + totalAds + automaticos,
  }
}

export { BANDA_VEREDICTO, REFERENCIA_TASA }
