// src/lib/audit.js
// ═══════════════════════════════════════════════════════════
// Registro de auditoría — quién hizo qué.
// Uso: import { logAccion } from '../../lib/audit'
//      await logAccion({ accion:'eliminar', entidad:'venta', entidadId:v.id, detalle:`#${v.n_referencia}` })
//
// Regla de oro: registrar NUNCA debe romper la acción principal.
// Si falla el log, se traga el error en silencio (solo console.warn).
// ═══════════════════════════════════════════════════════════
import { supabase } from './supabase'

// Cache del usuario actual para no consultarlo en cada acción
let _usuarioCache = null

export function setAuditUser(profile) {
  if (profile) {
    _usuarioCache = { id: profile.id, nombre: profile.nombre || 'Usuario' }
  }
}

export async function logAccion({ accion, entidad, entidadId = null, detalle = '' }) {
  try {
    let usuario = _usuarioCache
    // Fallback: si no está cacheado, intentar obtenerlo de la sesión
    if (!usuario) {
      const { data } = await supabase.auth.getUser()
      usuario = { id: data?.user?.id || null, nombre: data?.user?.email || 'Desconocido' }
    }
    await supabase.from('audit_log').insert({
      usuario_id: usuario?.id || null,
      usuario_nombre: usuario?.nombre || 'Desconocido',
      accion,
      entidad,
      entidad_id: entidadId != null ? String(entidadId) : null,
      detalle: detalle || '',
    })
  } catch (e) {
    // Registrar nunca rompe la operación principal
    console.warn('[audit] no se pudo registrar:', e?.message)
  }
}

// Registro en lote (para acciones masivas: borrar 10 ventas = 1 registro resumen)
export async function logAccionLote({ accion, entidad, cantidad, detalle = '' }) {
  return logAccion({
    accion,
    entidad,
    entidadId: null,
    detalle: `${cantidad} ${entidad}(s) — ${detalle}`.trim(),
  })
}
