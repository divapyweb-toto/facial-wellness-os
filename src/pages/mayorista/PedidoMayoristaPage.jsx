// src/pages/mayorista/PedidoMayoristaPage.jsx
// Pedido mayorista (venta por WhatsApp cargada a mano): se crea en Shopify con la Edge Function
// pedido-mayorista y sigue el mismo circuito que un pedido de la web (Despacho, courier, entrega, factura).
// La validación es de src/lib/mayorista.js; el servidor la repite.
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Plus, Trash2, X, CheckCircle2, AlertTriangle, Loader2, RefreshCw, Receipt, ShoppingBag } from 'lucide-react'
import { formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { hoyLocal } from '../../lib/fechas'
import { getEnvioCliente } from '../../lib/config'
import {
  validarRuc, validarPedidoMayorista, armarPayload, nuevaClaveIdempotencia, aEntero, totalPedido,
  estadoPedidoMayorista, estadoFacturaCorto,
} from '../../lib/mayorista'
import { cargarCatalogo, crearPedido, leerCorte, cargarListaMayoristas } from './api'
import DatosFactura from '../../components/DatosFactura'
import './mayorista.css'

const itemVacio = () => ({ variant_id: '', titulo: '', cantidad: '1', precio_unitario: '' })

function formInicial() {
  const envio = Number(getEnvioCliente())
  return {
    nombre: '', telefono: '', direccion: '', referencia: '', ciudad: '',
    ruc: '', razon_social: '', email: '',
    items: [itemVacio()],
    envio: Number.isFinite(envio) && envio > 0 ? String(envio) : '',
    cobro: 'contra_entrega', comprobante_ref: '',
    condicion: 'contado', plazo_dias: '',
    anterior_al_corte: false, fecha_entrega: '',
    nota: '',
  }
}

const COBRO_TXT = { transferencia_anticipada: 'Transferencia anticipada (ueno)', contra_entrega: 'Contra entrega (cobra el courier)' }

function Campo({ label, error, hint, hintOk, children, full }) {
  return (
    <div className="form-group" style={full ? { gridColumn: '1 / -1' } : undefined}>
      <label className="form-label">{label}</label>
      {children}
      {error ? <div className="may-error">{error}</div> : hint ? <div className={`form-hint${hintOk ? ' may-hint-ok' : ''}`}>{hint}</div> : null}
    </div>
  )
}

export default function PedidoMayoristaPage() {
  const { toast } = useToast()
  const [form, setForm] = useState(formInicial)
  const [errores, setErrores] = useState({})
  const [catalogo, setCatalogo] = useState([])
  const [cargandoCat, setCargandoCat] = useState(true)
  const [errorCat, setErrorCat] = useState('')
  const [corte, setCorte] = useState(null)
  const [resumen, setResumen] = useState(null)      // validación lista para confirmar
  const [enviando, setEnviando] = useState(false)
  const enviandoRef = useRef(false)                  // freno síncrono del doble clic
  const claveRef = useRef(nuevaClaveIdempotencia())  // misma clave en reintentos del mismo pedido
  const [incierto, setIncierto] = useState('')       // error sin respuesta clara de Shopify
  const [resultado, setResultado] = useState(null)
  const [lista, setLista] = useState([])
  const [cargandoLista, setCargandoLista] = useState(true)
  const [errorLista, setErrorLista] = useState('')
  const [datosFactura, setDatosFactura] = useState(null)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setItem = (i, cambios) => setForm(f => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...cambios } : it)) }))

  const traerCatalogo = useCallback(async () => {
    setCargandoCat(true); setErrorCat('')
    try { setCatalogo(await cargarCatalogo()) } catch (e) { setErrorCat(e.message || String(e)) }
    setCargandoCat(false)
  }, [])

  const traerLista = useCallback(async () => {
    setCargandoLista(true); setErrorLista('')
    try { setLista(await cargarListaMayoristas()) } catch (e) { setErrorLista(e.message || String(e)) }
    setCargandoLista(false)
  }, [])

  useEffect(() => { traerCatalogo(); traerLista(); leerCorte().then(setCorte) }, [traerCatalogo, traerLista])

  const opciones = useMemo(() => catalogo.flatMap(p => p.variantes.map(v => ({
    id: v.id,
    titulo: v.titulo && v.titulo !== 'Default Title' ? `${p.titulo} — ${v.titulo}` : p.titulo,
    precio: v.precio,
    borrador: p.estado !== 'ACTIVE',
  }))), [catalogo])

  const elegirProducto = (i, id) => {
    const o = opciones.find(x => x.id === id)
    const actual = form.items[i]
    setItem(i, {
      variant_id: id,
      titulo: o?.titulo || '',
      // Precio de lista como punto de partida; el mayorista se edita a mano.
      precio_unitario: actual.precio_unitario || (o ? String(o.precio) : ''),
    })
  }

  const ctx = { hoy: hoyLocal(), facturarDesde: corte }
  const rucVivo = form.ruc.trim().length >= 5 ? validarRuc(form.ruc) : null
  const total = totalPedido(form.items, form.envio)

  const revisar = (e) => {
    e?.preventDefault()
    const v = validarPedidoMayorista(form, ctx)
    setErrores(v.errores)
    if (!v.ok) { toast('Revisá los campos marcados', 'error'); return }
    setResumen(v)
  }

  const confirmar = async () => {
    if (enviandoRef.current) return
    enviandoRef.current = true
    setEnviando(true)
    try {
      const { status, body } = await crearPedido(armarPayload(form, claveRef.current))
      if (body?.ok) {
        setResultado(body)
        setResumen(null)
        setIncierto('')
        setForm(formInicial())
        setErrores({})
        claveRef.current = nuevaClaveIdempotencia()
        toast(body.repetido ? `El pedido ${body.nombre || ''} ya estaba creado` : `Pedido ${body.nombre || ''} creado en Shopify`, 'success')
        traerLista()
        return
      }
      if (body?.errores) setErrores(body.errores)
      if (body?.reintentable) claveRef.current = nuevaClaveIdempotencia()
      if (status === 502 || /incierto/.test(body?.error || '')) setIncierto(body.error)
      toast(body?.error || 'No se pudo crear el pedido', 'error')
    } catch (err) {
      setIncierto(`Sin respuesta (${err.message || err}). Revisá en Shopify si el pedido se creó.`)
    } finally {
      enviandoRef.current = false
      setEnviando(false)
    }
  }

  const nuevoIntento = () => { claveRef.current = nuevaClaveIdempotencia(); setIncierto('') }

  return (
    <div className="fade-in may-pagina">
      <div className="page-header">
        <div>
          <h1 className="page-title">Pedido mayorista</h1>
          <p className="page-subtitle">Venta por WhatsApp · se crea en Shopify y sigue el circuito normal (Despacho → courier → entrega → factura)</p>
        </div>
      </div>

      {resultado && (
        <div className={`alert ${resultado.avisos?.length ? 'alert-warning' : 'alert-success'}`} style={{ marginBottom: 16 }}>
          {resultado.avisos?.length ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <div style={{ flex: 1 }}>
            <strong>Pedido {resultado.nombre || resultado.shopify_order_id}{resultado.repetido ? ' (ya existía)' : ''} · {formatGs(resultado.total)}</strong>
            {resultado.avisos?.length > 0 && <ul className="may-avisos">{resultado.avisos.map((a, i) => <li key={i}>{a}</li>)}</ul>}
          </div>
          <button className="modal-close" onClick={() => setResultado(null)} aria-label="Cerrar"><X size={15} /></button>
        </div>
      )}

      {incierto && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          <AlertTriangle size={15} />
          <div style={{ flex: 1 }}>
            {incierto}
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={nuevoIntento}>Ya revisé Shopify y NO está: permitir otro intento</button>
            </div>
          </div>
        </div>
      )}

      <form className="card may-form" onSubmit={revisar} noValidate>
        <div className="section-label">Cliente y entrega</div>
        <div className="form-grid">
          <Campo label="Nombre de contacto" error={errores.nombre}>
            <input className="form-input" value={form.nombre} onChange={e => set('nombre', e.target.value)} autoComplete="off" />
          </Campo>
          <Campo label="Teléfono (WhatsApp)" error={errores.telefono}>
            <input className="form-input" inputMode="tel" placeholder="0981 123456" value={form.telefono} onChange={e => set('telefono', e.target.value)} />
          </Campo>
          <Campo label="Dirección" error={errores.direccion}>
            <input className="form-input" value={form.direccion} onChange={e => set('direccion', e.target.value)} />
          </Campo>
          <Campo label="Referencia (opcional)">
            <input className="form-input" placeholder="Frente a…, portón negro…" value={form.referencia} onChange={e => set('referencia', e.target.value)} />
          </Campo>
          <Campo label="Ciudad" error={errores.ciudad}>
            <input className="form-input" value={form.ciudad} onChange={e => set('ciudad', e.target.value)} />
          </Campo>
        </div>

        <div className="section-label">Factura</div>
        <div className="form-grid">
          <Campo label="RUC con DV" error={errores.ruc || (rucVivo && !rucVivo.ok ? rucVivo.error : null)} hintOk={!!rucVivo?.ok}
            hint={rucVivo?.ok ? `✓ Dígito verificador correcto (${rucVivo.texto})` : 'Ej.: 1234567-8'}>
            <input className={`form-input ${rucVivo ? (rucVivo.ok ? 'may-ok' : 'may-mal') : ''}`} inputMode="numeric" placeholder="1234567-8"
              value={form.ruc} onChange={e => set('ruc', e.target.value)} />
          </Campo>
          <Campo label="Razón social" error={errores.razon_social} hint="Como figura en el RUC">
            <input className="form-input" value={form.razon_social} onChange={e => set('razon_social', e.target.value)} />
          </Campo>
          <Campo label="Email para la factura (opcional)" error={errores.email}>
            <input className="form-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} />
          </Campo>
          <Campo label="Condición" error={errores.condicion || errores.plazo_dias}>
            <div className="may-fila">
              <select className="form-select" value={form.condicion} onChange={e => set('condicion', e.target.value)}>
                <option value="contado">Contado</option>
                <option value="credito">Crédito</option>
              </select>
              {form.condicion === 'credito' && (
                <input className="form-input may-plazo" inputMode="numeric" placeholder="Días" value={form.plazo_dias}
                  onChange={e => set('plazo_dias', e.target.value)} aria-label="Plazo en días" />
              )}
            </div>
          </Campo>
        </div>

        <div className="section-label">Productos (precio mayorista, IVA incluido)</div>
        {cargandoCat ? (
          <div className="form-hint"><Loader2 size={13} className="spinning" /> Cargando productos de Shopify…</div>
        ) : errorCat ? (
          <div className="alert alert-error"><AlertTriangle size={15} /><span style={{ flex: 1 }}>{errorCat}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={traerCatalogo}><RefreshCw size={13} /> Reintentar</button></div>
        ) : (
          <div className="may-items">
            {form.items.map((it, i) => {
              const sub = (aEntero(it.cantidad) || 0) * (aEntero(it.precio_unitario) || 0)
              return (
                <div className="may-item" key={i}>
                  <select className="form-select may-item-prod" value={it.variant_id} onChange={e => elegirProducto(i, e.target.value)} aria-label={`Producto ${i + 1}`}>
                    <option value="">— Elegí el producto —</option>
                    {opciones.map(o => <option key={o.id} value={o.id}>{o.titulo}{o.borrador ? ' (borrador)' : ''} · lista {formatGs(o.precio)}</option>)}
                  </select>
                  <input className="form-input may-item-cant" inputMode="numeric" value={it.cantidad} onChange={e => setItem(i, { cantidad: e.target.value })} aria-label="Cantidad" placeholder="Cant." />
                  <input className="form-input may-item-precio" inputMode="numeric" value={it.precio_unitario} onChange={e => setItem(i, { precio_unitario: e.target.value })} aria-label="Precio unitario" placeholder="Precio c/u" />
                  <span className="may-item-sub">{sub > 0 ? formatGs(sub) : '—'}</span>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={form.items.length === 1}
                    onClick={() => setForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))} aria-label="Quitar producto" style={{ color: 'var(--red)' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              )
            })}
            {errores.items && <div className="may-error">{errores.items}</div>}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm(f => ({ ...f, items: [...f.items, itemVacio()] }))} style={{ alignSelf: 'flex-start' }}>
              <Plus size={13} /> Agregar producto
            </button>
          </div>
        )}

        <div className="section-label">Envío y cobro</div>
        <div className="form-grid">
          <Campo label="Envío (Gs, lo paga el cliente)" error={errores.envio} hint="0 si el envío corre por tu cuenta">
            <input className="form-input" inputMode="numeric" value={form.envio} onChange={e => set('envio', e.target.value)} />
          </Campo>
          <Campo label="Cobro" error={errores.cobro}>
            <div className="may-radios">
              {Object.entries(COBRO_TXT).map(([k, t]) => (
                <label key={k} className={`may-radio ${form.cobro === k ? 'activo' : ''}`}>
                  <input type="radio" name="cobro" checked={form.cobro === k} onChange={() => set('cobro', k)} /> {t}
                </label>
              ))}
            </div>
          </Campo>
          {form.cobro === 'transferencia_anticipada' && (
            <Campo label="Comprobante de la transferencia" error={errores.comprobante_ref} hint="Número o referencia de la transferencia a ueno Empresas">
              <input className="form-input" value={form.comprobante_ref} onChange={e => set('comprobante_ref', e.target.value)} />
            </Campo>
          )}
        </div>

        <label className={`may-check ${form.anterior_al_corte ? 'activo' : ''}`}>
          <input type="checkbox" checked={form.anterior_al_corte} onChange={e => set('anterior_al_corte', e.target.checked)} />
          <span><strong>Ya entregado y cobrado (anterior al corte).</strong> No se le manda ningún mensaje al cliente, no va al courier y la factura queda retenida para la contadora.</span>
        </label>
        {form.anterior_al_corte && (
          <div className="form-grid">
            <Campo label="Fecha real de entrega y cobro" error={errores.fecha_entrega}
              hint={corte ? `Tiene que ser anterior al corte (${String(corte).slice(0, 10)})` : 'Todavía no hay corte de facturación cargado'}>
              <input className="form-input" type="date" max={hoyLocal()} value={form.fecha_entrega} onChange={e => set('fecha_entrega', e.target.value)} />
            </Campo>
          </div>
        )}

        <Campo label="Nota interna (opcional)" full>
          <textarea className="form-input" rows={2} value={form.nota} onChange={e => set('nota', e.target.value)} />
        </Campo>

        <div className="may-pie">
          <div className="may-total">Total <strong>{formatGs(total)}</strong></div>
          <button type="submit" className="btn btn-primary" disabled={enviando || cargandoCat || !!errorCat}>Revisar pedido</button>
        </div>
      </form>

      {/* ─── Lista de pedidos mayoristas ─── */}
      <div className="may-lista-head">
        <h2 className="may-h2"><ShoppingBag size={16} /> Pedidos mayoristas</h2>
        <button className="btn btn-ghost btn-sm" onClick={traerLista} disabled={cargandoLista}><RefreshCw size={13} className={cargandoLista ? 'spinning' : ''} /> Actualizar</button>
      </div>
      {errorLista && <div className="alert alert-error"><AlertTriangle size={15} /> {errorLista}</div>}
      <div className="table-wrapper">
        {cargandoLista ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Cargando…</div>
        ) : !lista.length ? (
          <div className="empty-state"><p className="empty-state-title">Todavía no hay pedidos mayoristas</p></div>
        ) : (
          <table className="tabla-responsive">
            <thead>
              <tr><th>Pedido</th><th>Fecha</th><th>Cliente</th><th>RUC</th><th>Total</th><th>Estado</th><th>Factura</th><th></th></tr>
            </thead>
            <tbody>
              {lista.map(p => {
                const est = estadoPedidoMayorista(p, p.retenida)
                return (
                  <tr key={p.shopify_order_id}>
                    <td data-label="Pedido" className="mono">{p.nombre || p.shopify_order_id}</td>
                    <td data-label="Fecha" className="muted">{new Date(p.creado_en).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}</td>
                    <td data-label="Cliente">{p.fiscal?.razon_social || p.cliente || '—'}{p.ciudad ? <span className="muted"> · {p.ciudad}</span> : null}</td>
                    <td data-label="RUC" className="mono">{p.fiscal ? `${p.fiscal.ruc}-${p.fiscal.dv}` : <span style={{ color: 'var(--red)' }}>falta</span>}
                      {p.fiscal?.condicion === 'credito' && <span className="badge badge-yellow" style={{ marginLeft: 6 }}>crédito {p.fiscal.plazo_dias} d</span>}</td>
                    <td data-label="Total" style={{ fontWeight: 600 }}>{formatGs(p.total)}</td>
                    <td data-label="Estado"><span style={{ color: est.color, fontWeight: 500 }}>{est.texto}</span></td>
                    <td data-label="Factura" className="muted">{estadoFacturaCorto(p.facturas, p.retenida)}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => setDatosFactura(p.shopify_order_id)} title="Datos de factura (RUC)">
                        <Receipt size={13} /> RUC
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ─── Resumen antes de confirmar ─── */}
      {resumen && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !enviando && setResumen(null)}>
          <div className="modal modal-lg">
            <div className="modal-header">
              <h2 className="modal-title">Confirmar pedido mayorista</h2>
              <button className="modal-close" onClick={() => !enviando && setResumen(null)} aria-label="Cerrar"><X size={18} /></button>
            </div>
            <div className="may-resumen">
              <div><span>Cliente</span><strong>{form.nombre} · {form.telefono}</strong></div>
              <div><span>Entrega</span><strong>{form.direccion}{form.referencia ? ` (${form.referencia})` : ''}, {form.ciudad}</strong></div>
              <div><span>Factura a</span><strong>{form.razon_social.trim()} · RUC {validarRuc(form.ruc).texto}</strong></div>
              <div><span>Condición</span><strong>{form.condicion === 'credito' ? `Crédito a ${aEntero(form.plazo_dias)} días` : 'Contado'}</strong></div>
              <div><span>Cobro</span><strong>{COBRO_TXT[form.cobro]}{form.comprobante_ref ? ` · ${form.comprobante_ref}` : ''}</strong></div>
              <table className="may-resumen-items">
                <tbody>
                  {form.items.map((it, i) => (
                    <tr key={i}><td>{it.titulo}</td><td>{aEntero(it.cantidad)} × {formatGs(aEntero(it.precio_unitario))}</td><td>{formatGs(aEntero(it.cantidad) * aEntero(it.precio_unitario))}</td></tr>
                  ))}
                  <tr><td>Envío</td><td></td><td>{formatGs(aEntero(form.envio) || 0)}</td></tr>
                  <tr className="may-resumen-total"><td>Total</td><td></td><td>{formatGs(resumen.total)}</td></tr>
                </tbody>
              </table>
              {resumen.avisos.map((a, i) => <div key={i} className="alert alert-warning"><AlertTriangle size={14} /> <span>{a}</span></div>)}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setResumen(null)} disabled={enviando}>Volver a editar</button>
              <button className="btn btn-primary" onClick={confirmar} disabled={enviando}>
                {enviando ? <><Loader2 size={14} className="spinning" /> Creando en Shopify…</> : 'Confirmar y crear en Shopify'}
              </button>
            </div>
          </div>
        </div>
      )}

      {datosFactura && (
        <DatosFactura shopifyOrderId={datosFactura} onClose={() => setDatosFactura(null)} onSaved={() => { setDatosFactura(null); traerLista() }} />
      )}
    </div>
  )
}
