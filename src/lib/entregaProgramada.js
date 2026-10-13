// src/lib/entregaProgramada.js
// ═══════════════════════════════════════════════════════════
// 13-10: ENTREGAS PROGRAMADAS EN DESPACHO
//
// Regla de Enrique (13-10): una entrega se puede programar para cualquier
// fecha futura desde la primera posible. El pedido programado se despacha EL
// MISMO DÍA, como cualquier otro: no se frena ni se saca de la planilla. Lo
// que cambia es que Despacho muestra la fecha y el courier la recibe escrita
// ("Entregar el viernes 16/10 antes de las 12") en la planilla y en la guía.
// Caso real: un pedido para "viernes 16/10 antes de las 12" salió sin que el
// courier supiera el día.
//
// Contrato (Shopify):
//   · tag ENTREGA_PROGRAMADA + atributos de nota `entrega_programada`
//     ("AAAA-MM-DD", fecha de Asunción) y opcional `entrega_franja`
//     ("antes de las 12"). Es la fuente de verdad.
//   · Formato viejo: un tag que empieza con ENTREGAR_ (ENTREGAR_VIERNES_16_10)
//     y la nota "ENTREGAR EL VIERNES 16/10 …". Se lee la fecha si se puede y se
//     muestra con aviso para que Enrique la mire.
// ═══════════════════════════════════════════════════════════

export const TAG_PROGRAMADA = 'ENTREGA_PROGRAMADA'
export const ATRIBUTO_FECHA = 'entrega_programada'
export const ATRIBUTO_FRANJA = 'entrega_franja'

// ─── Fechas "AAAA-MM-DD" (mediodía UTC, sin husos de por medio) ───

const DIA_MS = 86_400_000
const deFecha = (f) => new Date(`${f}T12:00:00Z`)
const aFecha = (d) => d.toISOString().slice(0, 10)
const dd = (n) => String(n).padStart(2, '0')
export const esFechaValida = (f) => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) && aFecha(deFecha(f)) === f

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

/** "2026-10-16" → "viernes 16/10". */
export function nombreDia(fecha) {
  const d = deFecha(fecha)
  return `${DIAS_SEMANA[d.getUTCDay()]} ${dd(d.getUTCDate())}/${dd(d.getUTCMonth() + 1)}`
}

// ─── Leer la programación del pedido (tags + atributos + nota) ───

/** Tags de Shopify: texto "A, B" (REST/CSV) o lista (GraphQL) → ['A', 'B'] en mayúscula. */
export function listaTags(tags) {
  const lista = Array.isArray(tags) ? tags : String(tags ?? '').split(',')
  return lista.map((t) => String(t ?? '').trim().toUpperCase()).filter(Boolean)
}

/** Atributo de "nombre: valor" por línea (Note Attributes del CSV). La clave tiene que ser exacta. */
function atributo(notas, clave) {
  for (const linea of String(notas ?? '').split('\n')) {
    const i = linea.indexOf(':')
    if (i >= 0 && linea.slice(0, i).trim().toLowerCase() === clave) return linea.slice(i + 1).trim()
  }
  return ''
}

const DIAS_CORTE = 60 // una fecha de más de 60 días atrás se toma como del año que viene (dic → ene)

/** Día y mes → "AAAA-MM-DD" con el año de `hoy` (o el siguiente si quedó muy atrás); null si no existe. */
function fechaDeDiaMes(dia, mes, hoy) {
  const anio = Number((esFechaValida(hoy) ? hoy : aFecha(new Date())).slice(0, 4))
  const armar = (a) => `${a}-${dd(mes)}-${dd(dia)}`
  let f = armar(anio)
  if (!esFechaValida(f)) return null
  if (esFechaValida(hoy) && (deFecha(hoy) - deFecha(f)) / DIA_MS > DIAS_CORTE) f = armar(anio + 1)
  return esFechaValida(f) ? f : null
}

const FRANJA_RE = /\b((?:antes|despu[eé]s|a partir|desde|hasta)\s+de\s+las\s+\d{1,2}(?:[:.]\d{2})?(?:\s*(?:hs?|horas))?|entre\s+las\s+\d{1,2}(?:[:.]\d{2})?\s+y\s+las\s+\d{1,2}(?:[:.]\d{2})?(?:\s*(?:hs?|horas))?|por\s+la\s+(?:mañana|tarde|noche))/i

/**
 * 13-10: programación de entrega del pedido, o null si no es programado.
 * { fecha: 'AAAA-MM-DD' | null, franja, origen: 'atributos' | 'formato_viejo', revisar, detalle }
 * `revisar`: formato viejo, o tag sin fecha válida → se muestra con aviso para que Enrique mire la fecha.
 */
export function leerProgramacion({ tags, notas, nota, hoy } = {}) {
  const lista = listaTags(tags)
  const conTag = lista.includes(TAG_PROGRAMADA)
  const fechaAttr = atributo(notas, ATRIBUTO_FECHA)
  const franjaAttr = atributo(notas, ATRIBUTO_FRANJA)
  const viejo = lista.find((t) => t.startsWith('ENTREGAR_'))
  if (!conTag && !fechaAttr && !viejo) return null

  if ((conTag || fechaAttr) && esFechaValida(fechaAttr)) {
    return { fecha: fechaAttr, franja: franjaAttr, origen: 'atributos', revisar: false, detalle: '' }
  }

  // Formato viejo (o tag sin fecha válida): se intenta sacar la fecha del tag o de la nota.
  const notaTxt = String(nota ?? '').trim()
  let fecha = null
  const mTag = viejo && /_(\d{1,2})_(\d{1,2})(?:_|$)/.exec(viejo)
  if (mTag) fecha = fechaDeDiaMes(Number(mTag[1]), Number(mTag[2]), hoy)
  if (!fecha) {
    const mNota = /entregar[^\n]*?\b(\d{1,2})\/(\d{1,2})\b/i.exec(notaTxt)
    if (mNota) fecha = fechaDeDiaMes(Number(mNota[1]), Number(mNota[2]), hoy)
  }
  const franja = franjaAttr || (FRANJA_RE.exec(notaTxt)?.[1] ?? '')
  const lineaNota = notaTxt.split('\n').find((l) => /entregar/i.test(l)) || ''
  const detalle = [viejo, lineaNota.trim()].filter(Boolean).join(' · ') || (fechaAttr ? `${ATRIBUTO_FECHA}: ${fechaAttr}` : TAG_PROGRAMADA)
  return { fecha, franja: franja.trim(), origen: conTag ? 'atributos' : 'formato_viejo', revisar: true, detalle }
}

/** Atributos de nota del JSON de Shopify: REST note_attributes {name, value} o GraphQL customAttributes {key, value}. */
export function atributosShopify(raw) {
  const lista = [
    ...(Array.isArray(raw?.note_attributes) ? raw.note_attributes : []),
    ...(Array.isArray(raw?.customAttributes) ? raw.customAttributes : []),
  ]
  return lista.map((a) => `${a?.name ?? a?.key ?? ''}: ${a?.value ?? ''}`).join('\n')
}

/** Programación desde el JSON crudo de Shopify (`shopify_pedidos.raw`). */
export const programacionDesdeShopify = (raw, hoy) =>
  leerProgramacion({ tags: raw?.tags, notas: atributosShopify(raw), nota: raw?.note, hoy })

// ─── Lo que muestra Despacho ───

/** "Entregar el viernes 16/10 antes de las 12" (texto para el courier). */
export function textoEntregaCourier(fecha, franja) {
  const base = `Entregar el ${nombreDia(fecha)}`
  const f = String(franja ?? '').trim()
  if (!f) return base
  return /^(antes|despu|desde|a partir|entre|por |de |hasta|a las)/i.test(f) ? `${base} ${f}` : `${base} (${f})`
}

/**
 * 13-10: qué muestra Despacho de un pedido programado. null si no es programado.
 * No frena nada: el pedido se despacha el mismo día como cualquier otro.
 * {
 *   fecha, franja,
 *   badge: "📅 Entregar el viernes 16/10 (antes de las 12)" (+ aviso si es formato viejo o si la fecha ya pasó),
 *   textoCourier: "Entregar el viernes 16/10 antes de las 12" (va a la planilla y la guía; vacío si no hay fecha o ya pasó),
 *   aviso: true si hay que mirarlo (formato viejo, sin fecha legible o fecha pasada),
 * }
 */
export function estadoProgramacion(prog, { hoy } = {}) {
  if (!prog) return null
  const { fecha, franja } = prog
  const viejo = prog.revisar ? ` · ⚠ formato viejo: revisá la fecha${prog.detalle ? ` (${prog.detalle})` : ''}` : ''
  if (!fecha) {
    return { fecha, franja, textoCourier: '', aviso: true, badge: `📅 Entrega programada: fecha sin leer${viejo}` }
  }
  const atrasado = esFechaValida(hoy) && fecha < hoy
  const cuando = `📅 Entregar el ${nombreDia(fecha)}${franja ? ` (${franja})` : ''}`
  return {
    fecha, franja,
    textoCourier: atrasado ? '' : textoEntregaCourier(fecha, franja),
    aviso: atrasado || !!prog.revisar,
    badge: `${cuando}${atrasado ? ' · ⚠ la fecha ya pasó: avisale al cliente' : ''}${viejo}`,
  }
}
