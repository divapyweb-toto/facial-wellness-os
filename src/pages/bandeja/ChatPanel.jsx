// src/pages/bandeja/ChatPanel.jsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Send, Bot, Hand, Phone, ChevronDown } from 'lucide-react'
import { ventanaAbierta } from './api'
import { nombreCliente } from './ListaConversaciones'
import BurbujaWA from './BurbujaWA'
import { armarLineaDeTiempo, reaccionesPorMensaje, colorAvatar } from './mensajeWA'
import { PLANTILLAS } from './plantillas'

const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// Aviso previo en pantalla: el filtro real está en el servidor (_shared/wa.ts).
export function palabraProhibida(texto, lista) {
  const t = sinTildes(texto)
  for (const p of lista || []) {
    const q = sinTildes(p).trim()
    if (!q) continue
    const re = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`)
    if (re.test(t)) return p
  }
  return null
}

export default function ChatPanel({ conv, mensajes, cargando, hayMas, cargandoMas, onMas, prohibidas, onVolver, onTomar, onDevolver, onEnviar }) {
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef(null)
  const pegadoRef = useRef(true)
  const convPrevRef = useRef(null)
  const altoPrevRef = useRef(0)
  const largoPrevRef = useRef(0)
  const [nuevos, setNuevos] = useState(0)
  const taRef = useRef(null)

  // Conversación actual, para que un envío que termina tarde no toque el chat nuevo.
  const convIdRef = useRef(conv?.id)
  convIdRef.current = conv?.id
  useEffect(() => { setTexto(''); setError(''); setEnviando(false) }, [conv?.id])

  // Scroll estilo WhatsApp: al abrir baja al final; si leías arriba no te mueve
  // (avisa con un botón); al cargar mensajes viejos mantiene tu posición.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (convPrevRef.current !== conv?.id) {
      convPrevRef.current = conv?.id; pegadoRef.current = true; setNuevos(0)
      el.scrollTop = el.scrollHeight
    } else if (altoPrevRef.current && el.scrollHeight > altoPrevRef.current && !pegadoRef.current && el.scrollTop < 80) {
      el.scrollTop += el.scrollHeight - altoPrevRef.current // mensajes viejos arriba
    } else if (pegadoRef.current) {
      el.scrollTop = el.scrollHeight
    } else if (mensajes.length > largoPrevRef.current && mensajes[mensajes.length - 1]?.direccion === 'in') {
      setNuevos(n => n + 1)
    }
    largoPrevRef.current = mensajes.length
    altoPrevRef.current = el.scrollHeight
  }, [mensajes, conv?.id])

  const alScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pegadoRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (pegadoRef.current) setNuevos(0)
    if (el.scrollTop < 60 && hayMas && !cargandoMas) { altoPrevRef.current = el.scrollHeight; onMas?.() }
  }
  const alFinal = () => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) }

  // Autoajuste de alto del textarea.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }, [texto])

  const ctx = useMemo(() => ({
    plantillas: PLANTILLAS,
    porWamid: new Map(mensajes.filter(m => m.wa_message_id).map(m => [m.wa_message_id, m])),
  }), [mensajes])
  const linea = useMemo(() => armarLineaDeTiempo(mensajes, ctx), [mensajes, ctx])
  const reacciones = useMemo(() => reaccionesPorMensaje(mensajes), [mensajes])

  if (!conv) {
    return (
      <section className="bandeja-chat">
        <div className="bandeja-vacio">
          <div className="empty-state">
            <p className="empty-state-title">Elegí un chat</p>
            <p className="empty-state-desc">Los marcados con punto amarillo esperan tu respuesta.</p>
          </div>
        </div>
      </section>
    )
  }

  const abierta = ventanaAbierta(conv)
  const prohibida = palabraProhibida(texto, prohibidas)
  const puedeEnviar = abierta && texto.trim() && !prohibida && !enviando
  const tel = conv.wa_clientes?.telefono

  async function enviar() {
    if (!puedeEnviar) return
    const convEnvio = conv.id
    const sigue = () => convIdRef.current === convEnvio // ¿seguís en el mismo chat?
    setEnviando(true); setError('')
    try {
      await onEnviar(texto.trim())
      if (sigue()) setTexto('') // si cambiaste de chat, no borra el borrador del otro
    } catch (e) {
      if (sigue()) setError(e?.message || 'No se pudo enviar. Probá de nuevo.')
    } finally {
      if (sigue()) setEnviando(false)
    }
  }

  function onKey(e) {
    // Escritorio: Enter manda, Shift+Enter baja de línea. En el celular el
    // Enter del teclado baja de línea y se manda con el botón.
    const tactil = window.matchMedia?.('(pointer: coarse)').matches
    if (e.key === 'Enter' && !e.shiftKey && !tactil && !e.nativeEvent.isComposing) {
      e.preventDefault()
      enviar()
    }
  }

  return (
    <section className="bandeja-chat">
      <header className="bandeja-chat-head">
        <button className="btn btn-ghost btn-icon bandeja-volver" onClick={onVolver} aria-label="Volver a la lista">
          <ArrowLeft size={20} />
        </button>
        <div className="bandeja-avatar" style={{ background: colorAvatar(nombreCliente(conv)) }}>{(nombreCliente(conv).replace(/^[@+]/, '')[0] || '?').toUpperCase()}</div>
        <div className="bandeja-chat-titulo">
          <div className="nombre">{nombreCliente(conv)}</div>
          <div className="sub">
            {conv.estado === 'humano' ? `Lo atendés vos${conv.asignado_a ? ` · ${conv.asignado_a}` : ''}` : conv.estado === 'ia' ? 'Lo atiende la IA' : 'Cerrada'}
            {tel ? ` · ${tel}` : ''}
          </div>
        </div>
        {tel && (
          <a className="btn btn-ghost btn-icon desktop-only" href={`tel:${tel}`} aria-label="Llamar">
            <Phone size={16} />
          </a>
        )}
        {conv.estado === 'humano'
          ? <button className="btn btn-secondary btn-sm" onClick={onDevolver}><Bot size={14} /> Devolver a IA</button>
          : <button className="btn btn-primary btn-sm" onClick={onTomar}><Hand size={14} /> Tomar chat</button>}
      </header>

      <div className="bandeja-mensajes-caja">
        <div className="bandeja-mensajes" ref={scrollRef} onScroll={alScroll}>
          {cargandoMas && <div className="wa-cargando-mas">Cargando mensajes anteriores…</div>}
          {cargando && !mensajes.length && <div className="wa-cargando-mas">Abriendo chat…</div>}
          {!cargando && mensajes.length === 0 && (
            <div className="wa-sistema">Sin mensajes en esta conversación.</div>
          )}
          {linea.map(g => g.tipo === 'dia'
            ? <div key={g.id} className="wa-dia"><span>{g.label}</span></div>
            : <BurbujaWA key={g.id} item={g} reacciones={reacciones[g.v.wamid]} />)}
        </div>
        {nuevos > 0 && (
          <button className="wa-bajar" onClick={alFinal} aria-label="Ir al último mensaje">
            <ChevronDown size={20} /><span>{nuevos}</span>
          </button>
        )}
      </div>

      {!abierta && (
        <div className="bandeja-aviso alert-warning">
          Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo deja mandar plantillas aprobadas. Escribile desde tu número o esperá a que responda.
        </div>
      )}
      {prohibida && (
        <div className="bandeja-aviso alert-error">
          El mensaje tiene «{prohibida}», que está en la lista de palabras prohibidas. Cambiala para poder enviarlo.
        </div>
      )}
      {error && <div className="bandeja-aviso alert-error">{error}</div>}
      {conv.estado === 'ia' && abierta && (
        <div className="bandeja-aviso" style={{ color: 'var(--text-muted)' }}>
          Al enviar, tomás el chat y la IA deja de responder hasta que lo devuelvas.
        </div>
      )}

      <div className="bandeja-composer">
        <textarea
          ref={taRef}
          className="form-input"
          rows={1}
          placeholder={abierta ? 'Escribí tu respuesta…' : 'Ventana de 24 h cerrada'}
          value={texto}
          disabled={!abierta || enviando}
          onChange={e => setTexto(e.target.value)}
          onKeyDown={onKey}
          aria-label="Mensaje"
        />
        <button className="btn btn-primary" onClick={enviar} disabled={!puedeEnviar} aria-label="Enviar">
          <Send size={18} />
        </button>
      </div>
    </section>
  )
}
