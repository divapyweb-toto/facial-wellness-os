// src/pages/importar/ImportarPage.jsx
import { useState, useRef, useMemo, useEffect } from 'react'
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
  // Dirección: Note Attributes (Releasit) → Shipping → Billing. Suma la referencia si existe.
  const dirBase = extraerNota(notas, 'Dirección principal')
    || (row['Shipping Address1'] && row['Shipping Address1'] !== '-' ? row['Shipping Address1'] : '')
    || (row['Billing Address1'] && row['Billing Address1'] !== '-' ? row['Billing Address1'] : '')
    || ''
  const refDir = extraerNota(notas, 'Referencia')
  const cliente_direccion = dirBase ? (refDir ? `${dirBase} (${refDir})` : dirBase) : refDir
  return {
    fecha,
    n_referencia: (row['Name'] || '').replace('#', '').trim(),
    producto_nombre: row['Lineitem name'] || 'Sin nombre',
    cantidad: parseInt(row['Lineitem quantity']) || 1,
    total,
    precio_unit: total,
    ciudad,
    cliente_nombre: nombre,
    cliente_telefono: telefono,
    cliente_direccion,
    estado: 'pendiente',
    estado_releasit,
    canal_origen: 'Shopify Orgánico',
    costo_prod: 0,
    costo_envio: 27000,
    envio_cliente: 0,
  }
}

// ─── Multiproducto: valor de un line item (precio × cantidad) ───
function precioLineaShopify(row) {
  const p = parseInt((row['Lineitem price'] || '0').toString().replace(/[^0-9]/g, '')) || 0
  const q = parseInt(row['Lineitem quantity']) || 1
  return p * q
}

// Agrupa filas de Shopify por pedido. Las filas SIN Name son líneas extra del
// pedido anterior (Shopify pone una fila por producto). Devuelve 1 venta por
// pedido usando como producto el line item de MAYOR valor, y reporta los pedidos
// con varios productos para avisar (no se pierden en silencio).
function agruparPedidosShopify(filas) {
  const grupos = []
  let actual = null
  for (const row of filas) {
    const name = (row['Name'] || '').trim()
    if (name.startsWith('#')) { actual = { cab: row, lineas: [row] }; grupos.push(actual) }
    else if (actual && (row['Lineitem name'] || '').trim()) actual.lineas.push(row)
  }
  const ventas = []
  const multi = []
  for (const g of grupos) {
    const base = mapShopifyRow(g.cab) // datos del cliente + Total del pedido
    let mejor = g.lineas[0], mejorVal = -1
    for (const ln of g.lineas) {
      const val = precioLineaShopify(ln)
      if (val > mejorVal) { mejorVal = val; mejor = ln }
    }
    ventas.push({
      ...base,
      producto_nombre: (mejor['Lineitem name'] || base.producto_nombre || 'Sin nombre').trim(),
      cantidad: parseInt(mejor['Lineitem quantity']) || 1,
    })
    if (g.lineas.length > 1) {
      multi.push({ ref: base.n_referencia, productos: g.lineas.map(l => (l['Lineitem name'] || '').trim()).filter(Boolean) })
    }
  }
  return { ventas, multi }
}

// ─── Match de producto del catálogo por nombre ──────────────
// Resuelve costo_prod y producto_id buscando el producto del catálogo
// que corresponde al nombre que viene de Shopify (que suele ser más largo/sucio).
function matchProducto(nombreVenta, productos) {
  if (!nombreVenta || !productos.length) return null
  const n = nombreVenta.toLowerCase().trim()
  // 1) match exacto
  let p = productos.find(x => (x.nombre || '').toLowerCase().trim() === n)
  if (p) return p
  // 2) "contiene": el nombre del catálogo aparece en el de la venta (o al revés).
  //    Se prefiere el nombre de catálogo más largo (el más específico).
  const cand = productos
    .filter(x => {
      const c = (x.nombre || '').toLowerCase().trim()
      return c && (n.includes(c) || c.includes(n))
    })
    .sort((a, b) => (b.nombre || '').length - (a.nombre || '').length)
  return cand[0] || null
}

function enriquecerConProducto(v, productos) {
  const p = matchProducto(v.producto_nombre, productos)
  if (!p) return { ...v, _sinProducto: true }
  return {
    ...v,
    producto_id: p.id,
    producto_nombre: p.nombre, // normaliza al nombre del catálogo (stock + analytics consistentes)
    costo_prod: (p.costo_unit || 0) * (v.cantidad || 1),
    _sinProducto: false,
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
    cliente_direccion: row['direccion'] || row['Direccion'] || row['dirección'] || row['address'] || '',
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
  const [productos, setProductos] = useState([])

  // Cargar catálogo de productos para resolver costo_prod y producto_id al importar
  useEffect(() => {
    supabase.from('productos').select('id, nombre, costo_unit, grupo_envio').eq('activo', true)
      .then(({ data }) => setProductos(data || []))
  }, [])

  // Agrupar pedidos Shopify (maneja pedidos con varios productos)
  const shopifyAgrupado = useMemo(() => {
    if (formato !== 'shopify' || !filasRaw.length) return { ventas: [], multi: [] }
    return agruparPedidosShopify(filasRaw)
  }, [filasRaw, formato])

  // Mapear todas las filas según formato + enriquecer con producto del catálogo
  const todasMapeadas = useMemo(() => {
    if (!filasRaw.length) return []
    let base
    if (formato === 'shopify') {
      base = shopifyAgrupado.ventas
    } else {
      base = filasRaw.map(mapGenericoRow).filter(v => v.producto_nombre && v.producto_nombre !== 'Sin nombre')
    }
    return base.map(v => enriquecerConProducto(v, productos))
  }, [filasRaw, formato, productos, shopifyAgrupado])

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

  // Productos que NO matchean con el catálogo → entran con costo 0 y sin descuento de stock
  const sinProducto = useMemo(() => {
    const m = new Map()
    ventasFinal.forEach(v => { if (v._sinProducto) m.set(v.producto_nombre, (m.get(v.producto_nombre) || 0) + 1) })
    return [...m.entries()].map(([nombre, n]) => ({ nombre, n })).sort((a, b) => b.n - a.n)
  }, [ventasFinal])

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
      // ANTI-DUPLICADOS: filtrar por referencia ya existente en ventas.
      // Ventas con referencia vacía (carga manual) se usa huella cliente+producto+ciudad.
      const refs = ventasFinal.map(v => v.n_referencia).filter(Boolean)
      let refsExistentes = new Set()
      if (refs.length) {
        try {
          const { data } = await supabase.from('ventas').select('n_referencia').in('n_referencia', refs)
          refsExistentes = new Set((data || []).map(d => String(d.n_referencia)))
        } catch (e) { /* sin filtro de BD si falla */ }
      }

      const vistos = new Set()
      const huellas = new Set()
      const nuevas = []
      const duplicados = []
      for (const v of ventasFinal) {
        const ref = v.n_referencia ? String(v.n_referencia) : ''
        const huella = `${(v.cliente_nombre||'').toLowerCase()}|${(v.producto_nombre||'').toLowerCase()}|${v.cantidad}|${(v.ciudad||'').toLowerCase()}`
        const esDupRef = ref && (refsExistentes.has(ref) || vistos.has(ref))
        const esDupHuella = !ref && huellas.has(huella)  // solo aplica si NO hay referencia
        if (esDupRef || esDupHuella) {
          duplicados.push(ref || huella)
        } else {
          if (ref) vistos.add(ref)
          else huellas.add(huella)
          nuevas.push(v)
        }
      }

      if (!nuevas.length) {
        setResultado({ insertados: 0, fallidos: 0, total: 0, duplicados: duplicados.length, refsDup: duplicados })
        setLoading(false)
        toast(`Todas ya estaban cargadas (${duplicados.length} duplicados)`, 'error')
        return
      }

      let insertados = 0, fallidos = 0
      for (let i = 0; i < nuevas.length; i += 50) {
        const lote = nuevas.slice(i, i + 50).map(({ estado_releasit, _sinProducto, ...v }) => v)
        const { error } = await supabase.from('ventas').insert(lote)
        if (error) fallidos += lote.length
        else insertados += lote.length
      }
      setResultado({ insertados, fallidos, total: nuevas.length, duplicados: duplicados.length, refsDup: duplicados })
      if (insertados > 0) toast(`${insertados} ventas importadas${duplicados.length ? ` · ${duplicados.length} duplicados omitidos` : ''}`, 'success')
      if (fallidos > 0) toast(`${fallidos} ventas fallaron`, 'error')
    } catch (err) {
      toast('Error al importar: ' + err.message, 'error')
    }
    setLoading(false)
  }

  const descargarPlantilla = () => {
    const csv = 'fecha,referencia,producto,cantidad,total,ciudad,direccion,cliente,telefono,canal\n2026-06-01,1580,JawFlex Pro,1,137000,Asunción,Av. España 123,Juan Pérez,0981000000,Meta Ads\n2026-06-01,1581,Pack Gudair,2,256000,San Lorenzo,Ruta 2 km 18,Ana López,0982000000,TikTok'
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

      {/* Alerta: hay órdenes pero todas filtradas por estado */}
      {!resultado && todasMapeadas.length > 0 && ventasFinal.length === 0 && (
        <div className="alert alert-warning">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 600 }}>
              {todasMapeadas.length} pedido{todasMapeadas.length !== 1 ? 's' : ''} encontrado{todasMapeadas.length !== 1 ? 's' : ''}, pero {todasMapeadas.length === 1 ? 'está' : 'están'} en estado pendiente de confirmación
            </div>
            <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5, opacity: 0.9 }}>
              Releasit todavía no confirmó {todasMapeadas.length === 1 ? 'este pedido' : 'estos pedidos'}.
              Destildá <b>"Solo confirmados + ayuda"</b> para importarlos igual, o esperá a que el cliente confirme.
            </div>
          </div>
        </div>
      )}

      {/* Alerta: CSV cargado pero sin pedidos válidos */}
      {!resultado && filasRaw.length > 0 && todasMapeadas.length === 0 && (
        <div className="alert alert-warning">
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 600 }}>El CSV no contiene pedidos válidos</div>
            <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5, opacity: 0.9 }}>
              Verificá que exportaste desde Shopify: Pedidos → Exportar → <b>"Archivo CSV sin formato"</b>.
              Las filas deben tener una columna "Name" con valores como "#1595".
            </div>
          </div>
        </div>
      )}

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
              <div className="kpi-value" style={{ color: 'var(--yellow)' }}>{excluidosPorEstado}</div>
              <div className="kpi-sub">Pendientes / cancelados</div>
            </div>
          )}
        </div>
      )}

      {/* Pedidos con varios productos */}
      {formato === 'shopify' && shopifyAgrupado.multi.length > 0 && (
        <div className="alert alert-warning">
          <AlertTriangle size={14} />
          <div>
            <div style={{ fontWeight: 600 }}>{shopifyAgrupado.multi.length} pedido(s) tienen varios productos</div>
            <div style={{ fontSize: 12, marginTop: 3, opacity: 0.9 }}>
              Se importa el producto principal (el de mayor valor) con el total del pedido. Los productos secundarios <b>no descuentan stock</b> — revisalos y ajustá el stock a mano si hace falta:
            </div>
            {shopifyAgrupado.multi.slice(0, 5).map((p, i) => (
              <div key={i} style={{ fontSize: 12, marginTop: 3 }}>#{p.ref}: {p.productos.join(' + ')}</div>
            ))}
            {shopifyAgrupado.multi.length > 5 && <div style={{ fontSize: 12, marginTop: 3, opacity: 0.6 }}>…y {shopifyAgrupado.multi.length - 5} más</div>}
          </div>
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

      {/* Productos sin match en catálogo */}
      {sinProducto.length > 0 && (
        <div className="alert alert-error">
          <AlertTriangle size={14} />
          <div>
            <div style={{ fontWeight: 600 }}>{sinProducto.length} producto(s) no están en tu catálogo</div>
            <div style={{ fontSize: 12, marginTop: 3, opacity: 0.9 }}>
              Estas ventas se importan con <b>costo 0</b> y <b>no descuentan stock</b>. Creá estos productos en Stock (con su costo) y volvé a importar para que el cálculo sea exacto:
            </div>
            {sinProducto.slice(0, 6).map((p, i) => (
              <div key={i} style={{ fontSize: 12, marginTop: 3 }}>• {p.nombre} <span style={{ opacity: 0.6 }}>({p.n})</span></div>
            ))}
            {sinProducto.length > 6 && <div style={{ fontSize: 12, marginTop: 3, opacity: 0.6 }}>…y {sinProducto.length - 6} más</div>}
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
                  <th>Dirección</th>
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
                    <td className="muted" style={{ maxWidth: 180, whiteSpace: 'normal', fontSize: 11 }}>{v.cliente_direccion || '—'}</td>
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
            {resultado.duplicados > 0 && (
              <div style={{ fontSize: 12, marginTop: 4, color: 'var(--yellow)' }}>
                ⚠ {resultado.duplicados} duplicado(s) ya cargado(s), omitidos: {(resultado.refsDup || []).filter(r => r && !r.includes('|')).map(r => `#${r}`).join(', ') || '(carga manual sin referencia)'}
              </div>
            )}
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
