// src/pages/entregas/EntregasPage.jsx
import { useState, useRef, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Upload, CheckCircle, X, TrendingUp, TrendingDown, Truck, PackageCheck, PackageX, Clock, MapPin, User, AlertTriangle, Search, Save, DollarSign, FileSpreadsheet } from 'lucide-react'

const COSTO_PAP = 27000

// ═══════════════════════════════════════════════════════════
// LÓGICA — combina los 2 reportes de Punto a Punto
// ═══════════════════════════════════════════════════════════
function detectarTipo(headers) {
  if (headers.includes('FechaEnt') || headers.includes('Recurso')) return 'gestion'
  if (headers.includes('Recibido Por') || headers.includes('FechaGestion')) return 'paquete'
  return 'desconocido'
}

function parseXLSX(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
  const headers = Object.keys(rows[0] || {})
  return { rows, headers, tipo: detectarTipo(headers) }
}

function normalizarRef(ref) {
  if (!ref) return ''
  return String(ref).replace(/[#\s]/g, '').trim()
}

function categorizar(estado) {
  const e = (estado || '').toLowerCase()
  if (e.includes('entregado')) return 'entregado'
  if (e.includes('devuelto') || e.includes('rechazado') || e.includes('inubicable') || e.includes('cancelado') || e.includes('no ingreso')) return 'devuelto'
  return 'en_proceso'
}

function toISODate(v) {
  if (!v) return null
  if (v instanceof Date && !isNaN(v)) return v.toISOString().split('T')[0]
  if (typeof v === 'string') {
    const m = v.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    if (m) return `${m[3]}-${m[2]}-${m[1]}`
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.split('T')[0].split(' ')[0]
  }
  return null
}

function diasEntre(a, b) {
  if (!a || !b) return null
  const da = new Date(a), db = new Date(b)
  if (isNaN(da) || isNaN(db)) return null
  const d = Math.round((db - da) / 86400000)
  return d >= 0 ? d : null
}

// Combina ambos reportes por NroGuia. Paquete tiene prioridad para el estado
// (es el cierre final); Gestión aporta el detalle (mensajero, fechas, ruta).
function combinar(paqData, gesData) {
  const pmap = new Map()
  const gmap = new Map()
  if (paqData) paqData.rows.forEach(r => pmap.set(String(r['NroGuia']), r))
  if (gesData) gesData.rows.forEach(r => gmap.set(String(r['NroGuia']), r))

  const guias = new Set([...pmap.keys(), ...gmap.keys()])
  const out = []

  guias.forEach(guia => {
    if (!guia || guia === 'undefined') return
    const p = pmap.get(guia)
    const g = gmap.get(guia)

    // Estado: prioridad PAQUETE (estado final)
    const estado = (p && p['Estado']) ? p['Estado'] : (g ? g['Estado'] : '')
    const cat = categorizar(estado)
    const importe = parseInt((p ? p['Importe'] : g['Importe']) || 0) || 0
    const ref = normalizarRef((p && p['NroGuiaRef']) ? p['NroGuiaRef'] : (g ? g['NroGuiaRef'] : ''))
    const ciudad = ((g ? g['Ciudad'] : (p ? p['Ciudad'] : '')) || '').trim()
    const mensajero = (g ? g['Recurso'] : '') || ''
    const motivo = (p ? p['Motivo'] : (g ? g['Motivo'] : '')) || ''
    const producto = (g ? (g['Descripcion'] || g['Tipodeproducto']) : (p ? p['TipoPaquete'] : '')) || ''
    const fIng = toISODate(g ? g['FechaIng'] : (p ? p['Fecha Ingreso'] : null))
    const fEnt = toISODate(g ? g['FechaEnt'] : (p ? p['FechaEvento'] : null))

    // Tesorería: ¿la plata ya te llegó? (solo si el reporte se exportó con "Incluir Tesorería")
    const estadoDepTesor = (g ? g['EstadoDepTesor'] : '') || ''
    const rendido = estadoDepTesor === 'Rendido Tesorero'
    const fRendido = toISODate(g ? g['FechaDepositoTesoreroCliente'] : null)
    const diasRendicion = (rendido && cat === 'entregado') ? diasEntre(fEnt, fRendido) : null

    out.push({
      nro_guia_pap: guia,
      n_referencia: ref,
      estado_pap: estado,
      categoria: cat,
      motivo,
      importe,
      cobrado: cat === 'entregado' ? importe : 0,
      costo_envio: COSTO_PAP,
      fecha_ingreso: fIng,
      fecha_entrega: fEnt,
      dias_entrega: cat === 'entregado' ? diasEntre(fIng, fEnt) : null,
      rendido,
      fecha_rendido: fRendido,
      dias_rendicion: diasRendicion,
      mensajero,
      ciudad,
      producto,
      mes: (fEnt || fIng || '').slice(0, 7),
    })
  })

  return out
}

const CAT_CFG = {
  entregado:  { label: 'Entregado', color: '#22c55e' },
  devuelto:   { label: 'Devuelto',  color: '#ef4444' },
  en_proceso: { label: 'En proceso', color: '#eab308' },
}

// ═══════════════════════════════════════════════════════════
// COMPONENTE
// ═══════════════════════════════════════════════════════════
export default function EntregasPage() {
  const { toast } = useToast()
  const fileRef = useRef()
  const [paqData, setPaqData] = useState(null)
  const [gesData, setGesData] = useState(null)
  const [busqueda, setBusqueda] = useState('')
  const [filtroCat, setFiltroCat] = useState('todos')
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)

  const merged = useMemo(() => {
    if (!paqData && !gesData) return []
    return combinar(paqData, gesData)
  }, [paqData, gesData])

  const stats = useMemo(() => {
    if (!merged.length) return null
    const total = merged.length
    const entregados = merged.filter(m => m.categoria === 'entregado')
    const devueltos = merged.filter(m => m.categoria === 'devuelto')
    const proceso = merged.filter(m => m.categoria === 'en_proceso')

    const cobrado = entregados.reduce((s, m) => s + m.importe, 0)
    const perdidoProd = devueltos.reduce((s, m) => s + m.importe, 0)
    const costoEnvios = COSTO_PAP * total
    const costoEnviosDevueltos = COSTO_PAP * devueltos.length
    const resueltos = entregados.length + devueltos.length

    const dias = entregados.map(m => m.dias_entrega).filter(d => d != null)
    const diasProm = dias.length ? (dias.reduce((a, b) => a + b, 0) / dias.length) : null

    // Tesorería / flujo de caja: cuánto ya te rindió PaP vs cuánto te debe
    const rendidos = entregados.filter(m => m.rendido)
    const entregadosSinRendir = entregados.filter(m => !m.rendido)
    const montoRendido = rendidos.reduce((s, m) => s + m.importe, 0)
    const montoPendienteCobro = entregadosSinRendir.reduce((s, m) => s + m.importe, 0)
    const diasRend = rendidos.map(m => m.dias_rendicion).filter(d => d != null)
    const diasRendicionProm = diasRend.length ? (diasRend.reduce((a, b) => a + b, 0) / diasRend.length) : null
    const hayTesoreria = merged.some(m => m.rendido || m.fecha_rendido)

    // por ciudad
    const ciudadMap = {}
    merged.forEach(m => {
      const c = m.ciudad || 'Sin ciudad'
      if (!ciudadMap[c]) ciudadMap[c] = { total: 0, entregados: 0 }
      ciudadMap[c].total++
      if (m.categoria === 'entregado') ciudadMap[c].entregados++
    })
    const porCiudad = Object.entries(ciudadMap)
      .filter(([, d]) => d.total >= 2)
      .map(([c, d]) => ({ ciudad: c, tasa: Math.round(d.entregados / d.total * 100), total: d.total, entregados: d.entregados }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)

    // por mensajero
    const msgMap = {}
    entregados.forEach(m => { const k = (m.mensajero || 'Sin asignar').split(' - ')[0]; msgMap[k] = (msgMap[k] || 0) + 1 })
    const porMensajero = Object.entries(msgMap).map(([m, n]) => ({ mensajero: m, entregas: n })).sort((a, b) => b.entregas - a.entregas).slice(0, 6)

    // motivos de no-entrega
    const motMap = {}
    ;[...devueltos, ...proceso].forEach(m => { const k = m.motivo || 'Sin motivo'; motMap[k] = (motMap[k] || 0) + 1 })
    const motivos = Object.entries(motMap).map(([m, n]) => ({ motivo: m, count: n })).sort((a, b) => b.count - a.count)

    const distribucion = [
      { name: 'Entregado', value: entregados.length, color: CAT_CFG.entregado.color },
      { name: 'Devuelto', value: devueltos.length, color: CAT_CFG.devuelto.color },
      { name: 'En proceso', value: proceso.length, color: CAT_CFG.en_proceso.color },
    ].filter(d => d.value > 0)

    return {
      total, entregados: entregados.length, devueltos: devueltos.length, proceso: proceso.length,
      tasaEntrega: resueltos ? Math.round(entregados.length / resueltos * 100) : 0,
      tasaTotal: Math.round(entregados.length / total * 100),
      cobrado, perdidoProd, costoEnvios, costoEnviosDevueltos,
      margenNeto: cobrado - costoEnvios,
      perdidaTotal: perdidoProd + costoEnviosDevueltos,
      diasProm, porCiudad, porMensajero, motivos, distribucion,
      montoRendido, montoPendienteCobro, diasRendicionProm, hayTesoreria,
      rendidos: rendidos.length, entregadosSinRendir: entregadosSinRendir.length,
      conRef: merged.filter(m => m.n_referencia).length,
    }
  }, [merged])

  const tablaFiltrada = useMemo(() => {
    let r = merged
    if (filtroCat !== 'todos') r = r.filter(m => m.categoria === filtroCat)
    if (busqueda.trim()) {
      const q = busqueda.toLowerCase()
      r = r.filter(m =>
        (m.n_referencia || '').includes(q) ||
        (m.ciudad || '').toLowerCase().includes(q) ||
        (m.mensajero || '').toLowerCase().includes(q) ||
        (m.estado_pap || '').toLowerCase().includes(q) ||
        (m.nro_guia_pap || '').includes(q)
      )
    }
    return r
  }, [merged, filtroCat, busqueda])

  const procesarFile = (file) => {
    if (!file?.name.match(/\.xlsx?$/i)) { toast('Solo archivos Excel (.xlsx)', 'error'); return }
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const parsed = parseXLSX(e.target.result)
        if (parsed.tipo === 'gestion') { setGesData(parsed); toast('Reporte de Gestión cargado ✓', 'success') }
        else if (parsed.tipo === 'paquete') { setPaqData(parsed); toast('Reporte de Paquetes cargado ✓', 'success') }
        else toast('No reconozco este reporte. ¿Es de Punto a Punto?', 'error')
        setGuardado(false)
      } catch (err) {
        toast('Error leyendo el archivo: ' + err.message, 'error')
      }
    }
    reader.readAsArrayBuffer(file)
  }

  const handleFiles = (files) => { Array.from(files).forEach(procesarFile) }

  const guardarEnSistema = async () => {
    if (!merged.length) return
    setGuardando(true)
    try {
      // 1) Upsert a tabla entregas (por nro_guia_pap)
      let ok = 0
      for (let i = 0; i < merged.length; i += 100) {
        const lote = merged.slice(i, i + 100)
        const { error } = await supabase.from('entregas').upsert(lote, { onConflict: 'nro_guia_pap' })
        if (!error) ok += lote.length
      }
      // 2) Actualizar estado de las ventas que matchean por referencia (no crítico)
      try {
        for (const m of merged.filter(x => x.n_referencia)) {
          await supabase.from('ventas').update({ estado: m.categoria === 'entregado' ? 'entregado' : m.categoria === 'devuelto' ? 'devuelto' : 'en_camino' }).eq('n_referencia', m.n_referencia)
        }
      } catch (e) { /* silencioso */ }

      setGuardado(true)
      toast(`${ok} entregas guardadas en el sistema`, 'success')
    } catch (err) {
      toast('Error guardando: ' + err.message, 'error')
    }
    setGuardando(false)
  }

  const reset = () => { setPaqData(null); setGesData(null); setBusqueda(''); setFiltroCat('todos'); setGuardado(false) }

  // ── UPLOAD ──────────────────────────────────────────────
  if (!stats) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Entregas · Tracking Punto a Punto</h1>
          <p className="page-subtitle">Subí los 2 reportes de PaP y mirá tu tasa de entrega y rentabilidad real</p>
        </div>
      </div>

      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>¿Cómo exportar de Punto a Punto?</div>
        {['Entrá a rastreo.puntoapunto.com.py → Reportes','Descargá el "Reporte de Gestión" (elegí el rango de fechas)','Descargá también el "Reporte de Paquetes" (mismo rango)','Subí los 2 archivos acá abajo'].map((p, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</div>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{p}</span>
          </div>
        ))}
      </div>

      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}
        style={{ border: '2px dashed var(--border)', borderRadius: 14, padding: '50px 20px', textAlign: 'center', cursor: 'pointer', background: 'var(--bg-card)', transition: 'all 0.2s' }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-dim)' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-card)' }}
      >
        <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
        <Upload size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Arrastrá los 2 reportes Excel acá</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>los detecto automáticamente · podés subirlos juntos o de a uno</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="card card-sm" style={{ display: 'flex', alignItems: 'center', gap: 12, borderColor: gesData ? 'var(--green)' : 'var(--border)' }}>
          {gesData ? <CheckCircle size={24} color="var(--green)" /> : <FileSpreadsheet size={24} color="var(--text-muted)" />}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Reporte de Gestión</div>
            <div style={{ fontSize: 11, color: gesData ? 'var(--green)' : 'var(--text-muted)' }}>{gesData ? `${gesData.rows.length} filas cargadas` : 'Pendiente'}</div>
          </div>
        </div>
        <div className="card card-sm" style={{ display: 'flex', alignItems: 'center', gap: 12, borderColor: paqData ? 'var(--green)' : 'var(--border)' }}>
          {paqData ? <CheckCircle size={24} color="var(--green)" /> : <FileSpreadsheet size={24} color="var(--text-muted)" />}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Reporte de Paquetes</div>
            <div style={{ fontSize: 11, color: paqData ? 'var(--green)' : 'var(--text-muted)' }}>{paqData ? `${paqData.rows.length} filas cargadas` : 'Pendiente'}</div>
          </div>
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
        Con un solo reporte ya ves resultados, pero con los 2 el análisis es completo.
      </p>
    </div>
  )

  // ── DASHBOARD ───────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Entregas · Tracking Punto a Punto</h1>
          <p className="page-subtitle">{stats.total} paquetes · {paqData && gesData ? 'ambos reportes' : paqData ? 'solo Paquetes' : 'solo Gestión'} · {stats.conRef} con referencia</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={guardarEnSistema} disabled={guardando || guardado}>
            {guardando ? 'Guardando...' : guardado ? <><CheckCircle size={13} /> Guardado</> : <><Save size={13} /> Guardar en sistema</>}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={reset}><X size={13} /> Otro</button>
        </div>
      </div>

      {/* Alerta si tasa de devolución alta */}
      {stats.devueltos / stats.total > 0.25 && (
        <div className="alert alert-warning">
          <AlertTriangle size={15} />
          <div>
            <div style={{ fontWeight: 600 }}>Tasa de devolución alta: {Math.round(stats.devueltos / stats.total * 100)}%</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Estás perdiendo {formatGs(stats.perdidaTotal)} entre producto devuelto y envíos pagados a pérdida. Revisá las ciudades y motivos de abajo.
            </div>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label"><PackageCheck size={13} style={{ verticalAlign: -2 }} /> Tasa de entrega</div>
          <div className="kpi-value green">{stats.tasaEntrega}%</div>
          <div className="kpi-sub">{stats.entregados} de {stats.entregados + stats.devueltos} resueltos</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><DollarSign size={13} style={{ verticalAlign: -2 }} /> Cobrado real</div>
          <div className="kpi-value">{formatGs(stats.cobrado)}</div>
          <div className="kpi-sub">Productos efectivamente entregados</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><TrendingDown size={13} style={{ verticalAlign: -2 }} /> Pérdida x devoluciones</div>
          <div className="kpi-value" style={{ color: 'var(--red)' }}>{formatGs(stats.perdidaTotal)}</div>
          <div className="kpi-sub">Producto que volvió + envíos pagados</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Clock size={13} style={{ verticalAlign: -2 }} /> En proceso</div>
          <div className="kpi-value accent">{stats.proceso}</div>
          <div className="kpi-sub">{stats.diasProm ? `${stats.diasProm.toFixed(1)} días prom. entrega` : 'Sin resolver'}</div>
        </div>
      </div>

      {/* Análisis financiero */}
      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
          <DollarSign size={15} color="var(--green)" /> Análisis financiero del despacho
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          {[
            { label: 'Cobrado bruto', val: stats.cobrado, color: 'var(--green)', sign: '+' },
            { label: `Costo envíos PaP (${stats.total} × 27k)`, val: -stats.costoEnvios, color: 'var(--red)', sign: '' },
            { label: 'Margen logístico neto', val: stats.margenNeto, color: stats.margenNeto > 0 ? 'var(--green)' : 'var(--red)', sign: '=', bold: true },
            { label: `Envíos perdidos (${stats.devueltos} devol.)`, val: -stats.costoEnviosDevueltos, color: 'var(--red)', sign: '' },
          ].map((item, i) => (
            <div key={i} style={{ padding: 12, background: 'var(--bg-hover)', borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: item.bold ? 20 : 16, fontWeight: item.bold ? 800 : 700, color: item.color, fontFamily: 'var(--font-display)' }}>
                {formatGs(item.val)}
              </div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
          El margen logístico es antes de restar el costo de tu producto (CMV). La pérdida por devoluciones ({formatGs(stats.perdidaTotal)}) es el golpe real: producto que volvió sin venderse + el envío que igual pagaste.
        </p>
      </div>

      {/* Flujo de caja con PaP (solo si el reporte incluye Tesorería) */}
      {stats.hayTesoreria && (
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Truck size={15} color="var(--accent)" /> Flujo de caja con Punto a Punto
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
            PaP cobra al cliente y la plata pasa por mensajero → supervisor → tesorero antes de llegarte.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            <div style={{ padding: 12, background: 'var(--green-dim)', borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>✅ Ya depositado a vos</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--font-display)' }}>{formatGs(stats.montoRendido)}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{stats.rendidos} pedidos rendidos</div>
            </div>
            <div style={{ padding: 12, background: 'var(--bg-hover)', borderRadius: 10, border: '1px solid var(--yellow)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>⏳ PaP te debe todavía</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--yellow)', fontFamily: 'var(--font-display)' }}>{formatGs(stats.montoPendienteCobro)}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{stats.entregadosSinRendir} entregados sin rendir</div>
            </div>
            <div style={{ padding: 12, background: 'var(--bg-hover)', borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>⏱ Tiempo de cobro</div>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'var(--font-display)' }}>{stats.diasRendicionProm ? `${stats.diasRendicionProm.toFixed(1)} días` : '—'}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>De la entrega al depósito</div>
            </div>
          </div>
        </div>
      )}

      {/* Distribución + Ciudad */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Distribución de estados</div>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={stats.distribucion} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {stats.distribucion.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Pie>
              <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap', marginTop: 4 }}>
            {stats.distribucion.map((e, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: e.color }} />
                <span style={{ color: 'var(--text-secondary)' }}>{e.name} ({e.value})</span>
              </span>
            ))}
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            <MapPin size={15} color="var(--accent)" /> Tasa de entrega por ciudad
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stats.porCiudad} layout="vertical" margin={{ left: 10, right: 30 }}>
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <YAxis type="category" dataKey="ciudad" width={90} tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} />
              <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} formatter={(v, n, p) => [`${v}% (${p.payload.entregados}/${p.payload.total})`, 'Entrega']} />
              <Bar dataKey="tasa" radius={[0, 4, 4, 0]}>
                {stats.porCiudad.map((c, i) => <Cell key={i} fill={c.tasa >= 70 ? '#22c55e' : c.tasa >= 50 ? '#eab308' : '#ef4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Mensajeros + Motivos */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="card card-sm">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <User size={15} color="var(--green)" /> Top mensajeros (entregas)
          </div>
          {stats.porMensajero.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < stats.porMensajero.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m.mensajero}</span>
              <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--font-display)' }}>{m.entregas}</span>
            </div>
          ))}
        </div>

        <div className="card card-sm">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <PackageX size={15} color="var(--red)" /> Motivos de no-entrega
          </div>
          {stats.motivos.map((m, i) => {
            const max = stats.motivos[0].count
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{m.motivo}</span>
                  <span style={{ fontWeight: 700 }}>{m.count}</span>
                </div>
                <div style={{ height: 5, background: 'var(--bg-hover)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${m.count / max * 100}%`, height: '100%', background: 'var(--red)' }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Tabla */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Detalle de paquetes</span>
          <div className="tabs" style={{ marginLeft: 0 }}>
            {[['todos', 'Todos'], ['entregado', 'Entregados'], ['devuelto', 'Devueltos'], ['en_proceso', 'En proceso']].map(([k, l]) => (
              <button key={k} className={`tab ${filtroCat === k ? 'active' : ''}`} onClick={() => setFiltroCat(k)}>{l}</button>
            ))}
          </div>
          <div style={{ position: 'relative', marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            <Search size={13} color="var(--text-muted)" style={{ position: 'absolute', left: 9 }} />
            <input value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="Buscar ref, ciudad, mensajero..." style={{ padding: '6px 10px 6px 28px', fontSize: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', width: 220 }} />
          </div>
        </div>
        <div style={{ overflowX: 'auto', maxHeight: 480 }}>
          <table>
            <thead>
              <tr>
                <th>Ref.</th><th>Guía PaP</th><th>Estado</th><th>Ciudad</th><th>Mensajero</th><th>Producto</th><th>Importe</th><th>Cobrado</th><th>Entrega</th>
              </tr>
            </thead>
            <tbody>
              {tablaFiltrada.map((m, i) => (
                <tr key={i}>
                  <td className="mono">{m.n_referencia ? `#${m.n_referencia}` : '—'}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{m.nro_guia_pap}</td>
                  <td><span style={{ fontSize: 11, fontWeight: 600, color: CAT_CFG[m.categoria].color, whiteSpace: 'nowrap' }}>{m.estado_pap}</span></td>
                  <td className="muted">{m.ciudad || '—'}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{(m.mensajero || '—').split(' - ')[0]}</td>
                  <td style={{ fontSize: 11 }}>{(m.producto || '—').slice(0, 28)}</td>
                  <td style={{ fontWeight: 600 }}>{formatGs(m.importe)}</td>
                  <td style={{ fontWeight: 600, color: m.cobrado > 0 ? 'var(--green)' : 'var(--text-muted)' }}>{m.cobrado > 0 ? formatGs(m.cobrado) : '—'}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{m.fecha_entrega || '—'}{m.dias_entrega != null ? ` (${m.dias_entrega}d)` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
