// src/pages/reclamos/ReclamosPage.jsx
// ═══════════════════════════════════════════════════════════
// BUSCADOR DE PEDIDOS PARA RECLAMOS
//
// Un cliente escribe por WhatsApp: "mi pedido no llegó". Esta pantalla existe
// para responderle desde el celular en segundos, con el número de guía en la
// mano para reclamarle al courier.
//
// Tres decisiones que definen el diseño:
//
// 1. UN SOLO CAMPO. No se le pregunta al usuario si va a buscar por nombre,
//    teléfono, referencia o guía: se pega lo que sea y la pantalla resuelve.
//    Elegir el tipo de búsqueda es un paso más justo cuando hay apuro.
//
// 2. LA GUÍA ARRIBA Y GRANDE. Es el único dato por el que se entra acá. Va
//    primero, en grande y con botón de copiar, antes que cualquier otra cosa.
//
// 3. SOLO LECTURA. Esta pantalla no modifica nada en Supabase. Se abre en
//    medio de una conversación con un cliente y con apuro; que no pueda
//    romper datos es parte del diseño.
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { telefonoWhatsApp } from '../../lib/seguimiento'
import {
  construirIndice, buscarPedidos, guiaCourier, despachoPedido,
  estadoPedido, cobroPedido, fechaCorta, refMostrar,
} from '../../lib/buscadorPedidos'
import { MOTIVOS, mensajeReclamo, copiarTexto } from '../../lib/reclamos'
import {
  Search, X, ArrowLeft, Copy, CheckCircle, AlertTriangle, Clock,
  RefreshCw, MapPin, Package, Phone, Truck, Wallet, MessageCircle, Hash,
} from 'lucide-react'

// Caché de sesión. Reclamos se abre con el cliente esperando del otro lado, y
// cada entrada volvía a bajar ~1.400 filas de `ventas` + `entregas`. En el
// iPhone eso son varios segundos mirando un spinner. Se guarda el índice ya
// armado y se muestra al instante; la recarga sigue por detrás, así que el dato
// nunca queda viejo más de lo que tarda esa consulta.
let _cacheIndice = null            // { indice, at }
const CACHE_TTL_MS = 3 * 60 * 1000

const COL_VENTAS = 'id, n_referencia, fecha, cliente_nombre, cliente_telefono, cliente_direccion, ciudad, producto_nombre, cantidad, total, estado, transportadora, pago_anticipado, despachado_at'
const COL_ENTREGAS = 'nro_guia_pap, n_referencia, guia_transportadora, estado_pap, categoria, motivo, importe, cobrado, rendido, fecha_ingreso, fecha_entrega, mensajero, ciudad, producto, transportadora'

// ─── Bloque etiqueta + valor, la unidad visual de la ficha ──
function Dato({ icono: Icono, label, children, color }) {
  if (children == null || children === '') return null
  return (
    <div className="data-row">
      {Icono && <Icono size={15} />}
      <div className="data-col">
        <div className="data-label">{label}</div>
        <div className="data-value" style={color ? { color } : undefined}>{children}</div>
      </div>
    </div>
  )
}

function Seccion({ titulo, children }) {
  return (
    <div className="card" style={{ padding: 14, marginBottom: 12 }}>
      <div className="section-label" style={{ marginBottom: 6 }}>{titulo}</div>
      {children}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// FICHA
// ═══════════════════════════════════════════════════════════
function Ficha({ pedido, onVolver }) {
  const { toast } = useToast()
  const [motivo, setMotivo] = useState('')
  const [copiado, setCopiado] = useState(null)

  const guia = useMemo(() => guiaCourier(pedido), [pedido])
  const desp = useMemo(() => despachoPedido(pedido), [pedido])
  const est = useMemo(() => estadoPedido(pedido), [pedido])
  const cobro = useMemo(() => cobroPedido(pedido), [pedido])
  const wa = telefonoWhatsApp(pedido.cliente_telefono)

  const copiar = async (texto, cual) => {
    const ok = await copiarTexto(texto)
    if (ok) { setCopiado(cual); setTimeout(() => setCopiado(null), 2000) }
    else toast('No se pudo copiar. Mantené presionado el texto para copiarlo a mano.', 'error')
  }

  // El motivo "figura entregado pero no lo recibió" solo se ofrece cuando el
  // courier efectivamente lo dio por entregado; en cualquier otro caso es un
  // motivo que no aplica y solo estorba.
  const motivosVisibles = MOTIVOS.filter(m => !m.soloSiEntregado || est.label === 'Entregado')

  return (
    <div className="fade-in">
      <button className="btn btn-ghost btn-sm" onClick={onVolver} style={{ marginBottom: 12 }}>
        <ArrowLeft size={15} /> Volver a la búsqueda
      </button>

      {/* ── Cabecera ── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
            {pedido.cliente_nombre || 'Pedido sin cliente registrado'}
          </h2>
          <span className="badge" style={{ background: 'transparent', border: `1px solid ${est.color}`, color: est.color }}>
            {est.label}
          </span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          {pedido.n_referencia ? `Pedido ${refMostrar(pedido.n_referencia)}` : 'Sin número de referencia'}
          {pedido.ciudad ? ` · ${pedido.ciudad}` : ''}
        </div>
      </div>

      {/* ── Aviso: el courier y el sistema no coinciden ── */}
      {est.discrepancia && (
        <div className="alert alert-warning" style={{ marginBottom: 12 }}>
          <AlertTriangle size={16} />
          <span>{est.discrepancia}</span>
        </div>
      )}

      {/* ── Este pedido no tiene venta cargada ── */}
      {pedido.soloEntrega && (
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          <AlertTriangle size={16} />
          <span>Este paquete está en los reportes del courier pero no cruza con ninguna venta del sistema. Los datos del cliente no están disponibles.</span>
        </div>
      )}

      {/* ── LA GUÍA ── lo que venís a buscar. Pieza central de la pantalla. */}
      <div className={guia.numero ? 'guia-card' : 'card'} style={{ marginBottom: 12, ...(guia.numero ? {} : { padding: 16 }) }}>
        {guia.numero ? (
          <>
            <div className="section-label" style={{ color: 'var(--accent)', marginBottom: 6 }}>
              {guia.etiqueta}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', position: 'relative' }}>
              <span className="guia-num">{guia.numero}</span>
              <button className="btn btn-primary" onClick={() => copiar(guia.numero, 'guia')} style={{ marginLeft: 'auto' }}>
                {copiado === 'guia' ? <><CheckCircle size={15} /> Copiado</> : <><Copy size={15} /> Copiar</>}
              </button>
            </div>
            {guia.extra && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, position: 'relative' }}>{guia.extra}</div>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <Clock size={17} color="var(--yellow)" style={{ marginTop: 1, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--yellow)' }}>Sin guía asignada</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>{guia.falta}</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Envío ── */}
      <Seccion titulo="Envío">
        <Dato icono={Truck} label="Courier">
          {pedido.transportadora === 'lucero' ? 'Lucero del Este'
            : pedido.transportadora === 'pap' ? 'Punto a Punto'
            : 'Otro courier'}
        </Dato>
        <Dato icono={Clock} label="Despachado">
          {desp.fecha ? (
            <>
              {fechaCorta(desp.fecha)}
              {desp.dias != null && (
                <span style={{ color: desp.dias > 10 ? 'var(--red)' : 'var(--text-muted)', marginLeft: 6 }}>
                  ({desp.dias} {desp.dias === 1 ? 'día' : 'días'} atrás)
                </span>
              )}
              {!desp.exacta && (
                <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 2 }}>
                  Es la fecha del pedido, no la del despacho — no hay fecha de despacho registrada.
                </div>
              )}
            </>
          ) : 'Sin fecha registrada'}
        </Dato>
        {est.fechaEntrega && <Dato icono={CheckCircle} label="Entregado el">{fechaCorta(est.fechaEntrega)}</Dato>}
        {est.detalleCourier && <Dato icono={Package} label="Estado según el courier">{est.detalleCourier}</Dato>}
        {est.motivo && <Dato icono={AlertTriangle} label="Motivo del courier">{est.motivo}</Dato>}
        {est.mensajero && <Dato icono={MapPin} label="Mensajero">{est.mensajero}</Dato>}
        <Dato icono={Wallet} label="Cobro" color={cobro.color}>
          {cobro.label}
          {cobro.monto ? ` · ${formatGs(cobro.monto)}` : ''}
          {cobro.rendido === true && <span style={{ color: 'var(--text-muted)' }}> · el courier ya te lo depositó</span>}
          {cobro.rendido === false && <span style={{ color: 'var(--yellow)' }}> · el courier todavía no te lo depositó</span>}
        </Dato>
      </Seccion>

      {/* ── Cliente ── */}
      {!pedido.soloEntrega && (
        <Seccion titulo="Cliente">
          <Dato icono={Phone} label="Teléfono">
            {pedido.cliente_telefono ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {pedido.cliente_telefono}
                {wa && (
                  <a className="btn btn-ghost btn-sm" href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer">
                    <MessageCircle size={14} /> WhatsApp
                  </a>
                )}
              </span>
            ) : 'Sin teléfono'}
          </Dato>
          <Dato icono={MapPin} label="Ciudad">{pedido.ciudad || 'Sin ciudad'}</Dato>
          <Dato icono={MapPin} label="Dirección">{pedido.cliente_direccion || 'Sin dirección'}</Dato>
        </Seccion>
      )}

      {/* ── Pedido ── */}
      <Seccion titulo="Pedido">
        {pedido.lineas.length ? pedido.lineas.map((l, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: i < pedido.lineas.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
            <span style={{ fontSize: 14 }}>
              {l.producto_nombre}
              {(l.cantidad || 1) > 1 && <span style={{ color: 'var(--text-muted)' }}> ×{l.cantidad}</span>}
            </span>
            <span style={{ fontSize: 14, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatGs(l.total)}</span>
          </div>
        )) : <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Sin detalle de productos</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Importe</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>
            {pedido.pago_anticipado ? `${formatGs(pedido.total)} (prepago)` : formatGs(pedido.total)}
          </span>
        </div>
      </Seccion>

      {/* ── Reclamo ── */}
      <Seccion titulo="Reclamar al courier">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {motivosVisibles.map(m => (
            <button
              key={m.id}
              onClick={() => setMotivo(m.texto)}
              className={`chip-choice${motivo === m.texto ? ' active' : ''}`}
            >
              {m.texto}
            </button>
          ))}
        </div>
        <textarea
          className="form-textarea"
          value={motivo}
          onChange={e => setMotivo(e.target.value)}
          placeholder="Motivo del reclamo — elegí uno de arriba o escribilo"
          rows={3}
          style={{ width: '100%', marginBottom: 10 }}
        />
        <button
          className="btn btn-primary btn-lg"
          style={{ width: '100%' }}
          onClick={() => copiar(mensajeReclamo(pedido, motivo), 'reclamo')}
        >
          {copiado === 'reclamo'
            ? <><CheckCircle size={17} /> Reclamo copiado — pegalo en el chat</>
            : <><Copy size={17} /> Copiar reclamo</>}
        </button>
        <pre className="copy-block" style={{ marginTop: 10 }}>{mensajeReclamo(pedido, motivo)}</pre>
      </Seccion>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// FILA DE RESULTADO
// ═══════════════════════════════════════════════════════════
function FilaResultado({ pedido, onClick }) {
  const est = estadoPedido(pedido)
  const desp = despachoPedido(pedido)
  const guia = guiaCourier(pedido)
  return (
    <button onClick={onClick} className="list-card" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pedido.cliente_nombre || (pedido.soloEntrega ? 'Paquete sin venta cargada' : 'Sin nombre')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {refMostrar(pedido.n_referencia) || 'sin ref'}
            {pedido.ciudad ? ` · ${pedido.ciudad}` : ''}
            {desp.fecha ? ` · ${fechaCorta(desp.fecha)}` : ''}
            {desp.dias != null ? ` (${desp.dias}d)` : ''}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, fontFamily: 'ui-monospace, Menlo, monospace' }}>
            {guia.numero || <span style={{ color: 'var(--yellow)', fontFamily: 'inherit' }}>sin guía</span>}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <span className="badge" style={{ background: 'transparent', border: `1px solid ${est.color}`, color: est.color, fontSize: 10 }}>
            {est.label}
          </span>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 5 }}>{formatGs(pedido.total)}</div>
        </div>
      </div>
    </button>
  )
}

// ═══════════════════════════════════════════════════════════
// PÁGINA
// ═══════════════════════════════════════════════════════════
export default function ReclamosPage() {
  const { toast } = useToast()
  const [indice, setIndice] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [elegido, setElegido] = useState(null)
  const inputRef = useRef(null)

  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (!silencioso) setCargando(true)
    setError(null)
    try {
      // Paginado: sin esto Supabase corta en 1.000 filas y un pedido podría
      // "no existir" justo cuando lo estás buscando con el cliente esperando.
      // `entregas` no tiene columna id — se ordena por su clave real.
      const [vts, ents] = await Promise.all([
        fetchAll(() => supabase.from('ventas').select(COL_VENTAS).is('deleted_at', null)),
        fetchAll(() => supabase.from('entregas').select(COL_ENTREGAS), { columnaOrden: 'nro_guia_pap' }),
      ])
      const idx = construirIndice(vts || [], ents || [])
      _cacheIndice = { indice: idx, at: Date.now() }
      setIndice(idx)
    } catch (e) {
      // Si falla una recarga silenciosa no se rompe la pantalla: lo que está en
      // pantalla vino del caché y sigue sirviendo para buscar.
      if (!silencioso) {
        setError(e?.message || String(e))
        toast('No se pudieron cargar los pedidos', 'error')
      } else {
        console.warn('[reclamos] la recarga en segundo plano falló:', e?.message || e)
      }
    } finally {
      if (!silencioso) setCargando(false)
    }
  }, [toast])

  useEffect(() => {
    if (_cacheIndice && Date.now() - _cacheIndice.at < CACHE_TTL_MS) {
      setIndice(_cacheIndice.indice)
      setCargando(false)
      cargar({ silencioso: true })     // se refresca por detrás
    } else {
      cargar()
    }
  }, [cargar])
  useEffect(() => { if (!cargando && !elegido) inputRef.current?.focus() }, [cargando, elegido])

  const resultados = useMemo(() => buscarPedidos(indice, q), [indice, q])

  // Una sola coincidencia: se abre la ficha directo, sin pedir un clic de más.
  useEffect(() => {
    if (resultados.length === 1 && q.trim().length >= 3) setElegido(resultados[0])
  }, [resultados, q])

  const limpiar = () => { setQ(''); setElegido(null); inputRef.current?.focus() }

  if (elegido) {
    return (
      <div className="page-content">
        <Ficha pedido={elegido} onVolver={() => setElegido(null)} />
      </div>
    )
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reclamos</h1>
          <p className="page-subtitle">Buscá el pedido y sacá el número de guía para reclamarle al courier</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-sm" onClick={cargar} disabled={cargando}>
            <RefreshCw size={14} className={cargando ? 'spinning' : ''} /> Actualizar
          </button>
        </div>
      </div>

      {/* ── Buscador ── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg-base)', paddingBottom: 10 }}>
        <div className="search-field">
          <Search size={19} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Nombre, teléfono, referencia o guía"
            autoComplete="off"
            /* inputMode text a propósito: el campo acepta números Y letras, y
               forzar el teclado numérico en el celular obligaría a cambiarlo
               a mano cada vez que se busca por nombre. */
          />
          {q && (
            <button onClick={limpiar} className="btn-icon" style={{ flexShrink: 0 }} aria-label="Limpiar">
              <X size={17} color="var(--text-muted)" />
            </button>
          )}
        </div>
      </div>

      {cargando && (
        <div className="empty-state">
          <div className="spinning" style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} />
          <div className="empty-state-desc" style={{ marginTop: 12 }}>Cargando pedidos…</div>
        </div>
      )}

      {error && !cargando && (
        <div className="alert alert-error"><AlertTriangle size={16} /><span>{error}</span></div>
      )}

      {!cargando && !error && (
        <>
          {q.trim().length < 2 ? (
            <div className="empty-state">
              <Search size={30} className="empty-state-icon" />
              <div className="empty-state-title">Buscá un pedido</div>
              <div className="empty-state-desc">
                Escribí el nombre del cliente, su teléfono, el número de referencia o la guía del courier.
                <br />No importan las tildes, las mayúsculas ni cómo esté escrito el teléfono.
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 14 }}>
                {indice.length} pedidos cargados
              </div>
            </div>
          ) : resultados.length === 0 ? (
            <div className="empty-state">
              <Package size={30} className="empty-state-icon" />
              <div className="empty-state-title">Sin resultados para “{q}”</div>
              <div className="empty-state-desc">
                Probá con menos letras, solo el apellido, o los últimos dígitos del teléfono.
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 8px' }}>
                {resultados.length} {resultados.length === 1 ? 'coincidencia' : 'coincidencias'}
                {resultados[0]?._motivo ? ` · mejor coincidencia por ${resultados[0]._motivo}` : ''}
              </div>
              {resultados.map(p => (
                <FilaResultado key={p.clave} pedido={p} onClick={() => setElegido(p)} />
              ))}
            </>
          )}
        </>
      )}
    </div>
  )
}
