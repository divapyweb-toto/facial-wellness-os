// src/pages/productos/ProductosPage.jsx
// Módulo "Productos nuevos": candidato → ficha → evidencia → competencia →
// cotizaciones → rentabilidad → decisión → prueba → dossier (especificación §10,
// contrato en reportes/productos/CONTRATO-MODULO.md, fuera del repo).
// Nada de esta pantalla contacta proveedores, compra, paga ni publica anuncios.
import { useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Lightbulb, Activity, FlaskConical } from 'lucide-react'
import { esModoDemo, setModoDemo } from './api'
import Oportunidades from './Oportunidades'
import Detalle from './Detalle'
import Actividad from './Actividad'
import './productos.css'

export default function ProductosPage() {
  const [params, setParams] = useSearchParams()
  const [demo, setDemo] = useState(esModoDemo())
  const [version, setVersion] = useState(0) // fuerza recarga al cambiar de modo
  const candidatoId = params.get('c')
  const vista = params.get('v') || 'oportunidades'

  const ir = useCallback((cambios) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(cambios)) {
      if (v === null || v === undefined) p.delete(k); else p.set(k, v)
    }
    setParams(p)
  }, [params, setParams])

  const alternarDemo = () => {
    const nuevo = !demo
    setModoDemo(nuevo)
    setDemo(nuevo)
    setVersion(v => v + 1)
    ir({ c: null })
  }

  return (
    <div className="pi-page" key={version}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Productos nuevos</h1>
          <p className="page-subtitle">Investigar, comparar proveedores, calcular la plata y decidir con evidencia. Desde acá no se compra ni se paga; a proveedores se les escribe solo dentro de un permiso para negociar autorizado.</p>
        </div>
        <div className="page-actions">
          <button className={`btn btn-sm ${demo ? 'btn-primary' : 'btn-ghost'}`} onClick={alternarDemo} title="Datos inventados en memoria; no se guarda nada en la base">
            <FlaskConical size={13} /> {demo ? 'Salir de DEMO' : 'Ver con datos DEMO'}
          </button>
        </div>
      </div>

      {demo && (
        <div className="alert alert-warning">
          <FlaskConical size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span><b>Modo DEMO:</b> todo lo que ves es inventado y vive solo en esta pestaña. Nada se guarda en la base. Tocá el botón de arriba para volver a los datos reales.</span>
        </div>
      )}

      {candidatoId ? (
        <Detalle candidatoId={candidatoId} onVolver={() => ir({ c: null, t: null })} tab={params.get('t') || 'producto'} onTab={(t) => ir({ t })} />
      ) : (
        <>
          <div className="tabs filter-scroll">
            <button className={`tab ${vista === 'oportunidades' ? 'active' : ''}`} onClick={() => ir({ v: null })}>
              <Lightbulb size={13} /> Oportunidades
            </button>
            <button className={`tab ${vista === 'actividad' ? 'active' : ''}`} onClick={() => ir({ v: 'actividad' })}>
              <Activity size={13} /> Actividad
            </button>
          </div>
          {vista === 'actividad'
            ? <Actividad onAbrir={(id) => ir({ c: id, t: 'producto' })} onActivarDemo={!demo ? alternarDemo : null} />
            : <Oportunidades onAbrir={(id) => ir({ c: id, t: 'producto' })} onActivarDemo={!demo ? alternarDemo : null} />}
        </>
      )}
    </div>
  )
}
