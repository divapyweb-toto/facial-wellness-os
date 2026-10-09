// Arreglos de Entregas y Ventas (09-10-2026). Datos inventados.
// Correr: node --import ./tests/registrar.mjs tests/entregas-ventas-arreglos.test.mjs
import { filasPaPParaVoltra, idsVentasParaEstado, diasDesdeParaguay, hoyParaguay, deudaPorCourier, esDeTienda } from '../src/pages/entregas/arreglosEntregas.js'
import { tasaPorTransportadora } from '../src/lib/riesgoCiudad.js'
import { armarPayloadCourier } from '../src/lib/importarCourierWA.js'
import { combinar } from '../src/lib/importarPaP.js'
import { fechaLucero } from '../src/lib/exportLucero.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

console.log('── 5) aviso a Voltra OS: solo el reporte nuevo de PaP ──')
const nuevos = [
  { nro_guia_pap: '901', n_referencia: 'VT-1001', estado_pap: 'ENTREGADO' },
  { nro_guia_pap: '902', n_referencia: '3001', estado_pap: 'ENTREGADO' },
  { nro_guia_pap: 'L-VT-1002', n_referencia: 'VT-1002', estado_pap: 'Entregado', transportadora: 'lucero' },
]
const filas = filasPaPParaVoltra(nuevos)
ok(filas.length === 2 && !filas.some(f => f.transportadora === 'lucero'), 'excluye filas de Lucero')
const payload = armarPayloadCourier('pap', filas)
ok(payload.filas.length === 1 && payload.filas[0].referencia === 'VT-1001', 'el filtro VT- sigue: solo VT-1001 viaja')
ok(filasPaPParaVoltra([]).length === 0 && armarPayloadCourier('pap', filasPaPParaVoltra([])).filas.length === 0, 'sin reporte nuevo no se manda nada')

console.log('\n── 7) Lucero: ventas cruzadas con normalizarRef y por id ──')
const ventas = [
  { id: 'a', n_referencia: '#3005', estado: 'pendiente' },
  { id: 'b', n_referencia: '3005', estado: 'pendiente' },     // 2da línea del mismo pedido
  { id: 'c', n_referencia: 'VT-3005', estado: 'pendiente' },  // Voltra: NO es el mismo pedido
  { id: 'd', n_referencia: 'FW-3006', estado: 'entregado' },  // ya entregada: no se toca
  { id: 'e', n_referencia: '3007', estado: 'pendiente' },
]
const ids = idsVentasParaEstado(ventas, ['3005', '3006'], 'entregado')
ok(ids.join(',') === 'a,b', "'3005' cruza con '#3005' y '3005', no con 'VT-3005'; la ya entregada se saltea")
ok(idsVentasParaEstado(ventas, ['VT-3005'], 'devuelto').join(',') === 'c', 'VT-3005 solo toca la venta de Voltra')
ok(idsVentasParaEstado(ventas, [], 'entregado').length === 0, 'sin referencias no toca nada')

console.log('\n── 8) tasa por transportadora ──')
const entregas = [
  { n_referencia: 'VT-1003', categoria: 'entregado', transportadora: 'lucero' },
  { n_referencia: '1003', categoria: 'devuelto' },
  { n_referencia: 'VT-1004', categoria: 'entregado' },
]
const mapa = { '1003': 'pap', 'VT-1004': 'lucero' }
const tp = tasaPorTransportadora(entregas, mapa)
ok(tp.lucero?.entregados === 2 && tp.lucero?.resueltos === 2, 'VT-1003 usa la transportadora de la entrega; VT-1004 cae a la venta')
ok(tp.pap?.devueltos === 1 && tp.pap?.resueltos === 1, 'el 1003 de FW no se mezcla con el VT-1003')
ok(tp.total?.resueltos === 3, 'total correcto')

console.log('\n── 14) días sin rendir con día de Paraguay ──')
// 09-10 a las 22:30 en Paraguay = 10-10 01:30 UTC
const ahora = new Date('2026-10-10T01:30:00Z')
ok(hoyParaguay(ahora) === '2026-10-09', 'hoy en Paraguay es 09-10 aunque en UTC ya sea 10-10')
ok(diasDesdeParaguay('2026-10-09', ahora) === 0, 'entregado hoy → 0 días (antes daba 1)')
ok(diasDesdeParaguay('2026-10-01', ahora) === 8, 'entregado el 01-10 → 8 días')
ok(diasDesdeParaguay(null, ahora) === null, 'sin fecha → null')

console.log('\n── 15) fechas de Excel con hora tarde ──')
const tarde = new Date(2026, 9, 8, 22, 30)   // 08-10 22:30 hora local de la máquina
ok(fechaLucero(tarde) === '2026-10-08', 'Lucero: 08-10 22:30 sigue siendo 08-10')
const pap = combinar(null, { rows: [{ NroGuia: '777', NroGuiaRef: '3010', Estado: 'ENTREGADO', Importe: 100000, Ciudad: 'CDE', FechaIng: new Date(2026, 9, 7, 23, 50), FechaEnt: tarde }] })
ok(pap[0].fecha_ingreso === '2026-10-07' && pap[0].fecha_entrega === '2026-10-08', 'PaP: fechas con hora tarde no corren un día')

console.log('\n── 9) lo que te deben, por courier y neto ──')
const d = deudaPorCourier([
  { importe: 150000, depositoReal: 150000 },
  { importe: 200000, depositoReal: 170000, transportadora: 'lucero' },
  { importe: 90000 },
])
ok(d.pap === 240000 && d.lucero === 170000 && d.total === 410000, 'Lucero cuenta neto de flete, PaP bruto')

console.log('\n── 1) filtro de tienda del reporte nuevo ──')
ok(esDeTienda({ tienda: 'voltra' }, 'voltra') && !esDeTienda({ tienda: 'fw' }, 'voltra') && esDeTienda({ tienda: 'fw' }, 'todas'), 'filas filtradas por tienda')

console.log(fallas ? `\n✗ ${fallas} falla(s)` : '\n✓ arreglos de Entregas y Ventas OK')
process.exit(fallas ? 1 : 0)
