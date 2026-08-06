// src/lib/seguimiento.js
// ═══════════════════════════════════════════════════════════
// SEGUIMIENTO POST-DESPACHO (contra entrega)
//
// Los pedidos COD que salen y no vuelven a dar señales son plata parada: el
// courier no siempre reporta a tiempo, y un paquete "en tránsito" desde hace
// una semana suele ser un paquete trabado que nadie está empujando.
//
// A los N días del despacho se le escribe al cliente por WhatsApp para
// preguntarle si recibió. Eso sirve para tres cosas, en orden de valor:
//
//   1. Si dice que SÍ recibió → se marca entregado en el acto, sin esperar el
//      reporte del courier. Sube la tasa de entrega REGISTRADA, que hoy va por
//      detrás de la real.
//   2. Si dice que NO → se detecta temprano y se reclama al courier mientras
//      el paquete todavía se puede recuperar.
//   3. El contacto en sí presiona al courier y le recuerda al cliente que
//      alguien está atento al envío.
//
// Solo aplica a COD: en un prepago ya cobraste y no hay nada que confirmar.
// ═══════════════════════════════════════════════════════════

// Días desde el despacho antes de escribir. 4 es el default: PaP declara
// 24-96hs según zona, así que al día 4 la mayoría ya debería estar entregada
// y el que no lo está es sospechoso de verdad.
export const DIAS_SEGUIMIENTO_DEFAULT = 4

// ─── Teléfono → formato internacional para wa.me ────────────
// Paraguay: código de país 595, celulares de 9 dígitos que empiezan con 9
// (el "0" del formato local 09XX-XXXXXX NO va en el número internacional).
//   0981639332      → 595981639332
//   +595 981 639332 → 595981639332
//   981639332       → 595981639332
// Devuelve null si no es un celular paraguayo válido, para no generar un
// link roto que abra un chat con un número inexistente.
export function telefonoWhatsApp(tel) {
  let n = String(tel ?? '').replace(/\D/g, '')
  if (!n) return null
  if (n.startsWith('595')) n = n.slice(3)      // ya traía código de país
  if (n.startsWith('0')) n = n.slice(1)        // formato local: 0981... → 981...
  // Un celular paraguayo, sin 0 ni código de país, son 9 dígitos que arrancan en 9.
  // Las líneas fijas (021, 061...) no tienen WhatsApp: se descartan.
  if (n.length !== 9 || !n.startsWith('9')) return null
  return '595' + n
}

// ─── Plantillas de mensaje ──────────────────────────────────
// Cortas y con una pregunta cerrada: un mensaje largo se lee en diagonal y
// uno abierto no se contesta. El nombre y el producto van adentro porque un
// mensaje genérico parece spam y baja la tasa de respuesta.
export const PLANTILLAS = {
  consulta: {
    id: 'consulta',
    label: 'Consulta normal',
    texto: ({ nombre, producto }) =>
      `Hola${nombre ? ' ' + nombre : ''}! Te escribo de Facial Wellness. ` +
      `Queria consultarte si ya recibiste tu pedido${producto ? ` de ${producto}` : ''}. ` +
      `Respondeme si o no asi lo verifico. Gracias!`,
  },
  demorado: {
    id: 'demorado',
    label: 'Ya lleva varios días',
    texto: ({ nombre, producto, dias }) =>
      `Hola${nombre ? ' ' + nombre : ''}! Te escribo de Facial Wellness. ` +
      `Tu pedido${producto ? ` de ${producto}` : ''} salio hace ${dias} dias y todavia no me figura como entregado. ` +
      `Lo recibiste? Si no, avisame y lo reclamo con la transportadora hoy mismo.`,
  },
  reintento: {
    id: 'reintento',
    label: 'Segundo intento',
    texto: ({ nombre }) =>
      `Hola${nombre ? ' ' + nombre : ''}! Te escribi hace unos dias por tu pedido de Facial Wellness. ` +
      `Necesito saber si te llego para cerrar el envio. Un si o un no me alcanza. Gracias!`,
  },
}

// Arma el link de wa.me con el mensaje ya cargado.
// Devuelve null si el teléfono no sirve — el llamador debe manejar ese caso
// mostrando el motivo, en vez de un botón que no lleva a ningún lado.
export function linkWhatsApp(venta, plantillaId = 'consulta', dias = null) {
  const tel = telefonoWhatsApp(venta?.cliente_telefono)
  if (!tel) return null
  const plantilla = PLANTILLAS[plantillaId] || PLANTILLAS.consulta
  // Solo el primer nombre: usar el nombre completo en un WhatsApp suena a
  // cobranza o a robot, y el objetivo es que conteste.
  const nombre = String(venta?.cliente_nombre || '').trim().split(/\s+/)[0] || ''
  const texto = plantilla.texto({
    nombre,
    producto: venta?.producto_nombre || '',
    dias: dias ?? DIAS_SEGUIMIENTO_DEFAULT,
  })
  return `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`
}

// Días transcurridos desde una fecha (YYYY-MM-DD) hasta hoy.
export function diasDesde(fecha, hoy = new Date()) {
  if (!fecha) return null
  const f = new Date(String(fecha).slice(0, 10) + 'T00:00:00')
  if (isNaN(f)) return null
  const h = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())
  return Math.floor((h - f) / 86400000)
}

// ─── Selección de pedidos a seguir ──────────────────────────
// Entra: ventas crudas. Sale: solo las que corresponde contactar, ordenadas
// por antigüedad (lo más viejo primero, que es lo más urgente).
//
// Criterios, todos necesarios:
//   · COD — en un prepago ya cobraste, no hay nada que confirmar
//   · sin resolver — ni entregado ni devuelto ni cancelado
//   · con al menos `diasMin` días desde el despacho
//   · no descartado a mano
export function pedidosParaSeguimiento(ventas, { diasMin = DIAS_SEGUIMIENTO_DEFAULT, hoy = new Date() } = {}) {
  const SIN_RESOLVER = ['pendiente', 'en_tramite', 'en_camino']
  return (ventas || [])
    .filter(v => !v.pago_anticipado)
    .filter(v => SIN_RESOLVER.includes(String(v.estado || '').toLowerCase()))
    .filter(v => v.seguimiento_estado !== 'descartado')
    .map(v => {
      const dias = diasDesde(v.fecha, hoy)
      const diasDesdeContacto = v.seguimiento_at ? diasDesde(v.seguimiento_at, hoy) : null
      return {
        ...v,
        dias,
        diasDesdeContacto,
        yaContactado: !!v.seguimiento_at,
        telefonoValido: telefonoWhatsApp(v.cliente_telefono) != null,
        // Sugerencia de plantilla: primer contacto vs. insistencia.
        plantillaSugerida: v.seguimiento_at ? 'reintento' : (dias >= diasMin + 3 ? 'demorado' : 'consulta'),
      }
    })
    .filter(v => v.dias != null && v.dias >= diasMin)
    // No re-escribir al mismo cliente todos los días: mínimo 3 días entre contactos.
    .filter(v => v.diasDesdeContacto == null || v.diasDesdeContacto >= 3)
    .sort((a, b) => b.dias - a.dias)
}

// Resumen para los KPIs de la cabecera.
export function resumenSeguimiento(pendientes) {
  const lista = pendientes || []
  return {
    total: lista.length,
    sinContactar: lista.filter(v => !v.yaContactado).length,
    reintentos: lista.filter(v => v.yaContactado).length,
    sinTelefono: lista.filter(v => !v.telefonoValido).length,
    montoEnJuego: lista.reduce((s, v) => s + (v.total || 0), 0),
    masViejo: lista.length ? Math.max(...lista.map(v => v.dias || 0)) : 0,
  }
}
