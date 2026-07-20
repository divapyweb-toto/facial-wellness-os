// src/pages/ads/AdsPage.jsx
import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { familiaProducto } from '../../lib/recompra'
import { calcularMetricasAds, textoVeredicto } from '../../lib/metricasAds'
import { Megaphone, Loader2, Save, Info } from 'lucide-react'

// Nombre visible de cada familia (orden en que se muestran)
const FAMILIAS = [
  ['nasal', 'Tiras Nasales'],
  ['parche', 'Parches Bucales'],
  ['gudair', 'Pack Gudair'],
  ['lengua', 'Raspador de Lengua'],
  ['jaw', 'JawFlex Pro'],
  ['botella', 'Botella Flexible'],
  ['bebird', 'Bebird Pro'],
]
const NOMBRE_FAMILIA = Object.fromEntries(FAMILIAS)

const normRef = (ref) => {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}
const categoriaPaP = (estado, motivo) => {
  const e = (estado || '').toLowerCase(), m = (motivo || '').toLowerCase()
  if (e.includes('entregado')) return 'entregado'
  if (e.includes('devuelto') || e.includes('devolucion') || m.includes('devolucion') ||
      m.includes('rechaz') || m.includes('inubicable') || m.includes('fuera de cobertura') ||
      m.includes('no desea') || m.includes('cancelad') || m.includes('rehus')) return 'devuelto'
  return 'en_proceso'
}

const VEREDICTO_CFG = {
  gana:      { color: 'var(--green)',  bg: 'var(--green-dim)',        label: '🟢 Rinde' },
  ajustar:   { color: 'var(--yellow)', bg: 'rgba(234,179,8,0.12)',    label: '🟡 Ajustar' },
  pierde:    { color: 'var(--red)',    bg: 'rgba(239,68,68,0.12)',    label: '🔴 Pierde' },
  sin_gasto: { color: 'var(--text-muted)', bg: 'transparent',         label: '—' },
}

export default function AdsPage() {
  const { toast } = useToast()
  const [mes, setMes] = useState(new Date().toISOString().substring(0, 7))
  const [modo, setModo] = useState('producto')       // 'producto' | 'total'
  const [gastos, setGastos] = useState({})            // familia → gasto (string)
  const [ventas, setVentas] = useState([])
  const [estadoPaP, setEstadoPaP] = useState({})
  const [loading, setLoading] = useState(true)
  const [guardando, setGuardando] = useState(false)

  // Cargar ventas del mes + estado real de PaP + gasto ya guardado
  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      const [y, m] = mes.split('-').map(Number)
      const inicio = `${mes}-01`
      const fin = new Date(y, m, 0).toISOString().slice(0, 10)
      const finBuf = new Date(y, m, 0); finBuf.setDate(finBuf.getDate() + 31)
      const finBufStr = finBuf.toISOString().slice(0, 10)

      const [vts, ents, camp] = await Promise.all([
        fetchAll(() => supabase.from('ventas')
          .select('n_referencia, total, estado, costo_prod, costo_envio, producto_nombre, fecha')
          .is('deleted_at', null).gte('fecha', inicio).lte('fecha', fin)),
        fetchAll(() => supabase.from('entregas')
          .select('n_referencia, nro_guia_ref, estado_pap, motivo, fecha_entrega')
          .gte('fecha_entrega', inicio).lte('fecha_entrega', finBufStr), { columnaOrden: 'nro_guia_pap' }),
        supabase.from('campanas_ads').select('*').eq('mes', mes),
      ])

      setVentas(vts || [])

      const est = {}
      for (const e of (ents || [])) {
        const k = normRef(e.n_referencia) || normRef(e.nro_guia_ref)
        if (k) est[k] = categoriaPaP(e.estado_pap, e.motivo)
      }
      setEstadoPaP(est)

      // Cargar gasto guardado (por familia o total)
      const gs = {}
      let modoGuardado = 'producto'
      for (const c of (camp.data || [])) {
        const fam = c.familia || 'total'
        gs[fam] = String(c.gasto || '')
        if (fam === 'total') modoGuardado = 'total'
      }
      setGastos(gs)
      if (Object.keys(gs).length) setModo(modoGuardado)
    } catch (e) {
      toast('Error cargando datos: ' + e.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [mes])

  useEffect(() => { cargar() }, [cargar])

  // Ventas agrupadas por familia
  const ventasPorFamilia = useMemo(() => {
    const map = {}
    for (const v of ventas) {
      const fam = familiaProducto(v.producto_nombre)
      if (!fam) continue
      if (!map[fam]) map[fam] = []
      map[fam].push(v)
    }
    return map
  }, [ventas])

  // Métricas por familia (modo producto) o del total (modo simple)
  const filas = useMemo(() => {
    if (modo === 'total') {
      const gastoTotal = Number(gastos.total) || 0
      return [{ familia: 'total', nombre: 'Todo el mes', ventas: ventas.filter(v => familiaProducto(v.producto_nombre)), m: calcularMetricasAds(gastoTotal, ventas.filter(v => familiaProducto(v.producto_nombre)), estadoPaP) }]
    }
    return FAMILIAS.map(([fam, nombre]) => {
      const vs = ventasPorFamilia[fam] || []
      return { familia: fam, nombre, ventas: vs, m: calcularMetricasAds(Number(gastos[fam]) || 0, vs, estadoPaP) }
    })
    // Mostramos todas las familias siempre, así siempre podés cargar el gasto
    // aunque ese producto todavía no tenga ventas registradas este mes.
  }, [modo, gastos, ventasPorFamilia, ventas, estadoPaP])

  // Totales del mes (para el resumen de arriba)
  const totalMes = useMemo(() => {
    const gastoTotal = modo === 'total'
      ? (Number(gastos.total) || 0)
      : FAMILIAS.reduce((s, [f]) => s + (Number(gastos[f]) || 0), 0)
    const todas = ventas.filter(v => familiaProducto(v.producto_nombre))
    return calcularMetricasAds(gastoTotal, todas, estadoPaP)
  }, [modo, gastos, ventas, estadoPaP])

  const setGasto = (fam, val) => setGastos(g => ({ ...g, [fam]: val.replace(/[^\d]/g, '') }))

  const guardar = async () => {
    setGuardando(true)
    try {
      // Reemplazar el gasto del mes: borrar lo anterior e insertar lo nuevo.
      // Solo columnas seguras: mes, familia, gasto.
      await supabase.from('campanas_ads').delete().eq('mes', mes)
      let filasIns = []
      if (modo === 'total') {
        const g = Number(gastos.total) || 0
        if (g > 0) filasIns.push({ mes, familia: 'total', gasto: g })
      } else {
        filasIns = FAMILIAS
          .filter(([f]) => (Number(gastos[f]) || 0) > 0)
          .map(([f]) => ({ mes, familia: f, gasto: Number(gastos[f]) }))
      }
      if (filasIns.length) {
        const { error } = await supabase.from('campanas_ads').insert(filasIns)
        if (error) throw error
      }
      toast('Gasto de ads guardado', 'success')
    } catch (e) {
      toast('Error al guardar: ' + e.message, 'error')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Meta Ads</h1>
          <p className="page-subtitle">Cargá el gasto y el sistema calcula CPA y ROAS reales con tus entregas</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="month" className="form-select" style={{ width: 'auto' }} value={mes}
            onChange={e => setMes(e.target.value)} />
          <button className="btn btn-primary" onClick={guardar} disabled={loading || guardando}>
            {guardando ? <Loader2 size={14} className="spinning" /> : <Save size={14} />} Guardar
          </button>
        </div>
      </div>

      {/* Toggle de modo */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div className="tabs">
          <button className={`tab ${modo === 'producto' ? 'active' : ''}`} onClick={() => setModo('producto')}>Por producto</button>
          <button className={`tab ${modo === 'total' ? 'active' : ''}`} onClick={() => setModo('total')}>Total del mes</button>
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {modo === 'producto' ? 'Cargá cuánto gastaste en cada producto' : 'Un solo número para todo el mes'}
        </span>
      </div>

      {loading ? (
        <div className="empty-state" style={{ padding: 60 }}><Loader2 size={28} className="spinning" /><p>Cargando ventas del mes…</p></div>
      ) : (
        <>
          {/* Resumen del mes */}
          {totalMes.gasto > 0 && (
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 14 }}>
                <ResumenKPI label="Gasto total" valor={formatGs(totalMes.gasto)} />
                <ResumenKPI label="CPA real" valor={formatGs(totalMes.cpaReal)} sub={`por entrega · Meta: ${formatGs(totalMes.cpaPedido)}`} />
                <ResumenKPI label="ROAS real" valor={`${totalMes.roasReal}x`} sub={`cobrado · bruto: ${totalMes.roasBruto}x`} color={totalMes.roasReal >= 2 ? 'var(--green)' : 'var(--yellow)'} />
                <ResumenKPI label="Ganancia neta" valor={formatGs(totalMes.gananciaNeta)} color={totalMes.gananciaNeta >= 0 ? 'var(--green)' : 'var(--red)'} />
                <ResumenKPI label="Entrega" valor={`${Math.round(totalMes.tasaEntrega * 100)}%`} sub={`${totalMes.entregados} de ${totalMes.entregados + totalMes.devueltos}`} />
              </div>
            </div>
          )}

          {/* Explicación del insight */}
          <div className="card" style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <Info size={15} color="var(--accent)" style={{ flexShrink: 0, marginTop: 1 }} />
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
              Meta cuenta pedidos <em>hechos</em>. El <strong>CPA real</strong> y el <strong>ROAS real</strong> se calculan sobre lo <strong>entregado y cobrado</strong> — el número que decide si la campaña gana plata de verdad.
            </p>
          </div>

          {/* Lista de productos con gasto + métricas */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {modo === 'total' && (
              <div className="card" style={{ padding: '14px 18px' }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Gasto total del mes en Meta</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Gs.</span>
                  <input className="form-input" type="text" inputMode="numeric" placeholder="2000000"
                    value={gastos.total ? Number(gastos.total).toLocaleString('es-PY') : ''}
                    onChange={e => setGasto('total', e.target.value)} style={{ maxWidth: 200, fontSize: 16, fontWeight: 700 }} />
                </div>
              </div>
            )}

            {filas.map(({ familia, nombre, ventas: vs, m }) => {
              const cfg = VEREDICTO_CFG[m.veredicto] || VEREDICTO_CFG.sin_gasto
              return (
                <div key={familia} className="card" style={{ padding: '14px 18px', borderLeft: `3px solid ${cfg.color}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: 15 }}>{nombre}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                        {m.despachados} pedidos · {m.entregados} entregados · {Math.round(m.tasaEntrega * 100)}% entrega
                      </div>
                    </div>
                    {modo === 'producto' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Gasté Gs.</span>
                        <input className="form-input" type="text" inputMode="numeric" placeholder="0"
                          value={gastos[familia] ? Number(gastos[familia]).toLocaleString('es-PY') : ''}
                          onChange={e => setGasto(familia, e.target.value)}
                          style={{ maxWidth: 130, fontWeight: 700 }} />
                      </div>
                    )}
                  </div>

                  {m.gasto > 0 && (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 10, marginTop: 12 }}>
                        <MetricaMini label="CPA real" valor={formatGs(m.cpaReal)} />
                        <MetricaMini label="ROAS real" valor={`${m.roasReal}x`} color={m.roasReal >= 2 ? 'var(--green)' : 'var(--yellow)'} />
                        <MetricaMini label="Cobrado" valor={formatGs(m.cobrado)} />
                        <MetricaMini label="Ganancia neta" valor={formatGs(m.gananciaNeta)} color={m.gananciaNeta >= 0 ? 'var(--green)' : 'var(--red)'} />
                      </div>
                      <p style={{ fontSize: 12.5, color: cfg.color, marginTop: 10, marginBottom: 0, fontWeight: 500 }}>
                        {textoVeredicto(m, nombre)}
                      </p>
                    </>
                  )}
                </div>
              )
            })}

            {filas.length === 0 && (
              <div className="empty-state" style={{ padding: 40 }}>
                <div className="empty-state-icon"><Megaphone size={26} /></div>
                <p style={{ fontWeight: 600 }}>Sin ventas ni gasto este mes</p>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Elegí un mes con ventas o cargá el gasto de un producto.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ResumenKPI({ label, valor, sub, color }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'var(--font-display)', color: color || 'var(--text-primary)', marginTop: 2 }}>{valor}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function MetricaMini({ label, valor, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color || 'var(--text-primary)', marginTop: 1 }}>{valor}</div>
    </div>
  )
}
