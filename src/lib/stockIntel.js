// src/lib/stockIntel.js
// ═══════════════════════════════════════════════════════════
// Inteligencia de stock — reposición predictiva.
// Calcula la velocidad de venta de cada producto (unidades/día)
// mirando el historial reciente, y estima los días hasta agotar.
//
// Para combos: la velocidad se reparte a sus componentes
// (vender 1 Pack Gudair = consumir 1 tira + 1 parche).
// ═══════════════════════════════════════════════════════════
import { supabase } from './supabase'
import { calcularStockCombo } from './stockEngine'

// Estados que cuentan como "consumo real" de stock (salió del depósito y no volvió)
const ESTADOS_CONSUMO = ['pendiente', 'entregado', 'en_tramite']

// Calcula la velocidad de venta (unidades/día) por producto_id,
// usando los últimos `dias` días de ventas.
// Devuelve un Map: producto_id -> { unidades, velocidadDia }
export async function calcularVelocidades(productos, dias = 30) {
  const desde = new Date()
  desde.setDate(desde.getDate() - dias)
  const desdeStr = desde.toISOString().split('T')[0]

  const { data: ventas } = await supabase
    .from('ventas')
    .select('producto_id, cantidad, estado, fecha')
    .is('deleted_at', null)
    .gte('fecha', desdeStr)

  // Acumular unidades vendidas por producto (solo consumo real)
  const unidadesPorProducto = {}
  const productosById = productos.reduce((a, p) => { a[p.id] = p; return a }, {})

  for (const v of (ventas || [])) {
    if (!ESTADOS_CONSUMO.includes(v.estado)) continue
    const cant = v.cantidad || 1
    const prod = productosById[v.producto_id]
    if (!prod) continue

    if (prod.es_combo) {
      // Explotar el combo a sus componentes
      if (prod.componente_1_id) {
        unidadesPorProducto[prod.componente_1_id] = (unidadesPorProducto[prod.componente_1_id] || 0) + (prod.componente_1_qty || 1) * cant
      }
      if (prod.componente_2_id) {
        unidadesPorProducto[prod.componente_2_id] = (unidadesPorProducto[prod.componente_2_id] || 0) + (prod.componente_2_qty || 1) * cant
      }
    } else {
      unidadesPorProducto[v.producto_id] = (unidadesPorProducto[v.producto_id] || 0) + cant
    }
  }

  // Convertir a velocidad/día
  const velocidades = {}
  for (const [id, unidades] of Object.entries(unidadesPorProducto)) {
    velocidades[id] = { unidades, velocidadDia: unidades / dias }
  }
  return velocidades
}

// Para un producto, calcula días hasta agotar y nivel de urgencia.
// stockActual: para simples = su stock; para combos = stock calculado.
export function analizarReposicion(producto, velocidades, productosById, diasVentana = 30) {
  // Para combos, el "agotamiento" lo marca el componente que se agota antes
  if (producto.es_combo) {
    const comps = [
      { id: producto.componente_1_id, qty: producto.componente_1_qty || 1 },
      { id: producto.componente_2_id, qty: producto.componente_2_qty || 1 },
    ].filter(c => c.id)
    let peor = null
    for (const c of comps) {
      const comp = productosById[c.id]
      if (!comp) continue
      const a = analizarReposicion(comp, velocidades, productosById, diasVentana)
      if (!peor || a.diasRestantes < peor.diasRestantes) peor = a
    }
    return peor || { diasRestantes: Infinity, urgencia: 'ok', velocidadDia: 0, stock: 0 }
  }

  const stock = producto.stock_actual || 0
  const vel = velocidades[producto.id]?.velocidadDia || 0

  // Sin ventas en la ventana → no se puede predecir
  if (vel <= 0) {
    return { diasRestantes: Infinity, urgencia: stock === 0 ? 'agotado' : 'sin_datos', velocidadDia: 0, stock }
  }

  const diasRestantes = Math.floor(stock / vel)
  let urgencia
  if (stock === 0) urgencia = 'agotado'
  else if (diasRestantes <= 7) urgencia = 'critico'
  else if (diasRestantes <= 14) urgencia = 'pronto'
  else urgencia = 'ok'

  return { diasRestantes, urgencia, velocidadDia: vel, stock }
}

// Sugerencia de cuánto reponer: cubrir `diasObjetivo` de venta.
export function sugerirReposicion(producto, velocidades, productosById, diasObjetivo = 30) {
  const a = analizarReposicion(producto, velocidades, productosById)
  if (a.velocidadDia <= 0) return 0
  const necesario = Math.ceil(a.velocidadDia * diasObjetivo)
  const faltante = necesario - a.stock
  return Math.max(0, faltante)
}

// Etiquetas legibles para la UI
export const URGENCIA_CFG = {
  agotado:  { label: 'Agotado',     color: 'var(--red)',    prioridad: 0 },
  critico:  { label: 'Crítico',     color: 'var(--red)',    prioridad: 1 },
  pronto:   { label: 'Reponer pronto', color: 'var(--yellow)', prioridad: 2 },
  sin_datos:{ label: 'Sin ventas',  color: 'var(--text-muted)', prioridad: 4 },
  ok:       { label: 'OK',          color: 'var(--green)',  prioridad: 3 },
}
