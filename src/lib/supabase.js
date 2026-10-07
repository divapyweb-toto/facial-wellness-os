// src/lib/supabase.js
// IMPORTANTE: Reemplazar con tus credenciales de Supabase
// Las encontrás en: Supabase Dashboard → Settings → API

import { createClient } from '@supabase/supabase-js'
import { getTienda } from './tienda'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'TU_SUPABASE_URL'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'TU_SUPABASE_ANON_KEY'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 }
  }
})

// Cliente para las pantallas de MÉTRICAS: igual que `supabase`, pero cada
// lectura (`.select`) de una tabla con columna `tienda` trae solo la tienda
// elegida arriba (Voltra / Facial Wellness / Todas). Las escrituras no se
// tocan. Las pantallas operativas (Despacho, importadores, Rendición) siguen
// con `supabase` a secas: trabajan por referencia y no deben perder de vista
// los pedidos de la otra tienda (ej. al evitar duplicados).
const TABLAS_CON_TIENDA = new Set(['ventas', 'entregas', 'gastos', 'campanas_ads', 'recompra_log'])

const conTienda = (tabla) => {
  const base = supabase.from(tabla)
  return new Proxy(base, {
    get(obj, prop) {
      if (prop === 'select') {
        return (...args) => {
          const q = obj.select(...args)
          const t = getTienda()
          return t === 'todas' ? q : q.eq('tienda', t)
        }
      }
      const v = Reflect.get(obj, prop)
      return typeof v === 'function' ? v.bind(obj) : v
    },
  })
}

export const supabaseTienda = new Proxy(supabase, {
  get(obj, prop) {
    if (prop === 'from') return (tabla) => (TABLAS_CON_TIENDA.has(tabla) ? conTienda(tabla) : obj.from(tabla))
    const v = Reflect.get(obj, prop)
    return typeof v === 'function' ? v.bind(obj) : v
  },
})

// Helper: formatear guaraníes
export const formatGs = (amount) => {
  if (!amount && amount !== 0) return '—'
  return new Intl.NumberFormat('es-PY', {
    style: 'decimal',
    maximumFractionDigits: 0,
  }).format(amount) + ' Gs.'
}

// Helper: formatear porcentaje
export const formatPct = (value) => {
  if (!value && value !== 0) return '—'
  return Number(value).toFixed(1) + '%'
}

// Helper: formatear fecha
export const formatFecha = (dateStr) => {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('es-PY', { day: '2-digit', month: 'short', year: 'numeric' })
}

// Helper: mes actual en formato "YYYY-MM"
export const getMesActual = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// Helper: nombre del mes
export const getNombreMes = (mesStr) => {
  if (!mesStr) return ''
  const [year, month] = mesStr.split('-')
  const d = new Date(year, parseInt(month) - 1, 1)
  return d.toLocaleDateString('es-PY', { month: 'long', year: 'numeric' })
}

// Colores estado
export const estadoConfig = {
  pendiente: { label: 'Pendiente', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  entregado: { label: 'Entregado', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  devuelto: { label: 'Devuelto', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  en_tramite: { label: 'En trámite', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' },
}

// Estado por defecto para valores no mapeados (ventas viejas con 'en_proceso',
// 'en_transito', vacío, etc.). SIN esto, acceder a estadoConfig[estado].color
// cuando el estado no existe tira una excepción que rompe el render entero de
// la página — dejando solo el fondo oscuro del modal, sin contenido.
export const getEstadoConfig = (estado) => estadoConfig[estado] || {
  label: estado ? String(estado).replace(/_/g, ' ') : 'Sin estado',
  color: '#6b7280',
  bg: 'rgba(107,114,128,0.1)',
}
