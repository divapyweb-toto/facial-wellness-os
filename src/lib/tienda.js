// src/lib/tienda.js
// ═══════════════════════════════════════════════════════════
// TIENDA ACTIVA (Voltra / Facial Wellness / Todas)
//
// Las métricas de Voltra no se mezclan con las de Facial Wellness: cada pantalla
// de reportes lee solo la tienda elegida. La elección se recuerda en el
// navegador. Por defecto Voltra, que es la tienda activa.
// ═══════════════════════════════════════════════════════════
import { useSyncExternalStore } from 'react'

const CLAVE = 'fw-os-tienda'
export const TIENDAS = [
  { id: 'voltra', label: 'Voltra' },
  { id: 'fw', label: 'Facial Wellness' },
  { id: 'todas', label: 'Todas' },
]

const leer = () => {
  try { const v = localStorage.getItem(CLAVE); return TIENDAS.some(t => t.id === v) ? v : 'voltra' } catch { return 'voltra' }
}

let actual = leer()
const oyentes = new Set()

export const getTienda = () => actual

export function setTienda(t) {
  if (!TIENDAS.some(x => x.id === t) || t === actual) return
  actual = t
  try { localStorage.setItem(CLAVE, t) } catch { /* sin almacenamiento: queda solo en memoria */ }
  oyentes.forEach(f => f())
}

const suscribir = (f) => { oyentes.add(f); return () => oyentes.delete(f) }
export const useTienda = () => useSyncExternalStore(suscribir, getTienda)

// Tienda con la que se marca lo que se CREA desde una pantalla. En "Todas" no
// hay una sola tienda: se usa 'fw', que es el valor por defecto de la base.
export const tiendaParaEscribir = () => (actual === 'todas' ? 'fw' : actual)
