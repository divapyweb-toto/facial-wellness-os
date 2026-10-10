// Pendientes de criterio contable (facturas_retenidas) y export para la contadora.
// Datos INVENTADOS (repo público).
import {
  medioDePago, clienteDe, rucOCi, courierDe, fechaCobro, filasRetenidos, filasExportContadora,
  COLUMNAS_CONTADORA, criterioValido, motivoErrorLiberar, etiquetaMotivo,
} from '../src/pages/facturas/retenidos.js'
import { aCsv } from '../src/pages/facturas/logica.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

console.log('── medio de pago ──')
ok(medioDePago([]) === 'efectivo COD', 'sin etiqueta → efectivo COD')
ok(medioDePago(['PAGO_VERIFICADO']) === 'transferencia anticipada', 'PAGO_VERIFICADO → transferencia anticipada (sin asumir banco)')
ok(medioDePago(['PAGO_VERIFICADO', 'PAGADO_QR']) === 'QR', 'PAGADO_QR gana')
ok(medioDePago(null) === 'efectivo COD', 'tags null → efectivo COD')

console.log('\n── cliente, RUC/CI y courier ──')
const pWeb = { shopify_order_id: 1, nombre: '#2001', total: 162000, tags: [], courier: 'Lucero', raw: { shipping_address: { name: 'Cliente Inventado' }, note_attributes: [{ name: 'Cédula', value: '1.234.567' }] } }
ok(clienteDe(pWeb, null) === 'Cliente Inventado', 'cliente desde la dirección de envío')
ok(rucOCi(pWeb, null) === 'CI 1234567', `cédula de los atributos: ${rucOCi(pWeb, null)}`)
const df = { ruc: '80000001', dv: '9', razon_social: 'Mayorista Inventado SRL' }
ok(clienteDe(pWeb, df) === 'Mayorista Inventado SRL', 'pedido_datos_fiscales manda en el cliente')
ok(rucOCi(pWeb, df) === '80000001-9', 'pedido_datos_fiscales manda en el RUC (base-DV)')
ok(rucOCi({ raw: { note_attributes: [{ name: 'Ruc', value: '80000002-7' }, { name: 'Razon social', value: 'Otra SA' }] } }, null) === '80000002-7', 'RUC de los atributos (Releasit)')
ok(rucOCi({ raw: { note_attributes: [{ name: 'Ruc', value: 'no' }] } }, null) === '', '"no" no es un RUC')
ok(courierDe(pWeb) === 'Lucero', 'courier del pedido')
ok(courierDe({ tags: ['MAYORISTA'] }) === 'mayorista', 'sin courier y MAYORISTA → mayorista')

console.log('\n── fecha de cobro ──')
ok(fechaCobro({ tags: [] }, { rendidoEn: '2026-10-09T15:00:00Z' }) === '2026-10-09T15:00:00Z', 'COD → cuando el courier rindió')
ok(fechaCobro({ tags: [] }, {}) === null, 'COD sin rendir → vacío')
ok(fechaCobro({ tags: ['PAGADO_QR'] }, { qrPagadoEn: '2026-10-05T12:00:00Z', rendidoEn: 'x' }) === '2026-10-05T12:00:00Z', 'QR → pagado_en del cobro')
ok(fechaCobro({ tags: ['PAGO_VERIFICADO'] }, { rendidoEn: 'x' }) === null, 'transferencia anticipada → sin fecha registrada')

console.log('\n── filas y export (caso: transferencia anticipada Gs 112.000 entregada antes del corte) ──')
const retenidas = [
  { shopify_order_id: 11, motivo: 'anterior_al_corte', retenido_en: '2026-10-10T12:00:00Z', liberado_en: null },
  { shopify_order_id: 12, motivo: 'anterior_al_corte', retenido_en: '2026-10-10T12:00:00Z', liberado_en: null },
  { shopify_order_id: 13, motivo: 'anterior_al_corte', liberado_en: '2026-10-10T13:00:00Z', criterio: 'facturar con fecha de hoy' },
]
const pedidos = {
  11: { shopify_order_id: 11, nombre: '#3011', total: 112000, tags: ['PAGO_VERIFICADO'], courier: 'PaP', entregado_en: '2026-10-08T15:00:00Z', raw: { customer: { first_name: 'Ana', last_name: 'Inventada' } } },
  12: { shopify_order_id: 12, nombre: '#3012', total: 162000, tags: [], courier: 'Lucero', entregado_en: '2026-10-07T02:30:00Z', raw: { shipping_address: { name: 'Beto Ficticio' } } },
}
const filas = filasRetenidos(retenidas, { pedidos, rendidos: { 12: '2026-10-09T18:00:00Z' } })
ok(filas.length === 2, 'los liberados no aparecen')
ok(filas[0].id === 12 && filas[1].id === 11, 'ordenados por fecha de entrega')
const t = filas.find((f) => f.id === 11)
ok(t.medio_pago === 'transferencia anticipada' && t.monto === 112000 && t.cobrado_en === null && t.courier === 'PaP', 'transferencia anticipada de 112.000 retenida')
const exp = filasExportContadora(filas)
ok(JSON.stringify(Object.keys(exp[0])) === JSON.stringify(COLUMNAS_CONTADORA), 'columnas del CSV en orden')
ok(exp[0]['Fecha de entrega'] === '06/10/2026', `fecha de entrega en hora de Asunción: ${exp[0]['Fecha de entrega']}`)
ok(exp[0]['Fecha de cobro'] === '09/10/2026' && exp[0]['Medio de pago'] === 'efectivo COD', 'COD con fecha de rendición')
ok(exp[1]['Medio de pago'] === 'transferencia anticipada' && exp[1]['Fecha de cobro'] === '', 'transferencia sin fecha de cobro')
ok(exp[1].Motivo === 'Entregado antes del corte' && etiquetaMotivo('otro') === 'otro', 'motivo legible')
const csv = aCsv(exp, COLUMNAS_CONTADORA)
ok(csv.split('\r\n').length === 3 && csv.includes('#3011;Ana Inventada;;112000;08/10/2026;;transferencia anticipada;PaP'), 'CSV con ; y una fila por pedido')
ok(filasRetenidos(retenidas, {})[0].pedido === '11', 'sin datos del pedido: muestra el id igual')

console.log('\n── liberar ──')
ok(!criterioValido('') && !criterioValido('  a ') && criterioValido('facturar hoy'), 'criterio obligatorio (≥ 3 letras)')
ok(motivoErrorLiberar({ message: 'sifen_liberar: falta el criterio de la contadora' }).startsWith('Escribí'), 'error de criterio legible')
ok(motivoErrorLiberar({ message: 'sifen_liberar: el pedido 1 no tiene una retención pendiente' }).includes('ya fue liberado'), 'error de doble liberación legible')
ok(motivoErrorLiberar({ message: 'Could not find the function public.sifen_liberar' }).includes('migración'), 'falta la migración')

console.log(fallas ? `\n${fallas} falla(s)` : '\nTodo OK')
process.exit(fallas ? 1 : 0)
