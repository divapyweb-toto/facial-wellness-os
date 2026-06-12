// src/pages/importar/ImportarPage.jsx
import { useState, useRef, useMemo } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Upload, CheckCircle, AlertTriangle, Download, X } from 'lucide-react'

// ═══════════════════════════════════════════════════════════
// PARSER CSV ROBUSTO — \r\n + comillas + saltos de línea en celdas
// ═══════════════════════════════════════════════════════════
function parseCSV(text) {
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
  })
}

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

function clasificarEstado(tags, cancelledAt) {
  const t = (tags || '').toLowerCase()
  if (t.includes('cancelado') || cancelledAt) return 'cancelado'
  if (t.includes('confirmado')) return 'confirmado'
  if (t.includes('ayuda') || t.includes('help')) return 'ayuda'
  if (t.includes('confirmation pending') || t.includes('pending')) return 'pending'
  return 'pending'
}

// ─── Mapear fila Shopify → venta (BUGS CORREGIDOS) ───────
function mapShopifyRow(row) {
  const notas = row['Note Attributes'] || ''
  const estado_releasit = clasificarEstado(row['Tags'], row['Cancelled at'])
  // FIX: fecha con espacio, no 'T'
  const fecha = (row['Created at'] || '').split(' ')[0] || new Date().toISOString().split('T')[0]
  // FIX: total sin ×1000 — ya viene en guaraníes
  const total = parseInt((row['Total'] || '0').replace(/[^0-9]/g, '')) || 0
  // FIX: ciudad desde Note Attributes (Shopify City suele venir "-")
  const ciudad = extraerNota(notas, 'ciudad') || (row['Shipping City'] !== '-' ? row['Shipping City'] : '') || ''
  const nombre = (extraerNota(notas, 'Nombre y apellido') || row['Billing Name'] || row['Shipping Name'] || '').replace(/\s*-\s*$/, '').trim()
  const telefono = limpiarTel(extraerNota(notas, 'Teléfono') || extraerNota(notas, 'whatsapp') || row['Phone'] || row['Billing Phone'] || '')
  return {
    fecha,
    n_referencia: row['Name'] || '',
    producto_nombre: row['Lineitem name'] || 'Sin nombre',
    cantidad: parseInt(row['Lineitem quantity']) || 1,
    total,
    precio_unit: total,
    ciudad,
    cliente_nombre: nombre,
    cliente_telefono: telefono,
    estado: 'pendiente',
    estado_releasit,
    canal_origen: 'Shopify Orgánico',
    costo_prod: 0,
    costo_envio: 27000,
    envio_cliente: 0,
  }
}

function mapGenericoRow(row) {
  const total = parseInt((row['total'] || row['Total'] || row['precio'] || '0').toString().replace(/[^0-9]/g, '')) || 0
  return {
    fecha: row['fecha'] || row['Fecha'] || new Date().toISOString().split('T')[0],
    n_referencia: row['referencia'] || row['Referencia'] || row['ref'] || '',
    producto_nombre: row['producto'] || row['Producto'] || row['product'] || 'Sin nombre',
    cantidad: parseInt(row['cantidad'] || row['Cantidad'] || row['qty'] || 1),
    total,
    precio_unit: total,
    ciudad: row['ciudad'] || row['Ciudad'] || row['city'] || '',
    cliente_nombre: row['cliente'] || row['Cliente'] || row['nombre'] || '',
    cliente_telefono: limpiarTel(row['telefono'] || row['Telefono'] || row['tel'] || ''),
    estado: row['estado'] || row['Estado'] || 'pendiente',
    estado_releasit: 'confirmado',
    canal_origen: row['canal'] || 'Meta Ads',
    costo_prod: 0,
    costo_envio: 27000,
    envio_cliente: 0,
  }
}

export default function ImportarPage() {
  const { toast } = useToast()
  const fileRef = useRef()
  const [archivo, setArchivo] = useState(null)
  const [filasRaw, setFilasRaw] = useState([])
  const [formato, setFormato] = useState('shopify')
  const [soloConfirmados, setSoloConfirmados] = useState(true)
  const [loading, setLoading] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [dragging, setDragging] = useState(false)

  // Mapear todas las filas según formato
  const todasMapeadas = useMemo(() => {
    if (!filasRaw.length) return []
    if (formato === 'shopify') {
      return filasRaw.filter(r => r['Name'] && r['Name'].startsWith('#')).map(mapShopifyRow)
    }
    return filasRaw.map(mapGenericoRow).filter(v => v.producto_nombre && v.producto_nombre !== 'Sin nombre')
  }, [filasRaw, formato])

  // Aplicar filtro de estado Releasit (solo Shopify)
  const ventasFinal = useMemo(() => {
    if (formato === 'shopify' && soloConfirmados) {
      return todasMapeadas.filter(v => v.estado_releasit === 'confirmado' || v.estado_releasit === 'ayuda')
    }
    return todasMapeadas
  }, [todasMapeadas, formato, soloConfirmados])

  const preview = useMemo(() => ventasFinal.slice(0, 10), [ventasFinal])

  const errores = useMemo(() => {
    const errs = []
    ventasFinal.slice(0, 50).forEach((v, i) => {
      if (!v.producto_nombre || v.producto_nombre === 'Sin nombre') errs.push(`${v.n_referencia || `Fila ${i+1}`}: sin nombre de producto`)
      if (v.total === 0) errs.push(`${v.n_referencia || `Fila ${i+1}`}: importe en 0`)
    })
    return errs
  }, [ventasFinal])

  const excluidosPorEstado = useMemo(() => {
    if (formato !== 'shopify' || !soloConfirmados) return 0
    return todasMapeadas.length - ventasFinal.length
  }, [todasMapeadas, ventasFinal, formato, soloConfirmados])

  const procesarArchivo = (file) => {
    if (!file) return
    setArchivo(file)
    setResultado(null)
    const reader = new FileReader()
    reader.onload = (e) => {
      const rows = parseCSV(e.target.result)
      setFilasRaw(rows)
    }
    reader.readAsText(file)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file && file.name.endsWith('.csv')) procesarArchivo(file)
    else toast('Solo se aceptan archivos .csv', 'error')
  }

  const handleImportar = async () => {
    if (!ventasFinal.length) { toast('No hay ventas para importar', 'error'); return }
    setLoading(true)
    try {
      let insertados = 0, fallidos = 0
      for (let i = 0; i < ventasFinal.length; i += 50) {
        const lote = ventasFinal.slice(i, i + 50).map(({ estado_releasit, ...v }) => v)
        const { error } = await supabase.from('ventas').insert(lote)
        if (error) fallidos += lote.length
        else insertados += lote.length
      }
      setResultado({ insertados, fallidos, total: ventasFinal.length })
      if (insertados > 0) toast(`${insertados} ventas importadas`, 'success')
      if (fallidos > 0) toast(`${fallidos} ventas fallaron`, 'error')
    } catch (err) {
      toast('Error al importar: ' + err.message, 'error')
    }
    setLoading(false)
  }

  const descargarPlantilla = () => {
    const csv = 'fecha,referencia,producto,cantidad,total,ciudad,cliente,telefono,canal\n2026-06-01,1580,JawFlex Pro,1,137000,Asunción,Juan Pérez,0981000000,Meta Ads\n2026-06-01,1581,Pack Gudair,2,256000,San Lorenzo,Ana López,0982000000,TikTok'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'plantilla_ventas.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const totalImporte = ventasFinal.reduce((s, v) => s + v.total, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Importar pedidos</h1>
          <p className="page-subtitle">Cargá ventas masivamente desde un CSV de Shopify o plantilla propia</p>
        </div>
        <button className="btn btn-ghost" onClick={descargarPlantilla}>
          <Download size={14} /> Descargar plantilla
        </button>
      </div>

      {/* Formato selector */}
      <div className="card card-sm">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Formato:</span>
          <div className="tabs">
            <button className={`tab ${formato === 'shopify' ? 'active' : ''}`} onClick={() => setFormato('shopify')}>
              Shopify CSV
            </button>
            <button className={`tab ${formato === 'generico' ? 'active' : ''}`} onClick={() => setFormato('generico')}>
              Plantilla propia
            </button>
          </div>
          {formato === 'shopify' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', marginLeft: 'auto', cursor: 'pointer' }}>
              <input type="checkbox" checked={soloConfirmados} onChange={e => setSoloConfirmados(e.target.checked)} />
              Solo confirmados + ayuda
            </label>
          )}
        </div>
        {formato === 'shopify' && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Exportá desde Shopify: Pedidos → Exportar → "Archivo CSV sin formato". Extrae nombre, ciudad y teléfono del Note Attributes de Releasit.
          </p>
        )}
        {formato === 'generico' && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Columnas requeridas: fecha, producto, cantidad, total. Opcionales: referencia, ciudad, cliente, telefono, canal
          </p>
        )}
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? 'var(--accent)' : archivo ? 'var(--green)' : 'var(--border)'}`,
          borderRadius: 12, padding: '40px 20px',
          textAlign: 'center', cursor: 'pointer',
          background: dragging ? 'var(--accent-dim)' : archivo ? 'var(--green-dim)' : 'var(--bg-card)',
          transition: 'all 0.2s ease',
        }}
      >
        <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
          onChange={e => procesarArchivo(e.target.files[0])} />
        {archivo ? (
          <div>
            <CheckCircle size={32} color="var(--green)" style={{ margin: '0 auto 10px' }} />
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--green)' }}>{archivo.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              {ventasFinal.length} ventas listas · Hacé clic para cambiar el archivo
            </div>
          </div>
        ) : (
          <div>
            <Upload size={32} color="var(--text-muted)" style={{ margin: '0 auto 10px' }} />
            <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-secondary)' }}>
              Arrastrá tu CSV acá o hacé clic para seleccionar
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Solo archivos .csv</div>
          </div>
        )}
      </div>

      {/* Resumen */}
      {ventasFinal.length > 0 && !resultado && (
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">Ventas a importar</div>
            <div className="kpi-value accent">{ventasFinal.length}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Importe total</div>
            <div className="kpi-value green">{formatGs(totalImporte)}</div>
          </div>
          {excluidosPorEstado > 0 && (
            <div className="kpi-card">
              <div className="kpi-label">Excluidos por estado</div>
              <div className="kpi-value" style={{ color: 'var(--red)' }}>{excluidosPorEstado}</div>
              <div className="kpi-sub">Cancelados / pendientes</div>
            </div>
          )}
        </div>
      )}

      {/* Errores */}
      {errores.length > 0 && (
        <div className="alert alert-warning">
          <AlertTriangle size={14} />
          <div>
            <div style={{ fontWeight: 600 }}>{errores.length} advertencia(s) en los datos</div>
            {errores.slice(0, 3).map((e, i) => <div key={i} style={{ fontSize: 12, marginTop: 3 }}>{e}</div>)}
          </div>
        </div>
      )}

      {/* Preview */}
      {preview.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Preview (primeras 10 de {ventasFinal.length})</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{archivo?.name}</span>
          </div>
          <div className="table-wrapper" style={{ border: 'none', borderRadius: 0, overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Ref.</th>
                  <th>Producto</th>
                  <th>Cant.</th>
                  <th>Total</th>
                  <th>Cliente</th>
                  <th>Ciudad</th>
                  <th>Teléfono</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((v, i) => (
                  <tr key={i}>
                    <td className="muted" style={{ fontSize: 11 }}>{v.fecha}</td>
                    <td className="mono">{v.n_referencia || '—'}</td>
                    <td style={{ fontWeight: 500, fontSize: 12 }}>{v.producto_nombre}</td>
                    <td>{v.cantidad}</td>
                    <td style={{ fontWeight: 600 }}>{formatGs(v.total)}</td>
                    <td className="muted">{v.cliente_nombre || '—'}</td>
                    <td className="muted">{v.ciudad || '—'}</td>
                    <td className="muted">{v.cliente_telefono || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Resultado */}
      {resultado && (
        <div className={`alert alert-${resultado.fallidos === 0 ? 'success' : 'warning'}`}>
          <CheckCircle size={15} />
          <div>
            <div style={{ fontWeight: 600 }}>Importación completada</div>
            <div style={{ fontSize: 12, marginTop: 3 }}>
              {resultado.insertados} ventas importadas · {resultado.fallidos} fallidas · Total: {resultado.total}
            </div>
          </div>
        </div>
      )}

      {/* Botón importar */}
      {ventasFinal.length > 0 && !resultado && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-ghost" onClick={() => { setArchivo(null); setFilasRaw([]) }}>
            <X size={14} /> Cancelar
          </button>
          <button className="btn btn-primary" onClick={handleImportar} disabled={loading} style={{ minWidth: 160 }}>
            {loading ? (
              <div style={{ width: 14, height: 14, border: '2px solid rgba(0,0,0,0.3)', borderTopColor: '#000', borderRadius: '50%' }} className="spinning" />
            ) : (
              <Upload size={14} />
            )}
            {loading ? 'Importando...' : `Importar ${ventasFinal.length} ventas`}
          </button>
        </div>
      )}
    </div>
  )
}
