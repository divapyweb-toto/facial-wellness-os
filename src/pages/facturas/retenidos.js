// src/pages/facturas/retenidos.js
// ═══════════════════════════════════════════════════════════
// PENDIENTES DE CRITERIO CONTABLE (lógica pura, sin React ni Supabase)
//
// Pedidos de Shopify (Voltra) que la cola SIFEN NO factura sola: están en
// `facturas_retenidas` sin `liberado_en` (p. ej. entregados antes del corte
// facturar_desde). La contadora decide; Enrique pulsa "Liberar" con su
// criterio (RPC sifen_liberar) y la cola los factura en la próxima corrida.
// Solo pedidos de Shopify: shopify_pedidos es la tienda Voltra (Facial
// Wellness no pasa por acá). Ventas directas: en espera (10-10).
// Tests: tests/facturas-retenidos.test.mjs (datos inventados).
// ═══════════════════════════════════════════════════════════

import { diaAsuncion, ddmmyyyy } from './logica'

export const TAG_QR = 'PAGADO_QR'
export const TAG_TRANSFERENCIA = 'PAGO_VERIFICADO'
export const TAG_MAYORISTA = 'MAYORISTA'

export const MOTIVOS = {
  anterior_al_corte: 'Entregado antes del corte',
}
export const etiquetaMotivo = (m) => MOTIVOS[m] || (m ? String(m) : '—')

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
const txt = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null)
const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Atributos del pedido (Releasit note_attributes o customAttributes de pedidos creados por API). */
export function atributos(raw) {
  const r = obj(raw)
  const a = Array.isArray(r.note_attributes) ? r.note_attributes : Array.isArray(r.customAttributes) ? r.customAttributes : []
  return a.map((x) => ({ k: norm(obj(x).name ?? obj(x).key), v: String(obj(x).value ?? '').trim() }))
}
const atributo = (raw, claves) => {
  const set = new Set(claves.map(norm))
  return atributos(raw).find((a) => set.has(a.k) && a.v && !/^(no|n|-+|ninguna?|x|0)$/i.test(a.v))?.v || null
}

/**
 * Medio de pago para la contadora. Banco de la transferencia: no se registra en el
 * pedido, así que sale "transferencia anticipada" (no se asume ueno ni Continental).
 */
export function medioDePago(tags) {
  const t = tags || []
  if (t.includes(TAG_QR)) return 'QR'
  if (t.includes(TAG_TRANSFERENCIA)) return 'transferencia anticipada'
  return 'efectivo COD'
}

export function clienteDe(pedido, datosFiscales) {
  if (txt(datosFiscales?.razon_social)) return datosFiscales.razon_social.trim()
  const r = obj(pedido?.raw)
  const razon = atributo(r, ['razon social', 'razón social', 'razon_social'])
  if (razon) return razon
  const dir = obj(r.shipping_address)
  const cli = obj(r.customer)
  return txt(dir.name) || [txt(cli.first_name), txt(cli.last_name)].filter(Boolean).join(' ') || txt(obj(r.billing_address).name) || '—'
}

/** RUC (base-DV) de pedido_datos_fiscales o de los atributos; si no, la cédula; si no, vacío. */
export function rucOCi(pedido, datosFiscales) {
  const df = datosFiscales || {}
  if (txt(df.ruc)) return txt(df.dv) && !String(df.ruc).includes('-') ? `${df.ruc.trim()}-${df.dv.trim()}` : df.ruc.trim()
  const raw = pedido?.raw
  const ruc = atributo(raw, ['ruc']) || atributo(raw, ['factura', 'datos de factura', 'ruc y razon social'])
  if (ruc) return ruc
  const ci = atributo(raw, ['cedula', 'cédula', 'ci', 'documento', 'nro de cedula', 'número de cédula', 'numero de cedula'])
  return ci ? `CI ${ci.replace(/[.\s]/g, '')}` : ''
}

export function courierDe(pedido) {
  if (txt(pedido?.courier)) return pedido.courier.trim()
  if ((pedido?.tags || []).includes(TAG_MAYORISTA)) return 'mayorista'
  return ''
}

/**
 * Fecha de cobro (ISO o null):
 *   QR → cobros_qr.pagado_en; contra entrega → cuando el courier RINDIÓ (pedido_estados RENDIDO);
 *   transferencia anticipada → no queda registrada (null: la contadora la toma del extracto).
 */
export function fechaCobro(pedido, { rendidoEn, qrPagadoEn } = {}) {
  const medio = medioDePago(pedido?.tags)
  if (medio === 'QR') return qrPagadoEn || null
  if (medio === 'efectivo COD') return rendidoEn || null
  return null
}

/**
 * Une las retenciones sin liberar con su pedido y datos extra.
 * retenidas: filas de facturas_retenidas; pedidos/rendidos/qr/fiscales: mapas por shopify_order_id.
 */
export function filasRetenidos(retenidas, { pedidos = {}, rendidos = {}, qr = {}, fiscales = {} } = {}) {
  return (retenidas || [])
    .filter((r) => !r.liberado_en && r.shopify_order_id != null)
    .map((r) => {
      const id = r.shopify_order_id
      const p = pedidos[id] || { shopify_order_id: id, tags: [] }
      const df = fiscales[id] || null
      return {
        id,
        pedido: p.nombre || String(id),
        cliente: clienteDe(p, df),
        ruc_ci: rucOCi(p, df),
        monto: Number(p.total) || 0,
        entregado_en: p.entregado_en || null,
        cobrado_en: fechaCobro(p, { rendidoEn: rendidos[id], qrPagadoEn: qr[id] }),
        medio_pago: medioDePago(p.tags),
        courier: courierDe(p),
        motivo: r.motivo,
        retenido_en: r.retenido_en || null,
        nota: r.nota || '',
      }
    })
    .sort((a, b) => String(a.entregado_en || '').localeCompare(String(b.entregado_en || '')))
}

export const COLUMNAS_CONTADORA = [
  'Pedido', 'Cliente', 'RUC/CI', 'Monto (Gs)', 'Fecha de entrega', 'Fecha de cobro', 'Medio de pago', 'Courier', 'Motivo',
]

/** Filas del CSV para la contadora (fechas dd/mm/aaaa en hora de Asunción). */
export function filasExportContadora(filas) {
  const f = (iso) => (iso ? ddmmyyyy(diaAsuncion(iso)) : '')
  return (filas || []).map((x) => ({
    Pedido: x.pedido,
    Cliente: x.cliente,
    'RUC/CI': x.ruc_ci,
    'Monto (Gs)': x.monto,
    'Fecha de entrega': f(x.entregado_en),
    'Fecha de cobro': f(x.cobrado_en),
    'Medio de pago': x.medio_pago,
    Courier: x.courier,
    Motivo: etiquetaMotivo(x.motivo),
  }))
}

/** El criterio de la contadora es obligatorio (la RPC exige al menos 3 caracteres). */
export function criterioValido(texto) {
  return String(texto || '').trim().length >= 3
}

/** Mensaje legible de un error de sifen_liberar. */
export function motivoErrorLiberar(error) {
  const m = String(error?.message || error || '')
  if (/falta el criterio/i.test(m)) return 'Escribí el criterio de la contadora (mínimo 3 letras).'
  if (/no tiene una retenci/i.test(m)) return 'Ese pedido ya fue liberado o no está retenido. Recargá la página.'
  if (/sesi/i.test(m)) return 'Tu sesión venció: volvé a entrar.'
  if (/function .* does not exist|could not find the function/i.test(m)) return 'Falta correr la migración del blindaje SIFEN (sifen_liberar).'
  return m || 'error desconocido'
}
