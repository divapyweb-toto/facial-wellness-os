// src/lib/errorLog.js
// ═══════════════════════════════════════════════════════════
// Registro de errores visible — captura fallos sin romper la app.
// Uso: import { logError } from '../../lib/errorLog'
//      await logError('crear_venta', error, { ref: '1595' })
//
// Regla de oro: registrar un error NUNCA debe causar otro error.
// Todo va envuelto en try/catch silencioso.
// ═══════════════════════════════════════════════════════════
import { supabase } from './supabase'

let _usuarioNombre = 'Desconocido'
export function setErrorUser(profile) {
  if (profile?.nombre) _usuarioNombre = profile.nombre
}

export async function logError(contexto, error, detalle = null) {
  try {
    const mensaje = error?.message || String(error || 'Error desconocido')
    await supabase.from('error_log').insert({
      contexto: contexto || 'desconocido',
      mensaje: mensaje.slice(0, 500),
      detalle: detalle ? JSON.stringify(detalle).slice(0, 1000) : null,
      usuario_nombre: _usuarioNombre,
    })
    // También a la consola para debug inmediato
    console.error(`[${contexto}]`, mensaje, detalle || '')
  } catch (e) {
    // Registrar el error nunca debe romper nada
    console.error('[errorLog] no se pudo registrar:', e?.message)
  }
}
