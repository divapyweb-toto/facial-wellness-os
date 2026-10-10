// src/lib/confirmacion.js
// ═══════════════════════════════════════════════════════════
// Confirmación de pedidos (config_wa, clave 'confirmacion', columna valor jsonb).
// Lógica pura: defaults, validación, merge y texto de ayuda. Sin React ni Supabase.
//
// CONTRATO (no cambiar nombres): recordatorio_min, aviso_enrique_h, ultimo_aviso_h, cancelar_h.
// Al guardar se conserva todo lo demás que ya esté en el jsonb (confirmar_min, etc.).
// ═══════════════════════════════════════════════════════════

export const CLAVE_CONFIRMACION = 'confirmacion'

export const CONFIRMACION_DEFAULTS = Object.freeze({
  recordatorio_min: 60,
  aviso_enrique_h: 3,
  ultimo_aviso_h: 24,
  cancelar_h: 48,
})

export const CAMPOS_CONFIRMACION = Object.keys(CONFIRMACION_DEFAULTS)

const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return NaN
  return Number(String(v).trim().replace(',', '.'))
}

/** Valores para el formulario: lo guardado o el default de cada campo (como string). */
export function leerConfirmacion(valor) {
  const v = valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {}
  const f = {}
  for (const k of CAMPOS_CONFIRMACION) {
    const n = num(v[k])
    f[k] = String(Number.isFinite(n) ? n : CONFIRMACION_DEFAULTS[k])
  }
  return f
}

/** Lista de errores en castellano simple; vacía si todo está bien. */
export function validarConfirmacion(form) {
  const errores = []
  const c = Object.fromEntries(CAMPOS_CONFIRMACION.map(k => [k, num(form?.[k])]))
  const nombres = {
    recordatorio_min: 'Recordatorio', aviso_enrique_h: 'Aviso a Enrique',
    ultimo_aviso_h: 'Último aviso al cliente', cancelar_h: 'Cancelación',
  }
  for (const k of CAMPOS_CONFIRMACION) {
    if (!Number.isFinite(c[k]) || !Number.isInteger(c[k])) errores.push(`${nombres[k]}: poné un número entero`)
  }
  if (errores.length) return errores
  if (c.recordatorio_min < 5) errores.push('El recordatorio tiene que ser de 5 minutos o más')
  if (c.aviso_enrique_h < 1) errores.push('El aviso a Enrique tiene que ser de 1 hora o más')
  if (c.ultimo_aviso_h < c.aviso_enrique_h) errores.push('El último aviso al cliente no puede ser antes del aviso a Enrique')
  const minCancelar = Math.max(24, c.ultimo_aviso_h + 1)
  if (c.cancelar_h < minCancelar) errores.push(`La cancelación tiene que ser a las ${minCancelar} h o más (mínimo 24 h y después del último aviso)`)
  return errores
}

/** jsonb a guardar: lo que ya había (confirmar_min y cualquier otra clave) + los 4 campos como número. */
export function armarConfirmacionGuardar(existente, form) {
  const base = existente && typeof existente === 'object' && !Array.isArray(existente) ? existente : {}
  const nuevos = Object.fromEntries(CAMPOS_CONFIRMACION.map(k => [k, num(form?.[k])]))
  return { ...base, ...nuevos }
}

/** Texto de ayuda con los valores que se están viendo. */
export function textoAyudaConfirmacion(form) {
  const x = Number.isFinite(num(form?.cancelar_h)) ? num(form.cancelar_h) : CONFIRMACION_DEFAULTS.cancelar_h
  const y = Number.isFinite(num(form?.aviso_enrique_h)) ? num(form.aviso_enrique_h) : CONFIRMACION_DEFAULTS.aviso_enrique_h
  return `Los pedidos sin confirmar se cancelan solos a las ${x} h. A las ${y} h te aviso por Telegram para que llames. ` +
    'Si el aviso o la cancelación caen de noche, salen a las 8:00.'
}
