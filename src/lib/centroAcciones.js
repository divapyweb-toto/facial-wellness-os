// src/lib/centroAcciones.js
// ═══════════════════════════════════════════════════════════
// CENTRO DE ACCIONES
//
// Las alertas de `alertasNegocio.js` son de DIAGNÓSTICO: te dicen qué pasó
// ("las ventas cayeron 20%"). Esto es distinto: son ACCIONES PENDIENTES, cosas
// que hay que hacer y todavía no se hicieron.
//
// El problema que resuelve: el sistema no corre nada solo — todo depende de
// que te acuerdes de entrar y hacerlo. Subir el reporte del courier, cargar el
// gasto de Meta, revisar la bandeja de seguimiento, mirar el stock. Si te
// olvidás de uno, los números quedan incompletos y no hay nada que avise.
//
// No automatiza el trabajo (eso necesitaría un servidor corriendo tareas).
// Automatiza el ACORDARSE, que es el 80% del problema y no cuesta nada.
//
// Todo se ordena por PLATA EN JUEGO, no por antigüedad: primero lo que más
// cuesta si no se hace.
// ═══════════════════════════════════════════════════════════

const diasEntre = (desde, hasta = new Date()) => {
  if (!desde) return null
  const d = new Date(String(desde).slice(0, 10) + 'T00:00:00')
  if (isNaN(d)) return null
  const h = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate())
  return Math.floor((h - d) / 86400000)
}

// Cada acción: qué hacer, por qué importa, cuánta plata hay detrás y adónde ir.
// `monto` se usa para ordenar; `urgencia` solo para el color.
function accion(id, { titulo, detalle, monto = 0, ruta, cta, urgencia = 'media' }) {
  return { id, titulo, detalle, monto, ruta, cta, urgencia }
}

// datos = {
//   ventasAbiertas: [{ fecha, total, estado, pago_anticipado, cliente_telefono, seguimiento_at }]
//   ultimaEntregaImportada: 'YYYY-MM-DD' | null
//   gastoAdsMes: number, mesActual: 'YYYY-MM'
//   productosBajos: [{ nombre, stock_actual, alerta_stock }]
//   sinRendir: { monto, cantidad, trancados }
//   ventasSinTransportadora: number
//   hoy: Date
// }
export function construirAcciones(datos = {}) {
  const hoy = datos.hoy || new Date()
  const acciones = []

  // ── 1. Pedidos COD sin resolver ──
  // Lo más rentable de atender: cada uno rescatado es una devolución menos.
  const cod = (datos.ventasAbiertas || []).filter(v => !v.pago_anticipado)
  const viejos = cod.filter(v => (diasEntre(v.fecha, hoy) ?? 0) >= 4)
  if (viejos.length) {
    const monto = viejos.reduce((s, v) => s + (v.total || 0), 0)
    const sinTocar = viejos.filter(v => !v.seguimiento_at).length
    acciones.push(accion('seguimiento', {
      titulo: `${viejos.length} pedido${viejos.length > 1 ? 's' : ''} COD sin resolver`,
      detalle: sinTocar
        ? `${sinTocar} sin contactar todavía. Cada día que pasa baja la chance de rescatarlo.`
        : 'Ya contactados, esperando respuesta o reclamo al courier.',
      monto, ruta: '/seguimiento', cta: 'Ir a Seguimiento',
      urgencia: sinTocar > 0 ? 'alta' : 'media',
    }))
  }

  // ── 2. Reporte del courier desactualizado ──
  // Sin esto, las entregas reales no se registran: la tasa de entrega y la
  // ganancia quedan por debajo de lo real, y parece que el mes va peor.
  const diasSinImportar = diasEntre(datos.ultimaEntregaImportada, hoy)
  if (diasSinImportar == null || diasSinImportar >= 3) {
    const enTransito = cod.filter(v => v.estado === 'pendiente')
    acciones.push(accion('importar', {
      titulo: diasSinImportar == null
        ? 'Nunca importaste un reporte de transportadora'
        : `Último reporte de transportadora: hace ${diasSinImportar} días`,
      detalle: `${enTransito.length} pedidos figuran en tránsito. Puede haber entregas ya cobradas sin registrar.`,
      monto: enTransito.reduce((s, v) => s + (v.total || 0), 0),
      ruta: '/entregas', cta: 'Importar reporte',
      urgencia: (diasSinImportar ?? 99) >= 7 ? 'alta' : 'media',
    }))
  }

  // ── 3. Gasto de Meta sin cargar ──
  // Sin el gasto, el ROAS del mes está incompleto y cualquier decisión de
  // escalar o cortar campañas se toma a ciegas.
  if (!datos.gastoAdsMes) {
    acciones.push(accion('ads', {
      titulo: 'Falta cargar el gasto de Meta de este mes',
      detalle: 'Sin el gasto, el ROAS y el CPA reales del mes no se pueden calcular.',
      monto: 0, ruta: '/ads', cta: 'Cargar gasto',
      urgencia: 'media',
    }))
  }

  // ── 4. Cobranza trancada ──
  if (datos.sinRendir?.trancados > 0) {
    acciones.push(accion('rendicion', {
      titulo: `${datos.sinRendir.trancados} cobros trancados hace +14 días`,
      detalle: 'Entregas cobradas al cliente que la transportadora todavía no depositó. Reclamalas.',
      monto: datos.sinRendir.monto || 0,
      ruta: '/rendicion', cta: 'Ver Rendición',
      urgencia: 'alta',
    }))
  }

  // ── 5. Stock por debajo del punto de reposición ──
  // Sin monto directo, pero quedarse sin stock corta la venta del producto.
  const bajos = datos.productosBajos || []
  if (bajos.length) {
    acciones.push(accion('stock', {
      titulo: `${bajos.length} producto${bajos.length > 1 ? 's' : ''} bajo el punto de reposición`,
      detalle: bajos.slice(0, 3).map(p => `${p.nombre} (${p.stock_actual})`).join(' · ')
        + (bajos.length > 3 ? ` y ${bajos.length - 3} más` : ''),
      monto: 0, ruta: '/stock', cta: 'Ver Stock',
      urgencia: bajos.some(p => (p.stock_actual || 0) <= 0) ? 'alta' : 'media',
    }))
  }

  // ── 6. Ventas sin transportadora ──
  // Rompen el reporte por transportadora: quedan contadas como PaP por defecto.
  if (datos.ventasSinTransportadora > 0) {
    acciones.push(accion('sin_transportadora', {
      titulo: `${datos.ventasSinTransportadora} ventas sin transportadora asignada`,
      detalle: 'Se cuentan como PaP por defecto, así que el desglose por courier sale mal.',
      monto: 0, ruta: '/ventas', cta: 'Revisar en Ventas',
      urgencia: 'baja',
    }))
  }

  // Orden: primero por urgencia, después por plata en juego.
  const peso = { alta: 0, media: 1, baja: 2 }
  return acciones.sort((a, b) => peso[a.urgencia] - peso[b.urgencia] || b.monto - a.monto)
}

export const COLOR_URGENCIA = {
  alta: 'var(--red)',
  media: 'var(--yellow)',
  baja: 'var(--text-muted)',
}
