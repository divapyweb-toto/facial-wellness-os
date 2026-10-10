// Historial: una fila por semana. En el celular se vuelve tarjetas (.tabla-responsive + data-label).
import { fmtMin, fmtNum, fmtPct, fmtUsd, rangoSemana } from './kpi'

const COLS = [
  { k: 'pedidos', t: 'Pedidos', f: fmtNum },
  { k: 'pct_confirmados', t: 'Confirm.', f: fmtPct },
  { k: 'sin_respuesta', t: 'Sin resp.', f: fmtNum },
  { k: 'pct_entregados', t: 'Entrega', f: fmtPct },
  { k: 'pct_entrega_confirmados', t: 'Entrega conf.', f: fmtPct },
  { k: 'pct_entrega_no_confirmados', t: 'Entrega no conf.', f: fmtPct },
  { k: 'minutos_mediana_confirmar', t: 'A confirmar', f: fmtMin },
  { k: 'costo_mensajes_por_entregado_usd', t: 'Msj / entreg.', f: fmtUsd },
  { k: 'costo_ia_por_entregado_usd', t: 'IA / entreg.', f: fmtUsd },
  { k: 'pct_derivado', t: 'Derivado', f: fmtPct },
  { k: 'recompras', t: 'Recompras', f: fmtNum },
  { k: 'reclamos', t: 'Reclamos', f: fmtNum },
]

export default function TablaSemanas({ filas, elegida, onElegir, semanaActual }) {
  return (
    <div className="table-wrapper">
      <table className="tabla-responsive kpi-wa-tabla">
        <thead>
          <tr>
            <th>Semana</th>
            {COLS.map((c) => <th key={c.k} className="num-col">{c.t}</th>)}
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr
              key={f.semana}
              className={f.semana === elegida ? 'kpi-wa-fila-activa' : ''}
              onClick={() => onElegir(f.semana)}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onElegir(f.semana) } }}
              aria-selected={f.semana === elegida}
            >
              <td data-label="Semana">
                {rangoSemana(f.semana)}
                {f.semana === semanaActual && <span className="kpi-wa-en-curso">en curso</span>}
              </td>
              {COLS.map((c) => (
                <td key={c.k} data-label={c.t} className="num num-col">{c.f(f[c.k])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
