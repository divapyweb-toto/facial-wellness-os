// src/pages/despacho/DespachoPagina.jsx
import { useState, useRef, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { Document, Packer, Paragraph, TextRun, AlignmentType, PageBreak, convertMillimetersToTwip } from 'docx'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Upload, FileSpreadsheet, FileText, ShoppingBag, CheckCircle, X, Download, Eye, Search, AlertTriangle, Package, MapPin, TrendingUp } from 'lucide-react'

// ═══════════════════════════════════════════════════════════
// PARSER CSV ROBUSTO — maneja \r\n, comillas RFC 4180 y saltos
// de línea dentro de celdas (Note Attributes de Releasit COD)
// ═══════════════════════════════════════════════════════════
function parseCSVRobust(text) {
  const input = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i], n = input[i + 1]
    if (q) {
      if (c === '"' && n === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else {
      if (c === '"') q = true
      else if (c === ',') { row.push(cell); cell = '' }
      else if (c === '\n') { row.push(cell); cell = ''; if (row.some(x => x.trim())) rows.push(row); row = [] }
      else cell += c
    }
  }
  if (cell || row.length) { row.push(cell); if (row.some(x => x.trim())) rows.push(row) }
  if (rows.length < 2) return []
  const headers = rows[0].map(h => h.trim())
  return rows.slice(1).map(vals => {
    const o = {}
    headers.forEach((h, i) => { o[h] = (vals[i] || '').trim() })
    return o
  }).filter(o => o['Name'] && o['Name'].startsWith('#'))
}

// ─── Extraer un dato del campo Note Attributes ───────────
function extraerNota(notas, clave) {
  if (!notas) return ''
  for (const linea of notas.split('\n')) {
    const l = linea.trim()
    if (l.toLowerCase().includes(clave.toLowerCase())) {
      const i = l.indexOf(':')
      if (i >= 0) return l.slice(i + 1).trim()
    }
  }
  return ''
}

function limpiarTel(tel) {
  if (!tel) return ''
  let t = String(tel).replace(/[\s\-()]/g, '')
  if (t.startsWith('+5950')) t = '0' + t.slice(5)
  else if (t.startsWith('+595')) t = '0' + t.slice(4)
  else if (t.startsWith('5950')) t = '0' + t.slice(4)
  else if (t.startsWith('595')) t = '0' + t.slice(3)
  if (t && !t.startsWith('0')) t = '0' + t
  return t
}

// ─── Clasificar estado Releasit ──────────────────────────
function clasificarEstado(tags, cancelledAt) {
  const t = (tags || '').toLowerCase()
  if (t.includes('cancelado') || cancelledAt) return 'cancelado'
  if (t.includes('confirmado')) return 'confirmado'
  if (t.includes('ayuda') || t.includes('help')) return 'ayuda'
  if (t.includes('confirmation pending') || t.includes('pending')) return 'pending'
  return 'pending'
}

const ESTADO_CONFIG = {
  confirmado: { label: '✅ Confirmado', color: 'var(--green)', despachar: true },
  ayuda:      { label: '💬 Ayuda',      color: 'var(--purple)', despachar: true },
  pending:    { label: '⚠ Pendiente',   color: 'var(--yellow)', despachar: false },
  cancelado:  { label: '❌ Cancelado',  color: 'var(--red)',    despachar: false },
}

function getTipo(nombre) {
  const n = (nombre || '').toLowerCase()
  if (n.includes('gudair') || (n.includes('tira') && n.includes('parche'))) return 'Pack Gudair'
  if (n.includes('tira') || n.includes('nasal')) return 'Tiras nasales'
  if (n.includes('raspador') || n.includes('lengua') || n.includes('limpiador')) return 'Raspador de lengua'
  if (n.includes('parche') || n.includes('bucal')) return 'Parche Bucal'
  if (n.includes('jaw') || n.includes('mandíbula') || n.includes('ejercitador')) return 'JawFlex Pro'
  if (n.includes('botella') || n.includes('flexible')) return 'Botella Flexible'
  if (n.includes('bebird')) return 'Bebird Pro'
  return nombre || 'Producto'
}

function getDesc(nombre, cantidad) {
  const n = (nombre || '').toLowerCase()
  const u = parseInt(cantidad) || 1
  if (n.includes('gudair') || (n.includes('tira') && n.includes('parche'))) return `Pack Gudair (${u} unidad${u > 1 ? 'es' : ''})`
  if (n.includes('tira') || n.includes('nasal')) return 'Tiras nasales (30 unidades)'
  if (n.includes('raspador') || n.includes('lengua') || n.includes('limpiador')) return 'Limpiador de Lengua Facial Wellness'
  if (n.includes('parche') || n.includes('bucal')) return 'Parches bucales (30 unidades)'
  if (n.includes('jaw') || n.includes('mandíbula') || n.includes('ejercitador')) return `Ejercitadores de Mandíbula - Pack ${u}x JawFlex Pro`
  if (n.includes('botella') || n.includes('flexible')) return u > 1 ? `Botella Flexible Flow 500 x${u}` : 'Botella Flexible Flow 500 Negro'
  if (n.includes('bebird')) return 'Bebird Pro - Limpiador de Oídos'
  return `${nombre} (${u} unidad${u > 1 ? 'es' : ''})`
}

// ─── Mapear una fila del CSV a un pedido limpio ──────────
function mapearPedido(row) {
  const notas = row['Note Attributes'] || ''
  const estado = clasificarEstado(row['Tags'], row['Cancelled at'])
  const cfg = ESTADO_CONFIG[estado]
  const fecha = (row['Created at'] || '').split(' ')[0] || new Date().toISOString().split('T')[0]
  const ref = (row['Name'] || '').replace('#', '').trim()
  const nombre = (extraerNota(notas, 'Nombre y apellido') || row['Billing Name'] || row['Shipping Name'] || '').replace(/\s*-\s*$/, '').trim()
  const ciudad = extraerNota(notas, 'ciudad') || (row['Shipping City'] !== '-' ? row['Shipping City'] : '') || ''
  const departamento = extraerNota(notas, 'departamento') || ''
  const dir = extraerNota(notas, 'Dirección principal') || (row['Shipping Address1'] !== '-' ? row['Shipping Address1'] : '') || ''
  const refDir = extraerNota(notas, 'Referencia') || ''
  const direccion = dir ? (refDir ? `${dir} (${refDir})` : dir) : refDir
  const telefono = limpiarTel(extraerNota(notas, 'Teléfono') || extraerNota(notas, 'whatsapp') || row['Phone'] || row['Billing Phone'] || '')
  const producto_nombre = row['Lineitem name'] || ''
  const cantidad = parseInt(row['Lineitem quantity']) || 1
  const total = parseInt((row['Total'] || '0').replace(/[^0-9]/g, '')) || 0
  const faltantes = []
  if (cfg.despachar) {
    if (!nombre) faltantes.push('nombre')
    if (!telefono) faltantes.push('teléfono')
    if (!direccion) faltantes.push('dirección')
  }
  return { n_referencia: ref, cliente_nombre: nombre, ciudad, departamento, direccion, telefono, producto_nombre, cantidad, total, fecha, estado_releasit: estado, cfg, despachar: cfg.despachar, faltantes }
}

// ─── Generar y descargar Cabecera XLSX (formato Punto a Punto AC) ─
function descargarCabeceraXLSX(pedidos) {
  const headers = ['NOMBRE','CIUDAD','DIRECCIÓN','TELÉFONO','TIPO DE PRODUCTO','CANTIDAD DE BULTOS','PRIORIDAD','FORMA DE PAGO','IMPORTE','N° REFERENCIA','DESCRIPCION']
  const aoa = [headers]
  pedidos.forEach(p => {
    const refNum = parseInt(p.n_referencia)
    aoa.push([
      p.cliente_nombre, p.ciudad, p.direccion, p.telefono,
      getTipo(p.producto_nombre),
      1,                          // CANTIDAD DE BULTOS = siempre 1
      null,                       // PRIORIDAD = vacío
      'efectivo a cobrar',
      p.total,                    // IMPORTE como número
      isNaN(refNum) ? p.n_referencia : refNum,
      getDesc(p.producto_nombre, p.cantidad),
    ])
  })
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{wch:28},{wch:15},{wch:40},{wch:15},{wch:20},{wch:15},{wch:12},{wch:18},{wch:12},{wch:12},{wch:35}]
  // Teléfono como texto (mantiene el 0 inicial)
  pedidos.forEach((p, i) => {
    const cell = 'D' + (i + 2)
    if (ws[cell]) { ws[cell].t = 's'; ws[cell].z = '@' }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Entregas')
  const refs = pedidos.map(p => p.n_referencia).filter(Boolean)
  XLSX.writeFile(wb, `Cabecera_${refs[0]}-${refs[refs.length-1]}.xlsx`)
}

// ─── Generar y descargar Guías DOCX 15×10cm ──────────────
async function descargarGuiasDOCX(pedidos) {
  const P = (text, size, bold = false) => new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, bold, size: size * 2 })],
    spacing: { after: 40 },
  })
  const VACIO = () => new Paragraph({ children: [new TextRun({ text: '' })] })

  const children = []
  pedidos.forEach((p, i) => {
    children.push(
      P('FACIAL WELLNESS', 18, true),
      P('CIUDAD DEL ESTE', 14),
      P('CI: 6.103.233', 14),
      P('NRO: 0985-914-500', 14),
      VACIO(),
      P('DATOS DEL DESTINATARIO', 14, true),
      VACIO(),
      P(`Nombre: ${p.cliente_nombre || '—'}`, 12),
      P(`Ciudad: ${p.ciudad || '—'}`, 12),
      P(`Dirección: ${p.direccion || '—'}`, 12),
      P(`Teléfono: ${p.telefono || '—'}`, 12),
      P(`Producto: ${getTipo(p.producto_nombre)} ×${p.cantidad || 1}`, 12),
    )
    if (i < pedidos.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }))
  })

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: convertMillimetersToTwip(100), height: convertMillimetersToTwip(150) },
          margin: {
            top: convertMillimetersToTwip(3), bottom: convertMillimetersToTwip(3),
            left: convertMillimetersToTwip(3), right: convertMillimetersToTwip(3),
          },
        },
      },
      children,
    }],
  })

  const blob = await Packer.toBlob(doc)
  const refs = pedidos.map(p => p.n_referencia).filter(Boolean)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `Guias_${refs[0]}-${refs[refs.length-1]}.docx`; a.click()
  URL.revokeObjectURL(url)
}

// ═══════════════════════════════════════════════════════════
// COMPONENTE
// ═══════════════════════════════════════════════════════════
export default function DespachoPagina() {
  const { toast } = useToast()
  const fileRef = useRef()
  const [todos, setTodos] = useState([])
  const [cargando, setCargando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [step, setStep] = useState('upload')
  const [busqueda, setBusqueda] = useState('')
  const [nombreArchivo, setNombreArchivo] = useState('')

  const paraDespacho = useMemo(() => todos.filter(p => p.despachar), [todos])
  const excluidos = useMemo(() => todos.filter(p => !p.despachar), [todos])

  const stats = useMemo(() => ({
    confirmados: todos.filter(p => p.estado_releasit === 'confirmado').length,
    ayuda: todos.filter(p => p.estado_releasit === 'ayuda').length,
    pending: todos.filter(p => p.estado_releasit === 'pending').length,
    cancelados: todos.filter(p => p.estado_releasit === 'cancelado').length,
    total: todos.length,
    valorDespacho: paraDespacho.reduce((s, p) => s + p.total, 0),
    ticketProm: paraDespacho.length ? Math.round(paraDespacho.reduce((s, p) => s + p.total, 0) / paraDespacho.length) : 0,
  }), [todos, paraDespacho])

  // Desglose por producto (para preparar bultos)
  const porProducto = useMemo(() => {
    const m = {}
    paraDespacho.forEach(p => { const t = getTipo(p.producto_nombre); m[t] = (m[t] || 0) + p.cantidad })
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [paraDespacho])

  // Desglose por ciudad
  const porCiudad = useMemo(() => {
    const m = {}
    paraDespacho.forEach(p => { const c = p.ciudad || 'Sin ciudad'; m[c] = (m[c] || 0) + 1 })
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [paraDespacho])

  // Pedidos a despachar con datos faltantes
  const conFaltantes = useMemo(() => paraDespacho.filter(p => p.faltantes.length > 0), [paraDespacho])

  // Tabla filtrada por búsqueda
  const tablaFiltrada = useMemo(() => {
    if (!busqueda.trim()) return todos
    const q = busqueda.toLowerCase()
    return todos.filter(p =>
      p.cliente_nombre.toLowerCase().includes(q) ||
      p.ciudad.toLowerCase().includes(q) ||
      p.n_referencia.includes(q) ||
      p.telefono.includes(q) ||
      getTipo(p.producto_nombre).toLowerCase().includes(q)
    )
  }, [todos, busqueda])

  const handleFile = (file) => {
    if (!file?.name.endsWith('.csv')) { toast('Solo archivos .csv', 'error'); return }
    setNombreArchivo(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      const rows = parseCSVRobust(e.target.result)
      const mapped = rows.map(mapearPedido).filter(p => p.producto_nombre)
      if (!mapped.length) { toast('No se encontraron pedidos válidos en el CSV', 'error'); return }
      setTodos(mapped)
      setStep('preview')
      setResultado(null)
      setBusqueda('')
      toast(`${mapped.length} pedidos procesados`, 'success')
    }
    reader.readAsText(file)
  }

  const cargarVentas = async () => {
    if (!paraDespacho.length) return
    setCargando(true)
    let ok = 0, fail = 0

    // 1) Guardar histórico Releasit completo (los 4 estados) para Analytics.
    //    Upsert por n_referencia → no duplica aunque cargues el mismo CSV 2 veces.
    //    Si la tabla pedidos_releasit no existe todavía, no rompe la carga de ventas.
    try {
      const histRegistros = todos
        .filter(p => p.n_referencia)
        .map(p => ({
          n_referencia: p.n_referencia,
          fecha: p.fecha,
          mes: (p.fecha || '').slice(0, 7),
          estado_releasit: p.estado_releasit,
          total: p.total,
          producto: getTipo(p.producto_nombre),
          ciudad: p.ciudad,
        }))
      const { error: errHist } = await supabase
        .from('pedidos_releasit')
        .upsert(histRegistros, { onConflict: 'n_referencia' })
      if (errHist) console.warn('Histórico Releasit no guardado:', errHist.message)
    } catch (e) {
      console.warn('Histórico Releasit no guardado:', e?.message)
    }

    // 2) Cargar ventas (solo confirmados + ayuda)
    const ventas = paraDespacho.map(p => ({
      fecha: p.fecha,
      producto_nombre: p.producto_nombre,
      cantidad: p.cantidad,
      precio_unit: p.total,
      total: p.total,
      n_referencia: p.n_referencia,
      estado: 'pendiente',
      canal_origen: 'Shopify Orgánico',
      ciudad: p.ciudad,
      cliente_nombre: p.cliente_nombre,
      cliente_telefono: p.telefono,
      costo_prod: 0,
      costo_envio: 27000,
      envio_cliente: 0,
      metodo_envio_nombre: 'Punto a Punto AC',
      metodo_pago_nombre: 'Efectivo COD',
      estado_releasit: p.estado_releasit,
    }))
    for (let i = 0; i < ventas.length; i += 50) {
      const { error } = await supabase.from('ventas').insert(ventas.slice(i, i + 50))
      if (error) fail += Math.min(50, ventas.length - i)
      else ok += Math.min(50, ventas.length - i)
    }
    setResultado({ ok, fail })
    setCargando(false)
    if (ok > 0) toast(`${ok} ventas cargadas`, 'success')
    if (fail > 0) toast(`${fail} fallaron`, 'error')
  }

  const descargarExcel = () => {
    if (!paraDespacho.length) return
    descargarCabeceraXLSX(paraDespacho)
    toast('Cabecera Excel (.xlsx) descargada', 'success')
  }

  const descargarGuiasDoc = async () => {
    if (!paraDespacho.length) return
    try {
      await descargarGuiasDOCX(paraDespacho)
      toast('Guías Word (.docx) descargadas', 'success')
    } catch (e) {
      toast('Error generando las guías: ' + e.message, 'error')
    }
  }

  const reset = () => { setTodos([]); setResultado(null); setStep('upload'); setBusqueda(''); setNombreArchivo('') }

  // ── UPLOAD ──────────────────────────────────────────────
  if (step === 'upload') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Despacho</h1>
          <p className="page-subtitle">CSV de Shopify → carga ventas + cabecera Excel + guías 15×10cm</p>
        </div>
      </div>
      <div className="card">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>¿Cómo exportar desde Shopify?</div>
        {['Shopify → Pedidos','Seleccioná los pedidos a despachar','Exportar → "Archivo CSV sin formato"','Subí ese archivo acá'].map((p,i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i+1}</div>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{p}</span>
          </div>
        ))}
      </div>
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }}
        style={{ border: '2px dashed var(--border)', borderRadius: 14, padding: '60px 20px', textAlign: 'center', cursor: 'pointer', background: 'var(--bg-card)', transition: 'all 0.2s' }}
        onMouseEnter={e => { e.currentTarget.style.borderColor='var(--accent)'; e.currentTarget.style.background='var(--accent-dim)' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor='var(--border)'; e.currentTarget.style.background='var(--bg-card)' }}
      >
        <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
        <Upload size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Arrastrá el CSV de Shopify acá</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>o hacé clic para seleccionar</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        {[
          { icon: ShoppingBag, color: 'var(--purple)', bg: 'var(--purple-dim)', title: '1. Carga ventas', desc: 'Solo confirmados y ayuda — como pendiente' },
          { icon: FileSpreadsheet, color: 'var(--green)', bg: 'var(--green-dim)', title: '2. Cabecera Excel', desc: 'Solo los que se despachan — formato Punto a Punto AC' },
          { icon: FileText, color: 'var(--accent)', bg: 'var(--accent-dim)', title: '3. Guías Word', desc: 'Solo los que se despachan — Word 15×10cm para imprimir' },
        ].map((item, i) => (
          <div key={i} className="card card-sm" style={{ textAlign: 'center' }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: item.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
              <item.icon size={20} color={item.color} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{item.title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.desc}</div>
          </div>
        ))}
      </div>
    </div>
  )

  // ── PREVIEW ─────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Despacho</h1>
          <p className="page-subtitle">{nombreArchivo} · {todos.length} pedidos procesados</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reset}><X size={13} /> Cargar otro CSV</button>
      </div>

      {/* Alerta de datos faltantes */}
      {conFaltantes.length > 0 && (
        <div className="alert alert-warning">
          <AlertTriangle size={15} />
          <div>
            <div style={{ fontWeight: 600 }}>{conFaltantes.length} pedido(s) a despachar con datos faltantes</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {conFaltantes.map(p => `#${p.n_referencia} (falta ${p.faltantes.join(', ')})`).join(' · ')}
            </div>
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text-muted)' }}>Revisá estos antes de generar las guías o el Excel.</div>
          </div>
        </div>
      )}

      {/* KPIs principales */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">📦 Para despachar</div>
          <div className="kpi-value accent">{paraDespacho.length}</div>
          <div className="kpi-sub">Confirmados + Ayuda</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">💰 Valor a cobrar</div>
          <div className="kpi-value green">{formatGs(stats.valorDespacho)}</div>
          <div className="kpi-sub">Total COD a despachar</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">🎯 Ticket promedio</div>
          <div className="kpi-value">{formatGs(stats.ticketProm)}</div>
          <div className="kpi-sub">Por pedido</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">📊 Tasa confirmación</div>
          <div className="kpi-value accent">{stats.total ? Math.round((stats.confirmados + stats.ayuda) / stats.total * 100) : 0}%</div>
          <div className="kpi-sub">{stats.confirmados + stats.ayuda} de {stats.total}</div>
        </div>
      </div>

      {/* Barra de estados */}
      {stats.total > 0 && (
        <div className="card card-sm">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Distribución de estados</span>
          </div>
          <div style={{ height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
            <div style={{ width: `${stats.confirmados / stats.total * 100}%`, background: 'var(--green)', transition: 'width 0.5s' }} />
            <div style={{ width: `${stats.ayuda / stats.total * 100}%`, background: 'var(--purple)', transition: 'width 0.5s' }} />
            <div style={{ width: `${stats.pending / stats.total * 100}%`, background: 'var(--yellow)', transition: 'width 0.5s' }} />
            <div style={{ width: `${stats.cancelados / stats.total * 100}%`, background: 'var(--red)', transition: 'width 0.5s' }} />
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, flexWrap: 'wrap' }}>
            {[
              { color: 'var(--green)', label: `Confirmados ${stats.confirmados}` },
              { color: 'var(--purple)', label: `Ayuda ${stats.ayuda}` },
              { color: 'var(--yellow)', label: `Pendiente ${stats.pending}` },
              { color: 'var(--red)', label: `Cancelados ${stats.cancelados}` },
            ].map((l, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.color, flexShrink: 0 }} />
                <span style={{ color: 'var(--text-secondary)' }}>{l.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Desglose producto + ciudad */}
      {paraDespacho.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="card card-sm">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
              <Package size={15} color="var(--accent)" /> Bultos a preparar
            </div>
            {porProducto.map(([prod, cant], i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < porProducto.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{prod}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--accent)', fontFamily: 'var(--font-display)' }}>{cant} u</span>
              </div>
            ))}
          </div>
          <div className="card card-sm">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
              <MapPin size={15} color="var(--green)" /> Por ciudad
            </div>
            {porCiudad.slice(0, 6).map(([ciudad, cant], i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < Math.min(porCiudad.length, 6) - 1 ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{ciudad}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--font-display)' }}>{cant}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3 acciones */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <div className="card" style={{ textAlign: 'center', padding: '20px 16px' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--purple-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
            <ShoppingBag size={22} color="var(--purple)" />
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Cargar Ventas</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
            {paraDespacho.length} pedidos como pendiente (solo confirmados + ayuda)
          </div>
          {resultado ? (
            <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <CheckCircle size={14} /> {resultado.ok} cargadas {resultado.fail > 0 && <span style={{ color: 'var(--red)' }}>· {resultado.fail} fallaron</span>}
            </div>
          ) : (
            <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center' }} onClick={cargarVentas} disabled={cargando || !paraDespacho.length}>
              {cargando ? 'Cargando...' : `Cargar ${paraDespacho.length} ventas`}
            </button>
          )}
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px 16px' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--green-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
            <FileSpreadsheet size={22} color="var(--green)" />
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Cabecera Excel</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
            {paraDespacho.length} filas — formato exacto Punto a Punto AC
          </div>
          <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center' }} onClick={descargarExcel} disabled={!paraDespacho.length}>
            <Download size={13} /> Descargar Excel
          </button>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px 16px' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
            <FileText size={22} color="var(--accent)" />
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Guías Word</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
            {paraDespacho.length} guías 15×10cm en Word — abrí e imprimí
          </div>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={descargarGuiasDoc} disabled={!paraDespacho.length}>
            <Download size={13} /> Descargar Guías
          </button>
        </div>
      </div>

      {/* Tabla con búsqueda */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Eye size={14} color="var(--text-muted)" />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Todos los pedidos</span>
          <div style={{ position: 'relative', marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            <Search size={13} color="var(--text-muted)" style={{ position: 'absolute', left: 9 }} />
            <input
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              placeholder="Buscar nombre, ciudad, ref..."
              style={{ padding: '6px 10px 6px 28px', fontSize: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', width: 200 }}
            />
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {paraDespacho.length} se despachan · {excluidos.length} excluidos
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Ref.</th>
                <th>Fecha</th>
                <th>Nombre</th>
                <th>Ciudad</th>
                <th>Teléfono</th>
                <th>Producto</th>
                <th>Cant.</th>
                <th>Total</th>
                <th>Estado</th>
                <th>Despacho</th>
              </tr>
            </thead>
            <tbody>
              {tablaFiltrada.map((p, i) => (
                <tr key={i} style={{ opacity: p.despachar ? 1 : 0.45 }}>
                  <td className="mono">#{p.n_referencia}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{p.fecha}</td>
                  <td style={{ fontWeight: 500 }}>
                    {p.cliente_nombre || '—'}
                    {p.faltantes.length > 0 && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--yellow)' }} title={`Falta ${p.faltantes.join(', ')}`}>⚠</span>}
                  </td>
                  <td className="muted">{p.ciudad || '—'}</td>
                  <td className="muted">{p.telefono || '—'}</td>
                  <td style={{ fontSize: 12 }}>{getTipo(p.producto_nombre)}</td>
                  <td>{p.cantidad}</td>
                  <td style={{ fontWeight: 600 }}>{formatGs(p.total)}</td>
                  <td>
                    <span style={{ fontSize: 11, fontWeight: 600, color: p.cfg.color, whiteSpace: 'nowrap' }}>
                      {p.cfg.label}
                    </span>
                  </td>
                  <td>
                    {p.despachar
                      ? <span className="badge badge-green" style={{ fontSize: 10 }}>✓ Despachar</span>
                      : <span className="badge badge-red" style={{ fontSize: 10 }}>✗ Excluido</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
