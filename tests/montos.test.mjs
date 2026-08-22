// tests/montos.test.mjs
// ═══════════════════════════════════════════════════════════
// GUARDIÁN: ningún importador puede producir un valor que Postgres rechace.
//
// Origen: un envío de Lucero (FW-2155) trajo Multa = 2.147.483.647 — el
// máximo de un entero de 32 bits, o sea un dato sin inicializar de su
// sistema. El parser lo sumaba a la tarifa y daba 2.147.523.647; como el
// guardado va por lotes, se caían los 79 envíos por UNA fila.
//
// Este test envenena cada columna de dinero de cada importador con los
// valores que rompen de verdad, y falla si alguno llega a la base.
//
// Correr:  node tests/montos.test.mjs
// ═══════════════════════════════════════════════════════════
import { importeSano, esImporteCorrupto, cantidadSana, esCantidadCorrupta } from '../src/lib/estadosPaP.js'
import { parsearExportLucero, exportLuceroAEntregas } from '../src/lib/exportLucero.js'
import { parsearRendicionLucero } from '../src/lib/rendicionLucero.js'
import { parsearFilasRendicion } from '../src/lib/conciliacionRendicion.js'

const INT4 = 2147483647
let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }
const sano = (v) => v == null || (Number.isFinite(v) && Math.abs(v) <= INT4)

// Los que rompen: el máximo de int4, el que lo pasa por uno, y los negativos
// (la primera versión del arreglo solo miraba el tope superior y los dejaba pasar).
const VENENO = [2147483647, 2147483648, 9999999999, 1e15, -2147483648, -9999999999, Number.MAX_SAFE_INTEGER]

console.log('── saneadores compartidos ──')
ok(VENENO.every(v => sano(importeSano(v))), 'importeSano neutraliza todo valor venenoso')
ok(VENENO.every(v => sano(cantidadSana(v))), 'cantidadSana neutraliza todo valor venenoso')
ok([NaN, Infinity, -Infinity, undefined, null, 'basura', '1.2.3'].every(v => sano(importeSano(v)) && sano(cantidadSana(v))),
   'NaN, Infinity, null y texto no se cuelan')
ok(VENENO.every(v => esImporteCorrupto(v) && esCantidadCorrupta(v)), 'los detectores marcan todos los venenos (incluidos negativos)')
// Los máximos REALES del negocio no deben tocarse nunca.
ok(importeSano(400000) === 400000 && !esImporteCorrupto(400000), 'el importe máximo real (400.000) pasa intacto')
ok(cantidadSana(4) === 4 && !esCantidadCorrupta(4), 'la cantidad máxima real (4) pasa intacta')

console.log('\n── negativos LEGÍTIMOS: no se pueden perder ──')
// `neto_depositado` es lo que realmente cae al banco. En un prepago o una
// devolución es NEGATIVO: cobraste 0 y el flete se paga igual, así que le
// debés esa plata a Lucero. Casos reales: FW-2031 (−25.000), FW-2152 (−30.000).
// El chequeo por magnitud los conserva; uno que solo mirara el signo los borraría.
ok([-25000, -30000, -40000, -1, -1999999].every(v => !esImporteCorrupto(v)),
   'los netos negativos reales NO se marcan como corruptos')
ok([-2147483648, -9999999999].every(v => esImporteCorrupto(v)),
   'los negativos IMPOSIBLES sí se marcan')

console.log('\n── export de seguimiento de Lucero ──')
const H = ['Codigo','EnvioID','Empresa','Estado','FechaCreado','FechaUltimoEstado','Ciudad','Zona','Barrio','Destinatario','Telefono','Direccion','Item','Cantidad','Total','Tarifa','Multa','FormaPago','Motivo','Transportador','FechaAsignacionRuta','Rendido','FechaRendicion','Notas']
const BASE = { Codigo:'FW-9001', EnvioID:'1', Empresa:'FW', Estado:'Entregado', FechaCreado:'01/08/2026',
  FechaUltimoEstado:'02/08/2026', Ciudad:'Asunción', Item:'X', Cantidad:1, Total:98000, Tarifa:30000, Multa:0, Rendido:'Sí' }
let malL = 0
for (const v of VENENO) for (const col of ['Total','Tarifa','Multa','Cantidad']) {
  const fila = H.map(h => (col === h ? v : (BASE[h] ?? '')))
  const regs = exportLuceroAEntregas(parsearExportLucero([H, fila]))
  if (!regs.flatMap(r => ['importe','cobrado','costo_envio','neto_depositado'].map(k => r[k])).every(sano)) malL++
}
ok(malL === 0, `${VENENO.length}×4 combinaciones envenenadas, ningún campo desborda`)

console.log('\n── rendición de Lucero ──')
const HR = ['ItemID','EnvioID','Código operación','Cliente recibe','EstadoFinal','Ciudad','Item','Cantidad','Tarifa','TotalCobrar','PagoCliente']
let malR = 0
for (const v of VENENO) for (const i of [8, 9, 10]) {
  const f = ['1','15','FW-9002','Ana','Entregado','Luque','X',1,30000,98000,68000]; f[i] = v
  const out = parsearRendicionLucero([['Resumen de lote'],['Lote',1,'Empresa','FW','Fecha','01/08/2026'],
    ['Bruto',1,'Tarifas',1,'Multas',0,'TotalPago',1],['GeneradoEn','x'],[],HR,f])
  const items = out.items || out
  if (!items.flatMap(x => [x.tarifa, x.totalCobrar, x.pagoCliente]).every(sano)) malR++
}
ok(malR === 0, `${VENENO.length}×3 combinaciones envenenadas, ningún monto desborda`)

console.log('\n── conciliación de rendición de PaP ──')
let malC = 0
for (const v of VENENO) for (const col of ['Importe','Cobrado']) {
  const filas = parsearFilasRendicion([{ NroGuia:'26000001', NroGuiaRef:'#900', Nombre:'X',
    Estado:'Entregado', Importe:98000, Cobrado:98000, FormaPago:'Efectivo', [col]: v }])
  if (!filas.every(f => sano(f.importe) && sano(f.cobrado))) malC++
}
ok(malC === 0, `${VENENO.length}×2 combinaciones envenenadas, ningún monto desborda`)

console.log(fallas ? `\n✗ ${fallas} FALLAS` : '\n✓ ningún importador puede producir un valor fuera de rango')
process.exit(fallas ? 1 : 0)
