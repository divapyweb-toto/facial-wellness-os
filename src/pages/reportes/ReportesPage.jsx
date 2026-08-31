// src/pages/reportes/ReportesPage.jsx
import { useState, useCallback, useRef, useEffect } from 'react'
import { supabase, formatGs, formatPct } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { agruparSerie } from '../../lib/periodos'
import { FileBarChart2, Download, Loader2, ArrowUpRight, ArrowDownRight, Minus, AlertTriangle, MapPin, Truck, Calendar, Repeat, FileText } from 'lucide-react'
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts'
import { familiaProducto } from '../../lib/recompra'
import { calcularMetricasAds } from '../../lib/metricasAds'

// Normaliza n_referencia igual que metricasAds/AdsPage (para cruzar ventas ↔ entregas)
const normRef = (ref) => {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}
const FAMILIAS_ADS_REP = [
  ['nasal', 'Tiras Nasales'], ['parche', 'Parches Bucales'], ['gudair', 'Pack Gudair'],
  ['lengua', 'Raspador de Lengua'], ['jaw', 'JawFlex Pro'], ['botella', 'Botella Flexible'], ['bebird', 'Bebird Pro'],
]

const COLORS = ['#c8f135', '#22c55e', '#3b82f6', '#a78bfa', '#f59e0b', '#ef4444', '#ec4899']

// Badge de variación vs mes anterior
// eslint-disable-next-line no-unused-vars
function Delta({ actual, anterior, invertido = false }) {
  if (anterior == null || anterior === 0) return <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>nuevo</span>
  const delta = ((actual - anterior) / anterior) * 100
  const bueno = invertido ? delta < 0 : delta > 0
  const color = Math.abs(delta) < 0.5 ? 'var(--text-muted)' : bueno ? 'var(--green)' : 'var(--red)'
  const Icon = delta > 0.5 ? ArrowUpRight : delta < -0.5 ? ArrowDownRight : Minus
  return (
    <span style={{ color, fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <Icon size={10} />{Math.abs(delta).toFixed(0)}%
    </span>
  )
}

export default function ReportesPage() {
  const [mes, setMes] = useState(new Date().toISOString().substring(0, 7))
  // Excluir mayoristas del reporte. Va en TRUE por defecto a propósito: los
  // números con los que se deciden precios y campañas (ticket promedio, CPA,
  // mix ×1/×2/×3) se distorsionan con un pedido de 20 unidades que no vino de
  // ads. Para el cierre de caja se destilda y entran todos.
  const [sinMayoristas, setSinMayoristas] = useState(true)
  const [datos, setDatos] = useState(null)
  const [loading, setLoading] = useState(false)
  const [generandoPdf, setGenerandoPdf] = useState(false)
  const reportRef = useRef()

  const cargarDatos = useCallback(async () => {
    setLoading(true)
    // Rango del mes elegido y del mes anterior (para comparar)
    const [year, month] = mes.split('-').map(Number)
    const inicio = `${mes}-01`
    const fin = new Date(year, month, 0).toISOString().slice(0, 10)
    // ── Comparativa justa contra el mes anterior ──
    // Si el mes elegido es el que está EN CURSO, solo tiene datos hasta hoy.
    // Compararlo contra el mes anterior COMPLETO da caídas falsas (el día 5
    // serían 5 días contra 31). Se recorta el mes anterior al mismo día.
    const hoy = new Date()
    const esMesEnCurso = year === hoy.getFullYear() && month === hoy.getMonth() + 1
    const dPrev = new Date(year, month - 2, 1)
    const ultimoDiaPrev = new Date(dPrev.getFullYear(), dPrev.getMonth() + 1, 0).getDate()
    const diaCorte = esMesEnCurso ? Math.min(hoy.getDate(), ultimoDiaPrev) : ultimoDiaPrev
    const inicioPrev = `${dPrev.getFullYear()}-${String(dPrev.getMonth() + 1).padStart(2, '0')}-01`
    const finPrev = new Date(dPrev.getFullYear(), dPrev.getMonth(), diaCorte).toISOString().slice(0, 10)
    const diasComparados = esMesEnCurso ? diaCorte : null
    // Objeto de período mensual (para etiquetas y la serie por día)
    const P = { tipo: 'mensual', granularidad: 'dia', inicio, fin, inicioPrev, finPrev,
      etiqueta: new Date(year, month - 1, 1).toLocaleDateString('es-PY', { month: 'long', year: 'numeric' }) }

    // Paginado: un mes a 100 pedidos/día son ~3.000 filas y Supabase corta en 1.000.
    // El cierre financiero no puede calcularse con datos recortados.
    const [ventasCrudas, ventasPrevCrudas, gastos, campanas, productos, entregas] = await Promise.all([
      // `es_mayorista` puede no existir todavía (migración 005). fetchAllSafe
      // evita que el reporte entero falle por eso: si la columna falta, se
      // reintenta sin ella y el filtro simplemente no se aplica.
      fetchAll(() => supabase.from('ventas').select('n_referencia, fecha, total, estado, ganancia_neta, costo_prod, costo_envio, producto_nombre, cantidad, ciudad, cliente_telefono, transportadora, pago_anticipado, es_mayorista').is('deleted_at', null).gte('fecha', inicio).lte('fecha', fin).order('fecha'))
        .catch(() => fetchAll(() => supabase.from('ventas').select('n_referencia, fecha, total, estado, ganancia_neta, costo_prod, costo_envio, producto_nombre, cantidad, ciudad, cliente_telefono, transportadora, pago_anticipado').is('deleted_at', null).gte('fecha', inicio).lte('fecha', fin).order('fecha'))),
      fetchAll(() => supabase.from('ventas').select('fecha, total, estado, ganancia_neta, es_mayorista').is('deleted_at', null).gte('fecha', inicioPrev).lte('fecha', finPrev))
        .catch(() => fetchAll(() => supabase.from('ventas').select('fecha, total, estado, ganancia_neta').is('deleted_at', null).gte('fecha', inicioPrev).lte('fecha', finPrev))),
      fetchAll(() => supabase.from('gastos').select('fecha, monto, categoria, concepto').is('deleted_at', null).gte('fecha', inicio).lte('fecha', fin)),
      fetchAll(() => supabase.from('campanas_ads').select('*').gte('mes', inicio.slice(0, 7)).lte('mes', fin.slice(0, 7))),
      fetchAll(() => supabase.from('productos').select('id, nombre, costo_unit, activo').eq('activo', true)),
      fetchAll(() => supabase.from('entregas').select('n_referencia, categoria, estado_pap, motivo, importe, rendido, dias_rendicion, fecha_entrega').gte('fecha_entrega', inicio).lte('fecha_entrega', fin), { columnaOrden: 'nro_guia_pap' }),
    ])

    // ── Filtro de mayoristas ──
    // Se aplica ACÁ, una sola vez, sobre la lista cruda: así todo lo que se
    // calcula abajo (contribución por producto, ticket, tasas, gráficos)
    // trabaja sobre el mismo universo y no hay forma de que un cálculo quede
    // filtrado y otro no.
    const esMayorista = (v) => v.es_mayorista === true
    const mayoristasExcluidos = sinMayoristas ? (ventasCrudas || []).filter(esMayorista).length : 0
    const ventas = sinMayoristas ? (ventasCrudas || []).filter(v => !esMayorista(v)) : (ventasCrudas || [])
    const ventasPrev = sinMayoristas ? (ventasPrevCrudas || []).filter(v => !esMayorista(v)) : (ventasPrevCrudas || [])

    const entregadas = (ventas || []).filter(v => v.estado === 'entregado')
    const pendientes = (ventas || []).filter(v => v.estado === 'pendiente')
    const devueltas = (ventas || []).filter(v => v.estado === 'devuelto')

    // Por producto (con tasa de devolución)
    // ── Margen REAL por producto ──
    // Antes esto solo contaba ventas y devoluciones. El número que falta para
    // decidir qué escalar y qué discontinuar es la CONTRIBUCIÓN: lo que deja
    // cada producto después de su costo y su flete.
    //
    // La clave está en el flete: se paga por TODO lo despachado, entregado o
    // devuelto. Un producto con 36% de devolución paga flete por 100 paquetes
    // y cobra por 64. Mirar solo el margen de lo entregado esconde esa pérdida.
    const porProducto = {}
    ;(ventas || []).forEach(v => {
      const k = v.producto_nombre || '(sin producto)'
      if (!porProducto[k]) porProducto[k] = {
        nombre: k, ventas: 0, entregados: 0, devueltos: 0, enTransito: 0,
        ingresos: 0, cobrado: 0, cogs: 0, flete: 0, unidades: 0,
      }
      const p = porProducto[k]
      p.ventas++
      // El flete se paga por todo lo RESUELTO (entregado o devuelto).
      if (v.estado === 'entregado' || v.estado === 'devuelto') p.flete += (v.costo_envio || 0)
      if (v.estado === 'entregado') {
        p.entregados++
        p.cobrado += (v.total || 0)
        p.cogs += (v.costo_prod || 0)
        p.unidades += (v.cantidad || 1)
        p.ingresos += (v.ganancia_neta || 0)
      } else if (v.estado === 'devuelto') {
        p.devueltos++
        // La mercadería devuelta vuelve al stock: su COGS no se pierde.
      } else p.enTransito++
    })
    const porProductoArr = Object.values(porProducto).map(p => {
      const res = p.entregados + p.devueltos
      // Contribución = lo cobrado − costo de lo vendido − flete de TODO lo resuelto.
      const contribucion = p.cobrado - p.cogs - p.flete
      return {
        ...p,
        tasaDevolucion: res ? Math.round(p.devueltos / res * 100) : 0,
        tasaEntrega: res ? (p.entregados / res) * 100 : null,
        contribucion,
        // Margen sobre lo cobrado: cuánto de cada guaraní queda.
        margenPct: p.cobrado ? (contribucion / p.cobrado) * 100 : null,
        // LA métrica de decisión: lo que deja cada paquete DESPACHADO, no cada
        // venta cerrada. Incorpora el costo de las devoluciones, así que un
        // producto que se devuelve mucho cae acá aunque su ticket sea alto.
        contribPorDespacho: res ? contribucion / res : null,
        ticketPromedio: p.entregados ? p.cobrado / p.entregados : null,
      }
    }).sort((a, b) => b.contribucion - a.contribucion)

    // Por día del mes (para el gráfico)
    const diasDelMes = new Date(year, month, 0).getDate()
    const hoyStr = new Date().toISOString().slice(0, 10)
    const porDia = []
    for (let d = 1; d <= diasDelMes; d++) {
      const fechaStr = `${mes}-${String(d).padStart(2, '0')}`
      const ventasDia = entregadas.filter(v => v.fecha === fechaStr)
      if (ventasDia.length > 0 || fechaStr <= hoyStr) {
        porDia.push({ dia: d, ventas: ventasDia.reduce((s, v) => s + v.total, 0), neto: ventasDia.reduce((s, v) => s + (v.ganancia_neta || 0), 0), cantidad: ventasDia.length })
      }
    }

    const totalGastos = (gastos || []).reduce((s, g) => s + g.monto, 0)
    const totalGastoAds = (campanas || []).reduce((s, c) => s + c.gasto, 0)

    // ── Comparativa con mes anterior ──
    const entregadasPrev = (ventasPrev || []).filter(v => v.estado === 'entregado')
    const comparativa = {
      ventasBrutas: entregadasPrev.reduce((s, v) => s + v.total, 0),
      ingresosNetos: entregadasPrev.reduce((s, v) => s + (v.ganancia_neta || 0), 0),
      paquetes: (ventasPrev || []).length,
      entregados: entregadasPrev.length,
      devueltos: (ventasPrev || []).filter(v => v.estado === 'devuelto').length,
      // Tasa sobre RESUELTOS (entregados + devueltos), no sobre el total: los
      // paquetes en tránsito todavía no fallaron, contarlos como fracaso
      // subestima la tasa sistemáticamente.
      tasaEntrega: (() => {
        const dev = (ventasPrev || []).filter(v => v.estado === 'devuelto').length
        const res = entregadasPrev.length + dev
        return res ? (entregadasPrev.length / res) * 100 : 0
      })(),
    }

    // ── Cobranza (de entregas del mes) ──
    const entItems = (entregas || [])
    const entEntregadas = entItems.filter(e => (e.categoria === 'entregado') || (e.estado_pap || '').toLowerCase().includes('entregado'))
    const rendidas = entEntregadas.filter(e => e.rendido)
    const sinRendir = entEntregadas.filter(e => !e.rendido)
    const diasRend = rendidas.map(e => e.dias_rendicion).filter(d => d != null && d >= 0)
    const diasOrden = [...diasRend].sort((a, b) => a - b)
    const medianaCobro = diasOrden.length
      ? (diasOrden.length % 2
          ? diasOrden[(diasOrden.length - 1) / 2]
          : (diasOrden[diasOrden.length / 2 - 1] + diasOrden[diasOrden.length / 2]) / 2)
      : null
    const cobroTrancados = diasRend.filter(d => d > 14).length  // cobros que tardaron +14 días (inflan el promedio)
    const cobranza = {
      cobrado: rendidas.reduce((s, e) => s + (e.importe || 0), 0),
      porCobrar: sinRendir.reduce((s, e) => s + (e.importe || 0), 0),
      nRendidas: rendidas.length, nSinRendir: sinRendir.length,
      // Mediana = cobro TÍPICO (robusto). Promedio = sensible a outliers: pocos cobros trancados lo disparan.
      medianaCobro,
      promedioCobro: diasRend.length ? diasRend.reduce((a, b) => a + b, 0) / diasRend.length : null,
      cobroMax: diasOrden.length ? diasOrden[diasOrden.length - 1] : null,
      cobroTrancados,
      hayCobranza: entItems.some(e => e.rendido || e.fecha_rendido),
    }

    // ── Ciudades ──
    const ciudadMap = {}
    ;(ventas || []).forEach(v => {
      const c = (v.ciudad || 'Sin ciudad').trim()
      if (!ciudadMap[c]) ciudadMap[c] = { ciudad: c, pedidos: 0, entregados: 0, devueltos: 0 }
      ciudadMap[c].pedidos++
      if (v.estado === 'entregado') ciudadMap[c].entregados++
      if (v.estado === 'devuelto') ciudadMap[c].devueltos++
    })
    const ciudades = Object.values(ciudadMap).map(c => {
      const res = c.entregados + c.devueltos
      return { ...c, tasaEntrega: res ? Math.round(c.entregados / res * 100) : 0, tasaDevolucion: res ? Math.round(c.devueltos / res * 100) : 0 }
    }).filter(c => c.pedidos >= 2).sort((a, b) => b.pedidos - a.pedidos)

    // ── Día de la semana ──
    const diasNombre = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
    const dM = {}; for (let i = 0; i < 7; i++) dM[i] = { entregados: 0, devueltos: 0 }
    ;(ventas || []).forEach(v => {
      if (!v.fecha) return
      const p = String(v.fecha).slice(0, 10).split('-').map(Number)
      if (p.length !== 3) return
      const dow = new Date(p[0], p[1] - 1, p[2]).getDay()
      if (v.estado === 'entregado') dM[dow].entregados++
      else if (v.estado === 'devuelto') dM[dow].devueltos++
    })
    const porDiaSemana = [1, 2, 3, 4, 5, 6, 0].map(i => {
      const d = dM[i]; const res = d.entregados + d.devueltos
      return { dia: diasNombre[i].slice(0, 3), devolucion: res ? Math.round(d.devueltos / res * 100) : 0, total: res }
    })

    // ── Motivos de devolución (de entregas) ──
    const motMap = {}
    entItems.filter(e => (e.categoria === 'devuelto') || (e.estado_pap || '').toLowerCase().includes('devuelto')).forEach(e => {
      const m = (e.motivo || 'Sin motivo').trim()
      motMap[m] = (motMap[m] || 0) + 1
    })
    const motivos = Object.entries(motMap).map(([m, n]) => ({ motivo: m, count: n })).sort((a, b) => b.count - a.count)

    // ── Recompras ──
    const telMap = {}
    ;(ventas || []).forEach(v => { const t = String(v.cliente_telefono || '').replace(/\D/g, ''); if (t.length >= 6) telMap[t] = (telMap[t] || 0) + 1 })
    const clientesUnicos = Object.keys(telMap).length
    const recompradores = Object.values(telMap).filter(n => n > 1).length

    // ── Alertas accionables ──
    const alertas = []
    porProductoArr.filter(p => (p.entregados + p.devueltos) >= 3 && p.tasaDevolucion >= 35)
      .forEach(p => alertas.push({ tipo: 'producto', texto: `"${p.nombre}" tiene ${p.tasaDevolucion}% de devolución. Revisá la confirmación antes de despachar o filtrá ciudades.` }))
    ciudades.filter(c => c.pedidos >= 3 && c.tasaDevolucion >= 50)
      .slice(0, 4).forEach(c => alertas.push({ tipo: 'ciudad', texto: `${c.ciudad}: ${c.tasaDevolucion}% de devolución (${c.pedidos} pedidos). Considerá confirmar por WhatsApp o pausar esa zona.` }))
    if (cobranza.porCobrar > 0) alertas.push({ tipo: 'cobranza', texto: `Las transportadoras te deben ${formatGs(cobranza.porCobrar)} de ${cobranza.nSinRendir} entregas. Mirá el detalle por courier en Rendición.` })
    const peorDia = [...porDiaSemana].filter(d => d.total >= 3).sort((a, b) => b.devolucion - a.devolucion)[0]
    if (peorDia && peorDia.devolucion >= 45) alertas.push({ tipo: 'patron', texto: `Los pedidos del ${peorDia.dia} se devuelven ${peorDia.devolucion}%. Evaluá no despachar ese día o reforzar la confirmación.` })

    const sumE = (f) => entregadas.reduce((s, v) => s + (f(v) || 0), 0)
    const sumP = (f) => pendientes.reduce((s, v) => s + (f(v) || 0), 0)
    const sumD = (f) => devueltas.reduce((s, v) => s + (f(v) || 0), 0)

    const ventasBrutasCalc = sumE(v => v.total)                 // lo cobrado (entregadas) — ya incluye el envío
    const cogsEntregadas = sumE(v => v.costo_prod)              // costo mercadería entregada
    const cogsPendientes = sumP(v => v.costo_prod)              // costo mercadería pendiente (info, no se resta)
    // Flete: ya NO es un valor fijo — sale de `costo_envio`, congelado por
    // venta al despachar con la tarifa real de esa transportadora en esa ciudad.
    // GANANCIA FIRME usa solo lo RESUELTO (entregadas + devueltas), igual que Entregas:
    // no contamos flete de pendientes porque puede que aún no se despacharon.
    const fleteEntregadas = sumE(v => v.costo_envio)
    const fletePendientes = sumP(v => v.costo_envio)           // en tránsito (no se resta de lo firme)
    const fleteDevoluciones = sumD(v => v.costo_envio)
    const fleteFirme = fleteEntregadas + fleteDevoluciones      // solo resueltos → unificado con Entregas
    const fleteTotal = fleteFirme + fletePendientes             // total incluyendo tránsito (referencia)
    // Ingreso neto de entregadas (= ganancia_neta = total − costo prod − flete; el envío ya viene en total)
    const ingresosNetosCalc = sumE(v => v.ganancia_neta)
    // ── GANANCIA FIRME ──
    //  Lo que ya cerró: dinero cobrado (entregadas) − flete de resueltos − costo mercadería vendida − gastos
    const dineroEntro = ventasBrutasCalc                        // lo cobrado (entregadas)
    const costoMercaderiaVendida = cogsEntregadas               // costo de lo entregado/vendido
    // Ganancia = cobrado − flete − costo mercadería − gastos − gasto en ads (Meta).
    // El ads viene del módulo Campañas y también es plata que sale.
    const utilidadNetaCalc = dineroEntro - fleteFirme - totalGastos - costoMercaderiaVendida - totalGastoAds
    // Protección anti-doble: ¿hay gasto de "Publicidad" en Gastos Y también ads en Campañas?
    const gastoPublicidadRep = (gastos || []).filter(g => /public|ads|meta|marketing/i.test(g.categoria || '')).reduce((s, g) => s + (g.monto || 0), 0)
    const posibleDobleAdsRep = totalGastoAds > 0 && gastoPublicidadRep > 0

    // ── Detalle de Meta Ads por producto (recalculado igual que la página Campañas) ──
    // campanas_ads solo guarda { mes, nombre(familia), gasto }; CPA/ROAS/ganancia se calculan al vuelo.
    const estadoPaPRep = {}
    ;(entregas || []).forEach(e => { const k = normRef(e.n_referencia); if (k && e.categoria) estadoPaPRep[k] = e.categoria })
    const gastoPorFam = {}
    ;(campanas || []).forEach(c => { const f = c.nombre || c.familia; if (f) gastoPorFam[f] = (gastoPorFam[f] || 0) + (Number(c.gasto) || 0) })
    const adsDetalle = FAMILIAS_ADS_REP.map(([fam, label]) => {
      const vs = (ventas || []).filter(v => familiaProducto(v.producto_nombre) === fam)
      const gasto = gastoPorFam[fam] || 0
      if (!vs.length && !gasto) return null
      return { familia: fam, label, ...calcularMetricasAds(gasto, vs, estadoPaPRep) }
    }).filter(Boolean)
    const ventasConFamilia = (ventas || []).filter(v => familiaProducto(v.producto_nombre))
    const adsTotal = { label: 'TOTAL', ...calcularMetricasAds(totalGastoAds, ventasConFamilia, estadoPaPRep) }

    // ── Desglose por transportadora ──
    // Hasta ahora todo el reporte asumía PaP: los fletes de Lucero y de "Otra"
    // se sumaban en la línea "Flete a Punto a Punto" sin distinguirse. Con dos
    // (o tres) couriers activos eso vuelve ilegible dónde se va la plata.
    const LABEL_TRANSP = { pap: 'Punto a Punto', lucero: 'Lucero del Este', otra: 'Otra transportadora' }
    const transpMap = {}
    ;(ventas || []).forEach(v => {
      const t = v.transportadora || 'pap'
      if (!transpMap[t]) transpMap[t] = {
        id: t, label: LABEL_TRANSP[t] || t,
        enviados: 0, entregados: 0, devueltos: 0, pendientes: 0,
        cobrado: 0, flete: 0, fleteFirme: 0, prepagos: 0,
      }
      const r = transpMap[t]
      r.enviados++
      if (v.pago_anticipado) r.prepagos++
      r.flete += (v.costo_envio || 0)
      if (v.estado === 'entregado') {
        r.entregados++; r.cobrado += (v.total || 0); r.fleteFirme += (v.costo_envio || 0)
      } else if (v.estado === 'devuelto') {
        r.devueltos++; r.fleteFirme += (v.costo_envio || 0)   // el flete se paga igual
      } else r.pendientes++
    })
    const porTransportadora = Object.values(transpMap).map(r => ({
      ...r,
      // Tasa sobre resueltos, igual criterio que el KPI general.
      tasaEntrega: (r.entregados + r.devueltos) ? (r.entregados / (r.entregados + r.devueltos)) * 100 : null,
      // Costo por entrega EXITOSA: el número que compara couriers de verdad,
      // porque incorpora las devoluciones (que pagan flete sin generar ingreso).
      costoPorEntrega: r.entregados ? r.fleteFirme / r.entregados : null,
    })).sort((a, b) => b.enviados - a.enviados)

    // ── Comparación cabeza a cabeza ──
    // La tabla de arriba muestra los números; esto los convierte en decisión.
    // Se comparan las DOS transportadoras con más envíos que tengan muestra
    // suficiente: con 2 o 3 paquetes resueltos cualquier diferencia es ruido,
    // y una recomendación basada en eso haría más daño que no decir nada.
    const MUESTRA_MINIMA = 5
    const comparables = porTransportadora
      .filter(t => (t.entregados + t.devueltos) >= MUESTRA_MINIMA && t.costoPorEntrega != null)
      .sort((a, b) => a.costoPorEntrega - b.costoPorEntrega)   // el más barato por entrega primero
    let duelo = null
    if (comparables.length >= 2) {
      const [gana, pierde] = comparables
      const difCosto = pierde.costoPorEntrega - gana.costoPorEntrega
      const difTasa = (gana.tasaEntrega ?? 0) - (pierde.tasaEntrega ?? 0)
      // Cuánto costaría el volumen del perdedor si se despachara por el ganador.
      const ahorroSiMigra = Math.round(difCosto * pierde.entregados)
      duelo = {
        gana, pierde, difCosto: Math.round(difCosto), difTasa, ahorroSiMigra,
        muestraChica: (gana.entregados + gana.devueltos) < 15 || (pierde.entregados + pierde.devueltos) < 15,
      }
    }

    setDatos({
      mes, periodo: P,
      // Cuántos mayoristas quedaron afuera: un reporte que esconde lo que
      // excluyó es un reporte en el que no se puede confiar.
      mayoristasExcluidos,
      serie: agruparSerie(ventas || [], P),
      ventasBrutas: ventasBrutasCalc,
      ingresosNetos: ingresosNetosCalc,
      totalGastos, totalGastoAds,
      cogsEntregadas, cogsPendientes, costoMercaderiaVendida,
      fleteEntregadas, fletePendientes, fleteDevoluciones, fleteFirme, fleteTotal,
      // Margen = ingreso neto de entregadas / ventas brutas
      margenPct: ventasBrutasCalc ? (ingresosNetosCalc / ventasBrutasCalc) * 100 : 0,
      paquetesEnviados: (ventas || []).length,
      porTransportadora, duelo, diasComparados,
      entregados: entregadas.length, devueltos: devueltas.length, pendientesCount: pendientes.length,
      // Misma corrección que arriba: denominador = resueltos, no total enviado.
      tasaEntrega: (entregadas.length + devueltas.length) ? (entregadas.length / (entregadas.length + devueltas.length)) * 100 : 0,
      utilidadNeta: utilidadNetaCalc,
      posibleDobleAds: posibleDobleAdsRep,
      porProducto: porProductoArr,
      porDia, campanas: campanas || [],
      gastos: gastos || [],
      adsDetalle, adsTotal,
      ventas: ventas || [],
      comparativa, cobranza, ciudades, porDiaSemana, motivos,
      clientesUnicos, recompradores, alertas,
    })
    setLoading(false)
    // `sinMayoristas` TIENE que estar acá. Sin él, useCallback congela el
    // valor de la primera vez (true) y el filtro no se puede apagar nunca,
    // por más que destildes y vuelvas a generar.
  }, [mes, sinMayoristas])

  // Al cambiar el filtro se regenera solo, pero SOLO si ya había un reporte en
  // pantalla: si no, abrir Reportes dispararía una carga pesada sin pedirla.
  const primeraCarga = useRef(true)
  useEffect(() => {
    if (primeraCarga.current) { primeraCarga.current = false; return }
    if (datos) cargarDatos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinMayoristas])

  const generarPDF = () => {
    if (!datos) return
    setGenerandoPdf(true)

    // Inyecta estilos de impresión: oculta todo menos el reporte, fuerza colores,
    // evita cortar tarjetas a la mitad entre páginas.
    const STYLE_ID = 'fw-print-styles'
    let styleEl = document.getElementById(STYLE_ID)
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = STYLE_ID
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = `
      @media print {
        @page { size: A4 portrait; margin: 12mm 10mm; }
        html, body { background: #ffffff !important; }
        body * { visibility: hidden !important; }
        #reporte-print, #reporte-print * { visibility: visible !important; }
        #reporte-print {
          position: absolute !important;
          left: 0 !important; top: 0 !important;
          width: 100% !important;
          margin: 0 !important; padding: 0 !important;
          background: #ffffff !important;
          color: #1a1a1a !important;
          font-family: 'Inter', -apple-system, sans-serif !important;
        }

        /* ── Documento ejecutivo: todo blanco y sobrio ── */
        #reporte-print * {
          background: transparent !important;
          color: #1a1a1a !important;
          box-shadow: none !important;
          text-shadow: none !important;
        }
        /* Tarjetas: borde fino gris, sin relleno oscuro */
        #reporte-print .card,
        #reporte-print .chart-card,
        #reporte-print .kpi-card,
        #reporte-print .table-wrapper {
          background: #ffffff !important;
          border: 1px solid #e2e2e2 !important;
          border-radius: 6px !important;
        }
        /* Verde sobrio (no neón) para positivos */
        #reporte-print [style*="--green"],
        #reporte-print [style*="rgb(34"],
        #reporte-print .green {
          color: #2a7a00 !important;
        }
        /* Rojo sobrio para negativos */
        #reporte-print [style*="--red"],
        #reporte-print [style*="rgb(239"] {
          color: #c0392b !important;
        }
        /* Acento lima → verde oscuro sobrio en el documento */
        #reporte-print [style*="--accent"] { color: #5a8a00 !important; }

        /* Títulos de sección: línea inferior gris */
        #reporte-print .chart-title,
        #reporte-print .section-title {
          color: #1a1a1a !important;
          font-weight: 700 !important;
        }
        /* Texto secundario y muted en grises legibles sobre blanco */
        #reporte-print [style*="text-muted"],
        #reporte-print [style*="text-secondary"],
        #reporte-print .muted { color: #888888 !important; }

        /* Tablas limpias estilo documento */
        #reporte-print table { border-collapse: collapse !important; }
        #reporte-print thead th {
          color: #888 !important;
          border-bottom: 1.5px solid #ddd !important;
          font-size: 9.5px !important;
          text-transform: uppercase !important;
          letter-spacing: 0.04em !important;
        }
        #reporte-print td {
          border-bottom: 1px solid #f2f2f2 !important;
          font-variant-numeric: tabular-nums !important;
        }
        #reporte-print td.mono { color: #555 !important; }

        /* KPIs en grilla con separadores claros */
        #reporte-print .kpi-grid { gap: 1px !important; background: #e2e2e2 !important; border: 1px solid #e2e2e2 !important; }

        /* Barras de gráficos: tonos sobrios imprimibles */
        #reporte-print .recharts-bar-rectangle path { fill: #5a8a00 !important; }

        /* Ámbar oscuro para amarillos (legible en blanco) */
        #reporte-print [style*="--yellow"],
        #reporte-print [style*="rgb(245"],
        #reporte-print .yellow { color: #b8860b !important; }

        /* Pie de página ejecutivo en dos columnas */
        #reporte-print .reporte-pie {
          display: flex !important;
          justify-content: space-between !important;
          text-align: left !important;
          border-top: 1px solid #ddd !important;
          padding-top: 12px !important;
          margin-top: 16px !important;
          font-size: 9.5px !important;
          color: #aaa !important;
        }
        #reporte-print .reporte-pie span { color: #aaa !important; }

        /* Encabezado: ocultar el gradiente oscuro, dejar limpio */
        #reporte-print .reporte-head {
          border: none !important;
          border-bottom: 2px solid #1a1a1a !important;
          border-radius: 0 !important;
          padding: 0 0 16px 0 !important;
          background: #ffffff !important;
        }

        /* Evitar cortes feos entre páginas */
        #reporte-print .card,
        #reporte-print .chart-card,
        #reporte-print .kpi-card,
        #reporte-print table,
        #reporte-print tr {
          break-inside: avoid !important;
          page-break-inside: avoid !important;
        }
        * {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
      }
    `

    // Renombra el documento para que el PDF salga con el nombre del mes
    const tituloOriginal = document.title
    document.title = `facial-wellness-reporte-${datos.mes}`

    const limpiar = () => {
      document.title = tituloOriginal
      setGenerandoPdf(false)
      window.removeEventListener('afterprint', limpiar)
    }
    window.addEventListener('afterprint', limpiar)

    // Pequeño delay para que apliquen los estilos antes de abrir el diálogo
    setTimeout(() => {
      window.print()
      // Fallback por si el navegador no dispara afterprint
      setTimeout(limpiar, 1000)
    }, 150)
  }

  // ── PDF COMPLETO PARA ANÁLISIS ──
  // Documento denso y estructurado (todo en tablas de texto) pensado para subir
  // a un chat de Claude y que analice. Se abre en una ventana nueva y se imprime.
  const generarPDFCompleto = () => {
    if (!datos) return
    const d = datos
    const gs = (n) => 'Gs. ' + Number(n || 0).toLocaleString('es-PY')
    const pct = (n) => (n == null ? '—' : Number(n).toFixed(1) + '%')
    const esc = (s) => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))

    // Embudo: pedidos → confirmados → despachados → entregados → cobrados
    const totalPedidos = d.paquetesEnviados || 0
    const entregados = d.entregados || 0
    const devueltos = d.devueltos || 0
    const pendientes = d.pendientesCount || 0
    const cobrados = entregados  // los entregados COD ya cobrados vía PaP + prepagos

    const filaTabla = (cols) => '<tr>' + cols.map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${c}</td>`).join('') + '</tr>'
    const tabla = (headers, filas) => `<table><thead><tr>${headers.map((h, i) => `<th${i > 0 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${filas.join('')}</tbody></table>`

    // Serie temporal
    const serieFilas = (d.serie || []).map(s => filaTabla([
      esc(s.label), s.pedidos, s.entregados, s.devueltos, gs(s.ventasBrutas), gs(s.ingresoEntregado),
    ]))
    // Por producto
    const prodFilas = (d.porProducto || []).map(p => filaTabla([
      esc(p.nombre), p.ventas, p.entregados, p.devueltos,
      p.tasaEntrega != null ? pct(p.tasaEntrega) : '—',
      gs(p.cobrado), gs(p.cogs), gs(p.flete),
      gs(p.contribucion),
      p.margenPct != null ? pct(p.margenPct) : '—',
      p.contribPorDespacho != null ? gs(Math.round(p.contribPorDespacho)) : '—',
    ]))
    // Por ciudad
    const ciudadFilas = (d.ciudades || []).slice(0, 30).map(c => filaTabla([
      esc(c.ciudad || c.nombre), c.total ?? c.pedidos, c.entregados ?? '—', c.devueltos ?? '—',
      c.tasaEntrega != null ? pct(c.tasaEntrega) : '—',
    ]))
    // Motivos de devolución
    const motivoFilas = (d.motivos || []).map(m => filaTabla([esc(m.motivo || m.nombre), m.cantidad ?? m.count]))
    // Meta Ads — detalle por producto (CPA/ROAS/ganancia recalculados como en Campañas)
    const veredictoTxt = { gana: 'Rinde', pierde: 'Pierde', ajustar: 'Ajustar', sin_gasto: '—' }
    const roas = (n) => (n == null ? '—' : Number(n).toFixed(2) + 'x')
    const adsRow = (a, bold) => `<tr${bold ? ' style="font-weight:700;background:#f7f7f7"' : ''}>${[
      esc(a.label),
      a.gasto ? gs(a.gasto) : '—',
      a.despachados ?? 0,
      a.entregados ?? 0,
      a.gasto ? gs(a.cpaReal) : '—',
      a.gasto ? roas(a.roasReal) : '—',
      gs(a.cobrado || 0),
      gs(a.gananciaNeta || 0),
      a.gasto ? (veredictoTxt[a.veredicto] || a.veredicto || '—') : '—',
    ].map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`
    const adsFilas = (d.adsDetalle || []).map(a => adsRow(a, false))
    if (d.adsTotal && (d.adsTotal.gasto || d.adsTotal.despachados)) adsFilas.push(adsRow({ ...d.adsTotal, label: 'TOTAL' }, true))

    // Gastos operativos — detalle (por categoría + por ítem)
    const gastosArr = (d.gastos || [])
    const gastoCatMap = {}
    gastosArr.forEach(g => { const c = (g.categoria || '').trim() || 'Sin categoría'; gastoCatMap[c] = (gastoCatMap[c] || 0) + (g.monto || 0) })
    const totalGastosOp = gastosArr.reduce((s, g) => s + (g.monto || 0), 0)
    const gastoCatFilas = Object.entries(gastoCatMap).sort((a, b) => b[1] - a[1]).map(([cat, monto]) => filaTabla([
      esc(cat), gs(monto), totalGastosOp ? pct(monto / totalGastosOp * 100) : '—',
    ]))
    const gastoItemFilas = [...gastosArr].sort((a, b) => (b.monto || 0) - (a.monto || 0)).map(g => filaTabla([
      esc((g.fecha || '').slice(0, 10)), esc(g.categoria || '—'), esc(g.concepto || '—'), gs(g.monto || 0),
    ]))

    // Filas de la tabla por transportadora (sección 10 del PDF)
    const pctT = (x) => x == null ? '—' : Math.round(x) + '%'
    const transpFilas = (d.porTransportadora || []).map(t => filaTabla([
      esc(t.label), t.enviados, t.entregados, t.devueltos, t.pendientes,
      pctT(t.tasaEntrega), gs(t.cobrado), gs(t.fleteFirme),
      t.costoPorEntrega != null ? gs(Math.round(t.costoPorEntrega)) : '—',
    ]))

    const win = window.open('', '_blank')
    if (!win) { toast('Permití las ventanas emergentes para descargar el PDF', 'error'); return }
    win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<title>Reporte completo — ${esc(d.periodo?.etiqueta || d.mes)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; font-size: 11px; line-height: 1.5; margin: 0; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #1a1a1a; }
  .sub { color: #666; font-size: 11px; margin-bottom: 4px; }
  .kpigrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0; }
  .kpi { border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; }
  .kpi .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: #777; }
  .kpi .val { font-size: 16px; font-weight: 700; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 4px; font-size: 10px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; }
  th { background: #f2f2f2; font-weight: 700; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  h2 { page-break-after: avoid; }
  .foot { margin-top: 8px; font-size: 9px; color: #999; }
  .formula { font-size: 9.5px; color: #777; margin: -2px 0 8px; }
</style></head><body>

<h1>Facial Wellness — Reporte completo</h1>
<div class="sub">${esc(d.periodo?.etiqueta || d.mes)} · comparado con ${esc(d.periodo?.etiquetaPrev || 'período anterior')} · generado ${new Date().toLocaleString('es-PY')}</div>
<div class="sub">Documento de datos para análisis. Todas las cifras en guaraníes (Gs.).</div>

<h2>1. Resumen del período</h2>
<div class="kpigrid">
  <div class="kpi"><div class="lbl">Ventas brutas (entregadas)</div><div class="val">${gs(d.ventasBrutas)}</div></div>
  <div class="kpi"><div class="lbl">Contribución firme</div><div class="val">${gs(d.ingresosNetos)}</div></div>
  <div class="kpi"><div class="lbl">Utilidad neta</div><div class="val">${gs(d.utilidadNeta)}</div></div>
  <div class="kpi"><div class="lbl">Margen %</div><div class="val">${pct(d.margenPct)}</div></div>
  <div class="kpi"><div class="lbl">Pedidos enviados</div><div class="val">${totalPedidos}</div></div>
  <div class="kpi"><div class="lbl">Tasa de entrega</div><div class="val">${pct(d.tasaEntrega)}</div></div>
  <div class="kpi"><div class="lbl">Gasto en ads</div><div class="val">${gs(d.totalGastoAds)}</div></div>
  <div class="kpi"><div class="lbl">Gastos totales</div><div class="val">${gs(d.totalGastos)}</div></div>
  <div class="kpi"><div class="lbl">Costo mercadería vendida</div><div class="val">${gs(d.costoMercaderiaVendida)}</div></div>
</div>
<div class="formula">Contribución firme = ingreso entregadas − flete (todos los envíos) − costo de producto entregado. Utilidad neta = contribución firme − gasto en Meta Ads − otros gastos del período.</div>

<h2>2. Serie temporal (${d.periodo?.granularidad === 'mes' ? 'por mes' : 'por día'})</h2>
${serieFilas.length ? tabla(['Período', 'Pedidos', 'Entregados', 'Devueltos', 'Ventas brutas', 'Ingreso entregado'], serieFilas) : '<p>Sin datos en el rango.</p>'}

<h2>3. Embudo de conversión</h2>
${tabla(['Etapa', 'Cantidad', '% del total'], [
  filaTabla(['Pedidos enviados', totalPedidos, '100%']),
  filaTabla(['Entregados', entregados, totalPedidos ? pct(entregados / totalPedidos * 100) : '—']),
  filaTabla(['Devueltos', devueltos, totalPedidos ? pct(devueltos / totalPedidos * 100) : '—']),
  filaTabla(['En proceso / pendientes', pendientes, totalPedidos ? pct(pendientes / totalPedidos * 100) : '—']),
  filaTabla(['Cobrados (entregados)', cobrados, totalPedidos ? pct(cobrados / totalPedidos * 100) : '—']),
])}

<h2>4. Margen por producto</h2>
${prodFilas.length ? tabla(['Producto', 'Ventas', 'Entreg.', 'Devuel.', 'Tasa entrega', 'Cobrado', 'Costo prod.', 'Flete', 'Contribución', 'Margen %', 'Por despacho'], prodFilas) : '<p>Sin datos.</p>'}
<div class="formula">Contribución = cobrado − costo del producto entregado − flete de TODO lo resuelto (entregado y devuelto: el flete se paga igual). <b>Por despacho</b> = contribución ÷ paquetes resueltos: es lo que deja cada paquete que sale, ya con el costo de las devoluciones adentro. Es el número para decidir qué escalar y qué discontinuar — un producto con ticket alto pero mucha devolución cae acá aunque su margen por venta se vea bien.</div>

<h2>5. Por ciudad (top 30)</h2>
${ciudadFilas.length ? tabla(['Ciudad', 'Pedidos', 'Entregados', 'Devueltos', 'Tasa entrega'], ciudadFilas) : '<p>Sin datos.</p>'}

<h2>6. Motivos de devolución</h2>
${motivoFilas.length ? tabla(['Motivo', 'Cantidad'], motivoFilas) : '<p>Sin devoluciones registradas.</p>'}

<h2>7. Meta Ads — detalle por producto</h2>
${adsFilas.length ? tabla(['Producto', 'Gasto', 'Pedidos', 'Entreg.', 'CPA/entrega', 'ROAS real', 'Cobrado', 'Ganancia neta', 'Veredicto'], adsFilas) : '<p>Sin campañas cargadas en el período.</p>'}
<div class="formula">CPA/entrega = gasto ÷ entregados (costo por cliente que paga). ROAS real = cobrado ÷ gasto (sobre lo cobrado, no lo facturado). Ganancia neta = cobrado − gasto ads − costo producto entregado − flete. Gasto total en ads: ${gs(d.totalGastoAds)}.${d.posibleDobleAds ? ' ⚠ Hay gasto categoría publicidad en Gastos Y ads en Campañas el mismo mes: posible doble conteo.' : ''}</div>

<h2>8. Gastos operativos — detalle</h2>
${gastoCatFilas.length ? tabla(['Categoría', 'Monto', '% del total'], gastoCatFilas) : '<p>Sin gastos operativos cargados en el período.</p>'}
${gastoItemFilas.length ? `<div class="formula">Desglose por ítem (${gastoItemFilas.length} gasto${gastoItemFilas.length > 1 ? 's' : ''}, de mayor a menor):</div>${tabla(['Fecha', 'Categoría', 'Concepto', 'Monto'], gastoItemFilas)}` : ''}
<div class="formula">Total gastos operativos: ${gs(totalGastosOp)}. No incluye Meta Ads (sección 7) ni costo de mercadería vendida (sección 1).</div>

<h2>9. Cobranza</h2>
${tabla(['Métrica', 'Valor'], [
  filaTabla(['Cobrado (rendido)', gs(d.cobranza?.cobrado || 0)]),
  filaTabla(['Por cobrar (sin rendir)', gs(d.cobranza?.porCobrar || 0)]),
  filaTabla(['Entregas rendidas', d.cobranza?.nRendidas ?? '—']),
  filaTabla(['Cobro típico (mediana)', d.cobranza?.medianaCobro != null ? d.cobranza.medianaCobro.toFixed(1) + ' días' : '—']),
  filaTabla(['Cobro promedio', d.cobranza?.promedioCobro != null ? d.cobranza.promedioCobro.toFixed(1) + ' días' : '—']),
  filaTabla(['Cobro más lento', d.cobranza?.cobroMax != null ? d.cobranza.cobroMax + ' días' : '—']),
  filaTabla(['Cobros trancados (+14 días)', d.cobranza?.cobroTrancados ?? 0]),
])}
<div class="formula">Se reporta la MEDIANA (cobro típico) por robustez: pocos cobros trancados inflan el promedio. Si "cobros trancados" es alto, reclamá esas guías en Rendición. Los tiempos combinan todas las transportadoras — el detalle separado está en Rendición.</div>

<h2>10. Desempeño por transportadora</h2>
${transpFilas.length ? tabla(['Transportadora', 'Enviados', 'Entreg.', 'Devueltos', 'En tránsito', 'Tasa entrega', 'Cobrado', 'Flete resuelto', 'Costo/entrega'], transpFilas) : '<p>Sin envíos en el período.</p>'}
<div class="formula">Costo por entrega = flete de lo resuelto ÷ entregados. Es el número que compara transportadoras de verdad: incorpora las devoluciones, que pagan flete sin generar ingreso, cosa que la tarifa nominal no muestra.</div>
${d.duelo ? `<div class="formula" style="border-left:3px solid #5a8a00;padding-left:10px">
<b>${esc(d.duelo.gana.label)} sale ${gs(d.duelo.difCosto)} más barato por entrega</b> que ${esc(d.duelo.pierde.label)}
(${gs(Math.round(d.duelo.gana.costoPorEntrega))} vs ${gs(Math.round(d.duelo.pierde.costoPorEntrega))}),
con ${Math.round(d.duelo.gana.tasaEntrega)}% de entrega contra ${Math.round(d.duelo.pierde.tasaEntrega)}%
(${d.duelo.difTasa > 0 ? '+' : ''}${Math.round(d.duelo.difTasa)} puntos).
Migrar las ${d.duelo.pierde.entregados} entregas de ${esc(d.duelo.pierde.label)} habría costado ${gs(d.duelo.ahorroSiMigra)} menos.
${d.duelo.muestraChica ? ' <b>Atención:</b> alguna de las dos tiene menos de 15 paquetes resueltos — la diferencia todavía puede ser suerte y no desempeño real.' : ''}
</div>` : ''}

<h2>11. Clientes</h2>
${tabla(['Métrica', 'Valor'], [
  filaTabla(['Clientes únicos', d.clientesUnicos ?? '—']),
  filaTabla(['Recompradores', d.recompradores ?? '—']),
  filaTabla(['Ticket promedio (entregado)', entregados ? gs(Math.round((d.ventasBrutas || 0) / entregados)) : '—']),
])}

${(d.alertas && d.alertas.length) ? `<h2>12. Alertas</h2><ul>${d.alertas.map(a => `<li>${esc(typeof a === 'string' ? a : (a.texto || a.mensaje || JSON.stringify(a)))}</li>`).join('')}</ul>` : ''}

<div class="foot">Facial Wellness OS · reporte generado automáticamente · ${new Date().toISOString().slice(0, 10)}</div>
</body></html>`)
    win.document.close()
    setTimeout(() => { win.focus(); win.print() }, 400)
  }

  const mesesDisponibles = []
  for (let i = 0; i < 12; i++) {
    const d = new Date(); d.setMonth(d.getMonth() - i)
    mesesDisponibles.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('es-PY', { month: 'long', year: 'numeric' }),
    })
  }
  // Años disponibles (para el período anual): del año actual hacia atrás

  const nombreMes = datos
    ? (() => { const [y, m] = datos.mes.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('es-PY', { month: 'long', year: 'numeric' }) })()
    : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reportes</h1>
          <p className="page-subtitle">
            Reporte mensual completo, con PDF ejecutivo y PDF para análisis
            {datos?.mayoristasExcluidos > 0 && (
              <span style={{ color: 'var(--yellow)' }}>
                {' · '}{datos.mayoristasExcluidos} línea{datos.mayoristasExcluidos === 1 ? '' : 's'} mayorista excluida{datos.mayoristasExcluidos === 1 ? '' : 's'}
              </span>
            )}
          </p>
        </div>
        <div className="page-actions">
          <select className="form-select" style={{ width: 'auto' }} value={mes}
            onChange={e => { setMes(e.target.value); setDatos(null) }}>
            {mesesDisponibles.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer',
            color: sinMayoristas ? 'var(--accent)' : 'var(--text-secondary)', whiteSpace: 'nowrap' }}
            title="Un pedido mayorista de 20 unidades sin costo de ads distorsiona el ticket promedio y el CPA">
            <input type="checkbox" checked={sinMayoristas}
              onChange={e => setSinMayoristas(e.target.checked)} />
            Sin mayoristas
          </label>
          <button className="btn btn-secondary" onClick={cargarDatos} disabled={loading}>
            {loading ? <Loader2 size={14} className="spinning" /> : <FileBarChart2 size={14} />}
            Generar
          </button>
          {datos && (
            <>
              <button className="btn btn-secondary" onClick={generarPDF} disabled={generandoPdf} title="PDF visual para leer o archivar">
                {generandoPdf ? <Loader2 size={14} className="spinning" /> : <Download size={14} />}
                PDF ejecutivo
              </button>
              <button className="btn btn-primary" onClick={generarPDFCompleto} disabled={generandoPdf} title="PDF denso con todos los datos, para subir a Claude y analizar">
                <FileText size={14} />
                PDF completo para análisis
              </button>
            </>
          )}
        </div>
      </div>

      {!datos && !loading && (
        <div className="empty-state" style={{ padding: 80 }}>
          <div className="empty-state-icon" style={{ width: 64, height: 64, borderRadius: 16 }}>
            <FileBarChart2 size={32} />
          </div>
          <p className="empty-state-title">Seleccioná un mes y generá el reporte</p>
          <p className="empty-state-desc">El reporte incluye ventas, stock, campañas de ads y análisis de márgenes</p>
          <button className="btn btn-primary" onClick={cargarDatos}>
            <FileBarChart2 size={14} /> Generar reporte
          </button>
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[...Array(5)].map((_, i) => <div key={i} className="skeleton" style={{ height: 80, borderRadius: 10 }} />)}
        </div>
      )}

      {datos && (
        <div ref={reportRef} id="reporte-print" style={{ display: 'flex', flexDirection: 'column', gap: 20, background: 'var(--bg-base)', padding: 8 }}>
          {/* Header del reporte */}
          <div className="reporte-head" style={{
            background: 'linear-gradient(135deg, var(--bg-card) 0%, #1a1a0a 100%)',
            border: '1px solid var(--border)',
            borderRadius: 14, padding: '24px 28px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                FACIAL <span style={{ color: 'var(--accent)' }}>WELLNESS</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                Reporte Ejecutivo Mensual
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--accent)', textTransform: 'capitalize' }}>
                {datos?.periodo?.etiqueta || nombreMes}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                Ciudad del Este, Paraguay
              </div>
            </div>
          </div>

          {/* KPIs grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { label: 'Ventas brutas', value: formatGs(datos.ventasBrutas), sub: 'Cobrado (entregadas)', color: 'var(--text-primary)' },
              { label: 'Costo de venta', value: formatGs(datos.costoMercaderiaVendida), sub: 'Mercadería vendida (entregada)', color: 'var(--red)' },
              { label: 'Margen %', value: formatPct(datos.margenPct), sub: 'Ingreso neto / ventas', color: datos.margenPct > 40 ? 'var(--green)' : 'var(--yellow)' },
              { label: 'Ganancia firme', value: formatGs(datos.utilidadNeta), sub: 'Lo ya cerrado', color: datos.utilidadNeta > 0 ? 'var(--green)' : 'var(--red)' },
              { label: 'Paquetes enviados', value: datos.paquetesEnviados, sub: `${datos.entregados} entregados`, color: 'var(--text-primary)' },
              { label: 'Devoluciones', value: datos.devueltos, sub: `${formatGs(datos.fleteDevoluciones)} en flete perdido`, color: datos.devueltos > 10 ? 'var(--red)' : 'var(--yellow)' },
              { label: 'Tasa de entrega', value: formatPct(datos.tasaEntrega), sub: 'Sobre total enviado', color: datos.tasaEntrega > 60 ? 'var(--green)' : 'var(--red)' },
              { label: 'Gastos totales', value: formatGs(datos.totalGastos), sub: `Ads: ${formatGs(datos.totalGastoAds)}`, color: 'var(--red)' },
            ].map((k, i) => (
              <div key={i} className="kpi-card">
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value" style={{ color: k.color, fontSize: 16 }}>{k.value}</div>
                <div className="kpi-sub">{k.sub}</div>
              </div>
            ))}
          </div>

          {/* Desglose de utilidad (P&L) */}
          {datos.posibleDobleAds && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(234,179,8,0.1)', border: '1px solid var(--yellow)', fontSize: 12.5, color: 'var(--text-secondary)' }}>
              ⚠️ Tenés Meta Ads cargado en Campañas <strong>y</strong> un gasto de "Publicidad" este período. Se está restando dos veces. Borrá el gasto de Publicidad — el ads ya se cuenta desde Campañas.
            </div>
          )}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
              Cómo se arma tu utilidad firme
            </div>
            <div style={{ padding: '6px 20px' }}>
              {[
                { l: 'Ingresos cobrados (entregadas, con envío)', v: datos.ventasBrutas, signo: '+' },
                { l: 'Costo de mercadería vendida (entregadas)', v: datos.costoMercaderiaVendida, signo: '−' },
                { l: `Flete de envíos (${datos.entregados + datos.devueltos} resueltos)`, v: datos.fleteFirme, signo: '−' },
                { l: 'Gasto en Meta Ads', v: datos.totalGastoAds, signo: '−' },
                { l: 'Otros gastos del mes', v: datos.totalGastos, signo: '−' },
              ].filter(r => r.v !== undefined && r.v !== 0).map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{r.l}</span>
                  <span style={{ fontWeight: 600, color: r.signo === '−' ? 'var(--red)' : 'var(--text-primary)' }}>{r.signo} {formatGs(r.v)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0 10px', fontSize: 14 }}>
                <span style={{ fontWeight: 700 }}>Utilidad firme</span>
                <span style={{ fontWeight: 800, color: datos.utilidadNeta > 0 ? 'var(--green)' : 'var(--red)' }}>{formatGs(datos.utilidadNeta)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingBottom: 12, lineHeight: 1.5 }}>
                Esta es tu ganancia <strong>firme</strong>: cuenta solo los {datos.entregados + datos.devueltos} paquetes que ya cerraron (entregados + devueltos), porque de esos ya pagaste el flete. {datos.pendientesCount > 0 ? `Tenés ${datos.pendientesCount} pendientes en tránsito (${formatGs(datos.fletePendientes)} en flete y ${formatGs(datos.cogsPendientes)} en mercadería) que sumarán cuando se entreguen — mirá el detalle en Entregas.` : ''}
              </div>
            </div>
          </div>

          {/* Comparativa con mes anterior */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
              Comparativa vs mes anterior
              {datos.diasComparados ? (
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>
                  · primeros {datos.diasComparados} días de cada mes (el mes en curso todavía no terminó)
                </span>
              ) : null}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 0 }}>
              {[
                { label: 'Ventas brutas', actual: datos.ventasBrutas, ant: datos.comparativa.ventasBrutas, fmt: formatGs },
                { label: 'Ingresos netos', actual: datos.ingresosNetos, ant: datos.comparativa.ingresosNetos, fmt: formatGs },
                { label: 'Entregados', actual: datos.entregados, ant: datos.comparativa.entregados, fmt: v => v },
                { label: 'Devueltos', actual: datos.devueltos, ant: datos.comparativa.devueltos, fmt: v => v, invertido: true },
                { label: 'Tasa entrega', actual: datos.tasaEntrega, ant: datos.comparativa.tasaEntrega, fmt: v => `${v.toFixed(0)}%` },
              ].map((m, i) => (
                <div key={i} style={{ padding: '12px 14px', borderRight: i < 4 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ fontSize: 9.5, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>{m.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{m.fmt(m.actual)}</div>
                  <div style={{ marginTop: 3 }}><Delta actual={m.actual} anterior={m.ant} invertido={m.invertido} /></div>
                </div>
              ))}
            </div>
          </div>

          {/* Veredicto: cuál transportadora conviene */}
          {datos.duelo && (
            <div className="card" style={{ padding: '16px 20px', borderLeft: '3px solid var(--accent)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
                {datos.duelo.gana.label} vs {datos.duelo.pierde.label}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
                <div className="kpi-card" style={{ borderLeft: '3px solid var(--green)' }}>
                  <div className="kpi-label">Más barato por entrega</div>
                  <div className="kpi-value" style={{ fontSize: 18, color: 'var(--green)' }}>{datos.duelo.gana.label}</div>
                  <div className="kpi-sub">{formatGs(Math.round(datos.duelo.gana.costoPorEntrega))} vs {formatGs(Math.round(datos.duelo.pierde.costoPorEntrega))}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Diferencia por entrega</div>
                  <div className="kpi-value" style={{ fontSize: 18 }}>{formatGs(datos.duelo.difCosto)}</div>
                  <div className="kpi-sub">A favor de {datos.duelo.gana.label}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Diferencia de tasa</div>
                  <div className="kpi-value" style={{ fontSize: 18, color: datos.duelo.difTasa > 0 ? 'var(--green)' : 'var(--red)' }}>
                    {datos.duelo.difTasa > 0 ? '+' : ''}{Math.round(datos.duelo.difTasa)} pts
                  </div>
                  <div className="kpi-sub">{Math.round(datos.duelo.gana.tasaEntrega)}% vs {Math.round(datos.duelo.pierde.tasaEntrega)}%</div>
                </div>
                <div className="kpi-card" style={{ borderLeft: '3px solid var(--accent)' }}>
                  <div className="kpi-label">Si migrabas todo</div>
                  <div className="kpi-value" style={{ fontSize: 18, color: 'var(--accent)' }}>{formatGs(datos.duelo.ahorroSiMigra)}</div>
                  <div className="kpi-sub">Sobre las {datos.duelo.pierde.entregados} entregas de {datos.duelo.pierde.label}</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                El costo por entrega incluye el flete de las devoluciones, que se paga aunque no generen ingreso — por eso es mayor que la tarifa de lista y es el número que compara transportadoras de verdad.
                {datos.duelo.muestraChica && (
                  <span style={{ color: 'var(--yellow)' }}>
                    {' '}Ojo: alguna de las dos tiene menos de 15 paquetes resueltos — la diferencia todavía puede ser suerte, no desempeño.
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Margen por producto — la tabla de decisión */}
          {(datos.porProducto || []).length > 0 && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
                Margen por producto
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>
                  · "por despacho" = lo que deja cada paquete que sale, con el costo de las devoluciones incluido
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase' }}>
                      <th style={{ padding: '8px 12px', textAlign: 'left' }}>Producto</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Entreg.</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Devuel.</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Tasa</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Cobrado</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Flete</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Contribución</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Margen</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Por despacho</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datos.porProducto.map(p => (
                      <tr key={p.nombre} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{p.nombre}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{p.entregados}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: p.devueltos ? 'var(--red)' : undefined }}>{p.devueltos}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right',
                          color: p.tasaEntrega == null ? 'var(--text-muted)' : p.tasaEntrega >= 85 ? 'var(--green)' : p.tasaEntrega >= 70 ? 'var(--accent)' : 'var(--red)' }}>
                          {p.tasaEntrega == null ? '—' : `${Math.round(p.tasaEntrega)}%`}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{formatGs(p.cobrado)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--red)' }}>{formatGs(p.flete)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700,
                          color: p.contribucion >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatGs(p.contribucion)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{p.margenPct == null ? '—' : `${Math.round(p.margenPct)}%`}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700,
                          color: (p.contribPorDespacho ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {p.contribPorDespacho == null ? '—' : formatGs(Math.round(p.contribPorDespacho))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Desempeño por transportadora */}
          {(datos.porTransportadora || []).length > 0 && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
                Por transportadora
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>
                  · costo por entrega = flete de lo resuelto ÷ entregados (incluye el flete de las devoluciones)
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase' }}>
                      <th style={{ padding: '8px 12px', textAlign: 'left' }}>Transportadora</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Enviados</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Entreg.</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Devueltos</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>En tránsito</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Tasa entrega</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Cobrado</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Flete resuelto</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Costo/entrega</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datos.porTransportadora.map(t => (
                      <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{t.label}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{t.enviados}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{t.entregados}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: t.devueltos ? 'var(--red)' : undefined }}>{t.devueltos}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{t.pendientes}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700,
                          color: t.tasaEntrega == null ? 'var(--text-muted)' : t.tasaEntrega >= 85 ? 'var(--green)' : t.tasaEntrega >= 70 ? 'var(--accent)' : 'var(--red)' }}>
                          {t.tasaEntrega == null ? '—' : `${Math.round(t.tasaEntrega)}%`}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{formatGs(t.cobrado)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--red)' }}>{formatGs(t.fleteFirme)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>
                          {t.costoPorEntrega == null ? '—' : formatGs(Math.round(t.costoPorEntrega))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Cobranza */}
          {datos.cobranza.hayCobranza && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <div className="kpi-card" style={{ borderLeft: '3px solid var(--green)' }}>
                <div className="kpi-label"><Truck size={11} /> Ya te depositaron</div>
                <div className="kpi-value green" style={{ fontSize: 15 }}>{formatGs(datos.cobranza.cobrado)}</div>
                <div className="kpi-sub">{datos.cobranza.nRendidas} entregas rendidas</div>
              </div>
              <div className="kpi-card" style={{ borderLeft: '3px solid var(--yellow)' }}>
                <div className="kpi-label">Te deben</div>
                <div className="kpi-value" style={{ fontSize: 15, color: 'var(--yellow)' }}>{formatGs(datos.cobranza.porCobrar)}</div>
                <div className="kpi-sub">{datos.cobranza.nSinRendir} sin rendir</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Tiempo de cobro (mediana)</div>
                <div className="kpi-value" style={{ fontSize: 15 }}>{datos.cobranza.medianaCobro != null ? `${datos.cobranza.medianaCobro.toFixed(1)} días` : '—'}</div>
                <div className="kpi-sub">
                  Entrega → depósito · típico
                  {datos.cobranza.promedioCobro != null ? ` · prom. ${datos.cobranza.promedioCobro.toFixed(1)}d` : ''}
                  {datos.cobranza.cobroTrancados > 0 ? ` · ${datos.cobranza.cobroTrancados} trancado${datos.cobranza.cobroTrancados > 1 ? 's' : ''} +14d` : ''}
                </div>
              </div>
            </div>
          )}

          {/* Charts */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
            <div className="chart-card">
              <div className="chart-header">
                <span className="chart-title">Ventas diarias — {datos?.periodo?.etiqueta || nombreMes}</span>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={datos.porDia} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradV" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#c8f135" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#c8f135" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="dia" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                    tickFormatter={v => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : `${(v/1000).toFixed(0)}k`} />
                  <Tooltip formatter={v => [formatGs(v)]} contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }} />
                  <Area type="monotone" dataKey="ventas" name="Ventas" stroke="#c8f135" fill="url(#gradV)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-card">
              <div className="chart-header"><span className="chart-title">Ingresos por producto</span></div>
              <ResponsiveContainer width="100%" height={Math.max(200, (datos.porProducto?.slice(0, 8).length || 1) * 32)}>
                <BarChart data={datos.porProducto?.slice(0, 8)} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                    tickFormatter={v => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : `${(v/1000).toFixed(0)}k`} />
                  <YAxis type="category" dataKey="nombre" tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} axisLine={false} tickLine={false} width={110}
                    tickFormatter={v => v.length > 16 ? v.slice(0, 15) + '…' : v} />
                  <Tooltip formatter={v => [formatGs(v), 'Ingresos']}
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }} />
                  <Bar dataKey="ingresos" fill="var(--accent)" opacity={0.85} radius={[0,3,3,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tabla por producto */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Detalle por producto</span>
            </div>
            <table className="tabla-responsive">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Pedidos</th>
                  <th>Entregados</th>
                  <th>Devueltos</th>
                  <th>Tasa entrega</th>
                  <th>Ingresos netos</th>
                </tr>
              </thead>
              <tbody>
                {datos.porProducto.map(p => (
                  <tr key={p.nombre}>
                    <td data-label="Producto" style={{ fontWeight: 600 }}>{p.nombre}</td>
                    <td data-label="Pedidos">{p.ventas}</td>
                    <td data-label="Entregados" style={{ color: 'var(--green)' }}>{p.entregados}</td>
                    <td data-label="Devueltos" style={{ color: 'var(--red)' }}>{p.devueltos}</td>
                    <td data-label="Tasa entrega">
                      <span style={{ color: (p.entregados/Math.max(p.ventas,1)) > 0.6 ? 'var(--green)' : 'var(--yellow)' }}>
                        {((p.entregados / Math.max(p.ventas, 1)) * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td data-label="Ingresos netos" style={{ fontWeight: 700, color: 'var(--green)' }}>{formatGs(p.ingresos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Entrega por ciudad */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <MapPin size={14} color="var(--accent)" /><span style={{ fontWeight: 600, fontSize: 14 }}>Entrega por ciudad</span>
            </div>
            <table className="tabla-responsive">
              <thead><tr><th>Ciudad</th><th>Pedidos</th><th>Entregados</th><th>Devueltos</th><th>Tasa entrega</th></tr></thead>
              <tbody>
                {datos.ciudades.slice(0, 12).map(c => (
                  <tr key={c.ciudad}>
                    <td data-label="Ciudad" style={{ fontWeight: 600 }}>{c.ciudad}</td>
                    <td data-label="Pedidos">{c.pedidos}</td>
                    <td data-label="Entregados" style={{ color: 'var(--green)' }}>{c.entregados}</td>
                    <td data-label="Devueltos" style={{ color: 'var(--red)' }}>{c.devueltos}</td>
                    <td data-label="Tasa entrega"><span style={{ fontWeight: 700, color: c.tasaEntrega > 60 ? 'var(--green)' : c.tasaEntrega > 40 ? 'var(--yellow)' : 'var(--red)' }}>{c.tasaEntrega}%</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Patrones: día de la semana + motivos de devolución */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 }}>
            <div className="chart-card">
              <div className="chart-header"><span className="chart-title"><Calendar size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />Devolución por día</span></div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={datos.porDiaSemana} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="dia" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={30} domain={[0, 100]} />
                  <Tooltip formatter={v => [`${v}%`, 'Devolución']} contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }} />
                  <Bar dataKey="devolucion" radius={[3, 3, 0, 0]}>
                    {datos.porDiaSemana.map((e, i) => <Cell key={i} fill={e.devolucion > 40 ? '#ef4444' : e.devolucion > 30 ? '#f59e0b' : '#22c55e'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 14 }}>Motivos de devolución</div>
              <div style={{ padding: '8px 0' }}>
                {datos.motivos.length ? datos.motivos.map((m, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 20px', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{m.motivo}</span>
                    <span style={{ fontWeight: 700, color: 'var(--red)' }}>{m.count}</span>
                  </div>
                )) : <div style={{ padding: '12px 20px', fontSize: 12, color: 'var(--text-muted)' }}>Sin devoluciones registradas</div>}
              </div>
            </div>
          </div>

          {/* Campañas ads */}
          {datos.campanas.length > 0 && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Campañas publicitarias</span>
              </div>
              <table className="tabla-responsive">
                <thead>
                  <tr>
                    <th>Producto / campaña</th>
                    <th>Plataforma</th>
                    <th>Gasto</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.campanas.map((c, i) => {
                    const NF = { nasal: 'Tiras Nasales', parche: 'Parches Bucales', gudair: 'Pack Gudair', lengua: 'Raspador de Lengua', jaw: 'JawFlex Pro', botella: 'Botella Flexible', bebird: 'Bebird Pro', total: 'Total del mes' }
                    return (
                      <tr key={c.id || i}>
                        <td data-label="Producto" style={{ fontWeight: 500 }}>{NF[c.nombre] || NF[c.familia] || c.nombre || '—'}</td>
                        <td data-label="Plataforma"><span className="badge badge-purple">{c.plataforma || 'Meta'}</span></td>
                        <td data-label="Gasto" style={{ color: 'var(--red)' }}>{formatGs(c.gasto)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Recompras */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <div className="kpi-card">
              <div className="kpi-label"><Repeat size={11} /> Clientes únicos</div>
              <div className="kpi-value" style={{ fontSize: 16 }}>{datos.clientesUnicos}</div>
              <div className="kpi-sub">Por teléfono, en el mes</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Recompraron</div>
              <div className="kpi-value accent" style={{ fontSize: 16 }}>{datos.recompradores}</div>
              <div className="kpi-sub">Compraron 2+ veces</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Tasa de recompra</div>
              <div className="kpi-value" style={{ fontSize: 16 }}>{datos.clientesUnicos ? Math.round(datos.recompradores / datos.clientesUnicos * 100) : 0}%</div>
              <div className="kpi-sub">Fidelización</div>
            </div>
          </div>

          {/* Alertas / acciones sugeridas */}
          {datos.alertas.length > 0 && (
            <div className="card" style={{ padding: 0, border: '1px solid var(--yellow)' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={15} color="var(--yellow)" />
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--yellow)' }}>Puntos de atención del mes</span>
              </div>
              <div style={{ padding: '8px 0' }}>
                {datos.alertas.map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 20px', fontSize: 12.5, lineHeight: 1.5, borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                    <span style={{ color: 'var(--yellow)', fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{a.texto}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer del reporte */}
          <div className="reporte-pie" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, padding: '12px 0' }}>
            <span>Generado el {new Date().toLocaleDateString('es-PY', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
            <span>Facial Wellness OS · Ciudad del Este, Paraguay</span>
          </div>
        </div>
      )}
    </div>
  )
}
