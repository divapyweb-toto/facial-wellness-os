// src/pages/dashboard/DashboardPage.jsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabaseTienda as supabase, supabase as supabaseCrudo, formatGs, formatPct } from '../../lib/supabase'
import { getTienda } from '../../lib/tienda'
import DashboardHero from './DashboardHero'
import { COLOR_URGENCIA } from '../../lib/centroAcciones'
import { cargarDashboard } from './cargaDashboard'
import { useAuth } from '../../lib/AuthContext'
import { useToast } from '../../lib/toast'
import CountUp from '../../lib/CountUp'
import { textoEsperada, textoRango, textoFuente, colorTasa } from '../../lib/tasaEntrega'
import { lazy, Suspense } from 'react'
// recharts (~5 MB) se carga aparte: los números aparecen ya, los gráficos después
const ChartUltimos7 = lazy(() => import('./DashboardCharts').then(m => ({ default: m.ChartUltimos7 })))
const ChartEvolucion = lazy(() => import('./DashboardCharts').then(m => ({ default: m.ChartEvolucion })))
const ChartFallback = () => <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Cargando gráfico…</div>
import {
  TrendingUp, Package, Truck, AlertTriangle, Plus,
  DollarSign, BarChart3, RefreshCw, Banknote, Edit3,
  CheckCircle2, XCircle, Clock, ArrowUpRight, History, X, Target
} from 'lucide-react'

// Bloques secundarios que muestran su propio skeleton chico en la PRIMERA carga
// (en las recargas los datos viejos quedan en pantalla hasta que llegan los nuevos).
const CARGANDO_TODO = { enCalle: true, saldo: true, chart7: true, historico: true, top: true, alertas: true, acciones: true, recientes: true }
const CARGANDO_NADA = { enCalle: false, saldo: false, chart7: false, historico: false, top: false, alertas: false, acciones: false, recientes: false }
const SkeletonLinea = ({ ancho = '100%', alto = 12 }) => <div className="skeleton" style={{ width: ancho, height: alto }} />
const SkeletonBloque = ({ alto = 120 }) => <div className="skeleton" style={{ height: alto, borderRadius: 'var(--radius)' }} />


// Modal saldo banco
function SaldoModal({ onClose, onSaved }) {
  const { toast } = useToast()
  const [historial, setHistorial] = useState([])
  const [monto, setMonto] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase.from('saldo_banco').select('*').order('created_at', { ascending: false }).limit(10)
      .then(({ data }) => setHistorial(data || []))
  }, [])

  const handleGuardar = async (e) => {
    e.preventDefault()
    if (!monto) return
    setLoading(true)
    const montoLimpio = parseInt(monto.replace(/\D/g, ''))
    const { error } = await supabase.from('saldo_banco').insert({
      monto: montoLimpio,
      descripcion: descripcion || 'Actualización manual',
    })
    if (error) toast('Error: ' + error.message, 'error')
    else {
      toast('Saldo registrado', 'success')
      onSaved()
      onClose()
    }
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Saldo en cuenta bancaria</h2>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        <form onSubmit={handleGuardar} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Monto actual en cuenta (Gs.) *</label>
            <input
              className="form-input"
              type="number"
              placeholder="Ej: 3.000.000"
              value={monto}
              onChange={e => setMonto(e.target.value)}
              required autoFocus
              style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18 }}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Descripción (opcional)</label>
            <input className="form-input" placeholder="Ej: Después de rendición semana 3" value={descripcion} onChange={e => setDescripcion(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading} style={{ justifyContent: 'center' }}>
            {loading ? 'Guardando...' : 'Guardar saldo'}
          </button>
        </form>

        {historial.length > 0 && (
          <>
            <div className="divider" />
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
              Historial reciente
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {historial.map((s, i) => (
                <div key={s.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', background: i === 0 ? 'var(--accent-dim)' : 'var(--bg-hover)',
                  borderRadius: 6, border: i === 0 ? '1px solid rgba(46,139,212,0.2)' : 'none',
                }}>
                  <div>
                    <div style={{ fontWeight: 700, color: i === 0 ? 'var(--accent)' : 'var(--text-primary)', fontSize: 14 }}>
                      {formatGs(s.monto)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {new Date(s.created_at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short', year: 'numeric' })}
                      {s.descripcion ? ` · ${s.descripcion}` : ''}
                    </div>
                  </div>
                  {i === 0 && <span className="badge badge-accent">Actual</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { profile, isAdmin } = useAuth()
  const navigate = useNavigate()
  const [kpis, setKpis] = useState(null)
  const [alertas, setAlertas] = useState([])
  const [acciones, setAcciones] = useState([])
  const [chartData, setChartData] = useState([])
  const [historico6m, setHistorico6m] = useState([])
  const [topProductos, setTopProductos] = useState([])
  const [saldoBanco, setSaldoBanco] = useState(null)
  const [showSaldoModal, setShowSaldoModal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [ventasRecientes, setVentasRecientes] = useState([])
  const [hero, setHero] = useState(null)
  const [fallasCarga, setFallasCarga] = useState([])
  const [cargando, setCargando] = useState(CARGANDO_TODO)

  // Recargas: cada carga lleva un número; si llega una más nueva, la vieja se
  // descarta (antes dos recargas seguidas se pisaban y quedaba la más lenta).
  const pedidoRef = useRef(0)
  const yaCargoRef = useRef(false)

  const cargarDatos = useCallback(async () => {
    const miPedido = ++pedidoRef.current
    const vigente = () => miPedido === pedidoRef.current
    // Skeleton de página entera solo la PRIMERA vez y solo hasta que llega el
    // bloque principal: en las recargas los números quedan en pantalla y se
    // actualizan solos.
    if (!yaCargoRef.current) setLoading(true)
    // Cada bloque se pinta apenas llegan SUS datos (ver cargaDashboard.js).
    // datos === undefined → ese bloque falló: se deja lo que había.
    const emitir = (bloque, d) => {
      if (d !== undefined) {
        switch (bloque) {
          case 'heroHoy': setHero(h => ({ ...(h || {}), hoyCount: d.hoyCount, hoyMonto: d.hoyMonto })); break
          case 'enCalle': setHero(h => ({ ...(h || {}), enCalleCount: d.enCalleCount, enCalleMonto: d.enCalleMonto })); break
          case 'chart7':
            setHero(h => ({ ...(h || {}), tasa7d: d.tasa7d, resueltos7d: d.resueltos7d, tasa7dReal: d.tasa7dReal }))
            setChartData(d.chartData)
            break
          case 'principal': setKpis(d.kpis); break
          case 'historico': setHistorico6m(d); break
          case 'saldo': setSaldoBanco(d.saldo); break
          case 'top': setTopProductos(d); break
          case 'alertas': setAlertas(d); break
          case 'acciones': setAcciones(d); break
          case 'recientes': setVentasRecientes(d); break
        }
      }
      if (bloque === 'principal') { yaCargoRef.current = true; setLoading(false) }
      setCargando(c => (c[bloque] ? { ...c, [bloque]: false } : c))
    }
    let fallas = []
    try {
      ({ fallas } = await cargarDashboard({ supabase, supabaseCrudo, tienda: getTienda(), vigente, emitir }))
    } catch (e) {
      // Lo que no se pudo leer: se muestra arriba y NO se arma la alerta/KPI que depende de eso.
      fallas = ['datos del panel']
      console.error('[dashboard] error inesperado:', e)
    } finally {
      if (vigente()) {
        setFallasCarga(fallas)
        yaCargoRef.current = true
        setLoading(false)
        setCargando(c => (Object.values(c).some(Boolean) ? CARGANDO_NADA : c))
      }
    }
  }, [])

  useEffect(() => {
    cargarDatos()
    // Cada cambio en ventas recarga ~20 consultas (en paralelo): se espera 1 s desde el
    // ÚLTIMO cambio (un import de 30 ventas dispara 30 eventos → 1 recarga).
    let timer = null
    const alCambiar = () => { clearTimeout(timer); timer = setTimeout(() => cargarDatos(), 1000) }
    const channel = supabase.channel('dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ventas' }, alCambiar)
      .subscribe()
    return () => {
      clearTimeout(timer)
      pedidoRef.current++ // descarta una carga en vuelo al salir
      supabase.removeChannel(channel)
    }
  }, [cargarDatos])

  const estadoBadge = {
    pendiente: <span className="badge badge-yellow">Pendiente</span>,
    entregado: <span className="badge badge-green">Entregado</span>,
    devuelto: <span className="badge badge-red">Devuelto</span>,
    en_tramite: <span className="badge badge-purple">En trámite</span>,
  }

  if (loading) return (
    <div className="skeleton-page">
      <div className="skeleton skeleton-hero" />
      <div className="skeleton-row">
        {[...Array(3)].map((_, i) => <div key={i} className="skeleton skeleton-kpi" />)}
      </div>
      <div className="skeleton-row">
        {[...Array(3)].map((_, i) => <div key={i} className="skeleton skeleton-kpi" />)}
      </div>
    </div>
  )

  const mesActual = new Date().toLocaleDateString('es-PY', { month: 'long', year: 'numeric' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── HERO: cómo va el negocio HOY, en 3 segundos ── */}
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <DashboardHero
            nombre={profile?.nombre?.split(' ')[0] || 'Enrique'}
            hoyCount={hero?.hoyCount ?? 0}
            hoyMonto={hero?.hoyMonto ?? 0}
            tasa7d={hero?.tasa7d ?? null}
            resueltos7d={hero?.resueltos7d ?? 0}
            tasa7dReal={hero?.tasa7dReal ?? null}
            enCalleCount={hero?.enCalleCount ?? 0}
            enCalleMonto={hero?.enCalleMonto ?? 0}
            alertasCount={alertas.length}
            pendiente={{ tasa: cargando.chart7, enCalle: cargando.enCalle, alertas: cargando.alertas }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="section-label">{mesActual.charAt(0).toUpperCase() + mesActual.slice(1)}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => cargarDatos()} title="Actualizar"><RefreshCw size={13} /></button>
      </div>

      {/* Lo que no se pudo leer: esos números/alertas NO se muestran (mejor nada que uno falso). */}
      {fallasCarga.length > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(234,179,8,0.1)', border: '1px solid var(--yellow)', fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <AlertTriangle size={14} color="var(--yellow)" />
          <span>No se pudo cargar: {fallasCarga.join(', ')}. Esos datos no se muestran.</span>
          <button className="btn btn-ghost btn-sm" onClick={() => cargarDatos()}>Reintentar</button>
        </div>
      )}

      {/* Alertas */}
      {/* CENTRO DE ACCIONES — qué falta hacer, ordenado por plata en juego.
          Va ARRIBA de las alertas a propósito: las alertas dicen qué pasó, esto
          dice qué hacer. Lo accionable primero. */}
      {cargando.acciones && (
        <div className="card" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SkeletonLinea ancho="35%" alto={14} />
          <SkeletonLinea alto={38} />
        </div>
      )}
      {acciones.length > 0 && (
        <div className="card" style={{ padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Qué falta hacer</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {acciones.length} pendiente{acciones.length > 1 ? 's' : ''} · ordenado por plata en juego
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {acciones.map(a => (
              <div key={a.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                flexWrap: 'wrap', padding: '10px 12px', borderRadius: 8,
                background: 'var(--bg-hover)', borderLeft: `3px solid ${COLOR_URGENCIA[a.urgencia]}`,
              }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{a.titulo}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{a.detalle}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {a.monto > 0 && (
                    <span style={{ fontSize: 13, fontWeight: 700, color: COLOR_URGENCIA[a.urgencia], whiteSpace: 'nowrap' }}>
                      {formatGs(a.monto)}
                    </span>
                  )}
                  <button className="btn btn-sm btn-secondary" onClick={() => navigate(a.ruta)} style={{ whiteSpace: 'nowrap' }}>
                    {a.cta}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {cargando.alertas && <SkeletonLinea alto={36} />}
      {alertas.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {alertas.map((a, i) => (
            <div key={i} className={`alert alert-${a.color === 'red' ? 'error' : a.color === 'green' ? 'success' : 'warning'}`}>
              <AlertTriangle size={14} />
              <span style={{ flex: 1 }}>{a.msg}</span>
              {a.ruta ? (
                <button className="btn btn-ghost btn-sm" onClick={() => navigate(a.ruta)}>{a.accion || 'Ver'}</button>
              ) : a.tipo === 'stock' ? (
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/stock')}>Ver</button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* Saldo banco — tarjeta especial */}
      <div
        className="saldo-card"
        style={{ cursor: 'pointer' }}
        onClick={() => setShowSaldoModal(true)}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 32, height: 32, background: 'var(--accent-dim)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Banknote size={16} color="var(--accent)" />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Saldo en banco</div>
              {cargando.saldo ? (
                <div style={{ padding: '6px 0' }}><SkeletonLinea ancho={140} alto={20} /></div>
              ) : (
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, color: saldoBanco ? 'var(--accent)' : 'var(--text-muted)', letterSpacing: '-0.02em' }}>
                  {saldoBanco ? formatGs(saldoBanco.monto) : 'Sin registrar'}
                </div>
              )}
              {saldoBanco && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
                  Actualizado {new Date(saldoBanco.created_at).toLocaleDateString('es-PY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Edit3 size={11} /> Actualizar
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <History size={10} /> Ver historial
            </span>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label"><TrendingUp size={11} />Ventas brutas</div>
          <div className="kpi-value"><CountUp value={kpis?.ventasBrutas || 0} format={formatGs} /></div>
          <div className="kpi-sub">Solo entregadas</div>
          <div className="kpi-icon" style={{ background: 'var(--green-dim)' }}><TrendingUp size={14} color="var(--green)" /></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><DollarSign size={11} />Contribución firme</div>
          <div className="kpi-value green"><CountUp value={kpis?.ingresosNetos || 0} format={formatGs} /></div>
          <div className="kpi-sub">Después de flete y producto</div>
          <div className="kpi-icon" style={{ background: 'var(--green-dim)' }}><DollarSign size={14} color="var(--green)" /></div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><BarChart3 size={11} />Margen %</div>
          <div className={`kpi-value ${(kpis?.margenPct || 0) > 40 ? 'green' : 'yellow'}`}>{formatPct(kpis?.margenPct || 0)}</div>
          <div className="kpi-sub">Contribución sobre lo cobrado</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Package size={11} />Enviados</div>
          <div className="kpi-value">{kpis?.paquetesEnviados || 0}</div>
          <div className="kpi-sub">
            {kpis?.entregados || 0} entregados · {kpis?.devueltos || 0} devueltos · {kpis?.enCamino || 0} en camino
            {(kpis?.sinDespachar || 0) > 0 && <span style={{ color: 'var(--yellow)' }}> · {kpis.sinDespachar} sin guía</span>}
          </div>
        </div>
        {/* 12-10: ~esperada + rango + en camino. Con pocos resueltos, color neutro
            (antes: 4 de 4 resueltos con 23 volando = "100%" verde). */}
        <div className="kpi-card">
          <div className="kpi-label"><Truck size={11} />Tasa entrega</div>
          <div className="kpi-value" style={{ color: colorTasa(kpis?.tasaReal, { verde: 60, amarillo: 40 }) }}>
            {textoEsperada(kpis?.tasaReal)}
          </div>
          <div className="kpi-sub" title={kpis?.tasaReal ? textoFuente(kpis.tasaReal) : undefined}>
            {textoRango(kpis?.tasaReal)}
          </div>
        </div>
      </div>

      {/* Desglose de cobro: transferencia (ya en banco) vs COD (por rendir PaP) */}
      {kpis && kpis.cantTransferencia > 0 && (
        <div className="card" style={{ padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Banknote size={15} color="var(--green)" />
            <span style={{ fontWeight: 700, fontSize: 14 }}>Cómo cobraste lo entregado</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--green-dim)', border: '1px solid var(--green)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Ya cobrado · transferencia</div>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--green)', marginTop: 4 }}>
                {formatGs(kpis.ingresoTransferencia)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {kpis.cantTransferencia} pedido{kpis.cantTransferencia === 1 ? '' : 's'} · ya está en tu cuenta
              </div>
            </div>
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Por rendir · COD</div>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--text-primary)', marginTop: 4 }}>
                {formatGs(kpis.ingresoCOD)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                lo cobra la transportadora y te lo rinde
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Punto de equilibrio en vivo */}
      {kpis && (kpis.gastosMes > 0 || kpis.entregados > 0) && (
        <div className="card" style={{ padding: '16px 18px', border: '1px solid var(--border)', background: kpis.cubierto ? 'linear-gradient(135deg, var(--green-dim), transparent)' : 'var(--bg-card)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Target size={15} color={kpis.cubierto ? 'var(--green)' : 'var(--accent)'} />
            <span style={{ fontWeight: 700, fontSize: 14 }}>Punto de equilibrio del mes</span>
          </div>
          {kpis.cubierto ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <CheckCircle2 size={18} color="var(--green)" />
                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)' }}>¡Gastos cubiertos!</span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Ganancia firme: <strong style={{ color: 'var(--green)' }}>{formatGs(kpis.gananciaReal)}</strong>
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                Cubriste {formatGs(kpis.gastosMes)} de gastos. Cada paquete que cierre bien deja ~{formatGs(Math.round(kpis.margenPromedio))} de contribución.
                {kpis.sangradoFlete > 0 && ` Ya se descontaron ${formatGs(kpis.sangradoFlete)} de flete de las ${kpis.devueltos} devoluciones.`}
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 28, fontFamily: 'var(--font-display)', fontWeight: 800, color: 'var(--accent)' }}>
                  {kpis.faltaParaCubrir}
                </span>
                <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                  venta{kpis.faltaParaCubrir !== 1 ? 's' : ''} más para cubrir el mes
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                  <span>Cubierto: {formatGs(kpis.ingresosNetos)}</span>
                  <span>Meta: {formatGs(kpis.gastosMes)}</span>
                </div>
                <div style={{ height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, kpis.gastosMes ? (kpis.ingresosNetos / kpis.gastosMes) * 100 : 0)}%`, height: '100%', background: 'var(--accent)', borderRadius: 4, transition: 'width 0.6s ease' }} />
                </div>
              </div>
              {kpis.margenPromedio > 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                  A ~{formatGs(Math.round(kpis.margenPromedio))} de margen por venta. Te faltan {formatGs(Math.abs(kpis.gananciaReal))}.
                </div>
              )}
            </div>
          )}
          {/* 12-10: lo que todavía vuela no está en la ganancia firme; se muestra
              aparte cuánto aportaría si cierra a la tasa proyectada. */}
          {kpis.enCamino > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10, padding: '8px 10px', background: 'var(--bg-hover)', borderRadius: 8 }}>
              <Clock size={12} style={{ verticalAlign: -2 }} /> {kpis.enCamino} en camino aportarían ~
              <strong style={{ color: kpis.contribucionProyectada >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {kpis.contribucionProyectada >= 0 ? '+' : ''}{formatGs(kpis.contribucionProyectada)}
              </strong>
              {' '}de contribución si cierran al {kpis.tasaProyeccion}% ({kpis.fuenteTasa === 'historica' ? 'tu historial' : 'referencia, poca historia'}).
              {!kpis.cubierto && kpis.gananciaReal + kpis.contribucionProyectada >= 0 && ' Con eso cubrirías el mes.'}
            </div>
          )}
          <div
            onClick={() => navigate('/entregas')}
            style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <Target size={12} /> Ver análisis logístico completo (contribución por envío, devoluciones, fletes) →
          </div>
        </div>
      )}
      <div className="chart-card">
        <div className="chart-header">
          <span className="chart-title">Últimos 7 días</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Solo entregadas</span>
        </div>
        {cargando.chart7 ? <SkeletonBloque alto={160} /> : (
          <Suspense fallback={<ChartFallback />}>
            <ChartUltimos7 chartData={chartData} />
          </Suspense>
        )}
      </div>

      {/* Evolución 6 meses (tendencia de mediano plazo) */}
      {cargando.historico && <SkeletonBloque alto={240} />}
      {historico6m.length > 0 && (
        <div className="chart-card">
          <div className="chart-header">
            <span className="chart-title">Evolución · últimos 6 meses</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Solo entregadas</span>
          </div>
          <Suspense fallback={<ChartFallback />}>
            <ChartEvolucion historico6m={historico6m} />
          </Suspense>
        </div>
      )}
      {cargando.top && <SkeletonBloque alto={150} />}
      {topProductos.length > 0 && (
        <div className="card card-sm">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Top productos — este mes <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>(por contribución, solo entregados)</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {topProductos.map((p, i) => {
              const maxIngresos = topProductos[0]?.ingresos || 1
              const pct = (p.ingresos / maxIngresos) * 100
              return (
                <div key={i}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{p.nombre}</span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{p.ventas} uds · {formatGs(p.ingresos)} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>contribución</span></span>
                  </div>
                  <div style={{ background: 'var(--bg-hover)', borderRadius: 3, height: 4 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: i === 0 ? 'var(--accent)' : 'var(--green)', borderRadius: 3, transition: 'width 0.6s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Ventas recientes */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Ventas recientes</span>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/ventas')}>
            Ver todas <ArrowUpRight size={11} />
          </button>
        </div>
        {cargando.recientes ? (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...Array(4)].map((_, i) => <SkeletonLinea key={i} alto={18} />)}
          </div>
        ) : ventasRecientes.length === 0 ? (
          <div className="empty-state" style={{ padding: 32 }}>
            <div className="empty-state-icon"><Package size={20} /></div>
            <p className="empty-state-title">Sin ventas aún</p>
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/ventas')}>
              <Plus size={12} /> Nueva venta
            </button>
          </div>
        ) : (
          <>
            {/* Desktop: tabla */}
            <div className="desktop-only" style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: 500 }}>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Producto</th>
                    <th>Total</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {ventasRecientes.map(v => (
                    <tr key={v.id}>
                      <td className="muted" style={{ fontSize: 12 }}>{new Date(v.fecha + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}</td>
                      <td style={{ fontWeight: 500, fontSize: 12 }}>{v.producto_nombre}</td>
                      <td style={{ fontWeight: 600, fontSize: 12 }}>{formatGs(v.total)}</td>
                      <td>{estadoBadge[v.estado]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Móvil: filas compactas */}
            <div className="mobile-only" style={{ display: 'flex', flexDirection: 'column' }}>
              {ventasRecientes.map((v, i) => (
                <div
                  key={v.id}
                  onClick={() => navigate('/ventas')}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                    padding: '12px 16px',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {v.producto_nombre}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {new Date(v.fecha + 'T00:00:00').toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-display)' }}>{formatGs(v.total)}</span>
                    {estadoBadge[v.estado]}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {showSaldoModal && <SaldoModal onClose={() => setShowSaldoModal(false)} onSaved={() => cargarDatos()} />}
    </div>
  )
}
