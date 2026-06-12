// src/pages/importar/ImportarPage.jsx
import { useState, useRef } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Upload, FileText, CheckCircle, XCircle, AlertTriangle, Download, X } from 'lucide-react'

const SHOPIFY_COLUMNS = {
  'Name': 'n_referencia',
  'Created at': 'fecha',
  'Lineitem name': 'producto_nombre',
  'Lineitem quantity': 'cantidad',
  'Total': 'total',
  'Shipping City': 'ciudad',
  'Phone': 'cliente_telefono',
  'Billing Name': 'cliente_nombre',
}

// ─── Parser CSV robusto (maneja saltos de línea dentro de celdas) ──
function parseCSV(text) {
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

function mapShopifyRow(row) {
  const fecha = row['Created at'] ? row['Created at'].split('T')[0] : new Date().toISOString().split('T')[0]
  const total = parseFloat((row['Total'] || '0').replace(/[^0-9.]/g, '')) * 1000 // convertir a guaraníes aprox
  return {
    fecha,
    n_referencia: row['Name'] || '',
    producto_nombre: row['Lineitem name'] || 'Sin nombre',
    cantidad: parseInt(row['Lineitem quantity']) || 1,
    total: Math.round(total) || 98000,
    precio_unit: Math.round(total) || 98000,
    ciudad: row['Shipping City'] || '',
    cliente_nombre: row['Billing Name'] || '',
    cliente_telefono: row['Phone'] || '',
    estado: 'pendiente',
    canal_origen: 'Shopify Orgánico',
    costo_prod: 0,
    costo_envio: 27000,
    envio_cliente: 0,
  }
}

function mapGenericoRow(row, headers) {
  // Formato genérico: fecha, producto, cantidad, precio, ciudad, estado
  return {
    fecha: row['fecha'] || row['Fecha'] || new Date().toISOString().split('T')[0],
    n_referencia: row['referencia'] || row['Referencia'] || row['ref'] || '',
    producto_nombre: row['producto'] || row['Producto'] || row['product'] || 'Sin nombre',
    cantidad: parseInt(row['cantidad'] || row['Cantidad'] || row['qty'] || 1),
    total: parseInt(row['total'] || row['Total'] || row['precio'] || 0),
    precio_unit: parseInt(row['total'] || row['Total'] || row['precio'] || 0),
    ciudad: row['ciudad'] || row['Ciudad'] || row['city'] || '',
    estado: row['estado'] || row['Estado'] || 'pendiente',
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
  const [preview, setPreview] = useState([])
  const [errores, setErrores] = useState([])
  const [formato, setFormato] = useState('shopify')
  const [loading, setLoading] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [dragging, setDragging] = useState(false)

  const procesarArchivo = (file) => {
    if (!file) return
    setArchivo(file)
    setResultado(null)
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target.result
      const rows = parseCSV(text)
      const erroresNuevos = []
      const prevNuevo = rows.slice(0, 10).map((row, i) => {
        const mapped = formato === 'shopify' ? mapShopifyRow(row) : mapGenericoRow(row, Object.keys(row))
        if (!mapped.producto_nombre || mapped.producto_nombre === 'Sin nombre') {
          erroresNuevos.push(`Fila ${i + 2}: Sin nombre de producto`)
        }
        return mapped
      })
      setPreview(prevNuevo)
      setErrores(erroresNuevos)
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
    if (!archivo) return
    setLoading(true)
    try {
      const reader = new FileReader()
      reader.onload = async (e) => {
        const text = e.target.result
        const rows = parseCSV(text)
        const ventas = rows.map(row => formato === 'shopify' ? mapShopifyRow(row) : mapGenericoRow(row, Object.keys(row)))
          .filter(v => v.producto_nombre && v.producto_nombre !== 'Sin nombre')

        // Insertar en lotes de 50
        let insertados = 0
        let fallidos = 0
        for (let i = 0; i < ventas.length; i += 50) {
          const lote = ventas.slice(i, i + 50)
          const { error } = await supabase.from('ventas').insert(lote)
          if (error) fallidos += lote.length
          else insertados += lote.length
        }

        setResultado({ insertados, fallidos, total: ventas.length })
        if (insertados > 0) toast(`${insertados} ventas importadas correctamente`, 'success')
        if (fallidos > 0) toast(`${fallidos} ventas fallaron`, 'error')
        setLoading(false)
      }
      reader.readAsText(archivo)
    } catch (err) {
      toast('Error al importar: ' + err.message, 'error')
      setLoading(false)
    }
  }

  const descargarPlantilla = () => {
    const csv = 'fecha,referencia,producto,cantidad,total,ciudad,estado,canal\n2026-06-01,1580,JawFlex Pro,1,98000,Asunción,pendiente,Meta Ads\n2026-06-01,1581,Pack Gudair,2,235000,San Lorenzo,entregado,TikTok'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'plantilla_ventas.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Importar pedidos</h1>
          <p className="page-subtitle">Cargá ventas masivamente desde un archivo CSV de Shopify o plantilla propia</p>
        </div>
        <button className="btn btn-ghost" onClick={descargarPlantilla}>
          <Download size={14} /> Descargar plantilla
        </button>
      </div>

      {/* Formato selector */}
      <div className="card card-sm">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Formato:</span>
          <div className="tabs">
            <button className={`tab ${formato === 'shopify' ? 'active' : ''}`} onClick={() => setFormato('shopify')}>
              Shopify CSV
            </button>
            <button className={`tab ${formato === 'generico' ? 'active' : ''}`} onClick={() => setFormato('generico')}>
              Plantilla propia
            </button>
          </div>
        </div>
        {formato === 'shopify' && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Exportá desde Shopify: Pedidos → Exportar → Pedidos actuales → CSV para Excel
          </p>
        )}
        {formato === 'generico' && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Columnas requeridas: fecha, producto, cantidad, total. Opcionales: referencia, ciudad, estado, canal
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
              {preview.length} filas en preview · Hacé clic para cambiar el archivo
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
            <span style={{ fontWeight: 600, fontSize: 13 }}>Preview (primeras 10 filas)</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{preview.length} de {archivo?.name}</span>
          </div>
          <div className="table-wrapper" style={{ border: 'none', borderRadius: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Ref.</th>
                  <th>Producto</th>
                  <th>Cant.</th>
                  <th>Total</th>
                  <th>Ciudad</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((v, i) => (
                  <tr key={i}>
                    <td className="muted">{v.fecha}</td>
                    <td className="mono">{v.n_referencia || '—'}</td>
                    <td style={{ fontWeight: 500 }}>{v.producto_nombre}</td>
                    <td>{v.cantidad}</td>
                    <td style={{ fontWeight: 600 }}>{formatGs(v.total)}</td>
                    <td className="muted">{v.ciudad || '—'}</td>
                    <td><span className="badge badge-yellow" style={{ fontSize: 10 }}>{v.estado}</span></td>
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
      {preview.length > 0 && !resultado && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-ghost" onClick={() => { setArchivo(null); setPreview([]); setErrores([]) }}>
            <X size={14} /> Cancelar
          </button>
          <button className="btn btn-primary" onClick={handleImportar} disabled={loading} style={{ minWidth: 160 }}>
            {loading ? (
              <div style={{ width: 14, height: 14, border: '2px solid rgba(0,0,0,0.3)', borderTopColor: '#000', borderRadius: '50%' }} className="spinning" />
            ) : (
              <Upload size={14} />
            )}
            {loading ? 'Importando...' : `Importar todas las ventas`}
          </button>
        </div>
      )}
    </div>
  )
}
