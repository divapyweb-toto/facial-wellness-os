// src/pages/reportes/ReportesPage.jsx
import { useState, useCallback, useRef } from 'react'
import { supabase, formatGs, formatPct } from '../../lib/supabase'
import { FileBarChart2, Download, Loader2 } from 'lucide-react'
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts'

const COLORS = ['#c8f135', '#22c55e', '#3b82f6', '#a78bfa', '#f59e0b', '#ef4444', '#ec4899']

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

    const [{ data: ventas }, { data: gastos }, { data: campanas }, { data: productos }] = await Promise.all([
      supabase.from('ventas').select('*').gte('fecha', inicio).lte('fecha', fin).order('fecha'),
      supabase.from('gastos').select('*').gte('fecha', inicio).lte('fecha', fin),
      supabase.from('campanas_ads').select('*').eq('mes', mes),
      supabase.from('productos').select('*').eq('activo', true),
    ])

    const entregadas = (ventas || []).filter(v => v.estado === 'entregado')
    const pendientes = (ventas || []).filter(v => v.estado === 'pendiente')
    const devueltas = (ventas || []).filter(v => v.estado === 'devuelto')

    // Por producto
    const porProducto = {}
    ;(ventas || []).forEach(v => {
      if (!porProducto[v.producto_nombre]) porProducto[v.producto_nombre] = { nombre: v.producto_nombre, ventas: 0, entregados: 0, devueltos: 0, ingresos: 0 }
      porProducto[v.producto_nombre].ventas++
      if (v.estado === 'entregado') { porProducto[v.producto_nombre].entregados++; porProducto[v.producto_nombre].ingresos += v.ganancia_neta }
      if (v.estado === 'devuelto') porProducto[v.producto_nombre].devueltos++
    })

    // Por día (para chart)
    const diasDelMes = new Date(year, parseInt(month), 0).getDate()
    const porDia = []
    for (let d = 1; d <= diasDelMes; d++) {
      const fechaStr = `${year}-${month}-${String(d).padStart(2, '0')}`
      const ventasDia = entregadas.filter(v => v.fecha === fechaStr)
      if (ventasDia.length > 0 || d <= new Date().getDate()) {
        porDia.push({
          dia: d,
          ventas: ventasDia.reduce((s, v) => s + v.total, 0),
          neto: ventasDia.reduce((s, v) => s + v.ganancia_neta, 0),
          cantidad: ventasDia.length,
        })
      }
    }

    const totalGastos = (gastos || []).reduce((s, g) => s + g.monto, 0)
    const totalGastoAds = (campanas || []).reduce((s, c) => s + c.gasto, 0)

    setDatos({
      mes, ventasBrutas: entregadas.reduce((s, v) => s + v.total, 0),
      ingresosNetos: entregadas.reduce((s, v) => s + v.ganancia_neta, 0),
      totalGastos, totalGastoAds,
      margenPct: entregadas.length ? entregadas.reduce((s, v) => s + parseFloat(v.margen_pct), 0) / entregadas.length : 0,
      paquetesEnviados: (ventas || []).length,
      entregados: entregadas.length, devueltos: devueltas.length, pendientesCount: pendientes.length,
      tasaEntrega: (ventas || []).length ? (entregadas.length / (ventas || []).length) * 100 : 0,
      utilidadNeta: entregadas.reduce((s, v) => s + v.ganancia_neta, 0) - totalGastos,
      porProducto: Object.values(porProducto).sort((a, b) => b.ingresos - a.ingresos),
      porDia, campanas: campanas || [],
      ventas: ventas || [],
    })
    setLoading(false)
  }, [mes])

  const generarPDF = async () => {
    if (!datos) return
    setGenerandoPdf(true)

    try {
      const { default: jsPDF } = await import('jspdf')
      const { default: html2canvas } = await import('html2canvas')

      const element = reportRef.current
      const canvas = await html2canvas(element, {
        backgroundColor: '#080808',
        scale: 1.5,
        useCORS: true,
        allowTaint: true,
      })

      const imgData = canvas.toDataURL('image/png')
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const imgWidth = pageWidth
      const imgHeight = (canvas.height * imgWidth) / canvas.width

      let heightLeft = imgHeight
      let position = 0

      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight)
      heightLeft -= pageHeight

      while (heightLeft >= 0) {
        position -= pageHeight
        pdf.addPage()
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight)
        heightLeft -= pageHeight
      }

      const nombreMes = new Date(datos.mes + '-01').toLocaleDateString('es-PY', { month: 'long', year: 'numeric' })
      pdf.save(`facial-wellness-reporte-${datos.mes}.pdf`)
    } catch (e) {
      console.error(e)
    }
    setGenerandoPdf(false)
  }

  const mesesDisponibles = []
  for (let i = 0; i < 6; i++) {
    const d = new Date(); d.setMonth(d.getMonth() - i)
    mesesDisponibles.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('es-PY', { month: 'long', year: 'numeric' }),
    })
  }

  const nombreMes = datos ? new Date(datos.mes + '-01').toLocaleDateString('es-PY', { month: 'long', year: 'numeric' }) : ''

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
        <div ref={reportRef} style={{ display: 'flex', flexDirection: 'column', gap: 20, background: 'var(--bg-base)', padding: 8 }}>
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
              { label: 'Ventas brutas', value: formatGs(datos.ventasBrutas), sub: 'Solo entregadas', color: 'var(--text-primary)' },
              { label: 'Ingresos netos', value: formatGs(datos.ingresosNetos), sub: 'Después de envíos', color: 'var(--green)' },
              { label: 'Margen %', value: formatPct(datos.margenPct), sub: 'Promedio del mes', color: datos.margenPct > 40 ? 'var(--green)' : 'var(--yellow)' },
              { label: 'Utilidad neta', value: formatGs(datos.utilidadNeta), sub: 'Ingresos - Gastos', color: datos.utilidadNeta > 0 ? 'var(--green)' : 'var(--red)' },
              { label: 'Paquetes enviados', value: datos.paquetesEnviados, sub: `${datos.entregados} entregados`, color: 'var(--text-primary)' },
              { label: 'Devoluciones', value: datos.devueltos, sub: `${((datos.devueltos/Math.max(datos.paquetesEnviados,1))*100).toFixed(1)}% del total`, color: datos.devueltos > 10 ? 'var(--red)' : 'var(--yellow)' },
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

          {/* Footer del reporte */}
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, padding: '12px 0' }}>
            Facial Wellness · Ciudad del Este, Paraguay · Generado el {new Date().toLocaleDateString('es-PY', { day: '2-digit', month: 'long', year: 'numeric' })}
          </div>
        </div>
      )}
    </div>
  )
}
