// src/pages/clientes/ClientesPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Users, Plus, X, Search, Phone, MapPin, TrendingUp, Star, Edit2, Trash2, Save, ShoppingBag } from 'lucide-react'

function ClienteModal({ cliente, onClose, onSaved }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState(cliente || {
    nombre: '', telefono: '', ciudad: '', direccion: '',
    canal_origen: 'Meta Ads', notas: '',
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    const { error } = cliente
      ? await supabase.from('clientes').update(form).eq('id', cliente.id)
      : await supabase.from('clientes').insert(form)
    if (error) toast('Error: ' + error.message, 'error')
    else { toast(cliente ? 'Cliente actualizado' : 'Cliente creado', 'success'); onSaved(); onClose() }
    setLoading(false)
  }

  const f = (key) => ({ value: form[key] ?? '', onChange: e => setForm(p => ({ ...p, [key]: e.target.value })) })

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{cliente ? 'Editar cliente' : 'Nuevo cliente'}</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Nombre completo *</label>
            <input className="form-input" {...f('nombre')} required placeholder="Ej: Juan Pérez" />
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Teléfono</label>
              <input className="form-input" {...f('telefono')} placeholder="0981 000 000" />
            </div>
            <div className="form-group">
              <label className="form-label">Ciudad</label>
              <input className="form-input" {...f('ciudad')} placeholder="Asunción" />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Dirección</label>
            <input className="form-input" {...f('direccion')} placeholder="Calle y número" />
          </div>
          <div className="form-group">
            <label className="form-label">Canal de origen</label>
            <select className="form-select" {...f('canal_origen')}>
              {['Meta Ads', 'TikTok', 'Instagram', 'WhatsApp', 'Shopify Orgánico', 'Otro'].map(c =>
                <option key={c} value={c}>{c}</option>
              )}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Notas</label>
            <textarea className="form-textarea" {...f('notas')} placeholder="Info adicional del cliente..." />
          </div>
          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <Save size={14} /> {loading ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ClienteDetalle({ cliente, onClose }) {
  const [ventas, setVentas] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('ventas').select('*')
      .eq('cliente_id', cliente.id)
      .order('fecha', { ascending: false })
      .then(({ data }) => { setVentas(data || []); setLoading(false) })
  }, [cliente.id])

  const entregadas = ventas.filter(v => v.estado === 'entregado')
  const ltv = entregadas.reduce((s, v) => s + v.total, 0)
  const tasaConversion = ventas.length ? Math.round(entregadas.length / ventas.length * 100) : 0

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2 className="modal-title">{cliente.nombre}</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        {/* Info del cliente */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          {cliente.telefono && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <Phone size={13} color="var(--text-muted)" />
              <span>{cliente.telefono}</span>
            </div>
          )}
          {cliente.ciudad && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <MapPin size={13} color="var(--text-muted)" />
              <span>{cliente.ciudad}</span>
            </div>
          )}
        </div>

        {/* KPIs del cliente */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
          {[
            { label: 'LTV', value: formatGs(ltv), color: 'var(--accent)' },
            { label: 'Pedidos', value: ventas.length, color: 'var(--text-primary)' },
            { label: 'Entregados', value: entregadas.length, color: 'var(--green)' },
            { label: 'Conversión', value: `${tasaConversion}%`, color: tasaConversion > 60 ? 'var(--green)' : 'var(--yellow)' },
          ].map((k, i) => (
            <div key={i} className="card card-sm" style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k.label}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800, color: k.color, marginTop: 4 }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Historial de compras */}
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          Historial de compras
        </div>
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>Cargando...</div>
        ) : ventas.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>Sin compras registradas</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
            {ventas.map(v => (
              <div key={v.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '9px 12px', background: 'var(--bg-hover)', borderRadius: 6,
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{v.producto_nombre}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {new Date(v.fecha + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short', year: 'numeric' })}
                    {v.n_referencia ? ` · Ref: ${v.n_referencia}` : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{formatGs(v.total)}</div>
                  <span className={`badge badge-${v.estado === 'entregado' ? 'green' : v.estado === 'devuelto' ? 'red' : 'yellow'}`}
                    style={{ fontSize: 10 }}>{v.estado}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function ClientesPage() {
  const { toast } = useToast()
  const [clientes, setClientes] = useState([])
  const [loading, setLoading] = useState(true)
  const [busqueda, setBusqueda] = useState('')
  const [modal, setModal] = useState(null)
  const [detalle, setDetalle] = useState(null)
  const [stats, setStats] = useState({})

  const cargar = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('clientes')
      .select('*')
      .eq('activo', true)
      .order('created_at', { ascending: false })
    setClientes(data || [])

    // Stats globales
    const { data: ventas } = await supabase.from('ventas').select('cliente_id, total, estado').not('cliente_id', 'is', null)
    if (ventas) {
      const entregadas = ventas.filter(v => v.estado === 'entregado')
      setStats({
        totalClientes: data?.length || 0,
        ltvTotal: entregadas.reduce((s, v) => s + v.total, 0),
        clientesConCompra: new Set(entregadas.map(v => v.cliente_id)).size,
        ltvPromedio: entregadas.length
          ? Math.round(entregadas.reduce((s, v) => s + v.total, 0) / new Set(entregadas.map(v => v.cliente_id)).size)
          : 0,
      })
    }
    setLoading(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const eliminar = async (id, nombre) => {
    if (!confirm(`¿Eliminar a ${nombre}?`)) return
    await supabase.from('clientes').update({ activo: false }).eq('id', id)
    toast('Cliente eliminado', 'info')
    cargar()
  }

  const filtrados = clientes.filter(c => {
    if (!busqueda) return true
    const b = busqueda.toLowerCase()
    return c.nombre?.toLowerCase().includes(b) || c.telefono?.includes(b) || c.ciudad?.toLowerCase().includes(b)
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Clientes</h1>
          <p className="page-subtitle">{clientes.length} clientes registrados</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setModal('nuevo')}>
            <Plus size={15} /> Nuevo cliente
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label"><Users size={11} />Total clientes</div>
          <div className="kpi-value">{stats.totalClientes || 0}</div>
          <div className="kpi-sub">Registrados</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><TrendingUp size={11} />LTV total</div>
          <div className="kpi-value accent">{formatGs(stats.ltvTotal || 0)}</div>
          <div className="kpi-sub">Valor acumulado</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Star size={11} />LTV promedio</div>
          <div className="kpi-value green">{formatGs(stats.ltvPromedio || 0)}</div>
          <div className="kpi-sub">Por cliente activo</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><ShoppingBag size={11} />Con compras</div>
          <div className="kpi-value">{stats.clientesConCompra || 0}</div>
          <div className="kpi-sub">Al menos 1 entregado</div>
        </div>
      </div>

      {/* Búsqueda */}
      <div style={{ position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input className="form-input" style={{ paddingLeft: 36 }} placeholder="Buscar por nombre, teléfono o ciudad..."
          value={busqueda} onChange={e => setBusqueda(e.target.value)} />
      </div>

      {/* Lista clientes */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 72, borderRadius: 10 }} />)}
        </div>
      ) : filtrados.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Users size={22} /></div>
          <p className="empty-state-title">{busqueda ? 'Sin resultados' : 'Sin clientes registrados'}</p>
          <p className="empty-state-desc">
            {busqueda ? 'Probá con otro nombre o teléfono' : 'Agregá clientes para trackear su LTV y historial de compras'}
          </p>
          {!busqueda && (
            <button className="btn btn-primary btn-sm" onClick={() => setModal('nuevo')}>
              <Plus size={13} /> Agregar cliente
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtrados.map(c => (
            <div key={c.id} className="card card-sm" style={{ cursor: 'pointer', transition: 'border-color 0.15s' }}
              onClick={() => setDetalle(c)}
              onMouseEnter={e => e.currentTarget.style.borderColor = '#333'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {/* Avatar */}
                  <div style={{
                    width: 40, height: 40, borderRadius: '50%',
                    background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 15, color: 'var(--accent)',
                    flexShrink: 0,
                  }}>
                    {c.nombre.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{c.nombre}</div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                      {c.telefono && (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Phone size={10} /> {c.telefono}
                        </span>
                      )}
                      {c.ciudad && (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <MapPin size={10} /> {c.ciudad}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Canal</div>
                    <span className="badge badge-gray" style={{ fontSize: 10 }}>{c.canal_origen}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                    <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setModal(c)} title="Editar">
                      <Edit2 size={13} />
                    </button>
                    <button className="btn btn-danger btn-sm btn-icon" onClick={() => eliminar(c.id, c.nombre)} title="Eliminar">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && <ClienteModal cliente={modal === 'nuevo' ? null : modal} onClose={() => setModal(null)} onSaved={cargar} />}
      {detalle && <ClienteDetalle cliente={detalle} onClose={() => setDetalle(null)} />}
    </div>
  )
}
