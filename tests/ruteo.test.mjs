// tests/ruteo.test.mjs
// ═══════════════════════════════════════════════════════════
// La lista oficial de ciudades manda: cada ciudad tiene que ir a la
// transportadora asignada, sin importar qué diga la comparación de costo.
// Correr:  npm test
// ═══════════════════════════════════════════════════════════
import { sugerirTransportadora, ciudadesRuteo, ruteoOficial, tarifaDe, DIAS_PREFERIR_LUCERO, cubre } from '../src/lib/transportadoras.js'
// Estas pruebas son de la regla NORMAL: se apaga la preferencia temporal por Lucero (lluvia) si cae hoy.
DIAS_PREFERIR_LUCERO.length = 0

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
console.log(f ? `  ✗ ${f} problemas` : `  ✓ las ${R.lucero.length} rutean a Lucero con tarifa`)

// 16-11: la lista PaP manda SOLO donde Lucero no cobra. Decisión de Enrique del 26-10: "donde llegan los dos couriers con
// cobranza va Lucero; PaP solo donde Lucero no llega" (el motor lo hace desde el 03-11). Antes este test exigía PaP en
// Capiatá, Ñemby, Villarrica, Salto, etc., y por esa regla salió VT-1174 por PaP con el motor diciendo Lucero.
// ruteoOficial sigue diciendo pap (la usa el plazo que promete el bot): solo cambia la asignación de sugerirTransportadora.
const antes = f
console.log(`\n── ${R.pap.length} ciudades de la lista de Punto a Punto ──`)
let aLucero = 0
for (const c of R.pap) {
  ok(ruteoOficial(c) === 'pap', `${c}: la lista debería decir pap`)
  const s = sugerirTransportadora(c, 'Limpiador de Lengua Facial Wellness')
  const esperado = cubre('lucero', c) ? 'lucero' : 'pap'
  if (esperado === 'lucero') aLucero++
  ok(s.transportadora === esperado, `${c}: rutea a ${s.transportadora} en vez de ${esperado}`)
}
console.log(f === antes ? `  ✓ ${R.pap.length - aLucero} van por PaP (Lucero no cobra) y ${aLucero} por Lucero (los dos cobran)` : `  ✗ ${f - antes} problemas`)

const antes2 = f
console.log('\n── variantes de escritura (así llegan del CSV) ──')
const VAR = [['cde','lucero'], ['Cnel Oviedo','lucero'], ['ASUNCION','lucero'], ['Ciudad del este','lucero'],
             // 16-11: pjc, Capiatá, Ñemby y Villarrica pasan a Lucero (los dos cobran); Salto sigue PaP sin la tabla
             // (la lista de Lucero del código no la tiene; con la tabla cargada, el motor y el respaldo dan Lucero).
             ['pjc','lucero'], ['Fernando de la Mora - Zona Norte','lucero'], ['Capiata','lucero'], ['Ñemby','lucero'], ['Villarrica','lucero'], ['Salto del Guaira','pap'],
             ['Concepción','pap'], ['Ayolas','pap']]
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

console.log(f ? `\n✗ ${f} FALLAS` : '\n✓ el ruteo respeta la lista oficial y la regla del 26-10')
process.exit(f ? 1 : 0)
