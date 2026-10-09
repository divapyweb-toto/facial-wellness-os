// src/lib/importarCourierWA.js
// ═══════════════════════════════════════════════════════════
// Puente entre los parsers de couriers que ya existen y la Edge Function
// `importar-courier` (avisos de WhatsApp de Voltra).
//
// NO parsea nada: toma la salida de
//   · parsearExportLucero(filas)   → src/lib/exportLucero.js
//   · combinar(paquete, gestion)   → src/lib/importarPaP.js
// y arma { courier, filas:[{referencia, estado_crudo, telefono, fecha, extra}] }.
// El saneo (multas 2147483647, fechas en dos formatos, lote dentro de la fecha
// de rendición, notas "N/A |") ya lo hacen esos parsers; la función repite un
// saneo defensivo del lado del servidor.
//
// Solo se mandan los datos necesarios para cruzar y avisar: nada de nombre ni
// dirección del cliente (el nombre sale del pedido de Shopify).
// ═══════════════════════════════════════════════════════════

import { esRefVoltra } from './referencias'

const TAMANO_LOTE = 500

// Lucero: el Codigo va COMPLETO ('FW-2071'), no `referencia` ('2071'): la
// función decide con config_wa.prefijos_courier si el prefijo es de esta tienda.
export function filasDesdeLucero(items) {
  return (items || []).map(it => ({
    referencia: it.codigo || '',
    estado_crudo: it.estado || '',
    telefono: it.telefono || '',
    fecha: it.fechaUltimoEstado || it.fechaCreado || null,
    extra: {
      envio_id: it.envioId || null,
      rendido: !!it.rendido,
      fecha_rendicion: it.fechaRendicion || null,
      lote: it.lote || null,
      motivo: it.motivo || '',
      total: it.total ?? null,
      tarifa: it.tarifa ?? null,
      multa: it.multa ?? null,
      fecha_ruta: it.fechaRuta || null,
      monto_corrupto: !!it.montoCorrupto,
    },
  }))
}

// PaP: NroGuiaRef ya normalizado por combinar() en `n_referencia`.
export function filasDesdePaP(registros) {
  return (registros || []).map(r => ({
    referencia: r.n_referencia || '',
    estado_crudo: r.estado_pap || '',
    telefono: r.telefono_courier || '',
    fecha: r.fecha_entrega || r.fecha_ingreso || null,
    extra: {
      nro_guia: r.nro_guia_pap || null,
      rendido: !!r.rendido,
      fecha_rendido: r.fecha_rendido || null,
      motivo: r.motivo || '',
      importe: r.importe ?? null,
      ruta_asignada: !!r.mensajero,
    },
  }))
}

// Arma el payload: descarta filas sin referencia NI teléfono (imposibles de
// cruzar) y repetidas (misma referencia + estado + rendido).
export function armarPayloadCourier(courier, salidaParser) {
  if (courier !== 'lucero' && courier !== 'pap') throw new Error(`Courier desconocido: ${courier}`)
  const filas = courier === 'lucero' ? filasDesdeLucero(salidaParser) : filasDesdePaP(salidaParser)
  const vistos = new Set()
  const unicas = []
  for (const f of filas) {
    // Solo pedidos de Voltra (VT-…). Las filas de Facial Wellness o sin
    // referencia NO se mandan: el servidor podría cruzarlas por teléfono con un
    // cliente de Voltra y marcarle (o avisarle) un estado que no es suyo.
    if (!esRefVoltra(String(f.referencia).trim())) continue
    const k = `${f.referencia}|${f.estado_crudo}|${f.extra.rendido}`
    if (vistos.has(k)) continue
    vistos.add(k)
    unicas.push(f)
  }
  return { courier, filas: unicas }
}

// Llama a la función en lotes y suma los resúmenes. `supabase` es el cliente
// del navegador (lleva el JWT del usuario logueado).
export async function enviarImportacionCourier(supabase, payload, { onProgreso } = {}) {
  const total = {
    procesadas: 0, avisos_programados: 0, sin_pedido: 0, repetidas: 0,
    estado_no_reconocido: 0, estados_no_reconocidos: [], otra_tienda: 0,
    cancelados_cliente: 0, errores: [],
  }
  const filas = payload.filas || []
  for (let i = 0; i < filas.length; i += TAMANO_LOTE) {
    const lote = filas.slice(i, i + TAMANO_LOTE)
    const { data, error } = await supabase.functions.invoke('importar-courier', {
      body: { courier: payload.courier, filas: lote },
    })
    if (error) {
      let detalle = error.message
      try { detalle = (await error.context?.json())?.error || detalle } catch { /* sin cuerpo */ }
      throw new Error(`No se pudo mandar el archivo a WhatsApp (filas ${i + 1}-${i + lote.length}): ${detalle}`)
    }
    for (const k of ['procesadas', 'avisos_programados', 'sin_pedido', 'repetidas', 'estado_no_reconocido', 'otra_tienda', 'cancelados_cliente']) {
      total[k] += data?.[k] || 0
    }
    total.estados_no_reconocidos = [...new Set([...total.estados_no_reconocidos, ...(data?.estados_no_reconocidos || [])])]
    total.errores.push(...(data?.errores || []))
    onProgreso?.(Math.min(i + lote.length, filas.length), filas.length)
  }
  return total
}

// Paso automático después de importar un Excel en Entregas: manda a Voltra OS
// los estados de los pedidos VT- (avisos por WhatsApp, Shopify, post-entrega,
// factura). Nunca tira: devuelve null si no había pedidos de Voltra.
export async function mandarAVoltraOS(supabase, courier, salidaParser) {
  const payload = armarPayloadCourier(courier, salidaParser)
  if (!payload.filas.length) return null
  return enviarImportacionCourier(supabase, payload)
}
