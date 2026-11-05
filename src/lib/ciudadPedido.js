// src/lib/ciudadPedido.js · 05-11-2026
// Qué ciudad usar para un pedido de Shopify en Despacho. El cliente escribe "Ciudad" en el formulario de Releasit
// y a veces pone el departamento o cualquier cosa ("Central", "Casa"); Shopify trae además el Shipping City, que el
// sistema corrige con el pin (pedidos-trabados, ciudad_desde_pin). Antes ganaba siempre lo escrito y el pedido quedaba
// sin cobertura aunque Shopify dijera Asunción (#1205 "Central", #1150 "Casa").
import { tarifaCourier, tarifasCourierCargadas } from './tarifasCourier'
import { transportadorasDisponibles } from './transportadoras'

// ¿La ciudad existe para algún courier? Con la tabla de tarifas cargada manda la tabla (PaP sin estimar o Lucero);
// sin la tabla, la lista vieja de couriers (con o sin cobranza).
export function ciudadReconocida(ciudad) {
  const c = String(ciudad ?? '').trim()
  if (!c) return false
  if (tarifasCourierCargadas()) {
    const pap = tarifaCourier('pap', c)
    return !!(pap && !pap.estimado) || !!tarifaCourier('lucero', c)
  }
  return transportadorasDisponibles(c, { cod: false }).some((t) => t !== 'otra')
}

// Lo escrito en la nota si se reconoce; si no, el Shipping City si se reconoce; si ninguno, lo que haya (la nota
// primero), para que "No sale hoy" muestre lo que escribió el cliente.
export function elegirCiudad(nota, envio, reconocida = ciudadReconocida) {
  const n = String(nota ?? '').trim()
  const e = String(envio ?? '').trim()
  if (n && reconocida(n)) return n
  if (e && reconocida(e)) return e
  return n || e
}
