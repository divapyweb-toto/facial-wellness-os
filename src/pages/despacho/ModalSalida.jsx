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
import { hoyLocal } from '../../lib/fechas'
import { getTienda } from '../../lib/tienda'
import { ScanLine, CheckCircle, AlertTriangle, X, Truck, Clock, ListChecks } from 'lucide-react'

const DIAS_OLVIDADO = 3
const fmtGs = (n) => `Gs. ${Number(n || 0).toLocaleString('es-PY')}`
// Días calendario en hora de Paraguay: con new Date('2026-10-08') (UTC) un
// pedido de hoy podía contar como de ayer y la alerta de olvidados se adelantaba.
export function diasDesde(f, hoy = hoyLocal()) {
  if (!f) return null
  const aUTC = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
  const n = Math.round((aUTC(hoy) - aUTC(f)) / 86400000)
  return isNaN(n) ? null : n
}

// Un pedido de 2 productos son 2 filas con la MISMA referencia: el índice
// guarda la lista entera, para marcar todas al escanear la única guía.
export function indexarPorRef(ventas) {
  const m = {}
  for (const v of ventas) {
    const k = interpretarEscaneo(v.n_referencia).ref
    if (k) { if (!m[k]) m[k] = []; m[k].push(v) }
  }
  return m
}

// Lo que el recolector cuenta son CAJAS: una por referencia, no por fila.
export const contarPaquetes = (filas) => new Set(filas.map(f => f.n_referencia || `_id_${f.id}`)).size

// Filtro por courier y por tienda (la del selector global). Sin transportadora
// guardada se asume PaP, igual que al cargar la venta; sin tienda, 'fw'
// (valor por defecto de la base).
export function filtrarSalida(ventas, { transportadora = 'todas', tienda = 'todas' } = {}) {
  return ventas.filter(v =>
    (transportadora === 'todas' || (v.transportadora || 'pap') === transportadora) &&
    (tienda === 'todas' || (v.tienda || 'fw') === tienda))
}

const COLS_BASE = 'id, n_referencia, cliente_nombre, ciudad, producto_nombre, cantidad, total, estado, fecha, despachado_at'
const FILTROS_TRANSP = [
  { id: 'todas', label: 'Todas' }, { id: 'pap', label: 'PaP' },
  { id: 'lucero', label: 'Lucero' }, { id: 'otra', label: 'Otra' },
]

export default function ModalSalida({ onClose, onConfirmado }) {
  const { toast } = useToast()
  const inputRef = useRef(null)
  const [ventas, setVentas] = useState([])
  const [loading, setLoading] = useState(true)
  const [confirmando, setConfirmando] = useState(false)
  const [valor, setValor] = useState('')
  const [tanda, setTanda] = useState([])
  const [ultimo, setUltimo] = useState(null)
  const [filtroTransp, setFiltroTransp] = useState('todas')
  const tienda = getTienda()

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      // Paginado: si se cortara en 1.000, una guía escaneada podría "no encontrarse"
      // transportadora y tienda permiten filtrar; si la base no las tuviera,
      // se reintenta sin ellas (todo cae en PaP / sin filtro de tienda).
      const traer = (cols) => fetchAll(() => supabase.from('ventas').select(cols).is('deleted_at', null))
      let data
      try { data = await traer(`${COLS_BASE}, transportadora, tienda`) }
      catch (e) {
        if (!/does not exist|Could not find|42703/i.test(`${e?.message} ${e?.code}`)) throw e
        data = await traer(COLS_BASE)
      }
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

  const idxRef = useMemo(() => indexarPorRef(ventas), [ventas])

  // Pendientes que todavía no salieron del depósito, del courier y la tienda
  // elegidos: así "Marcar todos" no mezcla la pila de PaP con la de Lucero.
  const esperados = useMemo(
    () => filtrarSalida(ventas, { transportadora: filtroTransp, tienda })
      .filter(v => v.estado === 'pendiente' && !v.despachado_at),
    [ventas, filtroTransp, tienda]
  )
  // Couriers distintos entre los pendientes visibles (para no mezclar en "Marcar todos")
  const couriersEsperados = useMemo(
    () => new Set(esperados.map(v => v.transportadora || 'pap')).size,
    [esperados]
  )
  const paquetesEsperados = useMemo(() => contarPaquetes(esperados), [esperados])
  // Cargados hace rato y nunca despachados: plata dormida
  const olvidados = useMemo(
    () => esperados.filter(v => (diasDesde(v.fecha) ?? 0) >= DIAS_OLVIDADO),
    [esperados]
  )

  const tandaIds = useMemo(() => new Set(tanda.map(t => t.id)), [tanda])

  const procesar = (bruto) => {
    const { ref } = interpretarEscaneo(bruto)
    if (!ref) return

    const filas = idxRef[ref] || []
    const venta = filas[0]
    if (!venta) {
      beep(false)
      setUltimo({ tipo: 'error', titulo: 'No encontrado', detalle: `"${bruto}" no coincide con ninguna venta cargada.` })
      return
    }
    const sinSalir = filas.filter(f => !f.despachado_at)
    if (!sinSalir.length) {
      beep(false)
      const f = new Date(venta.despachado_at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })
      setUltimo({ tipo: 'error', titulo: 'Ya fue despachado', detalle: `#${venta.n_referencia} salió el ${f}.` })
      return
    }
    // Una guía = un paquete = todas sus líneas (antes solo se marcaba una).
    const nuevas = sinSalir.filter(f => !tandaIds.has(f.id))
    if (!nuevas.length) {
      beep(false)
      setUltimo({ tipo: 'warn', titulo: 'Repetido en esta tanda', detalle: `#${venta.n_referencia} ya está en la lista.` })
      return
    }

    const raro = nuevas.some(f => f.estado !== 'pendiente')
    // Escaneado de un courier distinto al filtro elegido: se agrega igual
    // (la caja ya está en la mano), pero se avisa.
    const otroCourier = filtroTransp !== 'todas' && (venta.transportadora || 'pap') !== filtroTransp
    beep(true)
    setTanda(prev => [...nuevas.map(f => ({ ...f, _raro: f.estado !== 'pendiente' })), ...prev])
    const productos = nuevas.map(f => `${f.producto_nombre} ×${f.cantidad || 1}`).join(' + ')
    setUltimo({
      tipo: raro || otroCourier ? 'warn' : 'ok',
      titulo: raro
        ? `Figura como ${String(nuevas.find(f => f.estado !== 'pendiente').estado).toUpperCase()}`
        : otroCourier ? `Es de ${(venta.transportadora || 'pap').toUpperCase()}, no de ${filtroTransp.toUpperCase()}` : 'Listo para salir',
      detalle: `#${venta.n_referencia} · ${productos} · ${venta.ciudad || '—'}${raro ? ' — revisá el estado' : ''}`,
    })
  }

  const onSubmit = (e) => { e.preventDefault(); procesar(valor); setValor('') }
  // Se quita el paquete entero (todas las líneas de esa referencia)
  const mismaCaja = (a, b) => (a.n_referencia ? a.n_referencia === b.n_referencia : a.id === b.id)
  const quitar = (fila) => setTanda(prev => prev.filter(t => !mismaCaja(t, fila)))

  // ── Modo manual (por si te olvidaste de escanear y ya despachaste) ──
  const [modoManual, setModoManual] = useState(false)

  // Agrega a la tanda TODOS los pendientes que no estén ya cargados
  const agregarTodos = () => {
    const yaEnTanda = new Set(tanda.map(t => t.id))
    const nuevos = esperados
      .filter(v => !yaEnTanda.has(v.id))
      .map(v => ({ ...v, _raro: v.estado !== 'pendiente' }))
    if (!nuevos.length) return
    setTanda(prev => [...nuevos, ...prev])
    beep(true)
    const nPaq = contarPaquetes(nuevos)
    setUltimo({ tipo: 'ok', titulo: `${nPaq} paquete${nPaq === 1 ? '' : 's'} agregado${nPaq === 1 ? '' : 's'} a la tanda`, detalle: 'Todos los pendientes quedaron listos para confirmar la salida.' })
  }

  // Agrega o quita un pedido puntual de la tanda (para seleccionar 1 por 1)
  const toggleManual = (venta) => {
    if (tandaIds.has(venta.id)) {
      quitar(venta)
    } else {
      // Entra la caja completa: todas las líneas pendientes de esa referencia
      const lineas = esperados.filter(v => mismaCaja(v, venta) && !tandaIds.has(v.id))
      setTanda(prev => [...lineas.map(v => ({ ...v, _raro: v.estado !== 'pendiente' })), ...prev])
      beep(true)
    }
  }

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

      const nPaq = contarPaquetes(tanda.filter(t => !t.despachado_at))
      toast(`${nPaq} paquete${nPaq === 1 ? '' : 's'} registrados como despachados`, 'success')
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
  // Cajas reales de la tanda (un pedido multiproducto es UNA caja)
  const paquetesTanda = contarPaquetes(tanda)
  // Con varios couriers mezclados, "Marcar todos" pediría elegir uno antes
  const mezclaCouriers = filtroTransp === 'todas' && couriersEsperados > 1

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
              <strong style={{ color: 'var(--yellow)' }}>{contarPaquetes(olvidados)} pedido{contarPaquetes(olvidados) === 1 ? '' : 's'} sin despachar hace {DIAS_OLVIDADO}+ días.</strong>{' '}
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

        {/* Filtro por courier: cada recolector se lleva solo su pila */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10, fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>Transportadora:</span>
          {FILTROS_TRANSP.map(t => (
            <button
              key={t.id}
              type="button"
              className={`btn btn-sm ${filtroTransp === t.id ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFiltroTransp(t.id)}
              disabled={confirmando}
            >{t.label}</button>
          ))}
          {tienda !== 'todas' && (
            <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>· Tienda: {tienda === 'voltra' ? 'Voltra' : 'Facial Wellness'}</span>
          )}
        </div>

        {/* Acciones manuales — por si te olvidaste de escanear y ya despachaste */}
        {!loading && esperados.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={agregarTodos}
                disabled={confirmando || mezclaCouriers}
                className="btn btn-secondary btn-sm"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                title={mezclaCouriers ? 'Hay pendientes de varias transportadoras: elegí una arriba' : 'Agrega todos los pendientes a la tanda de una vez'}
              >
                <CheckCircle size={13} /> Marcar todos ({paquetesEsperados}){mezclaCouriers ? ' — elegí transportadora' : ''}
              </button>
              <button
                type="button"
                onClick={() => setModoManual(m => !m)}
                disabled={confirmando}
                className="btn btn-ghost btn-sm"
                style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)' }}
                title="Elegí uno por uno de la lista"
              >
                <ListChecks size={13} /> {modoManual ? 'Ocultar lista' : 'Elegir 1 por 1'}
              </button>
            </div>

            {/* Lista para seleccionar 1 por 1 */}
            {modoManual && (
              <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 10, maxHeight: 260, overflowY: 'auto' }}>
                {esperados.map(v => {
                  const enTanda = tandaIds.has(v.id)
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => toggleManual(v)}
                      disabled={confirmando}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                        padding: '9px 12px', border: 'none', borderBottom: '1px solid var(--border-subtle)',
                        background: enTanda ? 'var(--green-dim)' : 'transparent', cursor: 'pointer',
                      }}
                    >
                      <div style={{
                        width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                        border: `1.5px solid ${enTanda ? 'var(--green)' : 'var(--border)'}`,
                        background: enTanda ? 'var(--green)' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {enTanda && <CheckCircle size={12} color="#fff" />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                          #{v.n_referencia} · {v.cliente_nombre || '—'}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {v.producto_nombre} ×{v.cantidad || 1} · {v.ciudad || '—'} · {fmtGs(v.total)}
                        </div>
                      </div>
                      {(diasDesde(v.fecha) ?? 0) >= DIAS_OLVIDADO && (
                        <span style={{ fontSize: 10, color: 'var(--yellow)', whiteSpace: 'nowrap' }}>
                          {diasDesde(v.fecha)}d
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Contador — el número que tiene que coincidir con el recibo de PaP */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--accent)', lineHeight: 1 }}>
              {paquetesTanda}{' '}
              <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>
                de {paquetesEsperados} pendientes
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
                El recibo de la transportadora debe decir
              </div>
              <div style={{ fontSize: 17, fontWeight: 800, fontFamily: 'var(--font-display)' }}>
                {paquetesTanda} paquete{paquetesTanda === 1 ? '' : 's'}
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
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => quitar(t)} title="Quitar" style={{ color: 'var(--red)' }}>
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
            {confirmando ? 'Registrando…' : `Confirmar salida de ${paquetesTanda} paquete${paquetesTanda === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
