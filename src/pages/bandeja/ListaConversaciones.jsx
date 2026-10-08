// src/pages/bandeja/ListaConversaciones.jsx
import { Search, Bot, User, MessageCircle } from 'lucide-react'
import { ventanaAbierta } from './api'
import { textoVistaPrevia, colorAvatar } from './mensajeWA'
import { PLANTILLAS } from './plantillas'

export const FILTROS = [
  { id: 'todas', label: 'Todas' },
  { id: 'humano', label: 'Humano' },
  { id: 'ia', label: 'IA' },
  { id: 'cerrada', label: 'Cerradas' },
]

export function nombreCliente(conv) {
  const c = conv?.wa_clientes || {}
  return c.nombre || (c.wa_username ? `@${c.wa_username}` : '') || c.telefono || 'Cliente sin nombre'
}

export function horaCorta(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const hoy = new Date()
  if (d.toDateString() === hoy.toDateString()) return d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' })
  const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 1)
  if (d.toDateString() === ayer.toDateString()) return 'Ayer'
  return d.toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })
}

export function textoPreview(m) {
  if (!m) return 'Sin mensajes todavía'
  const pref = m.direccion === 'out' ? 'Vos: ' : ''
  return pref + (textoVistaPrevia(m, { plantillas: PLANTILLAS }) || (m.texto || `[${m.tipo || 'mensaje'}]`))
}

const inicial = (s) => (String(s || '?').replace(/^[@+]/, '').trim()[0] || '?').toUpperCase()

export default function ListaConversaciones({ conversaciones, ultimos, filtro, setFiltro, busqueda, setBusqueda, conteos, activaId, onElegir }) {
  return (
    <aside className="bandeja-lista">
      <div className="bandeja-lista-top">
        <div className="search-field">
          <Search size={16} />
          <input
            placeholder="Buscar por nombre o teléfono"
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            aria-label="Buscar conversación"
          />
        </div>
        <div className="filter-scroll bandeja-filtros" role="tablist">
          {FILTROS.map(f => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filtro === f.id}
              className={`chip-choice ${filtro === f.id ? 'active' : ''}`}
              onClick={() => setFiltro(f.id)}
            >
              {f.label}{conteos[f.id] != null ? ` · ${conteos[f.id]}` : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="bandeja-lista-scroll">
        {conversaciones.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><MessageCircle size={22} /></div>
            <p className="empty-state-title">{busqueda || filtro !== 'todas' ? 'Nada con ese filtro' : 'Todavía no hay chats'}</p>
            <p className="empty-state-desc">
              {busqueda || filtro !== 'todas'
                ? 'Probá con "Todas" o borrá la búsqueda.'
                : 'Cuando un cliente escriba al WhatsApp de Voltra, aparece acá al instante.'}
            </p>
          </div>
        ) : conversaciones.map(c => {
          const ult = ultimos[c.id]
          const esperando = c.estado === 'humano' && ult?.direccion === 'in'
          const nombre = nombreCliente(c)
          return (
            <button
              key={c.id}
              className={`bandeja-item ${activaId === c.id ? 'activo' : ''}`}
              onClick={() => onElegir(c.id)}
            >
              <div className="bandeja-avatar" style={{ background: colorAvatar(nombre) }}>{inicial(nombre)}</div>
              <div className="bandeja-item-body">
                <div className="bandeja-item-fila">
                  <span className="bandeja-item-nombre">{nombre}</span>
                  <span className="bandeja-item-hora">{horaCorta(ult?.creado_en || c.ultima_entrada_en)}</span>
                </div>
                <div className="bandeja-item-preview">{textoPreview(ult)}</div>
                <div className="bandeja-item-meta">
                  {c.estado === 'humano' && <span className="badge badge-yellow"><User size={10} /> Humano</span>}
                  {c.estado === 'ia' && <span className="badge badge-purple"><Bot size={10} /> IA</span>}
                  {c.estado === 'cerrada' && <span className="badge badge-gray">Cerrada</span>}
                  {!ventanaAbierta(c) && c.estado !== 'cerrada' && <span className="badge badge-gray">+24 h</span>}
                  {esperando && <span className="bandeja-punto" title="Espera tu respuesta" />}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
