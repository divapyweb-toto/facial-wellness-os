// src/pages/stock/StockPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Package, Plus, TrendingDown, AlertTriangle, Edit2, X, Save } from 'lucide-react'

// Modal: agregar/editar producto completo
function ProductoModal({ producto, onClose, onSaved }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const esNuevo = !producto
  const [form, setForm] = useState(producto || {
    nombre: '', costo_unit: '', precio_1u: '', precio_2u: '', precio_3u: '',
    grupo_envio: 'A', prioridad: 'Media', stock_actual: 0, stock_alerta: 20, activo: true,
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    const data = {
      nombre: form.nombre,
      costo_unit: parseInt(form.costo_unit) || 0,
      precio_1u: parseInt(form.precio_1u) || 0,
      precio_2u: parseInt(form.precio_2u) || 0,
      precio_3u: parseInt(form.precio_3u) || 0,
      grupo_envio: form.grupo_envio,
      prioridad: form.prioridad,
      stock_actual: parseInt(form.stock_actual) || 0,
      stock_alerta: parseInt(form.stock_alerta) || 10,
      activo: form.activo !== false,
    }
    const { error } = esNuevo
      ? await supabase.from('productos').insert(data)
      : await supabase.from('productos').update(data).eq('id', producto.id)
    if (error) toast('Error: ' + error.message, 'error')
    else { toast(esNuevo ? 'Producto creado' : 'Producto actualizado', 'success'); onSaved(); onClose() }
    setLoading(false)
  }

  const f = (key) => ({ value: form[key] ?? '', onChange: e => setForm(p => ({ ...p, [key]: e.target.value })) })

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2 className="modal-title">{esNuevo ? 'Nuevo producto' : `Editar — ${producto.nombre}`}</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Nombre *</label>
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
              <label className="form-label">Precio 1u (Gs.) *</label>
              <input className="form-input" type="number" {...f('precio_1u')} required placeholder="98000" />
            </div>
            <div className="form-group">
              <label className="form-label">Precio 2u (Gs.)</label>
              <input className="form-input" type="number" {...f('precio_2u')} placeholder="138000" />
            </div>
            <div className="form-group">
              <label className="form-label">Precio 3u (Gs.)</label>
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
          </div>
          <div className="form-group">
            <label className="form-label">Prioridad</label>
            <select className="form-select" {...f('prioridad')}>
              <option value="Alta">Alta</option>
              <option value="Media">Media</option>
              <option value="Baja">Baja</option>
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={form.activo !== false} onChange={e => setForm(p => ({ ...p, activo: e.target.checked }))} />
            Producto activo (visible en ventas)
          </label>
          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <Save size={14} /> {loading ? 'Guardando...' : esNuevo ? 'Crear producto' : 'Guardar cambios'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Modal: agregar stock
function CompraModal({ producto, onClose, onSaved }) {
  const { toast } = useToast()
  const [cantidad, setCantidad] = useState('')
  const [motivo, setMotivo] = useState('Compra de mercadería')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!cantidad || cantidad <= 0) { toast('Ingresá una cantidad válida', 'error'); return }
    setLoading(true)
    const { error } = await supabase.from('productos')
      .update({ stock_actual: producto.stock_actual + parseInt(cantidad) })
      .eq('id', producto.id)
    if (!error) {
      await supabase.from('stock_movimientos').insert({
        producto_id: producto.id, producto_nombre: producto.nombre,
        tipo: 'compra', cantidad: parseInt(cantidad), motivo,
      })
      toast(`+${cantidad} unidades agregadas a ${producto.nombre}`, 'success')
      onSaved(); onClose()
    } else toast('Error al actualizar stock', 'error')
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Agregar stock</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--bg-surface)', borderRadius: 8, padding: '12px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{producto.nombre}</span>
              <span style={{ fontWeight: 700, color: producto.stock_actual <= producto.stock_alerta ? 'var(--red)' : 'var(--green)' }}>
                {producto.stock_actual} uds actuales
              </span>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Unidades a agregar *</label>
            <input className="form-input" type="number" min="1" value={cantidad}
              onChange={e => setCantidad(e.target.value)} required autoFocus placeholder="50" />
          </div>
          <div className="form-group">
            <label className="form-label">Motivo</label>
            <input className="form-input" value={motivo} onChange={e => setMotivo(e.target.value)} />
          </div>
          {cantidad > 0 && (
            <div style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600, padding: '8px 12px', background: 'var(--accent-dim)', borderRadius: 6 }}>
              Nuevo stock: {producto.stock_actual + parseInt(cantidad || 0)} unidades
            </div>
          )}
          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Confirmar entrada'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function StockPage() {
  const [productos, setProductos] = useState([])
  const [movimientos, setMovimientos] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalCompra, setModalCompra] = useState(null)
  const [modalProducto, setModalProducto] = useState(null) // null=cerrado, 'nuevo'=nuevo, objeto=editar
  const [activeTab, setActiveTab] = useState('stock')

  const cargar = useCallback(async () => {
    setLoading(true)
    const [{ data: prods }, { data: movs }] = await Promise.all([
      supabase.from('productos').select('*').eq('activo', true).order('nombre'),
      supabase.from('stock_movimientos').select('*').order('created_at', { ascending: false }).limit(60),
    ])
    setProductos(prods || [])
    setMovimientos(movs || [])
    setLoading(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const valorTotal = productos.reduce((s, p) => s + (p.stock_actual * p.costo_unit), 0)
  const bajosAlerta = productos.filter(p => p.stock_actual <= p.stock_alerta)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock</h1>
          <p className="page-subtitle">{productos.length} productos · {formatGs(valorTotal)} en inventario</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setModalProducto('nuevo')}>
            <Plus size={15} /> Nuevo producto
          </button>
        </div>
      </div>

      {bajosAlerta.length > 0 && (
        <div className="alert alert-error">
          <AlertTriangle size={15} />
          <span>{bajosAlerta.map(p => p.nombre).join(', ')} — stock bajo</span>
        </div>
      )}

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label"><Package size={11} />Valor inventario</div>
          <div className="kpi-value">{formatGs(valorTotal)}</div>
          <div className="kpi-sub">Costo total</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><TrendingDown size={11} />Bajo alerta</div>
          <div className={`kpi-value ${bajosAlerta.length > 0 ? 'red' : 'green'}`}>{bajosAlerta.length}</div>
          <div className="kpi-sub">Productos bajo mínimo</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Package size={11} />Total unidades</div>
          <div className="kpi-value">{productos.reduce((s, p) => s + p.stock_actual, 0)}</div>
          <div className="kpi-sub">En todos los productos</div>
        </div>
      </div>

      <div className="tabs" style={{ alignSelf: 'flex-start' }}>
        <button className={`tab ${activeTab === 'stock' ? 'active' : ''}`} onClick={() => setActiveTab('stock')}>Stock actual</button>
        <button className={`tab ${activeTab === 'historial' ? 'active' : ''}`} onClick={() => setActiveTab('historial')}>Historial</button>
      </div>

      {activeTab === 'stock' && (
        <>
          {/* Desktop table */}
          <div className="table-wrapper" style={{ display: 'none' }} id="stock-table-desktop">
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Costo</th>
                  <th>1u</th>
                  <th>2u</th>
                  <th>3u</th>
                  <th>Stock</th>
                  <th>Alerta</th>
                  <th>Estado</th>
                  <th>Grupo</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {productos.map(p => {
                  const bajo = p.stock_actual <= p.stock_alerta
                  const pct = Math.min(100, (p.stock_actual / Math.max(p.stock_alerta * 3, 1)) * 100)
                  return (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.nombre}</td>
                      <td className="muted">{formatGs(p.costo_unit)}</td>
                      <td style={{ fontWeight: 500 }}>{formatGs(p.precio_1u)}</td>
                      <td className="muted">{p.precio_2u ? formatGs(p.precio_2u) : '—'}</td>
                      <td className="muted">{p.precio_3u ? formatGs(p.precio_3u) : '—'}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 700, color: bajo ? 'var(--red)' : 'var(--text-primary)', minWidth: 24 }}>{p.stock_actual}</span>
                          <div style={{ width: 50, height: 4, background: 'var(--bg-hover)', borderRadius: 2 }}>
                            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: bajo ? 'var(--red)' : pct > 50 ? 'var(--green)' : 'var(--yellow)', transition: 'width 0.5s' }} />
                          </div>
                        </div>
                      </td>
                      <td className="muted">{p.stock_alerta}</td>
                      <td>{bajo ? <span className="badge badge-red"><AlertTriangle size={9} /> Bajo</span> : <span className="badge badge-green">OK</span>}</td>
                      <td><span className={`badge ${p.grupo_envio === 'A' ? 'badge-blue' : 'badge-accent'}`}>Grupo {p.grupo_envio}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => setModalProducto(p)} title="Editar producto/precios">
                            <Edit2 size={12} /> Editar
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setModalCompra(p)}>
                            <Plus size={12} /> Stock
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Cards layout (visible always, table hidden via CSS on mobile) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {loading ? (
              [...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 80, borderRadius: 10 }} />)
            ) : productos.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon"><Package size={22} /></div>
                <p className="empty-state-title">Sin productos</p>
                <button className="btn btn-primary btn-sm" onClick={() => setModalProducto('nuevo')}>
                  <Plus size={13} /> Agregar primer producto
                </button>
              </div>
            ) : productos.map(p => {
              const bajo = p.stock_actual <= p.stock_alerta
              const pct = Math.min(100, (p.stock_actual / Math.max(p.stock_alerta * 3, 1)) * 100)
              return (
                <div key={p.id} className="card card-sm" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* Row 1: nombre + badges */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{p.nombre}</span>
                    <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                      <span className={`badge ${p.grupo_envio === 'A' ? 'badge-blue' : 'badge-accent'}`}>G{p.grupo_envio}</span>
                      {bajo ? <span className="badge badge-red"><AlertTriangle size={9} /> Bajo</span> : <span className="badge badge-green">OK</span>}
                    </div>
                  </div>

                  {/* Row 2: stock bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: bajo ? 'var(--red)' : 'var(--accent)', minWidth: 36 }}>
                      {p.stock_actual}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                        <span>Stock actual</span>
                        <span>Alerta: {p.stock_alerta}</span>
                      </div>
                      <div style={{ height: 5, background: 'var(--bg-hover)', borderRadius: 3 }}>
                        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: bajo ? 'var(--red)' : pct > 50 ? 'var(--green)' : 'var(--yellow)', transition: 'width 0.5s' }} />
                      </div>
                    </div>
                  </div>

                  {/* Row 3: precios */}
                  <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Costo </span>
                      <span style={{ fontWeight: 600 }}>{formatGs(p.costo_unit)}</span>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>1u </span>
                      <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{formatGs(p.precio_1u)}</span>
                    </div>
                    {p.precio_2u > 0 && (
                      <div>
                        <span style={{ color: 'var(--text-muted)' }}>2u </span>
                        <span style={{ fontWeight: 600 }}>{formatGs(p.precio_2u)}</span>
                      </div>
                    )}
                  </div>

                  {/* Row 4: acciones */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-ghost btn-sm" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setModalProducto(p)}>
                      <Edit2 size={12} /> Editar / Precios
                    </button>
                    <button className="btn btn-primary btn-sm" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setModalCompra(p)}>
                      <Plus size={12} /> Agregar stock
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {activeTab === 'historial' && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Producto</th>
                <th>Tipo</th>
                <th>Cant.</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {movimientos.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>Sin movimientos</td></tr>
              ) : movimientos.map(m => (
                <tr key={m.id}>
                  <td className="muted">{new Date(m.created_at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}</td>
                  <td style={{ fontWeight: 500 }}>{m.producto_nombre}</td>
                  <td><span className={`badge ${m.tipo === 'compra' ? 'badge-green' : m.tipo === 'venta' ? 'badge-blue' : m.tipo === 'devolucion' ? 'badge-yellow' : 'badge-gray'}`}>{m.tipo}</span></td>
                  <td style={{ fontWeight: 700, color: m.tipo === 'compra' || m.tipo === 'devolucion' ? 'var(--green)' : 'var(--red)' }}>
                    {m.tipo === 'compra' || m.tipo === 'devolucion' ? '+' : '-'}{m.cantidad}
                  </td>
                  <td className="muted">{m.motivo || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalCompra && <CompraModal producto={modalCompra} onClose={() => setModalCompra(null)} onSaved={cargar} />}
      {modalProducto && (
        <ProductoModal
          producto={modalProducto === 'nuevo' ? null : modalProducto}
          onClose={() => setModalProducto(null)}
          onSaved={cargar}
        />
      )}
    </div>
  )
}
