// src/pages/productos/ui.jsx
// Piezas chicas reutilizadas por las pantallas de Productos nuevos.
// Usan las primitivas de src/index.css (DESIGN.md): form-group, badge, empty-state, alert.
import { AlertCircle, Inbox } from 'lucide-react'
import { MONEDAS, tipoEvidenciaInfo, estadoInfo } from './formato'

export function Campo({ label, hint, children, span }) {
  return (
    <div className="form-group" style={span ? { gridColumn: `span ${span}` } : undefined}>
      {label && <label className="form-label">{label}</label>}
      {children}
      {hint && <span className="form-hint">{hint}</span>}
    </div>
  )
}

export const Demo = ({ si = true }) => si ? <span className="badge badge-yellow" title="Dato de demostración: inventado">DEMO</span> : null

export function BadgeEstado({ estado }) {
  const e = estadoInfo(estado)
  return <span className={`badge ${e.badge}`}>{e.label}</span>
}

export function BadgeTipo({ tipo }) {
  const t = tipoEvidenciaInfo(tipo)
  return <span className={`badge ${t.badge}`} title={t.ayuda}>{t.label}</span>
}

export function Vacio({ titulo, desc, icono: Icono = Inbox, children }) {
  return (
    <div className="empty-state" style={{ padding: 32 }}>
      <div className="empty-state-icon"><Icono size={22} /></div>
      <p className="empty-state-title">{titulo}</p>
      {desc && <p className="empty-state-desc" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{desc}</p>}
      {children}
    </div>
  )
}

export function ErrorCaja({ error, onReintentar }) {
  if (!error) return null
  return (
    <div className="alert alert-error">
      <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1 }}>
        <div>{error.message || String(error)}</div>
        {onReintentar && <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={onReintentar}>Reintentar</button>}
      </div>
    </div>
  )
}

export function SelectMoneda({ value, onChange, disabled }) {
  return (
    <select className="form-select" value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      {MONEDAS.map(m => <option key={m} value={m}>{m}</option>)}
    </select>
  )
}

// Fila etiqueta + valor (primitiva .data-row)
export function Dato({ label, children, title }) {
  return (
    <div className="data-col" title={title}>
      <span className="data-label">{label}</span>
      <span className="data-value">{children}</span>
    </div>
  )
}

// Modal simple con las clases del sistema.
export function Modal({ titulo, onCerrar, children, pie, ancho = 'modal-lg' }) {
  return (
    <div className="modal-overlay" onClick={onCerrar}>
      <div className={`modal ${ancho}`} onClick={e => e.stopPropagation()} role="dialog" aria-label={titulo}>
        <div className="modal-header">
          <h2 className="modal-title">{titulo}</h2>
          <button className="modal-close" onClick={onCerrar} aria-label="Cerrar">✕</button>
        </div>
        {children}
        {pie && <div className="modal-footer">{pie}</div>}
      </div>
    </div>
  )
}
