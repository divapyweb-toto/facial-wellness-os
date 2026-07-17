// src/pages/reportes/ComparadorMeses.jsx
// ═══════════════════════════════════════════════════════════
// COMPARADOR DE MESES
// Dos meses libres, recorte automático hasta la fecha, y dos vistas:
// Actividad (lo que ocurrió) y Resultado (solo ventas maduras).
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useMemo } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import {
  normRef, calcularMaduracion, calcularCorte, categorizarPaP,
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

export default function ComparadorMeses() {
  const [mesA, setMesA] = useState('')
  const [mesB, setMesB] = useState('')
  const [tab, setTab] = useState('actividad')
  const [ventas, setVentas] = useState([])
  const [entRef, setEntRef] = useState({})
  const [estadoPaP, setEstadoPaP] = useState({})   // ref → categoría real de PaP
  const [gastosPorMes, setGastosPorMes] = useState({})
  const [mesesDisponibles, setMesesDisponibles] = useState([])
  const [loading, setLoading] = useState(true)

  // ── Paso 1: lista de meses disponibles (consulta LIVIANA) ──
  // En vez de bajar todas las ventas para saber qué meses hay, solo pedimos la
  // fecha más vieja y la más nueva, y generamos los meses entre ambas.
  useEffect(() => {
    let activo = true
    ;(async () => {
      try {
        const [min, max] = await Promise.all([
          supabase.from('ventas').select('fecha').is('deleted_at', null).order('fecha', { ascending: true }).limit(1),
          supabase.from('ventas').select('fecha').is('deleted_at', null).order('fecha', { ascending: false }).limit(1),
        ])
        const fMin = min.data?.[0]?.fecha, fMax = max.data?.[0]?.fecha
        if (!fMin || !fMax) { if (activo) { setMesesDisponibles([]); setLoading(false) }; return }
        const meses = []
        let [y, m] = fMin.slice(0, 7).split('-').map(Number)
        const [yF, mF] = fMax.slice(0, 7).split('-').map(Number)
        while (y < yF || (y === yF && m <= mF)) {
          meses.push(`${y}-${String(m).padStart(2, '0')}`)
          m++; if (m > 12) { m = 1; y++ }
        }
        if (activo) setMesesDisponibles(meses.reverse())  // más nuevo primero
      } catch (e) { if (activo) setMesesDisponibles([]) }
    })()
    return () => { activo = false }
  }, [])

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

  // ── Paso 2: cargar datos SOLO de los meses elegidos (reactivo) ──
  // Cada vez que cambian mesA o mesB, bajamos únicamente esos meses. Así el
  // comparador no arrastra toda la historia y responde rápido.
  useEffect(() => {
    if (!mesA && !mesB) return
    let activo = true
    setLoading(true)
    ;(async () => {
      try {
        // Rango de fechas de un mes YYYY-MM → [primer día, último día]
        const rango = (mes) => {
          const [y, m] = mes.split('-').map(Number)
          const ini = `${mes}-01`
          const fin = new Date(y, m, 0)
          const finBuf = new Date(y, m, 0); finBuf.setDate(finBuf.getDate() + 31) // margen para entregas posteriores
          const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          return { ini, fin: iso(fin), finBuf: iso(finBuf) }
        }
        const meses = [...new Set([mesA, mesB].filter(Boolean))]

        // Ventas y gastos de esos meses; entregas con margen para las que se
        // entregaron después del mes de la venta.
        const cargasVentas = meses.map(mes => {
          const r = rango(mes)
          return fetchAll(() => supabase.from('ventas')
            .select('n_referencia, fecha, total, estado, costo_prod, costo_envio, producto_nombre')
            .is('deleted_at', null).gte('fecha', r.ini).lte('fecha', r.fin))
        })
        const cargasEnt = meses.map(mes => {
          const r = rango(mes)
          return fetchAll(() => supabase.from('entregas')
            .select('n_referencia, nro_guia_ref, fecha_entrega, estado_pap, motivo')
            .gte('fecha_entrega', r.ini).lte('fecha_entrega', r.finBuf), { columnaOrden: 'nro_guia_pap' })
        })
        const cargasGastos = meses.map(mes => {
          const r = rango(mes)
          return fetchAll(() => supabase.from('gastos').select('fecha, monto').gte('fecha', r.ini).lte('fecha', r.fin))
        })

        const [vtsArr, entArr, gastosArr] = await Promise.all([
          Promise.all(cargasVentas), Promise.all(cargasEnt), Promise.all(cargasGastos),
        ])
        if (!activo) return

        const vts = vtsArr.flat()
        const ents = entArr.flat()
        const gastos = gastosArr.flat()

        setVentas(vts)

        const ref = {}, est = {}
        for (const e of ents) {
          const k = normRef(e.n_referencia) || normRef(e.nro_guia_ref)
          if (!k) continue
          if (e.fecha_entrega && (!ref[k] || e.fecha_entrega > ref[k])) ref[k] = e.fecha_entrega
          est[k] = categorizarPaP(e.estado_pap, e.motivo)
        }
        setEntRef(ref)
        setEstadoPaP(est)

        const gm = {}
        for (const g of gastos) {
          const mes = String(g.fecha || '').slice(0, 7)
          if (mes) gm[mes] = (gm[mes] || 0) + (g.monto || 0)
        }
        setGastosPorMes(gm)
      } finally {
        if (activo) setLoading(false)
      }
    })()
    return () => { activo = false }
  }, [mesA, mesB])

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

  const resA = useMemo(() => metricasResultado(ventas, mesA, corteInfo.diaCorte, maduracion.dias, refCosto, COGS_PROMEDIO, new Date(), estadoPaP), [ventas, mesA, corteInfo, maduracion, refCosto, estadoPaP])
  const resB = useMemo(() => metricasResultado(ventas, mesB, corteInfo.diaCorte, maduracion.dias, refCosto, COGS_PROMEDIO, new Date(), estadoPaP), [ventas, mesB, corteInfo, maduracion, refCosto, estadoPaP])

  const puente = useMemo(() => puenteVariacion(resA, resB, gastosPorMes[mesA] || 0, gastosPorMes[mesB] || 0), [resA, resB, gastosPorMes, mesA, mesB])

  // Cobertura de datos de PaP: de las ventas maduras de cada mes, cuántas ya
  // tienen estado real de PaP cargado. Si es baja, el resultado es menos preciso.
  const coberturaPaP = useMemo(() => {
    const contar = (mes) => {
      if (!mes) return { total: 0, conPaP: 0 }
      const vs = ventas.filter(v => String(v.fecha || '').slice(0, 7) === mes)
      const conPaP = vs.filter(v => estadoPaP[normRef(v.n_referencia)]).length
      return { total: vs.length, conPaP }
    }
    const a = contar(mesA), b = contar(mesB)
    const total = a.total + b.total, conPaP = a.conPaP + b.conPaP
    return { total, conPaP, pct: total ? Math.round(conPaP / total * 100) : 100 }
  }, [ventas, estadoPaP, mesA, mesB])

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
            {coberturaPaP.total > 0 && coberturaPaP.pct < 80 && (
              <p style={{ fontSize: 10.5, color: 'var(--yellow)', margin: '6px 0 0' }}>
                <Info size={11} style={{ verticalAlign: -1 }} /> Solo el {coberturaPaP.pct}% de estas ventas tiene datos de PaP cargados ({coberturaPaP.conPaP} de {coberturaPaP.total}). Para el resto uso el estado guardado. Cruzá el reporte de PaP en Entregas para más precisión.
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
