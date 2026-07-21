// src/lib/alertasNegocio.js
// ═══════════════════════════════════════════════════════════
// ALERTAS INTELIGENTES DEL NEGOCIO
//
// El sistema detecta solo lo que necesita tu atención y te lo muestra en el
// Dashboard. No obliga nada: te avisa y te lleva a la página para actuar.
//
// Cada alerta: { tipo, color: 'red'|'yellow'|'green', msg, ruta, accion }
// ═══════════════════════════════════════════════════════════

const fmt = (n) => 'Gs. ' + Number(Math.round(n || 0)).toLocaleString('es-PY')

// Caída de ventas: compara el total facturado de este mes vs el mes pasado.
// mesActual, mesAnterior: números (total facturado).
export function alertaCaidaVentas(mesActual, mesAnterior) {
  if (!mesAnterior || mesAnterior <= 0) return null
  const delta = (mesActual - mesAnterior) / mesAnterior
  if (delta <= -0.15) {
    return {
      tipo: 'ventas', color: 'red', ruta: '/reportes', accion: 'Ver reportes',
      msg: `Ventas cayeron ${Math.round(Math.abs(delta) * 100)}% vs el mes pasado (${fmt(mesActual)} vs ${fmt(mesAnterior)}). Revisá creativos y ofertas.`,
    }
  }
  if (delta >= 0.15) {
    return {
      tipo: 'ventas', color: 'green', ruta: '/reportes', accion: 'Ver',
      msg: `Ventas subieron ${Math.round(delta * 100)}% vs el mes pasado. Buen momento para escalar.`,
    }
  }
  return null
}

// Tasa de entrega baja o cayendo.
// tasaActual: 0..1. tasaAnterior: 0..1 (opcional).
export function alertaTasaEntrega(tasaActual, tasaAnterior, resueltos) {
  if (!resueltos || resueltos < 5) return null // pocos datos
  if (tasaActual < 0.6) {
    return {
      tipo: 'entrega', color: 'red', ruta: '/inteligencia', accion: 'Ver dónde',
      msg: `Tasa de entrega en ${Math.round(tasaActual * 100)}% — estás perdiendo plata en fletes. Mirá en qué ciudades conviene prepago.`,
    }
  }
  if (tasaAnterior != null && tasaAnterior > 0 && (tasaActual - tasaAnterior) <= -0.08) {
    return {
      tipo: 'entrega', color: 'yellow', ruta: '/inteligencia', accion: 'Ver',
      msg: `La entrega bajó de ${Math.round(tasaAnterior * 100)}% a ${Math.round(tasaActual * 100)}% este mes. Revisá qué cambió.`,
    }
  }
  return null
}

// Campaña / producto que pierde plata (ganancia neta negativa con gasto de ads).
// campanas: [{ nombre, gananciaNeta }]
export function alertaCampanaPierde(campanas) {
  const perdedoras = (campanas || []).filter(c => c.gananciaNeta < 0)
  if (!perdedoras.length) return null
  const peor = perdedoras.sort((a, b) => a.gananciaNeta - b.gananciaNeta)[0]
  return {
    tipo: 'ads', color: 'red', ruta: '/ads', accion: 'Ver campañas',
    msg: perdedoras.length === 1
      ? `${peor.nombre} está perdiendo ${fmt(Math.abs(peor.gananciaNeta))} este mes. Cortá o cambiá el creativo.`
      : `${perdedoras.length} campañas están perdiendo plata (la peor: ${peor.nombre}, ${fmt(Math.abs(peor.gananciaNeta))}). Revisalas.`,
  }
}

// Clientes esperando recompra (oportunidad de venta).
export function alertaRecompra(cantidad) {
  if (!cantidad || cantidad < 3) return null
  return {
    tipo: 'recompra', color: 'yellow', ruta: '/recompra', accion: 'Contactar',
    msg: `${cantidad} clientes listos para recompra. Es plata fácil — mandales el mensaje.`,
  }
}

// Plata de PaP sin rendir (cobrada pero no depositada aún).
export function alertaSinRendir(monto, cantidad) {
  if (!monto || monto <= 0) return null
  return {
    tipo: 'rendicion', color: 'yellow', ruta: '/rendicion', accion: 'Ver',
    msg: `PaP te debe ${fmt(monto)} de ${cantidad} entrega(s) sin rendir. Seguí el cobro.`,
  }
}

// Junta todas las alertas nuevas (las que no son null), ordenadas: rojas primero.
export function construirAlertasNegocio(datos) {
  const lista = [
    alertaCaidaVentas(datos.ventasMesActual, datos.ventasMesAnterior),
    alertaTasaEntrega(datos.tasaEntregaActual, datos.tasaEntregaAnterior, datos.entregasResueltas),
    alertaCampanaPierde(datos.campanas),
    alertaRecompra(datos.recompraPendientes),
    alertaSinRendir(datos.montoSinRendir, datos.cantSinRendir),
  ].filter(Boolean)
  const orden = { red: 0, yellow: 1, green: 2 }
  return lista.sort((a, b) => (orden[a.color] ?? 3) - (orden[b.color] ?? 3))
}
