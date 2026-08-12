// src/lib/seguimiento.js
// ═══════════════════════════════════════════════════════════
// SEGUIMIENTO POST-DESPACHO — GESTIÓN DE EXCEPCIONES
//
// Esto NO es "mandar mensajes de WhatsApp": es una bandeja de excepciones.
// Cada pedido COD que lleva días sin resolverse es plata en riesgo, y el
// objetivo es CERRARLO — entregado o devuelto — no escribirle al cliente.
// El mensaje es apenas el medio.
//
// ── POR QUÉ UN MODELO DE ESTADOS Y NO UN "YA LE ESCRIBÍ" ──
// La versión anterior tenía dos estados: contactado o no. Con eso, apenas se
// abría WhatsApp el pedido desaparecía de la lista y no quedaba dónde
// registrar qué contestó el cliente. Pero las respuestas reales son seis
// situaciones distintas, y cada una necesita una acción distinta:
//
//   "ya lo recibí"          → cerrar la venta como entregada
//   "todavía lo espero"     → el cliente sigue interesado, hay que apurar
//   "nunca me contactaron"  → falla del courier → RECLAMAR
//   "que venga el viernes"  → reprogramado, no molestar hasta esa fecha
//   (visto, sin responder)  → reintentar en unos días
//   "ya no lo quiero"       → cerrar como devuelta, cortar la pérdida
//
// El pedido NUNCA desaparece: cambia de estado y sigue visible hasta cerrarse.
// ═══════════════════════════════════════════════════════════

// Días desde el despacho antes de escribir por primera vez.
export const DIAS_SEGUIMIENTO_DEFAULT = 4
// Espera mínima antes de habilitar un segundo mensaje al mismo cliente:
// escribirle todos los días molesta y baja la tasa de respuesta.
export const DIAS_REINTENTO = 3
// Tope de mensajes por pedido. Más que esto es insistir de más y no cambia
// el resultado — a esa altura el problema es del courier, no del cliente.
export const MAX_INTENTOS = 3

// ─── Teléfono → formato internacional para wa.me ────────────
// Paraguay: código 595, celulares de 9 dígitos que empiezan con 9 (el "0" del
// formato local 09XX no va). Las líneas fijas (021, 061...) no tienen
// WhatsApp: se descartan para no generar un link a un chat inexistente.
export function telefonoWhatsApp(tel) {
  let n = String(tel ?? '').replace(/\D/g, '')
  if (!n) return null
  if (n.startsWith('595')) n = n.slice(3)
  if (n.startsWith('0')) n = n.slice(1)
  if (n.length !== 9 || !n.startsWith('9')) return null
  return '595' + n
}

// ─── Estados del seguimiento ────────────────────────────────
// `abierto` → sigue en la bandeja y requiere acción.
// `cierra`  → con qué estado se cierra la venta al llegar acá.
export const ESTADOS_SEG = {
  pendiente: {
    id: 'pendiente', label: 'Por contactar', color: 'var(--accent)', abierto: true,
    ayuda: 'Despachado hace días y sin resolver. Escribile al cliente.',
  },
  esperando: {
    id: 'esperando', label: 'Esperando respuesta', color: 'var(--yellow)', abierto: true,
    ayuda: 'Ya le escribiste. Registrá qué contestó apenas responda.',
  },
  sin_respuesta: {
    id: 'sin_respuesta', label: 'No contestó', color: 'var(--text-muted)', abierto: true,
    ayuda: 'Te dejó en visto o no respondió. Se puede reintentar.',
  },
  reprogramado: {
    id: 'reprogramado', label: 'Reprogramado', color: 'var(--purple)', abierto: true,
    ayuda: 'El cliente pidió otra fecha. Vuelve a la bandeja ese día.',
  },
  sin_contacto: {
    id: 'sin_contacto', label: 'Courier no lo contactó', color: 'var(--red)', abierto: true,
    ayuda: 'El cliente dice que nadie lo llamó. Es falla del courier: reclamalo.',
  },
  escalado: {
    id: 'escalado', label: 'Reclamado al courier', color: 'var(--accent)', abierto: true,
    ayuda: 'Ya reclamaste. Esperando que el courier lo resuelva.',
  },
  recibido: {
    id: 'recibido', label: 'Recibido', color: 'var(--green)', abierto: false, cierra: 'entregado',
    ayuda: 'El cliente confirmó que lo recibió.',
  },
  rechazado: {
    id: 'rechazado', label: 'Ya no lo quiere', color: 'var(--red)', abierto: false, cierra: 'devuelto',
    ayuda: 'El cliente rechazó el pedido.',
  },
}

// Respuestas registrables tras escribirle. El orden es el de frecuencia real,
// para que el clic más común quede primero.
export const RESPUESTAS = [
  { id: 'recibido',     label: 'Ya lo recibió',     estado: 'recibido',      color: 'var(--green)' },
  { id: 'espera',       label: 'Todavía lo espera', estado: 'esperando',     color: 'var(--yellow)' },
  { id: 'sin_contacto', label: 'Nadie lo contactó', estado: 'sin_contacto',  color: 'var(--red)' },
  { id: 'reprograma',   label: 'Pidió otra fecha',  estado: 'reprogramado',  color: 'var(--purple)', pideFecha: true },
  { id: 'visto',        label: 'Me dejó en visto',  estado: 'sin_respuesta', color: 'var(--text-muted)' },
  { id: 'rechaza',      label: 'Ya no lo quiere',   estado: 'rechazado',     color: 'var(--red)' },
]

// ─── Plantillas al CLIENTE ──────────────────────────────────
// Cortas y con pregunta cerrada: un mensaje largo se lee en diagonal y uno
// abierto no se contesta.
export const PLANTILLAS = {
  consulta: {
    id: 'consulta', label: 'Primera consulta',
    texto: ({ nombre, producto }) =>
      `Hola${nombre ? ' ' + nombre : ''}! Te escribo de Facial Wellness. ` +
      `Queria consultarte si ya recibiste tu pedido${producto ? ` de ${producto}` : ''}. ` +
      `Respondeme si o no asi lo verifico. Gracias!`,
  },
  demorado: {
    id: 'demorado', label: 'Ya lleva varios días',
    texto: ({ nombre, producto, dias }) =>
      `Hola${nombre ? ' ' + nombre : ''}! Te escribo de Facial Wellness. ` +
      `Tu pedido${producto ? ` de ${producto}` : ''} salio hace ${dias} dias y todavia no me figura como entregado. ` +
      `Lo recibiste? Si no, avisame y lo reclamo con la transportadora hoy mismo.`,
  },
  reintento: {
    id: 'reintento', label: 'Segundo intento',
    texto: ({ nombre }) =>
      `Hola${nombre ? ' ' + nombre : ''}! Te escribi hace unos dias por tu pedido de Facial Wellness. ` +
      `Necesito saber si te llego para cerrar el envio. Un si o un no me alcanza. Gracias!`,
  },
  reclamado: {
    id: 'reclamado', label: 'Ya reclamé al courier',
    texto: ({ nombre }) =>
      `Hola${nombre ? ' ' + nombre : ''}! Ya reclame tu pedido con la transportadora y me confirmaron que lo van a priorizar. ` +
      `Cualquier cosa avisame. Gracias por la paciencia!`,
  },
}

export function diasDesde(fecha, hoy = new Date()) {
  if (!fecha) return null
  const f = new Date(String(fecha).slice(0, 10) + 'T00:00:00')
  if (isNaN(f)) return null
  const h = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())
  return Math.floor((h - f) / 86400000)
}

export const hoyISO = (hoy = new Date()) =>
  new Date(hoy.getTime() - hoy.getTimezoneOffset() * 60000).toISOString().slice(0, 10)

// ─── Bandeja de trabajo ─────────────────────────────────────
// Devuelve TODOS los pedidos abiertos con su estado — NO filtra los ya
// contactados. Ese era el fallo de flujo anterior: el pedido desaparecía al
// abrir WhatsApp y no quedaba dónde registrar la respuesta.
export function construirBandeja(ventas, { diasMin = DIAS_SEGUIMIENTO_DEFAULT, hoy = new Date() } = {}) {
  const hoyStr = hoyISO(hoy)
  return (ventas || [])
    .filter(v => !v.pago_anticipado)   // prepago: ya cobraste, no hay nada que rescatar
    .filter(v => ['pendiente', 'en_tramite', 'en_camino'].includes(v.estado))
    .map(v => {
      const dias = diasDesde(v.fecha, hoy)
      const estado = v.seguimiento_estado || 'pendiente'
      const cfg = ESTADOS_SEG[estado] || ESTADOS_SEG.pendiente
      const diasDesdeContacto = v.seguimiento_at ? diasDesde(v.seguimiento_at, hoy) : null
      const intentos = v.seguimiento_intentos || 0
      const wa = telefonoWhatsApp(v.cliente_telefono)
      // Reprogramado: no se lo molesta hasta la fecha que pidió el cliente.
      const esperandoFecha = estado === 'reprogramado' && v.seguimiento_fecha_prometida
        && v.seguimiento_fecha_prometida > hoyStr

      const puedeContactar = !!wa && (dias ?? 0) >= diasMin && intentos < MAX_INTENTOS
        && !esperandoFecha
        && (diasDesdeContacto == null || diasDesdeContacto >= DIAS_REINTENTO)

      // Motivo del bloqueo, para explicarlo en la UI en vez de mostrar un
      // botón muerto sin razón visible.
      let motivoBloqueo = null
      if (!wa) motivoBloqueo = 'Sin celular válido'
      else if ((dias ?? 0) < diasMin) motivoBloqueo = `Recién despachado (${dias}d)`
      else if (esperandoFecha) motivoBloqueo = `Reprogramado para el ${v.seguimiento_fecha_prometida}`
      else if (intentos >= MAX_INTENTOS) motivoBloqueo = `Ya van ${intentos} mensajes`
      else if (diasDesdeContacto != null && diasDesdeContacto < DIAS_REINTENTO)
        motivoBloqueo = `Le escribiste hace ${diasDesdeContacto}d — esperá ${DIAS_REINTENTO - diasDesdeContacto}d más`

      return {
        ...v, dias, estado, cfg, intentos, diasDesdeContacto, wa,
        telefonoValido: !!wa, puedeContactar, motivoBloqueo, esperandoFecha,
        // Plantilla según el historial: no repetir el mismo texto dos veces.
        plantillaSugerida: estado === 'escalado' ? 'reclamado'
          : intentos >= 1 ? 'reintento'
          : (dias ?? 0) >= diasMin + 3 ? 'demorado' : 'consulta',
        // Orden de trabajo: primero lo que hay que reclamar (es lo que más
        // rescata), después lo nuevo, y dentro de cada grupo lo más viejo.
        prioridad: estado === 'sin_contacto' ? 0 : estado === 'pendiente' ? 1
          : estado === 'sin_respuesta' ? 2 : estado === 'esperando' ? 3 : 4,
      }
    })
    .filter(v => (v.dias ?? -1) >= 0)
    .sort((a, b) => a.prioridad - b.prioridad || (b.dias ?? 0) - (a.dias ?? 0))
}

export function mensajeCliente(venta, plantillaId) {
  const p = PLANTILLAS[plantillaId] || PLANTILLAS.consulta
  return p.texto({
    nombre: String(venta?.cliente_nombre || '').trim().split(/\s+/)[0] || '',
    producto: venta?.producto_nombre || '',
    dias: venta?.dias ?? DIAS_SEGUIMIENTO_DEFAULT,
  })
}

export function linkWhatsApp(venta, plantillaId) {
  const tel = venta?.wa || telefonoWhatsApp(venta?.cliente_telefono)
  if (!tel) return null
  return `https://wa.me/${tel}?text=${encodeURIComponent(mensajeCliente(venta, plantillaId))}`
}

// ─── Reclamo AGRUPADO al courier ────────────────────────────
// La mayor reducción de fricción: en vez de escribirle a la transportadora una
// vez por pedido, se junta todo lo reclamable en UN mensaje con todos los
// códigos. Un reclamo con 5 guías se atiende igual de rápido que uno con 1,
// y a vos te cuesta un clic en lugar de cinco.
export function pedidosParaReclamar(bandeja) {
  const porCourier = {}
  ;(bandeja || []).forEach(v => {
    const reclamable = v.estado === 'sin_contacto'
      || (v.estado === 'reprogramado' && v.seguimiento_fecha_prometida)
    if (!reclamable) return
    const t = v.transportadora || 'pap'
    if (!porCourier[t]) porCourier[t] = []
    porCourier[t].push(v)
  })
  return porCourier
}

export function mensajeReclamo(pedidos) {
  const sinContacto = pedidos.filter(p => p.estado === 'sin_contacto')
  const reprogramados = pedidos.filter(p => p.estado === 'reprogramado')
  const l = ['Hola! Necesito ayuda con estos envios de Facial Wellness:']
  if (sinContacto.length) {
    l.push('', 'NO LOS CONTACTARON todavia (el cliente confirma que nadie lo llamo):')
    sinContacto.forEach(p => l.push(
      `- ${p.n_referencia || 's/ref'} · ${p.cliente_nombre || ''} · ${p.ciudad || ''} · ${p.cliente_telefono || ''}`))
  }
  if (reprogramados.length) {
    l.push('', 'REPROGRAMAR entrega (el cliente pidio otra fecha):')
    reprogramados.forEach(p => l.push(
      `- ${p.n_referencia || 's/ref'} · ${p.cliente_nombre || ''} · ${p.ciudad || ''} · para el ${p.seguimiento_fecha_prometida}`))
  }
  l.push('', 'Me confirman por favor? Gracias!')
  return l.join('\n')
}

export function resumenBandeja(bandeja) {
  const r = { total: bandeja.length, montoEnJuego: 0, porEstado: {},
    porContactar: 0, paraReclamar: 0, sinTelefono: 0, masViejo: 0 }
  bandeja.forEach(v => {
    r.montoEnJuego += (v.total || 0)
    r.porEstado[v.estado] = (r.porEstado[v.estado] || 0) + 1
    if (v.puedeContactar) r.porContactar++
    if (v.estado === 'sin_contacto' || (v.estado === 'reprogramado' && v.seguimiento_fecha_prometida)) r.paraReclamar++
    if (!v.telefonoValido) r.sinTelefono++
    if ((v.dias ?? 0) > r.masViejo) r.masViejo = v.dias
  })
  return r
}

// ─── Efectividad: ¿el seguimiento sirve? ────────────────────
// Sin esto no hay forma de saber si la pantalla mueve la aguja o solo genera
// trabajo. Compara los contactados que terminaron entregados vs devueltos.
export function efectividad(ventasHistoricas) {
  const tocados = (ventasHistoricas || []).filter(v => v.seguimiento_at)
  const entregados = tocados.filter(v => v.estado === 'entregado').length
  const devueltos = tocados.filter(v => v.estado === 'devuelto').length
  const resueltos = entregados + devueltos
  return {
    contactados: tocados.length, entregados, devueltos,
    tasaRescate: resueltos ? (entregados / resueltos) * 100 : null,
    montoRescatado: tocados.filter(v => v.estado === 'entregado')
      .reduce((s, v) => s + (v.total || 0), 0),
  }
}
