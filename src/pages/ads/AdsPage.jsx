// src/pages/ads/AdsPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase, formatGs, formatPct } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { logError } from '../../lib/errorLog'
import { Plus, X, Megaphone, TrendingUp, Target, DollarSign, Edit2, Trash2, Save } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'

function CampanaModal({ campana, onClose, onSaved }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const esEdicion = !!campana
  const [form, setForm] = useState(campana ? {
    mes: campana.mes || new Date().toISOString().substring(0, 7),
    plataforma: campana.plataforma || 'Meta Ads',
    nombre: campana.nombre || '',
    fecha_inicio: campana.fecha_inicio || new Date().toISOString().split('T')[0],
    gasto: campana.gasto ?? '',
    ingresos_atribuidos: campana.ingresos_atribuidos ?? '',
    ventas_generadas: campana.ventas_generadas ?? '',
    observaciones: campana.observaciones || '',
  } : {
    mes: new Date().toISOString().substring(0, 7),
    plataforma: 'Meta Ads',
    nombre: '',
    fecha_inicio: new Date().toISOString().split('T')[0],
    gasto: '',
    ingresos_atribuidos: '',
    ventas_generadas: '',
    observaciones: '',
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    const payload = {
      ...form,
      gasto: parseInt(form.gasto) || 0,
      ingresos_atribuidos: parseInt(form.ingresos_atribuidos) || 0,
      ventas_generadas: parseInt(form.ventas_generadas) || 0,
    }
    const { error } = esEdicion
      ? await supabase.from('campanas_ads').update(payload).eq('id', campana.id)
      : await supabase.from('campanas_ads').insert(payload)
    if (error) toast('Error al guardar', 'error')
    else { toast(esEdicion ? 'Campaña actualizada' : 'Campaña registrada', 'success'); onSaved(); onClose() }
    setLoading(false)
  }

  const roas = form.gasto && form.ingresos_atribuidos
    ? (parseInt(form.ingresos_atribuidos) / parseInt(form.gasto)).toFixed(2)
    : null

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{esEdicion ? 'Editar campaña' : 'Nueva campaña de ads'}</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Mes</label>
              <input className="form-input" type="month" value={form.mes}
                onChange={e => setForm(f => ({ ...f, mes: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="form-label">Plataforma</label>
              <select className="form-select" value={form.plataforma}
                onChange={e => setForm(f => ({ ...f, plataforma: e.target.value }))}>
                {['Meta Ads', 'TikTok Ads', 'Instagram Ads', 'Google Ads', 'Otro'].map(p =>
                  <option key={p} value={p}>{p}</option>
                )}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Nombre de la campaña *</label>
            <input className="form-input" placeholder="Ej: Pack Gudair Mayo 2026" value={form.nombre}
              onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required />
          </div>
          <div className="form-group">
            <label className="form-label">Fecha de inicio</label>
            <input className="form-input" type="date" value={form.fecha_inicio}
              onChange={e => setForm(f => ({ ...f, fecha_inicio: e.target.value }))} />
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Gasto en ads (Gs.)</label>
              <input className="form-input" type="number" placeholder="343000" value={form.gasto}
                onChange={e => setForm(f => ({ ...f, gasto: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Ingresos generados (Gs.)</label>
              <input className="form-input" type="number" placeholder="1095000" value={form.ingresos_atribuidos}
                onChange={e => setForm(f => ({ ...f, ingresos_atribuidos: e.target.value }))} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Ventas generadas (#)</label>
            <input className="form-input" type="number" placeholder="7" value={form.ventas_generadas}
              onChange={e => setForm(f => ({ ...f, ventas_generadas: e.target.value }))} />
          </div>

          {roas && (
            <div style={{ background: parseFloat(roas) >= 2 ? 'var(--green-dim)' : 'var(--yellow-dim)',
              border: `1px solid ${parseFloat(roas) >= 2 ? 'rgba(34,197,94,0.2)' : 'rgba(245,158,11,0.2)'}`,
              borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ display: 'flex', gap: 20 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>ROAS</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: parseFloat(roas) >= 2 ? 'var(--green)' : 'var(--yellow)', fontFamily: 'var(--font-display)' }}>
                    {roas}x
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>ROI</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: parseFloat(roas) >= 2 ? 'var(--green)' : 'var(--yellow)', fontFamily: 'var(--font-display)' }}>
                    {((parseFloat(roas) - 1) * 100).toFixed(0)}%
                  </div>
                </div>
                {form.gasto && form.ventas_generadas && (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>CPA</div>
                    <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'var(--font-display)' }}>
                      {formatGs(parseInt(form.gasto) / parseInt(form.ventas_generadas))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Observaciones</label>
            <textarea className="form-textarea" placeholder="Notas, audiencia, creativos..." value={form.observaciones}
              onChange={e => setForm(f => ({ ...f, observaciones: e.target.value }))} />
          </div>

          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <Save size={14} /> {loading ? 'Guardando...' : esEdicion ? 'Guardar cambios' : 'Guardar campaña'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function AdsPage() {
  const { toast } = useToast()
  const [campanas, setCampanas] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editando, setEditando] = useState(null)

  const cargar = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('campanas_ads').select('*').is('deleted_at', null).order('created_at', { ascending: false })
    setCampanas(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const eliminar = async (id) => {
    if (!confirm('¿Mover esta campaña a la papelera?')) return
    const { error } = await supabase.from('campanas_ads').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast('Error al eliminar', 'error'); logError('borrar_campana', error, { id }); return }
    toast('Campaña movida a la papelera', 'info')
    cargar()
  }

  const totalGasto = campanas.reduce((s, c) => s + (c.gasto || 0), 0)
  const totalIngresos = campanas.reduce((s, c) => s + (c.ingresos_atribuidos || 0), 0)
  const roasTotal = totalGasto > 0 ? (totalIngresos / totalGasto).toFixed(2) : 0
  const cpaTotal = campanas.reduce((s, c) => s + (c.ventas_generadas || 0), 0) > 0
    ? totalGasto / campanas.reduce((s, c) => s + (c.ventas_generadas || 0), 0) : 0

  // Chart data: agrupar por mes
  const chartData = {}
  campanas.forEach(c => {
    if (!chartData[c.mes]) chartData[c.mes] = { mes: c.mes, gasto: 0, ingresos: 0 }
    chartData[c.mes].gasto += c.gasto || 0
    chartData[c.mes].ingresos += c.ingresos_atribuidos || 0
  })
  const chartArr = Object.values(chartData).sort((a, b) => a.mes.localeCompare(b.mes))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Campañas Ads</h1>
          <p className="page-subtitle">ROI y métricas de publicidad en tiempo real</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={15} /> Nueva campaña
        </button>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label"><DollarSign size={12} />Gasto total</div>
          <div className="kpi-value red">{formatGs(totalGasto)}</div>
          <div className="kpi-sub">En publicidad</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><TrendingUp size={12} />Ingresos atribuidos</div>
          <div className="kpi-value green">{formatGs(totalIngresos)}</div>
          <div className="kpi-sub">Por campañas</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Megaphone size={12} />ROAS total</div>
          <div className={`kpi-value ${parseFloat(roasTotal) >= 2 ? 'green' : 'yellow'}`}>
            {roasTotal}x
          </div>
          <div className="kpi-sub">Por cada Gs. invertido</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Target size={12} />CPA promedio</div>
          <div className="kpi-value">{formatGs(Math.round(cpaTotal))}</div>
          <div className="kpi-sub">Costo por venta</div>
        </div>
      </div>

      {/* Chart */}
      {chartArr.length > 0 && (
        <div className="chart-card">
          <div className="chart-header">
            <span className="chart-title">Inversión vs. Retorno por mes</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartArr} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="mes" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                tickFormatter={v => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : `${(v/1000).toFixed(0)}k`} />
              <Tooltip formatter={(v, n) => [formatGs(v), n === 'gasto' ? 'Gasto' : 'Ingresos']}
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="gasto" name="Gasto" fill="var(--red)" opacity={0.7} radius={[3, 3, 0, 0]} />
              <Bar dataKey="ingresos" name="Ingresos" fill="var(--accent)" opacity={0.9} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tabla campañas */}
      <div className="table-wrapper">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Cargando...</div>
        ) : campanas.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Megaphone size={22} /></div>
            <p className="empty-state-title">Sin campañas registradas</p>
            <p className="empty-state-desc">Registrá tus campañas de Meta Ads y TikTok para ver el ROI real</p>
            <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>
              <Plus size={13} /> Nueva campaña
            </button>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mes</th>
                <th>Plataforma</th>
                <th>Campaña</th>
                <th>Gasto</th>
                <th>Ingresos</th>
                <th>Ventas</th>
                <th>ROAS</th>
                <th>ROI %</th>
                <th>CPA</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {campanas.map(c => {
                const roas = c.gasto > 0 ? c.ingresos_atribuidos / c.gasto : 0
                const roiPct = c.gasto > 0 ? (roas - 1) * 100 : 0
                const cpa = c.ventas_generadas > 0 ? c.gasto / c.ventas_generadas : 0
                return (
                  <tr key={c.id}>
                    <td className="muted">{c.mes}</td>
                    <td><span className="badge badge-purple">{c.plataforma}</span></td>
                    <td style={{ fontWeight: 500 }}>{c.nombre}</td>
                    <td style={{ color: 'var(--red)' }}>{formatGs(c.gasto)}</td>
                    <td style={{ color: 'var(--green)' }}>{formatGs(c.ingresos_atribuidos)}</td>
                    <td>{c.ventas_generadas}</td>
                    <td>
                      <span style={{ fontWeight: 700, color: roas >= 2 ? 'var(--green)' : 'var(--yellow)' }}>
                        {roas.toFixed(2)}x
                      </span>
                    </td>
                    <td>
                      <span style={{ fontWeight: 700, color: roiPct > 0 ? 'var(--green)' : 'var(--red)' }}>
                        {roiPct.toFixed(0)}%
                      </span>
                    </td>
                    <td className="muted">{cpa > 0 ? formatGs(Math.round(cpa)) : '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditando(c)} style={{ color: 'var(--accent)' }} title="Editar"><Edit2 size={13} /></button>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => eliminar(c.id)} style={{ color: 'var(--red)', opacity: 0.6 }} title="Eliminar"><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {showModal && <CampanaModal onClose={() => setShowModal(false)} onSaved={cargar} />}
      {editando && <CampanaModal campana={editando} onClose={() => setEditando(null)} onSaved={cargar} />}
    </div>
  )
}
