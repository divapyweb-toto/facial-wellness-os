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

console.log(fallas ? `\n✗ ${fallas} FALLAS` : '\n✓ los archivos reales se comportan como se espera')
process.exit(fallas ? 1 : 0)
