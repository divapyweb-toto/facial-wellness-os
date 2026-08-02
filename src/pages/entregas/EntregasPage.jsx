// src/pages/entregas/EntregasPage.jsx
import { useState, useRef, useMemo, useEffect, Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase, formatGs } from '../../lib/supabase'
import { categorizarPaP as categorizar, importeSano, esImporteCorrupto, sanearEntrega, soloColumnasEntregas, IMPORTE_MAX_RAZONABLE } from '../../lib/estadosPaP'
import { tasaPorTransportadora } from '../../lib/riesgoCiudad'
import { labelTransportadora } from '../../lib/transportadoras'
import { etiquetaMes } from '../../lib/fechas'
import { fetchAll, fetchAllSafe } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Upload, CheckCircle, X, TrendingUp, TrendingDown, Truck, PackageCheck, PackageX, Clock, MapPin, User, AlertTriangle, Search, Save, DollarSign, FileSpreadsheet, Calendar, ChevronRight, ChevronDown, ArrowRight } from 'lucide-react'
import { calcularPiramide, indexarCostos } from '../../lib/contribucion'
import { normalizarCiudad, ZONAS } from '../../lib/ciudades'
import MapaCiudades from './MapaCiudades'

import { costoFleteActual } from '../../lib/flete'
const COSTO_PAP = costoFleteActual()  // tarifa vigente hoy (los cálculos por-fecha usan lib/flete)

// ═══════════════════════════════════════════════════════════
// LÓGICA — combina los 2 reportes de Punto a Punto
// ═══════════════════════════════════════════════════════════
function detectarTipo(headers) {
  if (headers.includes('FechaEnt') || headers.includes('Recurso')) return 'gestion'
  if (headers.includes('Recibido Por') || headers.includes('FechaGestion')) return 'paquete'
  return 'desconocido'
}

function parseXLSX(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
  const headers = Object.keys(rows[0] || {})
  return { rows, headers, tipo: detectarTipo(headers) }
}

function normalizarRef(ref) {
  if (!ref) return ''
  // Quitar #, espacios y cualquier separador
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  // Prefijo de transportadora (ej. Lucero: 'FW-2025' → '2025'). Los códigos que
  // mandamos a Lucero van prefijados para no chocar con los de otros clientes;
  // al volver hay que sacarlo para poder cruzar con la venta, que guarda '2025'.
  const conPrefijo = r.match(/^[A-Za-z]{1,4}0*(\d+)$/)
  if (conPrefijo) return String(parseInt(conPrefijo[1], 10))
  // Si es puramente numérico, quitar ceros a la izquierda (PaP '00123' = venta '123')
  if (/^\d+$/.test(r)) {
    r = String(parseInt(r, 10))
  }
  return r
}

// Normaliza teléfono igual que Despacho, para poder cruzar con las ventas
function limpiarTel(tel) {
  if (!tel) return ''
  let t = String(tel).replace(/[\s\-()]/g, '')
  if (t.startsWith('+5950')) t = '0' + t.slice(5)
  else if (t.startsWith('+595')) t = '0' + t.slice(4)
  else if (t.startsWith('5950')) t = '0' + t.slice(4)
  else if (t.startsWith('595')) t = '0' + t.slice(3)
  if (t && !t.startsWith('0')) t = '0' + t
  return t
}

// Categoriza mirando ESTADO y MOTIVO juntos. El motivo manda cuando el estado
// es intermedio: un "Custodio" con motivo "Inubicable" es una devolución, no un proceso.

function toISODate(v) {
  if (!v) return null
  if (v instanceof Date && !isNaN(v)) return v.toISOString().split('T')[0]
  if (typeof v === 'string') {
    const m = v.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    if (m) return `${m[3]}-${m[2]}-${m[1]}`
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.split('T')[0].split(' ')[0]
  }
  return null
}

function diasEntre(a, b) {
  if (!a || !b) return null
  const da = new Date(a), db = new Date(b)
  if (isNaN(da) || isNaN(db)) return null
  const d = Math.round((db - da) / 86400000)
  return d >= 0 ? d : null
}

// Combina ambos reportes por NroGuia. Paquete tiene prioridad para el estado
// (es el cierre final); Gestión aporta el detalle (mensajero, fechas, ruta).
function combinar(paqData, gesData) {
  const pmap = new Map()
  const gmap = new Map()
  if (paqData) paqData.rows.forEach(r => pmap.set(String(r['NroGuia']), r))
  if (gesData) gesData.rows.forEach(r => gmap.set(String(r['NroGuia']), r))

  const guias = new Set([...pmap.keys(), ...gmap.keys()])
  const out = []
  // Registros cuyo Importe vino corrupto desde PaP (se avisan en pantalla).
  const importesDescartados = []

  guias.forEach(guia => {
    if (!guia || guia === 'undefined') return
    const p = pmap.get(guia)
    const g = gmap.get(guia)

    // Estado: prioridad PAQUETE (estado final). Motivo: el que tenga valor de cualquiera.
    const estado = (p && p['Estado']) ? p['Estado'] : (g ? g['Estado'] : '')
    const motivo = ((p && p['Motivo']) || (g && g['Motivo']) || '')
    const cat = categorizar(estado, motivo)
    // TOPE DE SANIDAD. Los borradores de PaP traen el Importe corrupto (se han
    // visto valores de 900+ millones), y un solo registro basura envenena todas
    // las sumas del sistema. Tu pedido más caro posible es Bebird ×3 ≈ 1.100.000,
    // así que cualquier cosa por encima del tope es dato roto, no una venta.
    const importeCrudo = parseInt((p ? p['Importe'] : g['Importe']) || 0) || 0
    const importe = importeSano(importeCrudo)
    if (esImporteCorrupto(importeCrudo)) {
      importesDescartados.push({
        ref: normalizarRef((p && p['NroGuiaRef']) ? p['NroGuiaRef'] : (g ? g['NroGuiaRef'] : '')),
        valor: importeCrudo,
        estado,
      })
    }
    const ref = normalizarRef((p && p['NroGuiaRef']) ? p['NroGuiaRef'] : (g ? g['NroGuiaRef'] : ''))
    const ciudad = ((g ? g['Ciudad'] : (p ? p['Ciudad'] : '')) || '').trim()
    const mensajero = (g ? g['Recurso'] : '') || ''
    const telefono = limpiarTel(g ? g['Telefono'] : '')
    const nombreCliente = ((g ? g['Nombre'] : (p ? p['Nombre'] : '')) || '').trim()
    const producto = (g ? (g['Descripcion'] || g['Tipodeproducto']) : (p ? p['TipoPaquete'] : '')) || ''
    const fIng = toISODate(g ? g['FechaIng'] : (p ? p['Fecha Ingreso'] : null))
    const fEnt = toISODate(g ? g['FechaEnt'] : (p ? p['FechaEvento'] : null))

    // Tesorería: ¿la plata ya te llegó? (solo si el reporte se exportó con "Incluir Tesorería")
    const estadoDepTesor = (g ? g['EstadoDepTesor'] : '') || ''
    const rendido = estadoDepTesor === 'Rendido Tesorero'
    const fRendido = toISODate(g ? g['FechaDepositoTesoreroCliente'] : null)
    const diasRendicion = (rendido && cat === 'entregado') ? diasEntre(fEnt, fRendido) : null

    out.push({
      nro_guia_pap: guia,
      n_referencia: ref,
      estado_pap: estado,
      categoria: cat,
      motivo,
      importe,
      cobrado: cat === 'entregado' ? importe : 0,
      costo_envio: COSTO_PAP,
      fecha_ingreso: fIng,
      fecha_entrega: fEnt,
      dias_entrega: cat === 'entregado' ? diasEntre(fIng, fEnt) : null,
      rendido,
      fecha_rendido: fRendido,
      dias_rendicion: diasRendicion,
      mensajero,
      telefono,
      nombre_cliente: nombreCliente,
      ciudad,
      producto,
      mes: (fIng || fEnt || '').slice(0, 7),  // mes por FECHA DE INGRESO (cuándo salió a despacho)
    })
  })

  // Se cuelgan del array para que quien lo use pueda avisar sin cambiar la firma.
  out.importesDescartados = importesDescartados
  return out
}

const CAT_CFG = {
  entregado:     { label: 'Entregado', color: '#22c55e' },
  devuelto:      { label: 'Devuelto',  color: '#ef4444' },
  en_proceso:    { label: 'En proceso', color: '#eab308' },
  // Guías que PaP nunca despachó (Borrador / NO INGRESO A PAP).
  no_despachado: { label: 'No despachado', color: '#6b7280' },
}
// Acceso seguro: si mañana aparece una categoría nueva, la fila se pinta gris
// en vez de romper la página entera con "Cannot read properties of undefined".
const catCfg = (cat) => CAT_CFG[cat] || { label: cat || '—', color: '#6b7280' }

// ═══════════════════════════════════════════════════════════
// COMPONENTE
// ═══════════════════════════════════════════════════════════
export default function EntregasPage() {
  const { toast } = useToast()
  const navigate = useNavigate()
  const fileRef = useRef()
  const autoSaveRef = useRef(null)
  const [paqData, setPaqData] = useState(null)
  const [gesData, setGesData] = useState(null)
  const [historico, setHistorico] = useState([])
  const [cargandoHist, setCargandoHist] = useState(true)
  const [busqueda, setBusqueda] = useState('')
  const [filtroCat, setFiltroCat] = useState('todos')
  const [filtroMes, setFiltroMes] = useState('actual')  // 'actual' | 'todos' | 'YYYY-MM'
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [resultadoGuardado, setResultadoGuardado] = useState(null)
  const [verSinRendir, setVerSinRendir] = useState(false)
  const [refCosto, setRefCosto] = useState({})       // costo real de producto por referencia de venta
  const [ventasParaPiramide, setVentasParaPiramide] = useState([]) // ventas completas: fuente única de la ganancia
  // Referencia → transportadora, para separar la tasa de entrega por courier.
  const [transpPorRef, setTranspPorRef] = useState({})

  // Cargar el histórico guardado en Supabase al entrar (así no "desaparece" al refrescar)
  useEffect(() => {
    let activo = true
    ;(async () => {
      try {
        // Paginado: sin esto Supabase corta en 1.000 filas sin avisar
        const data = await fetchAll(
          () => supabase.from('entregas').select('*').order('fecha_entrega', { ascending: false }),
          { columnaOrden: 'nro_guia_pap' }
        )
        if (activo) setHistorico(data || [])
      } catch (e) { /* tabla vacía o no accesible */ }
      if (activo) setCargandoHist(false)
    })()
    return () => { activo = false }
  }, [])

  // Cargar costos reales de producto (por referencia) y gastos por mes — para la pirámide
  useEffect(() => {
    let activo = true
    ;(async () => {
      try {
        // Costos: traer ventas con su referencia y costo_prod real
        const ventas = await fetchAll(() => supabase
          .from('ventas').select('n_referencia, costo_prod, costo_envio, total, ganancia_neta, estado, fecha, ciudad, producto_nombre, cantidad, transportadora').is('deleted_at', null))
        if (activo && ventas) {
          setRefCosto(indexarCostos(ventas))
          setVentasParaPiramide(ventas)
          // Mapa referencia → transportadora (la venta es donde se decidió al despachar)
          const mapa = {}
          ventas.forEach(v => {
            const k = String(v.n_referencia || '').replace(/[^0-9]/g, '')
            if (k) mapa[k] = v.transportadora || 'pap'
          })
          setTranspPorRef(mapa)
        }
        // Nota: esta página NO consulta gastos a propósito. La logística mide
        // contribución (flete + producto). Los gastos generales viven en Reportes.
      } catch (e) { /* sin datos */ }
    })()
    return () => { activo = false }
  }, [])

  // Lo recién subido en esta sesión (de los 2 reportes Excel)
  const reportesNuevos = useMemo(() => {
    if (!paqData && !gesData) return []
    return combinar(paqData, gesData)
  }, [paqData, gesData])

  // Vista combinada: histórico guardado + lo nuevo (lo nuevo pisa por nro_guia_pap).
  // Al histórico se le recalcula la categoría con la lógica nueva (estado + motivo).
  const merged = useMemo(() => {
    const map = new Map()
    historico.forEach(h => {
      // Se sanea al leer: las filas viejas traen categoría e importe mal guardados.
      map.set(String(h.nro_guia_pap), sanearEntrega(h))
    })
    reportesNuevos.forEach(r => map.set(String(r.nro_guia_pap), r))
    return Array.from(map.values())
  }, [reportesNuevos, historico])

  // Mes de un paquete según FECHA DE INGRESO (recalculado para que el histórico viejo
  // —que guardó "mes" con otra fórmula— quede consistente con la decisión actual).
  const mesDePaquete = (m) => (m.fecha_ingreso || m.fecha_entrega || m.mes || '').slice(0, 7)

  // Meses disponibles en los datos (para el selector), del más nuevo al más viejo.
  // Combina meses con reporte PaP Y meses con ventas (porque la pirámide sale de ventas).
  const mesesDisponibles = useMemo(() => {
    const set = new Set()
    merged.forEach(m => { const mm = mesDePaquete(m); if (mm) set.add(mm) })
    ventasParaPiramide.forEach(v => { const mm = (v.fecha || '').slice(0, 7); if (mm) set.add(mm) })
    return Array.from(set).sort().reverse()
  }, [merged, ventasParaPiramide])

  // El mes "actual" = el más reciente que tenga datos (no el calendario, por si no cargaste aún este mes)
  const mesActual = mesesDisponibles[0] || ''
  const mesEfectivo = filtroMes === 'actual' ? mesActual : filtroMes

  // merged filtrado por el mes elegido (o todos)
  const mergedFiltrado = useMemo(() => {
    if (filtroMes === 'todos') return merged
    return merged.filter(m => mesDePaquete(m) === mesEfectivo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged, filtroMes, mesEfectivo])


  // AUTO-GUARDADO: al subir reportes, guarda y actualiza las ventas solo (con debounce
  // para esperar a que carguen ambos archivos si los subís juntos).
  useEffect(() => {
    if (!reportesNuevos.length) return
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current)
    autoSaveRef.current = setTimeout(() => { guardarEnSistema() }, 1500)
    return () => { if (autoSaveRef.current) clearTimeout(autoSaveRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportesNuevos])

  const stats = useMemo(() => {
    if (!mergedFiltrado.length) return null
    const total = mergedFiltrado.length
    const entregados = mergedFiltrado.filter(m => m.categoria === 'entregado')
    const devueltos = mergedFiltrado.filter(m => m.categoria === 'devuelto')
    const proceso = mergedFiltrado.filter(m => m.categoria === 'en_proceso')

    const cobrado = entregados.reduce((s, m) => s + m.importe, 0)
    const perdidoProd = devueltos.reduce((s, m) => s + m.importe, 0)
    const costoEnvios = COSTO_PAP * total
    const costoEnviosDevueltos = COSTO_PAP * devueltos.length
    const resueltos = entregados.length + devueltos.length

    const dias = entregados.map(m => m.dias_entrega).filter(d => d != null)
    const diasProm = dias.length ? (dias.reduce((a, b) => a + b, 0) / dias.length) : null

    // Tesorería / flujo de caja: cuánto ya te rindió PaP vs cuánto te debe
    const rendidos = entregados.filter(m => m.rendido)
    const entregadosSinRendir = entregados.filter(m => !m.rendido)
    const montoRendido = rendidos.reduce((s, m) => s + m.importe, 0)
    const montoPendienteCobro = entregadosSinRendir.reduce((s, m) => s + m.importe, 0)
    const diasRend = rendidos.map(m => m.dias_rendicion).filter(d => d != null)
    const diasRendicionProm = diasRend.length ? (diasRend.reduce((a, b) => a + b, 0) / diasRend.length) : null
    const hayTesoreria = mergedFiltrado.some(m => m.rendido || m.fecha_rendido)
    // Lista detallada de lo que PaP te debe, lo que más tiempo lleva primero (para reclamar)
    const hoy = new Date()
    const listaSinRendir = entregadosSinRendir.map(m => {
      const fEnt = m.fecha_entrega ? new Date(m.fecha_entrega) : null
      const diasSinRendir = fEnt ? Math.max(0, Math.round((hoy - fEnt) / 86400000)) : null
      return { ...m, diasSinRendir }
    }).sort((a, b) => (b.diasSinRendir ?? -1) - (a.diasSinRendir ?? -1))

    // por ciudad
    const ciudadMap = {}
    mergedFiltrado.forEach(m => {
      const c = m.ciudad || 'Sin ciudad'
      if (!ciudadMap[c]) ciudadMap[c] = { total: 0, entregados: 0 }
      ciudadMap[c].total++
      if (m.categoria === 'entregado') ciudadMap[c].entregados++
    })
    const porCiudad = Object.entries(ciudadMap)
      .filter(([, d]) => d.total >= 2)
      .map(([c, d]) => ({ ciudad: c, tasa: Math.round(d.entregados / d.total * 100), total: d.total, entregados: d.entregados }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)

    // por mensajero
    const msgMap = {}
    entregados.forEach(m => { const k = (m.mensajero || 'Sin asignar').split(' - ')[0]; msgMap[k] = (msgMap[k] || 0) + 1 })
    const porMensajero = Object.entries(msgMap).map(([m, n]) => ({ mensajero: m, entregas: n })).sort((a, b) => b.entregas - a.entregas).slice(0, 6)

    // motivos de no-entrega
    const motMap = {}
    ;[...devueltos, ...proceso].forEach(m => { const k = m.motivo || 'Sin motivo'; motMap[k] = (motMap[k] || 0) + 1 })
    const motivos = Object.entries(motMap).map(([m, n]) => ({ motivo: m, count: n })).sort((a, b) => b.count - a.count)

    const distribucion = [
      { name: 'Entregado', value: entregados.length, color: CAT_CFG.entregado.color },
      { name: 'Devuelto', value: devueltos.length, color: CAT_CFG.devuelto.color },
      { name: 'En proceso', value: proceso.length, color: CAT_CFG.en_proceso.color },
    ].filter(d => d.value > 0)

    return {
      total, entregados: entregados.length, devueltos: devueltos.length, proceso: proceso.length,
      tasaEntrega: resueltos ? Math.round(entregados.length / resueltos * 100) : 0,
      tasaTotal: total ? Math.round(entregados.length / total * 100) : 0,
      cobrado, perdidoProd, costoEnvios, costoEnviosDevueltos,
      margenNeto: cobrado - costoEnvios,
      perdidaTotal: perdidoProd + costoEnviosDevueltos,
      diasProm, porCiudad, porMensajero, motivos, distribucion,
      montoRendido, montoPendienteCobro, diasRendicionProm, hayTesoreria,
      rendidos: rendidos.length, entregadosSinRendir: entregadosSinRendir.length, listaSinRendir,
      conRef: mergedFiltrado.filter(m => m.n_referencia).length,
    }
  }, [mergedFiltrado])

  // ── PIRÁMIDE DE RENTABILIDAD (profit-first) ──
  // Costo promedio de producto como fallback (cuando no hay match por referencia)
  const COGS_PROMEDIO = 12000
  // ── Convierte VENTAS de un mes al formato de calcularPiramide ──
  // estado → categoria, total → importe. Esta es la FUENTE ÚNICA de la ganancia
  // (la misma que usa Reportes), para que ambas pantallas coincidan exacto.
  const ventasComoPaquetes = (ventasMes) => ventasMes.map(v => ({
    n_referencia: v.n_referencia,
    importe: v.total || 0,
    fecha: v.fecha,
    costo_envio: v.costo_envio,  // flete real de esta venta (su transportadora)
    categoria: v.estado === 'entregado' ? 'entregado'
             : v.estado === 'devuelto' ? 'devuelto'
             : 'en_proceso',
  }))

  // Ventas filtradas por el mes elegido (la pirámide sale de acá, no de PaP)
  const ventasDelMes = useMemo(() => {
    if (filtroMes === 'todos') return ventasParaPiramide
    return ventasParaPiramide.filter(v => (v.fecha || '').slice(0, 7) === mesEfectivo)
  }, [ventasParaPiramide, filtroMes, mesEfectivo])

  // ── RENTABILIDAD POR CIUDAD ──
  // Sale de VENTAS (la fuente de verdad de la plata), no de los reportes PaP.
  // Reusa el mismo módulo de pirámide, con gastos = 0: los gastos generales
  // (ads, sueldos) no se pueden repartir por ciudad, así que acá se mide
  // CONTRIBUCIÓN, que es lo que cada ciudad deja después de flete y producto.
  const [ciudadAbierta, setCiudadAbierta] = useState(null)

  // Muchas ventas viejas se importaron sin ciudad (Shopify manda "-" y el dato
  // real venía en los Note Attributes de Releasit). Pero el reporte de Punto a
  // Punto SÍ trae ciudad y producto. Cuando la venta no los tiene, los buscamos
  // ahí por número de referencia. Sin esto, todo cae en "Sin ciudad".
  const datosPaPPorRef = useMemo(() => {
    const m = {}
    for (const p of merged) {
      const ref = normalizarRef(p.n_referencia)
      if (!ref) continue
      if (!m[ref]) m[ref] = {}
      if (p.ciudad && !m[ref].ciudad) m[ref].ciudad = p.ciudad
      if (p.producto && !m[ref].producto) m[ref].producto = p.producto
    }
    return m
  }, [merged])

  const porCiudad = useMemo(() => {
    if (!ventasDelMes.length) return []
    const grupos = {}
    for (const v of ventasDelMes) {
      const dePaP = datosPaPPorRef[normalizarRef(v.n_referencia)] || {}
      const cruda = v.ciudad || dePaP.ciudad || ''
      const info = normalizarCiudad(cruda)
      if (!grupos[info.clave]) grupos[info.clave] = { info, ventas: [] }
      grupos[info.clave].ventas.push(v)
    }
    return Object.values(grupos).map(({ info, ventas }) => {
      const p = calcularPiramide(ventasComoPaquetes(ventas), refCosto, COGS_PROMEDIO, 0)
      // Qué producto funciona (o fracasa) en esta ciudad
      const prodMap = {}
      for (const v of ventas) {
        const dePaP = datosPaPPorRef[normalizarRef(v.n_referencia)] || {}
        const k = v.producto_nombre || dePaP.producto || 'Sin producto'
        ;(prodMap[k] = prodMap[k] || []).push(v)
      }
      const productos = Object.entries(prodMap)
        .map(([nombre, vs]) => ({ nombre, ...calcularPiramide(ventasComoPaquetes(vs), refCosto, COGS_PROMEDIO, 0) }))
        .sort((a, b) => a.contribucionFirme - b.contribucionFirme) // el que más sangra, arriba
      return { ...info, ...p, productos }
    }).sort((a, b) => b.contribucionFirme - a.contribucionFirme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ventasDelMes, refCosto, datosPaPPorRef])

  // Resumen por zona: ¿conviene mandar lejos?
  const porZona = useMemo(() => {
    const z = {}
    for (const c of porCiudad) {
      if (!z[c.zona]) z[c.zona] = { zona: c.zona, pedidos: 0, entregados: 0, devueltos: 0, resueltos: 0, contribucion: 0, sangrado: 0 }
      const t = z[c.zona]
      t.pedidos += c.total; t.entregados += c.entregados; t.devueltos += c.devueltos
      t.resueltos += c.resueltos; t.contribucion += c.contribucionFirme; t.sangrado += c.sangradoFlete
    }
    return Object.values(z).map(t => ({
      ...t,
      tasaEntrega: t.resueltos ? Math.round(t.entregados / t.resueltos * 100) : 0,
      contribPorEnvio: t.resueltos ? Math.round(t.contribucion / t.resueltos) : 0,
    })).sort((a, b) => b.contribucion - a.contribucion)
  }, [porCiudad])

  // Ciudades que te están costando plata. Mínimo 3 resueltos para no
  // alarmarse por un único pedido devuelto.
  const alertasCiudad = useMemo(
    () => porCiudad
      .filter(c => c.resueltos >= 3 && (c.contribucionFirme < 0 || c.tasaDevolucion >= 35))
      .sort((a, b) => a.contribucionFirme - b.contribucionFirme)
      .slice(0, 4),
    [porCiudad]
  )

  const sinReconocer = useMemo(() => porCiudad.filter(c => !c.reconocida && c.clave !== '_sin_dato'), [porCiudad])

  const piramide = useMemo(() => {
    if (!ventasDelMes.length) return null
    // gastos = 0: los gastos generales (ads, sueldos) no los controla la logística.
    // Esta pirámide llega hasta la contribución firme. La ganancia final vive en Reportes.
    return calcularPiramide(ventasComoPaquetes(ventasDelMes), refCosto, COGS_PROMEDIO, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ventasDelMes, refCosto, filtroMes, mesEfectivo])

  // Pirámide del MES ANTERIOR (para comparar: ¿mejoró o empeoró?)
  const piramideMesAnterior = useMemo(() => {
    if (filtroMes === 'todos' || !mesEfectivo) return null
    // Calcular el mes anterior a mesEfectivo (YYYY-MM)
    const [y, m] = mesEfectivo.split('-').map(Number)
    const fechaAnt = new Date(y, m - 2, 1) // m-2 porque Date usa 0-index
    const mesAnt = `${fechaAnt.getFullYear()}-${String(fechaAnt.getMonth() + 1).padStart(2, '0')}`
    const ventasAnt = ventasParaPiramide.filter(v => (v.fecha || '').slice(0, 7) === mesAnt)
    if (!ventasAnt.length) return null
    return { ...calcularPiramide(ventasComoPaquetes(ventasAnt), refCosto, COGS_PROMEDIO, 0), mes: mesAnt }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ventasParaPiramide, refCosto, filtroMes, mesEfectivo])

  const tablaFiltrada = useMemo(() => {
    let r = mergedFiltrado
    if (filtroCat !== 'todos') r = r.filter(m => m.categoria === filtroCat)
    if (busqueda.trim()) {
      const q = busqueda.toLowerCase()
      r = r.filter(m =>
        (m.n_referencia || '').includes(q) ||
        (m.ciudad || '').toLowerCase().includes(q) ||
        (m.mensajero || '').toLowerCase().includes(q) ||
        (m.estado_pap || '').toLowerCase().includes(q) ||
        (m.nro_guia_pap || '').includes(q)
      )
    }
    return r
  }, [mergedFiltrado, filtroCat, busqueda])

  const procesarFile = (file) => {
    if (!file?.name.match(/\.xlsx?$/i)) { toast('Solo archivos Excel (.xlsx)', 'error'); return }
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const parsed = parseXLSX(e.target.result)
        if (parsed.tipo === 'gestion') { setGesData(parsed); toast('Reporte de Gestión cargado ✓', 'success') }
        else if (parsed.tipo === 'paquete') { setPaqData(parsed); toast('Reporte de Paquetes cargado ✓', 'success') }
        else toast('No reconozco este reporte. ¿Es de Punto a Punto?', 'error')
        setGuardado(false)
      } catch (err) {
        toast('Error leyendo el archivo: ' + err.message, 'error')
      }
    }
    reader.readAsArrayBuffer(file)
  }

  const handleFiles = (files) => { Array.from(files).forEach(procesarFile) }

  // Columnas reales de la tabla entregas (sin telefono/nombre_cliente que son solo para el match)

  const guardarEnSistema = async () => {
    if (!merged.length) return
    setGuardando(true)
    try {
      // 1) Guardar las entregas nuevas en la tabla (solo columnas válidas)
      const limpio = reportesNuevos.map(soloColumnasEntregas)

      // 1.5) REGLA "una vez rendido, queda rendido":
      //   Traigo las guías que YA están rendidas en la base (por el Excel del
      //   martes o un reporte anterior). Si este reporte no las marca como
      //   rendidas todavía, NO las desmarco — conservo lo que ya había.
      //   El reporte SÍ puede marcar nuevas como rendidas, nunca desmarcar.
      const guiasSubidas = limpio.map(m => m.nro_guia_pap).filter(Boolean)
      const yaRendidas = {}
      for (let i = 0; i < guiasSubidas.length; i += 200) {
        const chunk = guiasSubidas.slice(i, i + 200)
        try {
          const { data } = await supabase.from('entregas')
            .select('nro_guia_pap, fecha_rendido, dias_rendicion')
            .in('nro_guia_pap', chunk).eq('rendido', true)
          for (const row of (data || [])) yaRendidas[String(row.nro_guia_pap)] = row
        } catch (e) { /* si falla la consulta, se sigue igual (no se pierde nada) */ }
      }
      for (const m of limpio) {
        const prev = yaRendidas[String(m.nro_guia_pap)]
        if (prev && !m.rendido) {
          // Estaba rendida y este reporte no lo dice: mantenerla rendida.
          m.rendido = true
          if (m.fecha_rendido == null) m.fecha_rendido = prev.fecha_rendido
          if (m.dias_rendicion == null) m.dias_rendicion = prev.dias_rendicion
        }
      }

      let ok = 0, errEntregas = null
      for (let i = 0; i < limpio.length; i += 100) {
        const lote = limpio.slice(i, i + 100)
        const { error } = await supabase.from('entregas').upsert(lote, { onConflict: 'nro_guia_pap' })
        if (error) { if (!errEntregas) errEntregas = error.message } else ok += lote.length
      }

      // 2) Actualizar estado de ventas — MATCH EN CASCADA multi-criterio.
      //    Procesa TODO lo visible (histórico recategorizado + recién subido).
      //    a) por referencia #XXXX  b) por teléfono (+monto)  c) por nombre+monto
      let porRef = 0, porTel = 0, porNombre = 0, sinMatch = 0
      let updOk = 0, updVacio = 0, updFail = 0
      let diagnostico = errEntregas ? `Las entregas no se guardaron: ${errEntregas}` : null
      try {
        const { data: ventas, error: errSel } = await fetchAllSafe(() => supabase.from('ventas').select('*'))
        if (errSel) { diagnostico = diagnostico || ('No pude leer las ventas: ' + errSel.message) }
        else if (!ventas || !ventas.length) { diagnostico = diagnostico || 'La consulta de ventas vino vacía (¿permisos de la tabla ventas?)' }
        else {
          // Detectar la columna identificadora (normalmente 'id')
          const pk = ('id' in ventas[0]) ? 'id' : (Object.keys(ventas[0]).find(k => k === 'uuid' || k.toLowerCase().endsWith('id')) || 'id')

          const idxRef = new Map()
          ventas.forEach(v => { const rr = normalizarRef(v.n_referencia); if (rr) idxRef.set(rr, v) })

          const usadas = new Set()
          const updates = []

          for (const m of merged) {
            if (m.categoria === 'en_proceso') continue
            const nuevoEstado = m.categoria === 'entregado' ? 'entregado' : 'devuelto'
            let venta = null, metodo = null

            if (m.n_referencia && idxRef.has(m.n_referencia)) {
              const v = idxRef.get(m.n_referencia)
              if (!usadas.has(v[pk])) { venta = v; metodo = 'ref' }
            }
            if (!venta && m.telefono) {
              const mismoTel = ventas.filter(v => limpiarTel(v.cliente_telefono) === m.telefono && !usadas.has(v[pk]))
              if (mismoTel.length === 1) { venta = mismoTel[0]; metodo = 'tel' }
              else if (mismoTel.length > 1) {
                const mismoMonto = mismoTel.filter(v => Number(v.total) === Number(m.importe))
                venta = (mismoMonto.length ? mismoMonto[0] : mismoTel[0]); metodo = 'tel'
              }
            }
            if (!venta && m.nombre_cliente && m.importe) {
              const nom = m.nombre_cliente.toLowerCase().trim()
              const cand = ventas.filter(v => (v.cliente_nombre || '').toLowerCase().trim() === nom && Number(v.total) === Number(m.importe) && !usadas.has(v[pk]))
              if (cand.length) { venta = cand[0]; metodo = 'nombre' }
            }

            if (venta) {
              // Solo actualizar si el estado cambia (evita writes inútiles)
              if (venta.estado !== nuevoEstado) updates.push({ id: venta[pk], estado: nuevoEstado })
              usadas.add(venta[pk])
              if (metodo === 'ref') porRef++; else if (metodo === 'tel') porTel++; else porNombre++
            } else { sinMatch++ }
          }

          updFail = 0; updVacio = 0; updOk = 0
          let primerError = null
          for (const u of updates) {
            const { data: upd, error: errUpd } = await supabase.from('ventas').update({ estado: u.estado }).eq(pk, u.id).select()
            if (errUpd) { updFail++; if (!primerError) primerError = errUpd.message }
            else if (!upd || !upd.length) { updVacio++ }
            else { updOk++ }
          }
          const totalMatch = porRef + porTel + porNombre
          if (updFail > 0 && !diagnostico) {
            diagnostico = `${updFail} UPDATEs dieron error (columna id="${pk}"): ${primerError}`
          } else if (updVacio > 0 && updOk === 0 && !diagnostico) {
            diagnostico = `Encontré ${totalMatch} ventas para actualizar (${porRef} por ref, ${porTel} por tel), pero NINGÚN UPDATE modificó la fila. Esto es RLS: la tabla "ventas" permite leer pero NO actualizar. Hay que agregar una policy de UPDATE en Supabase (te paso el SQL).`
          } else if (totalMatch === 0 && merged.some(m => m.categoria !== 'en_proceso') && !diagnostico) {
            const conTel = ventas.filter(v => v.cliente_telefono).length
            const conRefBD = ventas.filter(v => normalizarRef(v.n_referencia)).length
            diagnostico = `0 coincidencias. En BD: ${ventas.length} ventas, ${conRefBD} con n_referencia, ${conTel} con teléfono (col id="${pk}"). Reportes traen ${merged.filter(m=>m.categoria!=='en_proceso').length} entregas con estado. Si las ventas tienen ref pero no cruzan, el formato de n_referencia no coincide.`
          }
        }
      } catch (e) { diagnostico = diagnostico || ('Error inesperado: ' + (e?.message || e)) }

      // 3) Recargar el histórico para refrescar la vista con lo recién guardado
      try {
        const data = await fetchAll(
          () => supabase.from('entregas').select('*').order('fecha_entrega', { ascending: false }),
          { columnaOrden: 'nro_guia_pap' }
        )
        setHistorico(data || [])
      } catch (e) { /* nada */ }

      setGuardado(true)
      setResultadoGuardado({ ok, porRef, porTel, porNombre, sinMatch, updOk, updVacio, updFail, diagnostico })
      toast(diagnostico ? `Guardado con avisos — mirá el detalle` : `${ok} entregas · ${updOk} ventas actualizadas`, diagnostico ? 'error' : 'success')
    } catch (err) {
      toast('Error guardando: ' + err.message, 'error')
    }
    setGuardando(false)
  }

  const reset = () => { setPaqData(null); setGesData(null); setBusqueda(''); setFiltroCat('todos'); setGuardado(false); setResultadoGuardado(null) }

  // ── CARGANDO HISTÓRICO ──────────────────────────────────
  if (cargandoHist) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320, color: 'var(--text-muted)', fontSize: 13 }}>
      Cargando entregas guardadas...
    </div>
  )

  // ── UPLOAD ──────────────────────────────────────────────
  // Mostrar la pantalla de "subí reportes" solo si no hay NADA: ni datos de PaP ni ventas.
  // Si hay ventas (aunque falte el reporte PaP), mostramos el dashboard con la pirámide.
  if (!stats && !piramide) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Entregas · Tracking Punto a Punto</h1>
          <p className="page-subtitle">Subí los 2 reportes de PaP y mirá tu tasa de entrega y rentabilidad real</p>
        </div>
      </div>

      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>¿Cómo exportar de Punto a Punto?</div>
        {['Entrá a rastreo.puntoapunto.com.py → Reportes','Descargá el "Reporte de Gestión" (elegí el rango de fechas)','Descargá también el "Reporte de Paquetes" (mismo rango)','Subí los 2 archivos acá abajo'].map((p, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</div>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{p}</span>
          </div>
        ))}
      </div>

      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}
        style={{ border: '2px dashed var(--border)', borderRadius: 14, padding: '50px 20px', textAlign: 'center', cursor: 'pointer', background: 'var(--bg-card)', transition: 'all 0.2s' }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-dim)' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-card)' }}
      >
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
        <Upload size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Arrastrá los 2 reportes Excel acá</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>los detecto automáticamente · podés subirlos juntos o de a uno</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="card card-sm" style={{ display: 'flex', alignItems: 'center', gap: 12, borderColor: gesData ? 'var(--green)' : 'var(--border)' }}>
          {gesData ? <CheckCircle size={24} color="var(--green)" /> : <FileSpreadsheet size={24} color="var(--text-muted)" />}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Reporte de Gestión</div>
            <div style={{ fontSize: 11, color: gesData ? 'var(--green)' : 'var(--text-muted)' }}>{gesData ? `${gesData.rows.length} filas cargadas` : 'Pendiente'}</div>
          </div>
        </div>
        <div className="card card-sm" style={{ display: 'flex', alignItems: 'center', gap: 12, borderColor: paqData ? 'var(--green)' : 'var(--border)' }}>
          {paqData ? <CheckCircle size={24} color="var(--green)" /> : <FileSpreadsheet size={24} color="var(--text-muted)" />}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Reporte de Paquetes</div>
            <div style={{ fontSize: 11, color: paqData ? 'var(--green)' : 'var(--text-muted)' }}>{paqData ? `${paqData.rows.length} filas cargadas` : 'Pendiente'}</div>
          </div>
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
        Con un solo reporte ya ves resultados, pero con los 2 el análisis es completo.
      </p>
    </div>
  )

  // ── DASHBOARD ───────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Entregas · Tracking Punto a Punto</h1>
          <p className="page-subtitle">
            {filtroMes === 'todos'
              ? <>{merged.length} paquetes en total · histórico completo</>
              : stats
                ? <>{stats.total} paquetes en {etiquetaMes(mesEfectivo)} · {stats.conRef} con referencia</>
                : <>{piramide?.total || 0} ventas en {etiquetaMes(mesEfectivo)} · sin reporte PaP cargado</>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
          {guardando && <span style={{ fontSize: 12, color: 'var(--accent)' }}>Procesando...</span>}
          <button className="btn btn-ghost btn-sm" onClick={guardarEnSistema} disabled={guardando} title="Vuelve a aplicar los estados a tus ventas">
            <CheckCircle size={13} /> Actualizar ventas
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => fileRef.current?.click()} disabled={guardando}>
            <Upload size={13} /> Subir reportes
          </button>
          {reportesNuevos.length > 0 && <button className="btn btn-ghost btn-sm" onClick={reset}><X size={13} /> Limpiar</button>}
        </div>
      </div>

      {/* Selector de mes — analiza por período (fecha de ingreso a despacho) */}
      {mesesDisponibles.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '12px 14px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12 }}>
          <Calendar size={15} color="var(--accent)" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 4 }}>Período:</span>
          <div className="filter-scroll" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mesesDisponibles.map(mm => (
              <button
                key={mm}
                onClick={() => setFiltroMes(mm)}
                className="btn btn-sm"
                style={{
                  background: (mesEfectivo === mm && filtroMes !== 'todos') ? 'var(--accent)' : 'var(--bg-hover)',
                  color: (mesEfectivo === mm && filtroMes !== 'todos') ? '#000' : 'var(--text-secondary)',
                  border: 'none', fontWeight: (mesEfectivo === mm && filtroMes !== 'todos') ? 700 : 500,
                  whiteSpace: 'nowrap',
                }}
              >
                {etiquetaMes(mm)}
              </button>
            ))}
            <button
              onClick={() => setFiltroMes('todos')}
              className="btn btn-sm"
              style={{
                background: filtroMes === 'todos' ? 'var(--accent)' : 'var(--bg-hover)',
                color: filtroMes === 'todos' ? '#000' : 'var(--text-secondary)',
                border: 'none', fontWeight: filtroMes === 'todos' ? 700 : 500,
                whiteSpace: 'nowrap',
              }}
            >
              Todos
            </button>
          </div>
          {filtroMes !== 'todos' && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              {(stats?.total ?? piramide?.total ?? 0)} paquete{(stats?.total ?? piramide?.total ?? 0) !== 1 ? 's' : ''} en {etiquetaMes(mesEfectivo)}
            </span>
          )}
        </div>
      )}

      {/* Resultado del guardado: cuántas ventas se actualizaron y cómo */}
      {resultadoGuardado && (
        <div className={`alert alert-${resultadoGuardado.diagnostico ? 'warning' : 'success'}`}>
          {resultadoGuardado.diagnostico ? <AlertTriangle size={15} /> : <CheckCircle size={15} />}
          <div>
            <div style={{ fontWeight: 600 }}>{resultadoGuardado.ok} entregas guardadas · {resultadoGuardado.updOk ?? 0} ventas actualizadas</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              <span>Coincidencias: </span>
              {resultadoGuardado.porRef > 0 && <span>{resultadoGuardado.porRef} por referencia</span>}
              {resultadoGuardado.porRef > 0 && (resultadoGuardado.porTel > 0 || resultadoGuardado.porNombre > 0) && <span> · </span>}
              {resultadoGuardado.porTel > 0 && <span>{resultadoGuardado.porTel} por teléfono</span>}
              {resultadoGuardado.porTel > 0 && resultadoGuardado.porNombre > 0 && <span> · </span>}
              {resultadoGuardado.porNombre > 0 && <span>{resultadoGuardado.porNombre} por nombre+monto</span>}
              {(resultadoGuardado.porRef + resultadoGuardado.porTel + resultadoGuardado.porNombre) === 0 && <span>ninguna</span>}
              {resultadoGuardado.sinMatch > 0 && <span style={{ color: 'var(--yellow)' }}> · {resultadoGuardado.sinMatch} sin coincidencia</span>}
              {resultadoGuardado.updVacio > 0 && <span style={{ color: 'var(--yellow)' }}> · {resultadoGuardado.updVacio} bloqueadas por permisos</span>}
            </div>
            {resultadoGuardado.diagnostico && (
              <div style={{ fontSize: 12, marginTop: 6, color: 'var(--yellow)', background: 'var(--bg-hover)', padding: 8, borderRadius: 6 }}>
                ⚠ {resultadoGuardado.diagnostico}
              </div>
            )}
            {!resultadoGuardado.diagnostico && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Las ventas pasaron de "Pendiente" a "Entregado" o "Devuelto". Revisá la sección Ventas.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ PIRÁMIDE DE RENTABILIDAD — profit-first ═══ */}
      {piramide && (() => {
        const p = piramide
        const prev = piramideMesAnterior
        // Número estrella de LOGÍSTICA: la contribución que deja cada envío.
        // No es la ganancia final: los gastos generales (ads, sueldos) no los
        // controla esta operación. Esa ganancia vive en Reportes.
        // Se elige "por envío" y no el total porque el total sube solo con el
        // volumen, aunque cada paquete rinda peor. Por envío avisa cuando la
        // operación se pudre.
        const estrella = p.contribPorEnvio
        const positivo = estrella >= 0
        const deltaDevol = prev ? p.tasaDevolucion - prev.tasaDevolucion : null
        const deltaEstrella = prev ? estrella - prev.contribPorEnvio : null
        const fmtSigno = (n) => (n >= 0 ? '+' : '') + formatGs(n)

        return (
          <>
            {/* NÚMERO ESTRELLA: CONTRIBUCIÓN POR ENVÍO (salud de la operación) */}
            <div className="card" style={{
              padding: '22px 24px',
              background: positivo
                ? 'linear-gradient(135deg, rgba(34,197,94,0.12), transparent 70%)'
                : 'linear-gradient(135deg, rgba(239,68,68,0.12), transparent 70%)',
              border: `1px solid ${positivo ? 'var(--green)' : 'var(--red)'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                    Contribución por envío
                    {filtroMes !== 'todos' && ` · ${etiquetaMes(mesEfectivo)}`}
                  </div>
                  <div style={{
                    fontSize: 38, fontWeight: 800, fontFamily: 'var(--font-display)', lineHeight: 1,
                    color: positivo ? 'var(--green)' : 'var(--red)',
                  }}>
                    {fmtSigno(estrella)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, maxWidth: 520 }}>
                    Lo que deja <strong>cada uno</strong> de los {p.resueltos} paquetes que cerraron. Sube si entregás más, baja si te devuelven. Es la salud de tu operación, sin importar cuánto vendiste.
                  </div>
                </div>
                {deltaEstrella != null && (
                  <div style={{
                    padding: '8px 14px', borderRadius: 10, background: 'var(--bg-card)',
                    border: '1px solid var(--border)', textAlign: 'right',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>vs {etiquetaMes(prev.mes)}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: deltaEstrella >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {deltaEstrella >= 0 ? '↑' : '↓'} {fmtSigno(deltaEstrella)}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* TASA DE ENTREGA POR TRANSPORTADORA */}
            {(() => {
              const tp = tasaPorTransportadora(mergedFiltrado, transpPorRef)
              const cols = Object.entries(tp).filter(([k, v]) => k !== 'total' && v.resueltos > 0)
              if (!cols.length) return null
              const pct = (x) => x == null ? '—' : `${Math.round(x * 100)}%`
              const colorTasa = (t) => t == null ? 'var(--text-muted)' : t >= 0.85 ? 'var(--green)' : t >= 0.7 ? 'var(--accent)' : 'var(--red)'
              return (
                <div className="card" style={{ padding: '16px 20px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Tasa de entrega por transportadora
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
                    Solo paquetes cerrados (entregados + devueltos). Los que vuelven pagan flete igual, así que cada punto vale plata.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                    {cols.map(([id, v]) => (
                      <div key={id} className="kpi-card">
                        <div className="kpi-label">{labelTransportadora(id)}</div>
                        <div className="kpi-value" style={{ fontSize: 22, color: colorTasa(v.tasa) }}>{pct(v.tasa)}</div>
                        <div className="kpi-sub">{v.entregados} de {v.resueltos} · {v.devueltos} devueltos</div>
                      </div>
                    ))}
                    {tp.total && cols.length > 1 && (
                      <div className="kpi-card">
                        <div className="kpi-label">Total</div>
                        <div className="kpi-value" style={{ fontSize: 22 }}>{pct(tp.total.tasa)}</div>
                        <div className="kpi-sub">{tp.total.entregados} de {tp.total.resueltos}</div>
                      </div>
                    )}
                  </div>
                  {cols.length < 2 && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10 }}>
                      Todavía no hay paquetes cerrados de la otra transportadora — cuando los haya, se comparan acá.
                    </div>
                  )}
                </div>
              )
            })()}

            {/* LA PIRÁMIDE — hasta donde llega la logística (CM2) */}
            <div className="card" style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 14, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                De dónde sale (solo lo que ya cerró)
              </div>
              {[
                { label: 'Ingreso cobrado', sub: `${p.entregados} entregados`, val: p.ingreso, sign: '+', color: 'var(--green)' },
                { label: 'Flete de envíos', sub: `${p.resueltos} resueltos × 27k`, val: -p.fleteResueltos, sign: '−', color: 'var(--red)' },
                { label: 'Costo del producto', sub: `solo los ${p.entregados} entregados`, val: -p.cogs, sign: '−', color: 'var(--red)' },
                { label: 'Contribución firme', sub: `${p.resueltos} envíos × ${formatGs(p.contribPorEnvio)}`, val: p.contribucionFirme, sign: '=', color: p.contribucionFirme >= 0 ? 'var(--green)' : 'var(--red)', bold: true, destacado: true },
              ].map((nivel, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: nivel.bold ? '12px 12px' : '8px 12px',
                  borderTop: nivel.sign === '=' ? '1px solid var(--border)' : 'none',
                  marginTop: nivel.sign === '=' ? 4 : 0,
                  background: nivel.destacado ? 'var(--green-dim)' : 'transparent',
                  borderRadius: nivel.destacado ? 8 : 0,
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-muted)', width: 16 }}>{nivel.sign}</span>
                    <div>
                      <div style={{ fontSize: nivel.bold ? 14 : 13, fontWeight: nivel.bold ? 700 : 500 }}>{nivel.label}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{nivel.sub}</div>
                    </div>
                  </div>
                  <div style={{
                    fontSize: nivel.bold ? 18 : 15, fontWeight: nivel.bold ? 800 : 600,
                    color: nivel.color, fontFamily: 'var(--font-display)',
                  }}>
                    {formatGs(nivel.val)}
                  </div>
                </div>
              ))}

              {/* Dónde termina la logística y empieza la contabilidad */}
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, maxWidth: 460, lineHeight: 1.5 }}>
                  Acá termina la logística. Los gastos generales (ads, sueldos) no los controla esta operación — la ganancia final está en Reportes.
                </p>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => navigate('/reportes')}
                  style={{ color: 'var(--accent)', whiteSpace: 'nowrap' }}
                >
                  Ver ganancia completa <ArrowRight size={13} />
                </button>
              </div>

              {p.cogsEstimado > 0 && (
                <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 10, fontStyle: 'italic' }}>
                  Nota: {p.conCostoReal} entregados con costo real (cruzados con su venta) y {p.cogsEstimado} con costo estimado ({formatGs(COGS_PROMEDIO)}). Cargá la referencia en cada venta para precisión total.
                </p>
              )}
            </div>

            {/* BLOQUE EN TRÁNSITO — lo que todavía está volando (proyección) */}
            {p.enProceso > 0 && (
              <div className="card" style={{ padding: '16px 20px', border: '1px solid var(--yellow)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Clock size={15} color="var(--yellow)" />
                  <span style={{ fontSize: 13, fontWeight: 700 }}>En tránsito · {p.enProceso} paquetes todavía volando</span>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
                  Estos NO están en la contribución firme porque aún no cerraron. Esto es la <strong>proyección</strong> si cierran como tu historial ({p.tasaEntrega}% de entrega).
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
                  <div style={{ padding: 12, background: 'var(--bg-hover)', borderRadius: 10 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Flete ya comprometido</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--font-display)' }}>−{formatGs(p.fleteEnTransito)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{p.enProceso} × 27k (ya despachados)</div>
                  </div>
                  <div style={{ padding: 12, background: 'var(--bg-hover)', borderRadius: 10 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Proyección de cierre</div>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-display)' }}>
                      ~{p.entregadosProyectados} <span style={{ color: 'var(--green)', fontSize: 12 }}>entregan</span> · ~{p.devueltosProyectados} <span style={{ color: 'var(--red)', fontSize: 12 }}>vuelven</span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>a tu tasa histórica {p.tasaEntrega}%</div>
                  </div>
                  <div style={{ padding: 12, background: p.contribucionProyectada >= 0 ? 'var(--green-dim)' : 'var(--bg-hover)', borderRadius: 10 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Aportaría a tu contribución</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: p.contribucionProyectada >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-display)' }}>
                      {p.contribucionProyectada >= 0 ? '+' : ''}{formatGs(p.contribucionProyectada)}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>si cierran como el promedio</div>
                  </div>
                </div>
              </div>
            )}

            {/* LAS 3 PALANCAS — métricas clave */}
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label"><TrendingUp size={13} style={{ verticalAlign: -2 }} /> Tasa de entrega</div>
                <div className="kpi-value" style={{ color: p.tasaEntrega >= 70 ? 'var(--green)' : p.tasaEntrega >= 50 ? 'var(--yellow)' : 'var(--red)' }}>{p.tasaEntrega}%</div>
                <div className="kpi-sub">{p.entregados} de {p.resueltos} resueltos llegaron</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label"><PackageX size={13} style={{ verticalAlign: -2 }} /> Tasa de devolución</div>
                <div className="kpi-value" style={{ color: p.tasaDevolucion > 25 ? 'var(--red)' : p.tasaDevolucion > 15 ? 'var(--yellow)' : 'var(--green)' }}>{p.tasaDevolucion}%</div>
                <div className="kpi-sub">
                  {deltaDevol != null
                    ? <span style={{ color: deltaDevol <= 0 ? 'var(--green)' : 'var(--red)' }}>{deltaDevol <= 0 ? '↓' : '↑'} {Math.abs(deltaDevol)}pts vs {etiquetaMes(prev.mes)}</span>
                    : `${p.devueltos} de ${p.resueltos} resueltos`}
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label"><TrendingDown size={13} style={{ verticalAlign: -2 }} /> Sangrado por fletes</div>
                <div className="kpi-value" style={{ color: 'var(--red)' }}>{formatGs(p.sangradoFlete)}</div>
                <div className="kpi-sub">{p.devueltos} devoluciones × 27k (el producto vuelve)</div>
              </div>
            </div>
          </>
        )
      })()}


      {/* ════ RENTABILIDAD POR CIUDAD (sale de ventas, no de PaP) ════ */}
      {porCiudad.length > 0 && (
        <>
          {/* Ciudades que sangran */}
          {alertasCiudad.length > 0 && (
            <div className="card" style={{ border: '1px solid var(--red)', padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <AlertTriangle size={15} color="var(--red)" />
                <span style={{ fontSize: 13, fontWeight: 700 }}>Ciudades que te están costando plata</span>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, marginTop: 0 }}>
                Después del flete de las devoluciones, acá perdés o casi no ganás. Considerá dejar de pautar o pedir seña.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                {alertasCiudad.map(c => (
                  <div key={c.clave} style={{ padding: 12, background: 'var(--bg-hover)', borderRadius: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{c.nombre}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'var(--font-display)', color: c.contribucionFirme < 0 ? 'var(--red)' : 'var(--yellow)', marginTop: 2 }}>
                      {c.contribucionFirme >= 0 ? '+' : ''}{formatGs(c.contribucionFirme)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      {c.tasaDevolucion}% devolución · {formatGs(c.sangradoFlete)} en fletes perdidos
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Resumen por zona: ¿conviene mandar lejos? */}
          <div className="kpi-grid">
            {porZona.map(z => (
              <div key={z.zona} className="kpi-card" style={{ borderLeft: `3px solid ${ZONAS[z.zona]?.color || '#666'}` }}>
                <div className="kpi-label">{ZONAS[z.zona]?.label || z.zona}</div>
                <div className="kpi-value" style={{ color: z.contribucion >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {formatGs(z.contribucion)}
                </div>
                <div className="kpi-sub">
                  {z.pedidos} pedidos · {z.tasaEntrega}% entrega · {formatGs(z.contribPorEnvio)}/envío
                </div>
              </div>
            ))}
          </div>

          {/* Tabla por ciudad */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <MapPin size={15} color="var(--accent)" />
              <span style={{ fontSize: 13, fontWeight: 700 }}>Rentabilidad por ciudad</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                Tocá una fila para ver qué producto funciona ahí
              </span>
            </div>
            <div style={{ overflowX: 'auto', maxHeight: 520 }}>
              <table className="tabla-responsive">
                <thead>
                  <tr>
                    <th>Ciudad</th><th>Zona</th><th>Pedidos</th><th>Entreg.</th><th>Devuel.</th>
                    <th>Tasa</th><th>Contribución</th><th>Por envío</th><th>Sangrado</th>
                  </tr>
                </thead>
                <tbody>
                  {porCiudad.map(c => {
                    const abierta = ciudadAbierta === c.clave
                    const negativa = c.contribucionFirme < 0
                    return (
                      <Fragment key={c.clave}>
                        <tr
                          onClick={() => setCiudadAbierta(abierta ? null : c.clave)}
                          style={{ cursor: 'pointer', background: negativa ? 'rgba(239,68,68,0.06)' : undefined }}
                        >
                          <td data-label="Ciudad" style={{ fontWeight: 600 }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {abierta ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              {c.nombre}
                              {!c.reconocida && <span title="Ciudad no reconocida" style={{ color: 'var(--yellow)', fontSize: 11 }}>·?</span>}
                            </span>
                          </td>
                          <td data-label="Zona">
                            <span style={{ fontSize: 10, fontWeight: 600, color: ZONAS[c.zona]?.color }}>{ZONAS[c.zona]?.label}</span>
                          </td>
                          <td data-label="Pedidos">{c.total}</td>
                          <td data-label="Entreg." style={{ color: 'var(--green)' }}>{c.entregados}</td>
                          <td data-label="Devuel." style={{ color: c.devueltos > 0 ? 'var(--red)' : 'var(--text-muted)' }}>{c.devueltos}</td>
                          <td data-label="Tasa" style={{ fontWeight: 600, color: c.tasaEntrega >= 70 ? 'var(--green)' : c.tasaEntrega >= 50 ? 'var(--yellow)' : 'var(--red)' }}>
                            {c.tasaEntrega}%
                          </td>
                          <td data-label="Contribución" style={{ fontWeight: 700, color: negativa ? 'var(--red)' : 'var(--green)' }}>
                            {formatGs(c.contribucionFirme)}
                          </td>
                          <td data-label="Por envío" style={{ color: c.contribPorEnvio < 0 ? 'var(--red)' : 'var(--text-secondary)' }}>
                            {formatGs(c.contribPorEnvio)}
                          </td>
                          <td data-label="Sangrado" style={{ color: 'var(--red)', fontSize: 12 }}>{formatGs(c.sangradoFlete)}</td>
                        </tr>
                        {abierta && (
                          <tr>
                            <td colSpan={9} style={{ background: 'var(--bg-hover)', padding: '10px 16px' }}>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                                Productos en {c.nombre} — el que más sangra, primero
                              </div>
                              {c.productos.map(p => (
                                <div key={p.nombre} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 12, gap: 10, flexWrap: 'wrap' }}>
                                  <span style={{ fontWeight: 500, flex: 1, minWidth: 140 }}>{p.nombre}</span>
                                  <span className="muted">{p.total} ped. · {p.devueltos} dev. ({p.tasaDevolucion}%)</span>
                                  <span style={{ fontWeight: 700, color: p.contribucionFirme < 0 ? 'var(--red)' : 'var(--green)', minWidth: 90, textAlign: 'right' }}>
                                    {formatGs(p.contribucionFirme)}
                                  </span>
                                </div>
                              ))}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {sinReconocer.length > 0 && (
              <p style={{ fontSize: 10.5, color: 'var(--text-muted)', padding: '10px 20px', margin: 0, fontStyle: 'italic', borderTop: '1px solid var(--border)' }}>
                {sinReconocer.length} ciudad{sinReconocer.length === 1 ? '' : 'es'} sin reconocer (marcadas con ·?): {sinReconocer.map(c => c.nombre).join(', ')}. Se muestran tal cual vinieron, sin mezclarse.
              </p>
            )}
          </div>

          {/* Mapa geográfico de las mismas ciudades */}
          <MapaCiudades ciudades={porCiudad} />
        </>
      )}

      {/* ════ SECCIONES LOGÍSTICAS (solo con reporte PaP cargado) ════ */}
      {stats && (<>

      {/* Aviso si el conteo de ventas y el de PaP difieren (fuentes distintas) */}
      {piramide && stats.total !== piramide.total && filtroMes !== 'todos' && (
        <div className="alert" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <AlertTriangle size={15} color="var(--text-muted)" style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            La <strong>ganancia de arriba</strong> sale de tus {piramide.total} ventas del mes (tu fuente de plata). Lo de <strong>acá abajo</strong> es el detalle logístico de los {stats.total} paquetes que Punto a Punto movió y reportó. Si no coinciden, es porque {stats.total < piramide.total ? `${piramide.total - stats.total} pedidos los despachaste por otro medio o aún no están en el reporte PaP` : 'el reporte PaP incluye paquetes de otros meses'}.
          </div>
        </div>
      )}

      {/* Flujo de caja con PaP (solo si el reporte incluye Tesorería) */}
      {stats.hayTesoreria && (
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Truck size={15} color="var(--accent)" /> Flujo de caja con Punto a Punto
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
            PaP cobra al cliente y la plata pasa por mensajero → supervisor → tesorero antes de llegarte.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            <div style={{ padding: 12, background: 'var(--green-dim)', borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>✅ Ya depositado a vos</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--font-display)' }}>{formatGs(stats.montoRendido)}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{stats.rendidos} pedidos rendidos</div>
            </div>
            <div onClick={() => stats.entregadosSinRendir > 0 && setVerSinRendir(v => !v)}
                 style={{ padding: 12, background: 'var(--bg-hover)', borderRadius: 10, border: '1px solid var(--yellow)', cursor: stats.entregadosSinRendir > 0 ? 'pointer' : 'default' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>⏳ PaP te debe todavía</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--yellow)', fontFamily: 'var(--font-display)' }}>{formatGs(stats.montoPendienteCobro)}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                {stats.entregadosSinRendir} entregados sin rendir
                {stats.entregadosSinRendir > 0 && <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>· {verSinRendir ? 'ocultar ▲' : 'ver cuáles ▼'}</span>}
              </div>
            </div>
            <div style={{ padding: 12, background: 'var(--bg-hover)', borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>⏱ Tiempo de cobro</div>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'var(--font-display)' }}>{stats.diasRendicionProm ? `${stats.diasRendicionProm.toFixed(1)} días` : '—'}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>De la entrega al depósito</div>
            </div>
          </div>

          {/* Detalle de entregados sin rendir (plata que PaP debe) */}
          {verSinRendir && stats.listaSinRendir.length > 0 && (
            <div style={{ marginTop: 14, border: '1px solid var(--yellow)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', background: 'var(--bg-hover)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--yellow)' }}>
                  {stats.listaSinRendir.length} entregas que PaP cobró pero todavía no te depositó · {formatGs(stats.montoPendienteCobro)}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Ordenadas por las que llevan más tiempo (reclamá estas primero)</span>
              </div>
              <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                <table className="tabla-responsive" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-card)' }}>
                    <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase' }}>
                      <th style={{ padding: '8px 14px' }}>Ref</th>
                      <th style={{ padding: '8px 6px' }}>Guía PaP</th>
                      <th style={{ padding: '8px 6px' }}>Cliente</th>
                      <th style={{ padding: '8px 6px' }}>Ciudad</th>
                      <th style={{ padding: '8px 6px' }}>Entregado</th>
                      <th style={{ padding: '8px 6px', textAlign: 'center' }}>Días</th>
                      <th style={{ padding: '8px 14px', textAlign: 'right' }}>Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.listaSinRendir.map((m, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                        <td data-label="Ref" style={{ padding: '8px 14px', fontWeight: 600 }}>{m.n_referencia ? '#' + m.n_referencia : '—'}</td>
                        <td data-label="Guía PaP" style={{ padding: '8px 6px', color: 'var(--text-muted)' }}>{m.nro_guia_pap}</td>
                        <td data-label="Cliente" style={{ padding: '8px 6px' }}>{m.nombre_cliente || '—'}</td>
                        <td data-label="Ciudad" style={{ padding: '8px 6px' }}>{m.ciudad || '—'}</td>
                        <td data-label="Entregado" style={{ padding: '8px 6px', color: 'var(--text-muted)' }}>{m.fecha_entrega ? new Date(m.fecha_entrega).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' }) : '—'}</td>
                        <td data-label="Días" style={{ padding: '8px 6px', textAlign: 'center' }}>
                          {m.diasSinRendir != null
                            ? <span style={{ color: m.diasSinRendir > 15 ? 'var(--red)' : m.diasSinRendir > 8 ? 'var(--yellow)' : 'var(--text-muted)', fontWeight: m.diasSinRendir > 15 ? 700 : 400 }}>{m.diasSinRendir}d</span>
                            : '—'}
                        </td>
                        <td data-label="Importe" style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 600 }}>{formatGs(m.importe)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Distribución + Ciudad */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Distribución de estados</div>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={stats.distribucion} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {stats.distribucion.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Pie>
              <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap', marginTop: 4 }}>
            {stats.distribucion.map((e, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: e.color }} />
                <span style={{ color: 'var(--text-secondary)' }}>{e.name} ({e.value})</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Mensajeros + Motivos */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="card card-sm">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <User size={15} color="var(--green)" /> Top mensajeros (entregas)
          </div>
          {stats.porMensajero.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < stats.porMensajero.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m.mensajero}</span>
              <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--font-display)' }}>{m.entregas}</span>
            </div>
          ))}
        </div>

        <div className="card card-sm">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <PackageX size={15} color="var(--red)" /> Motivos de no-entrega
          </div>
          {stats.motivos.map((m, i) => {
            const max = stats.motivos[0].count
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{m.motivo}</span>
                  <span style={{ fontWeight: 700 }}>{m.count}</span>
                </div>
                <div style={{ height: 5, background: 'var(--bg-hover)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${m.count / max * 100}%`, height: '100%', background: 'var(--red)' }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Tabla */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Detalle de paquetes</span>
          <div className="tabs" style={{ marginLeft: 0 }}>
            {[['todos', 'Todos'], ['entregado', 'Entregados'], ['devuelto', 'Devueltos'], ['en_proceso', 'En proceso']].map(([k, l]) => (
              <button key={k} className={`tab ${filtroCat === k ? 'active' : ''}`} onClick={() => setFiltroCat(k)}>{l}</button>
            ))}
          </div>
          <div style={{ position: 'relative', marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            <Search size={13} color="var(--text-muted)" style={{ position: 'absolute', left: 9 }} />
            <input value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar ref, ciudad, mensajero..." style={{ padding: '6px 10px 6px 28px', fontSize: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', width: 220 }} />
          </div>
        </div>
        <div style={{ overflowX: 'auto', maxHeight: 480 }}>
          <table className="tabla-responsive">
            <thead>
              <tr>
                <th>Ref.</th><th>Guía PaP</th><th>Estado</th><th>Ciudad</th><th>Mensajero</th><th>Producto</th><th>Importe</th><th>Cobrado</th><th>Entrega</th>
              </tr>
            </thead>
            <tbody>
              {tablaFiltrada.map((m, i) => (
                <tr key={i}>
                  <td data-label="Ref." className="mono">{m.n_referencia ? `#${m.n_referencia}` : '—'}</td>
                  <td data-label="Guía PaP" className="muted" style={{ fontSize: 11 }}>{m.nro_guia_pap}</td>
                  <td data-label="Estado"><span style={{ fontSize: 11, fontWeight: 600, color: catCfg(m.categoria).color, whiteSpace: 'nowrap' }}>{m.estado_pap}</span></td>
                  <td data-label="Ciudad" className="muted">{m.ciudad || '—'}</td>
                  <td data-label="Mensajero" className="muted" style={{ fontSize: 11 }}>{(m.mensajero || '—').split(' - ')[0]}</td>
                  <td data-label="Producto" style={{ fontSize: 11 }}>{(m.producto || '—').slice(0, 28)}</td>
                  <td data-label="Importe" style={{ fontWeight: 600 }}>{formatGs(m.importe)}</td>
                  <td data-label="Cobrado" style={{ fontWeight: 600, color: m.cobrado > 0 ? 'var(--green)' : 'var(--text-muted)' }}>{m.cobrado > 0 ? formatGs(m.cobrado) : '—'}</td>
                  <td data-label="Entrega" className="muted" style={{ fontSize: 11 }}>{m.fecha_entrega || '—'}{m.dias_entrega != null ? ` (${m.dias_entrega}d)` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      </>)}
      {/* ════ FIN SECCIONES LOGÍSTICAS ════ */}
    </div>
  )
}
