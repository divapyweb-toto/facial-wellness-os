// src/pages/clientes/ClientesPage.jsx
import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { Users, Search, TrendingUp, Star, ShoppingBag, X, Phone, MapPin } from 'lucide-react'

// Normaliza teléfono para agrupar al mismo cliente
function normalizarTel(t) {
  if (!t) return ''
  let s = String(t).replace(/\D/g, '')
  if (s.startsWith('595')) s = '0' + s.slice(3)
  if (s && !s.startsWith('0')) s = '0' + s
  return s
}

const fmtFecha = (f) => f ? new Date(f + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'

function ClienteDetalle({ cliente, onClose }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2 className="modal-title">{cliente.nombre || 'Cliente sin nombre'}</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-secondary)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Phone size={13} /> {cliente.telefono || '—'}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><MapPin size={13} /> {cliente.ciudad || '—'}</span>
          </div>
          <div className="kpi-grid">
            <div className="kpi-card"><div className="kpi-label">LTV</div><div className="kpi-value green" style={{ fontSize: 16 }}>{formatGs(cliente.ltv)}</div><div className="kpi-sub">{cliente.entregados} entregados</div></div>
            <div className="kpi-card"><div className="kpi-label">Ganancia generada</div><div className="kpi-value" style={{ fontSize: 16 }}>{formatGs(cliente.ganancia)}</div><div className="kpi-sub">Neto que te dejó</div></div>
            <div className="kpi-card"><div className="kpi-label">Pedidos</div><div className="kpi-value" style={{ fontSize: 16 }}>{cliente.pedidos}</div><div className="kpi-sub">{cliente.devueltos} devueltos</div></div>
          </div>
          <div className="table-wrapper" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="tabla-responsive">
              <thead><tr><th>Fecha</th><th>Producto</th><th>Total</th><th>Estado</th></tr></thead>
              <tbody>
                {cliente.compras.map((c, i) => (
                  <tr key={i}>
                    <td data-label="Fecha" className="muted">{fmtFecha(c.fecha)}</td>
                    <td data-label="Producto" style={{ fontSize: 12 }}>{c.producto_nombre}</td>
                    <td data-label="Total" style={{ fontWeight: 600 }}>{formatGs(c.total)}</td>
                    <td data-label="Estado"><span className="badge badge-gray" style={{ fontSize: 10 }}>{c.estado}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ClientesPage() {
  const [ventas, setVentas] = useState([])
  const [loading, setLoading] = useState(true)
  const [busqueda, setBusqueda] = useState('')
  const [detalle, setDetalle] = useState(null)

  const cargar = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('ventas')
      .select('cliente_nombre, cliente_telefono, ciudad, producto_nombre, total, estado, fecha, ganancia_neta, envio_cliente')
      .order('fecha', { ascending: false })
      .limit(5000)
    setVentas(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  // Derivar clientes desde las ventas (agrupados por teléfono)
  const clientes = useMemo(() => {
    const map = {}
    ventas.forEach(v => {
      const tel = normalizarTel(v.cliente_telefono)
      const key = tel || (v.cliente_nombre || '').toLowerCase().trim()
      if (!key) return
      if (!map[key]) map[key] = { key, nombre: '', telefono: tel, ciudad: '', pedidos: 0, entregados: 0, devueltos: 0, ltv: 0, ganancia: 0, ultima: '', compras: [] }
      const c = map[key]
      c.pedidos++
      if (!c.nombre && v.cliente_nombre) c.nombre = v.cliente_nombre
      if (!c.ciudad && v.ciudad) c.ciudad = v.ciudad
      if ((v.fecha || '') > c.ultima) c.ultima = v.fecha || ''
      if (v.estado === 'entregado') { c.entregados++; c.ltv += (v.total || 0); c.ganancia += (v.ganancia_neta || 0) + (v.envio_cliente || 0) }
      if (v.estado === 'devuelto') c.devueltos++
      c.compras.push(v)
    })
    return Object.values(map).sort((a, b) => b.ltv - a.ltv)
  }, [ventas])

  const filtrados = useMemo(() => {
    if (!busqueda) return clientes
    const b = busqueda.toLowerCase()
    return clientes.filter(c =>
      (c.nombre || '').toLowerCase().includes(b) ||
      (c.telefono || '').includes(b) ||
      (c.ciudad || '').toLowerCase().includes(b)
    )
  }, [clientes, busqueda])

  const conCompras = useMemo(() => clientes.filter(c => c.entregados > 0), [clientes])
  const ltvTotal = useMemo(() => clientes.reduce((s, c) => s + c.ltv, 0), [clientes])
  const ltvProm = conCompras.length ? ltvTotal / conCompras.length : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Clientes</h1>
          <p className="page-subtitle">{clientes.length} clientes · se arman solos desde tus ventas</p>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label"><Users size={11} /> Total clientes</div><div className="kpi-value">{clientes.length}</div><div className="kpi-sub">Únicos por teléfono</div></div>
        <div className="kpi-card"><div className="kpi-label"><TrendingUp size={11} /> LTV total</div><div className="kpi-value green">{formatGs(ltvTotal)}</div><div className="kpi-sub">Cobrado histórico</div></div>
        <div className="kpi-card"><div className="kpi-label"><Star size={11} /> LTV promedio</div><div className="kpi-value">{formatGs(ltvProm)}</div><div className="kpi-sub">Por cliente con compras</div></div>
        <div className="kpi-card"><div className="kpi-label"><ShoppingBag size={11} /> Con compras</div><div className="kpi-value">{conCompras.length}</div><div className="kpi-sub">Al menos 1 entregado</div></div>
      </div>

      <div style={{ position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input className="form-input" style={{ paddingLeft: 34 }} placeholder="Buscar por nombre, teléfono o ciudad..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
      </div>

      <div className="table-wrapper">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Cargando...</div>
        ) : filtrados.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Users size={22} /></div>
            <p className="empty-state-title">Sin clientes todavía</p>
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Cargá ventas y los clientes aparecen acá automáticamente.</p>
          </div>
        ) : (
          <table className="tabla-responsive">
            <thead>
              <tr><th>Cliente</th><th>Teléfono</th><th>Ciudad</th><th>Pedidos</th><th>Entregados</th><th>LTV</th><th>Última</th></tr>
            </thead>
            <tbody>
              {filtrados.slice(0, 200).map(c => (
                <tr key={c.key} style={{ cursor: 'pointer' }} onClick={() => setDetalle(c)}>
                  <td data-label="Cliente" style={{ fontWeight: 600 }}>{c.nombre || '—'}</td>
                  <td data-label="Teléfono" className="mono" style={{ fontSize: 12 }}>{c.telefono || '—'}</td>
                  <td data-label="Ciudad" className="muted" style={{ fontSize: 12 }}>{c.ciudad || '—'}</td>
                  <td data-label="Pedidos">{c.pedidos}</td>
                  <td data-label="Entregados" style={{ color: 'var(--green)' }}>{c.entregados}</td>
                  <td data-label="LTV" style={{ fontWeight: 600 }}>{formatGs(c.ltv)}</td>
                  <td data-label="Última" className="muted" style={{ fontSize: 12 }}>{fmtFecha(c.ultima)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {filtrados.length > 200 && (
        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Mostrando los 200 con mayor LTV de {filtrados.length}. Usá el buscador para encontrar al resto.</p>
      )}

      {detalle && <ClienteDetalle cliente={detalle} onClose={() => setDetalle(null)} />}
    </div>
  )
}
