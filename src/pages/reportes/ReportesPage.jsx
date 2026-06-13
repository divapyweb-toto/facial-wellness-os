// src/pages/reportes/ReportesPage.jsx
import { useState, useCallback, useRef } from 'react'
import { supabase, formatGs, formatPct } from '../../lib/supabase'
import { FileBarChart2, Download, Loader2, ArrowUpRight, ArrowDownRight, Minus, AlertTriangle, MapPin, Truck, Calendar, Repeat } from 'lucide-react'
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts'

const COLORS = ['#c8f135', '#22c55e', '#3b82f6', '#a78bfa', '#f59e0b', '#ef4444', '#ec4899']

// Badge de variación vs mes anterior
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
  const [datos, setDatos] = useState(null)
  const [loading, setLoading] = useState(false)
  const [generandoPdf, setGenerandoPdf] = useState(false)
  const reportRef = useRef()

  const cargarDatos = useCallback(async () => {
    setLoading(true)
    const [year, month] = mes.split('-')
    const inicio = `${year}-${month}-01`
    const fin = new Date(year, parseInt(month), 0).toISOString().split('T')[0]
    // Mes anterior (para comparar)
    const dPrev = new Date(year, parseInt(month) - 2, 1)
    const yPrev = dPrev.getFullYear(), mPrev = String(dPrev.getMonth() + 1).padStart(2, '0')
    const inicioPrev = `${yPrev}-${mPrev}-01`
    const finPrev = new Date(yPrev, parseInt(mPrev), 0).toISOString().split('T')[0]

    const [{ data: ventas }, { data: ventasPrev }, { data: gastos }, { data: campanas }, { data: productos }, { data: entregas }] = await Promise.all([
      supabase.from('ventas').select('*').gte('fecha', inicio).lte('fecha', fin).order('fecha'),
      supabase.from('ventas').select('*').gte('fecha', inicioPrev).lte('fecha', finPrev),
      supabase.from('gastos').select('*').gte('fecha', inicio).lte('fecha', fin),
      supabase.from('campanas_ads').select('*').eq('mes', mes),
      supabase.from('productos').select('*').eq('activo', true),
      supabase.from('entregas').select('*').gte('fecha_entrega', inicio).lte('fecha_entrega', fin),
    ])

    const entregadas = (ventas || []).filter(v => v.estado === 'entregado')
    const pendientes = (ventas || []).filter(v => v.estado === 'pendiente')
    const devueltas = (ventas || []).filter(v => v.estado === 'devuelto')

    // Por producto (con tasa de devolución)
    const porProducto = {}
    ;(ventas || []).forEach(v => {
      if (!porProducto[v.producto_nombre]) porProducto[v.producto_nombre] = { nombre: v.producto_nombre, ventas: 0, entregados: 0, devueltos: 0, ingresos: 0 }
      porProducto[v.producto_nombre].ventas++
      if (v.estado === 'entregado') { porProducto[v.producto_nombre].entregados++; porProducto[v.producto_nombre].ingresos += (v.ganancia_neta || 0) }
      if (v.estado === 'devuelto') porProducto[v.producto_nombre].devueltos++
    })
    const porProductoArr = Object.values(porProducto).map(p => {
      const res = p.entregados + p.devueltos
      return { ...p, tasaDevolucion: res ? Math.round(p.devueltos / res * 100) : 0 }
    }).sort((a, b) => b.ingresos - a.ingresos)

    // Por día (para chart)
    const diasDelMes = new Date(year, parseInt(month), 0).getDate()
    const porDia = []
    for (let d = 1; d <= diasDelMes; d++) {
      const fechaStr = `${year}-${month}-${String(d).padStart(2, '0')}`
      const ventasDia = entregadas.filter(v => v.fecha === fechaStr)
      if (ventasDia.length > 0 || d <= new Date().getDate()) {
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
      tasaEntrega: (ventasPrev || []).length ? (entregadasPrev.length / (ventasPrev || []).length) * 100 : 0,
    }

    // ── Cobranza (de entregas del mes) ──
    const entItems = (entregas || [])
    const entEntregadas = entItems.filter(e => (e.categoria === 'entregado') || (e.estado_pap || '').toLowerCase().includes('entregado'))
    const rendidas = entEntregadas.filter(e => e.rendido)
    const sinRendir = entEntregadas.filter(e => !e.rendido)
    const diasRend = rendidas.map(e => e.dias_rendicion).filter(d => d != null && d >= 0)
    const cobranza = {
      cobrado: rendidas.reduce((s, e) => s + (e.importe || 0), 0),
      porCobrar: sinRendir.reduce((s, e) => s + (e.importe || 0), 0),
      nRendidas: rendidas.length, nSinRendir: sinRendir.length,
      tiempoCobro: diasRend.length ? diasRend.reduce((a, b) => a + b, 0) / diasRend.length : null,
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
    if (cobranza.porCobrar > 0) alertas.push({ tipo: 'cobranza', texto: `PaP te debe ${formatGs(cobranza.porCobrar)} de ${cobranza.nSinRendir} entregas. Reclamá las más viejas en Rendición.` })
    const peorDia = [...porDiaSemana].filter(d => d.total >= 3).sort((a, b) => b.devolucion - a.devolucion)[0]
    if (peorDia && peorDia.devolucion >= 45) alertas.push({ tipo: 'patron', texto: `Los pedidos del ${peorDia.dia} se devuelven ${peorDia.devolucion}%. Evaluá no despachar ese día o reforzar la confirmación.` })

    const sumE = (f) => entregadas.reduce((s, v) => s + (f(v) || 0), 0)
    const ventasBrutasCalc = sumE(v => v.total)                 // lo cobrado (entregadas) — ya incluye el envío
    const cogsEntregadas = sumE(v => v.costo_prod)              // costo de mercadería entregada
    const fleteEntregadas = sumE(v => v.costo_envio)            // flete pagado al courier (entregadas)
    // Ingreso neto de entregadas = total − costo prod − flete  (ya es ganancia_neta; el envío ya viene en total)
    const ingresosNetosCalc = sumE(v => v.ganancia_neta)
    // Tu regla: pendientes también generan costo de venta (mercadería que salió); devueltas NO
    const cogsPendientes = pendientes.reduce((s, v) => s + (v.costo_prod || 0), 0)
    const costoVentaTotal = cogsEntregadas + cogsPendientes
    // Flete perdido: las devoluciones igual te cuestan el envío (COD)
    const fleteDevoluciones = devueltas.reduce((s, v) => s + (v.costo_envio || 0), 0)
    // Utilidad realizada (solo entregadas, correcta contablemente)
    const utilidadRealizada = ingresosNetosCalc - totalGastos - fleteDevoluciones
    // Utilidad según TU modelo: además resta el costo de la mercadería pendiente
    const utilidadNetaCalc = utilidadRealizada - cogsPendientes

    setDatos({
      mes, ventasBrutas: ventasBrutasCalc,
      ingresosNetos: ingresosNetosCalc,
      totalGastos, totalGastoAds, fleteDevoluciones,
      cogsEntregadas, cogsPendientes, costoVentaTotal, fleteEntregadas,
      // Margen real = ingreso neto / ventas brutas
      margenPct: ventasBrutasCalc ? (ingresosNetosCalc / ventasBrutasCalc) * 100 : 0,
      paquetesEnviados: (ventas || []).length,
      entregados: entregadas.length, devueltos: devueltas.length, pendientesCount: pendientes.length,
      tasaEntrega: (ventas || []).length ? (entregadas.length / (ventas || []).length) * 100 : 0,
      utilidadNeta: utilidadNetaCalc, utilidadRealizada,
      porProducto: porProductoArr,
      porDia, campanas: campanas || [],
      ventas: ventas || [],
      comparativa, cobranza, ciudades, porDiaSemana, motivos,
      clientesUnicos, recompradores, alertas,
    })
    setLoading(false)
  }, [mes])

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
        @page { size: A4 portrait; margin: 8mm; }
        html, body { background: #080808 !important; }
        body * { visibility: hidden !important; }
        #reporte-print, #reporte-print * { visibility: visible !important; }
        #reporte-print {
          position: absolute !important;
          left: 0 !important; top: 0 !important;
          width: 100% !important;
          margin: 0 !important; padding: 0 !important;
          background: #080808 !important;
        }
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

  const mesesDisponibles = []
  for (let i = 0; i < 6; i++) {
    const d = new Date(); d.setMonth(d.getMonth() - i)
    mesesDisponibles.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('es-PY', { month: 'long', year: 'numeric' }),
    })
  }

  const nombreMes = datos
    ? (() => { const [y, m] = datos.mes.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('es-PY', { month: 'long', year: 'numeric' }) })()
    : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reportes</h1>
          <p className="page-subtitle">Generá el reporte mensual completo en PDF</p>
        </div>
        <div className="page-actions">
          <select className="form-select" style={{ width: 'auto' }} value={mes}
            onChange={e => { setMes(e.target.value); setDatos(null) }}>
            {mesesDisponibles.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button className="btn btn-secondary" onClick={cargarDatos} disabled={loading}>
            {loading ? <Loader2 size={14} className="spinning" /> : <FileBarChart2 size={14} />}
            Generar reporte
          </button>
          {datos && (
            <button className="btn btn-primary" onClick={generarPDF} disabled={generandoPdf}>
              {generandoPdf ? <Loader2 size={14} className="spinning" /> : <Download size={14} />}
              Descargar PDF
            </button>
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
          <div style={{
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
                {nombreMes}
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
              { label: 'Costo de venta', value: formatGs(datos.costoVentaTotal), sub: 'Mercadería entreg. + pend.', color: 'var(--red)' },
              { label: 'Margen %', value: formatPct(datos.margenPct), sub: 'Ingreso neto / ventas', color: datos.margenPct > 40 ? 'var(--green)' : 'var(--yellow)' },
              { label: 'Utilidad neta', value: formatGs(datos.utilidadNeta), sub: 'Después de todo', color: datos.utilidadNeta > 0 ? 'var(--green)' : 'var(--red)' },
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
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
              Cómo se arma tu utilidad
            </div>
            <div style={{ padding: '6px 20px' }}>
              {[
                { l: 'Ingresos cobrados (entregadas, con envío)', v: datos.ventasBrutas, signo: '+' },
                { l: 'Costo de mercadería entregada', v: datos.cogsEntregadas, signo: '−' },
                { l: 'Flete pagado al courier (entregadas)', v: datos.fleteEntregadas, signo: '−' },
                { l: 'Costo de mercadería pendiente (no cobrada)', v: datos.cogsPendientes, signo: '−' },
                { l: 'Flete perdido en devoluciones', v: datos.fleteDevoluciones, signo: '−' },
                { l: 'Gastos del mes', v: datos.totalGastos, signo: '−' },
              ].filter(r => r.v !== undefined).map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{r.l}</span>
                  <span style={{ fontWeight: 600, color: r.signo === '−' ? 'var(--red)' : 'var(--text-primary)' }}>{r.signo} {formatGs(r.v)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0 10px', fontSize: 14 }}>
                <span style={{ fontWeight: 700 }}>Utilidad neta</span>
                <span style={{ fontWeight: 800, color: datos.utilidadNeta > 0 ? 'var(--green)' : 'var(--red)' }}>{formatGs(datos.utilidadNeta)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingBottom: 12, lineHeight: 1.5 }}>
                Nota: la utilidad resta el costo de la mercadería pendiente (tu criterio). Si mirás solo lo ya cobrado e ignorás las pendientes, la <b>utilidad realizada</b> del mes es {formatGs(datos.utilidadRealizada)}. La diferencia es mercadería que ya salió pero todavía no cobraste.
              </div>
            </div>
          </div>

          {/* Comparativa con mes anterior */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
              Comparativa vs mes anterior
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

          {/* Cobranza con PaP */}
          {datos.cobranza.hayCobranza && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <div className="kpi-card" style={{ borderLeft: '3px solid var(--green)' }}>
                <div className="kpi-label"><Truck size={11} /> Cobrado de PaP</div>
                <div className="kpi-value green" style={{ fontSize: 15 }}>{formatGs(datos.cobranza.cobrado)}</div>
                <div className="kpi-sub">{datos.cobranza.nRendidas} entregas rendidas</div>
              </div>
              <div className="kpi-card" style={{ borderLeft: '3px solid var(--yellow)' }}>
                <div className="kpi-label">PaP te debe</div>
                <div className="kpi-value" style={{ fontSize: 15, color: 'var(--yellow)' }}>{formatGs(datos.cobranza.porCobrar)}</div>
                <div className="kpi-sub">{datos.cobranza.nSinRendir} sin rendir</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Tiempo de cobro</div>
                <div className="kpi-value" style={{ fontSize: 15 }}>{datos.cobranza.tiempoCobro != null ? `${datos.cobranza.tiempoCobro.toFixed(1)} días` : '—'}</div>
                <div className="kpi-sub">Entrega → depósito</div>
              </div>
            </div>
          )}

          {/* Charts */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
            <div className="chart-card">
              <div className="chart-header">
                <span className="chart-title">Ventas diarias — {nombreMes}</span>
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
              <div className="chart-header"><span className="chart-title">Ventas por producto</span></div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={datos.porProducto} dataKey="ingresos" nameKey="nombre"
                    cx="50%" cy="50%" outerRadius={70} strokeWidth={0}>
                    {datos.porProducto.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={v => [formatGs(v)]}
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tabla por producto */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Detalle por producto</span>
            </div>
            <table>
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
                    <td style={{ fontWeight: 600 }}>{p.nombre}</td>
                    <td>{p.ventas}</td>
                    <td style={{ color: 'var(--green)' }}>{p.entregados}</td>
                    <td style={{ color: 'var(--red)' }}>{p.devueltos}</td>
                    <td>
                      <span style={{ color: (p.entregados/Math.max(p.ventas,1)) > 0.6 ? 'var(--green)' : 'var(--yellow)' }}>
                        {((p.entregados / Math.max(p.ventas, 1)) * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td style={{ fontWeight: 700, color: 'var(--green)' }}>{formatGs(p.ingresos)}</td>
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
            <table>
              <thead><tr><th>Ciudad</th><th>Pedidos</th><th>Entregados</th><th>Devueltos</th><th>Tasa entrega</th></tr></thead>
              <tbody>
                {datos.ciudades.slice(0, 12).map(c => (
                  <tr key={c.ciudad}>
                    <td style={{ fontWeight: 600 }}>{c.ciudad}</td>
                    <td>{c.pedidos}</td>
                    <td style={{ color: 'var(--green)' }}>{c.entregados}</td>
                    <td style={{ color: 'var(--red)' }}>{c.devueltos}</td>
                    <td><span style={{ fontWeight: 700, color: c.tasaEntrega > 60 ? 'var(--green)' : c.tasaEntrega > 40 ? 'var(--yellow)' : 'var(--red)' }}>{c.tasaEntrega}%</span></td>
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
              <table>
                <thead>
                  <tr>
                    <th>Campaña</th>
                    <th>Plataforma</th>
                    <th>Gasto</th>
                    <th>Ingresos</th>
                    <th>ROAS</th>
                    <th>ROI %</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.campanas.map(c => (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 500 }}>{c.nombre}</td>
                      <td><span className="badge badge-purple">{c.plataforma}</span></td>
                      <td style={{ color: 'var(--red)' }}>{formatGs(c.gasto)}</td>
                      <td style={{ color: 'var(--green)' }}>{formatGs(c.ingresos_atribuidos)}</td>
                      <td><span style={{ fontWeight: 700, color: parseFloat(c.roas) >= 2 ? 'var(--green)' : 'var(--yellow)' }}>{c.roas}x</span></td>
                      <td><span style={{ fontWeight: 700, color: parseFloat(c.roi_pct) > 0 ? 'var(--green)' : 'var(--red)' }}>{c.roi_pct}%</span></td>
                    </tr>
                  ))}
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
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, padding: '12px 0' }}>
            Facial Wellness · Ciudad del Este, Paraguay · Generado el {new Date().toLocaleDateString('es-PY', { day: '2-digit', month: 'long', year: 'numeric' })}
          </div>
        </div>
      )}
    </div>
  )
}
