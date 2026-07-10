// src/pages/despacho/ModalSalida.jsx
// ═══════════════════════════════════════════════════════════
// CONFIRMAR SALIDA — escaneo al entregar la tanda al courier
//
// Se escanea cada caja justo cuando se la entregás al recolector.
// Eso registra la FECHA REAL DE DESPACHO (despachado_at), que hasta
// ahora no existía.
//
// No genera ningún documento: las cabeceras ya se mandaron antes por
// WhatsApp, y el recibo lo emite Punto a Punto. Lo que sí aporta es el
// CONTEO VERIFICADO: sabés cuántas cajas entregaste realmente, para
// cotejarlo con el número que el recolector escribe a mano en su recibo.
//
// Nada de esto toca el stock: la mercadería ya se descontó al cargar
// la venta. Acá solo se registra que la caja salió del depósito.
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { interpretarEscaneo } from '../../lib/barcode'
import { beep } from '../../lib/beep'
import { ScanLine, CheckCircle, AlertTriangle, X, Truck, Clock } from 'lucide-react'

const DIAS_OLVIDADO = 3
const fmtGs = (n) => `Gs. ${Number(n || 0).toLocaleString('es-PY')}`
const diasDesde = (f) => (f ? Math.floor((Date.now() - new Date(f).getTime()) / 86400000) : null)

export default function ModalSalida({ onClose, onConfirmado }) {
  const { toast } = useToast()
  const inputRef = useRef(null)
  const [ventas, setVentas] = useState([])
  const [loading, setLoading] = useState(true)
  const [confirmando, setConfirmando] = useState(false)
  const [valor, setValor] = useState('')
  const [tanda, setTanda] = useState([])
  const [ultimo, setUltimo] = useState(null)

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      // Paginado: si se cortara en 1.000, una guía escaneada podría "no encontrarse"
      const data = await fetchAll(() => supabase
        .from('ventas')
        .select('id, n_referencia, cliente_nombre, ciudad, producto_nombre, cantidad, total, estado, fecha, despachado_at')
        .is('deleted_at', null))
      setVentas(data || [])
    } catch (e) {
      toast('Error cargando pedidos: ' + e.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { cargar() }, [cargar])

  // El lector escribe y manda Enter: el campo tiene que estar siempre activo.
  useEffect(() => {
    const t = setInterval(() => {
      if (inputRef.current && document.activeElement !== inputRef.current && !confirmando) {
        inputRef.current.focus()
      }
    }, 800)
    return () => clearInterval(t)
  }, [confirmando])

  const idxRef = useMemo(() => {
    const m = {}
    for (const v of ventas) {
      const k = interpretarEscaneo(v.n_referencia).ref
      if (k) m[k] = v
    }
    return m
  }, [ventas])

  // Pendientes que todavía no salieron del depósito
  const esperados = useMemo(
    () => ventas.filter(v => v.estado === 'pendiente' && !v.despachado_at),
    [ventas]
  )
  // Cargados hace rato y nunca despachados: plata dormida
  const olvidados = useMemo(
    () => esperados.filter(v => (diasDesde(v.fecha) ?? 0) >= DIAS_OLVIDADO),
    [esperados]
  )

  const tandaIds = useMemo(() => new Set(tanda.map(t => t.id)), [tanda])

  const procesar = (bruto) => {
    const { ref } = interpretarEscaneo(bruto)
    if (!ref) return

    const venta = idxRef[ref]
    if (!venta) {
      beep(false)
      setUltimo({ tipo: 'error', titulo: 'No encontrado', detalle: `"${bruto}" no coincide con ninguna venta cargada.` })
      return
    }
    if (venta.despachado_at) {
      beep(false)
      const f = new Date(venta.despachado_at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })
      setUltimo({ tipo: 'error', titulo: 'Ya fue despachado', detalle: `#${venta.n_referencia} salió el ${f}.` })
      return
    }
    if (tandaIds.has(venta.id)) {
      beep(false)
      setUltimo({ tipo: 'warn', titulo: 'Repetido en esta tanda', detalle: `#${venta.n_referencia} ya está en la lista.` })
      return
    }

    const raro = venta.estado !== 'pendiente'
    beep(true)
    setTanda(prev => [{ ...venta, _raro: raro }, ...prev])
    setUltimo({
      tipo: raro ? 'warn' : 'ok',
      titulo: raro ? `Figura como ${venta.estado.toUpperCase()}` : 'Listo para salir',
      detalle: `#${venta.n_referencia} · ${venta.producto_nombre} ×${venta.cantidad || 1} · ${venta.ciudad || '—'}${raro ? ' — revisá el estado' : ''}`,
    })
  }

  const onSubmit = (e) => { e.preventDefault(); procesar(valor); setValor('') }
  const quitar = (id) => setTanda(prev => prev.filter(t => t.id !== id))

  const confirmar = async () => {
    if (!tanda.length) return
    setConfirmando(true)
    try {
      const ids = tanda.filter(t => !t.despachado_at).map(t => t.id)
      const { error } = await supabase
        .from('ventas')
        .update({ despachado_at: new Date().toISOString() })
        .in('id', ids)
        .is('despachado_at', null) // idempotente: no pisa una salida ya registrada
      if (error) throw error

      toast(`${ids.length} paquete${ids.length === 1 ? '' : 's'} registrados como despachados`, 'success')
      setTanda([])
      setUltimo(null)
      await cargar()
      onConfirmado?.()
    } catch (e) {
      toast('Error confirmando salida: ' + e.message, 'error')
    } finally {
      setConfirmando(false)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }

  const totalCobrar = tanda.reduce((s, t) => s + Number(t.total || 0), 0)

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !confirmando && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Truck size={18} color="var(--accent)" /> Confirmar salida
          </h2>
          {!confirmando && <button className="modal-close" onClick={onClose}><X size={18} /></button>}
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 0 }}>
          Escaneá cada caja al entregársela al recolector. Se registra la fecha real de salida y te queda el <strong>conteo verificado</strong> para cotejar con el número que él escribe en su recibo.
        </p>

        {/* Alerta: pedidos olvidados */}
        {!loading && olvidados.length > 0 && (
          <div style={{
            padding: '10px 14px', borderRadius: 10, marginBottom: 12,
            background: 'var(--bg-hover)', border: '1px solid var(--yellow)',
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
            <Clock size={15} color="var(--yellow)" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--yellow)' }}>{olvidados.length} pedido{olvidados.length === 1 ? '' : 's'} sin despachar hace {DIAS_OLVIDADO}+ días.</strong>{' '}
              Están cargados y descontados del stock, pero nunca salieron. Es plata dormida.
            </div>
          </div>
        )}

        {/* Campo de escaneo */}
        <div style={{ border: '1px solid var(--accent)', borderRadius: 12, padding: '14px 16px', marginBottom: 12 }}>
          <form onSubmit={onSubmit}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <ScanLine size={14} color="var(--accent)" /> Escaneá la guía
            </label>
            <input
              ref={inputRef}
              className="form-input"
              value={valor}
              onChange={e => setValor(e.target.value)}
              placeholder="Apuntá el lector al código…"
              autoFocus
              autoComplete="off"
              disabled={confirmando || loading}
              style={{ fontSize: 20, fontFamily: 'var(--font-display)', letterSpacing: 1, padding: '10px 12px' }}
            />
          </form>

          {ultimo && (
            <div style={{
              marginTop: 10, padding: '9px 12px', borderRadius: 9,
              background: ultimo.tipo === 'ok' ? 'var(--green-dim)' : 'var(--bg-hover)',
              border: `1px solid ${ultimo.tipo === 'ok' ? 'var(--green)' : ultimo.tipo === 'warn' ? 'var(--yellow)' : 'var(--red)'}`,
              display: 'flex', alignItems: 'flex-start', gap: 9,
            }}>
              {ultimo.tipo === 'ok'
                ? <CheckCircle size={15} color="var(--green)" style={{ flexShrink: 0, marginTop: 1 }} />
                : <AlertTriangle size={15} color={ultimo.tipo === 'warn' ? 'var(--yellow)' : 'var(--red)'} style={{ flexShrink: 0, marginTop: 1 }} />}
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: ultimo.tipo === 'ok' ? 'var(--green)' : ultimo.tipo === 'warn' ? 'var(--yellow)' : 'var(--red)' }}>
                  {ultimo.titulo}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{ultimo.detalle}</div>
              </div>
            </div>
          )}
        </div>

        {/* Contador — el número que tiene que coincidir con el recibo de PaP */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--accent)', lineHeight: 1 }}>
              {tanda.length}{' '}
              <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>
                de {esperados.length} pendientes
              </span>
            </div>
            {tanda.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                Total a cobrar de la tanda: <strong>{fmtGs(totalCobrar)}</strong>
              </div>
            )}
          </div>
          {tanda.length > 0 && (
            <div style={{
              padding: '8px 14px', borderRadius: 10, background: 'var(--bg-hover)',
              border: '1px solid var(--border)', textAlign: 'right',
            }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                El recibo de PaP debe decir
              </div>
              <div style={{ fontSize: 17, fontWeight: 800, fontFamily: 'var(--font-display)' }}>
                {tanda.length} paquete{tanda.length === 1 ? '' : 's'}
              </div>
            </div>
          )}
        </div>

        {/* Lista escaneada */}
        {tanda.length > 0 && (
          <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
            <table className="tabla-responsive">
              <thead>
                <tr><th>Ref.</th><th>Cliente</th><th>Ciudad</th><th>Producto</th><th>A cobrar</th><th></th></tr>
              </thead>
              <tbody>
                {tanda.map(t => (
                  <tr key={t.id} style={t._raro ? { background: 'rgba(234,179,8,0.06)' } : undefined}>
                    <td data-label="Ref." className="mono">#{t.n_referencia}</td>
                    <td data-label="Cliente" style={{ fontSize: 12 }}>{t.cliente_nombre || '—'}</td>
                    <td data-label="Ciudad" className="muted" style={{ fontSize: 12 }}>{t.ciudad || '—'}</td>
                    <td data-label="Producto" style={{ fontSize: 12 }}>{t.producto_nombre} ×{t.cantidad || 1}</td>
                    <td data-label="A cobrar" style={{ fontWeight: 600 }}>{fmtGs(t.total)}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => quitar(t.id)} title="Quitar" style={{ color: 'var(--red)' }}>
                        <X size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="modal-footer" style={{ padding: 0, border: 'none', marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={confirmando}>Cerrar</button>
          <button className="btn btn-primary" onClick={confirmar} disabled={confirmando || !tanda.length}>
            <Truck size={15} />
            {confirmando ? 'Registrando…' : `Confirmar salida de ${tanda.length} paquete${tanda.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
