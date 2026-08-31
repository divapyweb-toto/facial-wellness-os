// src/pages/ventas/VentasPage.jsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase, formatGs, estadoConfig, getEstadoConfig } from '../../lib/supabase'
import { costoFleteActual } from '../../lib/flete'
import { getEnvioCliente } from '../../lib/config'
import { useToast } from '../../lib/toast'
import { aplicarStockNuevaVenta, aplicarStockCambioEstado, aplicarStockEdicion, devolverStockPorBorrado } from '../../lib/stockEngine'
import { precioSugerido, precioUnitarioSugerido, totalLinea, avisoPrecio, proximaReferenciaWA, totalesPedido, filasDeVenta } from '../../lib/pedidos'
import { normalizarRef, normalizarTel } from '../../lib/referencias'
import { fetchAll } from '../../lib/fetchAll'
import { logError } from '../../lib/errorLog'
import ModalErrorBoundary from '../../lib/ModalErrorBoundary'
import { validarVenta } from '../../lib/validation'
import { logAccion, logAccionLote } from '../../lib/audit'
import { Plus, Search, X, Clock, Trash2, Edit2, Save, AlertTriangle } from 'lucide-react'
import { hoyLocal } from '../../lib/fechas'

const CANALES = ['Meta Ads', 'TikTok', 'Instagram', 'WhatsApp', 'Shopify Orgánico', 'Otro']
const ESTADOS = ['todos', 'pendiente', 'entregado', 'devuelto', 'en_tramite']

function SearchSelect({ value, onChange, options, placeholder }) {
  const opts = Array.isArray(options) ? options : []
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef()

  useEffect(() => {
    const found = opts.find(o => o.value === value)
    setQuery(found ? found.label : '')
  }, [value, opts])

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = opts.filter(o =>
    (o?.label || '').toLowerCase().includes(query.toLowerCase())
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

// ═══════════════════════════════════════════════════════════
// ALTA DE VENTA — PEDIDOS ABIERTOS
//
// Antes asumía: 1 producto, cantidad 1 a 3 (un desplegable), precio de lista
// no editable. El negocio ya no funciona así — hay mayoristas de 10+10,
// upsells y descuentos.
//
// La regla de diseño: RÁPIDO PARA LO COMÚN, POSIBLE PARA LO RARO.
// Una venta de 1 unidad a precio de lista sigue siendo elegir producto y
// guardar. Las líneas extra, el precio editable y el mayorista solo aparecen
// si los usás.
//
// Y las validaciones AVISAN, no BLOQUEAN: si cargás un precio distinto al de
// lista se muestra la diferencia y se guarda igual. El que decide el precio
// es el dueño del negocio.
// ═══════════════════════════════════════════════════════════
function NuevaVentaModal({ onClose, onSaved }) {
  const { toast } = useToast()
  const [productos, setProductos] = useState([])
  const [metodosPago, setMetodosPago] = useState([])
  const [metodosEnvio, setMetodosEnvio] = useState([])
  const [ciudades, setCiudades] = useState([])
  const [loading, setLoading] = useState(false)
  const [faltaMigracion, setFaltaMigracion] = useState(false)
  const [form, setForm] = useState({
    fecha: hoyLocal(),
    n_referencia: '',
    estado: 'pendiente',
    metodo_pago_id: '',
    metodo_envio_id: '',
    canal_origen: 'Meta Ads',
    ciudad: '',
    cliente_nombre: '',
    cliente_telefono: '',
    cliente_direccion: '',
    descripcion: '',
    es_mayorista: false,
  })
  // Una línea por producto. Arranca con una sola: el caso común es un producto.
  // Cada línea guarda el precio POR UNIDAD; el total de la línea lo calcula el
  // sistema (unitario × cantidad). Escribir el total a mano en un pedido de 20
  // unidades es una invitación a equivocarse.
  const LINEA_VACIA = { producto_id: '', producto_nombre: '', cantidad: 1, precio_unitario: 0, precio: 0, precio_lista: 0, costo_prod: 0, tocado: false }
  const [lineas, setLineas] = useState([{ ...LINEA_VACIA }])
  // Flete gratis: a veces lo lleva un conocido y no hay costo de logística.
  const [fleteGratis, setFleteGratis] = useState(false)

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

  // Recalcula una línea. `tocado` marca que editaste el precio a mano: a
  // partir de ahí cambiar la cantidad ya no lo pisa, porque un precio
  // negociado no se recalcula solo.
  const recalcular = (l, productosLista) => {
    const prod = productosLista.find(x => x.id === l.producto_id)
    if (!prod) return { ...l, producto_nombre: '', precio_unitario: 0, precio: 0, precio_lista: 0, costo_prod: 0 }
    const q = Math.max(1, parseInt(l.cantidad, 10) || 1)
    // El unitario es lo que se escribe; el total de la línea SIEMPRE se deriva.
    // Si ya lo tocaste a mano, cambiar la cantidad no lo pisa: un precio
    // negociado no se recalcula solo.
    const unitario = l.tocado ? (Number(l.precio_unitario) || 0) : precioUnitarioSugerido(prod, q)
    return {
      ...l,
      producto_nombre: prod.nombre,
      precio_unitario: unitario,
      precio: totalLinea(unitario, q),
      precio_lista: precioSugerido(prod, q),
      costo_prod: (prod.costo_unit || 0) * q,
    }
  }
  const setLinea = (i, cambios) => setLineas(ls =>
    ls.map((l, j) => j === i ? recalcular({ ...l, ...cambios }, productos) : l))
  const agregarLinea = () => setLineas(ls => [...ls, { ...LINEA_VACIA }])
  const quitarLinea = (i) => setLineas(ls => ls.length > 1 ? ls.filter((_, j) => j !== i) : ls)

  // El envío se cuenta UNA vez por pedido: es una sola caja. El grupo de
  // envío sale del primer producto cargado.
  const envSel = metodosEnvio.find(m => m.id === form.metodo_envio_id)
  const primerProd = productos.find(p => p.id === lineas[0]?.producto_id)
  const envioCliente = primerProd?.grupo_envio === 'A' ? (envSel?.costo_cliente ?? getEnvioCliente()) : 0
  // ?? en vez de ||: un flete de 0 es válido (courier gratis, lo lleva un
  // conocido). Con || un 0 caía al valor por defecto y era imposible
  // registrar un envío sin costo.
  const costoEnvio = fleteGratis ? 0 : (envSel?.costo_propio ?? costoFleteActual())
  const tot = totalesPedido(lineas, { envioCliente, costoEnvio })

  const handleSubmit = async (e) => {
    e.preventDefault()
    const conProducto = lineas.filter(l => l.producto_id)
    if (!conProducto.length) { toast('Elegí al menos un producto', 'error'); return }
    if (conProducto.some(l => (parseInt(l.cantidad, 10) || 0) < 1)) { toast('La cantidad tiene que ser 1 o más', 'error'); return }
    const errorValidacion = validarVenta({ ...form, producto_id: conProducto[0].producto_id, cantidad: conProducto[0].cantidad })
    if (errorValidacion) { toast(errorValidacion, 'error'); return }

    setLoading(true)
    try {
      // Varias líneas necesitan una referencia común para que el sistema las
      // reconozca como UN pedido. Sin ella quedarían sueltas y el despacho
      // imprimiría una guía por producto.
      // 8.1 · Se genera SIEMPRE que falte, no solo con 2+ productos. Una venta
      // sin referencia no se puede cruzar con la guía del courier, no aparece
      // en Reclamos y no se agrupa: quedaban 19 así en la base.
      let ref = (form.n_referencia || '').trim()
      if (!ref) ref = await proximaReferenciaWA()

      // 8.6 · Avisar si esa referencia ya está cargada, antes de duplicarla.
      if (form.n_referencia?.trim()) {
        const { data: yaExiste } = await supabase.from('ventas')
          .select('id, producto_nombre, fecha').is('deleted_at', null)
          .eq('n_referencia', ref).limit(1)
        if (yaExiste?.length) {
          const y = yaExiste[0]
          const seguir = confirm(
            `Ya hay una venta con la referencia ${ref} (${y.producto_nombre || 'sin producto'}, ${y.fecha}).\n\n` +
            `Si es OTRO producto del MISMO pedido, está bien: dale Aceptar.\n` +
            `Si es un pedido distinto, cancelá y cambiá la referencia.`
          )
          if (!seguir) { setLoading(false); return }
        }
      }

      const base = {
        ...form,
        n_referencia: ref,
        // 8.5 · Único lugar del sistema que guardaba el teléfono crudo: el
        // mismo cliente aparecía dos veces según cómo se hubiera tipeado.
        cliente_telefono: normalizarTel(form.cliente_telefono) || form.cliente_telefono || '',
        metodo_pago_nombre: metodosPago.find(m => m.id === form.metodo_pago_id)?.nombre || '',
        metodo_envio_nombre: envSel?.nombre || '',
      }
      let filas = filasDeVenta(base, conProducto, { envioCliente, costoEnvio })

      // Tolerante a que falte la migración 005: si la base todavía no tiene
      // las columnas nuevas, se sacan y la venta se guarda igual.
      let creadas = null, error = null
      for (let intento = 0; intento < 4; intento++) {
        const r = await supabase.from('ventas').insert(filas).select()
        if (!r.error) { creadas = r.data; error = null; break }
        const falta = /Could not find the '(\w+)' column/.exec(r.error.message || '')
        if (falta && ['es_mayorista', 'precio_lista'].includes(falta[1])) {
          setFaltaMigracion(true)
          const col = falta[1]
          filas = filas.map(f => { const o = { ...f }; delete o[col]; return o })
          continue
        }
        error = r.error; break
      }
      if (error) { toast('Error: ' + error.message, 'error'); logError('crear_venta', error, { lineas: filas.length }); return }

      for (const v of (creadas || [])) {
        try { await aplicarStockNuevaVenta(v) } catch (e) { logError('crear_venta_stock', e, { id: v.id }) }
      }
      await logAccion({
        accion: 'crear', entidad: 'venta', entidadId: creadas?.[0]?.id,
        detalle: `#${ref || 's/ref'} — ${conProducto.map(l => `${l.producto_nombre} x${l.cantidad}`).join(' + ')}${form.es_mayorista ? ' [mayorista]' : ''}`,
      })
      toast(conProducto.length > 1 ? `Pedido de ${conProducto.length} productos registrado` : 'Venta registrada', 'success')
      onSaved(); onClose()
    } finally { setLoading(false) }
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
          {faltaMigracion && (
            <div className="alert alert-warning">
              <AlertTriangle size={15} />
              <span>Falta correr <code>005-ventas-abiertas.sql</code>. La venta se guarda igual, pero sin marcar mayorista ni el precio de lista.</span>
            </div>
          )}

          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Fecha</label>
              <input className="form-input" type="date" value={form.fecha}
                onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label className="form-label">N° Referencia</label>
              <input className="form-input" placeholder="Ej: 1520 — vacío genera WA-####" value={form.n_referencia}
                onChange={e => setForm(f => ({ ...f, n_referencia: e.target.value }))} />
            </div>
          </div>

          {/* ── LÍNEAS DEL PEDIDO ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="section-label">Productos</span>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: form.es_mayorista ? 'var(--accent)' : 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={form.es_mayorista}
                    onChange={e => setForm(f => ({ ...f, es_mayorista: e.target.checked }))} />
                  Pedido mayorista
                </label>
                {/* A veces lo lleva un conocido y no hay costo de logística.
                    Sin esto el sistema forzaba el flete por defecto y la
                    ganancia de ese pedido salía menor de lo real. */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: fleteGratis ? 'var(--accent)' : 'var(--text-secondary)' }}
                  title="Lo lleva un conocido: sin costo de envío">
                  <input type="checkbox" checked={fleteGratis} onChange={e => setFleteGratis(e.target.checked)} />
                  Envío sin costo
                </label>
              </div>
            </div>

            {lineas.map((l, i) => {
              const aviso = l.producto_id ? avisoPrecio(l.precio, l.precio_lista) : null
              const unitLista = l.producto_id && l.cantidad ? Math.round(l.precio_lista / Math.max(1, parseInt(l.cantidad, 10) || 1)) : 0
              return (
                <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div className="form-group" style={{ flex: '1 1 200px', minWidth: 0 }}>
                      {i === 0 && <label className="form-label">Producto *</label>}
                      <SearchSelect value={l.producto_id} onChange={(v) => setLinea(i, { producto_id: v })}
                        options={productosOpts} placeholder="Buscar producto..." />
                    </div>
                    <div className="form-group" style={{ width: 90 }}>
                      {i === 0 && <label className="form-label">Cantidad</label>}
                      {/* Input libre, no un desplegable de 1-2-3: un mayorista
                          puede pedir 10, 20 o 50 y el sistema tiene que dejarlo. */}
                      <input className="form-input" type="number" min="1" inputMode="numeric" value={l.cantidad}
                        onChange={e => setLinea(i, { cantidad: e.target.value })} />
                    </div>
                    <div className="form-group" style={{ width: 120 }}>
                      {i === 0 && <label className="form-label">Precio c/u</label>}
                      <input className="form-input" type="number" min="0" inputMode="numeric" value={l.precio_unitario}
                        onChange={e => setLinea(i, { precio_unitario: e.target.value, tocado: true })} />
                    </div>
                    {/* El total de la línea lo calcula el sistema: unitario × cantidad.
                        En un pedido de 20 unidades, hacer esa cuenta a mano es
                        justo donde se cuela el error. */}
                    <div className="form-group" style={{ width: 120 }}>
                      {i === 0 && <label className="form-label">Total línea</label>}
                      <div style={{ minHeight: 42, display: 'flex', alignItems: 'center', padding: '0 4px',
                        fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15,
                        color: l.producto_id ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {formatGs(l.precio || 0)}
                      </div>
                    </div>
                    {lineas.length > 1 && (
                      <button type="button" className="btn-icon" title="Quitar" onClick={() => quitarLinea(i)}
                        style={{ marginBottom: 2 }}>
                        <X size={15} color="var(--text-muted)" />
                      </button>
                    )}
                  </div>
                  {aviso && (
                    <div style={{ fontSize: 11.5, marginTop: 5, color: aviso.esDescuento ? 'var(--yellow)' : 'var(--accent)' }}>
                      {aviso.esDescuento ? '↓' : '↑'} {aviso.texto} · lista: {formatGs(unitLista)} c/u ({formatGs(l.precio_lista)} en total)
                    </div>
                  )}
                </div>
              )
            })}

            <button type="button" className="btn btn-ghost btn-sm" onClick={agregarLinea}>
              <Plus size={13} /> Agregar producto
            </button>
          </div>

          {/* ── RESUMEN ── */}
          {tot.lineas > 0 && (
            <div style={{ background: 'var(--accent-dim)', border: '1px solid rgba(200,241,53,0.2)', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
                  Total que paga el cliente{envioCliente > 0 ? ' (con envío)' : ''}
                </span>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, color: 'var(--accent)' }}>
                  {formatGs(tot.total)}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                {tot.lineas} {tot.lineas === 1 ? 'producto' : 'productos'} · {tot.unidades} unidades ·
                Costo: {formatGs(tot.costoProd)} · Flete: {fleteGratis ? 'sin costo' : formatGs(costoEnvio)} ·
                Contribución est.: {formatGs(tot.contribucion)}
              </div>
              {tot.descuento > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--yellow)', marginTop: 3 }}>
                  ↓ {formatGs(tot.descuento)} de descuento sobre la lista ({formatGs(tot.lista)})
                </div>
              )}
            </div>
          )}

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

          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Cliente</label>
              <input className="form-input" placeholder="Nombre del cliente" value={form.cliente_nombre}
                onChange={e => setForm(f => ({ ...f, cliente_nombre: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Teléfono</label>
              <input className="form-input" type="tel" inputMode="numeric" autoComplete="tel" placeholder="0981000000" value={form.cliente_telefono}
                onChange={e => setForm(f => ({ ...f, cliente_telefono: e.target.value }))} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Dirección de entrega</label>
            <input className="form-input" placeholder="Calle, número, referencia" value={form.cliente_direccion}
              onChange={e => setForm(f => ({ ...f, cliente_direccion: e.target.value }))} />
            <span className="form-hint">Necesaria para despachar desde Ventas (Cabecera + Guías)</span>
          </div>

          <div className="form-group">
            <label className="form-label">Descripción / Notas</label>
            <input className="form-input" placeholder="Ej: 2 negros, 1 blanco" value={form.descripcion}
              onChange={e => setForm(f => ({ ...f, descripcion: e.target.value }))} />
          </div>

          <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Guardando...' : tot.lineas > 1 ? `Registrar pedido (${tot.lineas} productos)` : 'Registrar venta'}
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
    cliente_direccion: venta.cliente_direccion || '',
    canal_origen: venta.canal_origen || 'Otro',
    costo_prod: venta.costo_prod || 0,
    costo_envio: venta.costo_envio || 0,
    envio_cliente: venta.envio_cliente || 0,
  })

  useEffect(() => {
    supabase.from('productos').select('id, nombre, costo_unit, grupo_envio').eq('activo', true).order('nombre')
      .then(({ data }) => setProductos(data || []))
      .catch(err => { console.warn('No se pudieron cargar productos:', err?.message); setProductos([]) })
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
      cliente_direccion: form.cliente_direccion,
      canal_origen: form.canal_origen,
      costo_prod: parseInt(form.costo_prod) || 0,
      costo_envio: parseInt(form.costo_envio) || 0,
      envio_cliente: parseInt(form.envio_cliente) || 0,
    }).eq('id', venta.id)
    if (error) toast('Error: ' + error.message, 'error')
    else {
      // Reajustar stock: el motor revierte la versión vieja y aplica la nueva (cantidad/producto/estado)
      const ventaNueva = {
        ...venta,
        producto_id: form.producto_id || null,
        cantidad: parseInt(form.cantidad) || 1,
        estado: form.estado,
        n_referencia: form.n_referencia,
      }
      try { await aplicarStockEdicion(venta, ventaNueva) } catch (e) { console.warn('stock:', e?.message) }
      toast('Venta actualizada', 'success'); onSaved(); onClose()
    }
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
              <input className="form-input" type="tel" inputMode="numeric" autoComplete="tel" value={form.cliente_telefono} onChange={e => set('cliente_telefono', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Ciudad</label>
              <input className="form-input" value={form.ciudad} onChange={e => set('ciudad', e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Dirección de entrega</label>
            <input className="form-input" value={form.cliente_direccion} onChange={e => set('cliente_direccion', e.target.value)} placeholder="Calle, número, referencia" />
            <span className="form-hint">Se usa al despachar desde Ventas (Cabecera + Guías)</span>
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

  // Deep-link: #/ventas?nueva=1 abre directo el modal de nueva venta.
  // Lo usan el atajo N y el acceso rápido del hero — cargar una venta pasa a
  // ser UNA acción desde cualquier pantalla, incluso si ya estás parado acá
  // (por eso escucha location, no solo el montaje). El parámetro se limpia
  // para que recargar o volver atrás no reabra el modal.
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    if (new URLSearchParams(location.search).get('nueva')) {
      setShowModal(true)
      navigate('/ventas', { replace: true })
    }
  }, [location.search, navigate])
  const [filtroEstado, setFiltroEstado] = useState('todos')
  const [filtroTransp, setFiltroTransp] = useState('todas')
  const [busqueda, setBusqueda] = useState('')
  const [filtroMes, setFiltroMes] = useState('')
  const [seleccionadas, setSeleccionadas] = useState(new Set())
  const [editando, setEditando] = useState(null)

  const cargarVentas = useCallback(async () => {
    setLoading(true)
    // fetchAll re-ejecuta la consulta en cada página, así que necesita una
    // función que la ARME de nuevo: una query de Supabase se consume al
    // ejecutarse y reusar el mismo objeto rompe la paginación.
    const armarQuery = () => {
      let q = supabase.from('ventas').select('*').is('deleted_at', null)
      if (filtroEstado !== 'todos') q = q.eq('estado', filtroEstado)
      // Filtro por transportadora: permite aislar (por ejemplo) las de 'Otra'
      // para marcarlas en lote, ya que esos couriers no dan reporte de estados.
      if (filtroTransp !== 'todas') q = q.eq('transportadora', filtroTransp)
      if (filtroMes) {
        const [year, month] = filtroMes.split('-')
        const inicio = `${year}-${month}-01`
        const fin = `${year}-${month}-${String(new Date(Number(year), Number(month), 0).getDate()).padStart(2, '0')}`
        q = q.gte('fecha', inicio).lte('fecha', fin)
      }
      return q
    }
    // Antes había un .limit(200) y la búsqueda filtraba en memoria sobre esas
    // 200 filas: cualquier pedido más viejo salía como inexistente. Se pagina
    // el rango completo, igual que hace Reportes.
    let data = []
    try {
      data = await fetchAll(armarQuery, { columnaOrden: 'id' })
    } catch (e) {
      toast('No pude cargar las ventas: ' + (e?.message || e), 'error')
      setLoading(false)
      return
    }
    // fetchAll ordena por id (necesita una columna única para paginar sin
    // repetir filas), así que el orden de pantalla se aplica acá.
    data.sort((a, b) =>
      String(b.fecha || '').localeCompare(String(a.fecha || '')) ||
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    )
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
  }, [filtroEstado, filtroTransp, busqueda, filtroMes])

  useEffect(() => { cargarVentas() }, [cargarVentas])

  // Un pedido de 2 productos son 2 filas en `ventas`. Cambiar el estado o
  // borrar tocaba UNA sola: quedaba media orden entregada y media pendiente.
  // Dos filas son el mismo pedido si comparten referencia normalizada Y fecha.
  // Se exige que la referencia tenga algún dígito: las basura ('NO TIENE',
  // 'no hay') agruparían clientes que no tienen nada que ver.
  // Se consulta la BASE y no la lista en memoria: con un filtro de estado
  // activo (o con la otra línea en otra página) la hermana no está cargada, y
  // el pedido se partiría igual. Se traen las ventas de ese día —son pocas— y
  // se comparan por referencia normalizada.
  const lineasDelPedido = async (venta) => {
    if (!venta) return []
    const ref = normalizarRef(venta.n_referencia)
    if (!ref || !/\d/.test(ref) || !venta.fecha) return [venta]
    const { data, error } = await supabase.from('ventas')
      .select('*').is('deleted_at', null).eq('fecha', venta.fecha)
    if (error || !data) return [venta]
    const hermanas = data.filter(v => normalizarRef(v.n_referencia) === ref)
    return hermanas.length ? hermanas : [venta]
  }

  const cambiarEstado = async (id, nuevoEstado) => {
    const ventaActual = ventas.find(v => v.id === id)
    const lineas = await lineasDelPedido(ventaActual)
    const ids = lineas.length ? lineas.map(v => v.id) : [id]
    const { error } = await supabase.from('ventas').update({ estado: nuevoEstado }).in('id', ids)
    if (error) { toast('Error al actualizar', 'error'); return }
    // Ajustar stock según la transición (devuelto suma, reactivar descuenta) — el motor evita el doble descuento
    for (const l of (lineas.length ? lineas : [ventaActual])) {
      if (!l) continue
      try { await aplicarStockCambioEstado(l, nuevoEstado) } catch (e) { console.warn('stock:', e?.message) }
    }
    toast(ids.length > 1 ? `Estado actualizado en las ${ids.length} líneas del pedido` : 'Estado actualizado', 'success')
    cargarVentas()
  }

  const eliminar = async (id) => {
    const venta = ventas.find(v => v.id === id)
    const lineas = await lineasDelPedido(venta)
    const ids = lineas.length ? lineas.map(v => v.id) : [id]
    const aviso = ids.length > 1
      ? `Este pedido tiene ${ids.length} productos. ¿Mover el pedido COMPLETO a la papelera? Podés recuperarlo después.`
      : '¿Mover esta venta a la papelera? Podés recuperarla después.'
    if (!confirm(aviso)) return
    // Si alguna línea tenía stock descontado, devolverlo al borrar
    for (const l of (lineas.length ? lineas : [venta])) {
      if (!l?.stock_descontado) continue
      try { await devolverStockPorBorrado(l) } catch (e) { logError('borrar_venta_stock', e, { id: l.id }) }
    }
    const { error } = await supabase.from('ventas').update({ deleted_at: new Date().toISOString() }).in('id', ids)
    if (error) { toast('Error al eliminar', 'error'); logError('borrar_venta', error, { id }); return }
    await logAccion({ accion: 'eliminar', entidad: 'venta', entidadId: id, detalle: venta ? `#${venta.n_referencia} — ${venta.producto_nombre}` : '' })
    toast('Venta movida a la papelera', 'info')
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
    if (!confirm(`¿Mover ${ids.length} venta(s) a la papelera? Podés recuperarlas después.`)) return
    // Devolver stock de las que estaban descontadas
    for (const id of ids) {
      const venta = ventas.find(v => v.id === id)
      if (venta?.stock_descontado) {
        try { await devolverStockPorBorrado(venta) } catch (e) { logError('borrar_lote_stock', e, { id }) }
      }
    }
    const { error } = await supabase.from('ventas').update({ deleted_at: new Date().toISOString() }).in('id', ids)
    if (error) { toast('Error al eliminar: ' + error.message, 'error'); logError('borrar_lote_ventas', error, { count: ids.length }) }
    else {
      await logAccionLote({ accion: 'eliminar', entidad: 'venta', cantidad: ids.length, detalle: `mes ${filtroMes}` })
      toast(`${ids.length} venta(s) movida(s) a la papelera`, 'info'); cargarVentas()
    }
  }

  const totalVentas = ventas.filter(v => v.estado === 'entregado').reduce((s, v) => s + v.total, 0)
  const totalNeto = ventas.filter(v => v.estado === 'entregado').reduce((s, v) => s + v.ganancia_neta, 0)

  const mesesDisponibles = []
  const _hoy = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(_hoy.getFullYear(), _hoy.getMonth() - i, 1)
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
        <div className="tabs filter-scroll">
          {ESTADOS.map(e => (
            <button key={e} className={`tab ${filtroEstado === e ? 'active' : ''}`} onClick={() => setFiltroEstado(e)}>
              {e === 'todos' ? 'Todos' : e === 'en_tramite' ? 'En trámite' : e.charAt(0).toUpperCase() + e.slice(1)}
            </button>
          ))}
        </div>
        <select className="form-select" style={{ width: 'auto' }} value={filtroTransp} onChange={e => setFiltroTransp(e.target.value)}>
          <option value="todas">Todas las transportadoras</option>
          <option value="pap">PAP</option>
          <option value="lucero">Lucero</option>
          <option value="otra">Otra</option>
        </select>
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

      {/* ─── VISTA DESKTOP: tabla ─────────────────────── */}
      <div className="table-wrapper desktop-only">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Cargando...</div>
        ) : ventas.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Plus size={22} /></div>
            <p className="empty-state-title">Sin ventas</p>
            <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}><Plus size={13} /> Nueva venta</button>
          </div>
        ) : (
          <table className="tabla-responsive">
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
                const cfg = getEstadoConfig(v.estado)
                const dias = v.estado === 'pendiente' ? diasSinResolver(v.fecha) : null
                return (
                  <tr key={v.id} style={seleccionadas.has(v.id) ? { background: 'var(--accent-dim)' } : undefined}>
                    <td><input type="checkbox" checked={seleccionadas.has(v.id)} onChange={() => toggleSel(v.id)} style={{ cursor: 'pointer' }} /></td>
                    <td data-label="Fecha" className="muted">{new Date(v.fecha + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}</td>
                    <td data-label="Ref." className="mono">{v.n_referencia || '—'}</td>
                    <td data-label="Producto" style={{ fontWeight: 500 }}>{v.producto_nombre}</td>
                    <td data-label="Cant." className="muted">{v.cantidad}</td>
                    <td data-label="Total" style={{ fontWeight: 600 }}>{formatGs(v.total)}</td>
                    <td data-label="Ganancia" style={{ color: v.estado === 'entregado' ? 'var(--green)' : 'var(--text-muted)', fontWeight: 500 }}>
                      {v.estado === 'entregado' ? formatGs(v.ganancia_neta) : '—'}
                    </td>
                    <td data-label="Estado">
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
                    <td data-label="Ciudad" className="muted" style={{ fontSize: 12 }}>{v.ciudad || '—'}</td>
                    <td data-label="Canal"><span className="badge badge-gray" style={{ fontSize: 10 }}>{v.canal_origen}</span></td>
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

      {/* ─── VISTA MÓVIL: tarjetas ────────────────────── */}
      <div className="mobile-only">
        {loading ? (
          <div className="m-card-list">
            {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 130, borderRadius: 'var(--radius)' }} />)}
          </div>
        ) : ventas.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Plus size={22} /></div>
            <p className="empty-state-title">Sin ventas</p>
            <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}><Plus size={13} /> Nueva venta</button>
          </div>
        ) : (
          <div className="m-card-list">
            {ventas.map(v => {
              const cfg = getEstadoConfig(v.estado)
              const dias = v.estado === 'pendiente' ? diasSinResolver(v.fecha) : null
              const sel = seleccionadas.has(v.id)
              return (
                <div key={v.id} className={`m-card${sel ? ' selected' : ''}`}>
                  {/* Header: checkbox + producto + total */}
                  <div className="m-card-head">
                    <input
                      type="checkbox"
                      checked={sel}
                      onChange={() => toggleSel(v.id)}
                      style={{ cursor: 'pointer', width: 17, height: 17, marginTop: 1, flexShrink: 0, accentColor: 'var(--accent)' }}
                    />
                    <div className="m-card-title">{v.producto_nombre}</div>
                    <div className="m-card-amount">{formatGs(v.total)}</div>
                  </div>

                  {/* Body: datos en grilla 2 columnas */}
                  <div className="m-card-body">
                    <div className="m-card-row">
                      <span className="m-card-label">Fecha</span>
                      <span className="m-card-value">
                        {new Date(v.fecha + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}
                        {dias !== null && dias >= 5 && <span style={{ color: 'var(--red)', marginLeft: 5 }}>· {dias}d</span>}
                      </span>
                    </div>
                    <div className="m-card-row">
                      <span className="m-card-label">Ref.</span>
                      <span className="m-card-value strong">{v.n_referencia ? `#${v.n_referencia}` : '—'}</span>
                    </div>
                    <div className="m-card-row">
                      <span className="m-card-label">Cantidad</span>
                      <span className="m-card-value">{v.cantidad} u</span>
                    </div>
                    <div className="m-card-row">
                      <span className="m-card-label">Ganancia</span>
                      <span className="m-card-value strong" style={{ color: v.estado === 'entregado' ? 'var(--green)' : 'var(--text-muted)' }}>
                        {v.estado === 'entregado' ? formatGs(v.ganancia_neta) : '—'}
                      </span>
                    </div>
                    <div className="m-card-row full">
                      <span className="m-card-label">Ciudad</span>
                      <span className="m-card-value">{v.ciudad || '—'} · {v.canal_origen}</span>
                    </div>
                  </div>

                  {/* Footer: estado + acciones */}
                  <div className="m-card-foot">
                    <select
                      value={v.estado}
                      onChange={e => cambiarEstado(v.id, e.target.value)}
                      className="m-status-select"
                      style={{ background: cfg.bg, color: cfg.color, borderColor: `${cfg.color}40` }}
                    >
                      <option value="pendiente">Pendiente</option>
                      <option value="entregado">Entregado</option>
                      <option value="devuelto">Devuelto</option>
                      <option value="en_tramite">En trámite</option>
                    </select>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditando(v)} style={{ color: 'var(--accent)' }}>
                        <Edit2 size={14} /> Editar
                      </button>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => eliminar(v.id)} style={{ color: 'var(--red)', opacity: 0.7 }} title="Eliminar">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showModal && <NuevaVentaModal onClose={() => setShowModal(false)} onSaved={cargarVentas} />}
      {editando && (
        <ModalErrorBoundary onClose={() => setEditando(null)}>
          <EditarVentaModal venta={editando} onClose={() => setEditando(null)} onSaved={cargarVentas} />
        </ModalErrorBoundary>
      )}
    </div>
  )
}
