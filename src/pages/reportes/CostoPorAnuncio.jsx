// src/pages/reportes/CostoPorAnuncio.jsx
// Tabla "Costo por anuncio": gasto de Meta por anuncio ÷ pedidos y entregados que trajo.
import { useEffect, useMemo, useState } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { cargarCostoPorAnuncio } from '../../lib/costoPorAnuncio'

const FILTROS = [
  { id: 'con', label: 'Con pedidos' },
  { id: 'todos', label: 'Todos' },
]
const ORDENES = {
  gasto: (a, b) => b.gasto - a.gasto,
  pedidos: (a, b) => b.pedidos - a.pedidos || b.gasto - a.gasto,
  costoEntregado: (a, b) => (a.costoEntregado ?? Infinity) - (b.costoEntregado ?? Infinity),
}

const gs = (n) => (n == null ? '—' : formatGs(n))

export default function CostoPorAnuncio({ inicio, fin }) {
  const [res, setRes] = useState(null)
  const [filtro, setFiltro] = useState('con')
  const [orden, setOrden] = useState('gasto')

  useEffect(() => {
    let vivo = true
    setRes(null)
    cargarCostoPorAnuncio(supabase, { inicio, fin }).then(r => { if (vivo) setRes(r) })
    return () => { vivo = false }
  }, [inicio, fin])

  const filas = useMemo(() => {
    if (!res) return []
    const base = filtro === 'con' ? res.filas.filter(f => f.pedidos > 0) : res.filas
    return [...base].sort(ORDENES[orden])
  }, [res, filtro, orden])

  if (!res) return <div className="card skeleton" style={{ height: 120 }} />
  if (!res.filas.length && !res.sinAnuncio) return null

  const t = res.total
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Costo por anuncio (Meta)</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Gasto real de cada anuncio ÷ los pedidos válidos y entregados que trajo (los cancelados no cuentan; los que cayeron sin respuesta van aparte). El gasto de hoy entra mañana a las 10:00.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FILTROS.map(f => (
            <button key={f.id} className={`chip-choice ${filtro === f.id ? 'active' : ''}`} onClick={() => setFiltro(f.id)}>
              {f.label}{f.id === 'con' ? ` · ${res.conPedidos}` : ` · ${res.filas.length}`}
            </button>
          ))}
          <select className="form-input" style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }} value={orden} onChange={e => setOrden(e.target.value)} aria-label="Ordenar">
            <option value="gasto">Más gasto</option>
            <option value="pedidos">Más pedidos</option>
            <option value="costoEntregado">Menor costo por entregado</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1, background: 'var(--border)' }}>
        {[
          ['Gasto en anuncios', gs(t.gasto)],
          ['Pedidos atribuidos', t.pedidos],
          ['Cayeron sin respuesta', res.sinRespuestaDisponible ? t.sinRespuesta : '—'],
          ['Entregados', t.entregados],
          ['Costo por pedido', gs(t.costoPedido)],
          ['Costo por entregado', gs(t.costoEntregado)],
        ].map(([k, v]) => (
          <div key={k} style={{ background: 'var(--bg-card)', padding: '10px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{k}</div>
            <div style={{ fontWeight: 700, fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
          </div>
        ))}
      </div>

      {filas.length ? (
        <table className="tabla-responsive">
          <thead>
            <tr>
              <th>Anuncio</th>
              <th>Canal</th>
              <th style={{ textAlign: 'right' }}>Gasto</th>
              <th style={{ textAlign: 'right' }}>Pedidos</th>
              <th style={{ textAlign: 'right' }} title="Cancelados solos por no confirmar. No cuentan en el costo por pedido.">Sin respuesta</th>
              <th style={{ textAlign: 'right' }}>Entregados</th>
              <th style={{ textAlign: 'right' }}>Costo / pedido</th>
              <th style={{ textAlign: 'right' }}>Costo / entregado</th>
            </tr>
          </thead>
          <tbody>
            {filas.map(f => (
              <tr key={f.anuncio}>
                <td data-label="Anuncio" style={{ fontWeight: 500, maxWidth: 340 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.anuncio}>{f.anuncio}</div>
                  {f.campana && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{f.campana}</div>}
                </td>
                <td data-label="Canal"><span className={`badge ${f.canal === 'WhatsApp' ? 'badge-green' : 'badge-blue'}`}>{f.canal}</span></td>
                <td data-label="Gasto" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{gs(f.gasto)}</td>
                <td data-label="Pedidos" style={{ textAlign: 'right' }}>{f.pedidos}</td>
                <td data-label="Sin respuesta" style={{ textAlign: 'right', color: f.sinRespuesta ? 'var(--yellow)' : 'var(--text-muted)' }}>
                  {res.sinRespuestaDisponible ? f.sinRespuesta : '—'}
                </td>
                <td data-label="Entregados" style={{ textAlign: 'right' }}>
                  {f.entregados}{f.tasaEntrega != null && f.pedidos > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> ({f.tasaEntrega}%)</span>}
                </td>
                <td data-label="Costo / pedido" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{gs(f.costoPedido)}</td>
                <td data-label="Costo / entregado" style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{gs(f.costoEntregado)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ padding: '14px 20px', fontSize: 12, color: 'var(--text-muted)' }}>
          {filtro === 'con' ? 'Todavía ningún anuncio con gasto cargado tiene pedidos en este período. Probá con "Todos".' : 'Sin gasto por anuncio en este período.'}
        </div>
      )}

      {res.sinAnuncio > 0 && (
        <div style={{ padding: '10px 20px', fontSize: 12, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
          {res.sinAnuncio} pedido(s) del período no traen de qué anuncio vinieron (orgánicos o sin etiqueta) y no se cuentan acá.
        </div>
      )}
    </div>
  )
}
