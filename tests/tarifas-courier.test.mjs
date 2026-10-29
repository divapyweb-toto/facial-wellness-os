// tests/tarifas-courier.test.mjs · 20-10-2026
// Tarifas con cobranza por courier y ciudad (src/lib/tarifasCourier.js) y su efecto en transportadoras.js.
// La lógica es la de las funciones SQL tarifa_courier / sugerir_courier (migración 20261020000001).
// OJO: el repo es público → los precios de acá son DE MENTIRA (los reales están solo en la base). Están elegidos para
// que cada ciudad dé la misma decisión que da hoy la base: CDE → Lucero, Asunción → Lucero, Itauguá → PaP,
// Villarrica → PaP, Fram → Lucero (PaP no cobra), San Juan Nepomuceno → sin cobertura, Pueblo Inventado → desconocida.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normCiudad, tarifaCourier, sugerirCourier, fijarTarifasCourier, tarifasCourierCargadas, textoSugerenciaCosto, filaTarifa,
} from '../src/lib/tarifasCourier.js'
import { cubre, tarifaDe, tarifaDetalle, fleteEstimado, sugerirTransportadora, transportadorasDisponibles, DIAS_PREFERIR_LUCERO } from '../src/lib/transportadoras.js'

DIAS_PREFERIR_LUCERO.length = 0 // regla normal (sin el día de lluvia)

const fila = (courier, ciudad, ciudad_nombre, precio, extra = {}) => ({
  courier, ciudad, ciudad_nombre, precio, alias: [], zona: null, tiempo: null, dias_min: 1, dias_max: 3,
  aplica_cobranza: true, tiene_agencia: null, ...extra,
})
const CDE_ALIAS = ['cuidad del este', 'cde', 'ciudad del este cde']
const FIXTURE = {
  tarifas: [
    fila('pap', 'ciudad del este', 'Ciudad del Este', 31000, { alias: CDE_ALIAS, zona: 'INTERIOR 1' }),
    fila('pap', 'asuncion', 'Asunción', 26000, { zona: 'GRAN ASUNCION' }),
    fila('pap', 'itaugua', 'Itauguá', 26000, { alias: ['itagua'], zona: 'CENTRAL' }),
    fila('pap', 'villarrica', 'Villarrica', 31000, { zona: 'INTERIOR 1' }),
    fila('pap', 'coronel oviedo', 'Coronel Oviedo', 31000, { zona: 'INTERIOR 1' }),
    fila('pap', 'san juan nepomuceno', 'San Juan Nepomuceno', 36000, { zona: 'INTERIOR 2', aplica_cobranza: false }),
    fila('pap', 'ayolas', 'Ayolas', 36000, { zona: 'INTERIOR 2', aplica_cobranza: false }),
    fila('pap', 'fram', 'Fram', 36000, { zona: 'INTERIOR 2', aplica_cobranza: false }),
    fila('lucero', 'ciudad del este', 'Ciudad del Este', 24000, { alias: CDE_ALIAS, dias_min: 0, dias_max: 1 }),
    fila('lucero', 'asuncion', 'Asunción', 29000),
    fila('lucero', 'itaugua', 'Itaguá', 39000, { alias: ['itagua'] }),
    fila('lucero', 'fram', 'Fram', 39000),
    fila('lucero', 'villarrica', 'Villarrica', 44000),
  ],
  tasas: [
    { courier: 'lucero', entregados: 39, resueltos: 42, tasa_medida: 92.9, pocos_datos: false, tasa_usada: 92.9 },
    { courier: 'pap', entregados: 2, resueltos: 3, tasa_medida: 66.7, pocos_datos: true, tasa_usada: 75 },
  ],
  zonasPaP: JSON.stringify({ 'GRAN ASUNCION': 26000, CENTRAL: 26000, 'INTERIOR 1': 31000, 'INTERIOR 2': 36000, 'INTERIOR 3': 36000 }),
}

test('normCiudad: igual que ciudad_norm de la base', () => {
  assert.equal(normCiudad('Cnel. Oviedo'), 'coronel oviedo')
  assert.equal(normCiudad('cnl oviedo'), 'coronel oviedo')
  assert.equal(normCiudad('Gral. Díaz'), 'general diaz')
  assert.equal(normCiudad('Pdte. Franco'), 'presidente franco')
  assert.equal(normCiudad('Itauguá (Central)'), 'itaugua')
  assert.equal(normCiudad('  Asunción,  barrio   Sajonia '), 'asuncion barrio sajonia')
  assert.equal(normCiudad("Juan E. O'Leary"), "juan e o'leary")
  assert.equal(normCiudad('Ñemby'), 'nemby')
  assert.equal(normCiudad(null), '')
})

test('sin tabla cargada: todo null y transportadoras.js sigue como antes', () => {
  fijarTarifasCourier(null)
  assert.equal(tarifasCourierCargadas(), false)
  assert.equal(tarifaCourier('pap', 'Asunción'), null)
  assert.equal(sugerirCourier('Asunción'), null)
  assert.equal(textoSugerenciaCosto(null), null)
  // Lista vieja del código: daba San Juan Nepomuceno como "con cobranza" (el error que motivó la tabla).
  assert.equal(cubre('pap', 'San Juan Nepomuceno'), true)
  assert.deepEqual(tarifaDetalle('pap', 'Capiatá'), { precio: 29000, estimado: true }) // flete plano de Config (fábrica)
  assert.equal(tarifaDe('pap', 'Pueblo Inventado'), null)
})

test('una tabla vacía (p. ej. sin sesión, RLS) NO cuenta como cargada', () => {
  assert.equal(fijarTarifasCourier({ tarifas: [], tasas: FIXTURE.tasas, zonasPaP: FIXTURE.zonasPaP }), false)
  assert.equal(tarifasCourierCargadas(), false)
})

test('tarifaCourier: exacta, alias, contenida en el texto y estimada por zona', () => {
  assert.equal(fijarTarifasCourier(FIXTURE), true)
  const cde = tarifaCourier('lucero', 'Cuidad del Este')
  assert.equal(cde.precio, 24000)
  assert.equal(cde.estimado, false)
  assert.equal(cde.cobranza, true)
  assert.equal(tarifaCourier('pap', 'Asunción, barrio Sajonia').precio, 26000)
  assert.equal(tarifaCourier('pap', 'Itaguá').precio, 26000)
  assert.deepEqual(tarifaCourier('pap', 'Itaguá'), tarifaCourier('pap', 'Itauguá'))
  assert.equal(tarifaCourier('pap', 'Cnel. Oviedo').ciudad, 'Coronel Oviedo')
  assert.equal(tarifaCourier('pap', 'San Juan Nepomuceno').cobranza, false)
  const inventado = tarifaCourier('pap', 'Pueblo Inventado')
  assert.deepEqual(
    { precio: inventado.precio, zona: inventado.zona, estimado: inventado.estimado, cobranza: inventado.cobranza, dias: [inventado.dias_min, inventado.dias_max] },
    { precio: 36000, zona: 'INTERIOR 2', estimado: true, cobranza: null, dias: [3, 5] })
  assert.equal(tarifaCourier('lucero', 'Pueblo Inventado'), null)
  assert.equal(tarifaCourier('pap', ''), null)
  // Exacta gana a "contenida": "ciudad del este cde" es alias exacto, no "ciudad del este" contenida.
  assert.equal(filaTarifa('lucero', 'Ciudad del Este CDE').ciudad, 'ciudad del este')
})

test('sugerirCourier: los casos reales de hoy (misma decisión que la rpc)', () => {
  fijarTarifasCourier(FIXTURE)
  const cde = sugerirCourier('Cuidad del Este')
  assert.equal(cde.sugerido, 'lucero')
  assert.equal(cde.sin_cobertura, false)
  assert.equal(cde.ciudad_reconocida, true)
  assert.deepEqual(cde.opciones.map((o) => [o.courier, o.precio, o.tasa, o.costo_por_entregado, o.valido, o.pocos_datos]),
    [['lucero', 24000, 92.9, 25834, true, false], ['pap', 31000, 75, 41333, true, true]])

  const asu = sugerirCourier('Asunción, barrio Sajonia')
  assert.equal(asu.sugerido, 'lucero')
  assert.deepEqual(asu.opciones.map((o) => o.costo_por_entregado), [31216, 34667])

  const sjn = sugerirCourier('San Juan Nepomuceno')
  assert.equal(sjn.sugerido, null)
  assert.equal(sjn.sin_cobertura, true)
  assert.equal(sjn.ciudad_reconocida, true)
  assert.deepEqual(sjn.opciones.map((o) => [o.courier, o.cobranza, o.valido]), [['pap', false, false]])
  // Ya pagado (pago anticipado): PaP sí sirve ahí.
  assert.equal(sugerirCourier('San Juan Nepomuceno', { cod: false }).sugerido, 'pap')

  assert.equal(sugerirCourier('Itaguá').sugerido, 'pap')
  assert.deepEqual(sugerirCourier('Itaguá'), { ...sugerirCourier('Itauguá'), ciudad: 'Itaguá' })
  assert.equal(sugerirCourier('Itaguá').opciones[0].precio, 26000)

  const fram = sugerirCourier('Fram')
  assert.equal(fram.sugerido, 'lucero')
  assert.equal(fram.opciones.find((o) => o.courier === 'pap').valido, false)

  assert.equal(sugerirCourier('Villarrica').sugerido, 'pap')
  assert.equal(sugerirCourier('Villarrica').opciones[0].precio, 31000)

  const inv = sugerirCourier('Pueblo Inventado')
  assert.equal(inv.sugerido, null)
  assert.equal(inv.sin_cobertura, true)
  assert.equal(inv.ciudad_reconocida, false)
  assert.deepEqual(inv.opciones.map((o) => [o.courier, o.estimado, o.valido]), [['pap', true, false]])
})

test('sin la vista de tasas: respaldo 85 Lucero / 75 PaP con "pocos datos"', () => {
  fijarTarifasCourier({ ...FIXTURE, tasas: [] })
  const s = sugerirCourier('Ciudad del Este')
  assert.deepEqual(s.opciones.map((o) => [o.courier, o.tasa, o.pocos_datos]), [['lucero', 85, true], ['pap', 75, true]])
  fijarTarifasCourier(FIXTURE)
})

test('textoSugerenciaCosto: la línea que se ve en Despacho', () => {
  fijarTarifasCourier(FIXTURE)
  assert.deepEqual(textoSugerenciaCosto(sugerirCourier('Cuidad del Este')), {
    texto: 'Sugerido por costo: Lucero · Lucero 24.000 ÷ 93% = 25.800 · PaP 31.000 ÷ 75% (pocos datos) = 41.300', nivel: 'ok' })
  const sjn = textoSugerenciaCosto(sugerirCourier('San Juan Nepomuceno'))
  assert.equal(sjn.nivel, 'sin_cobertura')
  assert.match(sjn.texto, /^Sin cobertura contra entrega · PaP no cobra contra entrega acá$/)
  assert.match(textoSugerenciaCosto(sugerirCourier('Fram')).texto, /^Sugerido por costo: Lucero · Lucero 39\.000 .* · PaP no cobra contra entrega acá$/)
  assert.equal(textoSugerenciaCosto(sugerirCourier('Pueblo Inventado')).nivel, 'desconocida')
  assert.match(textoSugerenciaCosto(sugerirCourier('San Juan Nepomuceno', { cod: false }), { cod: false }).texto, /^Sugerido por costo: PaP · PaP 36\.000/)
})

test('transportadoras.js con la tabla: flete real, estimado y bloqueo de PaP sin cobranza', () => {
  fijarTarifasCourier(FIXTURE)
  // Flete real por ciudad en vez del plano de Config.
  assert.equal(tarifaDe('pap', 'Villarrica'), 31000)
  assert.equal(tarifaDe('pap', 'Asunción'), 26000)
  assert.equal(fleteEstimado('pap', 'Villarrica'), false)
  // Ciudad fuera de la tabla: zona más cara, marcada como estimada.
  assert.deepEqual(tarifaDetalle('pap', 'Pueblo Inventado'), { precio: 36000, estimado: true })
  assert.equal(fleteEstimado('pap', 'Pueblo Inventado'), true)
  // Lucero: tabla primero; si no está, el tarifario de Config/fábrica.
  assert.deepEqual(tarifaDetalle('lucero', 'Ciudad del Este'), { precio: 24000, estimado: false })
  assert.equal(tarifaDe('lucero', 'Hernandarias'), 30000) // no está en la tabla de prueba → fábrica
  assert.equal(tarifaDe('otra', 'Asunción'), null)

  // Cobertura de PaP contra entrega = la tabla. Ya pagado: alcanza con que llegue.
  for (const c of ['San Juan Nepomuceno', 'Ayolas', 'Fram']) {
    assert.equal(cubre('pap', c), false, c)
    assert.equal(cubre('pap', c, { cod: false }), true, c)
  }
  assert.equal(cubre('pap', 'Itaguá'), true)
  // Fuera de la tabla → lista vieja de respaldo…
  assert.equal(cubre('pap', 'Guayaibi'), true)
  assert.equal(cubre('pap', 'Pueblo Inventado'), false)
  // …pero nunca true si la ciudad que reconoce la lista vieja está en la tabla sin cobranza (typo de SJN).
  assert.equal(cubre('pap', 'San Juan Nepomuseno'), false)
  assert.deepEqual(transportadorasDisponibles('San Juan Nepomuceno'), ['otra'])
  assert.deepEqual(transportadorasDisponibles('San Juan Nepomuceno', { cod: false }), ['pap', 'otra'])
})

test('sugerirTransportadora nunca preasigna PaP contra entrega donde PaP no cobra', () => {
  fijarTarifasCourier(FIXTURE)
  const prod = 'Limpiador de Lengua Facial Wellness'
  // San Juan Nepomuceno y Ayolas están en la lista oficial de PaP, pero PaP no cobra ahí y Lucero no llega.
  for (const c of ['San Juan Nepomuceno', 'Ayolas']) {
    const s = sugerirTransportadora(c, prod)
    assert.equal(s.transportadora, null, c)
    assert.equal(s.tarifa, null, c)
    // Ya pagado: va por PaP con su tarifa.
    const pagado = sugerirTransportadora(c, prod, { cod: false })
    assert.equal(pagado.transportadora, 'pap', c)
    assert.equal(pagado.tarifa, 36000, c)
  }
  // Fram: lista oficial Lucero; PaP sin cobranza no cambia nada.
  assert.equal(sugerirTransportadora('Fram', prod).transportadora, 'lucero')
  // Villarrica (lista oficial PaP): ahora con el flete de su ciudad, no el plano.
  const vr = sugerirTransportadora('Villarrica', prod)
  assert.deepEqual([vr.transportadora, vr.tarifa, vr.fleteEstimado], ['pap', 31000, false])
  // Ciudad desconocida que la lista vieja cubre: PaP con flete estimado por zona.
  const gy = sugerirTransportadora('Guayaibi', prod)
  assert.deepEqual([gy.transportadora, gy.tarifa, gy.fleteEstimado], ['pap', 36000, true])
  // Lucero por lista oficial: tarifa de la tabla.
  const cde = sugerirTransportadora('cde', prod)
  assert.deepEqual([cde.transportadora, cde.tarifa], ['lucero', 24000])
  fijarTarifasCourier(null)
})

test('21-10: producto "solo Lucero" (JawFlex): Lucero si llega; PaP con nota si Lucero no llega; sin cobertura si nadie cobra', () => {
  fijarTarifasCourier({
    ...FIXTURE,
    tarifas: [...FIXTURE.tarifas, fila('pap', 'pueblo de prueba', 'Pueblo de Prueba', 36000, { zona: 'INTERIOR 2' })],
  })
  const jaw = 'Ejercitador de mandibula JawFlex Pro'
  // Lucero llega: Lucero, sin nota (como hoy)
  const cde = sugerirTransportadora('Ciudad del Este', jaw)
  assert.deepEqual([cde.transportadora, !!cde.fallbackProducto], ['lucero', false])
  const fr = sugerirTransportadora('Fram', jaw)
  assert.deepEqual([fr.transportadora, !!fr.fallbackProducto], ['lucero', false])
  // Lucero no llega y PaP cobra: PaP solo, con la nota
  const pp = sugerirTransportadora('Pueblo de Prueba', jaw)
  assert.deepEqual([pp.transportadora, pp.fallbackProducto, pp.bloqueadoPorProducto, pp.tarifa], ['pap', true, false, 36000])
  assert.equal(pp.motivo, 'JawFlex por PaP: Lucero no llega')
  // Nadie cobra contra entrega (PaP sin cobranza, Lucero no llega): sin asignar → flujo de sin cobertura
  const sj = sugerirTransportadora('San Juan Nepomuceno', jaw)
  assert.deepEqual([sj.transportadora, !!sj.fallbackProducto, sj.bloqueadoPorProducto], [null, false, true])
  // Ya pagado (sin cobranza que cobrar): PaP llega aunque no cobre
  const sjPagado = sugerirTransportadora('San Juan Nepomuceno', jaw, { cod: false })
  assert.deepEqual([sjPagado.transportadora, sjPagado.fallbackProducto], ['pap', true])
  // Otro producto en la misma ciudad: igual que siempre, sin nota
  const tiras = sugerirTransportadora('Pueblo de Prueba', 'Tiras nasales')
  assert.deepEqual([tiras.transportadora, !!tiras.fallbackProducto], ['pap', false])
  fijarTarifasCourier(null)
})

test('26-10: regla preferir Lucero (config.courier_preferir_lucero) — Lucero donde es válido, si no el de siempre', () => {
  const ciudades = ['Cuidad del Este', 'Asunción, barrio Sajonia', 'San Juan Nepomuceno', 'Itaguá', 'Fram', 'Villarrica', 'Pueblo Inventado']
  for (const cod of [true, false]) {
    fijarTarifasCourier(FIXTURE)
    const antes = Object.fromEntries(ciudades.map((c) => [c, sugerirCourier(c, { cod })]))
    fijarTarifasCourier({ ...FIXTURE, preferirLucero: true })
    for (const c of ciudades) {
      const s = sugerirCourier(c, { cod })
      const luceroValido = s.opciones.some((o) => o.courier === 'lucero' && o.valido)
      assert.equal(s.sugerido, luceroValido ? 'lucero' : antes[c].sugerido, `${c} cod=${cod}`)
      assert.equal(s.regla, luceroValido ? 'preferir_lucero' : 'costo')
      assert.equal(s.sugerido_costo, antes[c].sugerido)
      // Cobertura, opciones y ciudad reconocida no cambian con la regla.
      assert.deepEqual([s.sin_cobertura, s.ciudad_reconocida, s.opciones], [antes[c].sin_cobertura, antes[c].ciudad_reconocida, antes[c].opciones])
    }
  }
  fijarTarifasCourier({ ...FIXTURE, preferirLucero: true })
  assert.equal(sugerirCourier('San Juan Nepomuceno').sugerido, null) // nadie cobra: sin cobertura como siempre
  assert.match(textoSugerenciaCosto(sugerirCourier('Cuidad del Este')).texto, /^Sugerido: Lucero, llega con cobranza · /)
  fijarTarifasCourier(FIXTURE)
})

// 29-10 (#1159): ciudad mal escrita → misma clave fonética que public.ciudad_fonetica (migración 20261029000002).
test('29-10: "Mbocayaty" → Lucero con cobranza; "Villa Rica" = Villarrica; "AsunciÓn"/"asuncion" reconocidas; "Casa" no', () => {
  fijarTarifasCourier({ ...FIXTURE, tarifas: [...FIXTURE.tarifas, fila('lucero', 'mbocajaty', 'Mbocajaty', 39000)] })
  const m = sugerirCourier('Mbocayaty')
  assert.equal(m.ciudad_reconocida, true)
  assert.equal(m.sin_cobertura, false)
  assert.equal(m.sugerido, 'lucero')
  assert.equal(m.opciones.find(o => o.courier === 'lucero').cobranza, true)
  assert.equal(sugerirCourier('  MBOCAYATY ').sugerido, 'lucero')
  assert.equal(filaTarifa('pap', 'Villa Rica')?.ciudad, 'villarrica')
  for (const c of ['AsunciÓn', 'asuncion', ' ASUNCION ', 'Ciudad Del Este']) assert.equal(sugerirCourier(c).ciudad_reconocida, true, c)
  assert.equal(sugerirCourier('Casa').ciudad_reconocida, false)
  // la fonética nunca gana a una coincidencia exacta o parcial
  assert.equal(filaTarifa('pap', 'Asunción, barrio Inventado')?.ciudad, 'asuncion')
  fijarTarifasCourier(FIXTURE)
})
