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

import { esImporteCorrupto } from './estadosPaP'

// Normaliza texto de encabezado: sin tildes, minúscula, sin espacios extra.
const normHeader = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

// Clave de guía DETERMINÍSTICA a partir de la referencia propia (no del EnvioID
// de Lucero, que no se conoce hasta que ellos procesan el envío). Usar la MISMA
// función tanto al crear el placeholder en Despacho como al conciliar la
// rendición es lo que hace que las dos escrituras caigan en la MISMA fila de
// `entregas` (mismo nro_guia_pap = mismo onConflict), en vez de crear una
// fila fantasma en el despacho y otra distinta al rendir.
export function guiaLucero(ref) {
  return `L-${refDesdeCodigoLucero(ref)}`
}

// Registro que se crea EN EL MOMENTO DEL DESPACHO, antes de saber nada de
// Lucero. Dispatch-time record, "Amazon style": el envío existe para el
// sistema desde que sale, no recién cuando alguien te paga por él.
//   venta: { n_referencia, total, ciudad, producto_nombre, cantidad, fecha, costo_envio }
export function placeholderEntregaLucero(venta) {
  const ref = refDesdeCodigoLucero(venta.n_referencia)
  return {
    nro_guia_pap: guiaLucero(ref),
    n_referencia: ref,
    estado_pap: '',
    categoria: 'en_proceso',
    motivo: '',
    importe: venta.total || 0,
    cobrado: 0,
    // Tarifa ESTIMADA (la misma que se congeló en la venta al despachar). Se
    // sobreescribe con la real en cuanto llega la rendición.
    costo_envio: venta.costo_envio || 0,
    fecha_ingreso: venta.fecha || null,
    fecha_entrega: null,
    dias_entrega: null,
    rendido: false,
    fecha_rendido: null,
    dias_rendicion: null,
    mensajero: '',
    ciudad: venta.ciudad || '',
    producto: venta.producto_nombre || '',
    mes: (venta.fecha || '').slice(0, 7),
    transportadora: 'lucero',
  }
}

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

// Monto de plata, con el mismo tope de sanidad que el resto del sistema.
// Lucero manda valores basura: se vio una multa con 2.147.483.647 (el máximo
// de un entero de 32 bits, o sea un dato sin inicializar de su sistema). Si
// eso llega a Postgres, rechaza el lote ENTERO y no entra ni una rendición.
// Basura → 0: acá no hay estimación previa que preservar, y un 0 visible se
// corrige a mano; un lote que no entra no se ve.
const montoSano = (v) => {
  const n = num(v)
  return esImporteCorrupto(n) ? 0 : n
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
      tarifa: iTarifa >= 0 ? montoSano(f[iTarifa]) : 0,          // flete REAL que cobró Lucero
      totalCobrar: iCobrar >= 0 ? montoSano(f[iCobrar]) : 0,      // lo que pagó el cliente
      pagoCliente: iPago >= 0 ? montoSano(f[iPago]) : 0,          // lo que te deposita Lucero
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
// Contraparte de la categoriaLucero() de exportLucero.js — ver la nota de allá.
// Esta lee el archivo de RENDICIÓN, que es el cierre: acá 'fallido' ya no se
// reintenta, es una devolución. Por eso las dos difieren y está bien.
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
// CLAVE: se usa `guiaLucero(referencia)`, la MISMA función que arma el
// placeholder en Despacho. Así el upsert (onConflict: nro_guia_pap) actualiza
// la fila que ya existía desde el despacho, en vez de crear una duplicada.
//
// rendido = true SIEMPRE: confirmado que la plata cae al banco ~30 min después
// de que aparece este archivo. Es un lag irrelevante frente a los 7-20 días de
// PaP, así que no se modela un estado "pendiente" intermedio — el archivo ES
// el evento de cobro.
//
// OJO campos que se OMITEN a propósito (fecha_ingreso, mensajero...): si el
// placeholder del despacho ya los tenía, un upsert de Supabase con esos campos
// ausentes del objeto los deja como estaban. Si se incluyeran en null, los
// borrarían.
export function rendicionLuceroAEntregas(parsed) {
  const { items, fecha } = parsed
  return (items || []).map(it => {
    const cat = categoriaLucero(it.estadoFinal)
    return {
      nro_guia_pap: guiaLucero(it.referencia),
      n_referencia: it.referencia,
      estado_pap: it.estadoFinal,
      categoria: cat,
      motivo: '',
      // Bruto REAL cobrado al cliente (dato de Lucero, pisa la estimación del despacho).
      importe: it.totalCobrar,
      cobrado: cat === 'entregado' ? it.totalCobrar : 0,
      // Tarifa REAL de Lucero para esa ciudad — pisa la estimación del despacho.
      costo_envio: it.tarifa,
      // NETO que efectivamente cae al banco (bruto − tarifa − multa de ESE item).
      // Es el número que hay que mirar para saber cuánta plata real tenés, no
      // el bruto — eso es justo lo que pediste.
      neto_depositado: it.pagoCliente,
      // ID interno de Lucero, guardado solo para referencia/auditoría — NO se
      // usa como clave de cruce (eso lo hace guiaLucero con la referencia).
      guia_transportadora: it.envioId || null,
      fecha_entrega: fecha,       // mejor proxy disponible: Lucero no manda fecha de entrega separada
      rendido: true,              // ver nota arriba: el archivo mismo es el evento de cobro
      fecha_rendido: fecha,
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
  // OJO con qué se compara contra qué — cada total de la cabecera tiene un
  // alcance distinto, y confundirlos genera falsos "no cuadra":
  //
  //   Bruto     = solo lo COBRADO, o sea los ENTREGADOS. Un devuelto trae su
  //               TotalCobrar (el valor del pedido) pero nunca se cobró, así
  //               que no entra. Sumar todo daba una diferencia igual al monto
  //               de las devoluciones.
  //   Tarifas   = TODOS los ítems, incluidos los devueltos: Lucero cobra el
  //               flete de ida aunque el paquete vuelva.
  //   TotalPago = TODOS los ítems. Los prepagos y devueltos suman NEGATIVO
  //               (te descuentan el flete de lo que te depositan).
  const sumaTarifas = items.reduce((s, i) => s + i.tarifa, 0)
  const sumaCobrar = items
    .filter(i => categoriaLucero(i.estadoFinal) === 'entregado')
    .reduce((s, i) => s + i.totalCobrar, 0)
  const sumaPago = items.reduce((s, i) => s + i.pagoCliente, 0)
  // Valor de lo devuelto: no entra en el bruto, pero sirve para mostrarlo.
  const montoDevuelto = items
    .filter(i => categoriaLucero(i.estadoFinal) === 'devuelto')
    .reduce((s, i) => s + i.totalCobrar, 0)
  // Chequeo de integridad contra el encabezado del propio archivo.
  // Se guarda el DETALLE de cada diferencia, no solo un sí/no: cuando un lote
  // no cuadra hay que poder decir exactamente qué campo y por cuánto, para
  // reclamárselo a Lucero con el número en la mano.
  const comparar = (etiqueta, cabecera, calculado) => ({
    etiqueta, cabecera, calculado,
    diferencia: (cabecera || 0) - (calculado || 0),
    ok: (cabecera || 0) === (calculado || 0),
  })
  const detalle = [
    comparar('Bruto cobrado', parsed.bruto, sumaCobrar),
    comparar('Tarifas', parsed.tarifas, sumaTarifas),
    comparar('Total a depositar', parsed.totalPago, sumaPago),
  ]
  const cuadra = {
    bruto: detalle[0].ok, tarifas: detalle[1].ok, totalPago: detalle[2].ok,
  }
  const diferencias = detalle.filter(d => !d.ok)
  return {
    cantidad: items.length,
    porCat,
    sumaTarifas, sumaCobrar, sumaPago,
    cuadra, detalle, diferencias, montoDevuelto,
    todoCuadra: diferencias.length === 0,
  }
}
