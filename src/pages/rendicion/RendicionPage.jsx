// src/pages/rendicion/RendicionPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Plus, X, Truck, CheckCircle, AlertCircle } from 'lucide-react'

function NuevaRendicionModal({ onClose, onSaved }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    semana: '',
    fecha_rendicion: new Date().toISOString().split('T')[0],
    mes: new Date().toISOString().substring(0, 7),
    paquetes_enviados: '',
    paquetes_entregados: '',
    paquetes_devueltos: '',
    monto_a_rendir: '',
    monto_recibido: '',
    estado: 'pendiente',
    observaciones: '',
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.from('rendiciones').insert({
      ...form,
      semana: parseInt(form.semana),
      paquetes_enviados: parseInt(form.paquetes_enviados) || 0,
      paquetes_entregados: parseInt(form.paquetes_entregados) || 0,
      paquetes_devueltos: parseInt(form.paquetes_devueltos) || 0,
      monto_a_rendir: parseInt(form.monto_a_rendir) || 0,
      monto_recibido: parseInt(form.monto_recibido) || 0,
    })
    if (error) toast('Error al guardar', 'error')
    else { toast('Rendición registrada', 'success'); onSaved(); onClose() }
    setLoading(false)
  }

  const diferencia = (parseInt(form.monto_recibido) || 0) - (parseInt(form.monto_a_rendir) || 0)

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Registrar rendición</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Semana #</label>
              <input className="form-input" type="number" min="1" max="52" placeholder="1" value={form.semana}
                onChange={e => setForm(f => ({ ...f, semana: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="form-label">Fecha de rendición</label>
              <input className="form-input" type="date" value={form.fecha_rendicion}
                onChange={e => setForm(f => ({ ...f, fecha_rendicion: e.target.value }))} />
            </div>
          </div>
          <div className="form-grid form-grid-3">
            <div className="form-group">
              <label className="form-label">Enviados</label>
              <input className="form-input" type="number" min="0" value={form.paquetes_enviados}
                onChange={e => setForm(f => ({ ...f, paquetes_enviados: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Entregados</label>
              <input className="form-input" type="number" min="0" value={form.paquetes_entregados}
                onChange={e => setForm(f => ({ ...f, paquetes_entregados: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Devueltos</label>
              <input className="form-input" type="number" min="0" value={form.paquetes_devueltos}
                onChange={e => setForm(f => ({ ...f, paquetes_devueltos: e.target.value }))} />
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Monto a rendir (Gs.)</label>
              <input className="form-input" type="number" value={form.monto_a_rendir}
                onChange={e => setForm(f => ({ ...f, monto_a_rendir: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Monto recibido (Gs.)</label>
              <input className="form-input" type="number" value={form.monto_recibido}
                onChange={e => setForm(f => ({ ...f, monto_recibido: e.target.value }))} />
            </div>
          </div>

          {(form.monto_a_rendir || form.monto_recibido) && (
            <div style={{
              background: diferencia === 0 ? 'var(--green-dim)' : diferencia < 0 ? 'var(--red-dim)' : 'var(--accent-dim)',
              border: `1px solid ${diferencia < 0 ? 'rgba(239,68,68,0.2)' : diferencia === 0 ? 'rgba(34,197,94,0.2)' : 'rgba(200,241,53,0.2)'}`,
              borderRadius: 8, padding: '10px 14px',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: diferencia < 0 ? 'var(--red)' : diferencia === 0 ? 'var(--green)' : 'var(--accent)' }}>
                Diferencia: {diferencia >= 0 ? '+' : ''}{formatGs(diferencia)}
                {diferencia === 0 ? ' — OK ✓' : diferencia < 0 ? ' — FALTANTE' : ' — SOBRANTE'}
              </span>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Estado</label>
            <select className="form-select" value={form.estado}
              onChange={e => setForm(f => ({ ...f, estado: e.target.value }))}>
              <option value="pendiente">Pendiente</option>
              <option value="recibido">Recibido</option>
              <option value="con_diferencia">Con diferencia</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Observaciones</label>
            <textarea className="form-textarea" value={form.observaciones}
              onChange={e => setForm(f => ({ ...f, observaciones: e.target.value }))} />
          </div>

          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Registrar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function RendicionPage() {
  const [rendiciones, setRendiciones] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)

  const cargar = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('rendiciones').select('*').order('semana', { ascending: false })
    setRendiciones(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const totalARendir = rendiciones.reduce((s, r) => s + (r.monto_a_rendir || 0), 0)
  const totalRecibido = rendiciones.reduce((s, r) => s + (r.monto_recibido || 0), 0)
  const diferenciaTot = totalRecibido - totalARendir
  const pendientes = rendiciones.filter(r => r.estado === 'pendiente').length

  const estadoBadge = {
    pendiente: <span className="badge badge-yellow">Pendiente</span>,
    recibido: <span className="badge badge-green">Recibido</span>,
    con_diferencia: <span className="badge badge-red">Con diferencia</span>,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Rendición</h1>
          <p className="page-subtitle">Control de cobros con la transportadora</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={15} /> Nueva rendición
        </button>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label"><Truck size={12} />Total a rendir</div>
          <div className="kpi-value">{formatGs(totalARendir)}</div>
          <div className="kpi-sub">Acumulado</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><CheckCircle size={12} />Total recibido</div>
          <div className="kpi-value green">{formatGs(totalRecibido)}</div>
          <div className="kpi-sub">Cobrado</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><AlertCircle size={12} />Diferencia</div>
          <div className={`kpi-value ${diferenciaTot === 0 ? 'green' : diferenciaTot < 0 ? 'red' : 'yellow'}`}>
            {formatGs(Math.abs(diferenciaTot))}
          </div>
          <div className="kpi-sub">{diferenciaTot < 0 ? 'Faltante' : diferenciaTot > 0 ? 'Sobrante' : 'Cuadrado ✓'}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Truck size={12} />Pendientes</div>
          <div className={`kpi-value ${pendientes > 0 ? 'yellow' : 'green'}`}>{pendientes}</div>
          <div className="kpi-sub">Sin confirmar</div>
        </div>
      </div>

      <div className="table-wrapper">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Cargando...</div>
        ) : rendiciones.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Truck size={22} /></div>
            <p className="empty-state-title">Sin rendiciones</p>
            <p className="empty-state-desc">Registrá las rendiciones semanales de la transportadora</p>
            <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>
              <Plus size={13} /> Nueva rendición
            </button>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Semana</th>
                <th>Mes</th>
                <th>Fecha</th>
                <th>Enviados</th>
                <th>Entregados</th>
                <th>Devueltos</th>
                <th>A rendir</th>
                <th>Recibido</th>
                <th>Diferencia</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {rendiciones.map(r => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>Sem. {r.semana}</td>
                  <td className="muted">{r.mes}</td>
                  <td className="muted">{r.fecha_rendicion ? new Date(r.fecha_rendicion + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short' }) : '—'}</td>
                  <td>{r.paquetes_enviados}</td>
                  <td style={{ color: 'var(--green)' }}>{r.paquetes_entregados}</td>
                  <td style={{ color: 'var(--red)' }}>{r.paquetes_devueltos}</td>
                  <td style={{ fontWeight: 600 }}>{formatGs(r.monto_a_rendir)}</td>
                  <td style={{ fontWeight: 600, color: 'var(--green)' }}>{formatGs(r.monto_recibido)}</td>
                  <td style={{ fontWeight: 700, color: r.diferencia < 0 ? 'var(--red)' : r.diferencia > 0 ? 'var(--yellow)' : 'var(--green)' }}>
                    {r.diferencia !== null ? `${r.diferencia >= 0 ? '+' : ''}${formatGs(r.diferencia)}` : '—'}
                  </td>
                  <td>{estadoBadge[r.estado] || estadoBadge.pendiente}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && <NuevaRendicionModal onClose={() => setShowModal(false)} onSaved={cargar} />}
    </div>
  )
}
