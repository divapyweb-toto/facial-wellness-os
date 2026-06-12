// src/pages/despacho/DespachoPagina.jsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import {
  Truck, FileSpreadsheet, FileText, Upload, Download,
  CheckSquare, Square, Search, X, Package, RefreshCw
} from 'lucide-react'

// ─── Helpers ─────────────────────────────────────────────
function parseCSVShopify(text) {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim())
  return lines.slice(1).map(line => {
    const values = []
    let current = ''
    let inQuotes = false
    for (const char of line) {
      if (char === '"') inQuotes = !inQuotes
      else if (char === ',' && !inQuotes) { values.push(current.trim()); current = '' }
      else current += char
    }
    values.push(current.trim())
    const obj = {}
    headers.forEach((h, i) => { obj[h] = (values[i] || '').replace(/"/g, '') })
    return obj
  }).filter(row => row['Name'] || row['Lineitem name'])
}

function mapShopifyToDespacho(row) {
  const ref = (row['Name'] || '').replace('#', '')
  const producto = row['Lineitem name'] || ''
  const cantidad = parseInt(row['Lineitem quantity']) || 1
  const totalRaw = parseFloat((row['Total'] || '0').replace(/[^0-9.]/g, ''))
  const total = Math.round(totalRaw > 1000 ? totalRaw : totalRaw * 1000)
  return {
    n_referencia: ref,
    cliente_nombre: row['Billing Name'] || row['Shipping Name'] || '',
    ciudad: row['Shipping City'] || '',
    direccion: `${row['Shipping Address1'] || ''} ${row['Shipping Address2'] || ''}`.trim(),
    telefono: row['Phone'] || '',
    producto_nombre: producto,
    cantidad,
    total,
    descripcion: `${producto} (${cantidad} unidad${cantidad > 1 ? 'es' : ''})`,
  }
}

// Descripción del producto para la cabecera (igual que en tus ejemplos)
function getDescripcionProducto(nombre, cantidad) {
  const n = nombre.toLowerCase()
  const u = `(${cantidad} unidad${cantidad > 1 ? 'es' : ''})`
  if (n.includes('tiras') || n.includes('nose strips')) return `Tiras nasales ${u}`
  if (n.includes('raspador') || n.includes('tongue')) return `Limpiador de Lengua Facial Wellness`
  if (n.includes('parche') || n.includes('mouth tape')) return `Parches bucales ${u}`
  if (n.includes('jaw') || n.includes('jawflex')) return `Ejercitadores de Mandíbula - Pack ${cantidad}x JawFlex Pro`
  if (n.includes('botella') || n.includes('flexible')) return `Botella Flexible Flow 500 ${cantidad > 1 ? `x${cantidad}` : 'Negro'}`
  if (n.includes('gudair') || n.includes('pack')) return `Pack Gudair ${u}`
  if (n.includes('bebird')) return `Bebird Pro - Limpiador de Oídos`
  return `${nombre} ${u}`
}

function getTipoProducto(nombre) {
  const n = nombre.toLowerCase()
  if (n.includes('tiras') || n.includes('nose')) return 'Tiras nasales'
  if (n.includes('raspador') || n.includes('tongue')) return 'Raspador de lengua'
  if (n.includes('parche') || n.includes('mouth')) return 'Parche Bucal'
  if (n.includes('jaw')) return 'JawFlex Pro'
  if (n.includes('botella') || n.includes('flexible')) return 'Botella Flexible'
  if (n.includes('gudair')) return 'Pack Gudair'
  if (n.includes('bebird')) return 'Bebird Pro'
  return nombre
}

// ─── Componente principal ─────────────────────────────────
export default function DespachoPagina() {
  const { toast } = useToast()
  const fileRef = useRef()
  const [pedidos, setPedidos] = useState([]) // de la app
  const [seleccionados, setSeleccionados] = useState(new Set())
  const [csvPedidos, setCsvPedidos] = useState([]) // del CSV
  const [fuente, setFuente] = useState('app') // 'app' | 'csv'
  const [busqueda, setBusqueda] = useState('')
  const [loading, setLoading] = useState(false)
  const [generando, setGenerando] = useState('')
  const [csvNombre, setCsvNombre] = useState('')

  const cargarPedidos = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('ventas')
      .select('*')
      .eq('estado', 'pendiente')
      .order('fecha', { ascending: false })
      .limit(100)
    setPedidos(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { cargarPedidos() }, [cargarPedidos])

  const pedidosActivos = fuente === 'app' ? pedidos : csvPedidos
  const filtrados = pedidosActivos.filter(p => {
    if (!busqueda) return true
    const b = busqueda.toLowerCase()
    return (p.n_referencia || '').toLowerCase().includes(b) ||
      (p.producto_nombre || '').toLowerCase().includes(b) ||
      (p.cliente_nombre || '').toLowerCase().includes(b) ||
      (p.ciudad || '').toLowerCase().includes(b)
  })

  const toggleSeleccion = (id) => {
    setSeleccionados(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleTodos = () => {
    if (seleccionados.size === filtrados.length) setSeleccionados(new Set())
    else setSeleccionados(new Set(filtrados.map(p => p.id || p.n_referencia)))
  }

  const handleCSV = (file) => {
    if (!file) return
    setCsvNombre(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      const rows = parseCSVShopify(e.target.result)
      const mapped = rows.map((r, i) => ({ ...mapShopifyToDespacho(r), id: `csv_${i}` }))
      setCsvPedidos(mapped)
      setFuente('csv')
      setSeleccionados(new Set(mapped.map(p => p.id)))
      toast(`${mapped.length} pedidos cargados desde CSV`, 'success')
    }
    reader.readAsText(file)
  }

  const getPedidosParaDespacho = () => {
    if (seleccionados.size === 0) return filtrados
    return filtrados.filter(p => seleccionados.has(p.id || p.n_referencia))
  }

  // ── Generar Cabecera Excel ────────────────────────────────
  const generarExcel = async () => {
    const lista = getPedidosParaDespacho()
    if (lista.length === 0) { toast('No hay pedidos seleccionados', 'error'); return }
    setGenerando('excel')

    try {
      // Construir CSV con el formato exacto de Punto a Punto AC
      const headers = ['NOMBRE', 'CIUDAD', 'DIRECCIÓN', 'TELÉFONO', 'TIPO DE PRODUCTO', 'CANTIDAD DE BULTOS', 'PRIORIDAD', 'FORMA DE PAGO', 'IMPORTE', 'N° REFERENCIA', 'DESCRIPCION']

      const rows = lista.map(p => {
        const nombre = p.cliente_nombre || p.descripcion || ''
        const ciudad = p.ciudad || ''
        const dir = p.direccion || ''
        const tel = p.telefono || p.cliente_telefono || ''
        const tipo = getTipoProducto(p.producto_nombre || '')
        const importe = p.total || 0
        const ref = p.n_referencia || ''
        const desc = getDescripcionProducto(p.producto_nombre || '', p.cantidad || 1)
        return [nombre, ciudad, dir, tel, tipo, '1', '', 'efectivo a cobrar', importe, ref, desc]
      })

      // Crear CSV descargable (compatible con Excel)
      const csvContent = [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n')

      // BOM para que Excel lo abra correctamente con tildes
      const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const refs = lista.map(p => p.n_referencia).filter(Boolean)
      const refRange = refs.length > 0 ? `_${refs[0]}-${refs[refs.length - 1]}` : ''
      a.href = url
      a.download = `Cabecera${refRange}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast(`Cabecera generada — ${lista.length} pedidos`, 'success')
    } catch (e) {
      toast('Error: ' + e.message, 'error')
    }
    setGenerando('')
  }

  // ── Generar Guías Word (HTML que se puede abrir en Word) ──
  const generarGuias = async () => {
    const lista = getPedidosParaDespacho()
    if (lista.length === 0) { toast('No hay pedidos seleccionados', 'error'); return }
    setGenerando('word')

    try {
      // Generar HTML con formato de etiqueta (15cm x 10cm por página)
      // Word puede abrir HTML y respetar el tamaño de página
      const guiasHTML = lista.map(p => {
        const nombre = p.cliente_nombre || '—'
        const ciudad = p.ciudad || '—'
        const dir = p.direccion || '—'
        const tel = p.telefono || p.cliente_telefono || '—'
        const cant = p.cantidad || 1
        const prod = `${getTipoProducto(p.producto_nombre || '')} ×${cant}`

        return `
<div style="
  width: 10cm;
  height: 15cm;
  padding: 0.3cm;
  font-family: Arial, sans-serif;
  text-align: center;
  page-break-after: always;
  display: flex;
  flex-direction: column;
  justify-content: center;
  border: 1px solid #000;
  box-sizing: border-box;
">
  <div style="font-size: 22pt; font-weight: bold; margin-bottom: 6pt;">FACIAL WELLNESS</div>
  <div style="font-size: 14pt; margin-bottom: 4pt;">CIUDAD DEL ESTE</div>
  <div style="font-size: 11pt; margin-bottom: 4pt;">CI: 6.103.233</div>
  <div style="font-size: 11pt; margin-bottom: 16pt;">NRO: 0985-914-500</div>
  <hr style="border: 1.5px solid #000; margin: 8pt 0;" />
  <div style="font-size: 14pt; font-weight: bold; margin: 8pt 0;">DATOS DEL DESTINATARIO</div>
  <hr style="border: 1.5px solid #000; margin: 8pt 0;" />
  <div style="font-size: 13pt; margin: 5pt 0;"><b>Nombre:</b> ${nombre}</div>
  <div style="font-size: 13pt; margin: 5pt 0;"><b>Ciudad:</b> ${ciudad}</div>
  <div style="font-size: 13pt; margin: 5pt 0;"><b>Dirección:</b> ${dir}</div>
  <div style="font-size: 13pt; margin: 5pt 0;"><b>Teléfono:</b> ${tel}</div>
  <div style="font-size: 13pt; margin: 8pt 0;"><b>Producto:</b> ${prod}</div>
</div>`
      }).join('\n')

      const htmlCompleto = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page { size: 10cm 15cm; margin: 0; }
    body { margin: 0; padding: 0; }
  </style>
</head>
<body>
${guiasHTML}
</body>
</html>`

      const blob = new Blob([htmlCompleto], { type: 'text/html;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const refs = lista.map(p => p.n_referencia).filter(Boolean)
      const refRange = refs.length > 0 ? `_${refs[0]}-${refs[refs.length - 1]}` : ''
      a.href = url
      a.download = `Guias${refRange}.html`
      a.click()
      URL.revokeObjectURL(url)
      toast(`${lista.length} guías generadas`, 'success')
    } catch (e) {
      toast('Error: ' + e.message, 'error')
    }
    setGenerando('')
  }

  const totalSeleccionados = seleccionados.size || filtrados.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Despacho</h1>
          <p className="page-subtitle">Generá cabecera Excel y guías Word para Punto a Punto AC</p>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-secondary"
            onClick={generarExcel}
            disabled={generando === 'excel' || filtrados.length === 0}
          >
            {generando === 'excel' ? <RefreshCw size={14} className="spinning" /> : <FileSpreadsheet size={14} />}
            Descargar Excel
          </button>
          <button
            className="btn btn-primary"
            onClick={generarGuias}
            disabled={generando === 'word' || filtrados.length === 0}
          >
            {generando === 'word' ? <RefreshCw size={14} className="spinning" /> : <FileText size={14} />}
            Descargar Guías
          </button>
        </div>
      </div>

      {/* Info boxes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="alert alert-info" style={{ margin: 0 }}>
          <FileSpreadsheet size={14} />
          <div>
            <div style={{ fontWeight: 600 }}>Cabecera Excel</div>
            <div style={{ fontSize: 11, marginTop: 2 }}>CSV con formato exacto para Punto a Punto AC. Abrí con Excel, guardá como .xlsx y mandá.</div>
          </div>
        </div>
        <div className="alert alert-success" style={{ margin: 0 }}>
          <FileText size={14} />
          <div>
            <div style={{ fontWeight: 600 }}>Guías Word</div>
            <div style={{ fontSize: 11, marginTop: 2 }}>HTML descargable. Abrilo con Word/Chrome e imprimí. 15×10cm por guía, listo para pegar.</div>
          </div>
        </div>
      </div>

      {/* Fuente de datos */}
      <div className="card card-sm">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="tabs">
            <button className={`tab ${fuente === 'app' ? 'active' : ''}`} onClick={() => { setFuente('app'); setSeleccionados(new Set()) }}>
              Pedidos pendientes ({pedidos.length})
            </button>
            <button className={`tab ${fuente === 'csv' ? 'active' : ''}`} onClick={() => fileRef.current?.click()}>
              <Upload size={12} /> Cargar CSV Shopify
            </button>
          </div>
          {csvNombre && fuente === 'csv' && (
            <span style={{ fontSize: 12, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
              ✓ {csvNombre} — {csvPedidos.length} pedidos
            </span>
          )}
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
            onChange={e => handleCSV(e.target.files[0])} />
        </div>
      </div>

      {/* Búsqueda + stats */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input className="form-input" style={{ paddingLeft: 30 }}
            placeholder="Buscar por ref, producto, nombre, ciudad..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{totalSeleccionados}</span> seleccionados para generar
        </div>
      </div>

      {/* Tabla */}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={toggleTodos} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {seleccionados.size === filtrados.length && filtrados.length > 0
              ? <CheckSquare size={14} color="var(--accent)" />
              : <Square size={14} />
            }
            {seleccionados.size === filtrados.length ? 'Deseleccionar todos' : 'Seleccionar todos'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {filtrados.length} pedidos {fuente === 'app' ? 'pendientes' : 'del CSV'}
          </span>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Cargando...</div>
        ) : filtrados.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Truck size={22} /></div>
            <p className="empty-state-title">
              {fuente === 'app' ? 'No hay pedidos pendientes' : 'Cargá un CSV de Shopify'}
            </p>
            <p className="empty-state-desc">
              {fuente === 'app'
                ? 'Los pedidos en estado "Pendiente" aparecen acá automáticamente'
                : 'Hacé clic en "Cargar CSV Shopify" arriba'
              }
            </p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th>Ref.</th>
                  <th>Cliente</th>
                  <th>Ciudad</th>
                  <th>Producto</th>
                  <th>Cant.</th>
                  <th>Importe</th>
                  <th>Teléfono</th>
                </tr>
              </thead>
              <tbody>
                {filtrados.map(p => {
                  const id = p.id || p.n_referencia
                  const sel = seleccionados.size === 0 || seleccionados.has(id)
                  return (
                    <tr key={id} style={{ opacity: sel ? 1 : 0.4, cursor: 'pointer' }}
                      onClick={() => toggleSeleccion(id)}>
                      <td onClick={e => { e.stopPropagation(); toggleSeleccion(id) }}>
                        {sel
                          ? <CheckSquare size={15} color="var(--accent)" />
                          : <Square size={15} color="var(--text-muted)" />
                        }
                      </td>
                      <td className="mono">{p.n_referencia || '—'}</td>
                      <td style={{ fontWeight: 500 }}>{p.cliente_nombre || '—'}</td>
                      <td className="muted">{p.ciudad || '—'}</td>
                      <td>{p.producto_nombre}</td>
                      <td className="muted">{p.cantidad || 1}</td>
                      <td style={{ fontWeight: 600 }}>{formatGs(p.total)}</td>
                      <td className="muted" style={{ fontSize: 11 }}>{p.telefono || p.cliente_telefono || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Botones abajo también */}
      {filtrados.length > 0 && (
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={generarExcel} disabled={generando === 'excel'}>
            {generando === 'excel' ? <RefreshCw size={14} className="spinning" /> : <FileSpreadsheet size={14} />}
            Descargar Cabecera Excel ({totalSeleccionados})
          </button>
          <button className="btn btn-primary" onClick={generarGuias} disabled={generando === 'word'}>
            {generando === 'word' ? <RefreshCw size={14} className="spinning" /> : <FileText size={14} />}
            Descargar Guías Word ({totalSeleccionados})
          </button>
        </div>
      )}
    </div>
  )
}
