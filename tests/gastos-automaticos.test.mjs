import { armarGastosAutomaticos, parsearGastosFijos } from '../src/lib/gastosAutomaticos.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }
const productos = [{ id: 'p-lengua', nombre: 'Raspador de Lengua' }, { id: 'p-jaw', nombre: 'Ejercitador de mandibula JawFlex Pro' }]
const ads = [
  { fecha: '2026-10-07', gasto: 100000, producto_id: 'p-lengua', tienda: 'voltra' },
  { fecha: '2026-10-08', gasto: 50000, producto_id: null, tienda: 'voltra' },        // catálogo mixto
  { fecha: '2026-10-08', gasto: 999999, producto_id: 'p-jaw', tienda: 'fw' },         // otra tienda
  { fecha: '2026-09-30', gasto: 70000, producto_id: 'p-jaw', tienda: 'voltra' },      // mes con Campañas a mano
]

console.log('── Meta diario ──')
let r = armarGastosAutomaticos({ adsDiario: ads, productos, mesesConCampanas: new Set(['2026-09']), tienda: 'voltra' })
ok(r.metaTotal === 150000, `Voltra suma 150.000 (sin FW, sin el mes que ya tiene Campañas) — dio ${r.metaTotal}`)
ok(r.metaPorFamilia.lengua === 100000 && !r.metaPorFamilia.jaw, 'se reparte por producto; el catálogo mixto cuenta en el total pero no en un producto')
ok(r.metaDescartado === 70000, 'lo descartado por doble conteo queda a la vista')
r = armarGastosAutomaticos({ adsDiario: ads, productos, tienda: 'fw' })
ok(r.metaTotal === 999999, 'la vista Facial Wellness solo ve lo suyo')
r = armarGastosAutomaticos({ adsDiario: [{ fecha: '2026-10-07', gasto: 5000, producto_id: null }], tienda: 'fw' })
ok(r.metaTotal === 5000, 'una fila sin columna tienda (migración sin correr) cuenta como Facial Wellness')

console.log('\n── WhatsApp y Claude (en dólares) ──')
const wa = [{ costo_usd: 0.0226 }, { costo_usd: 0.0113 }]
const turnos = [{ costo_usd: 0.5, simulado: false }, { costo_usd: 9, simulado: true }]
r = armarGastosAutomaticos({ waMensajes: wa, turnosIA: turnos, ciclosMejora: [{ costo_usd: 0.25 }], tienda: 'voltra', usdPyg: 0 })
ok(Math.abs(r.waUsd - 0.0339) < 1e-9 && Math.abs(r.claudeUsd - 0.75) < 1e-9, 'suma mensajes y turnos reales; los simulados no cuentan')
ok(r.faltaTipoCambio && r.totalGs === 0 && Math.abs(r.usdSinConvertir - 0.7839) < 1e-9, 'sin tipo de cambio NO se inventa: se avisa y no se suma')
r = armarGastosAutomaticos({ waMensajes: wa, turnosIA: turnos, ciclosMejora: [{ costo_usd: 0.25 }], tienda: 'voltra', usdPyg: 7000 })
ok(r.whatsappGs === 237 && r.claudeGs === 5250 && !r.faltaTipoCambio, 'con tipo de cambio se convierte a guaraníes')
r = armarGastosAutomaticos({ waMensajes: wa, turnosIA: turnos, tienda: 'fw', usdPyg: 7000 })
ok(r.waUsd === 0 && r.claudeUsd === 0 && r.totalGs === 0, 'Facial Wellness no usa WhatsApp API ni Claude')

console.log('\n── gastos fijos ──')
const fijos = parsearGastosFijos('Shopify: 180.000\nSupabase: 25 usd\nlinea rota\nDominio: 0')
ok(fijos.length === 2 && fijos[0].monto === 180000 && !fijos[0].usd && fijos[1].usd && fijos[1].monto === 25, 'lee guaraníes y dólares; ignora líneas rotas o en cero')
r = armarGastosAutomaticos({ gastosFijosTexto: 'Shopify: 180000\nSupabase: 25 usd', tienda: 'voltra', usdPyg: 7000, fraccionMes: 0.5 })
ok(r.fijosGs === 90000 + 87500, `se prorratean al período (medio mes) — dio ${r.fijosGs}`)
r = armarGastosAutomaticos({ gastosFijosTexto: 'Supabase: 25 usd', tienda: 'voltra', usdPyg: 0 })
ok(r.faltaTipoCambio && r.fijosGs === 0, 'un fijo en dólares sin tipo de cambio también espera')

console.log(fallas ? `\n✗ ${fallas} falla(s)` : '\n✓ los gastos automáticos suman sin duplicar ni inventar')
process.exit(fallas ? 1 : 0)
