// src/lib/rendicionLucero.js
// ═══════════════════════════════════════════════════════════
// RENDICIÓN DE LUCERO DEL ESTE
//
// El archivo de Lucero es MUY distinto al de PaP y bastante mejor: un mismo
// archivo trae la confirmación de entrega, la tarifa REAL que te cobraron y lo
// que te van a depositar. Estructura:
//
//   fila 1: "Resumen de lote"
//   fila 2: Lote | 419 | Empresa | Facial Wellness | Fecha | 31/07/2026 | Estado | pendiente
//   fila 3: Bruto | 196000 | Tarifas | 60000 | Multas | 0 | TotalPago | 136000
//   fila 4: GeneradoEn | 31/07/2026 08:37
//   fila 6: ItemID | EnvioID | Código operación | Cliente recibe | EstadoFinal |
//           Ciudad | Item | Cantidad | Tarifa | TotalCobrar | PagoCliente
//   fila 7+: los datos
//
// El encabezado NO está en la primera fila, así que no se puede leer con
// sheet_to_json normal: hay que buscar dónde arranca la tabla.
//
// IMPORTANTE: los paquetes de Lucero NO existen en la tabla `entregas` (esa la
// llena solo el importador de PaP). Por eso este archivo no solo concilia:
// CREA los registros de entrega que faltan.
// ═══════════════════════════════════════════════════════════

// Normaliza texto de encabezado: sin tildes, minúscula, sin espacios extra.
const normHeader = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

// Referencia normalizada: saca el prefijo FW- que le mandamos a Lucero, para
// poder cruzar con la venta, que guarda el número pelado.
export function refDesdeCodigoLucero(codigo) {
  if (codigo == null) return ''
  let r = String(codigo).replace(/[#\s.\-/]/g, '').trim()
  const conPrefijo = r.match(/^[A-Za-z]{1,4}0*(\d+)$/)
  if (conPrefijo) return String(parseInt(conPrefijo[1], 10))
  if (/^\d+$/.test(r)) return String(parseInt(r, 10))
  return r
}

const num = (v) => {
  if (typeof v === 'number') return Math.round(v)
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

// Fecha de Lucero: "31/07/2026 08:37" o "31/07/2026" → ISO 'YYYY-MM-DD'
export function fechaLucero(v) {
  if (!v) return null
  if (v instanceof Date && !isNaN(v)) return v.toISOString().split('T')[0]
  const s = String(v).trim()
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return iso ? iso[0] : null
}

// ¿Estas filas son una rendición de Lucero? Se detecta por la tabla de detalle,
// que es lo único que no puede faltar.
export function esRendicionLucero(rowsRaw) {
  return (rowsRaw || []).some(fila =>
    (fila || []).some(c => normHeader(c) === 'codigo operacion') &&
    (fila || []).some(c => normHeader(c) === 'pagocliente')
  )
}

// Lee los pares etiqueta/valor del bloque de resumen (filas antes de la tabla).
function leerResumen(rowsRaw, filaTabla) {
  const res = {}
  for (let i = 0; i < filaTabla; i++) {
    const fila = rowsRaw[i] || []
    for (let j = 0; j < fila.length - 1; j++) {
      const k = normHeader(fila[j])
      if (!k) continue
      const v = fila[j + 1]
      if (v === '' || v == null) continue
      if (!(k in res)) res[k] = v
    }
  }
  return res
}

// Parsea el archivo completo.
// rowsRaw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
export function parsearRendicionLucero(rowsRaw) {
  const filas = rowsRaw || []
  const filaTabla = filas.findIndex(f =>
    (f || []).some(c => normHeader(c) === 'codigo operacion'))
  if (filaTabla < 0) throw new Error('No se encontró la tabla de detalle (falta la columna "Código operación")')

  const headers = (filas[filaTabla] || []).map(normHeader)
  const col = (nombre) => headers.indexOf(nombre)
  const iCodigo = col('codigo operacion')
  const iEnvio  = col('envioid')
  const iItemId = col('itemid')
  const iCli    = col('cliente recibe')
  const iEstado = col('estadofinal')
  const iCiudad = col('ciudad')
  const iItem   = col('item')
  const iCant   = col('cantidad')
  const iTarifa = col('tarifa')
  const iCobrar = col('totalcobrar')
  const iPago   = col('pagocliente')

  const resumen = leerResumen(filas, filaTabla)
  const estadoLote = String(resumen['estado'] ?? '').toLowerCase().trim()
  // El lote se considera COBRADO solo si Lucero dice que ya pagó. 'pendiente'
  // significa que la rendición está emitida pero la plata todavía no llegó.
  const pagado = /pagad|deposit|acredit|liquidad/.test(estadoLote)

  const items = []
  for (let i = filaTabla + 1; i < filas.length; i++) {
    const f = filas[i] || []
    const codigo = iCodigo >= 0 ? f[iCodigo] : ''
    if (codigo === '' || codigo == null) continue
    const estadoFinal = String((iEstado >= 0 ? f[iEstado] : '') ?? '').toLowerCase().trim()
    items.push({
      itemId: iItemId >= 0 ? f[iItemId] : null,
      envioId: iEnvio >= 0 ? String(f[iEnvio] ?? '').trim() : '',
      codigo: String(codigo).trim(),
      referencia: refDesdeCodigoLucero(codigo),
      cliente: iCli >= 0 ? String(f[iCli] ?? '').trim() : '',
      estadoFinal,
      ciudad: iCiudad >= 0 ? String(f[iCiudad] ?? '').trim() : '',
      producto: iItem >= 0 ? String(f[iItem] ?? '').trim() : '',
      cantidad: iCant >= 0 ? (num(f[iCant]) || 1) : 1,
      tarifa: iTarifa >= 0 ? num(f[iTarifa]) : 0,          // flete REAL que cobró Lucero
      totalCobrar: iCobrar >= 0 ? num(f[iCobrar]) : 0,      // lo que pagó el cliente
      pagoCliente: iPago >= 0 ? num(f[iPago]) : 0,          // lo que te deposita Lucero
    })
  }

  return {
    lote: String(resumen['lote'] ?? '').trim(),
    empresa: String(resumen['empresa'] ?? '').trim(),
    fecha: fechaLucero(resumen['fecha']),
    generadoEn: fechaLucero(resumen['generadoen']),
    estadoLote: estadoLote || 'pendiente',
    pagado,
    bruto: num(resumen['bruto']),
    tarifas: num(resumen['tarifas']),
    multas: num(resumen['multas']),
    totalPago: num(resumen['totalpago']),
    items,
  }
}

// Mapea el estado final de Lucero a las categorías internas del sistema.
export function categoriaLucero(estadoFinal) {
  const e = String(estadoFinal || '').toLowerCase()
  if (e.includes('entregado')) return 'entregado'
  if (e.includes('devuelt') || e.includes('fallid') || e.includes('cancelad') || e.includes('rechaz')) return 'devuelto'
  if (e.includes('borrador') || e.includes('cargado')) return 'no_despachado'
  return 'en_proceso'
}

// Convierte la rendición en registros para la tabla `entregas`.
// Usa el MISMO esquema que el importador de PaP para que todo el resto del
// sistema (reportes, ganancia, tasa de entrega) los lea sin cambios.
//
// La guía se prefija con 'L-' para no chocar con las de PaP, que son numéricas.
export function rendicionLuceroAEntregas(parsed) {
  const { items, fecha, pagado } = parsed
  return (items || []).map(it => {
    const cat = categoriaLucero(it.estadoFinal)
    return {
      nro_guia_pap: `L-${it.envioId || it.codigo}`,
      n_referencia: it.referencia,
      estado_pap: it.estadoFinal,
      categoria: cat,
      motivo: '',
      importe: it.totalCobrar,
      cobrado: cat === 'entregado' ? it.totalCobrar : 0,
      // Tarifa REAL de Lucero para esa ciudad — mejor dato que cualquier estimación.
      costo_envio: it.tarifa,
      fecha_ingreso: null,
      // El archivo no trae fecha de entrega. No se inventa: si el lote está
      // pagado, la fecha del lote es lo más cercano que hay al cierre.
      fecha_entrega: pagado ? fecha : null,
      dias_entrega: null,
      rendido: pagado,
      fecha_rendido: pagado ? fecha : null,
      dias_rendicion: null,
      mensajero: '',
      telefono: '',
      nombre_cliente: it.cliente,
      ciudad: it.ciudad,
      producto: it.producto,
      transportadora: 'lucero',
      mes: (fecha || '').slice(0, 7),
    }
  })
}

// Resumen para mostrar antes de guardar (que el usuario vea qué va a pasar).
export function resumenRendicionLucero(parsed) {
  const items = parsed.items || []
  const porCat = {}
  items.forEach(it => {
    const c = categoriaLucero(it.estadoFinal)
    porCat[c] = (porCat[c] || 0) + 1
  })
  const sumaTarifas = items.reduce((s, i) => s + i.tarifa, 0)
  const sumaCobrar = items.reduce((s, i) => s + i.totalCobrar, 0)
  const sumaPago = items.reduce((s, i) => s + i.pagoCliente, 0)
  // Chequeo de integridad contra el encabezado del propio archivo.
  const cuadra = {
    bruto: parsed.bruto === sumaCobrar,
    tarifas: parsed.tarifas === sumaTarifas,
    totalPago: parsed.totalPago === sumaPago,
  }
  return {
    cantidad: items.length,
    porCat,
    sumaTarifas, sumaCobrar, sumaPago,
    cuadra,
    todoCuadra: cuadra.bruto && cuadra.tarifas && cuadra.totalPago,
  }
}
