// Tasa de entrega realista (src/lib/tasaEntrega.js) — 12-10.
// Con 4 entregados, 0 devueltos y 23 en camino ya no puede salir "100%".
import { tasaEntregaRealista, REFERENCIA_TASA, MIN_RESUELTOS, textoEsperada, textoRango, colorTasa, textoFuente } from '../src/lib/tasaEntrega.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }
const cerca = (a, b) => a != null && Math.abs(a - b) < 1e-9

// ── Caso de la auditoría: 27 enviados, 4 entregados, 23 en camino ──
const t = tasaEntregaRealista({ entregados: 4, devueltos: 0, enCamino: 23 })
ok(t.enviados === 27 && t.resueltos === 4, 'enviados 27, resueltos 4')
ok(cerca(t.sobreResueltos, 100), 'sobre resueltos sigue siendo 100 (dato crudo)')
ok(cerca(t.min, 4 / 27 * 100), 'min = 4/27')
ok(cerca(t.max, 100), 'max = (4+23)/27 = 100')
ok(cerca(t.esperada, (4 + 23 * REFERENCIA_TASA) / 27 * 100), 'esperada usa la referencia 80%')
ok(t.fuente === 'referencia' && t.tasaUsada === REFERENCIA_TASA, 'sin historia → referencia')
ok(t.muestraChica === true, '4 resueltos → muestra chica')
ok(colorTasa(t) === 'var(--text-secondary)', 'muestra chica → color neutro (nunca verde)')
ok(textoEsperada(t) === '~83%', `texto esperada ~83% (${textoEsperada(t)})`)
ok(textoRango(t).includes('rango 15–100%') && textoRango(t).includes('23 en camino'), `texto rango (${textoRango(t)})`)
ok(textoFuente(t).includes('referencia'), 'texto fuente dice referencia')

// ── Con historia suficiente se usa la histórica ──
const h = tasaEntregaRealista({ entregados: 4, devueltos: 0, enCamino: 23, hist: { entregados: 70, resueltos: 100 } })
ok(h.fuente === 'historica' && cerca(h.tasaUsada, 0.7), 'historia con 100 resueltos → 70%')
ok(cerca(h.esperada, (4 + 23 * 0.7) / 27 * 100), 'esperada con la histórica')
ok(textoFuente(h).includes('70% histórico'), 'texto fuente dice histórico')

// ── Historia con pocos resueltos NO se usa ──
const hc = tasaEntregaRealista({ entregados: 4, enCamino: 23, hist: { entregados: 5, resueltos: MIN_RESUELTOS - 1 } })
ok(hc.fuente === 'referencia', `historia con ${MIN_RESUELTOS - 1} resueltos → referencia`)

// ── Sin envíos: todo null ──
const v = tasaEntregaRealista({ entregados: 0, devueltos: 0, enCamino: 0 })
ok(v.enviados === 0 && v.min == null && v.max == null && v.esperada == null && v.sobreResueltos == null, 'sin envíos → null')
ok(textoEsperada(v) === '—', 'sin envíos → "—"')

// ── Muestra grande y todo resuelto: rango cerrado y color por esperada ──
const g = tasaEntregaRealista({ entregados: 80, devueltos: 20, enCamino: 0 })
ok(cerca(g.min, 80) && cerca(g.max, 80) && cerca(g.esperada, 80), 'todo resuelto → min = max = esperada = 80')
ok(g.muestraChica === false && colorTasa(g) === 'var(--green)', 'muestra grande 80% → verde')
ok(textoRango(g) === '100 resueltos', `sin en camino no muestra rango (${textoRango(g)})`)
const mala = tasaEntregaRealista({ entregados: 40, devueltos: 60, enCamino: 0 })
ok(colorTasa(mala) === 'var(--red)', '40% con muestra grande → rojo')

// ── Entradas sucias no rompen ──
const s = tasaEntregaRealista({ entregados: '3', devueltos: null, enCamino: -2 })
ok(s.enviados === 3 && cerca(s.esperada, 100), 'strings/null/negativos se sanean')
ok(tasaEntregaRealista().enviados === 0, 'sin argumentos no rompe')

if (fallas) { console.error(`\n${fallas} prueba(s) fallaron`); process.exit(1) }
console.log('\nTasa de entrega realista: todo OK')
