// src/pages/finanzas/FinanzasPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthContext'
import { useToast } from '../../lib/toast'
import { Plus, X, DollarSign, TrendingDown, TrendingUp, BarChart3 } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

const CATEGORIAS = ['Publicidad', 'Logística', 'Operativo', 'Personal', 'Impuestos', 'Otro']

function NuevoGastoModal({ onClose, onSaved }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    fecha: new Date().toISOString().split('T')[0],
    categoria: 'Publicidad',
    concepto: '',
    monto: '',
    mes: new Date().toISOString().substring(0, 7),
    presupuestado: '',
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.from('gastos').insert({
      ...form,
      monto: parseInt(form.monto),
      presupuestado: parseInt(form.presupuestado) || 0,
    })
    if (error) toast('Error al guardar', 'error')
    else { toast('Gasto registrado', 'success'); onSaved(); onClose() }
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Registrar gasto</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Fecha</label>
              <input className="form-input" type="date" value={form.fecha}
                onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="form-label">Categoría</label>
              <select className="form-select" value={form.categoria}
                onChange={e => setForm(f => ({ ...f, categoria: e.target.value }))}>
                {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Concepto *</label>
            <input className="form-input" placeholder="Ej: Meta Ads Mayo" value={form.concepto}
              onChange={e => setForm(f => ({ ...f, concepto: e.target.value }))} required />
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Monto real (Gs.) *</label>
              <input className="form-input" type="number" placeholder="1100000" value={form.monto}
                onChange={e => setForm(f => ({ ...f, monto: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="form-label">Presupuestado (Gs.)</label>
              <input className="form-input" type="number" placeholder="5000000" value={form.presupuestado}
                onChange={e => setForm(f => ({ ...f, presupuestado: e.target.value }))} />
            </div>
          </div>
          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Registrar gasto'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function FinanzasPage() {
  const { isAdmin } = useAuth()
  const [gastos, setGastos] = useState([])
  const [ventasPorMes, setVentasPorMes] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [filtroMes, setFiltroMes] = useState(new Date().toISOString().substring(0, 7))

  const cargar = useCallback(async () => {
    setLoading(true)
    const [year, month] = filtroMes.split('-')
    const inicio = `${year}-${month}-01`
    const fin = new Date(year, parseInt(month), 0).toISOString().split('T')[0]

    const [{ data: g }, { data: v }] = await Promise.all([
      supabase.from('gastos').select('*').gte('fecha', inicio).lte('fecha', fin).order('fecha', { ascending: false }),
      supabase.from('ventas').select('*').gte('fecha', inicio).lte('fecha', fin),
    ])

    setGastos(g || [])

    // Flujo diario para chart
    const diasDelMes = new Date(year, parseInt(month), 0).getDate()
    const diasData = []
    for (let d = 1; d <= diasDelMes; d++) {
      const fechaStr = `${year}-${month}-${String(d).padStart(2, '0')}`
      const ventasDia = (v || []).filter(x => x.fecha === fechaStr && x.estado === 'entregado')
      const gastosDia = (g || []).filter(x => x.fecha === fechaStr)
      diasData.push({
        dia: d,
        ingresos: ventasDia.reduce((s, x) => s + x.ganancia_neta, 0),
        gastos: gastosDia.reduce((s, x) => s + x.monto, 0),
      })
    }
    setVentasPorMes(diasData)
    setLoading(false)
  }, [filtroMes])

  useEffect(() => { cargar() }, [cargar])

  // KPIs del mes
  const totalGastos = gastos.reduce((s, g) => s + g.monto, 0)
  const totalPresupuestado = gastos.reduce((s, g) => s + (g.presupuestado || 0), 0)

  // Gastos por categoría
  const porCategoria = {}
  gastos.forEach(g => {
    if (!porCategoria[g.categoria]) porCategoria[g.categoria] = 0
    porCategoria[g.categoria] += g.monto
  })

  const mesesDisponibles = []
  for (let i = 0; i < 6; i++) {
    const d = new Date(); d.setMonth(d.getMonth() - i)
    mesesDisponibles.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('es-PY', { month: 'long', year: 'numeric' }),
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Finanzas</h1>
          <p className="page-subtitle">Control de gastos y flujo de caja</p>
        </div>
        <div className="page-actions">
          <select className="form-select" style={{ width: 'auto' }} value={filtroMes}
            onChange={e => setFiltroMes(e.target.value)}>
            {mesesDisponibles.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            <Plus size={15} /> Registrar gasto
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label"><TrendingDown size={12} />Total gastos</div>
          <div className="kpi-value red">{formatGs(totalGastos)}</div>
          <div className="kpi-sub">Gastos del mes</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><BarChart3 size={12} />Vs. presupuesto</div>
          <div className={`kpi-value ${totalGastos <= totalPresupuestado ? 'green' : 'red'}`}>
            {totalPresupuestado > 0 ? `${Math.round((totalGastos/totalPresupuestado)*100)}%` : '—'}
          </div>
          <div className="kpi-sub">
            {totalPresupuestado > 0 ? `Ppto: ${formatGs(totalPresupuestado)}` : 'Sin presupuesto'}
          </div>
        </div>
      </div>

      {/* Resumen por categoría */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Por categoría</h3>
          {Object.keys(porCategoria).length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Sin gastos registrados</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).map(([cat, monto]) => (
                <div key={cat}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{cat}</span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{formatGs(monto)}</span>
                  </div>
                  <div style={{ background: 'var(--bg-hover)', borderRadius: 3, height: 4 }}>
                    <div style={{
                      width: `${(monto / totalGastos) * 100}%`, height: '100%',
                      background: 'var(--accent)', borderRadius: 3,
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="chart-card">
          <div className="chart-header">
            <span className="chart-title">Flujo diario del mes</span>
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={ventasPorMes.filter(d => d.ingresos > 0 || d.gastos > 0)} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="dia" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                tickFormatter={v => `${(v/1000000).toFixed(1)}M`} />
              <Tooltip
                formatter={(v, n) => [formatGs(v), n === 'ingresos' ? 'Ingresos' : 'Gastos']}
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }} />
              <Bar dataKey="ingresos" fill="var(--green)" opacity={0.8} radius={[2, 2, 0, 0]} />
              <Bar dataKey="gastos" fill="var(--red)" opacity={0.7} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Tabla gastos */}
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Categoría</th>
              <th>Concepto</th>
              <th>Monto real</th>
              <th>Presupuestado</th>
              <th>Diferencia</th>
            </tr>
          </thead>
          <tbody>
            {gastos.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                Sin gastos registrados este mes
              </td></tr>
            ) : gastos.map(g => {
              const dif = g.presupuestado ? g.presupuestado - g.monto : null
              return (
                <tr key={g.id}>
                  <td className="muted">{new Date(g.fecha + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}</td>
                  <td><span className="badge badge-gray">{g.categoria}</span></td>
                  <td style={{ fontWeight: 500 }}>{g.concepto}</td>
                  <td style={{ color: 'var(--red)', fontWeight: 600 }}>{formatGs(g.monto)}</td>
                  <td className="muted">{g.presupuestado ? formatGs(g.presupuestado) : '—'}</td>
                  <td style={{ color: dif !== null ? (dif >= 0 ? 'var(--green)' : 'var(--red)') : undefined, fontWeight: 500 }}>
                    {dif !== null ? `${dif >= 0 ? '+' : ''}${formatGs(dif)}` : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {showModal && <NuevoGastoModal onClose={() => setShowModal(false)} onSaved={cargar} />}
    </div>
  )
}
