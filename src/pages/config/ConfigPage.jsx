// src/pages/config/ConfigPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthContext'
import { useToast } from '../../lib/toast'
import { useNavigate } from 'react-router-dom'
import { Plus, Edit2, X, Save, Package, CreditCard, Truck, Users, Shield, Trash2 } from 'lucide-react'

// ─── Modal producto ───────────────────────────────────────
function ProductoModal({ producto, onClose, onSaved }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState(producto || {
    nombre: '', costo_unit: '', precio_1u: '', precio_2u: '', precio_3u: '',
    grupo_envio: 'A', prioridad: 'Media', stock_actual: 0, stock_alerta: 20, activo: true,
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    const data = {
      nombre: form.nombre,
      costo_unit: parseInt(form.costo_unit),
      precio_1u: parseInt(form.precio_1u),
      precio_2u: parseInt(form.precio_2u) || 0,
      precio_3u: parseInt(form.precio_3u) || 0,
      grupo_envio: form.grupo_envio,
      prioridad: form.prioridad,
      stock_actual: parseInt(form.stock_actual) || 0,
      stock_alerta: parseInt(form.stock_alerta) || 10,
      activo: form.activo,
    }
    const { error } = producto
      ? await supabase.from('productos').update(data).eq('id', producto.id)
      : await supabase.from('productos').insert(data)
    if (error) toast('Error al guardar: ' + error.message, 'error')
    else { toast(producto ? 'Producto actualizado' : 'Producto creado', 'success'); onSaved(); onClose() }
    setLoading(false)
  }

  const f = (key) => ({
    value: form[key] ?? '',
    onChange: e => setForm(p => ({ ...p, [key]: e.target.value }))
  })

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2 className="modal-title">{producto ? 'Editar producto' : 'Nuevo producto'}</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Nombre del producto *</label>
            <input className="form-input" {...f('nombre')} required placeholder="Ej: Raspador de Lengua" />
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Costo unitario (Gs.) *</label>
              <input className="form-input" type="number" {...f('costo_unit')} required placeholder="5312" />
            </div>
            <div className="form-group">
              <label className="form-label">Grupo envío</label>
              <select className="form-select" {...f('grupo_envio')}>
                <option value="A">A — Cliente paga envío</option>
                <option value="B">B — Envío gratis</option>
              </select>
            </div>
          </div>
          <div className="form-grid form-grid-3">
            <div className="form-group">
              <label className="form-label">Precio 1 unidad (Gs.) *</label>
              <input className="form-input" type="number" {...f('precio_1u')} required placeholder="98000" />
            </div>
            <div className="form-group">
              <label className="form-label">Precio 2 unidades (Gs.)</label>
              <input className="form-input" type="number" {...f('precio_2u')} placeholder="138000" />
            </div>
            <div className="form-group">
              <label className="form-label">Precio 3 unidades (Gs.)</label>
              <input className="form-input" type="number" {...f('precio_3u')} placeholder="157000" />
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Stock actual</label>
              <input className="form-input" type="number" {...f('stock_actual')} />
            </div>
            <div className="form-group">
              <label className="form-label">Alerta mínima</label>
              <input className="form-input" type="number" {...f('stock_alerta')} />
            </div>
            <div className="form-group">
              <label className="form-label">Prioridad</label>
              <select className="form-select" {...f('prioridad')}>
                <option value="Alta">Alta</option>
                <option value="Media">Media</option>
                <option value="Baja">Baja</option>
              </select>
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.activo} onChange={e => setForm(p => ({ ...p, activo: e.target.checked }))} />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Producto activo (visible para registrar ventas)</span>
          </label>
          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Guardando...' : 'Guardar'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Modal simple (métodos pago/envío) ───────────────────
function MetodoModal({ tipo, item, onClose, onSaved }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const tabla = tipo === 'pago' ? 'metodos_pago' : 'metodos_envio'
  const [form, setForm] = useState(item || {
    nombre: '',
    ...(tipo === 'envio' ? { costo_cliente: 29000, costo_propio: 27000 } : {}),
    activo: true,
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    const { error } = item
      ? await supabase.from(tabla).update(form).eq('id', item.id)
      : await supabase.from(tabla).insert(form)
    if (error) toast('Error', 'error')
    else { toast(item ? 'Actualizado' : 'Creado', 'success'); onSaved(); onClose() }
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{item ? 'Editar' : 'Agregar'} método de {tipo === 'pago' ? 'pago' : 'envío'}</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Nombre *</label>
            <input className="form-input" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required placeholder={tipo === 'pago' ? 'Ej: Billetera virtual' : 'Ej: Punto a Punto AC'} />
          </div>
          {tipo === 'envio' && (
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Costo para el cliente (Gs.)</label>
                <input className="form-input" type="number" value={form.costo_cliente} onChange={e => setForm(f => ({ ...f, costo_cliente: parseInt(e.target.value) }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Costo propio (Gs.)</label>
                <input className="form-input" type="number" value={form.costo_propio} onChange={e => setForm(f => ({ ...f, costo_propio: parseInt(e.target.value) }))} />
              </div>
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.activo} onChange={e => setForm(f => ({ ...f, activo: e.target.checked }))} />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Activo</span>
          </label>
          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Guardando...' : 'Guardar'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Modal usuario ────────────────────────────────────────
function UsuarioModal({ onClose, onSaved }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ email: '', password: '', nombre: '', rol: 'staff' })

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (form.password.length < 6) { toast('La contraseña debe tener al menos 6 caracteres', 'error'); return }
    setLoading(true)
    const { data, error } = await supabase.auth.admin.createUser({
      email: form.email,
      password: form.password,
      user_metadata: { nombre: form.nombre, rol: form.rol },
      email_confirm: true,
    })
    if (error) {
      // Si no hay acceso admin, usar signUp normal
      const { error: e2 } = await supabase.auth.signUp({
        email: form.email, password: form.password,
        options: { data: { nombre: form.nombre, rol: form.rol } },
      })
      if (e2) { toast('Error: ' + e2.message, 'error'); setLoading(false); return }
    }
    toast('Usuario creado. Debe confirmar su email.', 'success')
    onSaved()
    onClose()
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Agregar usuario</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Nombre completo *</label>
            <input className="form-input" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} required placeholder="Ej: Juan Pérez" />
          </div>
          <div className="form-group">
            <label className="form-label">Email *</label>
            <input className="form-input" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
          </div>
          <div className="form-group">
            <label className="form-label">Contraseña *</label>
            <input className="form-input" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required placeholder="Mínimo 6 caracteres" />
          </div>
          <div className="form-group">
            <label className="form-label">Rol</label>
            <select className="form-select" value={form.rol} onChange={e => setForm(f => ({ ...f, rol: e.target.value }))}>
              <option value="staff">Staff — Sin acceso admin</option>
              <option value="admin">Admin — Acceso total</option>
            </select>
          </div>
          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Creando...' : 'Crear usuario'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Config Page ──────────────────────────────────────────
export default function ConfigPage() {
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState('productos')
  const [productos, setProductos] = useState([])
  const [metodosPago, setMetodosPago] = useState([])
  const [metodosEnvio, setMetodosEnvio] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null)

  useEffect(() => {
    if (!isAdmin) { navigate('/dashboard'); return }
    cargar()
  }, [isAdmin])

  const cargar = useCallback(async () => {
    setLoading(true)
    const [{ data: p }, { data: mp }, { data: me }, { data: pr }] = await Promise.all([
      supabase.from('productos').select('*').order('nombre'),
      supabase.from('metodos_pago').select('*').order('nombre'),
      supabase.from('metodos_envio').select('*').order('nombre'),
      supabase.from('profiles').select('*').order('nombre'),
    ])
    setProductos(p || [])
    setMetodosPago(mp || [])
    setMetodosEnvio(me || [])
    setProfiles(pr || [])
    setLoading(false)
  }, [])

  const toggleActivo = async (tabla, id, actual) => {
    await supabase.from(tabla).update({ activo: !actual }).eq('id', id)
    toast(`${actual ? 'Desactivado' : 'Activado'}`, 'success')
    cargar()
  }

  const tabs = [
    { key: 'productos', icon: Package, label: 'Productos' },
    { key: 'pago', icon: CreditCard, label: 'Métodos de pago' },
    { key: 'envio', icon: Truck, label: 'Métodos de envío' },
    { key: 'usuarios', icon: Users, label: 'Usuarios' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Configuración</h1>
          <p className="page-subtitle">Gestión completa de productos, precios, métodos y usuarios</p>
        </div>
        <span className="badge badge-accent"><Shield size={11} /> Solo admin</span>
      </div>

      <div className="tabs">
        {tabs.map(t => (
          <button key={t.key} className={`tab ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => setActiveTab(t.key)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {/* PRODUCTOS */}
      {activeTab === 'productos' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={() => setModal({ tipo: 'producto', item: null })}>
              <Plus size={14} /> Nuevo producto
            </button>
          </div>
          <div className="table-wrapper">
            <table className="tabla-responsive">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Costo</th>
                  <th>1u</th>
                  <th>2u</th>
                  <th>3u</th>
                  <th>Margen 1u</th>
                  <th>Grupo</th>
                  <th>Stock</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {productos.map(p => {
                  const margen = p.precio_1u > 0 ? ((p.precio_1u - p.costo_unit) / p.precio_1u * 100).toFixed(1) : 0
                  return (
                    <tr key={p.id}>
                      <td data-label="Producto" style={{ fontWeight: 600 }}>{p.nombre}</td>
                      <td data-label="Costo" className="muted">{formatGs(p.costo_unit)}</td>
                      <td data-label="1u" style={{ fontWeight: 500 }}>{formatGs(p.precio_1u)}</td>
                      <td data-label="2u" className="muted">{p.precio_2u ? formatGs(p.precio_2u) : '—'}</td>
                      <td data-label="3u" className="muted">{p.precio_3u ? formatGs(p.precio_3u) : '—'}</td>
                      <td data-label="Margen 1u" style={{ color: margen > 50 ? 'var(--green)' : 'var(--yellow)', fontWeight: 600 }}>{margen}%</td>
                      <td data-label="Grupo"><span className={`badge ${p.grupo_envio === 'A' ? 'badge-blue' : 'badge-accent'}`}>Grupo {p.grupo_envio}</span></td>
                      <td data-label="Stock" style={{ color: p.stock_actual <= p.stock_alerta ? 'var(--red)' : 'var(--green)', fontWeight: 700 }}>{p.stock_actual}</td>
                      <td data-label="Estado">
                        <button onClick={() => toggleActivo('productos', p.id, p.activo)}
                          className={`badge ${p.activo ? 'badge-green' : 'badge-gray'}`} style={{ border: 'none', cursor: 'pointer' }}>
                          {p.activo ? 'Activo' : 'Inactivo'}
                        </button>
                      </td>
                      <td data-label="Acciones">
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setModal({ tipo: 'producto', item: p })}>
                          <Edit2 size={13} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MÉTODOS DE PAGO */}
      {activeTab === 'pago' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={() => setModal({ tipo: 'metodo', subtipo: 'pago', item: null })}>
              <Plus size={14} /> Agregar método
            </button>
          </div>
          <div className="table-wrapper">
            <table className="tabla-responsive">
              <thead>
                <tr><th>Nombre</th><th>Estado</th><th>Acciones</th></tr>
              </thead>
              <tbody>
                {metodosPago.map(m => (
                  <tr key={m.id}>
                    <td data-label="Nombre" style={{ fontWeight: 500 }}>{m.nombre}</td>
                    <td data-label="Estado">
                      <button onClick={() => toggleActivo('metodos_pago', m.id, m.activo)}
                        className={`badge ${m.activo ? 'badge-green' : 'badge-gray'}`} style={{ border: 'none', cursor: 'pointer' }}>
                        {m.activo ? 'Activo' : 'Inactivo'}
                      </button>
                    </td>
                    <td data-label="Acciones">
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setModal({ tipo: 'metodo', subtipo: 'pago', item: m })}>
                        <Edit2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MÉTODOS DE ENVÍO */}
      {activeTab === 'envio' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={() => setModal({ tipo: 'metodo', subtipo: 'envio', item: null })}>
              <Plus size={14} /> Agregar transportadora
            </button>
          </div>
          <div className="table-wrapper">
            <table className="tabla-responsive">
              <thead>
                <tr><th>Nombre</th><th>Costo al cliente</th><th>Costo propio</th><th>Estado</th><th>Acciones</th></tr>
              </thead>
              <tbody>
                {metodosEnvio.map(m => (
                  <tr key={m.id}>
                    <td data-label="Nombre" style={{ fontWeight: 500 }}>{m.nombre}</td>
                    <td data-label="Costo al cliente">{formatGs(m.costo_cliente)}</td>
                    <td data-label="Costo propio" style={{ color: 'var(--red)' }}>{formatGs(m.costo_propio)}</td>
                    <td data-label="Estado">
                      <button onClick={() => toggleActivo('metodos_envio', m.id, m.activo)}
                        className={`badge ${m.activo ? 'badge-green' : 'badge-gray'}`} style={{ border: 'none', cursor: 'pointer' }}>
                        {m.activo ? 'Activo' : 'Inactivo'}
                      </button>
                    </td>
                    <td data-label="Acciones">
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setModal({ tipo: 'metodo', subtipo: 'envio', item: m })}>
                        <Edit2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* USUARIOS */}
      {activeTab === 'usuarios' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={() => setModal({ tipo: 'usuario' })}>
              <Plus size={14} /> Agregar usuario
            </button>
          </div>
          <div className="table-wrapper">
            <table className="tabla-responsive">
              <thead>
                <tr><th>Nombre</th><th>Rol</th><th>Estado</th></tr>
              </thead>
              <tbody>
                {profiles.map(p => (
                  <tr key={p.id}>
                    <td data-label="Nombre" style={{ fontWeight: 500 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>
                          {p.nombre.slice(0, 2).toUpperCase()}
                        </div>
                        {p.nombre}
                      </div>
                    </td>
                    <td data-label="Rol">
                      <span className={`badge ${p.rol === 'admin' ? 'badge-accent' : 'badge-gray'}`}>
                        {p.rol === 'admin' && <Shield size={10} />} {p.rol}
                      </span>
                    </td>
                    <td data-label="Estado"><span className={`badge ${p.activo ? 'badge-green' : 'badge-gray'}`}>{p.activo ? 'Activo' : 'Inactivo'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modals */}
      {modal?.tipo === 'producto' && (
        <ProductoModal producto={modal.item} onClose={() => setModal(null)} onSaved={cargar} />
      )}
      {modal?.tipo === 'metodo' && (
        <MetodoModal tipo={modal.subtipo} item={modal.item} onClose={() => setModal(null)} onSaved={cargar} />
      )}
      {modal?.tipo === 'usuario' && (
        <UsuarioModal onClose={() => setModal(null)} onSaved={cargar} />
      )}
    </div>
  )
}
