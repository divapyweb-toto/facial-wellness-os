// Historial: una fila por semana. En el celular se vuelve tarjetas (.tabla-responsive + data-label).
import { fmtMin, fmtNum, fmtPct, fmtPorEntregado, rangoSemana } from './kpi'
import { textoEsperada } from '../../lib/tasaEntrega'

// 12-10: con la semana sin resolver (< 80 % de los confirmados con resultado),
// los % sobre resueltos y el costo por entregado engañan → "parcial".
const pctSiResuelta = (k) => (f) => (f.semana_resuelta || fmtPct(f[k]) === '—' ? fmtPct(f[k]) : 'parcial')

const COLS = [
  { k: 'pedidos', t: 'Pedidos', f: fmtNum },
  { k: 'pct_confirmados', t: 'Confirm.', f: fmtPct },
  { k: 'sin_respuesta', t: 'Sin resp.', f: fmtNum },
  { k: 'pct_entrega_esperada', t: 'Entrega', v: (f) => (f.tasa_entrega ? textoEsperada(f.tasa_entrega) : '—') },
  { k: 'en_camino', t: 'En camino', f: fmtNum },
  { k: 'pct_entrega_confirmados', t: 'Entrega conf.', v: pctSiResuelta('pct_entrega_confirmados') },
  { k: 'pct_entrega_no_confirmados', t: 'Entrega no conf.', v: pctSiResuelta('pct_entrega_no_confirmados') },
  { k: 'minutos_mediana_confirmar', t: 'A confirmar', f: fmtMin },
  { k: 'costo_mensajes_por_entregado_usd', t: 'Msj / entreg.', v: (f) => fmtPorEntregado(f, 'costo_mensajes_por_entregado_usd') },
  { k: 'costo_ia_por_entregado_usd', t: 'IA / entreg.', v: (f) => fmtPorEntregado(f, 'costo_ia_por_entregado_usd') },
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
                <td key={c.k} data-label={c.t} className="num num-col">{c.v ? c.v(f) : c.f(f[c.k])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
