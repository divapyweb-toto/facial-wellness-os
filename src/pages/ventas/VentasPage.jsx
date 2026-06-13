// src/pages/ventas/VentasPage.jsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, formatGs, estadoConfig } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Plus, Search, X, Clock, Trash2, Edit2, Save } from 'lucide-react'

const CANALES = ['Meta Ads', 'TikTok', 'Instagram', 'WhatsApp', 'Shopify Orgánico', 'Otro']
const ESTADOS = ['todos', 'pendiente', 'entregado', 'devuelto', 'en_tramite']

function SearchSelect({ value, onChange, options, placeholder }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef()

  useEffect(() => {
    const found = options.find(o => o.value === value)
    setQuery(found ? found.label : '')
  }, [value, options])

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = options.filter(o =>
    o.label.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 20)

  const handleSelect = (opt) => {
    onChange(opt.value)
    setQuery(opt.label)
    setOpen(false)
  }

  const handleClear = () => { onChange(''); setQuery(''); setOpen(false) }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
        <input
          className="form-input"
          style={{ paddingLeft: 30, paddingRight: query ? 30 : 12 }}
          placeholder={placeholder}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
        />
        {query && (
          <button type="button" onClick={handleClear} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2 }}>
            <X size={13} />
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 999,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: '6px', marginTop: 4,
          maxHeight: 220, overflowY: 'auto',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}>
          {filtered.map((opt, i) => (
            <button key={i} type="button"
              onMouseDown={() => handleSelect(opt)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '9px 12px', background: 'none', border: 'none',
                cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)',
                borderBottom: i < filtered.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              {opt.label}
              {opt.sub && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>{opt.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NuevaVentaModal({ onClose, onSaved }) {
  const { toast } = useToast()
  const [productos, setProductos] = useState([])
  const [metodosPago, setMetodosPago] = useState([])
  const [metodosEnvio, setMetodosEnvio] = useState([])
  const [ciudades, setCiudades] = useState([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    fecha: new Date().toISOString().split('T')[0],
    producto_id: '',
    cantidad: 1,
    n_referencia: '',
    estado: 'pendiente',
    metodo_pago_id: '',
    metodo_envio_id: '',
    canal_origen: 'Meta Ads',
    ciudad: '',
    descripcion: '',
  })
  const [productoSel, setProductoSel] = useState(null)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    Promise.all([
      supabase.from('productos').select('*').eq('activo', true).order('nombre'),
      supabase.from('metodos_pago').select('*').eq('activo', true),
      supabase.from('metodos_envio').select('*').eq('activo', true),
      supabase.from('ciudades').select('nombre, zona').eq('activo', true).order('nombre'),
    ]).then(([p, mp, me, c]) => {
      setProductos(p.data || [])
      setMetodosPago(mp.data || [])
      setMetodosEnvio(me.data || [])
      setCiudades(c.data || [])
      if (mp.data?.length) setForm(f => ({ ...f, metodo_pago_id: mp.data[0].id }))
      if (me.data?.length) setForm(f => ({ ...f, metodo_envio_id: me.data[0].id }))
    })
  }, [])

  useEffect(() => {
    if (!productoSel) { setTotal(0); return }
    let precio = productoSel.precio_1u
    if (form.cantidad == 2) precio = productoSel.precio_2u || productoSel.precio_1u
    if (form.cantidad >= 3) precio = productoSel.precio_3u || productoSel.precio_1u
    setTotal(precio)
  }, [productoSel, form.cantidad])

  const handleProdChange = (id) => {
    const p = productos.find(x => x.id === id)
    setProductoSel(p || null)
    setForm(f => ({ ...f, producto_id: id }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.producto_id) { toast('Seleccioná un producto', 'error'); return }
    setLoading(true)
    const envioSel = form.metodo_envio_id
      ? (await supabase.from('metodos_envio').select('*').eq('id', form.metodo_envio_id).single()).data
      : null
    const metodoPagoNombre = metodosPago.find(m => m.id === form.metodo_pago_id)?.nombre || ''
    const costoEnvio = envioSel?.costo_propio || 27000
    const envioCliente = productoSel?.grupo_envio === 'A' ? (envioSel?.costo_cliente || 29000) : 0

    const { error } = await supabase.from('ventas').insert({
      ...form,
      producto_nombre: productoSel.nombre,
      precio_unit: total,
      total: total + envioCliente, // lo que paga el cliente, incluye envío (grupo A) — igual que Shopify
      costo_prod: productoSel.costo_unit * form.cantidad,
      costo_envio: costoEnvio,
      envio_cliente: envioCliente,
      metodo_pago_nombre: metodoPagoNombre,
      metodo_envio_nombre: envioSel?.nombre || '',
    })
    if (error) toast('Error: ' + error.message, 'error')
    else { toast('Venta registrada', 'success'); onSaved(); onClose() }
    setLoading(false)
  }

  const productosOpts = productos.map(p => ({ value: p.id, label: p.nombre, sub: `Stock: ${p.stock_actual}` }))
  const ciudadesOpts = ciudades.map(c => ({ value: c.nombre, label: c.nombre, sub: c.zona }))

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2 className="modal-title">Registrar nueva venta</h2>
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
              <label className="form-label">N° Referencia</label>
              <input className="form-input" placeholder="Ej: 1520" value={form.n_referencia}
                onChange={e => setForm(f => ({ ...f, n_referencia: e.target.value }))} />
            </div>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Producto *</label>
              <SearchSelect value={form.producto_id} onChange={handleProdChange} options={productosOpts} placeholder="Buscar producto..." />
            </div>
            <div className="form-group">
              <label className="form-label">Cantidad</label>
              <select className="form-select" value={form.cantidad}
                onChange={e => setForm(f => ({ ...f, cantidad: parseInt(e.target.value) }))}>
                <option value={1}>1 unidad</option>
                <option value={2}>2 unidades</option>
                <option value={3}>3 unidades</option>
              </select>
            </div>
          </div>

          {productoSel && (() => {
            const envSel = metodosEnvio.find(m => m.id === form.metodo_envio_id)
            const envioCli = productoSel.grupo_envio === 'A' ? (envSel?.costo_cliente || 29000) : 0
            const costoEnv = envSel?.costo_propio || 27000
            const costoProd = productoSel.costo_unit * form.cantidad
            const totalCliente = total + envioCli
            const margenEst = totalCliente - costoProd - costoEnv
            return (
              <div style={{ background: 'var(--accent-dim)', border: '1px solid rgba(200,241,53,0.2)', borderRadius: 8, padding: '12px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>Total que paga el cliente{envioCli > 0 ? ' (con envío)' : ''}</span>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, color: 'var(--accent)' }}>{formatGs(totalCliente)}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                  Producto: {formatGs(total)}{envioCli > 0 ? ` + envío ${formatGs(envioCli)}` : ''} · Costo: {formatGs(costoProd)} · Grupo: {productoSel.grupo_envio} · Margen est.: {formatGs(margenEst)}
                </div>
              </div>
            )
          })()}

          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Estado</label>
              <select className="form-select" value={form.estado} onChange={e => setForm(f => ({ ...f, estado: e.target.value }))}>
                <option value="pendiente">Pendiente</option>
                <option value="entregado">Entregado</option>
                <option value="devuelto">Devuelto</option>
                <option value="en_tramite">En trámite</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Canal de origen</label>
              <select className="form-select" value={form.canal_origen} onChange={e => setForm(f => ({ ...f, canal_origen: e.target.value }))}>
                {CANALES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Método de pago</label>
              <select className="form-select" value={form.metodo_pago_id} onChange={e => setForm(f => ({ ...f, metodo_pago_id: e.target.value }))}>
                {metodosPago.map(m => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Transportadora</label>
              <select className="form-select" value={form.metodo_envio_id} onChange={e => setForm(f => ({ ...f, metodo_envio_id: e.target.value }))}>
                {metodosEnvio.map(m => <option key={m.id} value={m.id}>{m.nombre}</option>)}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Ciudad destino</label>
            <SearchSelect value={form.ciudad} onChange={(v) => setForm(f => ({ ...f, ciudad: v }))} options={ciudadesOpts} placeholder="Buscar ciudad..." />
          </div>

          <div className="form-group">
            <label className="form-label">Descripción / Notas</label>
            <input className="form-input" placeholder="Ej: 2 negros, 1 blanco" value={form.descripcion}
              onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} />
          </div>

          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : 'Registrar venta'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function EditarVentaModal({ venta, onClose, onSaved }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [productos, setProductos] = useState([])
  const [form, setForm] = useState({
    fecha: venta.fecha || '',
    n_referencia: venta.n_referencia || '',
    producto_id: venta.producto_id || '',
    producto_nombre: venta.producto_nombre || '',
    cantidad: venta.cantidad || 1,
    total: venta.total || 0,
    estado: venta.estado || 'pendiente',
    ciudad: venta.ciudad || '',
    cliente_nombre: venta.cliente_nombre || '',
    cliente_telefono: venta.cliente_telefono || '',
    canal_origen: venta.canal_origen || 'Otro',
    costo_prod: venta.costo_prod || 0,
    costo_envio: venta.costo_envio || 0,
    envio_cliente: venta.envio_cliente || 0,
  })

  useEffect(() => {
    supabase.from('productos').select('id, nombre, costo_unit, grupo_envio').eq('activo', true).order('nombre')
      .then(({ data }) => setProductos(data || []))
  }, [])

  const set = (k, val) => setForm(f => ({ ...f, [k]: val }))

  const onProducto = (id) => {
    const p = productos.find(x => x.id === id)
    if (p) setForm(f => ({ ...f, producto_id: p.id, producto_nombre: p.nombre, costo_prod: (p.costo_unit || 0) * (parseInt(f.cantidad) || 1) }))
    else set('producto_id', id)
  }

  const onCantidad = (n) => {
    const cant = parseInt(n) || 1
    const p = productos.find(x => x.id === form.producto_id)
    setForm(f => ({ ...f, cantidad: cant, costo_prod: p ? (p.costo_unit || 0) * cant : f.costo_prod }))
  }

  const guardar = async (e) => {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.from('ventas').update({
      fecha: form.fecha,
      n_referencia: form.n_referencia,
      producto_id: form.producto_id || null,
      producto_nombre: form.producto_nombre,
      cantidad: parseInt(form.cantidad) || 1,
      total: parseInt(form.total) || 0,
      precio_unit: parseInt(form.total) || 0,
      estado: form.estado,
      ciudad: form.ciudad,
      cliente_nombre: form.cliente_nombre,
      cliente_telefono: form.cliente_telefono,
      canal_origen: form.canal_origen,
      costo_prod: parseInt(form.costo_prod) || 0,
      costo_envio: parseInt(form.costo_envio) || 0,
      envio_cliente: parseInt(form.envio_cliente) || 0,
    }).eq('id', venta.id)
    if (error) toast('Error: ' + error.message, 'error')
    else { toast('Venta actualizada', 'success'); onSaved(); onClose() }
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2 className="modal-title">Editar venta {venta.n_referencia ? `#${venta.n_referencia}` : ''}</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={guardar} style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '72vh', overflowY: 'auto' }}>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Fecha</label>
              <input className="form-input" type="date" value={form.fecha} onChange={e => set('fecha', e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label">N° Referencia</label>
              <input className="form-input" value={form.n_referencia} onChange={e => set('n_referencia', e.target.value)} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Producto</label>
            <select className="form-select" value={form.producto_id || ''} onChange={e => onProducto(e.target.value)}>
              <option value="">— {form.producto_nombre || 'Sin vincular'} —</option>
              {productos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          </div>

          <div className="form-grid form-grid-3">
            <div className="form-group">
              <label className="form-label">Cantidad</label>
              <input className="form-input" type="number" min="1" value={form.cantidad} onChange={e => onCantidad(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Total (Gs.)</label>
              <input className="form-input" type="number" value={form.total} onChange={e => set('total', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Estado</label>
              <select className="form-select" value={form.estado} onChange={e => set('estado', e.target.value)}>
                <option value="pendiente">Pendiente</option>
                <option value="entregado">Entregado</option>
                <option value="devuelto">Devuelto</option>
                <option value="en_tramite">En trámite</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Cliente</label>
            <input className="form-input" value={form.cliente_nombre} onChange={e => set('cliente_nombre', e.target.value)} placeholder="Nombre del cliente" />
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Teléfono</label>
              <input className="form-input" value={form.cliente_telefono} onChange={e => set('cliente_telefono', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Ciudad</label>
              <input className="form-input" value={form.ciudad} onChange={e => set('ciudad', e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Canal</label>
            <select className="form-select" value={form.canal_origen} onChange={e => set('canal_origen', e.target.value)}>
              {['Meta Ads', 'TikTok', 'Instagram', 'WhatsApp', 'Shopify Orgánico', 'Otro'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Costos (avanzado)</summary>
            <div className="form-grid form-grid-3">
              <div className="form-group">
                <label className="form-label">Costo producto</label>
                <input className="form-input" type="number" value={form.costo_prod} onChange={e => set('costo_prod', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Costo envío</label>
                <input className="form-input" type="number" value={form.costo_envio} onChange={e => set('costo_envio', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Envío cliente</label>
                <input className="form-input" type="number" value={form.envio_cliente} onChange={e => set('envio_cliente', e.target.value)} />
              </div>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>La ganancia y el margen se recalculan solos.</p>
          </details>

          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <Save size={14} /> {loading ? 'Guardando...' : 'Guardar cambios'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function VentasPage() {
  const { toast } = useToast()
  const [ventas, setVentas] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [filtroEstado, setFiltroEstado] = useState('todos')
  const [busqueda, setBusqueda] = useState('')
  const [filtroMes, setFiltroMes] = useState('')
  const [seleccionadas, setSeleccionadas] = useState(new Set())
  const [editando, setEditando] = useState(null)

  const cargarVentas = useCallback(async () => {
    setLoading(true)
    let query = supabase.from('ventas').select('*').order('fecha', { ascending: false }).order('created_at', { ascending: false })
    if (filtroEstado !== 'todos') query = query.eq('estado', filtroEstado)
    if (filtroMes) {
      const [year, month] = filtroMes.split('-')
      const inicio = `${year}-${month}-01`
      const fin = new Date(year, parseInt(month), 0).toISOString().split('T')[0]
      query = query.gte('fecha', inicio).lte('fecha', fin)
    }
    const { data } = await query.limit(200)
    let resultado = data || []
    if (busqueda) {
      const b = busqueda.toLowerCase()
      resultado = resultado.filter(v =>
        v.producto_nombre?.toLowerCase().includes(b) ||
        v.n_referencia?.toLowerCase().includes(b) ||
        v.ciudad?.toLowerCase().includes(b)
      )
    }
    setVentas(resultado)
    setSeleccionadas(new Set())
    setLoading(false)
  }, [filtroEstado, busqueda, filtroMes])

  useEffect(() => { cargarVentas() }, [cargarVentas])

  const cambiarEstado = async (id, nuevoEstado) => {
    const { error } = await supabase.from('ventas').update({ estado: nuevoEstado }).eq('id', id)
    if (error) toast('Error al actualizar', 'error')
    else { toast('Estado actualizado', 'success'); cargarVentas() }
  }

  const eliminar = async (id) => {
    if (!confirm('¿Eliminar esta venta?')) return
    await supabase.from('ventas').delete().eq('id', id)
    toast('Venta eliminada', 'info')
    cargarVentas()
  }

  const toggleSel = (id) => {
    setSeleccionadas(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }
  const todasSeleccionadas = ventas.length > 0 && seleccionadas.size === ventas.length
  const toggleTodas = () => setSeleccionadas(todasSeleccionadas ? new Set() : new Set(ventas.map(v => v.id)))

  const eliminarMasivo = async () => {
    const ids = [...seleccionadas]
    if (!ids.length) return
    if (!confirm(`¿Eliminar ${ids.length} venta(s)? Esta acción no se puede deshacer.`)) return
    const { error } = await supabase.from('ventas').delete().in('id', ids)
    if (error) toast('Error al eliminar: ' + error.message, 'error')
    else { toast(`${ids.length} venta(s) eliminada(s)`, 'info'); cargarVentas() }
  }

  const totalVentas = ventas.filter(v => v.estado === 'entregado').reduce((s, v) => s + v.total, 0)
  const totalNeto = ventas.filter(v => v.estado === 'entregado').reduce((s, v) => s + v.ganancia_neta, 0)

  const mesesDisponibles = []
  for (let i = 0; i < 6; i++) {
    const d = new Date(); d.setMonth(d.getMonth() - i)
    mesesDisponibles.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('es-PY', { month: 'short', year: 'numeric' }),
    })
  }

  const diasSinResolver = (fecha) => Math.floor((new Date() - new Date(fecha + 'T00:00:00')) / (1000 * 60 * 60 * 24))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Ventas</h1>
          <p className="page-subtitle">{ventas.length} registros · {formatGs(totalVentas)} · Neto: {formatGs(totalNeto)}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            <Plus size={15} /> Nueva venta
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1', minWidth: 180 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input className="form-input" style={{ paddingLeft: 30 }} placeholder="Buscar producto, ref, ciudad..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <div className="tabs">
          {ESTADOS.map(e => (
            <button key={e} className={`tab ${filtroEstado === e ? 'active' : ''}`} onClick={() => setFiltroEstado(e)}>
              {e === 'todos' ? 'Todos' : e === 'en_tramite' ? 'En trámite' : e.charAt(0).toUpperCase() + e.slice(1)}
            </button>
          ))}
        </div>
        <select className="form-select" style={{ width: 'auto' }} value={filtroMes} onChange={e => setFiltroMes(e.target.value)}>
          <option value="">Todos los meses</option>
          {mesesDisponibles.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      {seleccionadas.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px', background: 'var(--accent-dim)', border: '1px solid rgba(200,241,53,0.3)', borderRadius: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{seleccionadas.size} venta(s) seleccionada(s)</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setSeleccionadas(new Set())}>Deseleccionar</button>
            <button className="btn btn-sm" onClick={eliminarMasivo} style={{ background: 'var(--red)', color: '#fff' }}>
              <Trash2 size={13} /> Eliminar {seleccionadas.size}
            </button>
          </div>
        </div>
      )}

      <div className="table-wrapper">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Cargando...</div>
        ) : ventas.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Plus size={22} /></div>
            <p className="empty-state-title">Sin ventas</p>
            <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}><Plus size={13} /> Nueva venta</button>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }}><input type="checkbox" checked={todasSeleccionadas} onChange={toggleTodas} style={{ cursor: 'pointer' }} /></th>
                <th>Fecha</th>
                <th>Ref.</th>
                <th>Producto</th>
                <th>Cant.</th>
                <th>Total</th>
                <th>Ganancia</th>
                <th>Estado</th>
                <th>Ciudad</th>
                <th>Canal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ventas.map(v => {
                const cfg = estadoConfig[v.estado]
                const dias = v.estado === 'pendiente' ? diasSinResolver(v.fecha) : null
                return (
                  <tr key={v.id} style={seleccionadas.has(v.id) ? { background: 'var(--accent-dim)' } : undefined}>
                    <td><input type="checkbox" checked={seleccionadas.has(v.id)} onChange={() => toggleSel(v.id)} style={{ cursor: 'pointer' }} /></td>
                    <td className="muted">{new Date(v.fecha + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}</td>
                    <td className="mono">{v.n_referencia || '—'}</td>
                    <td style={{ fontWeight: 500 }}>{v.producto_nombre}</td>
                    <td className="muted">{v.cantidad}</td>
                    <td style={{ fontWeight: 600 }}>{formatGs(v.total)}</td>
                    <td style={{ color: v.estado === 'entregado' ? 'var(--green)' : 'var(--text-muted)', fontWeight: 500 }}>
                      {v.estado === 'entregado' ? formatGs(v.ganancia_neta) : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <select value={v.estado} onChange={e => cambiarEstado(v.id, e.target.value)}
                          style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}40`, borderRadius: 20, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-body)', appearance: 'none' }}>
                          <option value="pendiente">Pendiente</option>
                          <option value="entregado">Entregado</option>
                          <option value="devuelto">Devuelto</option>
                          <option value="en_tramite">En trámite</option>
                        </select>
                        {dias !== null && dias >= 5 && <Clock size={12} color="var(--red)" title={`${dias} días`} />}
                      </div>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{v.ciudad || '—'}</td>
                    <td><span className="badge badge-gray" style={{ fontSize: 10 }}>{v.canal_origen}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: 2 }}>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditando(v)} style={{ color: 'var(--accent)' }} title="Editar">
                          <Edit2 size={13} />
                        </button>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => eliminar(v.id)} style={{ color: 'var(--red)', opacity: 0.6 }} title="Eliminar">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {showModal && <NuevaVentaModal onClose={() => setShowModal(false)} onSaved={cargarVentas} />}
      {editando && <EditarVentaModal venta={editando} onClose={() => setEditando(null)} onSaved={cargarVentas} />}
    </div>
  )
}
