// Auditoría del Dashboard / Entregas (12-10). Datos inventados.
// Caso real (sin datos personales): Voltra octubre con 4 entregados, 0 devueltos,
// 23 pendientes de los cuales solo 21 tienen guía. Antes: "Tasa entrega 100%"
// verde, "23 ya despachados", proyección al 100% y "PaP te debe" aunque la deuda
// era de Lucero con rendido NULL.
import { calcularPiramide, indexarDespachos, historiaEntrega } from '../src/lib/contribucion.js'
import { alertaSinRendir } from '../src/lib/alertasNegocio.js'
import { tasaPorTransportadora } from '../src/lib/riesgoCiudad.js'
import { REFERENCIA_TASA } from '../src/lib/tasaEntrega.js'
import { cargarDashboard } from '../src/pages/dashboard/cargaDashboard.js'
import { hoyLocal } from '../src/lib/fechas.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }
const cerca = (a, b) => a != null && Math.abs(a - b) < 1e-6

// ── 1) Pirámide: en camino solo con guía, proyección con historia o referencia ──
console.log('── pirámide ──')
const paq = (i, categoria, despachado) => ({ n_referencia: `VT-${1000 + i}`, fecha: '2026-10-05', importe: 199000, costo_envio: 25000, costo_prod: 30000, categoria, despachado })
const paquetes = [
  ...[1, 2, 3, 4].map(i => paq(i, 'entregado', true)),
  ...Array.from({ length: 21 }, (_, k) => paq(10 + k, 'en_proceso', true)),
  paq(50, 'en_proceso', false), paq(51, 'en_proceso', false),
]
const p = calcularPiramide(paquetes, {}, 12000, 0)
ok(p.enProceso === 23 && p.enCamino === 21 && p.sinDespachar === 2, `23 sin resolver = 21 en camino + 2 sin guía (${p.enCamino}/${p.sinDespachar})`)
ok(p.tasaEntrega === 100, 'tasa cruda sobre resueltos sigue siendo 100 (compatibilidad)')
ok(p.tasaReal.muestraChica && p.fuenteTasa === 'referencia' && p.tasaProyeccion === 80, 'con 4 resueltos y sin historia → referencia 80%')
ok(cerca(p.tasaReal.esperada, (4 + 21 * REFERENCIA_TASA) / 25 * 100), `esperada ~${Math.round(p.tasaReal.esperada)}% sobre 25 despachados`)
ok(p.entregadosProyectados === Math.round(21 * 0.8) && p.devueltosProyectados === 21 - Math.round(21 * 0.8), 'proyección sobre los 21 con guía, no sobre 23')
ok(p.fleteEnTransito === 21 * 25000, `flete comprometido solo de los 21 despachados (${p.fleteEnTransito})`)
ok(p.ingresoProyectado === Math.round(21 * 199000 * 0.8), 'ingreso proyectado al 80%')

const ph = calcularPiramide(paquetes, {}, 12000, 0, { hist: { entregados: 60, resueltos: 100 } })
ok(ph.fuenteTasa === 'historica' && ph.tasaProyeccion === 60, 'con historia de 100 resueltos → 60% histórico')
const phChica = calcularPiramide(paquetes, {}, 12000, 0, { hist: { entregados: 5, resueltos: 5 } })
ok(phChica.fuenteTasa === 'referencia', 'historia de 5 resueltos no alcanza → referencia')

// Sin el campo `despachado` (llamadas viejas): todo lo sin resolver cuenta en camino.
const pv = calcularPiramide(paquetes.map(({ despachado, ...x }) => x), {}, 12000, 0)
ok(pv.enCamino === 23 && pv.sinDespachar === 0, 'sin campo despachado → compatibilidad (23 en camino)')

// Muestra grande propia: usa su propia tasa, no la referencia.
const grande = [
  ...Array.from({ length: 30 }, (_, k) => paq(100 + k, 'entregado', true)),
  ...Array.from({ length: 10 }, (_, k) => paq(200 + k, 'devuelto', true)),
  ...Array.from({ length: 10 }, (_, k) => paq(300 + k, 'en_proceso', true)),
]
const pg = calcularPiramide(grande, {}, 12000, 0)
ok(pg.fuenteTasa === 'historica' && pg.tasaProyeccion === 75 && !pg.tasaReal.muestraChica, 'con 40 resueltos propios proyecta a su 75%')

// ── 2) Despachos: guía por venta_id, por referencia o despachado_at ──
console.log('── despachos ──')
const esDesp = indexarDespachos([
  { venta_id: 'a1', n_referencia: null, nro_guia_pap: 'G-1' },
  { venta_id: null, n_referencia: 'VT-2002', nro_guia_pap: 'G-2' },
  { venta_id: 'a9', n_referencia: 'VT-2009', nro_guia_pap: null, guia_transportadora: null }, // sin guía
])
ok(esDesp({ id: 'a1', n_referencia: 'VT-2001' }), 'por venta_id')
ok(esDesp({ id: 'zz', n_referencia: 'vt-2002' }), 'por referencia normalizada')
ok(esDesp({ id: 'b3', n_referencia: 'VT-2003', despachado_at: '2026-10-10T12:00:00Z' }), 'por despachado_at')
ok(!esDesp({ id: 'a9', n_referencia: 'VT-2009' }), 'fila de entregas sin guía no cuenta')
ok(!esDesp({ id: 'b4', n_referencia: 'VT-2004' }), 'sin nada → sin despachar')

const h = historiaEntrega([
  { n_referencia: 'VT-1', fecha: '2026-09-01', estado: 'entregado' },
  { n_referencia: 'VT-1', fecha: '2026-09-01', estado: 'entregado' }, // 2 líneas = 1 pedido
  { n_referencia: 'VT-2', fecha: '2026-09-02', estado: 'devuelto' },
  { n_referencia: 'VT-3', fecha: '2026-09-03', estado: 'pendiente' },
])
ok(h.entregados === 1 && h.resueltos === 2, 'historia por pedido (1 de 2)')

// ── 3) Alerta de plata sin rendir según transportadora ──
console.log('── alerta sin rendir ──')
ok(alertaSinRendir(224000, 2, { lucero: 224000 }).msg.startsWith('Lucero te debe'), 'solo Lucero → "Lucero te debe"')
ok(alertaSinRendir(500000, 3, { pap: 500000 }).msg.startsWith('PaP te debe'), 'solo PaP → "PaP te debe"')
const ambas = alertaSinRendir(724000, 5, { pap: 500000, lucero: 224000 }).msg
ok(ambas.startsWith('Las transportadoras te deben') && ambas.includes('PaP') && ambas.includes('Lucero'), 'las dos → detalle por courier')
ok(alertaSinRendir(100, 1).msg.startsWith('Las transportadoras'), 'sin detalle → texto neutro (no "PaP")')

// ── 4) Tasa por transportadora cuenta lo en camino ──
const tp = tasaPorTransportadora([
  { categoria: 'entregado', transportadora: 'lucero' },
  { categoria: 'en_proceso', transportadora: 'lucero' },
  { categoria: 'en_proceso', transportadora: 'lucero' },
])
ok(tp.lucero.resueltos === 1 && tp.lucero.enCamino === 2 && tp.lucero.tasa === 1, 'por transportadora: 1 resuelto + 2 en camino')

// ── 5) Carga del Dashboard de punta a punta (base de mentira, sin red) ──
console.log('── carga del dashboard ──')
function crearBase(tablas) {
  class Q {
    constructor(t) { this.t = t; this.f = []; this.cuenta = false; this.head = false; this.rango = null; this.lim = null; this.single = false }
    select(_c, o) { if (o?.count) { this.cuenta = true; this.head = !!o.head } return this }
    is(c, v) { this.f.push(r => (r[c] ?? null) === v); return this }
    eq(c, v) { this.f.push(r => r[c] === v); return this }
    gte(c, v) { this.f.push(r => r[c] >= v); return this }
    lte(c, v) { this.f.push(r => r[c] <= v); return this }
    gt(c, v) { this.f.push(r => r[c] > v); return this }
    lt(c, v) { this.f.push(r => r[c] < v); return this }
    in(c, a) { this.f.push(r => a.includes(r[c])); return this }
    // not(c, 'is', v): IS NOT v (null cuenta como distinto de true/false, como en Postgres)
    not(c, _op, v) { this.f.push(r => (r[c] ?? null) !== v); return this }
    order() { return this }
    range(a, b) { this.rango = [a, b]; return this }
    limit(n) { this.lim = n; return this }
    maybeSingle() { this.single = true; return this }
    then(res, rej) { return Promise.resolve().then(() => this.correr()).then(res, rej) }
    correr() {
      let filas = (tablas[this.t] || []).filter(r => this.f.every(fn => fn(r)))
      if (this.cuenta) return { data: this.head ? null : filas, count: filas.length, error: null }
      if (this.rango) filas = filas.slice(this.rango[0], this.rango[1] + 1)
      if (this.lim != null) filas = filas.slice(0, this.lim)
      if (this.single) return { data: filas[0] ?? null, error: null }
      return { data: filas, error: null }
    }
  }
  return { from: (t) => new Q(t) }
}
const hoy = hoyLocal()
const v = (i, estado) => ({ id: `v${i}`, n_referencia: `VT-${3000 + i}`, fecha: hoy, estado, total: 199000, deleted_at: null, costo_envio: 25000, costo_prod: 30000, ganancia_neta: 144000, producto_nombre: 'Producto X', cantidad: 1, pago_anticipado: false, created_at: `${hoy}T10:00:00Z` })
const ventas = [
  ...[1, 2, 3, 4].map(i => v(i, 'entregado')),
  ...Array.from({ length: 23 }, (_, k) => v(10 + k, 'pendiente')),
]
// 21 de los 23 pendientes tienen guía; los 4 entregados también.
const entregas = [
  ...[1, 2, 3, 4, ...Array.from({ length: 21 }, (_, k) => 10 + k)].map(i => ({
    venta_id: `v${i}`, n_referencia: `VT-${3000 + i}`, nro_guia_pap: `LU-${i}`, guia_transportadora: `LU-${i}`,
    fecha_ingreso: hoy, transportadora: 'lucero', categoria: i < 10 ? 'entregado' : 'en_proceso',
    cobrado: i <= 2 ? 112000 : 0, importe: i < 10 ? 199000 : 0, rendido: null, fecha_entrega: i < 10 ? hoy : null,
  })),
]
const base = crearBase({ ventas, entregas, gastos: [], campanas_ads: [], tipo_cambio: [], productos: [], recompra_log: [], saldo_banco: [] })
const estado = {}
const { fallas: f } = await cargarDashboard({ supabase: base, supabaseCrudo: base, tienda: 'voltra', avisar: () => {}, emitir: (b, d) => { estado[b] = d } })
const k = estado.principal?.kpis
ok(f.length === 0, `sin fallas (${f.join(', ')})`)
ok(k && k.paquetesEnviados === 25 && k.enCamino === 21 && k.sinDespachar === 2, `enviados 25 = 4 + 21 con guía; 2 sin guía (${k?.paquetesEnviados}/${k?.enCamino}/${k?.sinDespachar})`)
ok(k && k.tasaReal.muestraChica && k.tasaReal.esperada < 100 && Math.round(k.tasaReal.min) === 16, `tasa ~${Math.round(k?.tasaReal?.esperada)}%, rango ${Math.round(k?.tasaReal?.min)}–${Math.round(k?.tasaReal?.max)}% (no 100% verde)`)
ok(k && k.contribucionProyectada > 0 && k.tasaProyeccion === 80, 'punto de equilibrio trae la contribución proyectada de lo en camino')
const t7 = estado.chart7?.tasa7dReal
ok(t7 && t7.enCamino === 21 && t7.muestraChica, 'hero 7 días: 21 en camino y muestra chica')
const alerta = (estado.alertas || []).find(a => a.tipo === 'rendicion')
ok(alerta && alerta.msg.startsWith('Lucero te debe') && alerta.msg.includes('224.000'), `rendido NULL entra y la alerta dice Lucero (${alerta?.msg})`)

if (fallas) { console.error(`\n${fallas} prueba(s) fallaron`); process.exit(1) }
console.log('\nAuditoría del Dashboard: todo OK')
