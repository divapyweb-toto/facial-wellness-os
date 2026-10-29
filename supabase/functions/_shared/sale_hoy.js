// _shared/sale_hoy.js · 29-10-2026. Enrique: "si no da para despachar es mejor que no se muestre".
// UNA sola regla de "sale hoy / no sale hoy" para la web (Despacho) y las Edge Functions (lista-despacho,
// pedidos-trabados). JS puro, sin imports: lo importan Deno (../_shared/sale_hoy.js) y Vite
// (../../../supabase/functions/_shared/sale_hoy.js), así no hay dos copias con criterios distintos.
//
// Sale hoy = confirmado (o "ayuda") + no cancelado + courier con cobertura (o ya pagado: courier libre)
//            + dirección utilizable (pin, o calle de 6 letras o más + ciudad, o zona/barrio + ciudad).
// Todo lo demás "no sale hoy", con el motivo en pocas palabras y quién lo resuelve (bot / sistema / Enrique).
// Cancelado o anulado (cancelled_at, CANCELADO_CLIENTE, voided…) no aparece en ningún lado.

/** Tags de Shopify (texto "A, B" o lista) → lista en minúsculas. */
export function listaTags(tags) {
  const l = Array.isArray(tags) ? tags : String(tags ?? '').split(',')
  return l.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
}

/**
 * Cancelado o anulado: no se muestra en ningún lado. Mismo criterio que ya usaban Despacho (clasificarEstado) y
 * lista-despacho: cancelled_at, cualquier tag con "cancelado" (CANCELADO_CLIENTE, SIN_COBERTURA_CANCELADO),
 * estado financiero "voided" (#1091), ANTERIOR_AL_CORTE y REEMPLAZADO_POR_… (lo reemplazó otro pedido).
 */
export function esCancelado({ tags, cancelledAt, financialStatus } = {}) {
  const t = listaTags(tags)
  if (cancelledAt) return true
  if (String(financialStatus ?? '').toLowerCase() === 'voided') return true
  return t.some((x) => x.includes('cancelado') || x === 'anterior_al_corte' || x.startsWith('reemplazado_por_'))
}

/** Confirmado por el cliente (o pidió ayuda: también sale, como hasta hoy). */
export function esConfirmado(tags) {
  const t = listaTags(tags)
  return t.some((x) => x.includes('confirmado')) || t.includes('ayuda') || t.includes('help')
}

// ── Dirección utilizable (la misma que usa pedidos-trabados para poner FALTAN_DATOS) ──
const PIN = /-\d{1,2}\.\d{3,}\s*,\s*-\d{1,2}\.\d{3,}/
/** 28-10 (Enrique: "area 4 sirve ya como direccion"): zona o barrio reconocible. */
const ZONA = /\b(?:[aá]rea|zona|barrio|b[°º]|km|kil[oó]metro|villa|compa[nñ][ií]a|asentamiento|sector|fracci[oó]n|loteamiento|manzana|mz)\b/i

export function tienePin({ direccion = '', notas = '' } = {}) {
  return PIN.test(String(direccion)) || PIN.test(String(notas))
}

/**
 * Pin (15-10: "con el pin basta y sobra", aunque falte la ciudad), o ciudad + calle escrita (≥ 6 letras), o ciudad +
 * zona/barrio ("Área 4", "Km 7", "Barrio San Miguel"), o ciudad + "Ruta 2" (≥ 3 letras y un número).
 */
export function direccionUtilizable({ direccion = '', notas = '', ciudad = '' } = {}) {
  if (tienePin({ direccion, notas })) return true
  const c = String(ciudad ?? '').trim()
  if (!c || c === '-') return false
  const texto = String(direccion ?? '').replace(/pin de ubicaci[oó]n:?/gi, '').replace(/sin calle \(ubicaci[oó]n pendiente\)/gi, '')
    .replace(PIN, '').replace(/https?:\/\/\S+/g, '')
  const letras = texto.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '')
  if (letras.length >= 6) return true
  return ZONA.test(texto) || (letras.length >= 3 && /\d/.test(texto))
}

// ── Ciudad: la misma normalización que public.ciudad_norm / public.ciudad_fonetica (migración 20261029000002) ──
/** Minúsculas, sin tildes, sin lo que va entre paréntesis, cnel/gral/pdte expandidos, signos → espacio. */
export function normCiudad(t) {
  return String(t ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(cnel|cnl)\.?(\s|$)/g, 'coronel ').replace(/\bgral\.?(\s|$)/g, 'general ').replace(/\b(pdte|pte)\.?(\s|$)/g, 'presidente ')
    .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 29-10 (#1159 "Mbocayaty" vs tarifa "Mbocajaty"): clave "como suena" para el último intento de emparejar una ciudad
 * mal escrita. y→j, v→b, z→s, sin espacios y sin letras repetidas ("Villa Rica" = "Villarrica"). Solo se usa con la
 * clave ENTERA (nunca "contiene"), y se verificó que no junta dos ciudades distintas de la tabla de tarifas.
 */
export function claveFonetica(t) {
  return normCiudad(t).replace(/[yvz]/g, (c) => ({ y: 'j', v: 'b', z: 's' })[c]).replace(/ /g, '').replace(/(.)\1+/g, '$1')
}

// ── La regla ──
/** Motivo (pocas palabras) + quién lo resuelve + qué pasa, para la sección "No sale hoy". */
export const MOTIVOS = {
  sin_confirmar: { motivo: 'Sin confirmar', quien: 'bot', detalle: 'en el flujo de confirmación; si no responde se cancela solo' },
  comprobante: { motivo: 'Comprobante', quien: 'Enrique', detalle: 'mandó comprobante: verificá el pago antes de despachar' },
  faltan_datos: { motivo: 'Faltan datos', quien: 'bot', detalle: 'falta la dirección: sin pin ni calle o zona con ciudad (se le pide al cliente)' },
  ciudad: { motivo: 'Faltan datos', quien: 'sistema', detalle: 'ciudad no reconocida: se busca por el pin o se le pide al cliente' },
  sin_cobertura: { motivo: 'Sin cobertura', quien: 'sistema', detalle: 'ningún courier cobra ahí: espera el pago anticipado (ofrecido; sin pago a las 48 h se cancela)' },
  no_recibe: { motivo: 'No recibe', quien: 'Enrique', detalle: 'historial de no recepción: habilitalo o pedí pago anticipado' },
  ciudad_riesgo: { motivo: 'Ciudad riesgosa', quien: 'Enrique', detalle: 'esa ciudad casi no recibe con ese courier: forzalo o cambiá de courier' },
  sin_flete: { motivo: 'Falta flete', quien: 'Enrique', detalle: 'courier "otra" sin costo de flete cargado' },
  retiro: { motivo: 'Retira en persona', quien: 'Enrique', detalle: 'lo retira en la oficina: no va al courier' },
}

const noSale = (clave) => ({ sale: false, clave, ...MOTIVOS[clave] })

/**
 * ¿Sale hoy? Entrada (todo opcional salvo lo que aplique):
 *   cancelado, retiro (RETIRO_EN_CASA), confirmado, pagado (antes de la entrega), comprobante (sin verificar),
 *   faltanDatos (tag FALTAN_DATOS u otro dato de entrega faltante), direccionOk (default true),
 *   courier ('pap' | 'lucero' | 'otra' con cobertura, o null), sinCoberturaTag (SIN_COBERTURA),
 *   ciudadReconocida (true / false / null = no se sabe), bloqueadoRiesgo, bloqueadoCiudad, sinFlete.
 * Salida: { oculto: true } (cancelado) · { retiro: true, clave: 'retiro', … } · { sale: true, courier } · { sale: false, clave, motivo, quien, detalle }.
 */
export function decidirSalida(p = {}) {
  if (p.cancelado) return { oculto: true, sale: false }
  if (p.retiro) return { retiro: true, ...noSale('retiro') }
  if (!p.confirmado) return noSale('sin_confirmar')
  if (p.comprobante && !p.pagado) return noSale('comprobante')
  if (p.faltanDatos || p.direccionOk === false) return noSale(p.ciudadReconocida === false && !p.courier ? 'ciudad' : 'faltan_datos')
  if (!p.courier && !p.pagado) {
    // 29-10 (#1150 "Casa"): una ciudad que no está en las tablas NUNCA es "sin cobertura": primero hay que saber cuál es.
    if (p.ciudadReconocida === false && !p.sinCoberturaTag) return noSale('ciudad')
    return noSale('sin_cobertura')
  }
  if (p.bloqueadoRiesgo) return noSale('no_recibe')
  if (p.bloqueadoCiudad) return noSale('ciudad_riesgo')
  if (p.sinFlete) return noSale('sin_flete')
  // 27-10 (Enrique): "ya está pagada no necesita cobranza" → sin courier con cobranza va por el que llegue.
  return { sale: true, courier: p.courier || 'libre' }
}
