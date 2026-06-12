// src/pages/despacho/DespachoPagina.jsx
import { useState, useRef } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Upload, FileSpreadsheet, FileText, ShoppingBag, CheckCircle, X, Download, Eye } from 'lucide-react'

// ─── Clasificar estado Releasit ──────────────────────────
function clasificarEstado(tags, cancelledAt) {
  const t = tags || ''
  if (t.includes('CANCELADO') || cancelledAt) return 'cancelado'
  if (t.includes('CONFIRMADO')) return 'confirmado'
  if (t.includes('AYUDA') || t.includes('HELP')) return 'ayuda'
  if (t.includes('Confirmation Pending') || t.includes('Pending')) return 'pending'
  return 'pending'
}

const ESTADO_CONFIG = {
  confirmado: { label: '✅ Confirmado', color: 'var(--green)', despachar: true },
  ayuda:      { label: '💬 Ayuda',      color: 'var(--purple)', despachar: true },
  pending:    { label: '⚠ Pendiente',   color: 'var(--yellow)', despachar: false },
  cancelado:  { label: '❌ Cancelado',  color: 'var(--red)',    despachar: false },
}

// ─── Helpers ─────────────────────────────────────────────
function extraerNota(notas, clave) {
  if (!notas) return ''
  for (const linea of notas.split('\n')) {
    if (linea.toLowerCase().includes(clave.toLowerCase())) {
      const partes = linea.split(':')
      if (partes.length >= 2) return partes.slice(1).join(':').trim()
    }
  }
  return ''
}

function limpiarTel(tel) {
  if (!tel) return ''
  let t = tel.replace(/\s+/g, '')
  if (t.startsWith('+5950')) return '0' + t.slice(5)
  if (t.startsWith('+595')) return '0' + t.slice(4)
  if (t.startsWith('595')) return '0' + t.slice(3)
  return t
}

function getTipo(nombre) {
  const n = (nombre || '').toLowerCase()
  if (n.includes('tira') || n.includes('nasal')) return 'Tiras nasales'
  if (n.includes('raspador') || n.includes('lengua') || n.includes('limpiador')) return 'Raspador de lengua'
  if (n.includes('parche') || n.includes('bucal')) return 'Parche Bucal'
  if (n.includes('jaw') || n.includes('mandíbula') || n.includes('ejercitador')) return 'JawFlex Pro'
  if (n.includes('botella') || n.includes('flexible')) return 'Botella Flexible'
  if (n.includes('gudair') || (n.includes('tira') && n.includes('parche'))) return 'Pack Gudair'
  if (n.includes('bebird')) return 'Bebird Pro'
  return nombre || 'Producto'
}

function getDesc(nombre, cantidad) {
  const n = (nombre || '').toLowerCase()
  const u = parseInt(cantidad) || 1
  if (n.includes('tira') || n.includes('nasal')) return 'Tiras nasales (30 unidades)'
  if (n.includes('raspador') || n.includes('lengua') || n.includes('limpiador')) return 'Limpiador de Lengua Facial Wellness'
  if (n.includes('parche') || n.includes('bucal')) return 'Parches bucales (30 unidades)'
  if (n.includes('jaw') || n.includes('mandíbula') || n.includes('ejercitador')) return `Ejercitadores de Mandíbula - Pack ${u}x JawFlex Pro`
  if (n.includes('botella') || n.includes('flexible')) return u > 1 ? `Botella Flexible Flow 500 x${u}` : 'Botella Flexible Flow 500 Negro'
  if (n.includes('gudair') || (n.includes('tira') && n.includes('parche'))) return `Pack Gudair (${u} unidad${u > 1 ? 'es' : ''})`
  if (n.includes('bebird')) return 'Bebird Pro - Limpiador de Oídos'
  return `${nombre} (${u} unidad${u > 1 ? 'es' : ''})`
}

// ─── Parser CSV robusto (maneja saltos de línea dentro de celdas) ──
function parseCSVRobust(text) {
  const rows = []
  let row = [], cell = '', inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '"') {
      if (inQuotes && next === '"') { cell += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      row.push(cell); cell = ''
    } else if (ch === '\n' && !inQuotes) {
      row.push(cell); cell = ''
      if (row.some(c => c.trim())) rows.push(row)
      row = []
    } else if (ch === '\n') {
      cell += ch  // ← \n dentro de campo entre comillas (Note Attributes multilínea)
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some(c => c.trim())) rows.push(row)

  if (rows.length < 2) return []
  const headers = rows[0].map(h => h.trim())
  return rows.slice(1)
    .map(vals => {
      const obj = {}
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim() })
      return obj
    })
    .filter(obj => obj['Name'] && obj['Name'].startsWith('#'))
}

function mapearPedido(row) {
  const notas = row['Note Attributes'] || ''
  const tags = row['Tags'] || ''
  const cancelledAt = row['Cancelled at'] || ''
  const estado = clasificarEstado(tags, cancelledAt)
  const cfg = ESTADO_CONFIG[estado]

  const fecha = (row['Created at'] || '').split(' ')[0] || new Date().toISOString().split('T')[0]
  const ref = (row['Name'] || '').replace('#', '').trim()
  const nombre = (row['Billing Name'] || row['Shipping Name'] || '').replace(/\s*-\s*$/, '').trim()

  const ciudadNota = extraerNota(notas, 'ciudad')
  const ciudad = ciudadNota || row['Shipping City'] || ''

  const dirPrincipal = extraerNota(notas, 'Dirección principal')
  const referencia = extraerNota(notas, 'Referencia')
  const direccion = dirPrincipal ? (referencia ? `${dirPrincipal}, ${referencia}` : dirPrincipal) : (row['Shipping Address1'] || '')

  const telNota = extraerNota(notas, 'Teléfono') || extraerNota(notas, 'Telefono')
  const telefono = limpiarTel(telNota || row['Billing Phone'] || row['Shipping Phone'] || '')

  const productoNombre = row['Lineitem name'] || ''
  const cantidad = parseInt(row['Lineitem quantity']) || 1
  const total = parseInt(row['Total']) || 0

  return {
    n_referencia: ref,
    cliente_nombre: nombre,
    ciudad,
    direccion,
    telefono,
    producto_nombre: productoNombre,
    cantidad,
    total,
    fecha,
    estado_releasit: estado,
    cfg,
    despachar: cfg.despachar,
  }
}

// ─── Generar Excel CSV ────────────────────────────────────
function generarExcel(pedidos) {
  const headers = ['NOMBRE','CIUDAD','DIRECCIÓN','TELÉFONO','TIPO DE PRODUCTO','CANTIDAD DE BULTOS','PRIORIDAD','FORMA DE PAGO','IMPORTE','N° REFERENCIA','DESCRIPCION']
  const filas = pedidos.map(p => [
    p.cliente_nombre, p.ciudad, p.direccion, p.telefono,
    getTipo(p.producto_nombre), '1', '', 'efectivo a cobrar',
    p.total, p.n_referencia, getDesc(p.producto_nombre, p.cantidad)
  ])
  const csv = [headers, ...filas].map(f => f.map(c => `"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n')
  return '\ufeff' + csv
}

// ─── Generar Guías HTML ───────────────────────────────────
function generarGuias(pedidos) {
  const guias = pedidos.map(p => `
<div class="guia">
  <div class="remitente">
    <div class="titulo">FACIAL WELLNESS</div>
    <div class="sub">CIUDAD DEL ESTE</div>
    <div class="sub">CI: 6.103.233 &nbsp;|&nbsp; NRO: 0985-914-500</div>
  </div>
  <div class="linea"></div>
  <div class="titulo-dest">DATOS DEL DESTINATARIO</div>
  <div class="linea"></div>
  <div class="datos">
    <div class="dato"><b>Nombre:</b> ${p.cliente_nombre||'—'}</div>
    <div class="dato"><b>Ciudad:</b> ${p.ciudad||'—'}</div>
    <div class="dato"><b>Dirección:</b> ${p.direccion||'—'}</div>
    <div class="dato"><b>Teléfono:</b> ${p.telefono||'—'}</div>
    <div class="dato prod"><b>Producto:</b> ${getTipo(p.producto_nombre)} ×${p.cantidad||1}</div>
  </div>
</div>`).join('\n')

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Guías Facial Wellness</title>
<style>
  @page{size:10cm 15cm;margin:0}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;background:white}
  .guia{width:10cm;height:15cm;padding:.4cm;text-align:center;page-break-after:always;display:flex;flex-direction:column;justify-content:center;align-items:center;border:1.5px solid #000}
  .titulo{font-size:22pt;font-weight:bold;letter-spacing:1px}
  .sub{font-size:10pt;margin-top:.1cm}
  .linea{border-top:2px solid #000;width:100%;margin:.3cm 0}
  .titulo-dest{font-size:12pt;font-weight:bold}
  .datos{width:100%;text-align:left;margin-top:.2cm}
  .dato{font-size:11pt;margin:.2cm 0;line-height:1.3}
  .prod{font-size:12pt;font-weight:bold;margin-top:.35cm}
</style></head><body>${guias}</body></html>`
}

// ─── Componente ──────────────────────────────────────────
export default function DespachoPagina() {
  const { toast } = useToast()
  const fileRef = useRef()
  const [todos, setTodos] = useState([]) // todos los pedidos del CSV
  const [cargando, setCargando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [step, setStep] = useState('upload')

  const paraDespacho = todos.filter(p => p.despachar)
  const excluidos = todos.filter(p => !p.despachar)

  // Stats
  const stats = {
    confirmados: todos.filter(p => p.estado_releasit === 'confirmado').length,
    ayuda: todos.filter(p => p.estado_releasit === 'ayuda').length,
    pending: todos.filter(p => p.estado_releasit === 'pending').length,
    cancelados: todos.filter(p => p.estado_releasit === 'cancelado').length,
    total: todos.length,
  }

  const handleFile = (file) => {
    if (!file?.name.endsWith('.csv')) { toast('Solo archivos .csv', 'error'); return }
    const reader = new FileReader()
    reader.onload = (e) => {
      const rows = parseCSVRobust(e.target.result)
      const mapped = rows.map(mapearPedido).filter(p => p.producto_nombre)
      if (!mapped.length) { toast('No se encontraron pedidos válidos', 'error'); return }
      setTodos(mapped)
      setStep('preview')
      setResultado(null)
    }
    reader.readAsText(file)
  }

  const cargarVentas = async () => {
    if (!paraDespacho.length) return
    setCargando(true)
    let ok = 0, fail = 0
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
    const refs = paraDespacho.map(p => p.n_referencia).filter(Boolean)
    const blob = new Blob([generarExcel(paraDespacho)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `Cabecera_${refs[0]}-${refs[refs.length-1]}.csv`; a.click()
    URL.revokeObjectURL(url)
    toast('Cabecera Excel descargada', 'success')
  }

  const descargarGuiasDoc = () => {
    const refs = paraDespacho.map(p => p.n_referencia).filter(Boolean)
    const blob = new Blob([generarGuias(paraDespacho)], { type: 'text/html;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `Guias_${refs[0]}-${refs[refs.length-1]}.html`; a.click()
    URL.revokeObjectURL(url)
    toast('Guías descargadas — abrí con Chrome e imprimí', 'success')
  }

  const reset = () => { setTodos([]); setResultado(null); setStep('upload') }

  // ── UPLOAD ──────────────────────────────────────────────
  if (step === 'upload') return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Despacho</h1>
          <p className="page-subtitle">CSV de Shopify → carga ventas + cabecera Excel + guías Word</p>
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
          { icon: FileText, color: 'var(--accent)', bg: 'var(--accent-dim)', title: '3. Guías Word', desc: 'Solo los que se despachan — 15×10cm para imprimir' },
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
          <p className="page-subtitle">{todos.length} pedidos procesados del CSV</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reset}><X size={13} /> Cargar otro CSV</button>
      </div>

      {/* Estadísticas */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Total en CSV</div>
          <div className="kpi-value">{stats.total}</div>
          <div className="kpi-sub">Pedidos analizados</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">✅ Confirmados</div>
          <div className="kpi-value green">{stats.confirmados}</div>
          <div className="kpi-sub">Se despachan</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">💬 Ayuda</div>
          <div className="kpi-value" style={{ color: 'var(--purple)' }}>{stats.ayuda}</div>
          <div className="kpi-sub">Se despachan</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">⚠ Pendiente</div>
          <div className="kpi-value yellow">{stats.pending}</div>
          <div className="kpi-sub">NO se despachan</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">❌ Cancelados</div>
          <div className="kpi-value red">{stats.cancelados}</div>
          <div className="kpi-sub">NO se despachan</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">📦 Para despachar</div>
          <div className="kpi-value accent">{paraDespacho.length}</div>
          <div className="kpi-sub">Confirmados + Ayuda</div>
        </div>
      </div>

      {/* Tasa de confirmación */}
      {stats.total > 0 && (
        <div className="card card-sm">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Tasa de confirmación</span>
            <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--accent)', fontFamily: 'var(--font-display)' }}>
              {Math.round((stats.confirmados + stats.ayuda) / stats.total * 100)}%
            </span>
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
            <Download size={13} /> Descargar CSV
          </button>
        </div>

        <div className="card" style={{ textAlign: 'center', padding: '20px 16px' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
            <FileText size={22} color="var(--accent)" />
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Guías Word</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
            {paraDespacho.length} guías 15×10cm — abrí en Chrome e imprimí
          </div>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={descargarGuiasDoc} disabled={!paraDespacho.length}>
            <Download size={13} /> Descargar Guías
          </button>
        </div>
      </div>

      {/* Tabla — TODOS los pedidos */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Eye size={14} color="var(--text-muted)" />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Todos los pedidos del CSV</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
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
              {todos.map((p, i) => (
                <tr key={i} style={{ opacity: p.despachar ? 1 : 0.45 }}>
                  <td className="mono">{p.n_referencia}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{p.fecha}</td>
                  <td style={{ fontWeight: 500 }}>{p.cliente_nombre || '—'}</td>
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
