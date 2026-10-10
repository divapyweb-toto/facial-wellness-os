// src/components/DatosFactura.jsx
// Modal "Datos de factura (RUC)" de un pedido de Shopify (Voltra) ya existente: un comprador con RUC que compró
// por la web, o un pedido mayorista. Guarda en pedido_datos_fiscales (origen 'web_con_ruc', o 'mayorista' si ya
// lo era); la cola de facturas (P1) usa estos datos antes que los atributos del pedido.
// Si el pedido ya tiene factura de producción, no deja cambiar nada: se corrige con nota de crédito
// (la base también lo bloquea: trigger pedido_datos_fiscales_bloqueo_facturado).
import { useEffect, useState } from 'react'
import { X, AlertTriangle, Info, Loader2, CheckCircle2 } from 'lucide-react'
import { supabase, formatGs } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/toast'
import { validarRuc, estadoFacturaPedido, filaDatosFiscales, nombrePedidoDesdeRef } from '../lib/mayorista'
import '../pages/mayorista/mayorista.css'

/** RUC y razón social que el cliente escribió en el pedido (Releasit / vendedor), para precargar. */
function datosDelPedido(raw) {
  const r = raw || {}
  const attrs = Array.isArray(r.note_attributes)
    ? r.note_attributes.map(a => [String(a?.name ?? ''), a?.value])
    : Array.isArray(r.customAttributes) ? r.customAttributes.map(a => [String(a?.key ?? ''), a?.value]) : []
  const buscar = (re) => { const x = attrs.find(([k]) => re.test(k.toLowerCase())); return x ? String(x[1] ?? '').trim() : '' }
  return { ruc: buscar(/^ruc$/), razon_social: buscar(/^raz[oó]n[ _]social$/) }
}

const vacio = { ruc: '', razon_social: '', email: '', condicion: 'contado', plazo_dias: '' }

export default function DatosFactura({ shopifyOrderId, referencia, onClose, onSaved }) {
  const { user } = useAuth()
  const { toast } = useToast()
  const [cargando, setCargando] = useState(true)
  const [errorCarga, setErrorCarga] = useState('')
  const [pedido, setPedido] = useState(null)
  const [existente, setExistente] = useState(null)
  const [estadoFac, setEstadoFac] = useState({ bloqueado: false, nivel: null, texto: '' })
  const [form, setForm] = useState(vacio)
  const [errores, setErrores] = useState({})
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    let vivo = true
    ;(async () => {
      try {
        let q = supabase.from('shopify_pedidos').select('shopify_order_id, nombre, total, tags, raw')
        if (shopifyOrderId) q = q.eq('shopify_order_id', shopifyOrderId)
        else {
          const nombre = nombrePedidoDesdeRef(referencia)
          if (!nombre) throw new Error('Esta venta no tiene un número de pedido de Shopify')
          q = q.eq('nombre', nombre).eq('es_borrador', false)
        }
        const { data: peds, error } = await q.limit(1)
        if (error) throw error
        const p = peds?.[0]
        if (!p) throw new Error('No encontré este pedido entre los pedidos de Shopify de Voltra (¿es de Facial Wellness o cargado a mano?)')
        const [fis, fac] = await Promise.all([
          supabase.from('pedido_datos_fiscales').select('*').eq('shopify_order_id', p.shopify_order_id).maybeSingle(),
          supabase.from('facturas').select('tipo_documento, estado, ambiente, numero_completo').eq('shopify_order_id', p.shopify_order_id),
        ])
        if (fis.error && !/pedido_datos_fiscales/.test(fis.error.message || '')) throw fis.error
        if (fis.error) throw new Error('Falta aplicar la migración de pedido_datos_fiscales')
        if (!vivo) return
        setPedido(p)
        setExistente(fis.data || null)
        setEstadoFac(estadoFacturaPedido(fac.error ? [] : fac.data))
        if (fis.data) {
          setForm({
            ruc: `${fis.data.ruc}-${fis.data.dv}`,
            razon_social: fis.data.razon_social || '',
            email: fis.data.email || '',
            condicion: fis.data.condicion || 'contado',
            plazo_dias: fis.data.plazo_dias ? String(fis.data.plazo_dias) : '',
          })
        } else {
          const d = datosDelPedido(p.raw)
          setForm({ ...vacio, ruc: d.ruc, razon_social: d.razon_social })
        }
      } catch (e) {
        if (vivo) setErrorCarga(e.message || String(e))
      }
      if (vivo) setCargando(false)
    })()
    return () => { vivo = false }
  }, [shopifyOrderId, referencia])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const rucVivo = form.ruc.trim().length >= 5 ? validarRuc(form.ruc) : null
  const bloqueado = estadoFac.bloqueado

  const guardar = async (e) => {
    e.preventDefault()
    if (bloqueado || guardando || !pedido) return
    const r = filaDatosFiscales(pedido.shopify_order_id, form, existente, user?.id)
    setErrores(r.ok ? {} : r.errores)
    if (!r.ok) return
    setGuardando(true)
    const { error } = await supabase.from('pedido_datos_fiscales').upsert(r.fila, { onConflict: 'shopify_order_id' })
    setGuardando(false)
    if (error) {
      toast(/nota de crédito/.test(error.message || '') ? error.message : `No se guardó: ${error.message}`, 'error')
      return
    }
    toast(`Datos de factura guardados para ${pedido.nombre || pedido.shopify_order_id}`, 'success')
    onSaved?.(r.fila)
  }

  const Aviso = ({ nivel, texto }) => {
    if (!texto) return null
    const cls = nivel === 'error' ? 'alert-error' : nivel === 'warning' ? 'alert-warning' : 'alert-info'
    const Icono = nivel === 'info' ? Info : AlertTriangle
    return <div className={`alert ${cls}`}><Icono size={15} /><span>{texto}</span></div>
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !guardando && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Datos de factura (RUC){pedido ? ` · ${pedido.nombre || pedido.shopify_order_id}` : ''}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </div>
        {cargando ? (
          <div className="form-hint"><Loader2 size={13} className="spinning" /> Cargando…</div>
        ) : errorCarga ? (
          <Aviso nivel="error" texto={errorCarga} />
        ) : (
          <form onSubmit={guardar} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-hint" style={{ marginTop: 0 }}>
              Total {formatGs(pedido.total)} · {existente ? `cargado como ${existente.origen === 'mayorista' ? 'pedido mayorista' : 'RUC agregado'}` : 'todavía sin datos de factura (sale a consumidor final)'}
            </div>
            <Aviso nivel={estadoFac.nivel} texto={estadoFac.texto} />
            <fieldset disabled={bloqueado} style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="form-group">
                <label className="form-label">RUC con DV</label>
                <input className={`form-input ${rucVivo ? (rucVivo.ok ? 'may-ok' : 'may-mal') : ''}`} inputMode="numeric" placeholder="1234567-8"
                  value={form.ruc} onChange={e => set('ruc', e.target.value)} autoFocus />
                {errores.ruc ? <div className="may-error">{errores.ruc}</div>
                  : rucVivo && <div className="form-hint" style={{ color: rucVivo.ok ? 'var(--green)' : 'var(--red)' }}>{rucVivo.ok ? <><CheckCircle2 size={11} /> Dígito verificador correcto</> : rucVivo.error}</div>}
              </div>
              <div className="form-group">
                <label className="form-label">Razón social</label>
                <input className="form-input" value={form.razon_social} onChange={e => set('razon_social', e.target.value)} />
                {errores.razon_social && <div className="may-error">{errores.razon_social}</div>}
              </div>
              <div className="form-group">
                <label className="form-label">Email para la factura (opcional)</label>
                <input className="form-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} />
                {errores.email && <div className="may-error">{errores.email}</div>}
              </div>
              <div className="form-group">
                <label className="form-label">Condición</label>
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
                {errores.plazo_dias && <div className="may-error">{errores.plazo_dias}</div>}
              </div>
            </fieldset>
            <div className="modal-footer">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={guardando}>Cerrar</button>
              {!bloqueado && (
                <button type="submit" className="btn btn-primary" disabled={guardando}>
                  {guardando ? <><Loader2 size={14} className="spinning" /> Guardando…</> : 'Guardar'}
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
