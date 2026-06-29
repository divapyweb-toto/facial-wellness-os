// src/pages/dashboard/DashboardPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, formatGs, formatPct } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthContext'
import { useToast } from '../../lib/toast'
import CountUp from '../../lib/CountUp'
import {
  TrendingUp, Package, Truck, AlertTriangle, Plus,
  DollarSign, BarChart3, RefreshCw, Banknote, Edit3,
  CheckCircle2, XCircle, Clock, ArrowUpRight, History, X, Target
} from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from 'recharts'

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>{label}</p>
        {payload.map((p, i) => (
          <p key={i} style={{ color: p.color, fontWeight: 600 }}>{p.name}: {formatGs(p.value)}</p>
        ))}
      </div>
    )
  }
  return null
}

// Modal saldo banco
function SaldoModal({ onClose, onSaved }) {
  const { toast } = useToast()
  const [historial, setHistorial] = useState([])
  const [monto, setMonto] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase.from('saldo_banco').select('*').order('created_at', { ascending: false }).limit(10)
      .then(({ data }) => setHistorial(data || []))
  }, [])

  const handleGuardar = async (e) => {
    e.preventDefault()
    if (!monto) return
    setLoading(true)
    const montoLimpio = parseInt(monto.replace(/\D/g, ''))
    const { error } = await supabase.from('saldo_banco').insert({
      monto: montoLimpio,
      descripcion: descripcion || 'Actualización manual',
    })
    if (error) toast('Error: ' + error.message, 'error')
    else {
      toast('Saldo registrado', 'success')
      onSaved()
      onClose()
    }
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Saldo en cuenta bancaria</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        <form onSubmit={handleGuardar} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Monto actual en cuenta (Gs.) *</label>
            <input
              className="form-input"
              type="number"
              placeholder="Ej: 3.000.000"
              value={monto}
              onChange={e => setMonto(e.target.value)}
              required autoFocus
              style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18 }}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Descripción (opcional)</label>
            <input className="form-input" placeholder="Ej: Después de rendición semana 3" value={descripcion} onChange={e => setDescripcion(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading} style={{ justifyContent: 'center' }}>
            {loading ? 'Guardando...' : 'Guardar saldo'}
          </button>
        </form>

        {historial.length > 0 && (
          <>
            <div className="divider" />
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
              Historial reciente
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {historial.map((s, i) => (
                <div key={s.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', background: i === 0 ? 'var(--accent-dim)' : 'var(--bg-hover)',
                  borderRadius: 6, border: i === 0 ? '1px solid rgba(200,241,53,0.2)' : 'none',
                }}>
                  <div>
                    <div style={{ fontWeight: 700, color: i === 0 ? 'var(--accent)' : 'var(--text-primary)', fontSize: 14 }}>
                      {formatGs(s.monto)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {new Date(s.created_at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short', year: 'numeric' })}
                      {s.descripcion ? ` · ${s.descripcion}` : ''}
                    </div>
                  </div>
                  {i === 0 && <span className="badge badge-accent">Actual</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { profile, isAdmin } = useAuth()
  const navigate = useNavigate()
  const [kpis, setKpis] = useState(null)
  const [alertas, setAlertas] = useState([])
  const [chartData, setChartData] = useState([])
  const [topProductos, setTopProductos] = useState([])
  const [saldoBanco, setSaldoBanco] = useState(null)
  const [showSaldoModal, setShowSaldoModal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [ventasRecientes, setVentasRecientes] = useState([])

  const cargarDatos = useCallback(async () => {
    setLoading(true)
    const ahora = new Date()
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString().split('T')[0]
    const finMes = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).toISOString().split('T')[0]

    const { data: ventasMes } = await supabase
      .from('ventas').select('*').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', finMes)

    // Gastos del mes (costo fijo para el punto de equilibrio)
    const { data: gastosMes } = await supabase
      .from('gastos').select('monto').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', finMes)
    const totalGastosMes = (gastosMes || []).reduce((s, g) => s + (g.monto || 0), 0)

    if (ventasMes) {
      const entregadas = ventasMes.filter(v => v.estado === 'entregado')
      const pendientes = ventasMes.filter(v => v.estado === 'pendiente')
      const devueltas = ventasMes.filter(v => v.estado === 'devuelto')
      const vbruto = entregadas.reduce((s, v) => s + v.total, 0)
      const ineto = entregadas.reduce((s, v) => s + v.ganancia_neta, 0)

      // ── Punto de equilibrio en vivo ──
      // Margen neto promedio por venta entregada
      const margenPromedio = entregadas.length ? ineto / entregadas.length : 0
      // Ganancia del mes después de cubrir gastos fijos
      const gananciaReal = ineto - totalGastosMes
      // ¿Cuántas ventas más faltan para cubrir los gastos? (si todavía no se cubrieron)
      const faltaParaCubrir = (gananciaReal < 0 && margenPromedio > 0)
        ? Math.ceil(Math.abs(gananciaReal) / margenPromedio)
        : 0

      setKpis({
        ventasBrutas: vbruto,
        ingresosNetos: ineto,
        // Margen real ponderado (incluye flete) — consistente con Reportes
        margenPct: vbruto ? (ineto / vbruto) * 100 : 0,
        paquetesEnviados: ventasMes.length,
        entregados: entregadas.length,
        devueltos: devueltas.length,
        pendientesCount: pendientes.length,
        tasaEntrega: ventasMes.length ? (entregadas.length / ventasMes.length * 100) : 0,
        // Punto de equilibrio
        gastosMes: totalGastosMes,
        margenPromedio,
        gananciaReal,
        faltaParaCubrir,
        cubierto: gananciaReal >= 0,
      })
    }

    // Saldo banco
    const { data: saldo } = await supabase
      .from('saldo_banco').select('*').order('created_at', { ascending: false }).limit(1).single()
    setSaldoBanco(saldo)

    // Chart 7 días
    const hace7 = new Date(); hace7.setDate(hace7.getDate() - 6)
    const { data: ventasChart } = await supabase
      .from('ventas').select('fecha, total, estado, ganancia_neta')
      .gte('fecha', hace7.toISOString().split('T')[0]).order('fecha')

    if (ventasChart) {
      const porDia = {}
      for (let i = 0; i < 7; i++) {
        const d = new Date(); d.setDate(d.getDate() - (6 - i))
        const key = d.toISOString().split('T')[0]
        const label = d.toLocaleDateString('es-PY', { weekday: 'short', day: 'numeric' })
        porDia[key] = { fecha: label, ventas: 0, neto: 0 }
      }
      ventasChart.forEach(v => {
        if (porDia[v.fecha] && v.estado === 'entregado') {
          porDia[v.fecha].ventas += v.total
          porDia[v.fecha].neto += v.ganancia_neta
        }
      })
      setChartData(Object.values(porDia))
    }

    // Top productos
    const { data: topProds } = await supabase
      .from('ventas').select('producto_nombre, total, ganancia_neta, estado, cantidad')
      .gte('fecha', inicioMes).lte('fecha', finMes).eq('estado', 'entregado')
    if (topProds) {
      const agrupado = {}
      topProds.forEach(v => {
        if (!agrupado[v.producto_nombre]) agrupado[v.producto_nombre] = { nombre: v.producto_nombre, ventas: 0, ingresos: 0 }
        agrupado[v.producto_nombre].ventas += v.cantidad
        agrupado[v.producto_nombre].ingresos += v.ganancia_neta
      })
      setTopProductos(Object.values(agrupado).sort((a, b) => b.ingresos - a.ingresos).slice(0, 5))
    }

    // Alertas
    const alertasActivas = []
    const { data: todosProds } = await supabase.from('productos')
      .select('id, nombre, stock_actual, stock_alerta, es_combo, componente_1_id, componente_1_qty, componente_2_id, componente_2_qty')
      .eq('activo', true)
    if (todosProds) {
      const porId = todosProds.reduce((a, p) => { a[p.id] = p; return a }, {})
      // Stock real considerando combos (combo = mínimo de sus componentes disponibles)
      const stockReal = (p) => {
        if (!p.es_combo) return p.stock_actual
        const disp = []
        const c1 = porId[p.componente_1_id], c2 = porId[p.componente_2_id]
        if (c1) disp.push(Math.floor((c1.stock_actual || 0) / (p.componente_1_qty || 1)))
        if (c2) disp.push(Math.floor((c2.stock_actual || 0) / (p.componente_2_qty || 1)))
        return disp.length ? Math.min(...disp) : 0
      }
      todosProds
        .filter(p => stockReal(p) <= p.stock_alerta)
        .forEach(p => {
          const s = stockReal(p)
          alertasActivas.push({
            tipo: 'stock', color: 'red',
            msg: p.es_combo
              ? `Stock bajo: ${p.nombre} — ${s} armables`
              : `Stock bajo: ${p.nombre} — ${s} uds`,
          })
        })
    }
    const hace5 = new Date(); hace5.setDate(hace5.getDate() - 5)
    const { data: viejos } = await supabase.from('ventas').select('id').eq('estado', 'pendiente').lt('fecha', hace5.toISOString().split('T')[0])
    if (viejos?.length) alertasActivas.push({ tipo: 'pendiente', color: 'yellow', msg: `${viejos.length} pedido(s) pendiente(s) con más de 5 días sin resolver` })
    setAlertas(alertasActivas)

    // Ventas recientes
    const { data: recientes } = await supabase.from('ventas').select('*').order('created_at', { ascending: false }).limit(8)
    setVentasRecientes(recientes || [])

    setLoading(false)
  }, [])

  useEffect(() => {
    cargarDatos()
    const channel = supabase.channel('dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ventas' }, cargarDatos)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [cargarDatos])

  const estadoBadge = {
    pendiente: <span className="badge badge-yellow">Pendiente</span>,
    entregado: <span className="badge badge-green">Entregado</span>,
    devuelto: <span className="badge badge-red">Devuelto</span>,
    en_tramite: <span className="badge badge-purple">En trámite</span>,
  }

  if (loading) return (
    <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
      {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 80, borderRadius: 10 }} />)}
    </div>
  )

  const mesActual = new Date().toLocaleDateString('es-PY', { month: 'long', year: 'numeric' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Hola, {profile?.nombre?.split(' ')[0] || 'Enrique'} 👋</h1>
          <p className="page-subtitle">{mesActual.charAt(0).toUpperCase() + mesActual.slice(1)}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-sm" onClick={cargarDatos}><RefreshCw size={13} /></button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/ventas')}>
            <Plus size={14} /> Nueva venta
          </button>
        </div>
      </div>

      {/* Alertas */}
      {alertas.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {alertas.map((a, i) => (
            <div key={i} className={`alert alert-${a.color === 'red' ? 'error' : 'warning'}`}>
              <AlertTriangle size={14} />
              <span style={{ flex: 1 }}>{a.msg}</span>
              {a.tipo === 'stock' && (
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/stock')}>Ver</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Saldo banco — tarjeta especial */}
      <div
        className="saldo-card"
        style={{ cursor: 'pointer' }}
        onClick={() => setShowSaldoModal(true)}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 32, height: 32, background: 'var(--accent-dim)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Banknote size={16} color="var(--accent)" />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Saldo en banco</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, color: saldoBanco ? 'var(--accent)' : 'var(--text-muted)', letterSpacing: '-0.02em' }}>
                {saldoBanco ? formatGs(saldoBanco.monto) : 'Sin registrar'}
              </div>
              {saldoBanco && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
                  Actualizado {new Date(saldoBanco.created_at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Edit3 size={11} /> Actualizar
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <History size={10} /> Ver historial
            </span>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label"><TrendingUp size={11} />Ventas brutas</div>
          <div className="kpi-value"><CountUp value={kpis?.ventasBrutas || 0} format={formatGs} /></div>
          <div className="kpi-sub">Solo entregadas</div>
          <div className="kpi-icon" style={{ background: 'var(--green-dim)' }}><TrendingUp size={14} color="var(--green)" /></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><DollarSign size={11} />Ingresos netos</div>
          <div className="kpi-value green"><CountUp value={kpis?.ingresosNetos || 0} format={formatGs} /></div>
          <div className="kpi-sub">Después de envíos</div>
          <div className="kpi-icon" style={{ background: 'var(--green-dim)' }}><DollarSign size={14} color="var(--green)" /></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><BarChart3 size={11} />Margen %</div>
          <div className={`kpi-value ${(kpis?.margenPct || 0) > 40 ? 'green' : 'yellow'}`}>{formatPct(kpis?.margenPct || 0)}</div>
          <div className="kpi-sub">Sobre entregadas (real)</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Package size={11} />Enviados</div>
          <div className="kpi-value">{kpis?.paquetesEnviados || 0}</div>
          <div className="kpi-sub">{kpis?.entregados || 0} entregados · {kpis?.devueltos || 0} devueltos</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Truck size={11} />Tasa entrega</div>
          <div className={`kpi-value ${(kpis?.tasaEntrega || 0) > 60 ? 'green' : (kpis?.tasaEntrega || 0) > 40 ? 'yellow' : 'red'}`}>
            {formatPct(kpis?.tasaEntrega || 0)}
          </div>
          <div className="kpi-sub" style={{ color: (kpis?.pendientesCount || 0) > 0 ? 'var(--yellow)' : undefined }}>
            {kpis?.pendientesCount || 0} pendientes
          </div>
        </div>
      </div>

      {/* Punto de equilibrio en vivo */}
      {kpis && (kpis.gastosMes > 0 || kpis.entregados > 0) && (
        <div className="card" style={{ padding: '16px 18px', border: '1px solid var(--border)', background: kpis.cubierto ? 'linear-gradient(135deg, var(--green-dim), transparent)' : 'var(--bg-card)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Target size={15} color={kpis.cubierto ? 'var(--green)' : 'var(--accent)'} />
            <span style={{ fontWeight: 700, fontSize: 14 }}>Punto de equilibrio del mes</span>
          </div>
          {kpis.cubierto ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <CheckCircle2 size={18} color="var(--green)" />
                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)' }}>¡Gastos cubiertos!</span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Ganancia real: <strong style={{ color: 'var(--green)' }}>{formatGs(kpis.gananciaReal)}</strong>
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                Cubriste {formatGs(kpis.gastosMes)} de gastos. Cada venta nueva (~{formatGs(Math.round(kpis.margenPromedio))} de margen) es ganancia limpia.
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 28, fontFamily: 'var(--font-display)', fontWeight: 800, color: 'var(--accent)' }}>
                  {kpis.faltaParaCubrir}
                </span>
                <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                  venta{kpis.faltaParaCubrir !== 1 ? 's' : ''} más para cubrir el mes
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                  <span>Cubierto: {formatGs(kpis.ingresosNetos)}</span>
                  <span>Meta: {formatGs(kpis.gastosMes)}</span>
                </div>
                <div style={{ height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, kpis.gastosMes ? (kpis.ingresosNetos / kpis.gastosMes) * 100 : 0)}%`, height: '100%', background: 'var(--accent)', borderRadius: 4, transition: 'width 0.6s ease' }} />
                </div>
              </div>
              {kpis.margenPromedio > 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                  A ~{formatGs(Math.round(kpis.margenPromedio))} de margen por venta. Te faltan {formatGs(Math.abs(kpis.gananciaReal))}.
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="chart-card">
        <div className="chart-header">
          <span className="chart-title">Últimos 7 días</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Solo entregadas</span>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gV" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gN" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--green)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="var(--green)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="fecha" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
              tickFormatter={v => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : v >= 1000 ? `${(v/1000).toFixed(0)}k` : v} />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="ventas" name="Ventas" stroke="var(--accent)" fill="url(#gV)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="neto" name="Neto" stroke="var(--green)" fill="url(#gN)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Top productos */}
      {topProductos.length > 0 && (
        <div className="card card-sm">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Top productos — este mes</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {topProductos.map((p, i) => {
              const maxIngresos = topProductos[0]?.ingresos || 1
              const pct = (p.ingresos / maxIngresos) * 100
              return (
                <div key={i}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{p.nombre}</span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{p.ventas} uds · {formatGs(p.ingresos)}</span>
                  </div>
                  <div style={{ background: 'var(--bg-hover)', borderRadius: 3, height: 4 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: i === 0 ? 'var(--accent)' : 'var(--green)', borderRadius: 3, transition: 'width 0.6s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Ventas recientes */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Ventas recientes</span>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/ventas')}>
            Ver todas <ArrowUpRight size={11} />
          </button>
        </div>
        {ventasRecientes.length === 0 ? (
          <div className="empty-state" style={{ padding: 32 }}>
            <div className="empty-state-icon"><Package size={20} /></div>
            <p className="empty-state-title">Sin ventas aún</p>
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/ventas')}>
              <Plus size={12} /> Nueva venta
            </button>
          </div>
        ) : (
          <>
            {/* Desktop: tabla */}
            <div className="desktop-only" style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: 500 }}>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Producto</th>
                    <th>Total</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {ventasRecientes.map(v => (
                    <tr key={v.id}>
                      <td className="muted" style={{ fontSize: 12 }}>{new Date(v.fecha + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}</td>
                      <td style={{ fontWeight: 500, fontSize: 12 }}>{v.producto_nombre}</td>
                      <td style={{ fontWeight: 600, fontSize: 12 }}>{formatGs(v.total)}</td>
                      <td>{estadoBadge[v.estado]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Móvil: filas compactas */}
            <div className="mobile-only" style={{ display: 'flex', flexDirection: 'column' }}>
              {ventasRecientes.map((v, i) => (
                <div
                  key={v.id}
                  onClick={() => navigate('/ventas')}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                    padding: '12px 16px',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.producto_nombre}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {new Date(v.fecha + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-display)' }}>{formatGs(v.total)}</span>
                    {estadoBadge[v.estado]}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {showSaldoModal && <SaldoModal onClose={() => setShowSaldoModal(false)} onSaved={cargarDatos} />}
    </div>
  )
}
