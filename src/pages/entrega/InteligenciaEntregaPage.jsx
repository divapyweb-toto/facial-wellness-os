// src/pages/entrega/InteligenciaEntregaPage.jsx
import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { getFlete } from '../../lib/config'
import { analizarEntregas, categorizarEntrega, tasaPorMes, TASA_CRITICA, TASA_VIGILAR } from '../../lib/inteligenciaEntrega'
import { Loader2, TrendingUp, AlertTriangle, MapPin, Package, User, RotateCcw, Truck } from 'lucide-react'

const SUG_CFG = {
  critico: { color: 'var(--red)',    bg: 'rgba(239,68,68,0.12)' },
  vigilar: { color: 'var(--yellow)', bg: 'rgba(234,179,8,0.12)' },
  ok:      { color: 'var(--green)',  bg: 'var(--green-dim)' },
  pocos:   { color: 'var(--text-muted)', bg: 'transparent' },
}

function barra(tasa) {
  const pct = Math.round(tasa * 100)
  const color = tasa < TASA_CRITICA ? 'var(--red)' : tasa < TASA_VIGILAR ? 'var(--yellow)' : 'var(--green)'
  return { pct, color }
}

export default function InteligenciaEntregaPage() {
  const [entregas, setEntregas] = useState([])
  const [loading, setLoading] = useState(true)
  const [meses, setMeses] = useState(6) // ventana de análisis

  const cargar = useCallback(async () => {
    setLoading(true)
    try {
      const desde = new Date(); desde.setMonth(desde.getMonth() - meses)
      const desdeStr = desde.toISOString().slice(0, 10)
      const data = await fetchAll(
        () => supabase.from('entregas').select('ciudad, producto, mensajero, motivo, estado_pap, fecha_entrega').gte('fecha_entrega', desdeStr),
        { columnaOrden: 'nro_guia_pap' })
      // Normalizar cada entrega para el análisis
      const norm = (data || []).map(e => ({
        categoria: categorizarEntrega(e.estado_pap, e.motivo),
        ciudad: e.ciudad, producto: e.producto, mensajero: e.mensajero,
        motivo: e.motivo, fecha: e.fecha_entrega,
      }))
      setEntregas(norm)
    } catch (e) {
      setEntregas([])
    } finally {
      setLoading(false)
    }
  }, [meses])

  useEffect(() => { cargar() }, [cargar])

  const flete = getFlete()
  const a = useMemo(() => analizarEntregas(entregas, flete), [entregas, flete])
  const serie = useMemo(() => tasaPorMes(entregas), [entregas])
  const tendencia = useMemo(() => {
    if (serie.length < 2) return null
    const ult = serie[serie.length - 1].tasa, prev = serie[serie.length - 2].tasa
    return { sube: ult >= prev, delta: Math.round((ult - prev) * 100) }
  }, [serie])

  const pctGeneral = Math.round(a.tasaGeneral * 100)
  const colGeneral = a.tasaGeneral < TASA_CRITICA ? 'var(--red)' : a.tasaGeneral < TASA_VIGILAR ? 'var(--yellow)' : 'var(--green)'

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Inteligencia de entrega</h1>
          <p className="page-subtitle">Dónde perdés entregas y dónde conviene pedir prepago (vos decidís)</p>
        </div>
        <select className="form-select" style={{ width: 'auto' }} value={meses} onChange={e => setMeses(Number(e.target.value))}>
          <option value={3}>Últimos 3 meses</option>
          <option value={6}>Últimos 6 meses</option>
          <option value={12}>Último año</option>
        </select>
      </div>

      {loading ? (
        <div className="empty-state" style={{ padding: 60 }}><Loader2 size={28} className="spinning" /><p>Analizando entregas…</p></div>
      ) : a.resueltos === 0 ? (
        <div className="empty-state" style={{ padding: 60 }}>
          <div className="empty-state-icon"><Truck size={28} /></div>
          <p style={{ fontWeight: 600 }}>Sin datos de entrega en el período</p>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Importá el reporte de tu transportadora en Entregas para ver el análisis.</p>
        </div>
      ) : (
        <>
          {/* Resumen accionable */}
          <div className="card" style={{ padding: '18px 20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 18 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Tasa de entrega</div>
                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-display)', color: colGeneral }}>{pctGeneral}%</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.entregados} de {a.resueltos} entregados</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Plata perdida en fletes</div>
                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--red)' }}>{formatGs(a.fleteFallo)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.devueltos} devoluciones × flete</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Recuperable al 75%</div>
                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--green)' }}>{formatGs(a.ahorroPotencial)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>si subís la entrega</div>
              </div>
              {tendencia && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Tendencia</div>
                  <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-display)', color: tendencia.sube ? 'var(--green)' : 'var(--red)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {tendencia.sube ? '↑' : '↓'} {Math.abs(tendencia.delta)}%
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>vs mes anterior</div>
                </div>
              )}
            </div>
            {a.ahorroPotencial > 0 && (
              <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 14, marginBottom: 0, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                Estás perdiendo <strong style={{ color: 'var(--red)' }}>{formatGs(a.fleteFallo)}</strong> en fletes de devoluciones. Si llevás la entrega al 75%, recuperás <strong style={{ color: 'var(--green)' }}>{formatGs(a.ahorroPotencial)}</strong>. Mirá abajo dónde conviene pedir prepago.
              </p>
            )}
          </div>

          {/* Por ciudad */}
          <SeccionGrupo titulo="Por ciudad" Icon={MapPin} grupos={a.porCiudad} maxItems={15} />

          {/* Por producto y mensajero, lado a lado */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            <SeccionGrupo titulo="Por producto" Icon={Package} grupos={a.porProducto} maxItems={8} compacto />
            <SeccionGrupo titulo="Por mensajero" Icon={User} grupos={a.porMensajero} maxItems={8} compacto />
          </div>

          {/* Motivos de devolución */}
          {a.motivos.length > 0 && (
            <div className="card" style={{ padding: '16px 20px' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                <RotateCcw size={15} /> Por qué se devuelven
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {a.motivos.slice(0, 8).map(m => (
                  <div key={m.motivo} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 12.5, minWidth: 140, color: 'var(--text-secondary)' }}>{m.motivo}</span>
                    <div style={{ flex: 1, height: 6, background: 'var(--bg-hover)', borderRadius: 3 }}>
                      <div style={{ width: `${Math.round(m.pct * 100)}%`, height: '100%', borderRadius: 3, background: 'var(--red)' }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, minWidth: 60, textAlign: 'right' }}>{m.cantidad} ({Math.round(m.pct * 100)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Sección reutilizable: lista de grupos (ciudad/producto/mensajero) con su tasa y sugerencia.
function SeccionGrupo({ titulo, Icon, grupos, maxItems = 10, compacto = false }) {
  const items = (grupos || []).filter(g => g.resueltos > 0).slice(0, maxItems)
  if (!items.length) return null
  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={15} /> {titulo}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map(g => {
          const b = barra(g.tasa)
          const cfg = SUG_CFG[g.sugerencia.nivel] || SUG_CFG.pocos
          return (
            <div key={g.clave} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, minWidth: compacto ? 90 : 130, flex: compacto ? 1 : 'none' }}>{g.clave}</span>
              <div style={{ flex: 1, minWidth: 80, height: 6, background: 'var(--bg-hover)', borderRadius: 3 }}>
                <div style={{ width: `${b.pct}%`, height: '100%', borderRadius: 3, background: b.color, transition: 'width 0.5s' }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, minWidth: 38, textAlign: 'right', color: b.color }}>{b.pct}%</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)', minWidth: 44, textAlign: 'right' }}>{g.entregados}/{g.resueltos}</span>
              {g.sugerencia.nivel === 'critico' && (
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: cfg.bg, color: cfg.color, whiteSpace: 'nowrap' }}>
                  {g.sugerencia.texto}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
