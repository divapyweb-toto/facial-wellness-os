// Tarjetas de la semana elegida, con la variación contra la anterior.
import { KPIS, variacion } from './kpi'

export default function TarjetasKpi({ fila, anterior }) {
  return (
    <div className="kpi-grid kpi-wa-grid">
      {KPIS.map((k) => {
        const v = variacion(k, fila, anterior)
        return (
          <div className="kpi-card" key={k.clave}>
            <span className="kpi-label">{k.etiqueta}</span>
            {/* 12-10: `valor`/`color` opcionales (entrega realista, costo 'parcial'). */}
            <span className="kpi-value" style={k.color?.(fila ?? {}) ? { color: k.color(fila ?? {}) } : undefined}>
              {k.valor ? k.valor(fila ?? {}) : k.fmt(fila?.[k.clave])}
            </span>
            <span className="kpi-sub">{k.sub(fila ?? {})}</span>
            {v && <span className={`kpi-sub kpi-wa-var ${v.tono ?? ''}`}>{v.texto}</span>}
          </div>
        )
      })}
    </div>
  )
}
