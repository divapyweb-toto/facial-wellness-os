// src/pages/bandeja/ChatPanel.jsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Send, Check, CheckCheck, AlertTriangle, Bot, Hand, Phone } from 'lucide-react'
import { ventanaAbierta } from './api'
import { nombreCliente, textoPreview } from './ListaConversaciones'

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

const hora = (iso) => new Date(iso).toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' })
const dia = (iso) => new Date(iso).toLocaleDateString('es-PY', { weekday: 'short', day: '2-digit', month: 'short' })

function Tilde({ estado }) {
  if (estado === 'leido') return <CheckCheck size={13} color="var(--accent)" aria-label="Leído" />
  if (estado === 'entregado') return <CheckCheck size={13} aria-label="Entregado" />
  if (estado === 'enviado') return <Check size={13} aria-label="Enviado" />
  if (estado === 'fallido') return <AlertTriangle size={13} color="var(--red)" aria-label="Falló" />
  return null
}

export default function ChatPanel({ conv, mensajes, cargando, prohibidas, onVolver, onTomar, onDevolver, onEnviar }) {
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState('')
  const finRef = useRef(null)
  const taRef = useRef(null)

  useEffect(() => { setTexto(''); setError('') }, [conv?.id])
  useEffect(() => { finRef.current?.scrollIntoView({ block: 'end' }) }, [mensajes.length, conv?.id])

  // Autoajuste de alto del textarea.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }, [texto])

  const grupos = useMemo(() => {
    const out = []
    let diaPrev = ''
    for (const m of mensajes) {
      const d = new Date(m.creado_en).toDateString()
      if (d !== diaPrev) { out.push({ tipo: 'dia', id: `d-${d}`, label: dia(m.creado_en) }); diaPrev = d }
      out.push({ tipo: 'msg', id: m.id, m })
    }
    return out
  }, [mensajes])

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
    setEnviando(true); setError('')
    try {
      await onEnviar(texto.trim())
      setTexto('')
    } catch (e) {
      setError(e?.message || 'No se pudo enviar. Probá de nuevo.')
    } finally {
      setEnviando(false)
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

      <div className="bandeja-mensajes">
        {cargando && <div className="skeleton skeleton-line" style={{ width: '40%' }} />}
        {!cargando && mensajes.length === 0 && (
          <div className="empty-state"><p className="empty-state-desc">Sin mensajes en esta conversación.</p></div>
        )}
        {grupos.map(g => g.tipo === 'dia'
          ? <div key={g.id} className="bandeja-dia">{g.label}</div>
          : (
            <div key={g.id} className={`burbuja ${g.m.direccion} ${g.m.estado === 'fallido' ? 'fallido' : ''}`}>
              {g.m.texto ? g.m.texto : <span className="burbuja-tipo">{textoPreview({ ...g.m, direccion: 'in' })}</span>}
              <div className="burbuja-pie">
                {hora(g.m.creado_en)}
                {g.m.direccion === 'out' && <Tilde estado={g.m.estado} />}
              </div>
            </div>
          ))}
        <div ref={finRef} />
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
