// src/pages/rendicion/logicaDevoluciones.js
// 21-11: lógica pura de la tarjeta "Devoluciones por doble cobro" (Rendición). Sin React ni Supabase, para poder
// probarla con node (tests/devoluciones-doble-cobro.test.mjs). Las filas vienen de la vista devoluciones_doble_cobro.

/** Separa pendientes y ya devueltas. Pendientes: la entrega más vieja arriba (la que hace más que espera). */
export function separarDevoluciones(filas) {
  const lista = Array.isArray(filas) ? filas : []
  const porFecha = (a, b) => String(a.fecha_entrega ?? '').localeCompare(String(b.fecha_entrega ?? '')) || String(a.ref).localeCompare(String(b.ref))
  const pendientes = lista.filter(f => !f.devuelta && Number(f.monto_devolver) > 0).sort(porFecha)
  const devueltas = lista.filter(f => f.devuelta)
    .sort((a, b) => String(b.devuelto_en ?? '').localeCompare(String(a.devuelto_en ?? '')))
  return { pendientes, devueltas }
}

/** Suma de lo que hay que devolver (o de lo ya devuelto). */
export const totalDevolver = (filas) => (Array.isArray(filas) ? filas : []).reduce((s, f) => s + (Number(f.monto_devolver) || 0), 0)

/** Fila para el upsert en devoluciones_cliente al marcar devuelta. La nota vacía queda null. */
export function filaMarcarDevuelta(f, nota, ahora = new Date(), quien = null) {
  const t = String(nota ?? '').trim()
  return {
    ref: f.ref,
    monto: Math.max(0, Math.round(Number(f.monto_devolver) || 0)),
    devuelto_en: ahora.toISOString(),
    nota: t || null,
    actualizado_en: ahora.toISOString(),
    actualizado_por: quien || null,
  }
}

/** Cambio para "Deshacer": vuelve a pendiente (la fila queda con su nota). */
export const cambioDeshacer = (ahora = new Date(), quien = null) =>
  ({ devuelto_en: null, actualizado_en: ahora.toISOString(), actualizado_por: quien || null })

/** ¿El error es porque la vista/tabla todavía no existe (migración sin aplicar)? Así la tarjeta no rompe la página. */
export function esFaltaVista(error) {
  if (!error) return false
  const msg = String(error.message ?? error)
  return error.code === 'PGRST205' || error.code === '42P01' ||
    /devoluciones_(doble_cobro|cliente)/i.test(msg) && /(does not exist|could not find|schema cache)/i.test(msg)
}

export const nombreCourier = (c) => (c === 'pap' ? 'PaP' : c === 'lucero' ? 'Lucero' : c || '—')
