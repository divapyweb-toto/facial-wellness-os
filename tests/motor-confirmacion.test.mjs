// tests/motor-confirmacion.test.mjs · 16-11-2026 (paquete b: motor de courier + Despacho). Datos INVENTADOS.
// Corre contra el código real: motorCourier.js y transportadoras.js directo; las funciones internas de Despacho con una
// copia compilada de DespachoPagina.jsx (mismo patrón que despacho-arreglos.test.mjs).
//   1. Cambio manual contra el motor: cuándo pedir confirmación y qué texto (con los números que devuelve el motor).
//   2. Motor sin respuesta: estado 'fallo' visible (no se usa la lista vieja en silencio).
//   3. Respaldo del ruteo (decisión de Enrique 26-10): donde los dos cobran contra entrega va Lucero; PaP solo donde
//      Lucero no llega. Pagado: el de menor flete, diferencia < ₲3.000 → Lucero. JawFlex solo Lucero.
//   4. Pagados en "Desde Ventas": las etiquetas de Shopify (PAGO_VERIFICADO, PAGADO, PAGADO_QR, CREDITO) dan ₲0.
//   5. Destildar "ya pagado" en un pedido con etiqueta de pago pide confirmación.
//   6. Carga manual en Ventas: courier según el método de envío.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import {
  confirmacionCambioManual, estadoDecision, decisionMotor, limpiarCacheMotor, paramsMotorDeVenta,
} from '../src/lib/motorCourier.js'
import {
  sugerirTransportadora, transportadoraDeMetodoEnvio, DIAS_PREFERIR_LUCERO,
} from '../src/lib/transportadoras.js'
import { fijarTarifasCourier } from '../src/lib/tarifasCourier.js'

DIAS_PREFERIR_LUCERO.length = 0   // regla normal (sin el día de lluvia)

let n = 0
const ok = (m) => { n++; console.log('✓ ' + m) }

// ── 1) Confirmación del cambio manual ──────────────────────
const dec = {
  ganador: 'lucero', regla: 'guarda_lucero', sin_cobertura: false, motivo: 'Lucero · …',
  sugerencia: { courier: 'pap', extra: 1500, motivo: 'margen menor al mínimo' },
  opciones: [
    { courier: 'pap', flete: 27000, p: 0.7612, ganancia_esperada: 39100 },
    { courier: 'lucero', flete: 45000, p: 0.9105, ganancia_esperada: 37600 },
  ],
}
assert.equal(confirmacionCambioManual(dec, 'lucero', { activo: true }), null, 'mismo courier que el motor: no pregunta')
assert.equal(confirmacionCambioManual(dec, 'pap', { activo: false }), null, 'motor apagado: no pregunta (solo sugiere)')
assert.equal(confirmacionCambioManual(null, 'pap', { activo: true }), null, 'sin decisión: no pregunta')
assert.equal(confirmacionCambioManual({ ...dec, ganador: null, sin_cobertura: true }, 'pap', { activo: true }), null)
const t1 = confirmacionCambioManual(dec, 'pap', { activo: true })
assert.ok(t1, 'distinto del motor con el motor activo: pregunta')
assert.match(t1, /^El motor elige Lucero\. Pasar a PaP/)
assert.match(t1, /ganancia esperada \+₲1\.500 por pedido/)          // 39.100 − 37.600, de las opciones del motor
assert.match(t1, /entrega Lucero 91% vs PaP 76%/)                     // p del motor redondeada
assert.match(t1, /flete Lucero ₲45\.000 vs PaP ₲27\.000/)
assert.match(t1, /margen menor al mínimo/)
assert.match(t1, /¿Confirmás\?$/)
const t2 = confirmacionCambioManual({ ...dec, regla: 'ganancia', opciones: [
  { courier: 'pap', flete: 27000, p: 0.7, ganancia_esperada: 30000 }, { courier: 'lucero', flete: 30000, p: 0.9, ganancia_esperada: 42345 }] }, 'pap')
assert.match(t2, /ganancia esperada −₲12\.345 por pedido/)
const t3 = confirmacionCambioManual({ ...dec, opciones: [dec.opciones[1]] }, 'pap')
assert.match(t3, /PaP no figura entre las opciones del motor/)
const t4 = confirmacionCambioManual({ ...dec, regla: 'producto_solo_lucero' }, 'otra')
assert.match(t4, /Pasar a Otra/)
assert.match(t4, /JawFlex solo por Lucero/)
ok('cambio manual contra el motor: pide confirmación con ganancia, entrega y flete del motor')

// ── 2) Motor sin respuesta ─────────────────────────────────
limpiarCacheMotor()
const pm = { ciudad: 'Ciudad Inventada', producto: 'Raspador', cobro: 112000, cod: true }
assert.equal(estadoDecision(pm), null, 'nunca pedido')
const lenta = decisionMotor(pm, { rpc: () => new Promise(() => {}), timeoutMs: 20 })
assert.equal(estadoDecision(pm), 'pendiente')
assert.equal(await lenta, null)
assert.equal(estadoDecision(pm), 'fallo', 'pasó el tope: queda como fallo (aviso visible)')
const pm2 = { ...pm, ciudad: 'Otra Ciudad Inventada' }
await decisionMotor(pm2, { rpc: async () => ({ data: { ganador: 'lucero', regla: 'ganancia', opciones: [] }, error: null }) })
assert.equal(estadoDecision(pm2), 'ok')
const pm3 = { ...pm, ciudad: 'Tercera Ciudad Inventada' }
await decisionMotor(pm3, { rpc: async () => ({ data: null, error: { message: 'caída' } }) })
assert.equal(estadoDecision(pm3), 'fallo')
limpiarCacheMotor()
ok('motor sin respuesta (tope o error): estado "fallo"; con respuesta: "ok"')

// ── 3) Respaldo del ruteo ──────────────────────────────────
// Sin tabla cargada (como en las funciones): la lista de Lucero del código.
fijarTarifasCourier(null)
for (const c of ['Villarrica', 'Capiatá', 'Ñemby', 'Limpio', 'Pedro Juan Caballero']) {
  assert.equal(sugerirTransportadora(c, 'Raspador de Lengua').transportadora, 'lucero', `${c}: los dos cobran → Lucero`)
}
assert.equal(sugerirTransportadora('Concepción', 'Raspador de Lengua').transportadora, 'pap', 'Concepción: Lucero no llega → PaP')
assert.equal(sugerirTransportadora('Villarrica', 'Ejercitador de Mandíbula JawFlex').transportadora, 'lucero', 'JawFlex: Lucero')
assert.equal(sugerirTransportadora('Concepción', 'Ejercitador de Mandíbula JawFlex').transportadora, 'pap', 'JawFlex sin Lucero → PaP con nota')
assert.equal(sugerirTransportadora('Concepción', 'Ejercitador de Mandíbula JawFlex').fallbackProducto, true)
// Con tabla cargada (datos inventados con la forma de tarifas_courier_vigente).
const fila = (courier, ciudad, precio, cobranza = true) => ({ courier, ciudad, ciudad_nombre: ciudad, precio, aplica_cobranza: cobranza, llega: true })
fijarTarifasCourier({ tarifas: [
  fila('lucero', 'villarrica', 45000), fila('pap', 'villarrica', 32076),
  fila('pap', 'concepcion', 32076),
  fila('lucero', 'asuncion', 30000), fila('pap', 'asuncion', 28500),
  fila('lucero', 'caacupe', 40000), fila('pap', 'caacupe', 27324),
  fila('lucero', 'san juan nepomuceno', 50000, false), fila('pap', 'san juan nepomuceno', 32076, true),
] })
const v = sugerirTransportadora('Villarrica', 'Raspador de Lengua')
assert.equal(v.transportadora, 'lucero', 'Villarrica con tabla: Lucero (antes PaP por la lista oficial)')
assert.equal(v.tarifa, 45000)
assert.equal(sugerirTransportadora('Concepción', 'Raspador de Lengua').transportadora, 'pap')
assert.equal(sugerirTransportadora('San Juan Nepomuceno', 'Raspador de Lengua').transportadora, 'pap', 'Lucero llega sin cobranza: PaP')
// Pagado por adelantado: menor flete; diferencia < ₲3.000 → Lucero.
assert.equal(sugerirTransportadora('Asunción', 'Raspador de Lengua', { cod: false }).transportadora, 'lucero', 'dif ₲1.500 → Lucero')
assert.equal(sugerirTransportadora('Caacupé', 'Raspador de Lengua', { cod: false }).transportadora, 'pap', 'dif ₲12.676 → PaP (más barato)')
assert.equal(sugerirTransportadora('Villarrica', 'Raspador de Lengua', { cod: false }).transportadora, 'pap')
fijarTarifasCourier(null)
ok('respaldo del ruteo: Lucero donde los dos cobran, PaP solo donde Lucero no cobra; pagado por menor flete')

// ── 6) Carga manual en Ventas ──────────────────────────────
assert.equal(transportadoraDeMetodoEnvio('Lucero del Este'), 'lucero')
assert.equal(transportadoraDeMetodoEnvio('Punto a Punto AC'), 'pap')
assert.equal(transportadoraDeMetodoEnvio('Punto a Punto'), 'pap')
assert.equal(transportadoraDeMetodoEnvio('Otra transportadora'), 'otra')
assert.equal(transportadoraDeMetodoEnvio('Retiro en persona'), 'otra')
assert.equal(transportadoraDeMetodoEnvio(''), null)
assert.equal(transportadoraDeMetodoEnvio('Courier Inventado SA'), null, 'desconocido: no se adivina (queda como hoy)')
ok('carga manual: courier según el método de envío')

// ── 4) y 5) Despacho (copia compilada) ─────────────────────
const dir = new URL('../src/pages/despacho/', import.meta.url)
const fuente = readFileSync(new URL('DespachoPagina.jsx', dir), 'utf8')
const copia = new URL('_probe_motor_conf.jsx', dir)
const salida = new URL('../_probe_motor_conf.out.mjs', import.meta.url)
const opts = {
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
}
writeFileSync(copia, fuente + '\nexport { ventaAPedido, clasificarVentasPendientes, avisoDestildarPago }\n')
try {
  buildSync({ ...opts, entryPoints: [copia.pathname], outfile: salida.pathname })
  const D = await import(pathToFileURL(salida.pathname).href)
  const venta = (ref, extra = {}) => ({ id: ref, n_referencia: ref, ciudad: 'Asunción', producto_nombre: 'Raspador de Lengua', cantidad: 1,
    total: 112000, pago_anticipado: false, transportadora: 'lucero', costo_envio: 30000, tienda: 'voltra', ...extra })
  const shop = (nombre, tags, extra = {}) => ({ nombre, tags, cancelado: null, fin: 'pending', ...extra })
  const { sale } = D.clasificarVentasPendientes(
    [venta('VT-9101'), venta('VT-9102'), venta('VT-9103'), venta('VT-9104'), venta('VT-9105'), venta('VT-9106', { pago_anticipado: true })],
    [shop('#9101', 'CONFIRMADO, PAGO_VERIFICADO'), shop('#9102', 'CONFIRMADO, PAGADO_QR'), shop('#9103', 'CONFIRMADO, CREDITO'),
      shop('#9104', 'CONFIRMADO'), shop('#9105', 'CONFIRMADO, PAGADO'), shop('#9106', 'CONFIRMADO')])
  const pedido = Object.fromEntries(sale.map(v => [v.n_referencia, D.ventaAPedido(v)]))
  for (const ref of ['VT-9101', 'VT-9102', 'VT-9103', 'VT-9105', 'VT-9106']) {
    assert.equal(pedido[ref].prepago, true, `${ref}: con etiqueta de pago (o venta pagada) → prepago, importe ₲0`)
    assert.equal(pedido[ref].prioridad, true, `${ref}: pagado va primero`)
  }
  assert.equal(pedido['VT-9104'].prepago, false, 'sin etiqueta de pago: contra entrega')
  // La venta sigue sin cambios en la base: solo se marca en memoria.
  assert.equal(sale.find(v => v.n_referencia === 'VT-9101').pago_anticipado, false)
  assert.equal(paramsMotorDeVenta(sale.find(v => v.n_referencia === 'VT-9101'), null).cod, false, 'motor: pagado → cod=false')
  ok('Desde Ventas: etiquetas de pago de Shopify → prepago (₲0, "YA PAGADO - NO COBRAR") sin tocar la venta')

  assert.match(D.avisoDestildarPago({ n_referencia: 'VT-9201', prepago: true, pagadoShopify: true, total: 158000 }) || '', /VT-9201.*158\.000/s)
  assert.equal(D.avisoDestildarPago({ n_referencia: 'VT-9202', prepago: false, pagadoShopify: true, total: 158000 }), null, 'volver a tildar: no pregunta')
  assert.equal(D.avisoDestildarPago({ n_referencia: 'VT-9203', prepago: true, pagadoShopify: false, total: 158000 }), null, 'marcado a mano sin etiqueta: no pregunta')
  ok('destildar "ya pagado" en un pedido con etiqueta de pago pide confirmación')
  assert.match(fuente, /confirmacionCambioManual\(p\.motorDecision, val, \{ activo: motorOn \}\)/)
  assert.match(fuente, /motor sin respuesta: revisar courier/)
  ok('Despacho usa la confirmación en el selector y muestra el aviso de motor sin respuesta')
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true })
}

console.log(`\n${n} verificaciones de motor + Despacho OK`)
