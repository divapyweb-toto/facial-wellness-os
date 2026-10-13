// Auditoría 12-10: Meta Ads (veredicto con lo en camino, gasto sincronizado,
// borrado por tienda) y salida total de Finanzas. Datos inventados.
import { calcularMetricasAds, textoVeredicto, leerCampanasManual, filtroBorradoCampanas, gastoEfectivoAds, resumenSalidaMes } from '../src/lib/metricasAds.js'
import { armarGastosAutomaticos, gastosSinDobleAds, claveCampanaManual } from '../src/lib/gastosAutomaticos.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

// Pedidos de prueba: cada uno una línea, precio 129.000, costo 30.000, flete 25.000.
const pedido = (n, estado) => ({ n_referencia: `T-${n}`, fecha: '2026-10-08', total: 129000, costo_prod: 30000, costo_envio: 25000, estado })
const lote = (desde, cant, estado) => Array.from({ length: cant }, (_, i) => pedido(desde + i, estado))

console.log('── 9) veredicto con muestra chica (4 cobrados, 23 en camino) ──')
{
  const ventas = [...lote(1, 4, 'entregado'), ...lote(100, 23, 'pendiente')]
  const m = calcularMetricasAds(800000, ventas, {})
  ok(m.gananciaNeta < 0, `hasta hoy da negativo (${m.gananciaNeta}) — antes eso era "Pierde, cortá"`)
  ok(m.veredicto === 'esperar', `ahora el veredicto es "esperar" — dio ${m.veredicto}`)
  ok(m.tasa.muestraChica && m.tasa.enCamino === 23, 'la tasa marca muestra chica y 23 en camino')
  const txt = textoVeredicto(m, 'Raspador')
  ok(/Esperá: 23 en camino/.test(txt) && !/Cortá|escalar/.test(txt.replace('No cortes ni escales', '')), `texto neutro: "${txt}"`)
  ok(Math.round(m.tasa.min) === 15 && m.tasa.max === 100, 'rango 15–100% (no un 100% de 4 resueltos)')
}

console.log('\n── 9) con muestra suficiente: proyecta lo en camino ──')
{
  // 20 entregados + 5 devueltos (25 resueltos, 80%) + 10 en camino.
  const ventas = [...lote(1, 20, 'entregado'), ...lote(50, 5, 'devuelto'), ...lote(100, 10, 'pendiente')]
  const gasto = 1600000
  const m = calcularMetricasAds(gasto, ventas, {})
  const firme = 20 * 129000 - gasto - 20 * 30000 - 25 * 25000
  ok(m.gananciaNeta === firme, `ganancia firme = ${firme} — dio ${m.gananciaNeta}`)
  const contrib = 0.8 * 10 * (129000 - 30000) - 10 * 25000
  ok(m.contribEnCamino === Math.round(contrib), `en camino aporta 80% × (precio − costo) − flete = ${contrib} — dio ${m.contribEnCamino}`)
  ok(m.gananciaProyectada === Math.round(firme + contrib), 'proyectada = firme + en camino')
  ok(m.tasa.fuente === 'historica' && Math.round(m.tasa.tasaUsada * 100) === 80, 'usa la tasa del propio mes (≥20 resueltos)')
  // firme = -245.000 → con 10% de banda (160.000) sería "pierde"; proyectada = +297.000 → "gana".
  ok(firme < -gasto * 0.1 && m.veredicto === 'gana', `sin proyección decía "pierde"; con proyección "gana" — dio ${m.veredicto}`)
  ok(/incluye 10 en camino proyectados al 80%/.test(textoVeredicto(m, 'X')), 'el texto dice que incluye lo en camino')
  const h = calcularMetricasAds(gasto, ventas, {}, 12000, { hist: { entregados: 50, resueltos: 100 } })
  ok(Math.round(h.tasa.tasaUsada * 100) === 50 && h.contribEnCamino === Math.round(0.5 * 10 * 99000 - 250000), 'acepta una tasa histórica de afuera')
}

console.log('\n── 9) sin nada en camino: el resultado ya es plata cerrada ──')
{
  const m = calcularMetricasAds(500000, lote(1, 3, 'entregado'), {})
  ok(m.veredicto === 'pierde', `3 entregados y 0 en camino: veredicto normal ("pierde") — dio ${m.veredicto}`)
  ok(calcularMetricasAds(0, lote(1, 3, 'pendiente'), {}).veredicto === 'sin_gasto', 'sin gasto sigue siendo sin_gasto')
}

console.log('\n── 2) gasto efectivo: carga manual manda, si no Meta sincronizado ──')
{
  const fams = ['lengua', 'nasal']
  const meta = { porFamilia: { lengua: 400000, nasal: 40000 }, total: 560000 }
  let e = gastoEfectivoAds({ gastos: {}, familias: fams, meta, usaMeta: true })
  ok(e.porFamilia.lengua === 400000 && e.total === 560000 && e.metaSinFamilia === 120000, 'Meta por producto + lo sin producto en el total')
  e = gastoEfectivoAds({ gastos: { lengua: '100000' }, familias: fams, meta, usaMeta: false })
  ok(e.total === 100000 && e.porFamilia.lengua === 100000, 'con carga a mano, Meta no se suma')
  e = gastoEfectivoAds({ modo: 'total', gastos: { total: '50000' }, familias: fams, meta, usaMeta: true })
  ok(e.total === 610000, 'en "Todas": manual de una tienda + Meta de la otra')

  // Voltra sin carga manual → Meta se usa; FW con carga manual → su Meta se descarta.
  const productos = [{ id: 'p1', nombre: 'Raspador de Lengua' }]
  const adsDiario = [
    { fecha: '2026-10-08', gasto: 300000, producto_id: 'p1', tienda: 'voltra' },
    { fecha: '2026-10-08', gasto: 90000, producto_id: 'p1', tienda: 'fw' },
  ]
  const camp = [{ mes: '2026-10', tienda: 'fw', nombre: 'lengua', gasto: 70000 }]
  const auto = armarGastosAutomaticos({ adsDiario, productos, tienda: 'todas', mesesConCampanas: new Set(camp.map(c => claveCampanaManual(c.tienda, c.mes))) })
  const man = leerCampanasManual(camp)
  e = gastoEfectivoAds({ gastos: man.gastos, familias: ['lengua'], meta: { porFamilia: auto.metaPorFamilia, total: auto.metaTotal }, usaMeta: true })
  ok(e.porFamilia.lengua === 370000, `"Todas": 300.000 Meta Voltra + 70.000 manual FW (sin los 90.000 de Meta FW) — dio ${e.porFamilia.lengua}`)
}

console.log('\n── 2) lectura de campanas_ads ──')
{
  const r = leerCampanasManual([
    { nombre: 'lengua', gasto: 100000, tienda: 'fw' },
    { nombre: 'lengua', gasto: 50000, tienda: 'voltra' },
    { familia: 'nasal', nombre: null, gasto: 20000 },
  ])
  ok(r.gastos.lengua === '150000', 'en "Todas" suma las dos tiendas (antes una pisaba a la otra)')
  ok(r.gastos.nasal === '20000' && r.modo === 'producto' && r.hayManual, 'datos viejos con `familia`')
  ok(leerCampanasManual([{ nombre: 'total', gasto: 5 }]).modo === 'total', 'modo total')
  ok(!leerCampanasManual([{ nombre: 'lengua', gasto: 0 }]).hayManual, 'gasto 0 no cuenta como carga manual')
}

console.log('\n── 3) borrado al guardar: solo la tienda y las familias de la pantalla ──')
{
  const f = filtroBorradoCampanas({ mes: '2026-10', tienda: 'voltra', familias: ['lengua', 'nasal'] })
  ok(f && f.tienda === 'voltra' && f.mes === '2026-10', 'filtra por tienda y mes')
  ok(f.nombres.includes('total') && f.nombres.includes('lengua') && !f.nombres.includes('sin_atribuir'), "no toca filas que la pantalla no muestra (ej. 'sin_atribuir')")
  ok(filtroBorradoCampanas({ mes: '2026-10', tienda: 'todas', familias: [] }) === null, 'en "Todas" no se guarda')
  ok(filtroBorradoCampanas({ mes: '', tienda: 'fw' }) === null, 'sin mes no se borra nada')
  // Simulación sobre filas en memoria: guardar en Voltra no borra FW.
  const filas = [
    { mes: '2026-10', tienda: 'fw', nombre: 'lengua' }, { mes: '2026-10', tienda: 'voltra', nombre: 'lengua' },
    { mes: '2026-10', tienda: 'voltra', nombre: 'sin_atribuir' }, { mes: '2026-09', tienda: 'voltra', nombre: 'nasal' },
  ]
  const quedan = filas.filter(x => !(x.mes === f.mes && x.tienda === f.tienda && f.nombres.includes(x.nombre)))
  ok(quedan.length === 3 && quedan.some(x => x.tienda === 'fw'), 'FW del mes y otros meses quedan intactos')
}

console.log('\n── 1) salida total de Finanzas ──')
{
  const auto = armarGastosAutomaticos({
    adsDiario: [{ fecha: '2026-10-08', gasto: 831771, producto_id: null, tienda: 'voltra' }],
    gastosFijosTexto: 'Shopify: 180000', tienda: 'voltra',
  })
  let r = resumenSalidaMes({ gastosBruto: 0, gastosSinDoble: gastosSinDobleAds([], auto.metaTotal), adsManual: 0, auto })
  ok(r.metaSync === 831771 && r.totalAds === 831771, 'Meta sincronizado entra en ads (antes 0)')
  ok(r.automaticos === 180000 && r.fijosGs === 180000, 'automáticos (fijos) aparte')
  ok(r.salidaTotal === 1011771, `salida = gastos + ads + automáticos — dio ${r.salidaTotal}`)
  const gastos = [{ monto: 200000, categoria: 'Publicidad' }, { monto: 50000, categoria: 'Operativo' }]
  r = resumenSalidaMes({ gastosBruto: 250000, gastosSinDoble: gastosSinDobleAds(gastos, auto.metaTotal), adsManual: 0, auto })
  ok(r.posibleDoble && r.totalGastos === 50000 && r.salidaTotal === 50000 + 831771 + 180000, 'Publicidad manual no se cuenta dos veces')
  r = resumenSalidaMes({ gastosBruto: 250000, adsManual: 0, auto: null })
  ok(r.salidaTotal === 250000 && r.metaSync === 0, 'sin automáticos (falló la lectura) no inventa nada')
}

if (fallas) { console.log(`\n✗ ${fallas} falla(s)`); process.exit(1) }
console.log('\n✓ auditoría ads/finanzas OK')
