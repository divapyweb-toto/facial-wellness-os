// src/pages/dashboard/DashboardPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, formatGs, formatPct } from '../../lib/supabase'
import { calcularPiramide, indexarCostos } from '../../lib/contribucion'
import { construirAlertasNegocio } from '../../lib/alertasNegocio'
import { fetchAll } from '../../lib/fetchAll'
import { useAuth } from '../../lib/AuthContext'
import { useToast } from '../../lib/toast'
import CountUp from '../../lib/CountUp'
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

// Costo estimado cuando una venta no tiene el costo real cargado (igual que Entregas)
const COGS_PROMEDIO = 12000


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
                  borderRadius: 6, border: i === 0 ? '1px solid rgba(200,241,53,0.2)' : 'none',
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
  const [chartData, setChartData] = useState([])
  const [historico6m, setHistorico6m] = useState([])
  const [topProductos, setTopProductos] = useState([])
  const [saldoBanco, setSaldoBanco] = useState(null)
  const [showSaldoModal, setShowSaldoModal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [ventasRecientes, setVentasRecientes] = useState([])

  const cargarDatos = useCallback(async () => {
    setLoading(true)
    const ahora = new Date()
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString().split('T')[0]
    const finMes = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).toISOString().split('T')[0]

    const { data: ventasMes } = await supabase
      .from('ventas').select('*').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', finMes)

    // Gastos del mes (costo fijo para el punto de equilibrio)
    const { data: gastosMes } = await supabase
      .from('gastos').select('monto, categoria').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', finMes)
    const totalGastosMes = (gastosMes || []).reduce((s, g) => s + (g.monto || 0), 0)

    // Gasto de Meta Ads del mes (viene del módulo Campañas). Se descuenta de la
    // ganancia igual que cualquier gasto — es plata que sale. Fuente única: acá.
    let totalAdsMes = 0
    try {
      const { data: adsRows } = await supabase.from('campanas_ads').select('gasto').eq('mes', inicioMes.slice(0, 7))
      totalAdsMes = (adsRows || []).reduce((s, c) => s + (c.gasto || 0), 0)
    } catch (e) { /* sin gasto de ads cargado */ }

    // Protección anti-doble: ¿hay ads en Campañas Y también un gasto de "Publicidad"?
    const gastoPublicidad = (gastosMes || []).filter(g => /public|ads|meta|marketing/i.test(g.categoria || '')).reduce((s, g) => s + (g.monto || 0), 0)
    const posibleDoble = totalAdsMes > 0 && gastoPublicidad > 0

    // Total de gastos que se descuenta de la ganancia = gastos + ads
    const totalGastosConAds = totalGastosMes + totalAdsMes

    // ── Histórico de 6 meses (tendencia de mediano plazo) ──
    const inicio6m = new Date(ahora.getFullYear(), ahora.getMonth() - 5, 1).toISOString().split('T')[0]
    const ventas6m = await fetchAll(() => supabase
      .from('ventas').select('fecha, total, ganancia_neta, estado').is('deleted_at', null).gte('fecha', inicio6m))
    const mesesData = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1)
      const ini = d.toISOString().split('T')[0]
      const fin = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0]
      const vMes = (ventas6m || []).filter(v => v.fecha >= ini && v.fecha <= fin)
      const entMes = vMes.filter(v => v.estado === 'entregado')
      mesesData.push({
        mes: d.toLocaleDateString('es-PY', { month: 'short' }),
        ventas: entMes.reduce((s, v) => s + (v.total || 0), 0),
        neto: entMes.reduce((s, v) => s + (v.ganancia_neta || 0), 0),
      })
    }
    setHistorico6m(mesesData)

    if (ventasMes) {
      const entregadas = ventasMes.filter(v => v.estado === 'entregado')
      const pendientes = ventasMes.filter(v => v.estado === 'pendiente')
      const devueltas = ventasMes.filter(v => v.estado === 'devuelto')

      // ── Fuente única de verdad: el mismo módulo que usan Entregas y Reportes ──
      // Antes acá había una fórmula propia que NO restaba el flete de las
      // devoluciones, y sobrestimaba la ganancia en (devueltos × 27.000).
      const paquetes = ventasMes.map(v => ({
        n_referencia: v.n_referencia,
        importe: v.total || 0,
        fecha: v.fecha,
        costo_envio: v.costo_envio,  // flete real de esta venta (su transportadora)
        categoria: v.estado === 'entregado' ? 'entregado'
                 : v.estado === 'devuelto' ? 'devuelto'
                 : 'en_proceso',
      }))
      const piramide = calcularPiramide(paquetes, indexarCostos(ventasMes), COGS_PROMEDIO, totalGastosConAds)

      // ── Desglose de cobro sobre lo entregado ──
      // Transferencia (prepago): plata que YA está en tu cuenta.
      // COD: la cobra PaP y te la rinde después.
      const ingresoTransferencia = entregadas.filter(v => v.pago_anticipado).reduce((s, v) => s + (v.total || 0), 0)
      const ingresoCOD = entregadas.filter(v => !v.pago_anticipado).reduce((s, v) => s + (v.total || 0), 0)
      const cantTransferencia = entregadas.filter(v => v.pago_anticipado).length

      // Cada paquete resuelto de más aporta la contribución por envío.
      const margenPromedio = piramide.contribPorEnvio
      const gananciaReal = piramide.gananciaFirme
      const faltaParaCubrir = (gananciaReal < 0 && margenPromedio > 0)
        ? Math.ceil(Math.abs(gananciaReal) / margenPromedio)
        : 0

      setKpis({
        ventasBrutas: piramide.ingreso,
        // Contribución firme: lo que deja la operación después de flete y producto
        ingresosNetos: piramide.contribucionFirme,
        // Margen de contribución sobre lo cobrado
        margenPct: piramide.ingreso ? (piramide.contribucionFirme / piramide.ingreso) * 100 : 0,
        paquetesEnviados: ventasMes.length,
        entregados: entregadas.length,
        devueltos: devueltas.length,
        pendientesCount: pendientes.length,
        // Tasa sobre lo RESUELTO (entregados + devueltos), no sobre los que aún vuelan
        tasaEntrega: piramide.tasaEntrega,
        sangradoFlete: piramide.sangradoFlete,
        // Punto de equilibrio
        gastosMes: totalGastosMes,
        gastoAds: totalAdsMes,
        posibleDobleAds: posibleDoble,
        margenPromedio,
        gananciaReal,
        faltaParaCubrir,
        cubierto: gananciaReal >= 0,
        // Desglose de cobro
        ingresoTransferencia,
        ingresoCOD,
        cantTransferencia,
      })
    }

    // Saldo banco
    const { data: saldo } = await supabase
      .from('saldo_banco').select('*').order('created_at', { ascending: false }).limit(1).single()
    setSaldoBanco(saldo)

    // Chart 7 días
    const hace7 = new Date(); hace7.setDate(hace7.getDate() - 6)
    const { data: ventasChart } = await supabase
      .from('ventas').select('fecha, total, estado, ganancia_neta')
      .gte('fecha', hace7.toISOString().split('T')[0]).order('fecha')

    if (ventasChart) {
      const porDia = {}
      for (let i = 0; i < 7; i++) {
        const d = new Date(); d.setDate(d.getDate() - (6 - i))
        const key = d.toISOString().split('T')[0]
        const label = d.toLocaleDateString('es-PY', { weekday: 'short', day: 'numeric' })
        porDia[key] = { fecha: label, ventas: 0, neto: 0 }
      }
      ventasChart.forEach(v => {
        if (porDia[v.fecha] && v.estado === 'entregado') {
          porDia[v.fecha].ventas += v.total
          porDia[v.fecha].neto += v.ganancia_neta
        }
      })
      setChartData(Object.values(porDia))
    }

    // Top productos
    const { data: topProds } = await supabase
      .from('ventas').select('producto_nombre, total, ganancia_neta, estado, cantidad')
      .gte('fecha', inicioMes).lte('fecha', finMes).eq('estado', 'entregado')
    if (topProds) {
      const agrupado = {}
      topProds.forEach(v => {
        if (!agrupado[v.producto_nombre]) agrupado[v.producto_nombre] = { nombre: v.producto_nombre, ventas: 0, ingresos: 0 }
        agrupado[v.producto_nombre].ventas += v.cantidad
        agrupado[v.producto_nombre].ingresos += v.ganancia_neta
      })
      setTopProductos(Object.values(agrupado).sort((a, b) => b.ingresos - a.ingresos).slice(0, 5))
    }

    // Alertas
    const alertasActivas = []
    const { data: todosProds } = await supabase.from('productos')
      .select('id, nombre, stock_actual, stock_alerta, es_combo, componente_1_id, componente_1_qty, componente_2_id, componente_2_qty')
      .eq('activo', true)
    if (todosProds) {
      const porId = todosProds.reduce((a, p) => { a[p.id] = p; return a }, {})
      // Stock real considerando combos (combo = mínimo de sus componentes disponibles)
      const stockReal = (p) => {
        if (!p.es_combo) return p.stock_actual
        const disp = []
        const c1 = porId[p.componente_1_id], c2 = porId[p.componente_2_id]
        if (c1) disp.push(Math.floor((c1.stock_actual || 0) / (p.componente_1_qty || 1)))
        if (c2) disp.push(Math.floor((c2.stock_actual || 0) / (p.componente_2_qty || 1)))
        return disp.length ? Math.min(...disp) : 0
      }
      todosProds
        .filter(p => stockReal(p) <= p.stock_alerta)
        .forEach(p => {
          const s = stockReal(p)
          alertasActivas.push({
            tipo: 'stock', color: 'red',
            msg: p.es_combo
              ? `Stock bajo: ${p.nombre} — ${s} armables`
              : `Stock bajo: ${p.nombre} — ${s} uds`,
          })
        })
    }
    const hace5 = new Date(); hace5.setDate(hace5.getDate() - 5)
    const { data: viejos } = await supabase.from('ventas').select('id').eq('estado', 'pendiente').lt('fecha', hace5.toISOString().split('T')[0])
    if (viejos?.length) alertasActivas.push({ tipo: 'pendiente', color: 'yellow', msg: `${viejos.length} pedido(s) pendiente(s) con más de 5 días sin resolver` })

    // Advertencia anti-doble-conteo: ads cargado en Campañas Y en Gastos (Publicidad)
    if (posibleDoble) {
      alertasActivas.push({
        tipo: 'doble_ads', color: 'yellow', ruta: '/finanzas', accion: 'Revisar gastos',
        msg: 'Cargaste Meta Ads en Campañas y también un gasto de "Publicidad" este mes. Se está descontando dos veces — borrá el gasto de Publicidad (el ads ya cuenta desde Campañas).',
      })
    }

    // ── Alertas inteligentes de negocio (cada dato por separado: si uno falla,
    //    las demás alertas igual salen) ──
    const datosAlertas = {}
    try {
      // Ventas mes actual vs mes anterior
      const inicioMesAnt = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1).toISOString().slice(0, 10)
      const finMesAnt = new Date(ahora.getFullYear(), ahora.getMonth(), 0).toISOString().slice(0, 10)
      const { data: vAct } = await supabase.from('ventas').select('total').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', finMes)
      const { data: vAnt } = await supabase.from('ventas').select('total').is('deleted_at', null).gte('fecha', inicioMesAnt).lte('fecha', finMesAnt)
      datosAlertas.ventasMesActual = (vAct || []).reduce((s, v) => s + (v.total || 0), 0)
      datosAlertas.ventasMesAnterior = (vAnt || []).reduce((s, v) => s + (v.total || 0), 0)
    } catch (e) { /* sin comparación de ventas */ }

    try {
      // Recompra pendientes (clientes listos hoy, estimación)
      const desdeR = new Date(); desdeR.setMonth(desdeR.getMonth() - 8)
      const [{ data: vEnt }, { data: logs }] = await Promise.all([
        supabase.from('ventas').select('cliente_telefono, fecha, estado').eq('estado', 'entregado').is('deleted_at', null).gte('fecha', desdeR.toISOString().slice(0, 10)).limit(1000),
        supabase.from('recompra_log').select('telefono, fecha_envio').gte('fecha_envio', new Date(Date.now() - 25 * 86400000).toISOString()),
      ])
      const enCooldown = new Set((logs || []).map(l => String(l.telefono).replace(/\D/g, '')))
      const hace15 = Date.now() - 15 * 86400000
      const candidatos = new Set()
      for (const v of (vEnt || [])) {
        const tel = String(v.cliente_telefono || '').replace(/\D/g, '')
        if (!tel || enCooldown.has(tel)) continue
        if (v.fecha && new Date(v.fecha).getTime() < hace15) candidatos.add(tel)
      }
      datosAlertas.recompraPendientes = candidatos.size
    } catch (e) { /* sin alerta de recompra */ }

    try {
      // Plata de PaP sin rendir
      const { data: sinRend } = await supabase.from('entregas').select('importe').eq('cobrado', true).eq('rendido', false).limit(2000)
      datosAlertas.montoSinRendir = (sinRend || []).reduce((s, e) => s + (Number(e.importe) || 0), 0)
      datosAlertas.cantSinRendir = (sinRend || []).length
    } catch (e) { /* sin alerta de rendición */ }

    try {
      // Tasa de entrega este mes vs mes anterior (independiente, para la alerta)
      const inicioMesAnt2 = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1).toISOString().slice(0, 10)
      const finMesAnt2 = new Date(ahora.getFullYear(), ahora.getMonth(), 0).toISOString().slice(0, 10)
      const tasa = (arr) => {
        const ent = (arr || []).filter(v => v.estado === 'entregado').length
        const dev = (arr || []).filter(v => v.estado === 'devuelto').length
        return { tasa: (ent + dev) ? ent / (ent + dev) : 0, resueltos: ent + dev }
      }
      const { data: vMesTasa } = await supabase.from('ventas').select('estado').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', finMes)
      const { data: vAntTasa } = await supabase.from('ventas').select('estado').is('deleted_at', null).gte('fecha', inicioMesAnt2).lte('fecha', finMesAnt2)
      const tAct = tasa(vMesTasa), tAnt = tasa(vAntTasa)
      datosAlertas.tasaEntregaActual = tAct.tasa
      datosAlertas.tasaEntregaAnterior = tAnt.tasa
      datosAlertas.entregasResueltas = tAct.resueltos
    } catch (e) { /* sin alerta de entrega */ }

    const alertasInteligentes = construirAlertasNegocio(datosAlertas)
    setAlertas([...alertasActivas, ...alertasInteligentes])

    // Ventas recientes
    const { data: recientes } = await supabase.from('ventas').select('*').order('created_at', { ascending: false }).limit(8)
    setVentasRecientes(recientes || [])

    setLoading(false)
  }, [])

  useEffect(() => {
    cargarDatos()
    const channel = supabase.channel('dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ventas' }, cargarDatos)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [cargarDatos])

  const estadoBadge = {
    pendiente: <span className="badge badge-yellow">Pendiente</span>,
    entregado: <span className="badge badge-green">Entregado</span>,
    devuelto: <span className="badge badge-red">Devuelto</span>,
    en_tramite: <span className="badge badge-purple">En trámite</span>,
  }

  if (loading) return (
    <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
      {[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 80, borderRadius: 10 }} />)}
    </div>
  )

  const mesActual = new Date().toLocaleDateString('es-PY', { month: 'long', year: 'numeric' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Hola, {profile?.nombre?.split(' ')[0] || 'Enrique'} 👋</h1>
          <p className="page-subtitle">{mesActual.charAt(0).toUpperCase() + mesActual.slice(1)}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-sm" onClick={cargarDatos}><RefreshCw size={13} /></button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/ventas')}>
            <Plus size={14} /> Nueva venta
          </button>
        </div>
      </div>

      {/* Alertas */}
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
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, color: saldoBanco ? 'var(--accent)' : 'var(--text-muted)', letterSpacing: '-0.02em' }}>
                {saldoBanco ? formatGs(saldoBanco.monto) : 'Sin registrar'}
              </div>
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
          <div className="kpi-sub">{kpis?.entregados || 0} entregados · {kpis?.devueltos || 0} devueltos</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Truck size={11} />Tasa entrega</div>
          <div className={`kpi-value ${(kpis?.tasaEntrega || 0) > 60 ? 'green' : (kpis?.tasaEntrega || 0) > 40 ? 'yellow' : 'red'}`}>
            {formatPct(kpis?.tasaEntrega || 0)}
          </div>
          <div className="kpi-sub" style={{ color: (kpis?.pendientesCount || 0) > 0 ? 'var(--yellow)' : undefined }}>
            {kpis?.pendientesCount || 0} pendientes
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
                lo cobra PaP y te lo rinde
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
        <Suspense fallback={<ChartFallback />}>
          <ChartUltimos7 chartData={chartData} />
        </Suspense>
      </div>

      {/* Evolución 6 meses (tendencia de mediano plazo) */}
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
      {topProductos.length > 0 && (
        <div className="card card-sm">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Top productos — este mes</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {topProductos.map((p, i) => {
              const maxIngresos = topProductos[0]?.ingresos || 1
              const pct = (p.ingresos / maxIngresos) * 100
              return (
                <div key={i}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{p.nombre}</span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{p.ventas} uds · {formatGs(p.ingresos)}</span>
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
        {ventasRecientes.length === 0 ? (
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

      {showSaldoModal && <SaldoModal onClose={() => setShowSaldoModal(false)} onSaved={cargarDatos} />}
    </div>
  )
}
