// tests/archivos-reales.test.mjs
// ═══════════════════════════════════════════════════════════
// Los parsers contra los archivos REALES de los couriers, en
// datos-couriers/. Complementa a montos.test.mjs: aquel prueba que lo
// imposible no pase, éste que lo normal siga funcionando igual.
//
// El export de Lucero incluido contiene el envío FW-2155 con la multa
// corrupta que tumbó una carga entera — por eso se conserva ese archivo.
//
// Correr:  npm test
// ═══════════════════════════════════════════════════════════
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { esExportLucero, parsearExportLucero, exportLuceroAEntregas, resumenExportLucero } from '../src/lib/exportLucero.js'
import { parsearRendicionLucero } from '../src/lib/rendicionLucero.js'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const DIR = new URL('../../datos-couriers/', import.meta.url).pathname
const INT4 = 2147483647
let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

const F_LUCERO = DIR + 'Exportacion_Lucero_2026-07-01_a_2026-08-20.xlsx'
if (!existsSync(F_LUCERO)) {
  console.log('⚠ falta datos-couriers/ — se omite (no es una falla)')
  process.exit(0)
}

console.log('── export de Lucero (archivo real) ──')
const wb = XLSX.readFile(F_LUCERO, { cellDates: true })
const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
ok(esExportLucero(filas), 'el formato se reconoce')
const items = parsearExportLucero(filas)
ok(items.length === 79, `79 envíos parseados (dio ${items.length})`)
ok(items.every(i => i.referencia), 'todos con referencia')

const regs = exportLuceroAEntregas(items)
ok(regs.every(r => String(r.nro_guia_pap).startsWith('L-')), 'clave interna L- correcta')
ok(regs.filter(r => r.telefono_courier).length === 79, 'telefono_courier presente (alimenta la vinculación)')
ok(regs.flatMap(r => [r.importe, r.cobrado, r.costo_envio, r.neto_depositado]).every(v => v == null || Math.abs(v) <= INT4),
   'ningún monto excede integer')

const r = resumenExportLucero(items)
ok(r.montosCorruptos === 1 && r.codigosCorruptos[0] === 'FW-2155', 'detecta FW-2155 (multa = máximo de int32) y solo esa')
ok(r.multas === 20000, `las multas legítimas quedan intactas: ${r.multas} Gs`)
ok(regs.find(x => x.n_referencia === '2155').costo_envio === 40000, 'FW-2155 conserva su tarifa real de 40.000')
ok(r.entregados + r.devueltos + r.enProceso === 79, 'todas categorizadas')
ok(Number.isFinite(r.costoPorEntrega), `costo por entrega sano: ${Math.round(r.costoPorEntrega)} Gs`)

// ── Rendiciones reales (planillas de pago de Lucero) ──
// Traen netos NEGATIVOS legítimos: en un prepago o una devolución cobrás 0
// y el flete se paga igual, así que le debés esa plata a Lucero.
console.log('\n── rendiciones de Lucero (archivos reales) ──')
const RENDS = [
  { archivo: 'rendicion_Facial_Wellness_698_20260819_153109.xlsx', lote: 698, envios: 4, totalPago: 398000 },
  { archivo: 'rendicion_Facial_Wellness_685_20260818_153540.xlsx', lote: 685, envios: 3, totalPago: 134000 },
]
for (const R of RENDS) {
  if (!existsSync(DIR + R.archivo)) { console.log(`⚠ falta ${R.archivo} — se omite`); continue }
  const w = XLSX.readFile(DIR + R.archivo, { cellDates: true })
  const fs2 = XLSX.utils.sheet_to_json(w.Sheets[w.SheetNames[0]], { header: 1, defval: '' })
  const out = parsearRendicionLucero(fs2)
  const its = out.items || out
  ok(its.length === R.envios, `lote ${R.lote}: ${R.envios} envíos`)
  ok(its.every(i => [i.tarifa, i.totalCobrar, i.pagoCliente].every(v => v == null || Math.abs(v) <= INT4)),
     `lote ${R.lote}: ningún monto desborda`)
  // La suma de pagos tiene que dar EXACTO el TotalPago de la cabecera:
  // prueba de que no se perdió ni se alteró un solo guaraní.
  const suma = its.reduce((s, i) => s + i.pagoCliente, 0)
  ok(suma === R.totalPago, `lote ${R.lote}: la suma de pagos da ${suma.toLocaleString('es-PY')} = TotalPago del archivo`)
  const negs = its.filter(i => i.pagoCliente < 0)
  ok(negs.length > 0 && negs.every(n2 => n2.pagoCliente < 0),
     `lote ${R.lote}: ${negs.length} neto(s) negativo(s) conservado(s) — ${negs.map(n2 => `${n2.codigo} ${n2.pagoCliente.toLocaleString('es-PY')}`).join(', ')}`)
}

console.log(fallas ? `\n✗ ${fallas} FALLAS` : '\n✓ los archivos reales se comportan como se espera')
process.exit(fallas ? 1 : 0)
