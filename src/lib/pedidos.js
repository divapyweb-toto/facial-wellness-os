// src/lib/pedidos.js
// ═══════════════════════════════════════════════════════════
// PEDIDOS ABIERTOS — líneas libres, precio editable, mayoristas
//
// El sistema nació asumiendo que todo pedido era: 1 producto, cantidad 1 a 3,
// precio de lista. Dejó de ser cierto — hay mayoristas, upsells y descuentos.
//
// La regla que ordena todo esto: **la lista de precios es una SUGERENCIA, no
// una regla**. Precarga el valor y avisa si el cargado difiere, pero nunca
// bloquea: el que decide el precio es el dueño del negocio, no el software.
// ═══════════════════════════════════════════════════════════
import { supabase } from './supabase'

// ─── Precio sugerido para una cantidad ──────────────────────
// El catálogo tiene precio para 1, 2 y 3 unidades, y son el TOTAL del pack
// (no el precio unitario). Para cantidades mayores no hay escalera definida,
// así que se extrapola desde el tramo de 3: es una sugerencia razonable para
// arrancar, y el precio queda editable justamente porque un mayorista casi
// siempre se negocia aparte.
export function precioSugerido(producto, cantidad) {
  if (!producto) return 0
  const q = Math.max(1, parseInt(cantidad, 10) || 1)
  const p1 = producto.precio_1u || 0
  const p2 = producto.precio_2u || p1
  const p3 = producto.precio_3u || p2
  if (q === 1) return p1
  if (q === 2) return p2
  if (q === 3) return p3
  // 4 o más: se mantiene el precio por unidad del tramo de 3.
  return p3 > 0 ? Math.round((p3 / 3) * q) : p1 * q
}

// ─── Diferencia contra la lista ─────────────────────────────
// Devuelve null si coincide. Si difiere, describe cuánto y en qué sentido,
// para MOSTRARLO — nunca para impedir el guardado.
export function avisoPrecio(precioCargado, precioLista) {
  const cargado = Number(precioCargado) || 0
  const lista = Number(precioLista) || 0
  if (!lista || cargado === lista) return null
  const dif = cargado - lista
  const pct = Math.round((dif / lista) * 100)
  return {
    dif, pct,
    esDescuento: dif < 0,
    texto: dif < 0
      ? `${Math.abs(dif).toLocaleString('es-PY')} menos que la lista (${Math.abs(pct)}% de descuento)`
      : `${dif.toLocaleString('es-PY')} más que la lista (+${pct}%)`,
  }
}

// ─── Próxima referencia de la serie WA- ─────────────────────
// Los pedidos que no vienen de Shopify no tienen número propio, y Shopify
// sigue numerando de a 1 (2060, 2061...). Ponerles un número cualquiera
// chocaría tarde o temprano con un pedido real. El prefijo 'WA-' lo evita:
// un pedido de Shopify nunca tiene letras.
//
// Se busca el mayor ya usado en TODA la base, no solo lo que está en
// pantalla, para no repetir ni entre sesiones distintas.
export async function proximaReferenciaWA() {
  const { data } = await supabase.from('ventas').select('n_referencia').ilike('n_referencia', 'WA-%')
  let siguiente = 1
  for (const v of (data || [])) {
    const n = parseInt(String(v.n_referencia).replace(/^WA-/i, ''), 10)
    if (!isNaN(n) && n >= siguiente) siguiente = n + 1
  }
  return `WA-${String(siguiente).padStart(4, '0')}`
}

// ─── Totales de un pedido de varias líneas ──────────────────
// El envío se cuenta UNA vez por pedido, no por línea: es una sola caja
// física. Mismo criterio que usa Despacho al armar la cabecera del courier.
export function totalesPedido(lineas, { envioCliente = 0, costoEnvio = 0 } = {}) {
  const vivas = (lineas || []).filter(l => l.producto_id)
  const producto = vivas.reduce((s, l) => s + (Number(l.precio) || 0), 0)
  const lista = vivas.reduce((s, l) => s + (Number(l.precio_lista) || 0), 0)
  const costoProd = vivas.reduce((s, l) => s + (Number(l.costo_prod) || 0), 0)
  const total = producto + envioCliente
  return {
    lineas: vivas.length,
    unidades: vivas.reduce((s, l) => s + (parseInt(l.cantidad, 10) || 0), 0),
    producto, lista, costoProd, total,
    descuento: lista > 0 ? lista - producto : 0,
    // Contribución estimada: lo que entra menos producto y flete real.
    contribucion: total - costoProd - costoEnvio,
  }
}

// ─── Las filas que se guardan ───────────────────────────────
// Una fila de `ventas` POR LÍNEA, todas con la misma referencia — que es como
// el sistema ya guarda los pedidos multi-producto que llegan de Shopify.
// El envío (cobrado y costo) va SOLO en la primera: una caja, un flete.
// Contarlo en cada línea duplicaría el costo del pedido.
export function filasDeVenta(base, lineas, { envioCliente = 0, costoEnvio = 0 } = {}) {
  return (lineas || []).filter(l => l.producto_id).map((l, i) => ({
    ...base,
    producto_id: l.producto_id,
    producto_nombre: l.producto_nombre,
    cantidad: parseInt(l.cantidad, 10) || 1,
    precio_unit: Number(l.precio) || 0,
    precio_lista: Number(l.precio_lista) || null,
    total: (Number(l.precio) || 0) + (i === 0 ? envioCliente : 0),
    costo_prod: Number(l.costo_prod) || 0,
    costo_envio: i === 0 ? costoEnvio : 0,
    envio_cliente: i === 0 ? envioCliente : 0,
    stock_descontado: false,
  }))
}
