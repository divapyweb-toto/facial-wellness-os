// src/pages/analytics/AnalyticsPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase, formatGs, formatPct } from '../../lib/supabase'
import { TrendingUp, TrendingDown, MapPin, BarChart3, Calendar, ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend, Cell
} from 'recharts'

function DeltaBadge({ actual, anterior, invertido = false }) {
  if (!anterior || anterior === 0) return <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>
  const delta = ((actual - anterior) / anterior) * 100
  const positivo = invertido ? delta < 0 : delta > 0
  const color = positivo ? 'var(--green)' : delta === 0 ? 'var(--text-muted)' : 'var(--red)'
  const Icon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus
  return (
    <span style={{ color, fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 2 }}>
      <Icon size={11} /> {Math.abs(delta).toFixed(1)}%
    </span>
  )
}

export default function AnalyticsPage() {
  const [loading, setLoading] = useState(true)
  const [mesMes, setMesMes] = useState(null)
  const [ciudades, setCiudades] = useState([])
  const [proyeccion, setProyeccion] = useState(null)
  const [historico, setHistorico] = useState([])
  const [activeTab, setActiveTab] = useState('comparativa')

  const cargar = useCallback(async () => {
    setLoading(true)

    const ahora = new Date()
    // Mes actual
    const inicioActual = new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString().split('T')[0]
    const finActual = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).toISOString().split('T')[0]
    // Mes anterior
    const inicioAnterior = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1).toISOString().split('T')[0]
    const finAnterior = new Date(ahora.getFullYear(), ahora.getMonth(), 0).toISOString().split('T')[0]

    const [{ data: vActual }, { data: vAnterior }, { data: vTodas }] = await Promise.all([
      supabase.from('ventas').select('*').gte('fecha', inicioActual).lte('fecha', finActual),
      supabase.from('ventas').select('*').gte('fecha', inicioAnterior).lte('fecha', finAnterior),
      supabase.from('ventas').select('*').order('fecha', { ascending: false }).limit(500),
    ])

    // ── Comparativa mes vs mes ──
    const calcMetricas = (ventas) => {
      const entregadas = ventas.filter(v => v.estado === 'entregado')
      const devueltas = ventas.filter(v => v.estado === 'devuelto')
      return {
        ventasBrutas: entregadas.reduce((s, v) => s + v.total, 0),
        ingresosNetos: entregadas.reduce((s, v) => s + v.ganancia_neta, 0),
        paquetes: ventas.length,
        entregados: entregadas.length,
        devueltos: devueltas.length,
        tasaEntrega: ventas.length ? Math.round(entregadas.length / ventas.length * 100) : 0,
        margenPct: entregadas.length ? entregadas.reduce((s, v) => s + parseFloat(v.margen_pct || 0), 0) / entregadas.length : 0,
        ticketPromedio: entregadas.length ? Math.round(entregadas.reduce((s, v) => s + v.total, 0) / entregadas.length) : 0,
      }
    }
    setMesMes({ actual: calcMetricas(vActual || []), anterior: calcMetricas(vAnterior || []) })

    // ── Ciudades ──
    const ciudadMap = {}
    ;(vTodas || []).forEach(v => {
      if (!v.ciudad) return
      if (!ciudadMap[v.ciudad]) ciudadMap[v.ciudad] = { ciudad: v.ciudad, pedidos: 0, entregados: 0, devueltos: 0, ingresos: 0 }
      ciudadMap[v.ciudad].pedidos++
      if (v.estado === 'entregado') { ciudadMap[v.ciudad].entregados++; ciudadMap[v.ciudad].ingresos += v.ganancia_neta }
      if (v.estado === 'devuelto') ciudadMap[v.ciudad].devueltos++
    })
    const ciudadesArr = Object.values(ciudadMap)
      .map(c => ({ ...c, tasaEntrega: Math.round(c.entregados / c.pedidos * 100) }))
      .sort((a, b) => b.pedidos - a.pedidos)
    setCiudades(ciudadesArr.slice(0, 20))

    // ── Histórico mensual (últimos 6 meses) para chart ──
    const mesesData = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1)
      const inicio = d.toISOString().split('T')[0]
      const fin = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0]
      const ventasMes = (vTodas || []).filter(v => v.fecha >= inicio && v.fecha <= fin)
      const entregadasMes = ventasMes.filter(v => v.estado === 'entregado')
      mesesData.push({
        mes: d.toLocaleDateString('es-PY', { month: 'short' }),
        ventas: entregadasMes.reduce((s, v) => s + v.total, 0),
        neto: entregadasMes.reduce((s, v) => s + v.ganancia_neta, 0),
        paquetes: ventasMes.length,
        tasa: ventasMes.length ? Math.round(entregadasMes.length / ventasMes.length * 100) : 0,
      })
    }
    setHistorico(mesesData)

    // ── Proyección 30 días ──
    const hace30 = new Date(); hace30.setDate(hace30.getDate() - 30)
    const hace60 = new Date(); hace60.setDate(hace60.getDate() - 60)
    const ultimos30 = (vTodas || []).filter(v => new Date(v.fecha) >= hace30)
    const prev30 = (vTodas || []).filter(v => new Date(v.fecha) >= hace60 && new Date(v.fecha) < hace30)

    const entUlt = ultimos30.filter(v => v.estado === 'entregado')
    const entPrev = prev30.filter(v => v.estado === 'entregado')

    const promedioVentasDia = entUlt.reduce((s, v) => s + v.total, 0) / 30
    const promedioNetoDia = entUlt.reduce((s, v) => s + v.ganancia_neta, 0) / 30
    const tendenciaVentas = prev30.length > 0
      ? ((entUlt.length - entPrev.length) / Math.max(entPrev.length, 1)) * 100
      : 0

    setProyeccion({
      ingresosEstimados: Math.round(promedioVentasDia * 30),
      netoEstimado: Math.round(promedioNetoDia * 30),
      pedidosEstimados: Math.round(ultimos30.length / 30 * 30),
      tendencia: tendenciaVentas,
      diarioPromedio: Math.round(promedioVentasDia),
      basadoEn: ultimos30.length,
    })

    setLoading(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const mesActual = new Date().toLocaleDateString('es-PY', { month: 'long' })
  const mesAnterior = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toLocaleDateString('es-PY', { month: 'long' })

  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 80, borderRadius: 10 }} />)}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-subtitle">Comparativa, mapa de ciudades y proyección</p>
        </div>
      </div>

      <div className="tabs" style={{ alignSelf: 'flex-start' }}>
        <button className={`tab ${activeTab === 'comparativa' ? 'active' : ''}`} onClick={() => setActiveTab('comparativa')}>
          Mes vs Mes
        </button>
        <button className={`tab ${activeTab === 'ciudades' ? 'active' : ''}`} onClick={() => setActiveTab('ciudades')}>
          Mapa ciudades
        </button>
        <button className={`tab ${activeTab === 'proyeccion' ? 'active' : ''}`} onClick={() => setActiveTab('proyeccion')}>
          Proyección 30d
        </button>
      </div>

      {/* ── TAB: Comparativa ── */}
      {activeTab === 'comparativa' && mesMes && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Tabla comparativa */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>
                {mesActual.charAt(0).toUpperCase() + mesActual.slice(1)} vs {mesAnterior}
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Métrica</th>
                    <th style={{ color: 'var(--accent)' }}>{mesActual.charAt(0).toUpperCase() + mesActual.slice(1)}</th>
                    <th>{mesAnterior.charAt(0).toUpperCase() + mesAnterior.slice(1)}</th>
                    <th>Variación</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Ventas brutas', actual: formatGs(mesMes.actual.ventasBrutas), anterior: formatGs(mesMes.anterior.ventasBrutas), av: mesMes.actual.ventasBrutas, ant: mesMes.anterior.ventasBrutas },
                    { label: 'Ingresos netos', actual: formatGs(mesMes.actual.ingresosNetos), anterior: formatGs(mesMes.anterior.ingresosNetos), av: mesMes.actual.ingresosNetos, ant: mesMes.anterior.ingresosNetos },
                    { label: 'Paquetes enviados', actual: mesMes.actual.paquetes, anterior: mesMes.anterior.paquetes, av: mesMes.actual.paquetes, ant: mesMes.anterior.paquetes },
                    { label: 'Tasa de entrega', actual: `${mesMes.actual.tasaEntrega}%`, anterior: `${mesMes.anterior.tasaEntrega}%`, av: mesMes.actual.tasaEntrega, ant: mesMes.anterior.tasaEntrega },
                    { label: 'Devoluciones', actual: mesMes.actual.devueltos, anterior: mesMes.anterior.devueltos, av: mesMes.actual.devueltos, ant: mesMes.anterior.devueltos, invertido: true },
                    { label: 'Margen promedio', actual: `${mesMes.actual.margenPct.toFixed(1)}%`, anterior: `${mesMes.anterior.margenPct.toFixed(1)}%`, av: mesMes.actual.margenPct, ant: mesMes.anterior.margenPct },
                    { label: 'Ticket promedio', actual: formatGs(mesMes.actual.ticketPromedio), anterior: formatGs(mesMes.anterior.ticketPromedio), av: mesMes.actual.ticketPromedio, ant: mesMes.anterior.ticketPromedio },
                  ].map((row, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 500 }}>{row.label}</td>
                      <td style={{ fontWeight: 700, color: 'var(--accent)' }}>{row.actual}</td>
                      <td className="muted">{row.anterior}</td>
                      <td><DeltaBadge actual={row.av} anterior={row.ant} invertido={row.invertido} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Chart histórico 6 meses */}
          <div className="chart-card">
            <div className="chart-header">
              <span className="chart-title">Evolución 6 meses</span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={historico} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="mes" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                  tickFormatter={v => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : `${(v/1000).toFixed(0)}k`} />
                <Tooltip formatter={(v, n) => [formatGs(v), n]} contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="ventas" name="Ventas brutas" fill="var(--accent)" opacity={0.85} radius={[3,3,0,0]} />
                <Bar dataKey="neto" name="Ingresos netos" fill="var(--green)" opacity={0.8} radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── TAB: Ciudades ── */}
      {activeTab === 'ciudades' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Chart horizontal */}
          <div className="chart-card">
            <div className="chart-header">
              <span className="chart-title">Top ciudades por pedidos</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Todos los tiempos</span>
            </div>
            <ResponsiveContainer width="100%" height={Math.max(200, ciudades.slice(0, 10).length * 28)}>
              <BarChart data={ciudades.slice(0, 10)} layout="vertical" margin={{ top: 0, right: 10, left: 80, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="ciudad" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} axisLine={false} tickLine={false} width={75} />
                <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                  formatter={(v, n) => [v, n === 'entregados' ? 'Entregados' : n === 'devueltos' ? 'Devueltos' : 'Pedidos']} />
                <Bar dataKey="entregados" name="Entregados" fill="var(--green)" opacity={0.85} radius={[0,3,3,0]} stackId="a" />
                <Bar dataKey="devueltos" name="Devueltos" fill="var(--red)" opacity={0.7} radius={[0,3,3,0]} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Tabla ciudades */}
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Ciudad</th>
                  <th>Pedidos</th>
                  <th>Entregados</th>
                  <th>Devueltos</th>
                  <th>Tasa entrega</th>
                  <th>Ingresos netos</th>
                </tr>
              </thead>
              <tbody>
                {ciudades.map((c, i) => (
                  <tr key={c.ciudad}>
                    <td className="muted">{i + 1}</td>
                    <td style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <MapPin size={12} color="var(--text-muted)" /> {c.ciudad}
                    </td>
                    <td>{c.pedidos}</td>
                    <td style={{ color: 'var(--green)', fontWeight: 600 }}>{c.entregados}</td>
                    <td style={{ color: 'var(--red)' }}>{c.devueltos}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 40, height: 4, background: 'var(--bg-hover)', borderRadius: 2 }}>
                          <div style={{ width: `${c.tasaEntrega}%`, height: '100%', borderRadius: 2, background: c.tasaEntrega > 60 ? 'var(--green)' : c.tasaEntrega > 40 ? 'var(--yellow)' : 'var(--red)' }} />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: c.tasaEntrega > 60 ? 'var(--green)' : c.tasaEntrega > 40 ? 'var(--yellow)' : 'var(--red)' }}>
                          {c.tasaEntrega}%
                        </span>
                      </div>
                    </td>
                    <td style={{ color: 'var(--green)', fontWeight: 600 }}>{formatGs(c.ingresos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── TAB: Proyección ── */}
      {activeTab === 'proyeccion' && proyeccion && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Header proyección */}
          <div style={{
            background: 'linear-gradient(135deg, var(--bg-card) 0%, rgba(200,241,53,0.05) 100%)',
            border: '1px solid rgba(200,241,53,0.2)', borderRadius: 12, padding: '20px 24px',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              Proyección próximos 30 días · Basada en {proyeccion.basadoEn} ventas reales
            </div>
            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color: 'var(--accent)', letterSpacing: '-0.02em' }}>
                  {formatGs(proyeccion.ingresosEstimados)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Ingresos proyectados</div>
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color: 'var(--green)', letterSpacing: '-0.02em' }}>
                  {formatGs(proyeccion.netoEstimado)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Neto proyectado</div>
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                  {proyeccion.pedidosEstimados}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Pedidos estimados</div>
              </div>
            </div>
          </div>

          {/* KPIs proyección */}
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label"><Calendar size={11} />Promedio diario</div>
              <div className="kpi-value accent">{formatGs(proyeccion.diarioPromedio)}</div>
              <div className="kpi-sub">Ventas por día (últimos 30d)</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label"><TrendingUp size={11} />Tendencia</div>
              <div className={`kpi-value ${proyeccion.tendencia > 0 ? 'green' : proyeccion.tendencia < 0 ? 'red' : ''}`}>
                {proyeccion.tendencia > 0 ? '+' : ''}{proyeccion.tendencia.toFixed(1)}%
              </div>
              <div className="kpi-sub">vs los 30 días anteriores</div>
            </div>
          </div>

          {/* Chart simulado de proyección */}
          <div className="chart-card">
            <div className="chart-header">
              <span className="chart-title">Proyección vs historial</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Basada en promedio móvil</span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={[
                ...historico,
                {
                  mes: 'Proy.',
                  ventas: proyeccion.ingresosEstimados,
                  neto: proyeccion.netoEstimado,
                  proyectado: true,
                }
              ]} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="mes" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                  tickFormatter={v => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : `${(v/1000).toFixed(0)}k`} />
                <Tooltip formatter={(v, n) => [formatGs(v), n]} contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="ventas" name="Ventas" stroke="var(--accent)" strokeWidth={2} dot={{ fill: 'var(--accent)', r: 4 }} strokeDasharray={(d) => d?.proyectado ? "5 5" : "0"} />
                <Line type="monotone" dataKey="neto" name="Neto" stroke="var(--green)" strokeWidth={2} dot={{ fill: 'var(--green)', r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="alert alert-info">
            <BarChart3 size={14} />
            <span>La proyección se calcula con el promedio de los últimos 30 días. No incluye estacionalidad ni campañas planificadas.</span>
          </div>
        </div>
      )}
    </div>
  )
}
