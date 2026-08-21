// src/lib/reclamos.js
// ═══════════════════════════════════════════════════════════
// MENSAJE DE RECLAMO AL COURIER
//
// El objetivo es que el courier pueda ubicar el paquete SIN volver a
// preguntarte nada. Cada transportadora busca por un código distinto, así que
// hay un formato por cada una:
//
//   Punto a Punto → busca por su número de guía (ej. 26280786).
//   Lucero        → busca por el código FW-XXXX que le mandamos en la
//                   cabecera, y más rápido todavía por su EnvioID interno
//                   cuando lo tenemos.
//
// Si el pedido todavía no tiene guía (pasa cuando el paquete no entró aún al
// sistema del courier), NO se manda un mensaje con un campo vacío: se manda
// uno pidiendo que lo ubiquen por referencia, nombre y teléfono. Un reclamo
// sin código igual sirve; uno con "Guía: " vacío, no.
// ═══════════════════════════════════════════════════════════
import { guiaCourier, despachoPedido, fechaCorta, refMostrar } from './buscadorPedidos'

// ─── Motivos frecuentes ─────────────────────────────────────
// El orden es el de frecuencia real: el clic más común queda primero.
// `soloSiEntregado` marca el motivo que solo tiene sentido cuando el courier
// ya dio el paquete por entregado.
export const MOTIVOS = [
  { id: 'no_contactaron', texto: 'El cliente dice que nadie lo contactó todavía.' },
  { id: 'figura_entregado', texto: 'Figura como entregado pero el cliente no lo recibió.', soloSiEntregado: true },
  { id: 'demorado', texto: 'Lleva demasiados días sin novedad. Necesito saber dónde está.' },
  { id: 'reprogramar', texto: 'El cliente pide que se lo entreguen en otra fecha.' },
  { id: 'no_ubicaron', texto: 'Dicen que no ubicaron al cliente, pero el cliente estuvo esperando.' },
  { id: 'devolucion', texto: 'Necesito saber cuándo vuelve el paquete a mi depósito.' },
]

// Un producto por línea: "Parche Bucal x1 · Tiras nasales x2"
function textoProductos(p) {
  if (!p?.lineas?.length) return null
  return p.lineas
    .map(l => `${l.producto_nombre}${(l.cantidad || 1) > 1 ? ` x${l.cantidad}` : ''}`)
    .join(' · ')
}

function lineaDespacho(p) {
  const d = despachoPedido(p)
  if (!d.fecha) return null
  const dias = d.dias != null ? ` (${d.dias} ${d.dias === 1 ? 'día' : 'días'} atrás)` : ''
  // Cuando la fecha sale de la venta y no del despacho real, se dice. Pasarle
  // al courier una fecha que no es la del despacho arruina el reclamo.
  const aclara = d.exacta ? '' : ' — fecha del pedido, no del despacho'
  return `Despachado: ${fechaCorta(d.fecha)}${dias}${aclara}`
}

// ─── El mensaje ─────────────────────────────────────────────
// Devuelve el texto listo para pegar en el chat del courier.
export function mensajeReclamo(pedido, motivo) {
  const g = guiaCourier(pedido)
  const l = ['Reclamo de pedido']

  if (g.numero) {
    // Lucero llama "código" a lo que PaP llama "guía". Usar la palabra que
    // cada uno entiende evita el ida y vuelta de "¿qué número es ese?".
    l.push(`${pedido.transportadora === 'lucero' ? 'Código' : 'Guía'}: ${g.numero}`)
    if (g.extra) l.push(g.extra)
  } else {
    // Sin guía: se le dan todos los datos para que lo busque él.
    l.push('(Todavía no tengo el número de guía — te paso los datos para ubicarlo)')
    // Solo si es una referencia de verdad: mandarle 'Mi referencia: NO TIENE'
    // al courier es peor que no mandarle nada.
    if (pedido.ref) l.push(`Mi referencia: ${refMostrar(pedido.n_referencia)}`)
    if (pedido.cliente_telefono) l.push(`Teléfono: ${pedido.cliente_telefono}`)
  }

  // Sin nombre (paquetes que no cruzan con ninguna venta) la ciudad va sola y
  // etiquetada: 'Cliente: ASUNCION' se lee como si el cliente se llamara así.
  if (pedido.cliente_nombre) {
    l.push(`Cliente: ${[pedido.cliente_nombre, pedido.ciudad].filter(Boolean).join(' - ')}`)
  } else if (pedido.ciudad) {
    l.push(`Ciudad: ${pedido.ciudad}`)
  }

  const desp = lineaDespacho(pedido)
  if (desp) l.push(desp)

  const prods = textoProductos(pedido)
  if (prods) l.push(`Producto: ${prods}`)

  const m = String(motivo ?? '').trim()
  if (m) l.push(`Motivo: ${m}`)

  l.push('', '¿Me confirmás por favor? Gracias!')
  return l.join('\n')
}

// Copiar al portapapeles. `navigator.clipboard` necesita HTTPS y falla en
// algunos navegadores del celular, así que hay un plan B con un textarea
// oculto — si no, el botón principal de la pantalla queda muerto justo donde
// más se usa.
export async function copiarTexto(texto) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto)
      return true
    }
  } catch { /* sigue al plan B */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = texto
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
