import { getVentanasRecompra } from './config'
import { getTienda } from './tienda'
// src/lib/recompra.js
// ═══════════════════════════════════════════════════════════
// MOTOR DE SEGMENTACIÓN DE RECOMPRA / CROSS-SELL
// Función pura y testeable. Decide a qué clientes contactar por WhatsApp
// para que vuelvan a comprar, en 3 grupos con prioridad 1 > 2 > 3.
//
// Decisiones de Enrique incorporadas:
//  - Gudair TAMBIÉN entra a reposición (el pack incluye tiras + parches).
//    Con la prioridad de grupos: 15-28 días → cross-sell Raspador; +28 → reponer.
//  - La ventana de reposición ESCALA con la cantidad comprada (28 días × unidades).
//  - Compras repetidas del mismo consumible → cuenta la entrega MÁS RECIENTE.
// ═══════════════════════════════════════════════════════════

export const DIAS_REPOSICION = 28
export const DIAS_CROSSSELL = 15
export const PRECIO_RECOMPRA = 69000
export const DIAS_COOLDOWN = 25

// Consumibles (se acaban → reposición)
const CONSUMIBLES = ['nasal', 'parche']

// Cross-sell por familia: producto comprado → familia a ofrecer
const CROSSSELL_MAP = {
  lengua:  'parche',
  jaw:     'nasal',
  botella: 'nasal',
  bebird:  'lengua',
  gudair:  'lengua',
}

// Nombres canónicos para mostrar (Bebird NUNCA se ofrece, solo se compra)
const NOMBRE = {
  nasal:   'Tiras Nasales',
  parche:  'Parches Bucales',
  lengua:  'Raspador de Lengua',
  jaw:     'JawFlex Pro',
  botella: 'Botella Flexible',
  gudair:  'Pack Gudair',
  bebird:  'Bebird Pro',
}

// Link directo al producto, por tienda y familia. Cada tienda tiene su
// dominio y sus handles: un cliente de Voltra no puede recibir un link de
// Facial Wellness. Familia sin producto en esa tienda → portada.
export const DOMINIO_TIENDA = {
  fw: 'https://facialwellnesspy.com',
  voltra: 'https://voltraparaguay.com',
}
const URL_PRODUCTO = {
  fw: {
    nasal:   'https://facialwellnesspy.com/products/tiras-nasales-30-unidades?variant=46259804930199',
    parche:  'https://facialwellnesspy.com/products/parches-bucales-30-unidades?variant=46259804536983',
    lengua:  'https://facialwellnesspy.com/products/raspador-de-lengua-facial-wellness-higiene-bucal-avanzada?variant=46521995952279',
    jaw:     'https://facialwellnesspy.com/products/ejercitadores-de-mandibula-pack-3-jawflex-pro?variant=46295196336279',
    botella: 'https://facialwellnesspy.com/products/gudair-botella-flexible-flow-500-%F0%9F%92%A7?variant=46892729270423',
    gudair:  'https://facialwellnesspy.com/products/pack-gudair-tira-nasal-parche-bucal-30-unidades-c-u?variant=46259805061271',
    bebird:  'https://facialwellnesspy.com/products/bebird-pro%E2%84%A2-limpieza-de-oidos-con-camara-hd-en-tiempo-real?variant=46462553129111',
  },
  // Handles leídos de la Admin API de Shopify de Voltra el 09-10-2026
  // (todos ACTIVE). Bebird no está en Voltra → portada.
  voltra: {
    nasal:   'https://voltraparaguay.com/products/tiras-nasales-gudair-30-unidades',
    parche:  'https://voltraparaguay.com/products/parches-bucales-gudair-30-unidades',
    lengua:  'https://voltraparaguay.com/products/raspador-de-lengua-de-acero-inoxidable',
    jaw:     'https://voltraparaguay.com/products/ejercitador-de-mandibula-3-niveles',
    botella: 'https://voltraparaguay.com/products/botella-flexible-gudair-500-ml',
    gudair:  'https://voltraparaguay.com/products/pack-gudair-tiras-nasales-parches-bucales',
  },
}

// 'todas' no es una tienda: se usa Voltra, la tienda activa.
export const tiendaReal = (t) => (t === 'fw' || t === 'voltra' ? t : 'voltra')

export function urlProducto(familia, tienda = getTienda()) {
  const t = tiendaReal(tienda)
  return URL_PRODUCTO[t][familia] || `${DOMINIO_TIENDA[t]}/`
}

// Clasifica cualquier nombre de producto en su familia.
// Misma lógica que el matcher de Importar/Despacho (probado con 500 pedidos),
// soporta nombres en español e inglés ("Nose Strips" = nasal, "Mouth Tape" = parche).
export function familiaProducto(nombre) {
  const n = (nombre || '').toLowerCase()
  if (!n) return null
  if (n.includes('gudair') || (n.includes('tira') && n.includes('parche'))) return 'gudair'
  if (n.includes('bebird')) return 'bebird'
  if (n.includes('raspador') || n.includes('lengua') || n.includes('limpiador') || n.includes('tongue') || n.includes('scraper')) return 'lengua'
  if (n.includes('parche') || n.includes('bucal') || n.includes('mouth') || n.includes('tape')) return 'parche'
  if (n.includes('tira') || n.includes('nasal') || n.includes('nose') || n.includes('strip')) return 'nasal'
  if (n.includes('jaw') || n.includes('mandíbula') || n.includes('mandibula') || n.includes('ejercitador')) return 'jaw'
  if (n.includes('botella') || n.includes('flexible') || n.includes('bottle') || n.includes('flow')) return 'botella'
  return null
}

// Día calendario en Paraguay (YYYY-MM-DD). Una fecha sola ('2026-10-01') ya
// es un día de Paraguay; un timestamp se pasa a la hora de Asunción.
const FMT_PY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Asuncion', year: 'numeric', month: '2-digit', day: '2-digit' })
export function diaPY(fecha) {
  if (typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha
  const d = fecha instanceof Date ? fecha : new Date(fecha)
  return Number.isNaN(d.getTime()) ? null : FMT_PY.format(d)
}

// Días entre dos días de Paraguay. Antes se restaba contra la medianoche UTC:
// de noche (21:00 PY en adelante) cada cliente sumaba un día de más.
export function diasDesde(hoy, fecha) {
  if (!fecha) return null
  const a = diaPY(hoy), b = diaPY(fecha)
  if (!a || !b) return null
  const utc = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))
  return Math.round((utc(a) - utc(b)) / 86400000)
}

function ofertaTexto(familiaOfrecida, esReposicion) {
  const nombre = NOMBRE[familiaOfrecida]
  return esReposicion ? `Reponer ${nombre}` : nombre
}

// ─── FUNCIÓN PRINCIPAL (pura) ───
// lineas: [{ telefono, nombre, familia, cantidad, fechaEntrega }]  (una por línea de venta entregada)
// excluidos: Set<string> de teléfonos contactados hace < 25 días (cooldown)
// hoy: Date  (inyectable para testear)
// tienda: tienda elegida arriba; si la línea trae su `tienda`, manda esa.
// → { g1, g2, g3 }  cada uno: [{ nombre, telefono, productoComprado, diasDesdeEntrega, grupo, ofertaSugerida }]
export function segmentarRecompra(lineas, excluidos = new Set(), hoy = new Date(), { tienda = getTienda() } = {}) {
  const { diasReposicion, diasCrosssell } = getVentanasRecompra()
  // Agrupar por teléfono. Saltar: sin teléfono, excluidos, producto no clasificable.
  const porCliente = new Map()
  for (const l of (lineas || [])) {
    const tel = (l.telefono || '').trim()
    if (!tel) continue
    if (excluidos.has(tel)) continue
    if (!l.familia) continue
    if (!porCliente.has(tel)) porCliente.set(tel, { nombre: l.nombre, lineas: [] })
    porCliente.get(tel).lineas.push(l)
  }

  const g1 = [], g2 = [], g3 = []

  for (const [tel, { nombre, lineas: ls }] of porCliente) {
    const compro = new Set(ls.map(l => l.familia))
    // Tienda del cliente: la de su pedido más reciente (si viene), si no la elegida.
    const ultima = ls.filter(l => l.tienda).sort((a, b) => String(b.fechaEntrega || '').localeCompare(String(a.fechaEntrega || '')))[0]
    const tiendaCli = tiendaReal(ultima?.tienda || tienda)
    const url = (fam) => urlProducto(fam, tiendaCli)
    const tieneGudair = compro.has('gudair')

    // ── Holdings de consumibles (para G1) ──
    // Lo que el cliente "tiene" de cada consumible: compra directa + (si Gudair) el pack incluye ambos.
    const holdings = { nasal: [], parche: [] }
    for (const l of ls) {
      const ev = { fechaEntrega: l.fechaEntrega, cantidad: l.cantidad || 1 }
      if (l.familia === 'nasal')  holdings.nasal.push(ev)
      if (l.familia === 'parche') holdings.parche.push(ev)
      if (l.familia === 'gudair') { holdings.nasal.push(ev); holdings.parche.push(ev) } // Gudair = tiras + parches
    }

    // Por cada consumible: entrega MÁS RECIENTE (fix repetidas) y ¿vencido? (ventana = 28 × cantidad)
    const vencido = {} // familia → { dias, fechaEntrega }
    for (const fam of CONSUMIBLES) {
      const evs = holdings[fam].filter(e => e.fechaEntrega)
      if (!evs.length) continue
      const reciente = evs.reduce((a, b) => new Date(a.fechaEntrega) >= new Date(b.fechaEntrega) ? a : b)
      const d = diasDesde(hoy, reciente.fechaEntrega)
      const ventana = diasReposicion * (reciente.cantidad || 1)
      if (d != null && d >= ventana) vencido[fam] = { dias: d, fechaEntrega: reciente.fechaEntrega }
    }

    // ── GRUPO 1: Reponer consumible (mayor prioridad) ──
    const vencidos = Object.keys(vencido)
    if (vencidos.length) {
      // Si ambos vencidos → el de entrega MÁS ANTIGUA (más urgente)
      const elegido = vencidos.length > 1
        ? vencidos.reduce((a, b) => new Date(vencido[a].fechaEntrega) <= new Date(vencido[b].fechaEntrega) ? a : b)
        : vencidos[0]
      g1.push({
        nombre, telefono: tel, tienda: tiendaCli,
        productoComprado: NOMBRE[elegido],
        productoOfrecido: NOMBRE[elegido],
        familiaOfrecida: elegido,
        urlOfrecido: url(elegido),
        diasDesdeEntrega: vencido[elegido].dias,
        grupo: 1,
        ofertaSugerida: ofertaTexto(elegido, true),
      })
      continue
    }

    // ── GRUPO 2: Completar combo sueño ──
    // Compró exactamente uno de {nasal, parche} (directo), NO el otro, NO Gudair, ≥15 días.
    const comproNasal = compro.has('nasal')
    const comproParche = compro.has('parche')
    if (!tieneGudair && (comproNasal !== comproParche)) {
      const famComprado = comproNasal ? 'nasal' : 'parche'
      const famFalta    = comproNasal ? 'parche' : 'nasal'
      const evs = holdings[famComprado].filter(e => e.fechaEntrega)
      const reciente = evs.reduce((a, b) => new Date(a.fechaEntrega) >= new Date(b.fechaEntrega) ? a : b)
      const d = diasDesde(hoy, reciente.fechaEntrega)
      if (d != null && d >= diasCrosssell) {
        g2.push({
          nombre, telefono: tel, tienda: tiendaCli,
          productoComprado: NOMBRE[famComprado],
          productoOfrecido: NOMBRE[famFalta],
          familiaOfrecida: famFalta,
          urlOfrecido: url(famFalta),
          diasDesdeEntrega: d,
          grupo: 2,
          ofertaSugerida: ofertaTexto(famFalta, false),
        })
        continue
      }
    }

    // ── GRUPO 3: Cross-sell durable ──
    // Compró un producto del mapa, ≥15 días. Si varios, el MÁS RECIENTE que igual supere 15.
    const candidatos = ls
      .filter(l => CROSSSELL_MAP[l.familia] && l.fechaEntrega)
      .map(l => ({ familia: l.familia, d: diasDesde(hoy, l.fechaEntrega) }))
      .filter(c => c.d != null && c.d >= diasCrosssell)
    if (candidatos.length) {
      const elegido = candidatos.reduce((a, b) => a.d <= b.d ? a : b) // más reciente
      g3.push({
        nombre, telefono: tel, tienda: tiendaCli,
        productoComprado: NOMBRE[elegido.familia],
        productoOfrecido: NOMBRE[CROSSSELL_MAP[elegido.familia]],
        familiaOfrecida: CROSSSELL_MAP[elegido.familia],
        urlOfrecido: url(CROSSSELL_MAP[elegido.familia]),
        diasDesdeEntrega: elegido.d,
        grupo: 3,
        ofertaSugerida: ofertaTexto(CROSSSELL_MAP[elegido.familia], false),
      })
      continue
    }
  }

  // Ordenar cada grupo por días desde entrega DESC (más viejo / más urgente arriba)
  const ordenar = arr => arr.sort((a, b) => b.diasDesdeEntrega - a.diasDesdeEntrega)
  return { g1: ordenar(g1), g2: ordenar(g2), g3: ordenar(g3) }
}
