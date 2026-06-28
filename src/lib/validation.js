// src/lib/validation.js
// ═══════════════════════════════════════════════════════════
// Validación de datos — reglas reutilizables para formularios.
// Uso:
//   const err = validarVenta(form)
//   if (err) { toast(err, 'error'); return }
// Devuelve null si todo OK, o un string con el primer error encontrado.
// ═══════════════════════════════════════════════════════════

// ── Validadores de campo ──
export function telefonoValido(tel) {
  if (!tel) return true // teléfono es opcional
  const limpio = String(tel).replace(/\D/g, '')
  // Paraguay: 9 dígitos (sin prefijo) hasta 12 (con +595 y 9 dígitos de número)
  return limpio.length >= 9 && limpio.length <= 12
}

export function montoValido(monto) {
  const n = Number(monto)
  return Number.isFinite(n) && n >= 0
}

export function fechaValida(fecha) {
  if (!fecha) return false
  const d = new Date(fecha + 'T00:00:00')
  if (isNaN(d.getTime())) return false
  // No permitir fechas absurdas (más de 1 año en el futuro)
  const maxFutura = new Date()
  maxFutura.setFullYear(maxFutura.getFullYear() + 1)
  return d <= maxFutura
}

// ── Validadores de entidad completa ──
// Devuelven null (OK) o el mensaje del primer problema.

export function validarVenta(form) {
  if (!form.fecha) return 'Falta la fecha de la venta'
  if (!fechaValida(form.fecha)) return 'La fecha no es válida'
  if (!form.producto_id) return 'Seleccioná un producto'
  const cant = parseInt(form.cantidad)
  if (!cant || cant < 1) return 'La cantidad debe ser al menos 1'
  if (cant > 999) return 'La cantidad parece demasiado alta (máx. 999)'
  if (form.total != null && !montoValido(form.total)) return 'El total no puede ser negativo'
  if (form.cliente_telefono && !telefonoValido(form.cliente_telefono)) return 'El teléfono no parece válido (9-11 dígitos)'
  return null
}

export function validarGasto(form) {
  if (!form.fecha) return 'Falta la fecha del gasto'
  if (!fechaValida(form.fecha)) return 'La fecha no es válida'
  if (!form.categoria) return 'Seleccioná una categoría'
  if (!form.concepto || !form.concepto.trim()) return 'Escribí un concepto'
  if (!montoValido(form.monto) || Number(form.monto) <= 0) return 'El monto debe ser mayor a 0'
  if (form.presupuestado != null && form.presupuestado !== '' && !montoValido(form.presupuestado)) return 'El presupuesto no puede ser negativo'
  return null
}

export function validarProducto(form) {
  if (!form.nombre || !form.nombre.trim()) return 'El producto necesita un nombre'
  if (!montoValido(form.costo_unit)) return 'El costo no puede ser negativo'
  if (form.precio_1u != null && form.precio_1u !== '' && !montoValido(form.precio_1u)) return 'El precio no puede ser negativo'
  const stock = parseInt(form.stock_actual)
  if (form.stock_actual !== '' && (isNaN(stock) || stock < 0)) return 'El stock no puede ser negativo'
  return null
}
