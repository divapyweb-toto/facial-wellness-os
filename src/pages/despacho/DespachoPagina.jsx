// src/pages/despacho/DespachoPagina.jsx
import { useState, useRef, useMemo } from 'react'
import { limpiarTel } from '../../lib/referencias'
import * as XLSX from 'xlsx'
import { Document, Packer, Paragraph, TextRun, AlignmentType, PageBreak, ImageRun, BorderStyle, Table, TableRow, TableCell, WidthType, convertMillimetersToTwip } from 'docx'
import { generarBarcodePNG, codigoPedido } from '../../lib/barcode'
import ModalSalida from './ModalSalida'
import { supabase, formatGs } from '../../lib/supabase'
import { categorizarPaP as categoriaPaP, importeSano, esImporteCorrupto, cantidadSana, esCantidadCorrupta } from '../../lib/estadosPaP'
import { costoFleteActual } from '../../lib/flete'
import { getEnvioCliente } from '../../lib/config'
import { tieneCobranzaPaP, zonaPaP } from '../../lib/cobranzaPaP'
import { sugerirTransportadora, ciudadParaPlanillaLucero, labelTransportadora, tarifaDe, transportadorasDisponibles, transportadoraForzada, ciudadesConocidas, coberturaCiudad, TRANSPORTADORAS } from '../../lib/transportadoras'
import { placeholderEntregaLucero, guiaLucero } from '../../lib/rendicionLucero'
import { familiaProducto } from '../../lib/recompra'
import { fetchAll, fetchAllSafe } from '../../lib/fetchAll'
import { construirHistorialClientes, evaluarRiesgo, motivoRiesgo, normalizarTel } from '../../lib/riesgoCliente'
import { construirHistorialCiudades, evaluarCiudad } from '../../lib/riesgoCiudad'
import { useToast } from '../../lib/toast'

// Helpers locales para el cruce ventas ⋈ entregas del historial de riesgo
const normRefRiesgo = (ref) => {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}
import {
  Upload, FileSpreadsheet, FileText, ShoppingBag, CheckCircle, X,
  Download, Eye, Search, AlertTriangle, Package, MapPin, TrendingUp, RefreshCw, Info, ScanLine, MessageSquare, Edit2,
} from 'lucide-react'

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
  if (n.includes('bebird')) return 'Bebird Pro' // FIX bebird antes de lengua: "Limpiador de Oídos" contiene "limpiador"
  if (n.includes('tira') || n.includes('nasal') || n.includes('nose') || n.includes('strip')) return 'Tiras nasales'
  if (n.includes('raspador') || n.includes('lengua') || n.includes('limpiador') || n.includes('tongue') || n.includes('scraper')) return 'Raspador de lengua'
  if (n.includes('parche') || n.includes('bucal') || n.includes('mouth') || n.includes('tape')) return 'Parche Bucal'
  if (n.includes('jaw') || n.includes('mandíbula') || n.includes('mandibula') || n.includes('ejercitador')) return 'JawFlex Pro'
  if (n.includes('botella') || n.includes('flexible') || n.includes('bottle') || n.includes('flow')) return 'Botella Flexible'
  return nombre || 'Producto'
}

function getDesc(nombre, cantidad) {
  const n = (nombre || '').toLowerCase()
  const u = parseInt(cantidad) || 1
  if (n.includes('gudair') || (n.includes('tira') && n.includes('parche'))) return `Pack Gudair (${u} unidad${u > 1 ? 'es' : ''})`
  if (n.includes('bebird')) return 'Bebird Pro - Limpiador de Oídos' // FIX bebird antes de lengua: "Limpiador de Oídos" contiene "limpiador"
  if (n.includes('tira') || n.includes('nasal') || n.includes('nose') || n.includes('strip')) return 'Tiras nasales (30 unidades)'
  if (n.includes('raspador') || n.includes('lengua') || n.includes('limpiador') || n.includes('tongue') || n.includes('scraper')) return 'Limpiador de Lengua Facial Wellness'
  if (n.includes('parche') || n.includes('bucal') || n.includes('mouth') || n.includes('tape')) return 'Parches bucales (30 unidades)'
  if (n.includes('jaw') || n.includes('mandíbula') || n.includes('mandibula') || n.includes('ejercitador')) return `Ejercitadores de Mandíbula - Pack ${u}x JawFlex Pro`
  if (n.includes('botella') || n.includes('flexible') || n.includes('bottle') || n.includes('flow')) return u > 1 ? `Botella Flexible Flow 500 x${u}` : 'Botella Flexible Flow 500 Negro'
  return `${nombre} (${u} unidad${u > 1 ? 'es' : ''})`
}

// ─── Agrupar filas del CSV por número de pedido ──────────
// Shopify exporta UNA FILA POR PRODUCTO: un pedido de 2 productos son 2 filas
// que comparten el mismo 'Name' (#2063). Solo la PRIMERA fila de ese grupo
// trae Nombre/Ciudad/Teléfono/Dirección/Total/Subtotal — las siguientes los
// dejan en blanco. Sin agrupar, el segundo producto queda como un pedido
// roto: sin ciudad, sin teléfono, sin total (ingreso $0), y su stock nunca
// se descuenta.
function agruparFilasPorReferencia(rows) {
  const grupos = new Map()
  const orden = []
  for (const row of rows) {
    const key = (row['Name'] || '').trim()
    if (!key) continue
    if (!grupos.has(key)) { grupos.set(key, []); orden.push(key) }
    grupos.get(key).push(row)
  }
  return orden.map(key => grupos.get(key))
}

// ─── Mapear un GRUPO de filas (mismo pedido) a uno o varios pedidos ──
// Devuelve UN PEDIDO POR PRODUCTO (mantiene el modelo "1 venta = 1 producto"
// que ya usa todo el resto del sistema — stock, COGS, ganancia por familia),
// pero con los datos de envío copiados a los dos, y el total repartido de
// forma proporcional entre los productos (no 100% al primero y $0 al segundo).
//
// El flete es UNA sola vez por paquete físico: solo la primera línea lo lleva
// en costo_envio; las demás van en 0 para no duplicar el costo al sumar.
function mapearGrupoAPedidos(grupoRows) {
  // Dato a nivel de PEDIDO (no de línea): el primer valor no vacío entre
  // todas las filas del grupo — Shopify los deja en blanco en las filas de
  // continuación de un pedido multi-producto.
  const primero = (campo) => {
    for (const row of grupoRows) {
      const v = row[campo]
      if (v != null && String(v).trim() !== '' && v !== '-') return v
    }
    return ''
  }
  const notas = primero('Note Attributes')
  const estado = clasificarEstado(primero('Tags'), primero('Cancelled at'))
  const cfg = ESTADO_CONFIG[estado]
  const fecha = (primero('Created at') || '').split(' ')[0] || new Date().toISOString().split('T')[0]
  const ref = (primero('Name') || '').replace('#', '').trim()
  const nombre = (extraerNota(notas, 'Nombre y apellido') || primero('Billing Name') || primero('Shipping Name') || '').replace(/\s*-\s*$/, '').trim()
  const ciudad = extraerNota(notas, 'ciudad') || primero('Shipping City') || ''
  const departamento = extraerNota(notas, 'departamento') || ''
  const dir = extraerNota(notas, 'Dirección principal') || primero('Shipping Address1') || ''
  const refDir = extraerNota(notas, 'Referencia') || ''
  const direccion = dir ? (refDir ? `${dir} (${refDir})` : dir) : refDir
  const telefono = limpiarTel(extraerNota(notas, 'Teléfono') || extraerNota(notas, 'whatsapp') || primero('Phone') || primero('Billing Phone') || '')
  // Montos del CSV con tope de sanidad. Un valor imposible (archivo editado,
  // export corrupto) desbordaba el integer de Postgres y tumbaba el insert
  // ENTERO de las ventas — el mismo bug que trajo Lucero con una multa de
  // 2.147.483.647. Se guarda el crudo para poder avisarlo en pantalla.
  const totalCrudo = parseInt((primero('Total') || '0').replace(/[^0-9]/g, '')) || 0
  const subtotalCrudo = parseInt((primero('Subtotal') || '0').replace(/[^0-9]/g, '')) || 0
  const totalOrden = importeSano(totalCrudo)
  const subtotalOrden = importeSano(subtotalCrudo)
  const montosRaros = esImporteCorrupto(totalCrudo) || esImporteCorrupto(subtotalCrudo)

  // Ítems del pedido: Lineitem SIEMPRE está presente en cada fila, aunque el
  // resto de los datos de esa fila estén en blanco.
  const items = grupoRows
    .map(row => ({
      producto_nombre: row['Lineitem name'] || '',
      cantidad: cantidadSana(row['Lineitem quantity']),
      precio: importeSano(parseInt((row['Lineitem price'] || '0').replace(/[^0-9]/g, '')) || 0),
      // Se recuerda si esta línea venía con un dato imposible, para avisarlo.
      lineaRara: esCantidadCorrupta(row['Lineitem quantity'])
        || esImporteCorrupto(parseInt((row['Lineitem price'] || '0').replace(/[^0-9]/g, '')) || 0),
    }))
    .filter(it => it.producto_nombre)
  if (!items.length) return []

  // Reparto proporcional del total (ya incluye envío/descuentos) según el
  // peso de cada línea sobre el subtotal — así cada producto se lleva SU
  // parte real del ingreso (importa para ganancia por familia y ROAS). El
  // último ítem absorbe el redondeo para que la suma sea EXACTA al total.
  const pesoItem = (it) => subtotalOrden > 0 ? (it.precio * it.cantidad) / subtotalOrden : 1 / items.length
  let acumulado = 0
  const totales = items.map((it, i) => {
    if (i === items.length - 1) return totalOrden - acumulado
    const t = Math.round(pesoItem(it) * totalOrden)
    acumulado += t
    return t
  })

  // Si CUALQUIER línea tiene transportadora forzada (ej. JawFlex → Lucero),
  // rige para TODO el paquete: es una sola caja física, no se reparte.
  const conRegla = items.find(it => transportadoraForzada(it.producto_nombre))
  const productoParaRuteo = conRegla ? conRegla.producto_nombre : items[0].producto_nombre
  const sugerencia = sugerirTransportadora(ciudad, productoParaRuteo)
  const transportadora = sugerencia.transportadora
  const cobranzaOk = transportadora != null
  const faltantes = []
  if (cfg.despachar) {
    if (!nombre) faltantes.push('nombre')
    if (!telefono) faltantes.push('teléfono')
    if (!direccion) faltantes.push('dirección')
  }
  // Un monto o cantidad imposible NO se guarda en silencio: se descarta el
  // valor (para que el resto del pedido entre) y el pedido queda marcado en
  // la pantalla de revisión, que es justo donde mirás antes de despachar.
  if (montosRaros || items.some(it => it.lineaRara)) {
    faltantes.push('importe o cantidad imposible en el archivo — revisá el monto')
  }
  const despachar = cfg.despachar && cobranzaOk
  const multiProducto = items.length > 1
  // Descripción combinada, para cuando se imprime UNA guía/cabecera por
  // paquete: "Tiras nasales (30 unidades) x1 + Limpiador de Lengua x1".
  const descripcionCombinada = multiProducto
    ? items.map((it, i) => `${getDesc(it.producto_nombre, it.cantidad)} x${it.cantidad}`).join(' + ')
    : null
  const tipoCombinado = multiProducto
    ? [...new Set(items.map(it => getTipo(it.producto_nombre)))].join(' + ')
    : null

  return items.map((it, i) => ({
    n_referencia: ref, cliente_nombre: nombre, ciudad, departamento, direccion,
    referencia_dir: refDir,          // separada: Lucero la pide en su propia columna
    telefono, producto_nombre: it.producto_nombre, cantidad: it.cantidad,
    total: totales[i], fecha, estado_releasit: estado,
    cfg, cobranzaOk, despachar, faltantes,
    transportadora,                  // 'pap' | 'lucero' | 'otra' — editable después en la UI
    motivoTransportadora: sugerencia.motivo,
    bloqueadoPorProducto: !!sugerencia.bloqueadoPorProducto,
    // Tarifa real de ESA transportadora en ESA ciudad — solo en la primera
    // línea del pedido (una sola caja, un solo flete; el resto va en 0).
    costo_envio: i === 0 ? sugerencia.tarifa : 0,
    esMultiProducto: multiProducto,
    numLineas: items.length,
    lineaIndice: i,
    totalOrden,
    descripcionCombinada,
    tipoCombinado,
  }))
}

// ─── Match de producto del catálogo (resuelve costo_prod) ───
function matchProducto(nombreVenta, productos) {
  if (!nombreVenta || !productos.length) return null
  const n = nombreVenta.toLowerCase().trim()
  let p = productos.find(x => (x.nombre || '').toLowerCase().trim() === n)
  if (p) return p
  const cand = productos
    .filter(x => { const c = (x.nombre || '').toLowerCase().trim(); return c && (n.includes(c) || c.includes(n)) })
    .sort((a, b) => (b.nombre || '').length - (a.nombre || '').length)
  return cand[0] || null
}

// ═══════════════════════════════════════════════════════════
// CARGA MANUAL (pedidos cerrados por WhatsApp, fuera de Shopify)
//
// Enrique pega el bloque de texto que el cliente le manda por WhatsApp
// ("Nombre completo: ... Ciudad: ... Producto y cantidad: ...") y el sistema
// lo convierte en pedidos que entran por la MISMA tubería que un CSV de
// Shopify: mismo chequeo de riesgo, misma sugerencia de transportadora,
// misma generación de guía y cabecera. No hay una ruta paralela.
//
// LA REFERENCIA — el problema real que resuelve esto: estos pedidos no
// tienen número de Shopify (nunca pasaron por el checkout), y Shopify sigue
// numerando de a 1 en 1 (2060, 2061, 2062...). Ponerles un número cualquiera
// chocaría tarde o temprano con un pedido real de Shopify que llegue a ese
// mismo número. La referencia lleva el prefijo 'WA-' (whatsapp): un pedido
// de Shopify JAMÁS va a tener letras en su número, así que 'WA-0007' nunca
// puede confundirse con un '#0007' de Shopify. Mismo truco que ya usamos
// para los códigos de Lucero (FW-2025).
// ═══════════════════════════════════════════════════════════

// Divide el texto pegado en un bloque por pedido. Un pedido nuevo arranca
// donde aparece "Nombre completo" — tolera mayúsculas/minúsculas y con o sin
// los dos puntos.
function dividirBloquesManual(texto) {
  const marcador = /(?=nombre\s+completo\s*:?)/gi
  return (texto || '')
    .split(marcador)
    .map(b => b.trim())
    .filter(b => b && /nombre\s+completo/i.test(b))
}

// Extrae el valor de una etiqueta dentro de un bloque de texto, tolerando
// variantes de redacción ("Número de contacto" / "Contacto" / "Teléfono").
function extraerCampoManual(bloque, patrones) {
  for (const patron of patrones) {
    const re = new RegExp(patron + '\\s*:?\\s*(.+)', 'i')
    const m = bloque.match(re)
    if (m) {
      // Corta en el salto de línea (el valor no cruza a la siguiente etiqueta)
      return m[1].split('\n')[0].trim()
    }
  }
  return ''
}

// "limpiador de Lengua 1" → 1 | "jawflex pro uno solo" → 1 | sin número → 1
const NUMEROS_TEXTO = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 }
function extraerCantidadManual(textoProducto) {
  const n = (textoProducto || '').toLowerCase()
  const digito = n.match(/(\d+)\s*(unidad|u\.?|x)?$/) || n.match(/\bx\s*(\d+)\b/)
  if (digito) { const v = parseInt(digito[1]); if (v > 0 && v < 100) return v }
  for (const [palabra, val] of Object.entries(NUMEROS_TEXTO)) {
    if (new RegExp(`\\b${palabra}\\b`).test(n)) return val
  }
  return 1
}

// Parsea UN bloque de texto a un pedido — mismo formato que produce el
// importador de CSV, para reusar toda la tubería de Despacho sin cambios.
function parsearPedidoManual(bloque, catalogo, nRef) {
  const cliente_nombre = extraerCampoManual(bloque, ['nombre\\s+completo'])
  const ciudad = extraerCampoManual(bloque, ['ciudad'])
  const direccion = extraerCampoManual(bloque, ['direcci[oó]n\\s+exacta', 'direcci[oó]n'])
  const telefono = limpiarTel(extraerCampoManual(bloque, ['n[uú]mero\\s+de\\s+contacto', 'contacto', 'tel[eé]fono', 'whatsapp']))
  const ci = extraerCampoManual(bloque, ['c[ée]dula.*?ruc', 'ci\\s*:.*?ruc', 'c[ée]dula', '\\bci\\b', '\\bruc\\b'])
  let productoTexto = extraerCampoManual(bloque, ['producto\\s+y\\s+cantidad', 'producto'])
  // A veces el cliente pega su CI/RUC de nuevo, pegado en la misma línea del
  // producto ("limpiador de Lengua 1. CI:6919774"). Se corta todo lo que
  // venga después de un separador (".", "-") seguido de CI/RUC o de un
  // número largo (5+ dígitos, que no es una cantidad real de producto).
  productoTexto = productoTexto.replace(/[.\-–]\s*(c[ée]dula|ruc|ci)\b.*$/i, '').trim()
  productoTexto = productoTexto.replace(/\b\d{5,}\b.*$/, '').trim()
  const cantidad = extraerCantidadManual(productoTexto)

  // Orden de matcheo, del más confiable al más frágil:
  //   1. Nombre exacto del catálogo.
  //   2. FAMILIA — entiende sinónimos ("limpiador de lengua" = raspador) y
  //      packs. Va ANTES del match parcial porque un pack MENCIONA a sus
  //      componentes: "pack gudair (tiras nasales + parches bucales)" contiene
  //      el nombre de tres productos, y el match parcial elegía el más largo
  //      ("Parches bucales", 79.000) en vez del pack real (150.000).
  //   3. Coincidencia parcial de texto, como último recurso.
  const nTexto = productoTexto.toLowerCase().trim()
  let prod = catalogo.find(c => (c.nombre || '').toLowerCase().trim() === nTexto) || null
  if (!prod) {
    const familia = familiaProducto(productoTexto)
    if (familia) prod = catalogo.find(c => familiaProducto(c.nombre) === familia) || null
  }
  if (!prod) prod = matchProducto(productoTexto, catalogo)
  const precioBase = prod
    ? (cantidad >= 3 ? (prod.precio_3u || prod.precio_1u) : cantidad === 2 ? (prod.precio_2u || prod.precio_1u) : prod.precio_1u) || 0
    : 0
  const envioCliente = prod?.grupo_envio === 'A' ? getEnvioCliente() : 0
  const total = precioBase + envioCliente

  const sugerencia = sugerirTransportadora(ciudad, productoTexto)
  const transportadora = sugerencia.transportadora
  const faltantes = []
  if (!cliente_nombre) faltantes.push('nombre')
  if (!telefono) faltantes.push('teléfono')
  if (!direccion) faltantes.push('dirección')
  if (!prod) faltantes.push('producto (no matcheó con el catálogo)')

  return {
    n_referencia: nRef, cliente_nombre, ciudad, departamento: '', direccion,
    referencia_dir: '', telefono,
    producto_nombre: prod ? prod.nombre : productoTexto, cantidad,
    total, fecha: new Date().toISOString().split('T')[0],
    // Ya está confirmado: lo tipeó el propio Enrique después de cerrar la
    // venta — no pasa por el estado de Shopify/Tags.
    estado_releasit: 'confirmado', cfg: ESTADO_CONFIG['confirmado'],
    cobranzaOk: transportadora != null,
    despachar: transportadora != null && faltantes.length === 0,
    faltantes,
    transportadora,
    motivoTransportadora: sugerencia.motivo,
    bloqueadoPorProducto: !!sugerencia.bloqueadoPorProducto,
    costo_envio: sugerencia.tarifa,
    // 100% de estos pedidos vienen pagados por transferencia — se marca de
    // entrada (queda editable como cualquier otro prepago en la tabla).
    prepago: true,
    notas: ci ? `CI/RUC: ${ci}` : '',
    origenManual: true,
  }
}

// ─── Cabecera XLSX — formato Lucero del Este ────────────────
// La estructura tiene que ser EXACTA: su importador detecta las columnas por
// nombre. Ojo con las tildes, son inconsistentes en la plantilla original:
// CODIGO / TELEFONO / DIRECCION van SIN tilde, pero UBICACIÓN va CON tilde.
// Copiadas literal del archivo oficial — no "corregir" la ortografía.
const HEADERS_LUCERO = ['CODIGO','EMPRESA','TELEFONO','DIRECCION','NOMBRE Y APELLIDO','CIUDAD','BARRIO','REFERENCIA','CANTIDAD','PRODUCTO','IMPORTE','FECHA','UBICACIÓN','NOTAS']

// Empresa vinculada en el panel de Lucero. Tiene que coincidir exacto.
const EMPRESA_LUCERO = 'Facial Wellness'

// ── CÓDIGO DE LUCERO ──
// Sus códigos chocan entre clientes distintos (el índice único no está scopeado
// por empresa), así que acordamos mandarlo VACÍO y que ellos generen el suyo.
//
// OJO: sin código, su importador pierde la protección anti-duplicados ("si el
// mismo código ya existe, lo omite"). Subir dos veces el mismo archivo crea
// envíos duplicados. Por eso el nombre del archivo lleva el rango de refs y la
// referencia va SIEMPRE en NOTAS, para poder rastrear y detectar repetidos.
//
// Si Lucero acepta códigos con prefijo (FW-2025), poné 'prefijo' acá: es mejor
// solución — no choca con otros clientes Y conserva el anti-duplicados.
const MODO_CODIGO_LUCERO = 'prefijo'    // 'vacio' | 'prefijo' | 'numero'
const PREFIJO_LUCERO = 'FW-'

function codigoLucero(ref) {
  if (MODO_CODIGO_LUCERO === 'vacio') return ''
  if (MODO_CODIGO_LUCERO === 'prefijo') return `${PREFIJO_LUCERO}${String(ref || '').trim()}`
  const n = parseInt(ref)
  return isNaN(n) ? String(ref || '').trim() : n
}

// Los campos vacíos van como 'N/A', no en blanco: su sistema los rechaza.
// (CODIGO es la excepción: ahí el vacío es intencional.)
const oNA = (v) => { const s = String(v ?? '').trim(); return s === '' ? 'N/A' : s }

// ─── Colapsar líneas hermanas (mismo pedido) en UNA entrada por paquete ──
// La guía y la cabecera son por PAQUETE FÍSICO, no por producto — si un
// pedido de 2 productos llegó como 2 entradas (una por línea, para que stock
// y ganancia por familia funcionen bien), acá se combinan de nuevo en una
// sola fila antes de imprimir. Si ya viene una sola línea, se devuelve tal cual.
function colapsarPorReferencia(pedidos) {
  const grupos = new Map()
  const orden = []
  for (const p of pedidos) {
    const key = p.n_referencia || `_sin_ref_${orden.length}`
    if (!grupos.has(key)) { grupos.set(key, []); orden.push(key) }
    grupos.get(key).push(p)
  }
  return orden.map(key => {
    const items = grupos.get(key)
    if (items.length === 1) return items[0]
    const base = items[0]
    const descripcionCombinada = base.descripcionCombinada
      || items.map(it => `${getDesc(it.producto_nombre, it.cantidad)} x${it.cantidad}`).join(' + ')
    const tipoCombinado = base.tipoCombinado
      || [...new Set(items.map(it => getTipo(it.producto_nombre)))].join(' + ')
    const totalCombinado = base.totalOrden ?? items.reduce((s, it) => s + (it.total || 0), 0)
    // El flete real está en UNA sola línea (las demás quedan en 0 para no
    // duplicar el costo); el máximo entre las líneas del grupo es ese valor,
    // sin depender de que items[0] sea justo esa línea (el orden de fetch de
    // la base no lo garantiza).
    const costoEnvioCombinado = Math.max(...items.map(it => it.costo_envio || 0))
    return {
      ...base,
      esMultiProducto: true,
      numLineas: items.length,
      descripcionCombinada,
      tipoCombinado,
      cantidad: 1,           // el paquete es 1 bulto — cada producto ya lleva su "xN" en la descripción
      total: totalCombinado,
      costo_envio: costoEnvioCombinado,
    }
  })
}

function descargarCabeceraLuceroXLSX(pedidos) {
  const aoa = [HEADERS_LUCERO]
  pedidos.forEach(p => {
    // La referencia va en NOTAS sí o sí: si el CODIGO va vacío, este es el único
    // rastro que queda para cruzar el envío de Lucero con la venta del OS.
    const partes = []
    if (p.prepago) partes.push('YA PAGADO - NO COBRAR')   // primero: es lo urgente
    // La referencia solo se duplica en NOTAS si el CODIGO va vacío. Con prefijo
    // (FW-2025) el código ya la lleva y repetirla solo ensucia la guía.
    if (MODO_CODIGO_LUCERO === 'vacio' && p.n_referencia) partes.push(`Ref ${p.n_referencia}`)
    const notas = partes.length ? partes.join(' · ') : 'N/A'
    aoa.push([
      codigoLucero(p.n_referencia),                    // CODIGO (vacío: lo genera Lucero)
      EMPRESA_LUCERO,                                  // EMPRESA (siempre fijo)
      oNA(p.telefono),                                 // TELEFONO
      oNA(p.direccion),                                // DIRECCION
      oNA(p.cliente_nombre),                           // NOMBRE Y APELLIDO
      ciudadParaPlanillaLucero(p.ciudad),              // CIUDAD (nombre oficial en mayúscula)
      'N/A',                                           // BARRIO (Shopify no lo pide)
      oNA(p.referencia_dir),                           // REFERENCIA (punto de referencia)
      1,                                               // CANTIDAD (siempre 1: es bultos, no unidades)
      oNA(p.esMultiProducto ? p.descripcionCombinada : getDesc(p.producto_nombre, p.cantidad)),     // PRODUCTO
      p.prepago ? 0 : (p.total || 0),                  // IMPORTE a cobrar
      oNA(p.fecha),                                    // FECHA
      'N/A',                                           // UBICACIÓN (no hay link de maps en Shopify)
      notas,                                           // NOTAS (aviso de pago + Ref del OS)
    ])
  })
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{wch:12},{wch:18},{wch:15},{wch:40},{wch:28},{wch:20},{wch:12},{wch:30},{wch:10},{wch:35},{wch:12},{wch:12},{wch:14},{wch:24}]
  // Teléfono como texto: si Excel lo toma como número le come el 0 inicial.
  pedidos.forEach((p, i) => {
    const cell = 'C' + (i + 2)
    if (ws[cell]) { ws[cell].t = 's'; ws[cell].z = '@' }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Hoja1')
  const refs = pedidos.map(p => p.n_referencia).filter(Boolean)
  XLSX.writeFile(wb, `Lucero_${refs[0]}-${refs[refs.length-1]}.xlsx`)
}

// ─── Generar y descargar Cabecera XLSX (formato Punto a Punto AC) ─
function descargarCabeceraXLSX(pedidos) {
  const headers = ['NOMBRE','CIUDAD','DIRECCIÓN','TELÉFONO','TIPO DE PRODUCTO','CANTIDAD DE BULTOS','PRIORIDAD','FORMA DE PAGO','IMPORTE','N° REFERENCIA','DESCRIPCION']
  const aoa = [headers]
  pedidos.forEach(p => {
    const refNum = parseInt(p.n_referencia)
    aoa.push([
      p.cliente_nombre, p.ciudad, p.direccion, p.telefono,
      p.esMultiProducto ? p.tipoCombinado : getTipo(p.producto_nombre),
      1,
      p.prepago ? 'urgente' : null,                          // prepago = prioridad urgente
      p.prepago ? 'ya esta pagado' : 'efectivo a cobrar',    // forma de pago
      p.prepago ? 0 : p.total,                               // importe a cobrar (0 si ya pagó)
      isNaN(refNum) ? p.n_referencia : refNum,
      p.esMultiProducto ? p.descripcionCombinada : getDesc(p.producto_nombre, p.cantidad),
    ])
  })
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{wch:28},{wch:15},{wch:40},{wch:15},{wch:20},{wch:15},{wch:12},{wch:18},{wch:12},{wch:12},{wch:35}]
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

  // ── Helpers de etiqueta ──
  const GRIS = '5A5A5A'
  const ANCHO_LABEL = convertMillimetersToTwip(26)
  const ANCHO_VALOR = convertMillimetersToTwip(68)
  const SIN_BORDE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
  const BORDES_TABLA = { top: SIN_BORDE, bottom: SIN_BORDE, left: SIN_BORDE, right: SIN_BORDE, insideHorizontal: SIN_BORDE, insideVertical: SIN_BORDE }

  // Fila "TÍTULO   valor" de la tabla de datos
  const fila = (titulo, valor, opciones = {}) => new TableRow({
    children: [
      new TableCell({
        width: { size: ANCHO_LABEL, type: WidthType.DXA },
        borders: BORDES_TABLA,
        margins: { top: 46, bottom: 46, left: 0, right: 60 },
        children: [new Paragraph({ spacing: { after: 0 }, children: [
          new TextRun({ text: titulo, bold: true, size: 18, color: GRIS, characterSpacing: 12 }),
        ] })],
      }),
      new TableCell({
        width: { size: ANCHO_VALOR, type: WidthType.DXA },
        borders: BORDES_TABLA,
        margins: { top: 46, bottom: 46, left: 0, right: 0 },
        children: [new Paragraph({ spacing: { after: 0 }, children: [
          new TextRun({ text: String(valor || '—'), size: opciones.destacado ? 28 : 25, bold: !!opciones.destacado }),
        ] })],
      }),
    ],
  })

  // Título de sección con línea inferior
  const seccion = (texto) => new Paragraph({
    spacing: { before: 90, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '333333' } },
    children: [new TextRun({ text: texto, bold: true, size: 20, color: '222222', characterSpacing: 40 })],
  })

  const tabla = (filas) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [ANCHO_LABEL, ANCHO_VALOR],
    borders: BORDES_TABLA,
    rows: filas,
  })

  const children = []
  pedidos.forEach((p, i) => {
    // ── REMITENTE ──
    children.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [new TextRun({ text: 'FACIAL WELLNESS', bold: true, size: 34 })],
      }),
      new Paragraph({
        spacing: { after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '000000' } },
        children: [new TextRun({ text: 'Ciudad del Este  ·  CI 6.103.233  ·  Tel. 0985-914-500', size: 18, color: GRIS })],
      }),
    )

    // ── CÓDIGO DE BARRAS ──
    const codigo = codigoPedido(p.n_referencia, p.fecha)
    const bc = codigo ? generarBarcodePNG(codigo, { height: 62, fontSize: 18 }) : null
    if (bc) {
      const ANCHO_MAX = 330 // px ≈ 87mm, entra cómodo en los 94mm útiles
      const escala = Math.min(1.6, ANCHO_MAX / bc.width)
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60, after: 40 },
        children: [new ImageRun({
          type: 'png',
          data: bc.data,
          transformation: { width: Math.round(bc.width * escala), height: Math.round(bc.height * escala) },
        })],
      }))
    } else {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60, after: 40 },
        children: [new TextRun({ text: '— PEDIDO SIN REFERENCIA —', bold: true, size: 20, color: 'AA0000' })],
      }))
    }

    // ── TRANSPORTADORA ──
    // Va grande y arriba: es lo que mira el que arma los paquetes para separar
    // la pila de PAP de la de Lucero.
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 40, after: 80 },
      children: [new TextRun({
        text: `TRANSPORTADORA: ${labelTransportadora(p.transportadora)}`,
        bold: true, size: 26,
      })],
    }))

    // ── DESTINATARIO ──
    children.push(
      seccion('DESTINATARIO'),
      tabla([
        fila('NOMBRE', p.cliente_nombre, { destacado: true }),
        fila('DIRECCIÓN', p.direccion),
        fila('CIUDAD', p.ciudad, { destacado: true }),
        fila('TELÉFONO', p.telefono),
      ]),
    )

    // ── PEDIDO ──
    children.push(
      seccion('PEDIDO'),
      tabla([
        fila('PRODUCTO', p.esMultiProducto ? p.tipoCombinado : getTipo(p.producto_nombre), { destacado: true }),
        p.esMultiProducto
          ? fila('DETALLE', p.descripcionCombinada)
          : fila('CANTIDAD', `${p.cantidad || 1} unidad${(p.cantidad || 1) === 1 ? '' : 'es'}`),
        fila('REFERENCIA', codigo || p.n_referencia || '—'),
      ]),
    )

    // ── Recuadro de cobro: COD normal o YA PAGADO ──
    const B = { style: BorderStyle.SINGLE, size: 10, color: '000000' }
    if (p.prepago) {
      // Pago anticipado: el repartidor NO cobra nada. Sin monto para no confundir.
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 100, after: 0 },
          border: { top: B, left: B, right: B },
          children: [new TextRun({ text: 'YA PAGADO', bold: true, size: 34, color: '1a7a3a' })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 20, after: 50 },
          border: { bottom: B, left: B, right: B },
          children: [new TextRun({ text: 'NO COBRAR — ENTREGAR', bold: true, size: 20, color: '1a7a3a', characterSpacing: 20 })],
        }),
      )
    } else {
      // Contra entrega (COD): el repartidor cobra el monto.
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 100, after: 0 },
          border: { top: B, left: B, right: B },
          children: [new TextRun({ text: 'A COBRAR CONTRA ENTREGA', bold: true, size: 18, color: '222222', characterSpacing: 30 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 30, after: 50 },
          border: { bottom: B, left: B, right: B },
          children: [new TextRun({ text: `Gs. ${Number(p.total || 0).toLocaleString('es-PY')}`, bold: true, size: 40 })],
        }),
      )
    }

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

// ─── Map venta DB → formato pedido (para XLSX/DOCX) ─────
function ventaAPedido(v) {
  // Si la venta ya tiene transportadora guardada (despachada antes), se respeta.
  // Si no, se sugiere por ciudad — así las ventas viejas también salen ruteadas.
  const sug = sugerirTransportadora(v.ciudad || '', v.producto_nombre || '')
  const transportadora = v.transportadora || sug.transportadora
  return {
    n_referencia: v.n_referencia || '',
    cliente_nombre: v.cliente_nombre || '—',
    ciudad: v.ciudad || '',
    departamento: '',
    direccion: v.cliente_direccion || '',
    referencia_dir: '',
    telefono: v.cliente_telefono || '',
    producto_nombre: v.producto_nombre || '',
    cantidad: v.cantidad || 1,
    total: v.total || 0,
    fecha: v.fecha || '',
    estado_releasit: v.estado_releasit || '',
    cfg: ESTADO_CONFIG[v.estado_releasit] || ESTADO_CONFIG['pending'],
    despachar: transportadora != null,
    faltantes: [],
    transportadora,
    motivoTransportadora: sug.motivo,
    bloqueadoPorProducto: !!sug.bloqueadoPorProducto,
    costo_envio: v.costo_envio ?? sug.tarifa,
  }
}

// ═══════════════════════════════════════════════════════════
// COMPONENTE
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// MODAL DE CORRECCIÓN DE PEDIDO
//
// Los datos vienen del checkout de Shopify o de un texto de WhatsApp, así que
// los escribe el cliente: ciudades mal escritas, teléfonos incompletos,
// direcciones a medias. Corregirlos ANTES de cargar la venta evita despachar
// a la ciudad equivocada (y pagar la tarifa equivocada).
//
// La ciudad se elige de una lista de ciudades conocidas en vez de tipear
// libre: si se corrige un typo con otro typo, el pedido queda sin cobertura y
// el problema se traslada en vez de resolverse.
// ═══════════════════════════════════════════════════════════
function ModalEditarPedido({ pedido, onGuardar, onCerrar }) {
  const [f, setF] = useState({
    cliente_nombre: pedido.cliente_nombre || '',
    telefono: pedido.telefono || '',
    ciudad: pedido.ciudad || '',
    direccion: pedido.direccion || '',
    referencia_dir: pedido.referencia_dir || '',
    cantidad: pedido.cantidad || 1,
    total: pedido.total || 0,
  })
  const ciudades = useMemo(() => ciudadesConocidas(), [])
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }))

  // Efecto de la ciudad elegida: se muestra ANTES de guardar, para que la
  // corrección sea una decisión informada y no a ciegas.
  const cobertura = useMemo(() => coberturaCiudad(f.ciudad), [f.ciudad])
  const sug = useMemo(
    () => sugerirTransportadora(f.ciudad, pedido.producto_nombre),
    [f.ciudad, pedido.producto_nombre]
  )
  const cambioCiudad = f.ciudad !== (pedido.ciudad || '')

  return (
    <div className="modal-overlay" onClick={onCerrar}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 15 }}>
            Corregir pedido {pedido.n_referencia ? `#${pedido.n_referencia}` : ''}
          </h3>
          <button className="btn btn-ghost btn-sm" onClick={onCerrar}><X size={15} /></button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label className="form-label">Nombre y apellido</label>
            <input className="form-input" value={f.cliente_nombre} onChange={e => set('cliente_nombre', e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label className="form-label">Teléfono</label>
              <input className="form-input" value={f.telefono} onChange={e => set('telefono', e.target.value)} placeholder="0981234567" />
            </div>
            <div>
              <label className="form-label">Ciudad</label>
              <input
                className="form-input" list="ciudades-conocidas"
                value={f.ciudad} onChange={e => set('ciudad', e.target.value)}
                placeholder="Empezá a escribir…"
              />
              <datalist id="ciudades-conocidas">
                {ciudades.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>
          </div>
          <div>
            <label className="form-label">Dirección</label>
            <input className="form-input" value={f.direccion} onChange={e => set('direccion', e.target.value)} />
          </div>
          <div>
            <label className="form-label">Referencia de la dirección <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(opcional)</span></label>
            <input className="form-input" value={f.referencia_dir} onChange={e => set('referencia_dir', e.target.value)} placeholder="frente a la farmacia…" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label className="form-label">Cantidad</label>
              <input className="form-input" type="number" min="1" value={f.cantidad} onChange={e => set('cantidad', parseInt(e.target.value) || 1)} />
            </div>
            <div>
              <label className="form-label">Total a cobrar</label>
              <input className="form-input" type="number" value={f.total} onChange={e => set('total', parseInt(e.target.value) || 0)} />
            </div>
          </div>

          {/* Efecto de la corrección de ciudad */}
          {cambioCiudad && (
            <div style={{
              padding: '10px 12px', borderRadius: 8, fontSize: 12,
              border: `1px solid ${sug.transportadora ? 'var(--border)' : 'var(--red)'}`,
              background: 'var(--bg-hover)',
            }}>
              {sug.transportadora ? (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>
                    Pasa a {labelTransportadora(sug.transportadora)}
                    {sug.tarifa != null ? ` · ${formatGs(sug.tarifa)}` : ''}
                  </div>
                  <div style={{ color: 'var(--text-muted)' }}>{sug.motivo}</div>
                </>
              ) : (
                <div style={{ color: 'var(--red)', fontWeight: 600 }}>
                  Ninguna transportadora cubre esa ciudad — el pedido no se va a poder despachar.
                </div>
              )}
              <div style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: 11 }}>
                Cobertura: {cobertura.pap ? 'PaP ✓' : 'PaP ✗'} · {cobertura.lucero ? `Lucero ✓ (${formatGs(cobertura.tarifaLucero)})` : 'Lucero ✗'}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
          <button className="btn btn-primary" onClick={() => onGuardar(f)}>Guardar corrección</button>
        </div>
      </div>
    </div>
  )
}

export default function DespachoPagina() {
  const { toast } = useToast()
  const fileRef = useRef()

  // ── Estado CSV ─────────────────────────────────────────
  const [todos, setTodos] = useState([])
  const [cargando, setCargando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [step, setStep] = useState('upload')
  const [busqueda, setBusqueda] = useState('')
  const [nombreArchivo, setNombreArchivo] = useState('')

  // ── Modo (CSV / Ventas) ────────────────────────────────
  const [modo, setModo] = useState('csv')
  const [textoManual, setTextoManual] = useState('')
  const [procesandoManual, setProcesandoManual] = useState(false)
  const [modalSalida, setModalSalida] = useState(false)

  // ── Estado Desde Ventas ────────────────────────────────
  const [ventasPend, setVentasPend] = useState([])
  const [selVentas, setSelVentas] = useState(new Set())
  const [cargVentas, setCargVentas] = useState(false)
  const [busqVentas, setBusqVentas] = useState('')

  // ── Memos CSV ──────────────────────────────────────────
  // Pedidos que el usuario fuerza a despachar aunque la ciudad no matchee
  // cobranza (porque él sabe que PaP igual llega, o corrigió el nombre).
  const [forzados, setForzados] = useState(new Set())

  // Pedidos que el cliente PAGÓ POR ADELANTADO (transferencia verificada en
  // WhatsApp). El repartidor no cobra: la guía dice "YA PAGADO" y la cabecera
  // va con importe 0. El usuario los marca a mano acá.
  const [prepagos, setPrepagos] = useState(new Set())

  // Historial de riesgo de clientes (tel normalizado → historial). Se llena al
  // cargar el CSV. Vacío = todos OK (sin datos, beneficio de la duda).
  const [historialRiesgo, setHistorialRiesgo] = useState(new Map())
  // Pedidos que el admin habilitó manualmente pese al riesgo (override).
  const [riesgoHabilitado, setRiesgoHabilitado] = useState(new Set())
  // Transportadora elegida a mano por pedido (pisa la sugerencia automática).
  const [transpOverride, setTranspOverride] = useState({})
  // Costo de flete tipeado a mano cuando la transportadora es 'otra' (no hay
  // tarifario para un courier arbitrario).
  const [costoOtraManual, setCostoOtraManual] = useState({})
  // Correcciones hechas a mano sobre un pedido del CSV/WhatsApp antes de
  // cargarlo (típico: el cliente escribió mal su ciudad). Se guardan por
  // referencia y se aplican en el memo, así el ruteo se RECALCULA con el dato
  // corregido en vez de quedar con la transportadora de la ciudad equivocada.
  const [ediciones, setEdiciones] = useState({})
  const [editando, setEditando] = useState(null)   // pedido abierto en el modal
  // Historial de entrega por ciudad + ciudades forzadas a mano por el admin.
  const [historialCiudad, setHistorialCiudad] = useState(new Map())
  const [ciudadHabilitada, setCiudadHabilitada] = useState(new Set())

  // Aplica los overrides: despacho forzado + marca de prepago + riesgo cliente.
  const todosConOverride = useMemo(
    () => todos.map(pOriginal => {
      // 1) Se aplican las correcciones manuales ANTES de cualquier cálculo.
      const edit = ediciones[pOriginal.n_referencia]
      let p = edit ? { ...pOriginal, ...edit } : pOriginal
      // 2) Si se corrigió la ciudad, el ruteo se recalcula por completo: la
      //    ciudad decide cobertura, transportadora y tarifa. Sin esto, el
      //    pedido quedaría con los datos de la ciudad equivocada.
      if (edit && edit.ciudad && edit.ciudad !== pOriginal.ciudad) {
        const sug = sugerirTransportadora(p.ciudad, p.producto_nombre)
        const faltantes = []
        if (!p.cliente_nombre) faltantes.push('nombre')
        if (!p.telefono) faltantes.push('teléfono')
        if (!p.direccion) faltantes.push('dirección')
        p = {
          ...p,
          transportadora: sug.transportadora,
          motivoTransportadora: sug.motivo,
          bloqueadoPorProducto: !!sug.bloqueadoPorProducto,
          costo_envio: sug.tarifa,
          cobranzaOk: sug.transportadora != null,
          faltantes,
          despachar: p.cfg?.despachar !== false && sug.transportadora != null && faltantes.length === 0,
        }
      }
      p = { ...p, editado: !!edit }
      const tel = normalizarTel(p.telefono)
      const ev = evaluarRiesgo(historialRiesgo.get(tel))
      const habilitado = riesgoHabilitado.has(p.n_referencia)
      // Un pedido bloqueado por riesgo NO se despacha salvo que el admin lo habilite.
      const bloqueadoPorRiesgo = ev.nivel === 'bloqueado' && !habilitado
      const despacharBase = (p.despachar || forzados.has(p.n_referencia))
      // Transportadora: la elegida a mano, o la sugerida por ciudad.
      const transportadora = transpOverride[p.n_referencia] || p.transportadora
      const tarifa = transportadora === 'otra'
        ? (parseInt(costoOtraManual[p.n_referencia]) || 0)
        : (transportadora ? tarifaDe(transportadora, p.ciudad) : null)
      // Riesgo de la CIUDAD con esa transportadora (0% de entrega = plata quemada).
      const evCiudad = evaluarCiudad(historialCiudad, p.ciudad, transportadora)
      const ciudadOk = ciudadHabilitada.has(p.n_referencia)
      const bloqueadoPorCiudad = evCiudad.nivel === 'bloqueado' && !ciudadOk
      return {
        ...p,
        riesgo: ev,
        riesgoHabilitado: habilitado,
        bloqueadoPorRiesgo,
        riesgoCiudad: evCiudad,
        ciudadHabilitada: ciudadOk,
        bloqueadoPorCiudad,
        despachar: despacharBase && !bloqueadoPorRiesgo && !bloqueadoPorCiudad,
        forzado: forzados.has(p.n_referencia),
        prepago: prepagos.has(p.n_referencia),
        transportadora,
        transpManual: !!transpOverride[p.n_referencia],
        // Si la transportadora elegida no cubre la ciudad, tarifa queda null y
        // se avisa en la UI en vez de guardar un costo inventado.
        costo_envio: tarifa,
      }
    }),
    [todos, forzados, prepagos, historialRiesgo, riesgoHabilitado, transpOverride, historialCiudad, ciudadHabilitada, costoOtraManual, ediciones]
  )

  const paraDespacho = useMemo(() => todosConOverride.filter(p => p.despachar), [todosConOverride])
  const excluidos = useMemo(() => todosConOverride.filter(p => !p.despachar), [todosConOverride])

  const toggleForzar = (ref) => {
    setForzados(prev => {
      const s = new Set(prev)
      if (s.has(ref)) s.delete(ref); else s.add(ref)
      return s
    })
  }

  const togglePrepago = (ref) => {
    setPrepagos(prev => {
      const s = new Set(prev)
      if (s.has(ref)) s.delete(ref); else s.add(ref)
      return s
    })
  }

  // El admin habilita (o vuelve a bloquear) un pedido marcado por riesgo.
  // Forzar el envío a una ciudad bloqueada (decisión consciente del admin).
  const toggleCiudad = (ref) => {
    setCiudadHabilitada(prev => {
      const s = new Set(prev)
      if (s.has(ref)) s.delete(ref); else s.add(ref)
      return s
    })
  }

  const toggleRiesgo = (ref) => {
    setRiesgoHabilitado(prev => {
      const s = new Set(prev)
      if (s.has(ref)) s.delete(ref); else s.add(ref)
      return s
    })
  }
  const stats = useMemo(() => ({
    confirmados: todos.filter(p => p.estado_releasit === 'confirmado').length,
    ayuda: todos.filter(p => p.estado_releasit === 'ayuda').length,
    pending: todos.filter(p => p.estado_releasit === 'pending').length,
    cancelados: todos.filter(p => p.estado_releasit === 'cancelado').length,
    // Confirmados/ayuda pero de ciudad SIN cobranza PaP (no se pueden despachar)
    // Confirmados/ayuda de ciudad SIN cobranza que NO fueron forzados a despachar
    fueraCobertura: todos.filter(p => p.cfg.despachar && !p.cobranzaOk && !forzados.has(p.n_referencia)).length,
    // De los que se despachan, cuántos pagaron por adelantado (transferencia)
    prepagos: paraDespacho.filter(p => p.prepago).length,
    montoPrepago: paraDespacho.filter(p => p.prepago).reduce((s, p) => s + (p.total || 0), 0),
    // Clientes riesgosos entre los pedidos del CSV
    bloqueados: todosConOverride.filter(p => p.riesgo?.nivel === 'bloqueado' && !p.riesgoHabilitado).length,
    enRiesgo: todosConOverride.filter(p => p.riesgo?.nivel === 'riesgo').length,
    total: todos.length,
    valorDespacho: paraDespacho.reduce((s, p) => s + p.total, 0),
    ticketProm: paraDespacho.length ? Math.round(paraDespacho.reduce((s, p) => s + p.total, 0) / paraDespacho.length) : 0,
  }), [todos, todosConOverride, paraDespacho, forzados])
  const porProducto = useMemo(() => {
    const m = {}
    paraDespacho.forEach(p => { const t = getTipo(p.producto_nombre); m[t] = (m[t] || 0) + p.cantidad })
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [paraDespacho])
  const porCiudad = useMemo(() => {
    const m = {}
    paraDespacho.forEach(p => { const c = p.ciudad || 'Sin ciudad'; m[c] = (m[c] || 0) + 1 })
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [paraDespacho])
  const conFaltantes = useMemo(() => paraDespacho.filter(p => p.faltantes.length > 0), [paraDespacho])
  const tablaFiltrada = useMemo(() => {
    if (!busqueda.trim()) return todosConOverride
    const q = busqueda.toLowerCase()
    return todosConOverride.filter(p =>
      p.cliente_nombre.toLowerCase().includes(q) ||
      p.ciudad.toLowerCase().includes(q) ||
      p.n_referencia.includes(q) ||
      p.telefono.includes(q) ||
      getTipo(p.producto_nombre).toLowerCase().includes(q)
    )
  }, [todosConOverride, busqueda])

  // ── Procesar el texto pegado de WhatsApp → pedidos ──────
  const procesarPedidosManual = async () => {
    const bloques = dividirBloquesManual(textoManual)
    if (!bloques.length) {
      toast('No se encontró ningún pedido — cada uno necesita "Nombre completo:"', 'error')
      return
    }
    setProcesandoManual(true)
    try {
      const { data: catalogo } = await supabase
        .from('productos').select('id, nombre, costo_unit, grupo_envio, precio_1u, precio_2u, precio_3u')
        .eq('activo', true)

      // Próximo número de la serie WA-: se toma el mayor ya usado en toda la
      // base (no solo lo que está en pantalla) para no repetir nunca, ni
      // siquiera entre sesiones distintas.
      const { data: existentes } = await supabase
        .from('ventas').select('n_referencia').ilike('n_referencia', 'WA-%')
      let siguiente = 1
      for (const v of (existentes || [])) {
        const n = parseInt(String(v.n_referencia).replace(/^WA-/i, ''), 10)
        if (!isNaN(n) && n >= siguiente) siguiente = n + 1
      }

      const pedidos = bloques.map(bloque => {
        const nRef = `WA-${String(siguiente).padStart(4, '0')}`
        siguiente++
        return parsearPedidoManual(bloque, catalogo || [], nRef)
      })

      setTodos(pedidos)
      setStep('preview')
      toast(`${pedidos.length} pedido${pedidos.length > 1 ? 's' : ''} procesado${pedidos.length > 1 ? 's' : ''}`, 'success')
    } catch (e) {
      toast('Error procesando el texto: ' + e.message, 'error')
    } finally {
      setProcesandoManual(false)
    }
  }

  // ── Memos Ventas ───────────────────────────────────────
  const ventasFiltradas = useMemo(() => {
    if (!busqVentas.trim()) return ventasPend
    const q = busqVentas.toLowerCase()
    return ventasPend.filter(v =>
      (v.cliente_nombre || '').toLowerCase().includes(q) ||
      (v.ciudad || '').toLowerCase().includes(q) ||
      (v.n_referencia || '').includes(q) ||
      (v.cliente_telefono || '').includes(q) ||
      (v.producto_nombre || '').toLowerCase().includes(q)
    )
  }, [ventasPend, busqVentas])
  const pedidosSeleccionados = useMemo(
    () => ventasPend.filter(v => selVentas.has(v.id)).map(ventaAPedido),
    [ventasPend, selVentas]
  )
  const todosSeleccionados = ventasFiltradas.length > 0 && ventasFiltradas.every(v => selVentas.has(v.id))
  const valorSeleccionado = pedidosSeleccionados.reduce((s, p) => s + p.total, 0)

  // ── Handlers CSV ───────────────────────────────────────
  const handleFile = (file) => {
    if (!file?.name.endsWith('.csv')) { toast('Solo archivos .csv', 'error'); return }
    setNombreArchivo(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      const rows = parseCSVRobust(e.target.result)
      const mapped = agruparFilasPorReferencia(rows).flatMap(mapearGrupoAPedidos).filter(p => p.producto_nombre)
      if (!mapped.length) { toast('No se encontraron pedidos válidos en el CSV', 'error'); return }
      setTodos(mapped)
      setStep('preview')
      setResultado(null)
      setBusqueda('')
      cargarHistorialRiesgo(mapped)  // evaluar riesgo de los clientes del CSV
      toast(`${mapped.length} pedidos procesados`, 'success')
    }
    reader.readAsText(file)
  }

  // Historial de riesgo de los clientes del CSV. Se cruza el teléfono de cada
  // pedido contra el historial de ventas/entregas para detectar clientes que
  // no reciben (devoluciones repetidas).
  const cargarHistorialRiesgo = async (pedidos) => {
    try {
      // Teléfonos únicos del CSV
      const tels = [...new Set(pedidos.map(p => normalizarTel(p.telefono)).filter(Boolean))]
      if (!tels.length) { setHistorialRiesgo(new Map()); return }

      // Traer las ventas históricas de esos clientes (columnas livianas)
      const ventasHist = await fetchAll(() => supabase.from('ventas')
        .select('cliente_telefono, n_referencia, estado, fecha, producto_nombre')
        .is('deleted_at', null).in('cliente_telefono', tels), { columnaOrden: 'fecha' })

      // Estado real de PaP para esas ventas (más preciso que ventas.estado)
      const refs = [...new Set((ventasHist || []).map(v => v.n_referencia).filter(Boolean))]
      let estadoPaP = {}
      if (refs.length) {
        try {
          const ents = await fetchAll(() => supabase.from('entregas')
            .select('n_referencia, nro_guia_ref, estado_pap, motivo')
            .in('n_referencia', refs), { columnaOrden: 'nro_guia_pap' })
          for (const eItem of (ents || [])) {
            const k = normRefRiesgo(eItem.n_referencia) || normRefRiesgo(eItem.nro_guia_ref)
            if (k) estadoPaP[k] = categoriaPaP(eItem.estado_pap, eItem.motivo)
          }
        } catch (err) { /* si falla, se usa ventas.estado */ }
      }
      setHistorialRiesgo(construirHistorialClientes(ventasHist || [], estadoPaP))
    } catch (e) {
      setHistorialRiesgo(new Map())  // ante cualquier error, no bloquear nada
    }

    // ── Historial de entrega POR CIUDAD (para bloquear ciudades que no entregan) ──
    // Se carga aparte y con su propio try: si falla, no se bloquea ninguna ciudad.
    try {
      const [ents, vts] = await Promise.all([
        fetchAllSafe(() => supabase.from('entregas').select('n_referencia, ciudad, estado_pap, motivo'), { columnaOrden: 'nro_guia_pap' }),
        fetchAllSafe(() => supabase.from('ventas').select('n_referencia, transportadora').is('deleted_at', null), { columnaOrden: 'n_referencia' }),
      ])
      const listaEnt = (ents?.data ?? ents) || []
      const listaVta = (vts?.data ?? vts) || []
      // La transportadora sale de la VENTA (ahí se decidió al despachar).
      const transpPorRef = {}
      listaVta.forEach(v => {
        const k = normRefRiesgo(v.n_referencia)
        if (k) transpPorRef[k] = v.transportadora || 'pap'
      })
      const paraHist = listaEnt.map(e => ({
        n_referencia: e.n_referencia,
        ciudad: e.ciudad,
        categoria: categoriaPaP(e.estado_pap, e.motivo),
      }))
      setHistorialCiudad(construirHistorialCiudades(paraHist, transpPorRef))
    } catch (e) {
      setHistorialCiudad(new Map())
    }
  }

  const cargarVentas = async () => {
    if (!paraDespacho.length) return
    setCargando(true)
    let ok = 0, fail = 0
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

    const refs = paraDespacho.map(p => p.n_referencia).filter(Boolean)
    // Se cuenta CUÁNTAS líneas de cada referencia ya existen en la base — no
    // un simple sí/no. Un pedido de 2 productos son 2 filas con la MISMA
    // referencia: con un Set booleano, la segunda línea se marcaría como
    // "duplicada" de la primera y se perdería. Contando, además, un CSV viejo
    // (de antes de este fix) que solo cargó la primera línea se puede volver
    // a subir para recuperar la línea que faltaba, sin duplicar la que ya está.
    let countExistentePorRef = new Map()
    try {
      const { data } = await supabase.from('ventas').select('n_referencia').in('n_referencia', refs)
      ;(data || []).forEach(d => {
        const r = String(d.n_referencia)
        countExistentePorRef.set(r, (countExistentePorRef.get(r) || 0) + 1)
      })
    } catch (e) { /* continuar sin filtro */ }

    // Set simple derivado del conteo — para el chequeo de "esta ref ya existe"
    // (marcar prepago en ventas ya cargadas), que no necesita el conteo fino.
    const refsExistentes = new Set(countExistentePorRef.keys())

    const vistosPorRef = new Map()   // cuántas líneas de esta ref ya se procesaron EN ESTE lote
    const nuevas = []
    const duplicados = []
    for (const p of paraDespacho) {
      const ref = String(p.n_referencia)
      const yaExistentes = countExistentePorRef.get(ref) || 0
      const vistasEnLote = vistosPorRef.get(ref) || 0
      if (vistasEnLote < yaExistentes) { duplicados.push(ref) }
      else { nuevas.push(p) }
      vistosPorRef.set(ref, vistasEnLote + 1)
    }

    // Ventas que YA estaban cargadas pero ahora marcaste como prepago:
    // actualizar su flag para que reportes y guías queden consistentes.
    const prepagoExistentes = paraDespacho
      .filter(p => p.prepago && refsExistentes.has(String(p.n_referencia)))
      .map(p => String(p.n_referencia))
    if (prepagoExistentes.length) {
      try {
        await supabase.from('ventas')
          .update({ pago_anticipado: true, metodo_pago_nombre: 'Transferencia (anticipado)' })
          .in('n_referencia', prepagoExistentes)
      } catch (e) { console.warn('No se pudo actualizar prepago existentes:', e?.message) }
    }

    if (!nuevas.length) {
      setResultado({ ok: 0, fail: 0, duplicados })
      setCargando(false)
      toast(`Todas ya estaban cargadas (${duplicados.length} duplicados)`, 'error')
      return
    }

    let catalogo = []
    try {
      const { data } = await supabase.from('productos').select('id, nombre, costo_unit').eq('activo', true)
      catalogo = data || []
    } catch (e) { /* sin catálogo, costo_prod=0 */ }

    const ventasArr = nuevas.map(p => {
      const prod = matchProducto(p.producto_nombre, catalogo)
      // ── Cierre automático: prepago + transportadora sin reporte ──
      // TSI, Multienvíos y cualquier courier convencional NO entregan reporte
      // de estados, así que estas ventas nunca podrían salir de 'pendiente':
      // no hay archivo que importar ni rendición que las cierre. Quedarían
      // restando flete sin sumar nunca el ingreso, hundiendo la ganancia.
      // Como además están 100% pagadas por adelantado (la plata YA entró y no
      // depende de que el cliente reciba), se marcan entregadas al despachar.
      // OJO: solo aplica a 'otra'. PaP y Lucero SÍ tienen reporte — esas se
      // cierran con el dato real, no por suposición.
      const cierreAutomatico = p.prepago && p.transportadora === 'otra'
      return {
        fecha: p.fecha,
        producto_nombre: prod ? prod.nombre : p.producto_nombre,
        cantidad: p.cantidad,
        precio_unit: p.total,
        total: p.total,
        n_referencia: p.n_referencia,
        estado: cierreAutomatico ? 'entregado' : 'pendiente',
        // Los pedidos cargados a mano NO vinieron de Shopify — dejarlos como
        // "Shopify Orgánico" ensuciaría cualquier reporte por canal de origen.
        canal_origen: p.origenManual ? 'WhatsApp' : 'Shopify Orgánico',
        ciudad: p.ciudad,
        cliente_nombre: p.cliente_nombre,
        cliente_telefono: p.telefono,
        cliente_direccion: p.direccion,
        producto_id: prod ? prod.id : null,
        costo_prod: prod ? (prod.costo_unit || 0) * (p.cantidad || 1) : 0,
        // Flete REAL de la transportadora elegida en ESA ciudad. Se congela acá:
        // si mañana cambia la tarifa, los reportes viejos no se mueven.
        costo_envio: p.costo_envio ?? tarifaDe(p.transportadora || 'pap', p.ciudad) ?? costoFleteActual(),
        transportadora: p.transportadora || 'pap',
        envio_cliente: 0,
        metodo_envio_nombre: (TRANSPORTADORAS[p.transportadora] || TRANSPORTADORAS.pap).nombre,
        metodo_pago_nombre: p.prepago ? 'Transferencia (anticipado)' : 'Efectivo COD',
        pago_anticipado: !!p.prepago,  // pagó por adelantado (transferencia verificada)
        estado_releasit: p.estado_releasit,
        // CI/RUC del pedido manual (columna opcional — ver nota de guardado tolerante abajo).
        notas: p.notas || null,
      }
    })
    for (let i = 0; i < ventasArr.length; i += 50) {
      let chunk = ventasArr.slice(i, i + 50)
      let { error } = await supabase.from('ventas').insert(chunk)
      // Guardado tolerante: si la tabla todavía no tiene la columna `notas`
      // (falta correr la migración), se reintenta sin ese campo en vez de
      // perder el lote entero — igual patrón que ya usamos para Lucero.
      if (error && /Could not find the '(\w+)' column/.test(error.message || '')) {
        const col = error.message.match(/Could not find the '(\w+)' column/)[1]
        chunk = chunk.map(r => { const o = { ...r }; delete o[col]; return o })
        ;({ error } = await supabase.from('ventas').insert(chunk))
      }
      if (error) fail += chunk.length
      else ok += chunk.length
    }

    // ── Placeholder en `entregas` para cada venta de Lucero ──
    // "Estilo Amazon": el envío existe para el sistema desde el momento en que
    // sale, no recién cuando Lucero te rinde. Sin esto, un paquete de Lucero es
    // invisible (no aparece en Entregas, tasa de entrega, nada) hasta que por
    // fin aparece en un archivo de rendición semanas después.
    // Best-effort: si falla, no bloquea el despacho — ventas ya se guardó bien.
    const deLuceroNuevas = ventasArr.filter(v => v.transportadora === 'lucero')
    if (deLuceroNuevas.length) {
      try {
        // Un pedido de varios productos genera varias filas de venta con la
        // MISMA referencia (ver fix de multi-producto). El placeholder es UNO
        // por paquete físico — si no se combinan acá antes del upsert,
        // Postgres rechaza el batch ENTERO por clave repetida ("ON CONFLICT
        // DO UPDATE command cannot affect row a second time"), y se pierde el
        // placeholder de ese pedido y de cualquier otro que compartiera el
        // mismo lote de 50.
        const porRef = new Map()
        for (const v of deLuceroNuevas) {
          const key = String(v.n_referencia)
          if (!porRef.has(key)) porRef.set(key, { ...v })
          else {
            const acc = porRef.get(key)
            acc.total = (acc.total || 0) + (v.total || 0)
            // Solo una línea lleva el flete real (las demás van en 0); el
            // máximo entre las líneas del pedido es ese valor real.
            acc.costo_envio = Math.max(acc.costo_envio || 0, v.costo_envio || 0)
          }
        }
        const placeholders = [...porRef.values()].map(placeholderEntregaLucero)
        for (let i = 0; i < placeholders.length; i += 50) {
          await supabase.from('entregas')
            .upsert(placeholders.slice(i, i + 50), { onConflict: 'nro_guia_pap' })
        }
      } catch (e) {
        console.warn('No se pudo crear el placeholder de Lucero en entregas:', e?.message)
      }
    }
    setResultado({ ok, fail, duplicados })
    setCargando(false)
    if (ok > 0) toast(`${ok} ventas cargadas${duplicados.length ? ` · ${duplicados.length} duplicados omitidos` : ''}`, 'success')
    if (fail > 0) toast(`${fail} fallaron`, 'error')
  }

  // Descarga una cabecera POR transportadora: cada una tiene su propio formato
  // y su propio panel. Si todos los pedidos van por la misma, baja un solo archivo.
  const descargarExcel = () => {
    if (!paraDespacho.length) return
    const colapsados = colapsarPorReferencia(paraDespacho)
    const dePaP = colapsados.filter(p => (p.transportadora || 'pap') === 'pap')
    const deLucero = colapsados.filter(p => p.transportadora === 'lucero')
    const deOtra = colapsados.filter(p => p.transportadora === 'otra')
    if (dePaP.length) descargarCabeceraXLSX(dePaP)
    if (deLucero.length) descargarCabeceraLuceroXLSX(deLucero)
    const partes = []
    if (dePaP.length) partes.push(`${dePaP.length} PAP`)
    if (deLucero.length) partes.push(`${deLucero.length} Lucero`)
    if (deOtra.length) partes.push(`${deOtra.length} Otra (sin cabecera, solo guía)`)
    toast(`Cabecera descargada — ${partes.join(' · ')}`, 'success')
  }

  // Un solo documento de guías (como se venía imprimiendo), pero ORDENADO por
  // transportadora: así salen de la impresora ya separadas en dos pilas.
  const descargarGuiasDoc = async () => {
    if (!paraDespacho.length) return
    try {
      const colapsados = colapsarPorReferencia(paraDespacho)
      const orden = { pap: 0, lucero: 1, otra: 2 }
      const ordenadas = [...colapsados].sort(
        (a, b) => (orden[a.transportadora] ?? 0) - (orden[b.transportadora] ?? 0)
      )
      await descargarGuiasDOCX(ordenadas)
      toast('Guías Word (.docx) descargadas', 'success')
    } catch (e) {
      toast('Error generando las guías: ' + e.message, 'error')
    }
  }

  const reset = () => { setTodos([]); setResultado(null); setStep('upload'); setBusqueda(''); setNombreArchivo('') }

  // ── Handlers Ventas ────────────────────────────────────
  const fetchVentasPendientes = async () => {
    setCargVentas(true)
    try {
      const { data, error } = await fetchAllSafe(() => supabase
        .from('ventas')
        .select('id, n_referencia, fecha, cliente_nombre, cliente_telefono, cliente_direccion, ciudad, producto_nombre, cantidad, total, estado_releasit')
        .eq('estado', 'pendiente')
        .order('fecha', { ascending: false }))
      if (error) throw error
      setVentasPend(data || [])
      setSelVentas(new Set())
      setBusqVentas('')
    } catch (e) {
      toast('Error al cargar ventas pendientes: ' + (e.message || ''), 'error')
    }
    setCargVentas(false)
  }

  const irAVentas = () => {
    setModo('ventas')
    if (!ventasPend.length && !cargVentas) fetchVentasPendientes()
  }

  const toggleSelVenta = (id) => {
    setSelVentas(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleTodosVentas = () => {
    if (todosSeleccionados) setSelVentas(new Set())
    else setSelVentas(new Set(ventasFiltradas.map(v => v.id)))
  }

  const descargarExcelVentas = async () => {
    if (!pedidosSeleccionados.length) { toast('Seleccioná al menos una venta', 'error'); return }
    const colapsados = colapsarPorReferencia(pedidosSeleccionados)
    const dePaP = colapsados.filter(p => (p.transportadora || 'pap') === 'pap')
    const deLucero = colapsados.filter(p => p.transportadora === 'lucero')
    if (dePaP.length) descargarCabeceraXLSX(dePaP)
    if (deLucero.length) descargarCabeceraLuceroXLSX(deLucero)
    // Backfill: si esta venta de Lucero es de antes de que existiera el
    // placeholder automático, se crea recién ahora. SOLO para las que todavía
    // no tienen fila en `entregas` — si ya se rindió, un upsert acá la
    // regresaría a "en camino" y le borraría que ya estaba cobrada.
    if (deLucero.length) {
      try {
        const claves = deLucero.map(p => guiaLucero(p.n_referencia))
        const { data: existentes } = await supabase.from('entregas')
          .select('nro_guia_pap').in('nro_guia_pap', claves)
        const yaExisten = new Set((existentes || []).map(e => e.nro_guia_pap))
        const faltantes = deLucero.filter(p => !yaExisten.has(guiaLucero(p.n_referencia)))
        if (faltantes.length) {
          const placeholders = faltantes.map(placeholderEntregaLucero)
          for (let i = 0; i < placeholders.length; i += 50) {
            await supabase.from('entregas')
              .upsert(placeholders.slice(i, i + 50), { onConflict: 'nro_guia_pap' })
          }
        }
      } catch (e) { console.warn('No se pudo backfillear placeholder de Lucero:', e?.message) }
    }
    const partes = []
    if (dePaP.length) partes.push(`${dePaP.length} PAP`)
    if (deLucero.length) partes.push(`${deLucero.length} Lucero`)
    const deOtraV = colapsados.filter(p => p.transportadora === 'otra')
    if (deOtraV.length) partes.push(`${deOtraV.length} Otra (sin cabecera, solo guía)`)
    toast(`Cabecera descargada — ${partes.join(' · ')}`, 'success')
  }

  const descargarGuiasVentas = async () => {
    if (!pedidosSeleccionados.length) { toast('Seleccioná al menos una venta', 'error'); return }
    try {
      const colapsados = colapsarPorReferencia(pedidosSeleccionados)
      const orden = { pap: 0, lucero: 1, otra: 2 }
      const ordenadas = [...colapsados].sort(
        (a, b) => (orden[a.transportadora] ?? 0) - (orden[b.transportadora] ?? 0)
      )
      await descargarGuiasDOCX(ordenadas)
      toast('Guías Word (.docx) descargadas', 'success')
    } catch (e) {
      toast('Error al generar las guías: ' + e.message, 'error')
    }
  }

  // ── Subtítulo dinámico ─────────────────────────────────
  const subtitle = modo === 'ventas'
    ? `${ventasPend.length} ventas pendientes en DB`
    : step === 'preview'
      ? `${modo === 'manual' ? 'Cargados por WhatsApp' : nombreArchivo} · ${todos.length} pedido${todos.length === 1 ? '' : 's'} procesado${todos.length === 1 ? '' : 's'}`
      : modo === 'manual'
        ? 'Pegá el pedido tal como te lo manda el cliente'
        : 'CSV de Shopify o selección manual desde Ventas'

  // ═══════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ─── HEADER con tab switcher ─────────────────────── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Despacho</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setModalSalida(true)} title="Escanear las cajas al entregarlas al courier">
            <ScanLine size={14} /> Confirmar salida
          </button>
          {/* Tab switcher */}
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <button
              onClick={() => setModo('csv')}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: modo === 'csv' ? 'var(--accent)' : 'var(--bg-card)',
                color: modo === 'csv' ? '#fff' : 'var(--text-secondary)',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <Upload size={12} /> Desde CSV
            </button>
            <button
              onClick={irAVentas}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600, border: 'none',
                borderLeft: '1px solid var(--border)', cursor: 'pointer',
                background: modo === 'ventas' ? 'var(--accent)' : 'var(--bg-card)',
                color: modo === 'ventas' ? '#fff' : 'var(--text-secondary)',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <ShoppingBag size={12} /> Desde Ventas
            </button>
            <button
              onClick={() => { setModo('manual'); setStep('upload') }}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600, border: 'none',
                borderLeft: '1px solid var(--border)', cursor: 'pointer',
                background: modo === 'manual' ? 'var(--accent)' : 'var(--bg-card)',
                color: modo === 'manual' ? '#fff' : 'var(--text-secondary)',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <MessageSquare size={12} /> WhatsApp
            </button>
          </div>
          {modo === 'csv' && step === 'preview' && (
            <button className="btn btn-ghost btn-sm" onClick={reset}><X size={13} /> Cargar otro CSV</button>
          )}
          {modo === 'manual' && step === 'preview' && (
            <button className="btn btn-ghost btn-sm" onClick={() => { reset(); setTextoManual('') }}><X size={13} /> Cargar otro pedido</button>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════
          MODO: DESDE VENTAS
      ═══════════════════════════════════════════════════ */}
      {modo === 'ventas' && (
        <>
          {/* Aviso: solo si hay ventas seleccionadas SIN dirección */}
          {(() => {
            const sinDir = pedidosSeleccionados.filter(p => !p.direccion).length
            if (selVentas.size === 0 || sinDir === 0) return null
            return (
              <div className="alert" style={{ background: 'var(--yellow-dim)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px' }}>
                <AlertTriangle size={14} color="var(--yellow)" style={{ flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  {sinDir} de las {selVentas.size} ventas seleccionadas no tienen dirección guardada (ventas viejas cargadas antes de esta función). En la Cabecera y las Guías ese campo saldrá vacío — completalo a mano en Excel, o editá la venta para cargarle la dirección.
                </span>
              </div>
            )
          })()}

          {/* Barra de acción */}
          <div className="card card-sm" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 16px' }}>
            <span style={{ fontSize: 13 }}>
              {selVentas.size > 0
                ? <><b style={{ color: 'var(--text-primary)' }}>{selVentas.size}</b><span style={{ color: 'var(--text-muted)' }}> seleccionadas</span> · <b style={{ color: 'var(--green)' }}>{formatGs(valorSeleccionado)}</b></>
                : <span style={{ color: 'var(--text-muted)' }}>{cargVentas ? 'Cargando…' : `${ventasPend.length} ventas pendientes`}</span>
              }
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={fetchVentasPendientes}
                disabled={cargVentas}
                style={{ display: 'flex', alignItems: 'center', gap: 5 }}
              >
                <RefreshCw size={12} style={{ animation: cargVentas ? 'spin 1s linear infinite' : 'none' }} />
                {cargVentas ? 'Cargando…' : 'Recargar'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={descargarExcelVentas}
                disabled={!selVentas.size}
                style={{ display: 'flex', alignItems: 'center', gap: 5 }}
              >
                <FileSpreadsheet size={12} /> Cabecera Excel
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={descargarGuiasVentas}
                disabled={!selVentas.size}
                style={{ display: 'flex', alignItems: 'center', gap: 5 }}
              >
                <FileText size={12} /> Guías Word
              </button>
            </div>
          </div>

          {/* Tabla de ventas pendientes */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Search size={13} color="var(--text-muted)" />
              <input
                value={busqVentas}
                onChange={e => setBusqVentas(e.target.value)}
                placeholder="Buscar nombre, ciudad, ref, teléfono, producto…"
                style={{ padding: '6px 10px', fontSize: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', width: 260 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                {ventasFiltradas.length} resultado{ventasFiltradas.length !== 1 ? 's' : ''}
              </span>
            </div>

            {cargVentas ? (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Cargando ventas pendientes…
              </div>
            ) : ventasFiltradas.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                {ventasPend.length === 0
                  ? 'No hay ventas en estado pendiente en la base de datos.'
                  : 'Sin resultados para esa búsqueda.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="tabla-responsive">
                  <thead>
                    <tr>
                      <th style={{ width: 40, textAlign: 'center', padding: '8px 8px 8px 16px' }}>
                        <input
                          type="checkbox"
                          checked={todosSeleccionados}
                          onChange={toggleTodosVentas}
                          title={todosSeleccionados ? 'Deseleccionar todos' : 'Seleccionar todos'}
                          style={{ cursor: 'pointer', accentColor: 'var(--accent)', width: 14, height: 14 }}
                        />
                      </th>
                      <th>Ref.</th>
                      <th>Fecha</th>
                      <th>Nombre</th>
                      <th>Ciudad</th>
                      <th>Dirección</th>
                      <th>Teléfono</th>
                      <th>Producto</th>
                      <th>Cant.</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ventasFiltradas.map(v => (
                      <tr
                        key={v.id}
                        onClick={() => toggleSelVenta(v.id)}
                        style={{
                          cursor: 'pointer',
                          background: selVentas.has(v.id) ? 'var(--accent-dim)' : 'transparent',
                          transition: 'background 0.1s',
                        }}
                      >
                        <td style={{ textAlign: 'center', padding: '8px 8px 8px 16px' }}>
                          <input
                            type="checkbox"
                            checked={selVentas.has(v.id)}
                            onChange={() => toggleSelVenta(v.id)}
                            onClick={e => e.stopPropagation()}
                            style={{ cursor: 'pointer', accentColor: 'var(--accent)', width: 14, height: 14 }}
                          />
                        </td>
                        <td data-label="Ref." className="mono">#{v.n_referencia}</td>
                        <td data-label="Fecha" className="muted" style={{ fontSize: 11 }}>{v.fecha}</td>
                        <td data-label="Nombre" style={{ fontWeight: 500 }}>{v.cliente_nombre || '—'}</td>
                        <td data-label="Ciudad" className="muted">{v.ciudad || '—'}</td>
                        <td data-label="Dirección" className="muted" style={{ maxWidth: 200, whiteSpace: 'normal', fontSize: 11 }}>
                          {v.cliente_direccion
                            ? v.cliente_direccion
                            : <span style={{ color: 'var(--yellow)' }} title="Sin dirección — completar en Excel o editar la venta">⚠ falta</span>}
                        </td>
                        <td data-label="Teléfono" className="muted">{v.cliente_telefono || '—'}</td>
                        <td data-label="Producto" style={{ fontSize: 12 }}>{getTipo(v.producto_nombre)}</td>
                        <td data-label="Cant.">{v.cantidad}</td>
                        <td data-label="Total" style={{ fontWeight: 600 }}>{formatGs(v.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════
          MODO: CSV — UPLOAD
      ═══════════════════════════════════════════════════ */}
      {modo === 'csv' && step === 'upload' && (
        <>
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
        </>
      )}

      {/* ═══════════════════════════════════════════════════
          MODO: MANUAL (WhatsApp) — PEGAR TEXTO
      ═══════════════════════════════════════════════════ */}
      {modo === 'manual' && step === 'upload' && (
        <>
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
              Pegá el pedido tal cual te lo pasa el cliente. Podés pegar varios seguidos, uno abajo del otro —
              cada uno arranca donde dice <b>"Nombre completo"</b>.
            </div>
            <textarea
              className="form-input"
              value={textoManual}
              onChange={e => setTextoManual(e.target.value)}
              placeholder={'Nombre completo: Natalia Vanessa Enciso Torres\nCI: 3698580\nCiudad: San Ignacio Misiones\nDirección exacta: Calle Tuyuti 845 entre Fulgencio Yegros e Iturbe\nNúmero de contacto: 0974320155\nProducto y cantidad: Limpiador de Lengua 1'}
              style={{ width: '100%', minHeight: 220, fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                className="btn btn-primary"
                disabled={procesandoManual || !textoManual.trim()}
                onClick={procesarPedidosManual}
              >
                {procesandoManual ? 'Procesando…' : 'Procesar pedido(s)'}
              </button>
            </div>
          </div>
          <div className="card card-sm" style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>
            <Info size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            Se asigna automáticamente una referencia <b>WA-0001, WA-0002...</b> — nunca choca con la numeración
            de Shopify (que es solo números). Se marca como <b>pago anticipado</b> por defecto: destildalo en la
            tabla si algún caso no lo es.
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════
          MODO: CSV / MANUAL — PREVIEW (comparten toda la tabla y el despacho)
      ═══════════════════════════════════════════════════ */}
      {(modo === 'csv' || modo === 'manual') && step === 'preview' && (
        <>
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

          {/* KPIs */}
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
              {stats.fueraCobertura > 0 && (
                <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'rgba(234,179,8,0.1)', border: '1px solid var(--yellow)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <MapPin size={16} color="var(--yellow)" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--yellow)' }}>{stats.fueraCobertura} pedido{stats.fueraCobertura === 1 ? '' : 's'} confirmado{stats.fueraCobertura === 1 ? '' : 's'} pero fuera de cobertura PaP.</strong> Punto a Punto no figura con cobranza en esas ciudades, así que no se despachan. Buscalos abajo marcados con 📍 — si sabés que PaP igual llega, tocá el botón para despacharlos igual.
                  </span>
                </div>
              )}
              {(stats.bloqueados > 0 || stats.enRiesgo > 0) && (
                <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid var(--red)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <AlertTriangle size={16} color="var(--red)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {stats.bloqueados > 0 && <><strong style={{ color: 'var(--red)' }}>{stats.bloqueados} pedido{stats.bloqueados === 1 ? '' : 's'} bloqueado{stats.bloqueados === 1 ? '' : 's'} por historial de no recepción.</strong> Esos clientes ya no recibieron varias veces — no se despachan. Buscalos con 🚫: podés habilitarlos bajo tu criterio o exigir pago anticipado. </>}
                    {stats.enRiesgo > 0 && <>{stats.bloqueados > 0 ? '' : <strong style={{ color: 'var(--yellow)' }}>Atención: </strong>}<span style={{ color: 'var(--yellow)' }}>{stats.enRiesgo} cliente{stats.enRiesgo === 1 ? '' : 's'} con algún antecedente (⚠) — conviene pedirles pago anticipado.</span></>}
                  </span>
                </div>
              )}
              {stats.prepagos > 0 && (
                <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: 'var(--green-dim)', border: '1px solid var(--green)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CheckCircle size={16} color="var(--green)" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    <strong style={{ color: 'var(--green)' }}>{stats.prepagos} pedido{stats.prepagos === 1 ? '' : 's'} pagado{stats.prepagos === 1 ? '' : 's'} por adelantado ({formatGs(stats.montoPrepago)}).</strong> En la guía dirán "YA PAGADO — NO COBRAR" y en la cabecera van con importe 0. El repartidor no cobra nada de esos.
                  </span>
                </div>
              )}
            </div>
          )}
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
                <div>
                  {resultado.ok > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      <CheckCircle size={14} /> {resultado.ok} cargadas {resultado.fail > 0 && <span style={{ color: 'var(--red)' }}>· {resultado.fail} fallaron</span>}
                    </div>
                  )}
                  {resultado.duplicados && resultado.duplicados.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 6, lineHeight: 1.4 }}>
                      ⚠ {resultado.duplicados.length} duplicado(s) ya cargado(s), omitidos:<br />
                      <span style={{ color: 'var(--text-muted)' }}>{resultado.duplicados.map(r => `#${r}`).join(', ')}</span>
                    </div>
                  )}
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
              <table className="tabla-responsive">
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
                    <th>Transportadora</th>
                    <th>Cliente</th>
                    <th>Despacho</th>
                    <th>Pago</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tablaFiltrada.map((p, i) => (
                    <tr key={i} style={{ opacity: p.despachar ? 1 : 0.45 }}>
                      <td data-label="Ref." className="mono">#{p.n_referencia}</td>
                      <td data-label="Fecha" className="muted" style={{ fontSize: 11 }}>{p.fecha}</td>
                      <td data-label="Nombre" style={{ fontWeight: 500 }}>
                        {p.cliente_nombre || '—'}
                        {p.faltantes.length > 0 && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--yellow)' }} title={`Falta ${p.faltantes.join(', ')}`}>⚠</span>}
                      </td>
                      <td data-label="Ciudad" className="muted">{p.ciudad || '—'}</td>
                      <td data-label="Teléfono" className="muted">{p.telefono || '—'}</td>
                      <td data-label="Producto" style={{ fontSize: 12 }}>{getTipo(p.producto_nombre)}</td>
                      <td data-label="Cant.">{p.cantidad}</td>
                      <td data-label="Total" style={{ fontWeight: 600 }}>{formatGs(p.total)}</td>
                      <td data-label="Estado">
                        <span style={{ fontSize: 11, fontWeight: 600, color: p.cfg.color, whiteSpace: 'nowrap' }}>
                          {p.cfg.label}
                        </span>
                      </td>
                      <td data-label="Transportadora" onClick={e => e.stopPropagation()}>
                        {(() => {
                          const disponibles = transportadorasDisponibles(p.ciudad)
                          if (!disponibles.length) {
                            return <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 600 }}>Sin cobertura</span>
                          }
                          const cubre = p.transportadora && disponibles.includes(p.transportadora)
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <select
                                className="form-input"
                                value={p.transportadora || ''}
                                onChange={e => {
                                  const val = e.target.value
                                  setTranspOverride(prev => ({ ...prev, [p.n_referencia]: val }))
                                  // Nudge: si se está pisando un bloqueo de producto a mano,
                                  // se sugiere pago anticipado (la razón de fondo del bloqueo
                                  // era justamente evitar mandar este producto en COD). Queda
                                  // togglear normal después si el admin decide lo contrario.
                                  if (!p.transportadora && p.bloqueadoPorProducto && !prepagos.has(p.n_referencia)) {
                                    togglePrepago(p.n_referencia)
                                  }
                                }}
                                style={{ fontSize: 11, padding: '3px 6px', height: 'auto', minWidth: 96 }}
                              >
                                {Object.values(TRANSPORTADORAS).map(t => (
                                  <option key={t.id} value={t.id}>
                                    {t.label}{disponibles.includes(t.id) ? '' : ' (no cubre)'}
                                  </option>
                                ))}
                              </select>
                              <span style={{ fontSize: 9, color: cubre ? 'var(--text-dim)' : 'var(--red)', whiteSpace: 'nowrap' }}>
                                {!p.transportadora && p.bloqueadoPorProducto
                                  ? 'Solo Lucero — no cubre acá'
                                  : !cubre
                                    ? 'No cubre esta ciudad'
                                    : p.transportadora === 'otra'
                                      ? null
                                      : `${formatGs(p.costo_envio || 0)}${p.transpManual ? ' · manual' : ''}`}
                              </span>
                              {p.transportadora === 'otra' && (
                                <input
                                  type="number"
                                  className="form-input"
                                  placeholder="Costo flete"
                                  value={costoOtraManual[p.n_referencia] ?? ''}
                                  onChange={e => setCostoOtraManual(prev => ({ ...prev, [p.n_referencia]: e.target.value }))}
                                  style={{ fontSize: 10, padding: '2px 6px', height: 'auto', width: 90 }}
                                />
                              )}
                              {!p.transportadora && p.bloqueadoPorProducto && (
                                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                                  Elegí transportadora a mano + marcá pago anticipado
                                </span>
                              )}
                              {p.riesgoCiudad?.nivel === 'bloqueado' && (
                                <button
                                  onClick={() => toggleCiudad(p.n_referencia)}
                                  title={p.riesgoCiudad.motivo}
                                  style={{
                                    fontSize: 9, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
                                    border: '1px solid var(--red)', whiteSpace: 'nowrap',
                                    background: p.ciudadHabilitada ? 'var(--red)' : 'transparent',
                                    color: p.ciudadHabilitada ? '#fff' : 'var(--red)',
                                  }}
                                >
                                  {p.ciudadHabilitada
                                    ? '⚠ Forzado'
                                    : `Ciudad ${Math.round((p.riesgoCiudad.tasa ?? 0) * 100)}% · forzar`}
                                </button>
                              )}
                              {p.riesgoCiudad?.nivel === 'riesgo' && (
                                <span style={{ fontSize: 9, color: 'var(--orange, #f59e0b)', whiteSpace: 'nowrap' }} title={p.riesgoCiudad.motivo}>
                                  {p.riesgoCiudad.alternativa
                                    ? `↔ Mejor por ${labelTransportadora(p.riesgoCiudad.alternativa.transportadora)} (${Math.round(p.riesgoCiudad.alternativa.tasa * 100)}%)`
                                    : `Ciudad ${Math.round((p.riesgoCiudad.tasa ?? 0) * 100)}% entrega`}
                                </span>
                              )}
                            </div>
                          )
                        })()}
                      </td>
                      <td data-label="Cliente">
                        {p.riesgo?.nivel === 'bloqueado' ? (
                          <button
                            onClick={() => toggleRiesgo(p.n_referencia)}
                            title={`${motivoRiesgo(p.riesgo)}\n\nClic para habilitar el despacho bajo tu criterio.`}
                            style={{ cursor: 'pointer', borderRadius: 20, padding: '3px 10px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
                              border: `1px solid ${p.riesgoHabilitado ? 'var(--green)' : 'var(--red)'}`,
                              background: p.riesgoHabilitado ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                              color: p.riesgoHabilitado ? 'var(--green)' : 'var(--red)' }}
                          >
                            {p.riesgoHabilitado ? '✓ Habilitado' : `🚫 ${p.riesgo.fallos}/${p.riesgo.pedidos} no recibió`}
                          </button>
                        ) : p.riesgo?.nivel === 'riesgo' ? (
                          <span
                            title={motivoRiesgo(p.riesgo)}
                            style={{ borderRadius: 20, padding: '3px 10px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                              background: 'rgba(234,179,8,0.15)', color: 'var(--yellow)', border: '1px solid var(--yellow)' }}
                          >
                            ⚠ {p.riesgo.fallos}/{p.riesgo.pedidos} · conviene prepago
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td data-label="Despacho">
                        {p.forzado ? (
                          <button
                            onClick={() => toggleForzar(p.n_referencia)}
                            title="Forzado por vos. Clic para volver a excluir."
                            style={{ cursor: 'pointer', border: '1px solid var(--green)', background: 'rgba(34,197,94,0.12)', color: 'var(--green)', borderRadius: 20, padding: '3px 10px', fontSize: 10, fontWeight: 700 }}
                          >
                            ✓ Despachar (forzado)
                          </button>
                        ) : p.despachar ? (
                          <span className="badge badge-green" style={{ fontSize: 10 }}>✓ Despachar</span>
                        ) : (p.cfg.despachar && !p.cobranzaOk) ? (
                          <button
                            onClick={() => toggleForzar(p.n_referencia)}
                            title="PaP no figura con cobranza en esta ciudad. Si sabés que igual llega, clic para despacharlo."
                            style={{ cursor: 'pointer', background: 'rgba(234,179,8,0.15)', color: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 20, padding: '3px 10px', fontSize: 10, fontWeight: 600 }}
                          >
                            📍 Sin cobranza · forzar
                          </button>
                        ) : (
                          <span className="badge badge-red" style={{ fontSize: 10 }}>✗ Excluido</span>
                        )}
                      </td>
                      <td data-label="" onClick={e => e.stopPropagation()} style={{ textAlign: 'right' }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setEditando(p)}
                          title="Corregir datos del pedido (ciudad, teléfono, dirección…)"
                          style={{ padding: '3px 7px' }}
                        >
                          <Edit2 size={13} />
                        </button>
                      </td>
                      <td data-label="Pago">
                        {p.despachar ? (
                          <button
                            onClick={() => togglePrepago(p.n_referencia)}
                            title={p.prepago ? 'Pagó por transferencia. Clic para volver a contra entrega.' : 'Marcar como pagado por adelantado (transferencia). El repartidor no cobra.'}
                            style={{
                              cursor: 'pointer', borderRadius: 20, padding: '3px 10px', fontSize: 10, fontWeight: 700,
                              display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                              border: `1px solid ${p.prepago ? 'var(--green)' : 'var(--border)'}`,
                              background: p.prepago ? 'rgba(34,197,94,0.12)' : 'transparent',
                              color: p.prepago ? 'var(--green)' : 'var(--text-muted)',
                            }}
                          >
                            {p.prepago ? '💳 Ya pagó' : '💳 Contra entrega'}
                          </button>
                        ) : (
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {editando && (
        <ModalEditarPedido
          pedido={editando}
          onCerrar={() => setEditando(null)}
          onGuardar={(campos) => {
            setEdiciones(prev => ({ ...prev, [editando.n_referencia]: campos }))
            setEditando(null)
            toast('Pedido corregido — se recalculó la transportadora', 'success')
          }}
        />
      )}

      {modalSalida && (
        <ModalSalida
          onClose={() => setModalSalida(false)}
          onConfirmado={() => { if (modo === 'ventas') fetchVentasPendientes() }}
        />
      )}
    </div>
  )
}
