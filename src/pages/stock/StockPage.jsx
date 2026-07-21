// src/pages/stock/StockPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { calcularStockCombo, aplicarStockLoteNuevasVentas, calcularDiferencias, aplicarConteoFisico } from '../../lib/stockEngine'
import { calcularCostoPonderado, calcularCostoCombo } from '../../lib/costoPonderado'
import { calcularVelocidades, analizarReposicion, sugerirReposicion, URGENCIA_CFG } from '../../lib/stockIntel'
import { Package, Plus, TrendingDown, AlertTriangle, Edit2, X, Save, Layers, Clock, TrendingUp, CheckCircle } from 'lucide-react'

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
    if (error) { toast('Error: ' + error.message, 'error'); setLoading(false); return }
    // Si al editar cambió el stock a mano, dejar rastro auditable en el historial.
    // Tipo 'ajuste': no es una compra ni una venta, es una corrección.
    if (!esNuevo && producto && data.stock_actual !== producto.stock_actual) {
      const delta = data.stock_actual - producto.stock_actual
      try {
        await supabase.from('stock_movimientos').insert({
          producto_id: producto.id, producto_nombre: data.nombre,
          tipo: 'ajuste', cantidad: Math.abs(delta),
          motivo: `Ajuste manual: ${producto.stock_actual} → ${data.stock_actual} (${delta > 0 ? '+' : '−'}${Math.abs(delta)})`,
        })
      } catch (e) { /* el stock ya quedó guardado */ }
    }
    toast(esNuevo ? 'Producto creado' : 'Producto actualizado', 'success'); onSaved(); onClose()
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
function CompraModal({ producto, productos, onClose, onSaved }) {
  const { toast } = useToast()
  const [cantidad, setCantidad] = useState('')
  const [costoNuevo, setCostoNuevo] = useState('')
  const [motivo, setMotivo] = useState('Compra de mercadería')
  const [loading, setLoading] = useState(false)

  const cant = parseInt(cantidad) || 0
  const costo = parseInt(costoNuevo) || 0
  // Cálculo en vivo del promedio ponderado
  const calc = calcularCostoPonderado(producto.stock_actual, producto.costo_unit, cant, costo)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!cant || cant <= 0) { toast('Ingresá una cantidad válida', 'error'); return }
    setLoading(true)

    // Nuevo costo: si cargaste el costo de la compra, se pondera; si lo dejaste
    // vacío, se mantiene el costo actual (solo suma stock, como antes).
    const nuevoCosto = costo > 0 ? calc.nuevoCosto : producto.costo_unit
    const nuevoStock = producto.stock_actual + cant

    const { error } = await supabase.from('productos')
      .update({ stock_actual: nuevoStock, costo_unit: nuevoCosto })
      .eq('id', producto.id)
    if (error) { toast('Error al actualizar stock', 'error'); setLoading(false); return }

    // Registrar el movimiento; si falla, revertir para no descuadrar
    const motivoFull = costo > 0
      ? `${motivo} · ${cant} uds a ${formatGs(costo)} · costo prom. ${formatGs(producto.costo_unit)} → ${formatGs(nuevoCosto)}`
      : motivo
    const { error: errMov } = await supabase.from('stock_movimientos').insert({
      producto_id: producto.id, producto_nombre: producto.nombre,
      tipo: 'compra', cantidad: cant, motivo: motivoFull,
    })
    if (errMov) {
      await supabase.from('productos').update({ stock_actual: producto.stock_actual, costo_unit: producto.costo_unit }).eq('id', producto.id)
      toast('No se pudo registrar el movimiento — stock sin cambios', 'error')
      setLoading(false); return
    }

    // Si cambió el costo de este producto, recalcular el costo de los combos que lo usan
    if (costo > 0 && nuevoCosto !== producto.costo_unit) {
      try {
        const costoPorId = {}
        for (const p of (productos || [])) costoPorId[p.id] = p.id === producto.id ? nuevoCosto : p.costo_unit
        const combosAfectados = (productos || []).filter(p =>
          p.es_combo && (p.componente_1_id === producto.id || p.componente_2_id === producto.id))
        for (const c of combosAfectados) {
          const costoCombo = calcularCostoCombo(c, costoPorId)
          await supabase.from('productos').update({ costo_unit: costoCombo }).eq('id', c.id)
        }
      } catch (e) { /* el combo se puede recalcular después; el producto ya quedó bien */ }
    }

    toast(costo > 0
      ? `+${cant} uds · costo promedio actualizado a ${formatGs(nuevoCosto)}`
      : `+${cant} unidades agregadas a ${producto.nombre}`, 'success')
    onSaved(); onClose()
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Reponer stock</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--bg-surface)', borderRadius: 8, padding: '12px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{producto.nombre}</span>
              <span style={{ fontWeight: 700, color: producto.stock_actual <= producto.stock_alerta ? 'var(--red)' : 'var(--green)' }}>
                {producto.stock_actual} uds · costo {formatGs(producto.costo_unit)}
              </span>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Unidades que comprás *</label>
            <input className="form-input" type="number" min="1" value={cantidad}
              onChange={e => setCantidad(e.target.value)} required autoFocus placeholder="200" />
          </div>
          <div className="form-group">
            <label className="form-label">Costo por unidad de esta compra</label>
            <input className="form-input" type="number" min="0" value={costoNuevo}
              onChange={e => setCostoNuevo(e.target.value)} placeholder="9000" />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Si lo dejás vacío, solo suma stock y mantiene el costo actual.
            </span>
          </div>
          <div className="form-group">
            <label className="form-label">Motivo</label>
            <input className="form-input" value={motivo} onChange={e => setMotivo(e.target.value)} />
          </div>

          {cant > 0 && (
            <div style={{ fontSize: 13, padding: '10px 14px', background: 'var(--accent-dim)', borderRadius: 8, lineHeight: 1.7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Nuevo stock</span>
                <strong style={{ color: 'var(--accent)' }}>{producto.stock_actual + cant} uds</strong>
              </div>
              {costo > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Nuevo costo promedio</span>
                  <strong style={{ color: 'var(--accent)' }}>
                    {formatGs(producto.costo_unit)} → {formatGs(calc.nuevoCosto)}
                  </strong>
                </div>
              )}
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
  const [velocidades, setVelocidades] = useState({})
  const [loading, setLoading] = useState(true)
  const [modalCompra, setModalCompra] = useState(null)
  const [modalProducto, setModalProducto] = useState(null) // null=cerrado, 'nuevo'=nuevo, objeto=editar
  const [activeTab, setActiveTab] = useState('stock')
  const [confirmSync, setConfirmSync] = useState(false)
  const [sincronizando, setSincronizando] = useState(false)
  const [conteos, setConteos] = useState({})        // { producto_id: valor tipeado }
  const [aplicandoConteo, setAplicandoConteo] = useState(false)
  const [confirmConteo, setConfirmConteo] = useState(false)

  const cargar = useCallback(async () => {
    setLoading(true)
    const [{ data: prods }, { data: movs }] = await Promise.all([
      supabase.from('productos').select('*').eq('activo', true).order('nombre'),
      supabase.from('stock_movimientos').select('*').order('created_at', { ascending: false }).limit(60),
    ])
    setProductos(prods || [])
    setMovimientos(movs || [])
    setLoading(false)
    // Velocidades de venta (predicción) — en segundo plano, no bloquea la pantalla
    try {
      const vel = await calcularVelocidades(prods || [], 30)
      setVelocidades(vel)
    } catch (e) { console.warn('velocidades:', e?.message) }
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const { toast } = useToast()

  // Sincronizar stock: descuenta las ventas que todavía no descontaron
  // (importaciones viejas). Idempotente: las ya descontadas se saltean.
  const sincronizarStock = async () => {
    setSincronizando(true)
    try {
      const ventas = await fetchAll(() => supabase
        .from('ventas')
        .select('id, producto_id, cantidad, estado, n_referencia, stock_descontado')
        .is('deleted_at', null))
      const res = await aplicarStockLoteNuevasVentas(ventas || [])
      if (res.descontadas > 0) {
        toast(`Stock sincronizado: ${res.descontadas} ventas descontadas en ${res.productos} producto${res.productos === 1 ? '' : 's'}`, 'success')
      } else {
        toast('El stock ya estaba sincronizado (no había ventas pendientes de descontar)', 'info')
      }
      setConfirmSync(false)
      cargar()
    } catch (e) {
      toast('Error sincronizando stock: ' + e.message, 'error')
    } finally {
      setSincronizando(false)
    }
  }

  // ── Conteo físico de inventario ──
  const { filas: filasConteo, resumen: resumenConteo } = calcularDiferencias(productos, conteos)

  const aplicarConteo = async () => {
    setAplicandoConteo(true)
    try {
      const res = await aplicarConteoFisico(filasConteo)
      if (res.ajustados > 0) {
        toast(`${res.ajustados} producto${res.ajustados === 1 ? '' : 's'} ajustado${res.ajustados === 1 ? '' : 's'} · ${res.unidades} unidades corregidas`, 'success')
      } else {
        toast('Todo coincide: no hubo nada que ajustar', 'info')
      }
      setConteos({})
      setConfirmConteo(false)
      cargar()
    } catch (e) {
      toast('Error aplicando el conteo: ' + e.message, 'error')
    } finally {
      setAplicandoConteo(false)
    }
  }

  // Mapa de productos por ID (para calcular stock de combos)
  const productosById = productos.reduce((acc, p) => { acc[p.id] = p; return acc }, {})
  // Stock a mostrar: combos = calculado (mín. de componentes); simples = stock real
  const stockMostrado = (p) => p.es_combo ? calcularStockCombo(p, productosById) : p.stock_actual
  // Predicción de reposición por producto
  const prediccion = (p) => analizarReposicion(p, velocidades, productosById)
  // Productos que necesitan reposición (crítico o pronto o agotado), ordenados por urgencia
  const necesitanReposicion = productos
    .map(p => ({ producto: p, analisis: prediccion(p) }))
    .filter(x => ['agotado', 'critico', 'pronto'].includes(x.analisis.urgencia))
    .sort((a, b) => (URGENCIA_CFG[a.analisis.urgencia]?.prioridad ?? 9) - (URGENCIA_CFG[b.analisis.urgencia]?.prioridad ?? 9))
  // Valor de inventario: solo productos simples (los combos no tienen stock propio, evita doble conteo)
  const valorTotal = productos.reduce((s, p) => s + (p.es_combo ? 0 : p.stock_actual * p.costo_unit), 0)
  const bajosAlerta = productos.filter(p => !p.es_combo && p.stock_actual <= p.stock_alerta)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock</h1>
          <p className="page-subtitle">{productos.length} productos · {formatGs(valorTotal)} en inventario</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={() => setConfirmSync(true)} title="Descontar ventas que aún no descontaron stock">
            <TrendingDown size={15} /> Sincronizar
          </button>
          <button className="btn btn-primary" onClick={() => setModalProducto('nuevo')}>
            <Plus size={15} /> Nuevo producto
          </button>
        </div>
      </div>

      {necesitanReposicion.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-hover)' }}>
            <TrendingUp size={15} color="var(--accent)" />
            <span style={{ fontWeight: 700, fontSize: 14 }}>Reposición sugerida</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· según tu ritmo de ventas (últimos 30 días)</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {necesitanReposicion.map(({ producto, analisis }, i) => {
              const cfg = URGENCIA_CFG[analisis.urgencia]
              const sugerido = sugerirReposicion(producto, velocidades, productosById, 30)
              return (
                <div key={producto.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: cfg.color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{producto.nombre}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {analisis.urgencia === 'agotado'
                        ? 'Agotado'
                        : <><Clock size={9} style={{ display: 'inline', verticalAlign: 'middle' }} /> Se acaba en ~{analisis.diasRestantes} día{analisis.diasRestantes !== 1 ? 's' : ''} · vende {analisis.velocidadDia.toFixed(1)}/día</>}
                    </div>
                  </div>
                  <span className="badge" style={{ background: `${cfg.color}22`, color: cfg.color, fontSize: 10, flexShrink: 0 }}>{cfg.label}</span>
                  {sugerido > 0 && (
                    <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 70 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--accent)' }}>+{sugerido}</div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>comprar</div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
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
          <div className="kpi-value">{productos.reduce((s, p) => s + (p.es_combo ? 0 : p.stock_actual), 0)}</div>
          <div className="kpi-sub">En todos los productos</div>
        </div>
      </div>

      <div className="tabs" style={{ alignSelf: 'flex-start' }}>
        <button className={`tab ${activeTab === 'stock' ? 'active' : ''}`} onClick={() => setActiveTab('stock')}>Stock actual</button>
        <button className={`tab ${activeTab === 'conteo' ? 'active' : ''}`} onClick={() => setActiveTab('conteo')}>Conteo físico</button>
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
                  const stockVal = stockMostrado(p)
                  const bajo = !p.es_combo && stockVal <= p.stock_alerta
                  const pct = Math.min(100, (stockVal / Math.max(p.stock_alerta * 3, 1)) * 100)
                  return (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>
                        {p.nombre}
                        {p.es_combo && <span className="badge badge-accent" style={{ marginLeft: 6, fontSize: 9 }}><Layers size={8} /> Combo</span>}
                      </td>
                      <td className="muted">{formatGs(p.costo_unit)}</td>
                      <td style={{ fontWeight: 500 }}>{formatGs(p.precio_1u)}</td>
                      <td className="muted">{p.precio_2u ? formatGs(p.precio_2u) : '—'}</td>
                      <td className="muted">{p.precio_3u ? formatGs(p.precio_3u) : '—'}</td>
                      <td>
                        {p.es_combo ? (
                          <span style={{ fontWeight: 700, color: 'var(--accent)' }} title="Calculado según componentes disponibles">
                            {stockVal} <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>armables</span>
                          </span>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontWeight: 700, color: bajo ? 'var(--red)' : 'var(--text-primary)', minWidth: 24 }}>{stockVal}</span>
                            <div style={{ width: 50, height: 4, background: 'var(--bg-hover)', borderRadius: 2 }}>
                              <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: bajo ? 'var(--red)' : pct > 50 ? 'var(--green)' : 'var(--yellow)', transition: 'width 0.5s' }} />
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="muted">{p.es_combo ? '—' : p.stock_alerta}</td>
                      <td>{p.es_combo ? <span className="badge badge-accent">Auto</span> : bajo ? <span className="badge badge-red"><AlertTriangle size={9} /> Bajo</span> : <span className="badge badge-green">OK</span>}</td>
                      <td><span className={`badge ${p.grupo_envio === 'A' ? 'badge-blue' : 'badge-accent'}`}>Grupo {p.grupo_envio}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => setModalProducto(p)} title="Editar producto/precios">
                            <Edit2 size={12} /> Editar
                          </button>
                          {!p.es_combo && (
                            <button className="btn btn-secondary btn-sm" onClick={() => setModalCompra(p)}>
                              <Plus size={12} /> Reponer
                            </button>
                          )}
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
              const stockVal = stockMostrado(p)
              const bajo = !p.es_combo && stockVal <= p.stock_alerta
              const pct = Math.min(100, (stockVal / Math.max(p.stock_alerta * 3, 1)) * 100)
              return (
                <div key={p.id} className="card card-sm" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* Row 1: nombre + badges */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>
                      {p.nombre}
                      {p.es_combo && <span className="badge badge-accent" style={{ marginLeft: 5, fontSize: 9 }}><Layers size={8} /> Combo</span>}
                    </span>
                    <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                      <span className={`badge ${p.grupo_envio === 'A' ? 'badge-blue' : 'badge-accent'}`}>G{p.grupo_envio}</span>
                      {p.es_combo ? <span className="badge badge-accent">Auto</span> : bajo ? <span className="badge badge-red"><AlertTriangle size={9} /> Bajo</span> : <span className="badge badge-green">OK</span>}
                    </div>
                  </div>

                  {/* Row 2: stock bar (o disponibilidad de combo) */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: bajo ? 'var(--red)' : 'var(--accent)', minWidth: 36 }}>
                      {stockVal}
                    </span>
                    <div style={{ flex: 1 }}>
                      {p.es_combo ? (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          Packs armables según componentes disponibles
                        </div>
                      ) : (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                            <span>Stock actual</span>
                            <span>Alerta: {p.stock_alerta}</span>
                          </div>
                          <div style={{ height: 5, background: 'var(--bg-hover)', borderRadius: 3 }}>
                            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: bajo ? 'var(--red)' : pct > 50 ? 'var(--green)' : 'var(--yellow)', transition: 'width 0.5s' }} />
                          </div>
                        </>
                      )}
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
                    {!p.es_combo && (
                      <button className="btn btn-primary btn-sm" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setModalCompra(p)}>
                        <Plus size={12} /> Reponer stock
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {activeTab === 'conteo' && (
        <>
          <div className="card" style={{ padding: '14px 18px' }}>
            <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
              Contá la mercadería con la mano y cargá el número real. El sistema calcula la diferencia y deja un <strong>ajuste auditable</strong> en el historial — nunca sobrescribe en silencio. Los productos que dejes vacíos no se tocan. Los combos no aparecen: se arman de sus componentes.
            </p>
          </div>

          {resumenConteo.contados > 0 && (
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Contados</div>
                <div className="kpi-value">{resumenConteo.contados}<span style={{ fontSize: 14, color: 'var(--text-muted)' }}>/{resumenConteo.productos}</span></div>
                <div className="kpi-sub">{resumenConteo.coinciden} coinciden con el sistema</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Falta mercadería</div>
                <div className="kpi-value" style={{ color: resumenConteo.faltantes ? 'var(--red)' : 'var(--text-primary)' }}>{resumenConteo.faltantes}</div>
                <div className="kpi-sub">{resumenConteo.unidadesFaltantes} unidades menos de lo esperado</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Sobra mercadería</div>
                <div className="kpi-value" style={{ color: resumenConteo.sobrantes ? 'var(--yellow)' : 'var(--text-primary)' }}>{resumenConteo.sobrantes}</div>
                <div className="kpi-sub">{resumenConteo.unidadesSobrantes} unidades más de lo esperado</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Valor de la diferencia</div>
                <div className="kpi-value" style={{ color: resumenConteo.valorNeto < 0 ? 'var(--red)' : resumenConteo.valorNeto > 0 ? 'var(--green)' : 'var(--text-primary)' }}>
                  {formatGs(resumenConteo.valorNeto)}
                </div>
                <div className="kpi-sub">A costo de compra</div>
              </div>
            </div>
          )}

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="table-wrapper">
              <table className="tabla-responsive">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>Dice el sistema</th>
                    <th>Contaste</th>
                    <th>Diferencia</th>
                    <th>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {filasConteo.map(f => {
                    const sinContar = f.contado === null
                    return (
                      <tr key={f.id}>
                        <td data-label="Producto" style={{ fontWeight: 500 }}>{f.nombre}</td>
                        <td data-label="Dice el sistema" style={{ fontWeight: 600 }}>{f.sistema}</td>
                        <td data-label="Contaste">
                          <input
                            className="form-input"
                            type="number"
                            min="0"
                            inputMode="numeric"
                            placeholder="—"
                            value={conteos[f.id] ?? ''}
                            onChange={e => setConteos(prev => ({ ...prev, [f.id]: e.target.value }))}
                            style={{ width: 90, padding: '6px 8px', fontSize: 14, fontFamily: 'var(--font-display)', textAlign: 'center' }}
                          />
                        </td>
                        <td data-label="Diferencia" style={{ fontWeight: 700, color: sinContar ? 'var(--text-muted)' : f.delta === 0 ? 'var(--green)' : f.delta < 0 ? 'var(--red)' : 'var(--yellow)' }}>
                          {sinContar ? '—' : f.delta === 0 ? 'OK' : `${f.delta > 0 ? '+' : ''}${f.delta}`}
                        </td>
                        <td data-label="Valor" style={{ color: sinContar || f.delta === 0 ? 'var(--text-muted)' : f.valorDelta < 0 ? 'var(--red)' : 'var(--green)', fontSize: 12 }}>
                          {sinContar || f.delta === 0 ? '—' : formatGs(f.valorDelta)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={() => setConfirmConteo(true)} disabled={!resumenConteo.hayCambios || aplicandoConteo}>
              <CheckCircle size={15} /> Aplicar conteo
            </button>
            {Object.keys(conteos).length > 0 && (
              <button className="btn btn-ghost" onClick={() => setConteos({})} disabled={aplicandoConteo}>Limpiar</button>
            )}
            {!resumenConteo.hayCambios && resumenConteo.contados > 0 && (
              <span style={{ fontSize: 12, color: 'var(--green)' }}>Todo coincide con el sistema. Nada que ajustar.</span>
            )}
          </div>
        </>
      )}

      {activeTab === 'historial' && (
        <div className="table-wrapper">
          <table className="tabla-responsive">
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
                  <td data-label="Fecha" className="muted">{new Date(m.created_at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}</td>
                  <td data-label="Producto" style={{ fontWeight: 500 }}>{m.producto_nombre}</td>
                  <td data-label="Tipo"><span className={`badge ${m.tipo === 'compra' ? 'badge-green' : m.tipo === 'venta' ? 'badge-blue' : m.tipo === 'devolucion' ? 'badge-yellow' : 'badge-gray'}`}>{m.tipo}</span></td>
                  <td data-label="Cant." style={{ fontWeight: 700, color: m.tipo === 'compra' || m.tipo === 'devolucion' ? 'var(--green)' : 'var(--red)' }}>
                    {m.tipo === 'compra' || m.tipo === 'devolucion' ? '+' : '-'}{m.cantidad}
                  </td>
                  <td data-label="Motivo" className="muted">{m.motivo || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalCompra && <CompraModal producto={modalCompra} productos={productos} onClose={() => setModalCompra(null)} onSaved={cargar} />}
      {modalProducto && (
        <ProductoModal
          producto={modalProducto === 'nuevo' ? null : modalProducto}
          onClose={() => setModalProducto(null)}
          onSaved={cargar}
        />
      )}

      {confirmConteo && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !aplicandoConteo && setConfirmConteo(false)}>
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">Aplicar conteo físico</h2>
              {!aplicandoConteo && <button className="modal-close" onClick={() => setConfirmConteo(false)}><X size={18} /></button>}
            </div>
            <div style={{ padding: '4px 4px 8px' }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 0 }}>
                Se van a ajustar <strong>{filasConteo.filter(f => f.contado !== null && f.delta !== 0).length} producto(s)</strong> para que el stock refleje lo que contaste.
              </p>
              <div style={{ maxHeight: 220, overflowY: 'auto', margin: '10px 0' }}>
                {filasConteo.filter(f => f.contado !== null && f.delta !== 0).map(f => (
                  <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: 12.5 }}>
                    <span style={{ fontWeight: 500 }}>{f.nombre}</span>
                    <span className="muted">{f.sistema} → <strong style={{ color: 'var(--text-primary)' }}>{f.contado}</strong></span>
                    <span style={{ fontWeight: 700, color: f.delta < 0 ? 'var(--red)' : 'var(--yellow)', minWidth: 46, textAlign: 'right' }}>
                      {f.delta > 0 ? '+' : ''}{f.delta}
                    </span>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 0 }}>
                Cada ajuste queda registrado en el historial con el antes y el después. Los productos que dejaste vacíos no se tocan.
                {resumenConteo.valorNeto !== 0 && (
                  <> Impacto en el valor del inventario: <strong style={{ color: resumenConteo.valorNeto < 0 ? 'var(--red)' : 'var(--green)' }}>{formatGs(resumenConteo.valorNeto)}</strong>.</>
                )}
              </p>
            </div>
            <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
              <button className="btn btn-ghost" onClick={() => setConfirmConteo(false)} disabled={aplicandoConteo}>Cancelar</button>
              <button className="btn btn-primary" onClick={aplicarConteo} disabled={aplicandoConteo}>
                {aplicandoConteo ? 'Aplicando…' : 'Aplicar y registrar ajustes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmSync && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !sincronizando && setConfirmSync(false)}>
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">Sincronizar stock</h2>
              {!sincronizando && <button className="modal-close" onClick={() => setConfirmSync(false)}><X size={18} /></button>}
            </div>
            <div style={{ padding: '4px 4px 8px' }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 0 }}>
                Esto descuenta del stock todas las ventas que todavía no lo hicieron (las importaciones que nunca descontaron). Corrige tu inventario para que refleje lo que realmente tenés.
              </p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Es seguro: solo toca las ventas pendientes de descontar (las ya contadas se saltean), así que podés correrlo sin miedo a descontar dos veces. Las ventas devueltas no se descuentan.
              </p>
            </div>
            <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
              <button className="btn btn-ghost" onClick={() => setConfirmSync(false)} disabled={sincronizando}>Cancelar</button>
              <button className="btn btn-primary" onClick={sincronizarStock} disabled={sincronizando}>
                {sincronizando ? 'Sincronizando…' : 'Sincronizar ahora'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
