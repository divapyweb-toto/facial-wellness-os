// tests/motor-courier.test.mjs · 21-10-2026
// Motor de courier en el front (src/lib/motorCourier.js + su uso en Despacho).
// Correr: node --import ./tests/registrar.mjs tests/motor-courier.test.mjs
// Las decisiones son SIMULADAS (objetos con la forma de la rpc motor_courier) y los datos, inventados:
// el cálculo de verdad (p, ganancia) vive en la base y no se prueba acá.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import {
  interpretarConfigMotor, motorEstaActivo, cargarMotorConfig, fijarConfigMotor, motorActivo, asegurarMotorConfig,
  claveDecision, normalizarDecision, decisionMotor, decisionGuardada, limpiarCacheMotor, pedirDecisiones,
  paramsMotorDePedido, paramsMotorDeVenta, infoPorReferencia,
  elegirTransportadora, esCambioManual, armarFilaCambio, filasCambioDePedidos, registrarCambiosCourier,
  aplicarMotorAPedido, textoMotor, resumenPedidosParados, insertarTolerante,
} from '../src/lib/motorCourier.js'
import { transportadoraForzada } from '../src/lib/transportadoras.js'

let n = 0
const ok = (m) => { n++; console.log('✓ ' + m) }

// ── Decisiones simuladas (misma forma que devuelve la rpc) ──
const op = (courier, extra = {}) => ({
  courier, flete: 30000, p: 0.8, nivel_p: 'ciudad', pocos_datos: false, ajuste_producto: 1, dias_rendicion: 1,
  costo_caja: 500, ganancia_esperada: 50000, estimado: false, dias_min: 1, dias_max: 2, dias_pedido_entrega: 2, ...extra,
})
const DEC_CDE = {   // Ciudad del Este → Lucero
  ganador: 'lucero', regla: 'ganancia', sin_cobertura: false, pocos_datos: false, fallback_producto: false,
  motivo: 'Lucero · entrega 85% · rinde en 1 días · ganancia esperada ₲64k vs PaP ₲50k',
  opciones: [op('lucero', { p: 0.85, flete: 25000, ganancia_esperada: 64000 }), op('pap', { ganancia_esperada: 50000 })],
}
const DEC_LEJOS = { // Lucero ₲50k vs PaP ₲32k → PaP
  ganador: 'pap', regla: 'ganancia', sin_cobertura: false, pocos_datos: false, fallback_producto: false,
  motivo: 'PaP · entrega 78% · rinde en 9 días · ganancia esperada ₲41k vs Lucero ₲22k',
  opciones: [op('pap', { p: 0.78, flete: 32000, ganancia_esperada: 41000, dias_rendicion: 9 }), op('lucero', { flete: 50000, ganancia_esperada: 22000 })],
}
const DEC_SIN_DATOS = { // ciudad sin historial: p general
  ganador: 'pap', regla: 'ganancia', sin_cobertura: false, pocos_datos: false, fallback_producto: false,
  motivo: 'PaP · entrega 70% · rinde en 9 días · ganancia esperada ₲30k vs Lucero ₲28k',
  opciones: [op('pap', { nivel_p: 'general', ganancia_esperada: 30000 }), op('lucero', { nivel_p: 'general', ganancia_esperada: 28000 })],
}
const DEC_DESEMPATE = {
  ganador: 'lucero', regla: 'desempate_rendicion', sin_cobertura: false, pocos_datos: false, fallback_producto: false,
  motivo: 'Lucero · entrega 82% · rinde en 1 días · ganancia esperada ₲40k vs PaP ₲39k (desempate: rinde más rápido)',
  opciones: [op('lucero', { ganancia_esperada: 40000 }), op('pap', { ganancia_esperada: 39000 })],
}
const DEC_JAW = {   // regla dura de producto: Lucero
  ganador: 'lucero', regla: 'producto_solo_lucero', sin_cobertura: false, pocos_datos: false, fallback_producto: false,
  motivo: 'Lucero (regla de producto: este producto solo va por Lucero)',
  opciones: [op('lucero', { ganancia_esperada: 35000 })],
}
const DEC_JAW_FALLBACK = {   // Lucero no llega: PaP con aviso
  ganador: 'pap', regla: 'producto_fallback_pap', sin_cobertura: false, pocos_datos: false, fallback_producto: true,
  motivo: 'PaP (regla de producto: Lucero no llega acá)',
  opciones: [op('pap', { ganancia_esperada: 18000 })],
}
const DEC_SIN_COBERTURA = {
  ganador: null, regla: 'sin_cobertura', sin_cobertura: true, pocos_datos: false, fallback_producto: false,
  motivo: 'Sin cobertura: ningún courier cobra contra entrega en esta ciudad', opciones: [],
}
const DEC_PAGADO = {   // ya pagado: gana cualquiera que llegue
  ganador: 'pap', regla: 'pagado_adelantado', sin_cobertura: false, pocos_datos: false, fallback_producto: false,
  motivo: 'PaP (ya pagado: cualquier courier que llegue)', opciones: [op('pap', { ganancia_esperada: 60000 })],
}

// Pedido de Despacho inventado (forma de mapearGrupoAPedidos).
const pedido = (extra = {}) => ({
  n_referencia: 'VT-9001', ciudad: 'Ciudad Inventada', producto_nombre: 'Tiras nasales', productoRuteo: 'Tiras nasales',
  total: 120000, totalOrden: 120000, cfg: { despachar: true }, cobranzaOk: true, despachar: true, faltantes: [],
  transportadora: 'pap', costo_envio: 32000, flete_estimado: false, lineaPrincipal: true, motivoTransportadora: 'regla de hoy',
  bloqueadoPorProducto: false, fallbackProducto: false, codRuteo: true, ...extra,
})
const tarifaFalsa = (c) => ({ precio: c === 'lucero' ? 25000 : 32000, estimado: false })

// ═══ 1) Interruptor ═══
{
  assert.deepEqual(interpretarConfigMotor('{"activo": false, "desde": null}'), { activo: false, desde: null })
  assert.deepEqual(interpretarConfigMotor('{"activo": true, "desde": "2026-10-25"}'), { activo: true, desde: '2026-10-25' })
  // cualquier cosa rara = apagado (nunca prende por error)
  for (const raro of [null, undefined, '', 'basura', '[1]', '{"activo": "true"}', '{"activo": 1}', 42]) {
    assert.equal(interpretarConfigMotor(raro).activo, false, String(raro))
  }
  assert.equal(motorEstaActivo({ activo: true, desde: null }, '2026-10-21'), true)
  assert.equal(motorEstaActivo({ activo: true, desde: '2026-10-25' }, '2026-10-24'), false)   // todavía no llegó la fecha
  assert.equal(motorEstaActivo({ activo: true, desde: '2026-10-25' }, '2026-10-25'), true)
  assert.equal(motorEstaActivo({ activo: false, desde: null }, '2026-10-30'), false)
  assert.equal(motorEstaActivo(null), false)
  ok('interruptor: solo prende con activo=true (y fecha desde cumplida); lo raro = apagado')
}
{
  const clienteCon = (resp) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => resp() }) }) }) })
  fijarConfigMotor('{"activo": true, "desde": null}')
  assert.equal(motorActivo(), true)
  // error de red / permisos → apagado, no tira
  let c = await cargarMotorConfig(clienteCon(() => ({ data: null, error: { message: 'boom' } })))
  assert.equal(c.activo, false)
  assert.equal(motorActivo(), false)
  // la promesa rechazada tampoco tira
  c = await cargarMotorConfig(clienteCon(() => { throw new Error('sin red') }))
  assert.equal(c.activo, false)
  // sin fila (sin sesión: RLS vacío) → apagado y se reintenta; con fila prendida → activo
  c = await cargarMotorConfig(clienteCon(() => ({ data: null, error: null })))
  assert.equal(c.activo, false)
  c = await cargarMotorConfig(clienteCon(() => ({ data: { valor: '{"activo": true, "desde": null}' }, error: null })))
  assert.equal(c.activo, true)
  assert.equal(motorActivo(), true)
  // ya cargado: asegurar no vuelve a pedir
  const dado = await asegurarMotorConfig()
  assert.equal(dado.activo, true)
  fijarConfigMotor('{"activo": false, "desde": null}')
  ok('cargarMotorConfig: si falla queda apagado (como hoy); nunca tira')
}

// ═══ 2) decisionMotor: caché, tope, fallas ═══
{
  limpiarCacheMotor()
  let llamadas = 0
  const rpc = async (args) => { llamadas++; assert.equal(args.p_cod, true); return { data: DEC_CDE, error: null } }
  const par = { ciudad: 'Ciudad del Este', producto: 'Tiras nasales', cobro: 120000, cod: true }
  const [a, b] = await Promise.all([decisionMotor(par, { rpc }), decisionMotor({ ...par, ciudad: ' ciudad del este ' }, { rpc })])
  assert.equal(llamadas, 1, 'misma clave = una sola llamada')
  assert.equal(a.ganador, 'lucero'); assert.equal(b.ganador, 'lucero')
  assert.equal(decisionGuardada(par).ganador, 'lucero')
  // otra clave (cod distinto / cobro distinto) = otra llamada
  await decisionMotor({ ...par, cod: false }, { rpc: async (args) => { assert.equal(args.p_cod, false); return { data: DEC_PAGADO, error: null } } })
  await decisionMotor({ ...par, cobro: 150000 }, { rpc })
  assert.equal(llamadas, 2)
  assert.notEqual(claveDecision(par), claveDecision({ ...par, cod: false }))
  ok('decisionMotor: una llamada por clave (ciudad+producto+cobro+cod), cacheada en memoria')
}
{
  limpiarCacheMotor()
  const par = { ciudad: 'Ciudad Tarda', producto: 'Tiras nasales', cobro: 100000 }
  // rpc que nunca responde → null a los 30 ms (tope chico para el test; en producción son 4 s)
  const t0 = Date.now()
  const lenta = await decisionMotor(par, { rpc: () => new Promise(() => {}), timeoutMs: 30 })
  assert.equal(lenta, null)
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(decisionGuardada(par), null)
  // error de la rpc, excepción y respuesta inválida → null
  for (const [i, r] of [
    [1, async () => ({ data: null, error: { message: 'no existe' } })],
    [2, async () => { throw new Error('red caída') }],
    [3, async () => ({ data: { ganador: 'otro_courier' }, error: null })],
    [4, async () => ({ data: 'texto', error: null })],
  ]) {
    assert.equal(await decisionMotor({ ...par, ciudad: 'Falla ' + i }, { rpc: r }), null, 'falla ' + i)
  }
  // una falla se reintenta recién después de 30 s (no se insiste en bucle)
  let llamadas = 0
  let reloj = 1_000_000
  const rpc = async () => { llamadas++; return llamadas === 1 ? { data: null, error: { message: 'x' } } : { data: DEC_LEJOS, error: null } }
  const p2 = { ciudad: 'Reintento', producto: 'Tiras nasales', cobro: 90000 }
  assert.equal(await decisionMotor(p2, { rpc, ahora: () => reloj }), null)
  reloj += 5000
  assert.equal(await decisionMotor(p2, { rpc, ahora: () => reloj }), null)
  assert.equal(llamadas, 1)
  reloj += 31000
  assert.equal((await decisionMotor(p2, { rpc, ahora: () => reloj })).ganador, 'pap')
  assert.equal(llamadas, 2)
  // sin ciudad o sin producto ni se consulta
  assert.equal(await decisionMotor({ ciudad: '', producto: 'x', cobro: 1 }, { rpc }), null)
  assert.equal(llamadas, 2)
  ok('decisionMotor: rpc lenta (>tope), con error o inválida → null (todo sigue como hoy); la falla se reintenta a los 30 s')
}
{
  limpiarCacheMotor()
  let llamadas = 0, simultaneas = 0, maxSim = 0
  const rpc = async () => { llamadas++; simultaneas++; maxSim = Math.max(maxSim, simultaneas); await new Promise(r => setTimeout(r, 5)); simultaneas--; return { data: DEC_CDE, error: null } }
  const lista = Array.from({ length: 25 }, (_, i) => ({ ciudad: 'Ciudad ' + (i % 23), producto: 'Tiras nasales', cobro: 100000 }))
  let tandas = 0
  await pedirDecisiones(lista, { tanda: 10, alTerminarTanda: () => tandas++, opts: { rpc } })
  assert.equal(llamadas, 23, 'repetidas se piden una vez')
  assert.ok(maxSim <= 10)
  assert.equal(tandas, 3)
  // lo ya pedido no se vuelve a pedir
  await pedirDecisiones(lista, { opts: { rpc } })
  assert.equal(llamadas, 23)
  ok('pedirDecisiones: en tandas de 10 en paralelo, sin repetir claves')
}

// ═══ 3) elegirTransportadora ═══
{
  const base = { motor: DEC_CDE, activo: true, actual: 'pap' }
  assert.equal(elegirTransportadora(base), 'lucero')                                       // activo asigna el ganador
  assert.equal(elegirTransportadora({ ...base, activo: false }), 'pap')                    // inactivo no cambia nada
  assert.equal(elegirTransportadora({ ...base, manual: 'pap', motor: DEC_CDE }), 'pap')    // manual gana
  assert.equal(elegirTransportadora({ ...base, manual: 'otra' }), 'otra')
  assert.equal(elegirTransportadora({ ...base, motor: null }), 'pap')                      // sin decisión = como hoy
  // lo ya guardado en una venta NUNCA se reasigna, ni con el motor activo
  assert.equal(elegirTransportadora({ ...base, guardada: 'pap' }), 'pap')
  assert.equal(elegirTransportadora({ ...base, guardada: 'otra', manual: 'lucero' }), 'otra')
  assert.equal(elegirTransportadora({ motor: DEC_CDE, activo: true, actual: 'pap', guardada: 'lucero', manual: 'pap' }), 'lucero')
  // bloqueo de PaP sin cobranza: si el ganador no está entre los que cubren, no se aplica
  assert.equal(elegirTransportadora({ ...base, motor: DEC_LEJOS, actual: 'lucero', disponibles: ['lucero', 'otra'] }), 'lucero')
  assert.equal(elegirTransportadora({ ...base, motor: DEC_LEJOS, actual: 'lucero', disponibles: ['pap', 'lucero', 'otra'] }), 'pap')
  assert.equal(elegirTransportadora({ activo: true, motor: DEC_CDE }), 'lucero')
  assert.equal(elegirTransportadora({}), null)
  ok('elegirTransportadora: guardada > manual > motor activo > el de hoy; inactivo no cambia; respeta cobertura')
}

// ═══ 4) Decisiones simuladas por caso de negocio, con aplicarMotorAPedido ═══
{
  const ap = (p, dec, o = {}) => aplicarMotorAPedido(p, dec, { activo: true, detalleTarifa: tarifaFalsa, ...o })
  // CDE → Lucero (el de hoy era PaP): cambia, con el flete de Lucero
  let r = ap(pedido(), DEC_CDE, { disponibles: ['pap', 'lucero', 'otra'] })
  assert.equal(r.transportadora, 'lucero'); assert.equal(r.costo_envio, 25000); assert.equal(r.despachar, true)
  assert.equal(r.courier_motor, 'lucero'); assert.equal(r.courier_regla, 'ganancia'); assert.equal(r.motorDecision, DEC_CDE)
  assert.match(textoMotor(DEC_CDE), /^Lucero · entrega 85%/)
  // Lucero ₲50k vs PaP ₲32k → PaP
  r = ap(pedido({ transportadora: 'lucero', costo_envio: 50000 }), DEC_LEJOS)
  assert.equal(r.transportadora, 'pap'); assert.equal(r.costo_envio, 32000)
  // Ciudad sin datos → "pocos datos" en la línea
  assert.match(textoMotor(DEC_SIN_DATOS), /pocos datos/)
  assert.doesNotMatch(textoMotor(DEC_LEJOS), /pocos datos/)
  assert.match(textoMotor({ ...DEC_LEJOS, pocos_datos: true }), /pocos datos/)
  assert.equal((textoMotor({ ...DEC_LEJOS, pocos_datos: true, motivo: 'PaP · pocos datos' }).match(/pocos datos/g) || []).length, 1, 'no se repite')
  // Desempate y regla dura se ven en la línea
  assert.match(textoMotor(DEC_DESEMPATE), /desempate: rinde más rápido/)
  assert.match(textoMotor(DEC_JAW), /regla de producto/)
  // JawFlex → regla de hoy: Lucero; si no llega, PaP con aviso (fallbackProducto)
  r = ap(pedido({ producto_nombre: 'Ejercitador JawFlex Pro', productoRuteo: 'Ejercitador JawFlex Pro', transportadora: 'lucero' }), DEC_JAW)
  assert.equal(r.transportadora, 'lucero'); assert.equal(r.fallbackProducto, false)
  r = ap(pedido({ producto_nombre: 'Ejercitador JawFlex Pro', transportadora: null, bloqueadoPorProducto: true, despachar: false, cobranzaOk: false }), DEC_JAW_FALLBACK)
  assert.equal(r.transportadora, 'pap'); assert.equal(r.fallbackProducto, true); assert.equal(r.bloqueadoPorProducto, false); assert.equal(r.despachar, true)
  assert.match(r.motivoTransportadora, /Lucero no llega/)
  // Sin cobertura → sin asignar y no se despacha
  r = ap(pedido(), DEC_SIN_COBERTURA)
  assert.equal(r.transportadora, null); assert.equal(r.despachar, false); assert.equal(r.cobranzaOk, false); assert.equal(r.costo_envio, null)
  assert.equal(r.courier_motor, null); assert.equal(r.courier_regla, 'sin_cobertura')
  assert.match(textoMotor(DEC_SIN_COBERTURA), /Sin cobertura/)
  // Pagado → cualquiera que llegue: si solo llega PaP, PaP
  r = ap(pedido({ transportadora: null, despachar: false }), DEC_PAGADO, { disponibles: ['pap', 'otra'] })
  assert.equal(r.transportadora, 'pap'); assert.equal(r.despachar, true)
  // y si el ganador no llega (datos viejos), se queda como estaba
  r = ap(pedido({ transportadora: 'lucero' }), DEC_PAGADO, { disponibles: ['lucero', 'otra'] })
  assert.equal(r.transportadora, 'lucero')
  // Líneas secundarias de un pedido de varios productos: flete 0 (una sola caja)
  r = ap(pedido({ lineaPrincipal: false, costo_envio: 0 }), DEC_CDE)
  assert.equal(r.transportadora, 'lucero'); assert.equal(r.costo_envio, 0)
  ok('casos: CDE→Lucero, Lucero caro→PaP, sin datos→"pocos datos", JawFlex→regla de hoy, sin cobertura→sin asignar, pagado→el que llegue')
}
{
  // Motor APAGADO: solo anota; no cambia ninguna asignación
  const p = pedido()
  for (const dec of [DEC_CDE, DEC_LEJOS, DEC_SIN_COBERTURA, DEC_JAW, DEC_PAGADO]) {
    const r = aplicarMotorAPedido(p, dec, { activo: false, detalleTarifa: tarifaFalsa })
    assert.equal(r.transportadora, 'pap'); assert.equal(r.costo_envio, 32000); assert.equal(r.despachar, true)
    assert.equal(r.motorDecision, dec); assert.equal(r.courier_regla, dec.regla)
  }
  // Elegido a mano: aunque esté activo, no se toca
  const m = aplicarMotorAPedido(p, DEC_CDE, { activo: true, manual: 'pap', detalleTarifa: tarifaFalsa })
  assert.equal(m.transportadora, 'pap')
  assert.equal(m.courier_motor, 'lucero')   // pero queda anotado lo que eligió el motor (para medir el cambio manual)
  // Sin decisión, retiro en persona o pedido que no se despacha: devuelve el mismo objeto
  assert.equal(aplicarMotorAPedido(p, null, { activo: true }), p)
  const retiro = pedido({ retiroEnPersona: true })
  assert.equal(aplicarMotorAPedido(retiro, DEC_CDE, { activo: true }), retiro)
  const pend = pedido({ cfg: { despachar: false } })
  assert.equal(aplicarMotorAPedido(pend, DEC_CDE, { activo: true }), pend)
  // No muta el original
  assert.equal(p.transportadora, 'pap'); assert.equal(p.motorDecision, undefined)
  ok('motor apagado: solo anota; manual y retiros no se tocan; no muta el pedido')
}

// ═══ 5) Lo ya cargado no se reasigna ═══
{
  // "Desde Ventas": lo que está guardado en la venta manda, incluso con el motor activo y otra opinión
  const ventas = [
    { n_referencia: 'VT-9101', transportadora: 'pap' }, { n_referencia: 'VT-9102', transportadora: 'lucero' },
    { n_referencia: 'VT-9103', transportadora: 'otra' },
  ]
  for (const v of ventas) {
    for (const motor of [DEC_CDE, DEC_LEJOS, DEC_SIN_COBERTURA, DEC_PAGADO]) {
      assert.equal(elegirTransportadora({ motor, activo: true, actual: 'lucero', guardada: v.transportadora }), v.transportadora)
    }
  }
  // La pantalla no pasa las ventas cargadas por el motor: ventaAPedido sigue respetando v.transportadora
  const src = readFileSync(new URL('../src/pages/despacho/DespachoPagina.jsx', import.meta.url), 'utf8')
  const ventaAPedido = src.slice(src.indexOf('function ventaAPedido'), src.indexOf('// Columnas de "Desde Ventas"'))
  assert.match(ventaAPedido, /const transportadora = v\.transportadora \|\| sug\.transportadora/)
  assert.doesNotMatch(ventaAPedido, /motor/i)
  // y el motor solo se aplica a pedidos NUEVOS: en "Traer de Voltra" a los que no tienen venta
  assert.match(src, /frescos = \[\.\.\.conCourier, \.\.\.sinCobertura\]\.filter\(p => !cuenta\.has\(String\(p\.n_referencia\)\)\)/)
  ok('lo ya cargado en Ventas no se reasigna (guardada manda; ventaAPedido intacta; Voltra solo pedidos nuevos)')
}

// ═══ 6) Registro de cambios manuales ═══
{
  assert.equal(esCambioManual(DEC_CDE, 'pap'), true)
  assert.equal(esCambioManual(DEC_CDE, 'lucero'), false)
  assert.equal(esCambioManual(DEC_CDE, 'otra'), true)
  assert.equal(esCambioManual(DEC_SIN_COBERTURA, 'pap'), false)   // el motor no eligió a nadie: no hay "cambio"
  assert.equal(esCambioManual(null, 'pap'), false)
  assert.equal(armarFilaCambio({ ref: 'VT-9001', ciudad: 'Ciudad del Este', producto: 'Tiras nasales', decision: DEC_CDE, final: 'lucero' }), null)
  assert.equal(armarFilaCambio({ ref: 'VT-9001', decision: null, final: 'pap' }), null)
  const f = armarFilaCambio({ ref: 'VT-9001', ciudad: 'Ciudad del Este', producto: 'Tiras nasales', decision: DEC_CDE, final: 'pap' })
  assert.deepEqual(f, {
    n_referencia: 'VT-9001', ciudad: 'Ciudad del Este', producto: 'Tiras nasales',
    courier_motor: 'lucero', courier_final: 'pap', regla_motor: 'ganancia', ganancia_motor: 64000, ganancia_final: 50000,
  })
  // 'otra' no tiene ganancia calculada → null (no se inventa)
  assert.equal(armarFilaCambio({ ref: 'VT-9001', decision: DEC_CDE, final: 'otra' }).ganancia_final, null)
  // sin datos personales en la fila
  assert.deepEqual(Object.keys(f).sort(), ['ciudad', 'courier_final', 'courier_motor', 'ganancia_final', 'ganancia_motor', 'n_referencia', 'producto', 'regla_motor'])
  // pedidos: una fila por referencia, solo los insertados y solo si difiere
  const ps = [
    pedido({ n_referencia: 'VT-1', transportadora: 'pap', motorDecision: DEC_CDE }),
    pedido({ n_referencia: 'VT-1', transportadora: 'pap', motorDecision: DEC_CDE, lineaPrincipal: false }),   // 2ª línea
    pedido({ n_referencia: 'VT-2', transportadora: 'lucero', motorDecision: DEC_CDE }),                       // igual al motor
    pedido({ n_referencia: 'VT-3', transportadora: 'pap', motorDecision: DEC_CDE }),                          // no se insertó
    pedido({ n_referencia: 'VT-4', transportadora: 'pap' }),                                                  // sin decisión
  ]
  const filas = filasCambioDePedidos(ps, new Set(['VT-1', 'VT-2', 'VT-4']))
  assert.deepEqual(filas.map(x => x.n_referencia), ['VT-1'])
  assert.equal(filasCambioDePedidos(ps).length, 2)   // sin filtro de insertadas: VT-1 y VT-3
  // el registro nunca tira
  let usado = null
  assert.equal(await registrarCambiosCourier(filas, { from: (t) => ({ insert: async (x) => { usado = [t, x]; return { error: null } } }) }), true)
  assert.equal(usado[0], 'courier_cambios'); assert.equal(usado[1].length, 1)
  assert.equal(await registrarCambiosCourier(filas, { from: () => ({ insert: async () => ({ error: { message: 'sin tabla' } }) }) }), false)
  assert.equal(await registrarCambiosCourier(filas, { from: () => { throw new Error('x') } }), false)
  assert.equal(await registrarCambiosCourier([], { from: () => { throw new Error('no debería llamarse') } }), false)
  ok('courier_cambios: solo cuando difiere, una fila por pedido, sin datos personales, tolerante a fallas')
}

// ═══ 7) Texto de la línea ═══
{
  assert.equal(textoMotor(null), '')
  assert.equal(textoMotor({ ganador: 'lucero', motivo: '' }), 'Motor: Lucero')
  assert.equal(textoMotor(normalizarDecision({ ganador: 'pap', motivo: 'PaP · algo', opciones: [{ courier: 'pap', nivel_p: 'zona' }] })), 'PaP · algo')
  assert.equal(textoMotor(normalizarDecision({ ganador: 'pap', motivo: 'PaP · algo', opciones: [{ courier: 'pap', nivel_p: 'general' }] })), 'PaP · algo · pocos datos')
  assert.equal(textoMotor(normalizarDecision({ ganador: 'pap', motivo: 'PaP · algo', opciones: [{ courier: 'pap', pocos_datos: true }] })), 'PaP · algo · pocos datos')
  // normalizar: forma inválida → null
  assert.equal(normalizarDecision(null), null); assert.equal(normalizarDecision({}), null); assert.equal(normalizarDecision({ ganador: 'x' }), null)
  assert.equal(normalizarDecision({ ganador: null, sin_cobertura: true }).sin_cobertura, true)
  ok('textoMotor: motivo de la base + "pocos datos" cuando el dato es flojo (nivel general o pocos_datos)')
}

// ═══ 8) Parámetros de la consulta ═══
{
  const p = pedido({ productoRuteo: 'Ejercitador JawFlex Pro', producto_nombre: 'Tiras nasales', totalOrden: 300000, total: 120000 })
  assert.deepEqual(paramsMotorDePedido(p, true), { ciudad: 'Ciudad Inventada', producto: 'Ejercitador JawFlex Pro', cobro: 300000, cod: true })
  assert.equal(paramsMotorDePedido(p, false).cod, false)
  // todas las líneas de un pedido comparten clave → misma decisión
  assert.equal(claveDecision(paramsMotorDePedido(p, true)), claveDecision(paramsMotorDePedido({ ...p, total: 180000 }, true)))
  // Desde Ventas: una decisión por pedido; el producto con regla (JawFlex) rige toda la caja
  const filas = [
    { n_referencia: 'VT-7', producto_nombre: 'Tiras nasales', total: 100000, ciudad: 'X' },
    { n_referencia: 'VT-7', producto_nombre: 'Ejercitador JawFlex Pro', total: 200000, ciudad: 'X' },
    { n_referencia: 'VT-8', producto_nombre: 'Tiras nasales', total: 90000, ciudad: 'Y', pago_anticipado: true },
  ]
  const info = infoPorReferencia(filas, transportadoraForzada)
  assert.deepEqual(info.get('VT-7'), { producto: 'Ejercitador JawFlex Pro', forzado: true, cobro: 300000 })
  assert.equal(info.get('VT-8').cobro, 90000)
  assert.deepEqual(paramsMotorDeVenta(filas[0], info.get('VT-7')), { ciudad: 'X', producto: 'Ejercitador JawFlex Pro', cobro: 300000, cod: true })
  assert.equal(paramsMotorDeVenta(filas[2], info.get('VT-8')).cod, false)
  ok('parámetros: cobro del pedido entero, producto de la regla, cod según pago anticipado')
}

// ═══ 9) Banner de pedidos parados ═══
{
  const f = (ref, horas, extra = {}) => ({ ref, nombre: '#' + ref.slice(3), ciudad: 'Ciudad ' + ref, horas, dias: Math.floor(horas / 24), etapa: 'sin_despachar', courier: 'pap', producto: 'X', ...extra })
  const r = resumenPedidosParados([f('VT-3', 30), f('VT-1', 130), f('VT-2', 49, { etapa: 'sin_cargar', courier: null })])
  assert.equal(r.n, 3); assert.equal(r.resto, 0)
  assert.equal(r.texto, 'VT-1 Ciudad VT-1 · 5 días · sin_despachar → PaP · VT-2 Ciudad VT-2 · 2 días · sin_cargar · VT-3 Ciudad VT-3 · 1 día · sin_despachar → PaP')
  // máximo 10 y "y N más", del más viejo al más nuevo
  const muchas = Array.from({ length: 13 }, (_, i) => f('VT-' + (100 + i), 25 + i))
  const r2 = resumenPedidosParados(muchas)
  assert.equal(r2.items.length, 10); assert.equal(r2.resto, 3); assert.equal(r2.n, 13)
  assert.match(r2.items[0], /^VT-112 /); assert.match(r2.texto, / y 3 más$/)
  assert.equal(resumenPedidosParados([]).n, 0)
  assert.equal(resumenPedidosParados(null).texto, '')
  assert.equal(resumenPedidosParados([f('VT-9', 24, { courier: 'lucero' })]).texto, 'VT-9 Ciudad VT-9 · 1 día · sin_despachar → Lucero')
  ok('pedidos parados: más viejo primero, máximo 10 y "y N más"')
}

// ═══ 10) Guardado tolerante a columnas que faltan ═══
{
  const falta = (cols) => ({
    enviados: [],
    from(tabla) {
      assert.equal(tabla, 'ventas')
      return { insert: async (filas) => {
        this.enviados.push(filas)
        const c = cols.find(col => filas.some(r => col in r))
        return c ? { error: { message: `Could not find the '${c}' column of 'ventas' in the schema cache` } } : { error: null }
      } }
    },
  })
  const filas = [{ n_referencia: 'VT-1', total: 1, courier_motor: 'pap', courier_regla: 'ganancia', notas: 'x' }]
  // faltan las DOS columnas nuevas: se sacan una por una y el resto se guarda
  const c = falta(['courier_motor', 'courier_regla'])
  const r = await insertarTolerante(c, 'ventas', filas)
  assert.equal(r.error, null)
  assert.deepEqual(r.filas, [{ n_referencia: 'VT-1', total: 1, notas: 'x' }])
  assert.equal(c.enviados.length, 3)
  assert.ok('courier_motor' in filas[0], 'no muta las filas originales')
  // un error distinto se devuelve tal cual, sin reintentar
  const c2 = { from: () => ({ insert: async () => ({ error: { message: 'duplicate key' } }) }) }
  const r2 = await insertarTolerante(c2, 'ventas', filas)
  assert.equal(r2.error.message, 'duplicate key'); assert.equal(r2.filas, filas)
  // tope de reintentos: no entra en bucle infinito
  let veces = 0
  const c3 = { from: () => ({ insert: async () => { veces++; return { error: { message: `Could not find the 'c${veces}' column of 'ventas'` } } } }) }
  const r3 = await insertarTolerante(c3, 'ventas', filas, 3)
  assert.ok(r3.error); assert.equal(veces, 4)
  ok('insertarTolerante: saca varias columnas faltantes, devuelve otros errores y no entra en bucle')
}

// ═══ 11) La fila de venta que arma Despacho guarda lo que dijo el motor ═══
{
  const dir = new URL('../src/pages/despacho/', import.meta.url)
  const copia = new URL('_probe_motor.jsx', dir)
  const salida = new URL('../_probe_motor.out.mjs', import.meta.url)
  const opts = {
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
    define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
  }
  writeFileSync(copia, readFileSync(new URL('DespachoPagina.jsx', dir), 'utf8') + '\nexport { filaVentaDePedido, aplicarMotorLote }\n')
  try {
    buildSync({ ...opts, entryPoints: [copia.pathname], outfile: salida.pathname })
    const D = await import(pathToFileURL(salida.pathname).href)
    const base = { fecha: '2026-10-21', producto_nombre: 'Tiras nasales', cantidad: 1, total: 120000, n_referencia: 'VT-9001', tienda: 'voltra', ciudad: 'Ciudad Inventada',
      cliente_nombre: 'Cliente Prueba', telefono: '0981000000', direccion: 'Calle Inventada 1', estado_releasit: 'confirmado', transportadora: 'lucero', costo_envio: 25000 }
    const con = D.filaVentaDePedido({ ...base, courier_motor: 'pap', courier_regla: 'ganancia' }, [])
    assert.equal(con.courier_motor, 'pap'); assert.equal(con.courier_regla, 'ganancia'); assert.equal(con.transportadora, 'lucero')
    const sin = D.filaVentaDePedido(base, [])
    assert.equal('courier_motor' in sin, false); assert.equal('courier_regla' in sin, false)
    // aplicarMotorLote con el motor apagado y sin red (la rpc falla): devuelve los pedidos como estaban
    limpiarCacheMotor(); fijarConfigMotor('{"activo": false, "desde": null}')
    const antes = [pedido({ n_referencia: 'VT-9500', ciudad: '' })]   // sin ciudad: ni se consulta
    const despues = await D.aplicarMotorLote(antes)
    assert.equal(despues[0].transportadora, 'pap'); assert.equal(despues[0].courier_motor, undefined)
    ok('Despacho: la venta guarda courier_motor/courier_regla (si hay) y sin motor queda igual que hoy')
  } finally {
    for (const f of [copia, salida]) { try { rmSync(f) } catch { /* nada */ } }
  }
}

console.log(`\n${n} bloques de motor-courier OK`)
