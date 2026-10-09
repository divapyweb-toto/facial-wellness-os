// Panel de facturas (SIFEN): agrupación por estado, totales del mes con IVA
// discriminado, etiquetas y filas de exportación. Datos INVENTADOS.
import {
  filtrarPorPestana, contarPorPestana, resumenMes, rangoMes, diaAsuncion, mesAsuncion,
  numeroCompleto, etiquetaPedido, etiquetaCliente, siglaTipo, infoEstado, esModoPrueba,
  filasExportacion, filasResumen, aCsv, COLUMNAS_EXPORT, esTablaInexistente, motivoErrorReenvio,
  fechaHoraCorta,
} from '../src/pages/facturas/logica.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

const F = (o) => ({
  tipo_documento: 1, establecimiento: '001', punto: '001', timbrado: '12345678', ambiente: 'test', simulado: false,
  receptor_tipo: 'innominado', ruc: null, razon_social: null,
  base10: 0, iva10: 0, base5: 0, iva5: 0, exento: 0, total: 0, ...o,
})
const facturas = [
  F({ id: 'a', numero: 1, estado: 'aprobada', fecha_emision: '2026-10-08T13:00:00Z', base10: 100000, iva10: 10000, total: 110000, cdc: '0'.repeat(44) }),
  F({ id: 'b', numero: 2, estado: 'aprobada', fecha_emision: '2026-10-05T13:00:00Z', receptor_tipo: 'ruc', ruc: '80000001-1', razon_social: 'Empresa Inventada SA', base10: 50000, iva10: 5000, base5: 20000, iva5: 1000, exento: 3000, total: 79000 }),
  F({ id: 'c', numero: 3, estado: 'pendiente', fecha_emision: '2026-10-08T02:30:00Z', total: 99000 }), // 07-10 23:30 en Asunción
  F({ id: 'd', numero: 4, estado: 'enviada', fecha_emision: '2026-10-06T13:00:00Z', total: 1 }),
  F({ id: 'e', numero: 5, estado: 'error', fecha_emision: null, creado_en: '2026-10-08T20:00:00Z', total: 1 }),
  F({ id: 'f', numero: 6, estado: 'rechazada', motivo_rechazo: 'RUC inexistente', fecha_emision: '2026-10-04T13:00:00Z', total: 5 }),
  F({ id: 'g', numero: 7, estado: 'cancelada', fecha_emision: '2026-10-03T13:00:00Z', total: 7 }),
  F({ id: 'h', tipo_documento: 5, numero: 1, estado: 'aprobada', fecha_emision: '2026-10-07T13:00:00Z', base10: 10000, iva10: 1000, total: 11000 }),
  F({ id: 'i', tipo_documento: 7, numero: 1, estado: 'aprobada', fecha_emision: '2026-10-07T13:00:00Z', total: 0 }),
]
const HOY = new Date('2026-10-08T15:00:00Z') // 12:00 en Asunción

console.log('── fechas en hora de Asunción ──')
ok(diaAsuncion('2026-10-08T02:30:00Z') === '2026-10-07', '02:30 UTC del 08 es el 07 en Paraguay')
ok(mesAsuncion(new Date('2026-11-01T02:00:00Z')) === '2026-10', 'el 01-11 a las 23:00 de Asunción sigue siendo octubre')
const r = rangoMes('2026-10')
ok(r.desde === '2026-10-01T03:00:00.000Z' && r.hasta === '2026-11-01T03:00:00.000Z', `rango del mes en UTC: ${r.desde} → ${r.hasta}`)
ok(rangoMes('2026-12').hasta === '2027-01-01T03:00:00.000Z', 'diciembre cruza de año')
ok(fechaHoraCorta('2026-10-08T15:04:00Z') === '08/10/2026 12:04', `fecha corta: ${fechaHoraCorta('2026-10-08T15:04:00Z')}`)

console.log('\n── etiquetas ──')
ok(numeroCompleto({ numero: 1, establecimiento: '001', punto: '001' }) === '001-001-0000001', 'número 001-001-0000001')
ok(numeroCompleto({ numero_completo: '002-003-0000045', numero: 45 }) === '002-003-0000045', 'respeta numero_completo guardado')
ok(etiquetaPedido('#1003', 999) === 'VT-1003', '#1003 → VT-1003')
ok(etiquetaPedido(null, 18900000000001) === '#18900000000001' && etiquetaPedido(null, null) === '—', 'sin nombre: id crudo o —')
ok(etiquetaCliente(facturas[0]) === 'Consumidor final' && etiquetaCliente(facturas[1]) === 'Empresa Inventada SA', 'innominado → Consumidor final')
ok(siglaTipo(1) === 'FE' && siglaTipo(4) === 'AF' && siglaTipo(5) === 'NC' && siglaTipo(6) === 'ND' && siglaTipo(7) === 'NR', 'siglas FE/AF/NC/ND/NR')
ok(infoEstado('aprobada').badge === 'badge-green' && infoEstado('rechazada').badge === 'badge-red' && infoEstado('raro').grupo === 'otros', 'badges por estado y estado desconocido no rompe')

console.log('\n── pestañas ──')
const c = contarPorPestana(facturas)
ok(c.todas === 9, 'todas = 9')
ok(c.aprobadas === 4, 'aprobadas = 4 (FE×2, NC, NR)')
ok(c.pendientes === 3, 'pendientes = pendiente + enviada + error')
ok(c.rechazadas === 1 && filtrarPorPestana(facturas, 'rechazadas')[0].motivo_rechazo === 'RUC inexistente', 'rechazadas trae el motivo')
ok(c.canceladas === 1, 'canceladas = 1')
ok(c.nc === 1 && filtrarPorPestana(facturas, 'nc')[0].id === 'h', 'notas de crédito por tipo 5')

console.log('\n── resumen del mes ──')
const res = resumenMes(facturas, HOY)
ok(res.delDia === 2, `del día (Asunción) = 2 [a, e]; c es del 07: ${res.delDia}`)
ok(res.pendientes === 3 && res.rechazadas === 1 && res.canceladas === 1, 'contadores de tarjetas')
const t = res.totales
ok(t.base10 === 140000 && t.iva10 === 14000, `base/IVA 10 netos de NC: ${t.base10}/${t.iva10}`)
ok(t.base5 === 20000 && t.iva5 === 1000 && t.exento === 3000, 'base/IVA 5 y exento')
ok(t.total === 178000 && t.totalIva === 15000, `total neto ${t.total} (110000+79000−11000), IVA ${t.totalIva}`)
ok(t.cantidad === 3, 'NR no cuenta como venta (FE×2 + NC)')
ok(!resumenMes([F({ estado: 'rechazada', total: 500, iva10: 50 })]).totales.total, 'rechazadas no suman plata')
ok(resumenMes([]).totales.total === 0 && resumenMes(null).cantidad === 0, 'mes vacío no rompe')

console.log('\n── modo prueba ──')
ok(esModoPrueba(facturas), 'ambiente test → cartel')
ok(!esModoPrueba([{ ambiente: 'prod', simulado: false }]), 'prod real → sin cartel')
ok(esModoPrueba([{ ambiente: 'prod', simulado: true }]), 'simulado → cartel')

console.log('\n── exportación para la contadora ──')
const filas = filasExportacion(facturas)
ok(filas.length === 9, 'una fila por comprobante (todos los estados)')
ok(JSON.stringify(Object.keys(filas[0])) === JSON.stringify(COLUMNAS_EXPORT), 'columnas en el orden pedido')
ok(filas[0]['Número'] === '001-001-0000007' && filas[0]['Fecha'] === '03/10/2026', 'ordenadas por fecha, DD/MM/AAAA')
const fb = filas.find(f => f['Razón social'] === 'Empresa Inventada SA')
ok(fb['RUC/Documento receptor'] === '80000001-1' && fb['IVA 5%'] === 1000 && fb['Exento'] === 3000 && fb['Total'] === 79000, 'montos como números')
const fe = filas.find(f => f['Estado'] === 'Error')
ok(fe['Fecha'] === '08/10/2026', 'sin fecha_emision usa creado_en')
const resumen = filasResumen(facturas, '2026-10')
const neto = resumen.find(f => String(f['Concepto']).startsWith('NETO'))
ok(neto['Total'] === 178000 && neto['Total IVA'] === 15000 && neto['Cantidad'] === 3, 'hoja resumen: neto por tasa')
ok(resumen.find(f => f['Concepto'] === 'Total comprobantes del mes')['Cantidad'] === 9, 'hoja resumen: cantidad de comprobantes')
const csv = aCsv([{ A: 'x;y', B: 'di "hola"', C: 5 }], ['A', 'B', 'C'])
ok(csv === '﻿A;B;C\r\n"x;y";"di ""hola""";5', 'CSV con ; escapa separador y comillas')

console.log('\n── errores ──')
ok(esTablaInexistente({ code: '42P01', message: 'relation "facturas" does not exist' }), 'tabla inexistente (Postgres)')
ok(esTablaInexistente({ code: 'PGRST205', message: "Could not find the table 'public.facturas' in the schema cache" }), 'tabla inexistente (PostgREST)')
ok(!esTablaInexistente({ code: '42501', message: 'permission denied' }), 'permiso denegado NO es tabla inexistente')
ok(motivoErrorReenvio({ name: 'FunctionsHttpError', context: { status: 404 } }) === 'La función de reenvío todavía no está desplegada.', '404 → mensaje claro')
ok(/desplegada/.test(motivoErrorReenvio({ name: 'FunctionsFetchError', message: 'Failed to send' })), 'fallo de red → posible no desplegada')
ok(motivoErrorReenvio(null) === null, 'sin error → null')

if (fallas) { console.error(`\n✗ ${fallas} falla(s)`); process.exit(1) }
console.log('\n✓ facturas-panel: todo OK')
