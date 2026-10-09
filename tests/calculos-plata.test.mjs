// Cálculos de plata de Dashboard y Reportes, con datos inventados.
// Correr: node --import ./tests/registrar.mjs tests/calculos-plata.test.mjs
import { fleteDe, sumarFlete } from '../src/lib/flete.js'
import { calcularPiramide, indexarCostos, contarPedidos, categoriaVenta } from '../src/lib/contribucion.js'
import { armarGastosAutomaticos, claveCampanaManual, gastosSinDobleAds } from '../src/lib/gastosAutomaticos.js'
import { calcularMetricasAds } from '../src/lib/metricasAds.js'
import { familiaProducto } from '../src/lib/recompra.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

console.log('── 1) flete: 0 es dato, no "sin dato" ──')
ok(fleteDe({ costo_envio: 0 }) === 0, 'una línea con flete 0 cuesta 0')
ok(fleteDe({ costo_envio: 29000 }) === 29000, 'una línea con flete 29.000 cuesta 29.000')
ok(fleteDe({ costo_envio: null }) > 0 && fleteDe({}) > 0, 'sin dato (null/undefined) usa la tarifa de respaldo')
{
  const pedido2Lineas = [
    { n_referencia: '#1500', fecha: '2026-10-05', importe: 150000, costo_envio: 29000, costo_prod: 30000, categoria: 'entregado' },
    { n_referencia: '#1500', fecha: '2026-10-05', importe: 90000, costo_envio: 0, costo_prod: 20000, categoria: 'entregado' },
  ]
  ok(sumarFlete(pedido2Lineas) === 29000, `pedido de 2 líneas (29.000 + 0) suma 29.000 — dio ${sumarFlete(pedido2Lineas)}`)
  const p = calcularPiramide(pedido2Lineas, {}, 12000, 0)
  ok(p.fleteResueltos === 29000, `la pirámide del Dashboard también da 29.000 (como Reportes) — dio ${p.fleteResueltos}`)
}

console.log('\n── 2) COGS de un pedido multiproducto ──')
{
  const lineas = [
    { n_referencia: '2001', fecha: '2026-10-05', total: 150000, costo_prod: 30000, estado: 'entregado' },
    { n_referencia: '2001', fecha: '2026-10-05', total: 90000, costo_prod: 10000, estado: 'entregado' },
  ]
  const paquetes = lineas.map(v => ({ n_referencia: v.n_referencia, fecha: v.fecha, importe: v.total, costo_envio: 0, costo_prod: v.costo_prod, categoria: 'entregado' }))
  const p = calcularPiramide(paquetes, indexarCostos(lineas), 12000, 0)
  ok(p.cogs === 40000, `con costo_prod por línea: 30.000 + 10.000 = 40.000 — dio ${p.cogs}`)
  // Entregas pasa las líneas SIN costo_prod: el índice (promedio por línea) tiene que dar el total del pedido.
  const sinCosto = paquetes.map(({ costo_prod, ...r }) => r)
  const p2 = calcularPiramide(sinCosto, indexarCostos(lineas), 12000, 0)
  ok(p2.cogs === 40000, `solo con el índice por referencia también da 40.000 (antes 20.000: la última línea pisaba) — dio ${p2.cogs}`)
  const p3 = calcularPiramide([{ n_referencia: '9999', importe: 1, costo_envio: 0, categoria: 'entregado' }], {}, 12000, 0)
  ok(p3.cogs === 12000 && p3.cogsEstimado === 1, 'sin costo ni índice usa el promedio y lo marca como estimado')
}

console.log('\n── 4) Meta sincronizado vs campañas manuales, por tienda ──')
{
  const ads = [
    { fecha: '2026-10-03', gasto: 200000, producto_id: null, tienda: 'voltra' },
    { fecha: '2026-10-03', gasto: 80000, producto_id: null, tienda: 'fw' },
  ]
  // Campaña manual de FW en octubre: solo descarta el Meta de FW, no el de Voltra.
  const meses = new Set([claveCampanaManual('fw', '2026-10')])
  let r = armarGastosAutomaticos({ adsDiario: ads, mesesConCampanas: meses, tienda: 'todas' })
  ok(r.metaTotal === 200000 && r.metaDescartado === 80000, `"Todas": queda el Meta de Voltra (200.000), se descarta solo el de FW — dio ${r.metaTotal}/${r.metaDescartado}`)
  r = armarGastosAutomaticos({ adsDiario: ads, mesesConCampanas: meses, tienda: 'voltra' })
  ok(r.metaTotal === 200000, 'vista Voltra: la campaña manual de FW no le borra nada')
  ok(claveCampanaManual(null, '2026-10-01') === 'fw|2026-10', 'una campaña sin tienda cuenta como Facial Wellness')
  r = armarGastosAutomaticos({ adsDiario: ads, mesesConCampanas: new Set(['2026-10']), tienda: 'todas' })
  ok(r.metaTotal === 0, 'una clave vieja sin tienda sigue valiendo para todas (compatibilidad)')
}

console.log('\n── 5) fila TOTAL de ads contra todas las ventas ──')
{
  const ventas = [
    { n_referencia: 'VT-1001', fecha: '2026-10-02', producto_nombre: 'Organizador Voltra X', total: 200000, costo_prod: 60000, costo_envio: 25000, estado: 'entregado' },
    { n_referencia: 'VT-1002', fecha: '2026-10-02', producto_nombre: 'Organizador Voltra X', total: 200000, costo_prod: 60000, costo_envio: 25000, estado: 'entregado' },
  ]
  ok(familiaProducto(ventas[0].producto_nombre) == null, 'un producto de Voltra no tiene familia de FW')
  const viejo = calcularMetricasAds(100000, ventas.filter(v => familiaProducto(v.producto_nombre)), {})
  const nuevo = calcularMetricasAds(100000, ventas, {})
  ok(viejo.roasReal === 0 && viejo.veredicto === 'pierde', 'antes: filtrando por familia daba ROAS 0 y "pierde"')
  ok(nuevo.roasReal === 4 && nuevo.veredicto === 'gana', `ahora: 400.000 cobrados / 100.000 de gasto = ROAS 4, "gana" — dio ${nuevo.roasReal} ${nuevo.veredicto}`)
}

console.log('\n── 10) conteos por pedido, plata por línea ──')
{
  const ventas = [
    { n_referencia: '#3001', fecha: '2026-10-01', total: 100000, estado: 'entregado' },
    { n_referencia: '3001', fecha: '2026-10-01', total: 50000, estado: 'entregado' },   // misma caja
    { n_referencia: '3002', fecha: '2026-10-01', total: 100000, estado: 'devuelto' },
    { n_referencia: '3003', fecha: '2026-10-02', total: 100000, estado: 'pendiente' },
    { n_referencia: '3003', fecha: '2026-10-02', total: 40000, estado: 'pendiente' },
    { n_referencia: '3004', fecha: '2026-10-02', total: 80000, estado: 'entregado' },
    { n_referencia: '3004', fecha: '2026-10-02', total: 20000, estado: 'devuelto' },     // mixto: cuenta como entregado
    { n_referencia: '', fecha: '2026-10-02', total: 10000, estado: 'entregado' },          // sin ref: pedido propio
  ]
  const c = contarPedidos(ventas, categoriaVenta)
  ok(c.total === 5, `5 pedidos (no 8 líneas) — dio ${c.total}`)
  ok(c.entregados === 3 && c.devueltos === 1, `3 entregados y 1 devuelto — dio ${c.entregados}/${c.devueltos}`)
  ok((c.porCat.pendiente || 0) === 1, 'el pedido pendiente de 2 líneas cuenta 1')
  const paquetes = ventas.map(v => ({ n_referencia: v.n_referencia, fecha: v.fecha, importe: v.total, costo_envio: 0, costo_prod: 0, categoria: categoriaVenta(v) === 'pendiente' ? 'en_proceso' : categoriaVenta(v) }))
  const p = calcularPiramide(paquetes, {}, 0, 0)
  ok(p.entregados === 3 && p.devueltos === 1 && p.resueltos === 4 && p.tasaEntrega === 75, `pirámide: 3 de 4 resueltos = 75% — dio ${p.entregados}/${p.resueltos} ${p.tasaEntrega}%`)
  ok(p.ingreso === 100000 + 50000 + 80000 + 10000, `la plata sigue por línea: cobrado 240.000 — dio ${p.ingreso}`)
  ok(p.total === 5 && p.enProceso === 1, 'total y en tránsito por pedido')
  const otroDia = contarPedidos([{ n_referencia: '3001', fecha: '2026-10-01', estado: 'entregado' }, { n_referencia: '3001', fecha: '2026-11-01', estado: 'entregado' }], categoriaVenta)
  ok(otroDia.total === 2, 'misma referencia en otra fecha = otro pedido (igual que metricasAds)')
}

console.log('\n── 12) sin doble resta de publicidad ──')
{
  const gastos = [
    { monto: 500000, categoria: 'Sueldos' },
    { monto: 300000, categoria: 'Publicidad' },
  ]
  let r = gastosSinDobleAds(gastos, 300000)
  ok(r.posibleDoble && r.totalGastos === 500000 && r.gastoPublicidad === 300000, `con ads cargado: se resta solo el ads, Publicidad queda afuera (gastos 500.000) — dio ${r.totalGastos}`)
  r = gastosSinDobleAds(gastos, 0)
  ok(!r.posibleDoble && r.totalGastos === 800000, 'sin ads: el gasto de Publicidad SÍ cuenta (es la única fuente)')
  r = gastosSinDobleAds([{ monto: 100000, categoria: 'Envases' }], 300000)
  ok(!r.posibleDoble && r.totalGastos === 100000, 'sin gasto de Publicidad no hay aviso ni descuento')
  // Utilidad = cobrado − flete − gastos − COGS − ads: con el arreglo, 300.000 menos de resta.
  const util = (tg) => 2000000 - 200000 - tg - 600000 - 300000
  ok(util(gastosSinDobleAds(gastos, 300000).totalGastos) === 400000, 'la utilidad ya no resta la publicidad dos veces (400.000, antes 100.000)')
}

console.log('\n── 6) lecturas paginadas (sin el corte de 1.000 filas) ──')
{
  const { cargarGastosAutomaticos } = await import('../src/lib/gastosAutomaticos.js')
  const { cargarCostoPorAnuncio } = await import('../src/lib/costoPorAnuncio.js')
  // Cliente falso que, como Supabase, nunca devuelve más de 1.000 filas por pedido.
  const filas = { wa_mensajes: Array.from({ length: 2500 }, () => ({ costo_usd: 0.01, creado_en: '2026-10-05T15:00:00Z' })),
    pedidos_origen_anuncio: Array.from({ length: 1500 }, (_, i) => ({ shopify_order_id: i, utm_content: 'Anuncio A', entregado: i % 2 === 0 })) }
  const cliente = { from: (t) => {
    let desde = 0, hasta = 999
    const q = { select: () => q, gte: () => q, lte: () => q, not: () => q, eq: () => q, order: () => q,
      range: (a, b) => { desde = a; hasta = Math.min(b, a + 999); return q },
      then: (res) => res({ data: (filas[t] || []).slice(desde, hasta + 1), error: null }) }
    return q
  } }
  const r = await cargarGastosAutomaticos(cliente, { inicio: '2026-10-01', fin: '2026-10-31' })
  ok(r.waMensajes.length === 2500, `WhatsApp: trae las 2.500 filas — dio ${r.waMensajes.length}`)
  const c = await cargarCostoPorAnuncio(cliente, { inicio: '2026-10-01', fin: '2026-10-31' })
  ok(c.total.pedidos === 1500 && c.total.entregados === 750, `costo por anuncio: 1.500 pedidos — dio ${c.total.pedidos}`)
}

console.log(fallas ? `\n✗ ${fallas} falla(s)` : '\n✓ los cálculos de plata cierran')
process.exit(fallas ? 1 : 0)
