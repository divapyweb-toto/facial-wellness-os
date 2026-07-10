// src/lib/ModalErrorBoundary.jsx
// ═══════════════════════════════════════════════════════════
// Envuelve un modal para que, si algo falla al montarlo, se vea el error
// en pantalla en vez de quedar la pantalla oscurecida sin nada (que es
// lo que pasa cuando un componente tira una excepción al renderizar:
// React desmonta el árbol y solo queda el overlay).
// ═══════════════════════════════════════════════════════════
import { Component } from 'react'

export default class ModalErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Deja rastro en la consola para diagnóstico
    console.error('Error al montar el modal:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && this.props.onClose?.()}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <h2 className="modal-title" style={{ color: 'var(--red)' }}>No se pudo abrir</h2>
              <button className="modal-close" onClick={() => this.props.onClose?.()}>✕</button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              Ocurrió un error al abrir esta ventana. El detalle quedó en la consola del navegador (Cmd+Option+I → Console).
            </p>
            <pre style={{
              fontSize: 11, background: 'var(--bg-hover)', padding: 12, borderRadius: 8,
              overflowX: 'auto', color: 'var(--red)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {String(this.state.error?.message || this.state.error)}
            </pre>
            <div className="modal-footer" style={{ padding: 0, border: 'none' }}>
              <button className="btn btn-primary" onClick={() => this.props.onClose?.()}>Cerrar</button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
