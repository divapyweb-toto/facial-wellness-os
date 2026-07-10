// src/pages/reportes/ComparadorMeses.jsx
// ═══════════════════════════════════════════════════════════
// COMPARADOR DE MESES
// Dos meses libres, recorte automático hasta la fecha, y dos vistas:
// Actividad (lo que ocurrió) y Resultado (solo ventas maduras).
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import {
  normRef, calcularMaduracion, calcularCorte,
  metricasActividad, metricasResultado, puenteVariacion, etiquetaMes,
} from '../../lib/comparador'
import { TrendingUp, TrendingDown, Minus, Calendar, Info } from 'lucide-react'

const COGS_PROMEDIO = 12000

// Delta con flecha y color. invertido=true → menos es mejor (ej: devoluciones)
function Delta({ a, b, fmt = (x) => x, invertido = false, pct = false }) {
  const dif = b - a
  if (dif === 0) return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}><Minus size={11} style={{ verticalAlign: -1 }} /> igual</span>
  const bueno = invertido ? dif < 0 : dif > 0
  const color = bueno ? 'var(--green)' : 'var(--red)'
  const Icon = dif > 0 ? TrendingUp : TrendingDown
  const valor = pct ? `${dif > 0 ? '+' : ''}${dif}pts` : `${dif > 0 ? '+' : ''}${fmt(dif)}`
  return (
    <span style={{ color, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      <Icon size={11} style={{ verticalAlign: -1 }} /> {valor}
    </span>
  )
}

// Fila comparativa: etiqueta | valor A | valor B | delta
function Fila({ label, sub, a, b, fmt = (x) => x, invertido = false, pct = false, destacado = false }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 0.9fr', gap: 8, alignItems: 'center',
      padding: destacado ? '12px 12px' : '9px 12px',
      background: destacado ? 'var(--bg-hover)' : 'transparent',
      borderRadius: destacado ? 8 : 0,
      borderTop: destacado ? '1px solid var(--border)' : '1px solid var(--border-subtle)',
    }}>
      <div>
        <div style={{ fontSize: destacado ? 13.5 : 12.5, fontWeight: destacado ? 700 : 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{sub}</div>}
      </div>
      <div style={{ fontSize: destacado ? 15 : 13, fontWeight: destacado ? 700 : 600, fontFamily: 'var(--font-display)', textAlign: 'right' }}>{fmt(a)}{pct ? '%' : ''}</div>
      <div style={{ fontSize: destacado ? 15 : 13, fontWeight: destacado ? 700 : 600, fontFamily: 'var(--font-display)', textAlign: 'right' }}>{fmt(b)}{pct ? '%' : ''}</div>
      <div style={{ textAlign: 'right' }}><Delta a={a} b={b} fmt={fmt} invertido={invertido} pct={pct} /></div>
    </div>
  )
}

export default function ComparadorMeses({ mesesDisponibles = [], gastosPorMes = {} }) {
  const [mesA, setMesA] = useState('')
  const [mesB, setMesB] = useState('')
  const [tab, setTab] = useState('actividad')
  const [ventas, setVentas] = useState([])
  const [entRef, setEntRef] = useState({})
  const [loading, setLoading] = useState(true)

  // Elegir por defecto los dos meses más recientes
  useEffect(() => {
    if (mesesDisponibles.length >= 2 && !mesA && !mesB) {
      setMesB(mesesDisponibles[0])
      setMesA(mesesDisponibles[1])
    } else if (mesesDisponibles.length === 1 && !mesB) {
      setMesB(mesesDisponibles[0])
      setMesA(mesesDisponibles[0])
    }
  }, [mesesDisponibles, mesA, mesB])

  // Cargar ventas + fechas de entrega (una vez)
  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      const [vts, ents] = await Promise.all([
        fetchAll(() => supabase.from('ventas')
          .select('n_referencia, fecha, total, estado, costo_prod, producto_nombre')
          .is('deleted_at', null)),
        fetchAll(() => supabase.from('entregas').select('n_referencia, fecha_entrega'), { columnaOrden: 'nro_guia_pap' }),
      ])
      setVentas(vts || [])
      // fecha de entrega por referencia (la más reciente si hay varias)
      const ref = {}
      for (const e of (ents || [])) {
        const k = normRef(e.n_referencia)
        if (k && e.fecha_entrega) {
          if (!ref[k] || e.fecha_entrega > ref[k]) ref[k] = e.fecha_entrega
        }
      }
      setEntRef(ref)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { cargar() }, [cargar])

  // Índice de costo real por referencia
  const refCosto = useMemo(() => {
    const m = {}
    for (const v of ventas) {
      const k = normRef(v.n_referencia)
      if (k && v.costo_prod != null) m[k] = v.costo_prod
    }
    return m
  }, [ventas])

  const maduracion = useMemo(() => calcularMaduracion(ventas, entRef, 0.9), [ventas, entRef])
  const corteInfo = useMemo(() => calcularCorte(mesA, mesB), [mesA, mesB])

  const actA = useMemo(() => metricasActividad(ventas, mesA, corteInfo.diaCorte, gastosPorMes[mesA] || 0), [ventas, mesA, corteInfo, gastosPorMes])
  const actB = useMemo(() => metricasActividad(ventas, mesB, corteInfo.diaCorte, gastosPorMes[mesB] || 0), [ventas, mesB, corteInfo, gastosPorMes])

  const resA = useMemo(() => metricasResultado(ventas, mesA, corteInfo.diaCorte, maduracion.dias, refCosto, COGS_PROMEDIO), [ventas, mesA, corteInfo, maduracion, refCosto])
  const resB = useMemo(() => metricasResultado(ventas, mesB, corteInfo.diaCorte, maduracion.dias, refCosto, COGS_PROMEDIO), [ventas, mesB, corteInfo, maduracion, refCosto])

  const puente = useMemo(() => puenteVariacion(resA, resB, gastosPorMes[mesA] || 0, gastosPorMes[mesB] || 0), [resA, resB, gastosPorMes, mesA, mesB])

  if (loading) return <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Cargando datos…</div>
  if (mesesDisponibles.length < 2) return <div className="card" style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>Necesitás al menos dos meses con datos para comparar.</div>

  const selector = (valor, setter, label) => (
    <div style={{ flex: 1 }}>
      <label style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</label>
      <select className="form-input" value={valor} onChange={e => setter(e.target.value)} style={{ marginTop: 4 }}>
        {mesesDisponibles.map(m => <option key={m} value={m}>{etiquetaMes(m)}</option>)}
      </select>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Selectores */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {selector(mesA, setMesA, 'Comparar')}
          <div style={{ fontSize: 18, color: 'var(--text-muted)', paddingBottom: 8 }}>vs</div>
          {selector(mesB, setMesB, 'Contra')}
        </div>
        {corteInfo.esActual && (
          <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-hover)', border: '1px solid var(--accent)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={14} color="var(--accent)" />
            <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              Uno de los meses está en curso, así que ambos se comparan <strong>hasta el día {corteInfo.diaCorte}</strong>. Comparar un mes completo contra uno a medias no tendría sentido.
            </span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button className={`tab ${tab === 'actividad' ? 'active' : ''}`} onClick={() => setTab('actividad')}>Actividad</button>
        <button className={`tab ${tab === 'resultado' ? 'active' : ''}`} onClick={() => setTab('resultado')}>Resultado</button>
      </div>

      {tab === 'actividad' && (
        <div className="card" style={{ padding: '16px 20px' }}>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
            Lo que <strong>ya ocurrió</strong>: pedidos que entraron y plata facturada. No depende de si la venta cerró.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 0.9fr', gap: 8, padding: '0 12px 8px', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            <div></div>
            <div style={{ textAlign: 'right' }}>{etiquetaMes(mesA)}</div>
            <div style={{ textAlign: 'right' }}>{etiquetaMes(mesB)}</div>
            <div style={{ textAlign: 'right' }}>Cambio</div>
          </div>
          <Fila label="Pedidos" sub="cuántas ventas entraron" a={actA.pedidos} b={actB.pedidos} destacado />
          <Fila label="Ventas brutas" sub="plata facturada" a={actA.ventasBrutas} b={actB.ventasBrutas} fmt={formatGs} />
          <Fila label="Ticket promedio" a={actA.ticketPromedio} b={actB.ticketPromedio} fmt={formatGs} />
          <Fila label="Gasto en ads" a={actA.gastoAds} b={actB.gastoAds} fmt={formatGs} invertido />
          <Fila label="Costo por pedido" sub="ads ÷ pedidos" a={actA.cpa} b={actB.cpa} fmt={formatGs} invertido />
        </div>
      )}

      {tab === 'resultado' && (
        <>
          <div className="card" style={{ padding: '16px 20px' }}>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 0, marginBottom: 4 }}>
              Solo ventas <strong>maduras</strong> (con {maduracion.dias}+ días, ya tuvieron tiempo de cerrar). Así se comparan ventas cerradas contra cerradas, no contra las que todavía están volando.
            </p>
            {!maduracion.confiable && (
              <p style={{ fontSize: 10.5, color: 'var(--yellow)', margin: '6px 0 0' }}>
                <Info size={11} style={{ verticalAlign: -1 }} /> Pocos datos de entrega aún: uso 15 días por defecto. Se afina solo con más historial.
              </p>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 0.9fr', gap: 8, padding: '12px 12px 8px', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              <div></div>
              <div style={{ textAlign: 'right' }}>{etiquetaMes(mesA)}</div>
              <div style={{ textAlign: 'right' }}>{etiquetaMes(mesB)}</div>
              <div style={{ textAlign: 'right' }}>Cambio</div>
            </div>
            <Fila label="Contribución" sub="lo que dejó la operación" a={resA.contribucion} b={resB.contribucion} fmt={formatGs} destacado />
            <Fila label="Por envío" sub="lo que deja cada paquete" a={resA.contribPorEnvio} b={resB.contribPorEnvio} fmt={formatGs} />
            <Fila label="Tasa de entrega" a={resA.tasaEntrega} b={resB.tasaEntrega} pct invertido={false} />
            <Fila label="Tasa de devolución" a={resA.tasaDevolucion} b={resB.tasaDevolucion} pct invertido />
            <Fila label="Paquetes cerrados" sub="entregados + devueltos" a={resA.resueltos} b={resB.resueltos} />
          </div>

          {/* Puente de variación */}
          <div className="card" style={{ padding: '16px 20px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>¿Por qué cambió la contribución?</div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0, marginBottom: 14 }}>
              El cambio de {formatGs(puente.cambioTotal)} se descompone en tres causas. La suma es exacta.
            </p>
            {[
              { label: 'Por volumen', sub: `vendiste ${resB.resueltos - resA.resueltos >= 0 ? 'más' : 'menos'} envíos`, val: puente.efVolumen },
              { label: 'Por eficiencia', sub: 'cada envío rinde distinto', val: puente.efEficiencia },
              { label: 'Por gastos', sub: 'cambió el gasto en ads', val: puente.efGastos },
            ].map((e, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--border-subtle)' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{e.label}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{e.sub}</div>
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-display)', color: e.val >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {e.val >= 0 ? '+' : ''}{formatGs(e.val)}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0 0', marginTop: 4, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>Cambio total</div>
              <div style={{ fontSize: 17, fontWeight: 800, fontFamily: 'var(--font-display)', color: puente.cambioTotal >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {puente.cambioTotal >= 0 ? '+' : ''}{formatGs(puente.cambioTotal)}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
