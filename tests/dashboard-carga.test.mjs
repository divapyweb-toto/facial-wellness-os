// Carga del Dashboard en paralelo (src/pages/dashboard/cargaDashboard.js).
// Corre el código REAL contra una base de mentira donde cada consulta tarda
// RETARDO ms, y mide cuántas "rondas" (esperas de red una detrás de otra)
// hacen falta hasta cada bloque. Antes eran ~20 en serie.
import { cargarDashboard } from '../src/pages/dashboard/cargaDashboard.js'
import { hoyLocal } from '../src/lib/fechas.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

const RETARDO = 60

// ── Base de mentira: arma la consulta y la "ejecuta" sobre arrays en memoria ──
function crearBase(tablas, { errores = {} } = {}) {
  class Q {
    constructor(t) { this.t = t; this.f = []; this.cuenta = false; this.head = false; this.ord = []; this.rango = null; this.lim = null; this.single = false }
    select(_c, o) { if (o?.count) { this.cuenta = true; this.head = !!o.head } return this }
    is(c, v) { this.f.push(r => (r[c] ?? null) === v); return this }
    eq(c, v) { this.f.push(r => r[c] === v); return this }
    gte(c, v) { this.f.push(r => r[c] >= v); return this }
    lte(c, v) { this.f.push(r => r[c] <= v); return this }
    gt(c, v) { this.f.push(r => r[c] > v); return this }
    lt(c, v) { this.f.push(r => r[c] < v); return this }
    in(c, a) { this.f.push(r => a.includes(r[c])); return this }
    not(c, _op, v) { this.f.push(r => (r[c] ?? null) !== v); return this }
    order(c, o) { this.ord.push([c, o?.ascending !== false]); return this }
    range(a, b) { this.rango = [a, b]; return this }
    limit(n) { this.lim = n; return this }
    maybeSingle() { this.single = true; return this }
    upsert() { return this }
    then(res, rej) { return new Promise(r => setTimeout(r, RETARDO)).then(() => this.correr()).then(res, rej) }
    correr() {
      if (errores[this.t]) return { data: null, count: null, error: { message: `falla simulada en ${this.t}` } }
      let filas = (tablas[this.t] || []).filter(r => this.f.every(fn => fn(r)))
      if (this.cuenta) return { data: this.head ? null : filas, count: filas.length, error: null }
      for (const [c, asc] of [...this.ord].reverse()) filas = [...filas].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1))
      if (this.rango) filas = filas.slice(this.rango[0], this.rango[1] + 1)
      if (this.lim != null) filas = filas.slice(0, this.lim)
      if (this.single) return { data: filas[0] ?? null, error: null }
      return { data: filas, error: null }
    }
  }
  return { from: (t) => new Q(t) }
}

// ── Datos de prueba (fechas relativas a hoy) ──
const dia = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return hoyLocal(d) }
const hoy = dia(0)
const mes = hoy.slice(0, 7)
const venta = (id, fecha, estado, total, extra = {}) => ({
  id, n_referencia: `R${id}`, fecha, estado, total, deleted_at: null, costo_envio: 25000, costo_prod: 30000,
  ganancia_neta: total - 55000, producto_nombre: id % 2 ? 'Raspador' : 'JawFlex', cantidad: 1,
  cliente_telefono: `0981${String(id).padStart(6, '0')}`, pago_anticipado: id === 3, transportadora: 'pap',
  created_at: `${fecha}T10:00:00Z`, seguimiento_at: null, ...extra,
})
const ventas = [
  venta(1, hoy, 'entregado', 199000),
  venta(2, hoy, 'pendiente', 129000),
  venta(3, hoy, 'entregado', 249000),
  venta(4, hoy, 'devuelto', 129000),
  venta(5, dia(-40), 'entregado', 199000),
  venta(6, dia(-60), 'pendiente', 129000), // pendiente viejo (alerta) y en la calle
]
// Si hoy es día 1-2, las ventas de "hoy" igual caen en el mes: la prueba no depende del día.
const tasasMes = []
for (let i = 1; i <= 31; i++) tasasMes.push({ fecha: `${mes}-${String(i).padStart(2, '0')}`, usd_pyg: 7300 })
const tablas = {
  ventas,
  gastos: [{ id: 'g1', monto: 300000, categoria: 'Publicidad', fecha: hoy, deleted_at: null }, { id: 'g2', monto: 100000, categoria: 'Envases', fecha: hoy, deleted_at: null }],
  campanas_ads: [{ gasto: 150000, mes, tienda: 'voltra' }],
  tipo_cambio: tasasMes,
  saldo_banco: [{ id: 's1', monto: 3500000, created_at: `${hoy}T09:00:00Z` }, { id: 's0', monto: 1000, created_at: `${dia(-9)}T09:00:00Z` }],
  productos: [{ id: 'p1', nombre: 'Raspador', stock_actual: 2, stock_alerta: 10, activo: true, es_combo: false }],
  entregas: [{ nro_guia_pap: 'G1', cobrado: 199000, rendido: false, importe: 199000, categoria: 'entregado', fecha_entrega: dia(-20), transportadora: 'pap' }],
  recompra_log: [],
}

async function correr(opciones = {}) {
  const base = crearBase(tablas, opciones)
  const t0 = Date.now()
  const rondas = {}
  const estado = {}
  const { fallas: f } = await cargarDashboard({
    supabase: base, supabaseCrudo: base, tienda: 'voltra', avisar: () => {},
    vigente: opciones.vigente,
    emitir: (b, d) => { rondas[b] = Math.round((Date.now() - t0) / RETARDO); estado[b] = d },
  })
  return { rondas, estado, fallas: f, total: Math.round((Date.now() - t0) / RETARDO) }
}

console.log('── Rondas de red en serie (antes: ~20 hasta ver algo) ──')
const r = await correr()
console.log('   rondas por bloque:', JSON.stringify(r.rondas), '· total', r.total)
ok(r.rondas.heroHoy === 1, `ventas de hoy en 1 ronda (dio ${r.rondas.heroHoy})`)
ok(r.rondas.principal <= 3, `KPIs y ganancia del mes en ≤3 rondas (dio ${r.rondas.principal}): gastos automáticos 2 + tipo de cambio 1`)
for (const b of ['historico', 'enCalle', 'saldo', 'chart7', 'top', 'recientes']) ok(r.rondas[b] === 1, `${b} en 1 ronda (dio ${r.rondas[b]})`)
ok(r.rondas.alertas <= 3 && r.rondas.acciones <= 3, 'alertas y acciones en ≤3 rondas (esperan el gasto de ads)')
ok(r.total <= 3, `carga completa en ≤3 rondas (dio ${r.total})`)

console.log('\n── Resultados ──')
ok(r.fallas.length === 0, `sin fallas (${r.fallas.join(', ')})`)
ok(r.estado.heroHoy.hoyCount === 4 && r.estado.heroHoy.hoyMonto === 706000, 'hero: 4 pedidos y 706.000 hoy')
ok(r.estado.enCalle.enCalleCount === 2 && r.estado.enCalle.enCalleMonto === 258000, 'plata en la calle: 2 pedidos, 258.000 (incluye el pendiente viejo)')
ok(r.estado.saldo.saldo.monto === 3500000, 'saldo: el más reciente')
ok(r.estado.recientes.length === 6, 'ventas recientes')
const k = r.estado.principal.kpis
ok(k && k.gastoAds === 150000 && k.posibleDobleAds === true, 'ads del mes = Campañas y se detecta el doble con "Publicidad"')
ok(k && k.gastosMes === 100000 + 150000, `gastos del mes sin restar dos veces la publicidad (dio ${k?.gastosMes})`)
ok(k && k.ventasBrutas === 448000 && k.entregados === 2 && k.devueltos === 1, 'ventas brutas del mes = solo entregadas')
ok(r.estado.alertas.some(a => a.tipo === 'stock') && r.estado.alertas.some(a => a.tipo === 'pendiente') && r.estado.alertas.some(a => a.tipo === 'doble_ads'), 'alertas: stock, pendiente viejo y doble publicidad')
ok(Array.isArray(r.estado.acciones), 'centro de acciones armado')

console.log('\n── Si una lectura falla, solo ese bloque cae ──')
const rSaldo = await correr({ errores: { saldo_banco: true } })
ok(rSaldo.estado.saldo === undefined && rSaldo.fallas.join() === 'saldo del banco', 'saldo falla → "saldo del banco" y no se toca el saldo')
ok(rSaldo.estado.principal.kpis?.ventasBrutas === 448000, 'los KPIs salen igual')
const rRec = await correr({ errores: { recompra_log: true } })
ok(rRec.fallas.join() === 'recompra' && Array.isArray(rRec.estado.alertas), 'recompra falla → solo esa alerta no se arma; las demás salen')
const rGastos = await correr({ errores: { gastos: true, campanas_ads: true } })
ok(rGastos.estado.principal.kpis === null, 'sin gastos no hay ganancia (mejor nada que un número falso)')
ok(rGastos.fallas.join() === 'gastos del mes,gasto de Campañas', `fallas en orden fijo (${rGastos.fallas.join(', ')})`)

console.log('\n── Respuestas viejas ──')
let vigente = true
const pVieja = correr({ vigente: () => vigente })
vigente = false
const rVieja = await pVieja
ok(Object.keys(rVieja.estado).length === 0, 'una carga reemplazada no pinta nada')

if (fallas) { console.log(`\n${fallas} prueba(s) fallaron`); process.exit(1) }
console.log('\nTodo OK')
