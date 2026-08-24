// tests/ruteo.test.mjs
// ═══════════════════════════════════════════════════════════
// La lista oficial de ciudades manda: cada ciudad tiene que ir a la
// transportadora asignada, sin importar qué diga la comparación de costo.
// Correr:  npm test
// ═══════════════════════════════════════════════════════════
import { sugerirTransportadora, ciudadesRuteo, ruteoOficial, tarifaDe } from '../src/lib/transportadoras.js'

let f = 0
const ok = (c, m) => { if (!c) { console.log(`✗ ${m}`); f++ } }
const R = ciudadesRuteo()

console.log(`── ${R.lucero.length} ciudades asignadas a Lucero ──`)
for (const c of R.lucero) {
  ok(ruteoOficial(c) === 'lucero', `${c}: la lista debería decir lucero`)
  const s = sugerirTransportadora(c, 'Limpiador de Lengua Facial Wellness')
  ok(s.transportadora === 'lucero', `${c}: rutea a ${s.transportadora} en vez de lucero`)
  ok(s.tarifa > 0, `${c}: sin tarifa de Lucero (${s.tarifa})`)
}
console.log(f ? `  ✗ ${f} problemas` : '  ✓ las 63 rutean a Lucero con tarifa')

const antes = f
console.log(`\n── ${R.pap.length} ciudades asignadas a Punto a Punto ──`)
for (const c of R.pap) {
  ok(ruteoOficial(c) === 'pap', `${c}: la lista debería decir pap`)
  const s = sugerirTransportadora(c, 'Limpiador de Lengua Facial Wellness')
  ok(s.transportadora === 'pap', `${c}: rutea a ${s.transportadora} en vez de pap`)
}
console.log(f === antes ? '  ✓ las 29 rutean a PaP' : `  ✗ ${f - antes} problemas`)

const antes2 = f
console.log('\n── variantes de escritura (así llegan del CSV) ──')
const VAR = [['cde','lucero'], ['Cnel Oviedo','lucero'], ['ASUNCION','lucero'], ['Ciudad del este','lucero'],
             ['pjc','pap'], ['Fernando de la Mora - Zona Norte','pap'], ['Villarrica','pap'], ['Salto del Guaira','pap']]
for (const [c, esperado] of VAR) {
  const s = sugerirTransportadora(c, 'Limpiador de Lengua Facial Wellness')
  ok(s.transportadora === esperado, `"${c}" → ${s.transportadora}, se esperaba ${esperado}`)
}
console.log(f === antes2 ? '  ✓ las variantes rutean bien' : `  ✗ ${f - antes2} variantes mal`)

const antes3 = f
console.log('\n── la regla por producto sigue mandando sobre la lista ──')
// JawFlex va SIEMPRE por Lucero: es decisión de negocio y pesa más que la lista.
const jaw = sugerirTransportadora('Villarrica', 'Ejercitadores de Mandíbula - Pack 1x JawFlex Pro')
ok(jaw.transportadora !== 'pap', `JawFlex en Villarrica fue a PaP — la regla de producto debería ganar (dio ${jaw.transportadora})`)
console.log(f === antes3 ? '  ✓ la regla por producto tiene prioridad' : `  ✗ la regla por producto se perdió`)

console.log(f ? `\n✗ ${f} FALLAS` : '\n✓ el ruteo respeta la lista oficial')
process.exit(f ? 1 : 0)
