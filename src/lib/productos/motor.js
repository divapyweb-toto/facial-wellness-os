// src/lib/productos/motor.js
// ═══════════════════════════════════════════════════════════
// MOTOR FINANCIERO del módulo de inteligencia de productos (Voltra).
// ESM puro, sin dependencias, determinista: mismas entradas → misma salida.
// Ninguna función lee la red, la hora ni variables globales.
// Cada salida trae { version, entradas, ... } para guardarla tal cual en
// pi_escenarios_costo.resultado y poder recalcularla después.
//
// Dinero: guaraníes ENTEROS (PYG escala 0). Monedas extranjeras en unidades
// menores + tipo de cambio "1 <moneda> = X PYG" (ver dinero.js).
// Tasas y probabilidades: números entre 0 y 1.
// Redondeo: un solo redondeo al final de cada cifra (dinero.redondear,
// mitad lejos del cero). Los campos "...Exacta" van sin redondear, solo
// para conciliar contra el total de una cohorte.
//
// FÓRMULA COD DE VOLTRA (memoria formula-rentabilidad-cod):
//   el anuncio y el flete se pagan en TODOS los pedidos despachados,
//   se entreguen o no → NUNCA se multiplican por la tasa de entrega.
//   El producto de una entrega fallida vuelve al depósito (costo 0) salvo
//   que se diga lo contrario (recuperaFallida: false).
// Ramas mutuamente excluyentes de un pedido INICIADO (especificación §6):
//   cancelado (antes del despacho) · fallida (no se entregó) ·
//   entregado (y se quedó) · devuelto (se entregó y después se devolvió).
// Denominadores (ampliación A9): la especificación usa pedido INICIADO;
// Voltra decide por CONFIRMADO. El motor da las dos vistas, separadas, con
// la conversión explícita: adsPorConfirmado = adsPorIniciado / (1 − pctCancelado).
// ═══════════════════════════════════════════════════════════

import { convertirAPYG, escalaDe, redondear, aMenor, escalarTC } from './dinero.js'

export const MOTOR_VERSION = '1.0.0'
const TOL_SUMA = 1e-9

// ─────────────────────────── utilidades ───────────────────────────
function err(msg) { return new Error(`[motor] ${msg}`) }

function exigirNumero(v, nombre, { entero = false, min = 0, max = Infinity } = {}) {
  if (v == null || v === '') throw err(`Falta el dato crítico "${nombre}".`)
  if (typeof v !== 'number' || !Number.isFinite(v)) throw err(`"${nombre}" tiene que ser un número y llegó "${v}".`)
  if (entero && !Number.isInteger(v)) throw err(`"${nombre}" va en guaraníes enteros y llegó ${v}.`)
  if (v < min || v > max) throw err(`"${nombre}" = ${v} está fuera de rango (${min} a ${max}).`)
  return v
}

function exigirTasa(v, nombre) { return exigirNumero(v, nombre, { min: 0, max: 1 }) }

const clonar = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)))

// ─────────────────────── conversiones de denominador (A9) ───────────────────────
export function adsPorConfirmadoDesdeIniciado(adsPorIniciado, pctCancelado) {
  exigirNumero(adsPorIniciado, 'adsPorPedidoIniciado')
  exigirTasa(pctCancelado, 'pctCancelado')
  if (pctCancelado >= 1) throw err('Con 100% cancelado no hay confirmados: no existe costo por confirmado.')
  return adsPorIniciado / (1 - pctCancelado)
}

export function adsPorIniciadoDesdeConfirmado(adsPorConfirmado, pctCancelado) {
  exigirNumero(adsPorConfirmado, 'adsPorConfirmado')
  exigirTasa(pctCancelado, 'pctCancelado')
  return adsPorConfirmado * (1 - pctCancelado)
}

// ─────────────────────────── ramas ───────────────────────────
// Desde tasas como las mide Voltra:
//   confirmacion = confirmados ÷ iniciados
//   entrega      = entregados ÷ despachados (entregados + perdidos definitivos)
//   devolucion   = devueltos después de entregar ÷ entregados (0 si no hay dato)
export function ramasDesdeTasas({ confirmacion, entrega, devolucion = 0 } = {}) {
  exigirTasa(confirmacion, 'tasas.confirmacion')
  exigirTasa(entrega, 'tasas.entrega')
  exigirTasa(devolucion, 'tasas.devolucion')
  const entregadoTotal = confirmacion * entrega
  return {
    cancelado: 1 - confirmacion,
    fallida: confirmacion * (1 - entrega),
    entregado: entregadoTotal * (1 - devolucion),
    devuelto: entregadoTotal * devolucion,
  }
}

export function validarRamas(ramas) {
  if (!ramas || typeof ramas !== 'object') throw err('Faltan las ramas {cancelado, fallida, entregado, devuelto} (o las tasas).')
  const claves = ['cancelado', 'fallida', 'entregado', 'devuelto']
  for (const k of Object.keys(ramas)) if (!claves.includes(k)) throw err(`Rama desconocida "${k}". Las ramas son: ${claves.join(', ')}.`)
  for (const k of claves) exigirTasa(ramas[k], `ramas.${k}`)
  const suma = claves.reduce((s, k) => s + ramas[k], 0)
  if (Math.abs(suma - 1) > TOL_SUMA) {
    throw err(`Las ramas tienen que sumar 1 y suman ${suma.toFixed(6)} (cancelado ${ramas.cancelado}, fallida ${ramas.fallida}, entregado ${ramas.entregado}, devuelto ${ramas.devuelto}).`)
  }
  return ramas
}

// ─────────────────────────── costo puesto ───────────────────────────
// lineas: [{ concepto, monto_minor, moneda, tc_a_pyg, recuperable, desembolso,
//            factura_a_nombre_voltra?, incluido_en?, rango?, fuente?, fecha? }]
//  - recuperable: true = IVA de compra que se puede recuperar → es DESEMBOLSO
//    (sale caja) pero NO costo. Solo vale si factura_a_nombre_voltra === true
//    (ampliación A4: desde el 29-10 el stock va con factura a nombre de Voltra;
//    sin factura ese IVA no se recupera y la mercadería no se deduce del IRE).
//  - desembolso: false = costo económico que no sale caja ahora (ej. merma
//    valorizada, molde ya pagado). Por defecto true.
//  - incluido_en: "<concepto>" = la partida ya viene dentro de otra (ej. flete
//    incluido en el precio del proveedor). Se muestra y NO se suma (no se cobra dos veces).
//  - monto_minor null: dato desconocido. Con rango {min_minor, max_minor} el
//    resultado sale como rango; sin rango es un error (no se puede acotar).
export function costoPuesto(lineas, { unidadesCompradas, unidadesVendibles } = {}) {
  if (!Array.isArray(lineas) || lineas.length === 0) throw err('costoPuesto necesita al menos una línea de costo.')
  exigirNumero(unidadesCompradas, 'unidadesCompradas', { entero: true, min: 1 })
  exigirNumero(unidadesVendibles, 'unidadesVendibles', { entero: true, min: 1 })
  if (unidadesVendibles > unidadesCompradas) throw err(`Unidades vendibles (${unidadesVendibles}) no pueden ser más que las compradas (${unidadesCompradas}).`)

  const conceptos = new Set(lineas.map(l => l?.concepto))
  const avisos = []
  const desconocidos = []
  let costoMin = 0, costoMax = 0, desembolso = 0, ivaRecuperable = 0
  const detalle = lineas.map((l, i) => {
    if (!l || !l.concepto) throw err(`La línea ${i + 1} no tiene concepto.`)
    const moneda = l.moneda || 'PYG'
    escalaDe(moneda)
    const base = { concepto: l.concepto, moneda, monto_minor: l.monto_minor ?? null, tc_a_pyg: l.tc_a_pyg ?? (moneda === 'PYG' ? '1' : null), fuente: l.fuente ?? null, fecha: l.fecha ?? null }

    if (l.incluido_en) {
      if (!conceptos.has(l.incluido_en)) throw err(`"${l.concepto}" dice estar incluido en "${l.incluido_en}", pero esa línea no existe.`)
      return { ...base, pyg: 0, incluido_en: l.incluido_en, tratamiento: 'incluido en otra línea (no se suma)' }
    }

    let recuperable = !!l.recuperable
    if (recuperable && l.factura_a_nombre_voltra !== true) {
      recuperable = false
      avisos.push(l.factura_a_nombre_voltra === false
        ? `"${l.concepto}": sin factura a nombre de Voltra el IVA de compra NO se recupera (stock sin factura no deducible). Se cuenta como costo.`
        : `"${l.concepto}": falta confirmar factura a nombre de Voltra; hasta confirmarlo el IVA se cuenta como costo, no como recuperable.`)
    } else if (l.factura_a_nombre_voltra === false) {
      avisos.push(`"${l.concepto}": sin factura a nombre de Voltra (stock sin factura no deducible del IRE).`)
    }
    const esDesembolso = l.desembolso !== false

    if (l.monto_minor == null) {
      const r = l.rango
      if (!r || r.min_minor == null || r.max_minor == null) {
        throw err(`Falta el monto de "${l.concepto}" y no tiene rango {min_minor, max_minor}: es un costo crítico desconocido.`)
      }
      const min = convertirAPYG(r.min_minor, moneda, l.tc_a_pyg).pyg
      const max = convertirAPYG(r.max_minor, moneda, l.tc_a_pyg).pyg
      if (min > max) throw err(`Rango de "${l.concepto}" invertido (mínimo mayor que máximo).`)
      desconocidos.push({ concepto: l.concepto, minPYG: min, maxPYG: max })
      if (!recuperable) { costoMin += min; costoMax += max }
      if (esDesembolso || recuperable) desembolso += max
      return { ...base, pyg: null, rangoPYG: { min, max }, recuperable, desembolso: esDesembolso || recuperable, tratamiento: 'desconocido con rango' }
    }

    const { pyg } = convertirAPYG(l.monto_minor, moneda, l.tc_a_pyg)
    if (recuperable) { ivaRecuperable += pyg; desembolso += pyg }
    else {
      costoMin += pyg; costoMax += pyg
      if (esDesembolso) desembolso += pyg
    }
    return { ...base, pyg, recuperable, desembolso: esDesembolso || recuperable, tratamiento: recuperable ? 'IVA recuperable: desembolso, no costo' : (esDesembolso ? 'costo y desembolso' : 'costo sin desembolso') }
  })

  const merma = unidadesCompradas - unidadesVendibles
  const exacto = desconocidos.length === 0
  return {
    version: MOTOR_VERSION,
    tipo: 'costoPuesto',
    entradas: { lineas: clonar(lineas), unidadesCompradas, unidadesVendibles },
    totalPYG: exacto ? costoMin : null,
    porUnidadVendible: exacto ? redondear(costoMin / unidadesVendibles) : null,
    porUnidadComprada: exacto ? redondear(costoMin / unidadesCompradas) : null,
    rango: exacto ? null : {
      totalPYG: { min: costoMin, max: costoMax },
      porUnidadVendible: { min: redondear(costoMin / unidadesVendibles), max: redondear(costoMax / unidadesVendibles) },
    },
    desembolsoPYG: desembolso,
    ivaRecuperablePYG: ivaRecuperable,
    merma: { unidades: merma, pct: merma / unidadesCompradas },
    desconocidos,
    detalle,
    avisos,
  }
}

// ─────────────────────────── unidades, cajas y peso ───────────────────────────
export function unidadesDesdeCajas(cajas, unidadesPorCaja) {
  exigirNumero(cajas, 'cajas', { entero: true })
  exigirNumero(unidadesPorCaja, 'unidadesPorCaja', { entero: true, min: 1 })
  return cajas * unidadesPorCaja
}

export function cajasParaUnidades(unidades, unidadesPorCaja) {
  exigirNumero(unidades, 'unidades', { entero: true })
  exigirNumero(unidadesPorCaja, 'unidadesPorCaja', { entero: true, min: 1 })
  const cajas = Math.ceil(unidades / unidadesPorCaja)
  return { cajas, unidadesEnviadas: cajas * unidadesPorCaja, sobrante: cajas * unidadesPorCaja - unidades }
}

// Peso cobrable = el mayor entre el real y el volumétrico. El divisor lo da
// el transportista en su cotización: NO hay divisor universal (especificación §6).
export function pesoCobrable({ pesoBrutoG, medidasCm, divisor, cajas = 1 } = {}) {
  exigirNumero(pesoBrutoG, 'pesoBrutoG', { min: 0 })
  exigirNumero(cajas, 'cajas', { entero: true, min: 1 })
  const realKg = (pesoBrutoG * cajas) / 1000
  let volKg = null
  if (medidasCm != null) {
    if (!Array.isArray(medidasCm) || medidasCm.length !== 3) throw err('medidasCm va como [largo, ancho, alto] en cm.')
    medidasCm.forEach((m, i) => exigirNumero(m, `medidasCm[${i}]`, { min: 0 }))
    if (divisor == null) throw err('Para el peso volumétrico falta el divisor del transportista (sale de su cotización; no hay uno universal).')
    exigirNumero(divisor, 'divisor', { min: 1 })
    volKg = (medidasCm[0] * medidasCm[1] * medidasCm[2] * cajas) / divisor
  }
  return {
    version: MOTOR_VERSION,
    entradas: { pesoBrutoG, medidasCm: medidasCm ?? null, divisor: divisor ?? null, cajas },
    pesoRealKg: realKg,
    pesoVolumetricoKg: volKg,
    pesoCobrableKg: volKg == null ? realKg : Math.max(realKg, volKg),
    base: volKg != null && volKg > realKg ? 'volumetrico' : 'real',
  }
}

// Reparte un monto (PYG) de un lote mixto según una base documentada
// (peso, volumen, valor o unidades). Resto mayor: la suma da exacto el total.
export function asignarPorBase(montoPYG, items, base) {
  exigirNumero(montoPYG, 'montoPYG', { entero: true })
  if (!['peso', 'volumen', 'valor', 'unidades'].includes(base)) throw err(`Base de asignación "${base}" no válida: peso, volumen, valor o unidades.`)
  if (!Array.isArray(items) || !items.length) throw err('asignarPorBase necesita items.')
  const pesos = items.map((it, i) => exigirNumero(it?.[base], `items[${i}].${base}`))
  const total = pesos.reduce((a, b) => a + b, 0)
  if (total <= 0) throw err(`La base "${base}" suma 0: no se puede repartir.`)
  const crudos = pesos.map(p => (montoPYG * p) / total)
  const pisos = crudos.map(Math.floor)
  let resto = montoPYG - pisos.reduce((a, b) => a + b, 0)
  const orden = crudos.map((c, i) => ({ i, f: c - Math.floor(c) })).sort((a, b) => b.f - a.f || a.i - b.i)
  for (let k = 0; resto > 0; k++, resto--) pisos[orden[k % orden.length].i] += 1
  return items.map((it, i) => ({ id: it.id ?? i, base, valorBase: pesos[i], pyg: pisos[i] }))
}

// ─────────────────────────── plantillas de ruta (A6) ───────────────────────────
// Valores de REFERENCIA, editables, con fuente y fecha. Verificar antes de comprometer plata.
export const PLANTILLAS_RUTA = Object.freeze({
  avion_easybox: Object.freeze({
    id: 'avion_easybox',
    nombre: 'Avión · Easybox (China → CDE)',
    tarifa: Object.freeze({ monto: '38', moneda: 'USD', por: 'kg cobrable' }),
    fuente: 'Easybox avión: tarifa de referencia cargada por Enrique, verificar con la cotización vigente',
    fecha: '2026-11-18',
    estado: 'referencia 18-11, verificar',
    incluye: 'flete internacional hasta Easybox; no incluye flete interno en China ni retiro en CDE',
  }),
  barco_easybox: Object.freeze({
    id: 'barco_easybox',
    nombre: 'Barco · Easybox (China → CDE)',
    tarifa: null,
    fuente: 'sin tarifa validada (unknown): cargar la cotización vigente del forwarder',
    fecha: '2026-11-18',
    estado: 'desconocido',
    incluye: 'desconocido',
  }),
  local_cde: Object.freeze({
    id: 'local_cde',
    nombre: 'Compra local · mayorista CDE',
    tarifa: Object.freeze({ monto: '0', moneda: 'PYG', por: 'sin flete internacional' }),
    fuente: 'compra local: sin flete internacional; el traslado al depósito se carga aparte',
    fecha: '2026-11-18',
    estado: 'referencia 18-11, verificar',
    incluye: 'sin flete internacional',
  }),
})

// Devuelve la(s) línea(s) de flete de una ruta para costoPuesto.
// sobreescribir: { tarifa: {monto, moneda}, fuente, fecha } para editar la plantilla.
// La ruta sin tarifa (barco) devuelve una línea con monto null: si no se pasa
// un rango, costoPuesto la rechaza como costo crítico desconocido.
export function lineasDeRuta(idRuta, { pesoCobrableKg, tcAPyg, sobreescribir = {}, rango } = {}) {
  const p = PLANTILLAS_RUTA[idRuta]
  if (!p) throw err(`Ruta "${idRuta}" desconocida. Rutas: ${Object.keys(PLANTILLAS_RUTA).join(', ')}.`)
  const tarifa = sobreescribir.tarifa ?? p.tarifa
  const fuente = sobreescribir.fuente ?? p.fuente
  const fecha = sobreescribir.fecha ?? p.fecha
  const concepto = `Flete internacional (${p.nombre})`
  if (idRuta === 'local_cde' && !sobreescribir.tarifa) {
    return [{ concepto, monto_minor: 0, moneda: 'PYG', tc_a_pyg: '1', recuperable: false, desembolso: true, fuente, fecha, ruta: idRuta }]
  }
  if (!tarifa) {
    return [{ concepto, monto_minor: null, moneda: 'USD', tc_a_pyg: tcAPyg ?? null, recuperable: false, desembolso: true, fuente, fecha, ruta: idRuta, estado: 'desconocido', ...(rango ? { rango } : {}) }]
  }
  exigirNumero(pesoCobrableKg, 'pesoCobrableKg', { min: 0 })
  const tarifaMinor = aMenor(tarifa.monto, tarifa.moneda)
  return [{
    concepto,
    monto_minor: redondear(tarifaMinor * pesoCobrableKg),
    moneda: tarifa.moneda,
    tc_a_pyg: tarifa.moneda === 'PYG' ? '1' : (tcAPyg ?? null),
    recuperable: false,
    desembolso: true,
    fuente: `${fuente} · ${tarifa.monto} ${tarifa.moneda}/${p.tarifa?.por ?? 'kg'} × ${pesoCobrableKg} kg`,
    fecha,
    ruta: idRuta,
    estado: sobreescribir.tarifa ? 'editada' : p.estado,
  }]
}

// ─────────────────────── contribución por pedido ───────────────────────
// e = { precio, ivaPct, costoUnit, unidadesPorPedido, flete, costoBot,
//       ramas | tasas, recuperaFallida, perdidaDevuelto,
//       adsPorPedidoIniciado | adsPorConfirmado, contribucionObjetivo,
//       canceladoTrasConfirmar }
//  canceladoTrasConfirmar (0-1, opcional): de los confirmados de Voltra (definición de
//          pedidos_entrega), qué parte canceló DESPUÉS de confirmar y no salió. Con este dato
//          la tasa de confirmado de Voltra = (1 − cancelado) ÷ (1 − canceladoTrasConfirmar), y el
//          costo por confirmado de Voltra (tope ₲35.000) se convierte con ESA tasa y no con
//          1 − cancelado (que es la tasa de despacho, más baja): así no se subestiman los ads por
//          iniciado ni se infla la ganancia. Se expresa sobre confirmados para que siga valiendo
//          cuando un escenario cambia la confirmación.
//  precio: lo que cobra el courier al cliente por pedido, CON IVA incluido.
//  ivaPct: % de IVA incluido en el precio (10 en Voltra). El ingreso neto del
//          entregado es precio × 100 / (100 + ivaPct): el IVA es del Estado.
//          Solo nace en el entregado (el cancelado, la fallida y el devuelto no cobran).
//  costoUnit × unidadesPorPedido: mercadería consumida (unidadesPorPedido puede ser
//          un promedio, ej. 1,5).
//  flete: lo cobra el courier en todo pedido DESPACHADO (fallida y devuelto incluidos).
//  costoBot: costo de IA por pedido iniciado (todas las ramas).
//  perdidaDevuelto: lo que se pierde por cada devuelto (deterioro, traslado de vuelta).
//  contribucionObjetivo: por pedido iniciado (por defecto 0 = equilibrio).
export function contribucionPorPedido(e = {}) {
  const precio = exigirNumero(e.precio, 'precio', { entero: true })
  const ivaPct = exigirNumero(e.ivaPct, 'ivaPct', { max: 100 })
  const costoUnit = exigirNumero(e.costoUnit, 'costoUnit', { entero: true })
  const unidades = exigirNumero(e.unidadesPorPedido, 'unidadesPorPedido')
  if (unidades <= 0) throw err('unidadesPorPedido tiene que ser mayor que 0.')
  const flete = exigirNumero(e.flete, 'flete', { entero: true })
  if (typeof e.recuperaFallida !== 'boolean') throw err('Falta el dato crítico "recuperaFallida" (true si el producto de una entrega fallida vuelve vendible).')
  const avisos = []
  if (e.costoBot == null) avisos.push('costoBot no informado: se usó ₲0.')
  const costoBot = e.costoBot == null ? 0 : exigirNumero(e.costoBot, 'costoBot')
  const objetivo = e.contribucionObjetivo == null ? 0 : exigirNumero(e.contribucionObjetivo, 'contribucionObjetivo', { min: -Infinity })

  if (e.ramas && e.tasas) throw err('Pasá ramas O tasas, no las dos.')
  const ramas = validarRamas(e.ramas ? { ...e.ramas } : ramasDesdeTasas(e.tasas || {}))
  if (ramas.devuelto > 0 && e.perdidaDevuelto == null) avisos.push('perdidaDevuelto no informada con devoluciones > 0: se usó ₲0.')
  const perdidaDevuelto = e.perdidaDevuelto == null ? 0 : exigirNumero(e.perdidaDevuelto, 'perdidaDevuelto')
  const despachado = 1 - ramas.cancelado
  let confirmado = despachado, baseConfirmado = 'despacho'
  if (e.canceladoTrasConfirmar != null) {
    const q = exigirTasa(e.canceladoTrasConfirmar, 'canceladoTrasConfirmar')
    if (q >= 1) throw err('canceladoTrasConfirmar tiene que ser menor que 1 (100% cancelado después de confirmar = no sale ningún pedido).')
    if (despachado > 0) { confirmado = despachado / (1 - q); baseConfirmado = 'voltra' }
    if (confirmado > 1 + TOL_SUMA) throw err(`Con cancelado ${+ramas.cancelado.toFixed(6)} y canceladoTrasConfirmar ${q} la confirmación daría más de 100%: revisá las tasas.`)
    confirmado = Math.min(confirmado, 1)
  } else if (e.adsPorConfirmado != null) {
    avisos.push('Sin canceladoTrasConfirmar: el costo por confirmado se convierte con la tasa de despacho (1 − cancelado). Si el dato viene de Voltra (incluye confirmados que después cancelan), los ads por iniciado quedan bajos y la ganancia alta.')
  }

  // Ads: una sola fuente, convertida de forma explícita (A9). Nunca se restan dos veces.
  let adsIni = null, adsConf = null, adsOrigen = null
  if (e.adsPorPedidoIniciado != null && e.adsPorConfirmado != null) {
    throw err('Pasá adsPorPedidoIniciado O adsPorConfirmado, no los dos (se restaría la publicidad dos veces).')
  }
  if (e.adsPorPedidoIniciado != null) {
    adsIni = exigirNumero(e.adsPorPedidoIniciado, 'adsPorPedidoIniciado'); adsOrigen = 'iniciado'
    adsConf = confirmado > 0 ? adsPorConfirmadoDesdeIniciado(adsIni, 1 - confirmado) : null
  } else if (e.adsPorConfirmado != null) {
    adsConf = exigirNumero(e.adsPorConfirmado, 'adsPorConfirmado'); adsOrigen = 'confirmado'
    adsIni = adsPorIniciadoDesdeConfirmado(adsConf, 1 - confirmado)
  } else {
    avisos.push('Sin costo de anuncios: solo se calcula la contribución antes de ads y el máximo pagable.')
  }

  const ingresoNeto = (precio * 100) / (100 + ivaPct)
  const ivaDebito = precio - ingresoNeto
  const producto = costoUnit * unidades
  const defs = {
    cancelado: { ingreso: 0, producto: 0, flete: 0, bot: costoBot, perdida: 0 },
    fallida: { ingreso: 0, producto: e.recuperaFallida ? 0 : producto, flete, bot: costoBot, perdida: 0 },
    entregado: { ingreso: ingresoNeto, producto, flete, bot: costoBot, perdida: 0 },
    devuelto: { ingreso: 0, producto: 0, flete, bot: costoBot, perdida: perdidaDevuelto },
  }
  let antesExacta = 0
  const detalleRamas = Object.entries(defs).map(([rama, d]) => {
    const costos = d.producto + d.flete + d.bot + d.perdida
    const resultado = d.ingreso - costos
    const aporte = ramas[rama] * resultado
    antesExacta += aporte
    return {
      rama, probabilidad: ramas[rama],
      ingresoNeto: redondear(d.ingreso),
      costos: { producto: redondear(d.producto), flete: d.flete, bot: redondear(d.bot), perdida: d.perdida },
      resultado: redondear(resultado),
      aporte: redondear(aporte),
    }
  })
  const despuesExacta = adsIni == null ? null : antesExacta - adsIni
  const maxIni = antesExacta - objetivo
  const porConf = (x) => (x == null || confirmado <= 0 ? null : x / confirmado)
  const porEnt = (x) => (x == null || ramas.entregado <= 0 ? null : x / ramas.entregado)
  const r = (x) => (x == null ? null : redondear(x))

  return {
    version: MOTOR_VERSION,
    tipo: 'contribucionPorPedido',
    entradas: clonar({ ...e, ramas: e.ramas ?? null, tasas: e.tasas ?? null }),
    ramas: { ...ramas },
    detalleRamas,
    ingresoNetoEntregado: redondear(ingresoNeto),
    ivaDebitoEsperadoPorIniciado: redondear(ivaDebito * ramas.entregado),
    tasaEntregaSobreDespachados: despachado > 0 ? (ramas.entregado + ramas.devuelto) / despachado : null,
    adsOrigen,
    // Vista 1: por pedido INICIADO (denominador de la especificación)
    porIniciado: {
      denominador: 'pedido iniciado',
      contribucionAntesAds: redondear(antesExacta),
      ads: r(adsIni),
      contribucionDespuesAds: r(despuesExacta),
      costoAdsMaximo: redondear(maxIni),
      contribucionAntesAdsExacta: antesExacta,
      contribucionDespuesAdsExacta: despuesExacta,
    },
    // Vista 2: por pedido CONFIRMADO (como decide Voltra) = vista 1 ÷ tasa de confirmado
    // (tasaConfirmadoVoltra si viene; si no, 1 − cancelado = tasa de despacho, y se avisa)
    porConfirmado: {
      denominador: baseConfirmado === 'voltra' ? 'pedido confirmado (Voltra, incluye los que cancelan después)' : 'pedido despachado (sin tasa de confirmado de Voltra)',
      base: baseConfirmado,
      conversion: baseConfirmado === 'voltra'
        ? `÷ confirmación Voltra = (1 − cancelado) ÷ (1 − canceladoTrasConfirmar) = ÷ ${+confirmado.toFixed(6)}`
        : `÷ (1 − pctCancelado ${+ramas.cancelado.toFixed(6)}) = ÷ ${+confirmado.toFixed(6)}`,
      contribucionAntesAds: r(porConf(antesExacta)),
      ads: r(adsConf),
      contribucionDespuesAds: r(porConf(despuesExacta)),
      costoAdsMaximo: r(porConf(maxIni)),
    },
    // Vista 3: por pedido ENTREGADO (CPA real de Enrique: ads ÷ entregados)
    porEntregado: {
      denominador: 'pedido entregado y retenido',
      ads: r(porEnt(adsIni)),
      costoAdsMaximo: r(porEnt(maxIni)),
    },
    contribucionObjetivo: objetivo,
    nota: 'Contribución, no utilidad neta: no descuenta gastos fijos, IRE ni sueldo.',
    avisos,
  }
}

// ─────────────────────── cohorte real (conciliación) ───────────────────────
// pedidos: [{ rama, precio, costoProducto, flete, costoBot, perdida }]
//   costoProducto = mercadería consumida o perdida en ESE pedido (0 si volvió).
// Devuelve totales realizados y las ramas observadas, para comparar con el motor.
export function contribucionCohorte(pedidos, { ivaPct, gastoAds = null } = {}) {
  if (!Array.isArray(pedidos) || !pedidos.length) throw err('La cohorte está vacía.')
  exigirNumero(ivaPct, 'ivaPct', { max: 100 })
  const cuenta = { cancelado: 0, fallida: 0, entregado: 0, devuelto: 0 }
  let ingreso = 0, costos = 0
  pedidos.forEach((p, i) => {
    if (!(p?.rama in cuenta)) throw err(`Pedido ${i + 1}: rama "${p?.rama}" desconocida.`)
    cuenta[p.rama]++
    if (p.rama === 'entregado') ingreso += (exigirNumero(p.precio, `pedidos[${i}].precio`, { entero: true }) * 100) / (100 + ivaPct)
    costos += (p.costoProducto || 0) + (p.flete || 0) + (p.costoBot || 0) + (p.perdida || 0)
  })
  const n = pedidos.length
  const antes = ingreso - costos
  return {
    version: MOTOR_VERSION,
    tipo: 'contribucionCohorte',
    entradas: { pedidos: n, ivaPct, gastoAds },
    pedidosIniciados: n,
    ramas: Object.fromEntries(Object.entries(cuenta).map(([k, v]) => [k, v / n])),
    conteo: cuenta,
    ingresoNetoTotal: redondear(ingreso),
    costosVariablesTotal: redondear(costos),
    contribucionAntesAdsTotal: redondear(antes),
    contribucionDespuesAdsTotal: gastoAds == null ? null : redondear(antes - gastoAds),
    contribucionAntesAdsTotalExacta: antes,
  }
}

// ─────────────────────── evaluación completa, escenarios, sensibilidad ───────────────────────
// entradas = las de contribucionPorPedido + opcional lote: { lineas, unidadesCompradas,
// unidadesVendibles } (el costoUnit sale del costo puesto) y usarRango: 'min'|'max'
// cuando el costo puesto tiene partidas desconocidas con rango.
export function evaluar(entradas) {
  const e = clonar(entradas) || {}
  let cp = null
  if (e.lote) {
    cp = costoPuesto(e.lote.lineas, e.lote)
    if (cp.porUnidadVendible != null) e.costoUnit = cp.porUnidadVendible
    else if (e.usarRango === 'min' || e.usarRango === 'max') e.costoUnit = cp.rango.porUnidadVendible[e.usarRango]
    else throw err(`El costo puesto tiene partidas desconocidas (${cp.desconocidos.map(d => d.concepto).join(', ')}): indicá usarRango 'min' o 'max'.`)
  }
  const { lote, usarRango, nombre, fuentes, ...paraContribucion } = e
  const c = contribucionPorPedido(paraContribucion)
  return { version: MOTOR_VERSION, tipo: 'evaluacion', entradas: clonar(entradas), costoPuesto: cp, contribucion: c }
}

// Aplica sobreescrituras a unas entradas: claves de primer nivel reemplazan;
// "tasas" y "lote" se mezclan; "tc" = { USD: '7600' } cambia el tipo de
// cambio de todas las líneas del lote en esa moneda.
export function aplicarCambios(base, cambios = {}) {
  const out = clonar(base)
  for (const [k, v] of Object.entries(cambios || {})) {
    if (k === 'nombre' || k === 'fuentes') continue
    if (k === 'tasas') {
      if (out.ramas) throw err('El escenario base usa ramas: para cambiar tasas, la base tiene que usar tasas.')
      out.tasas = { ...(out.tasas || {}), ...v }
    } else if (k === 'ramas') {
      out.ramas = { ...v }; delete out.tasas
    } else if (k === 'lote') {
      if (!out.lote) throw err('El escenario cambia el lote pero la base no tiene lote.')
      out.lote = { ...out.lote, ...v }
    } else if (k === 'tc') {
      if (!out.lote) throw err('Cambiar el tipo de cambio requiere un lote en la base.')
      out.lote.lineas = out.lote.lineas.map(l => (v[l.moneda || 'PYG'] != null && (l.moneda || 'PYG') !== 'PYG') ? { ...l, tc_a_pyg: String(v[l.moneda]) } : l)
    } else if (k === 'adsPorPedidoIniciado' || k === 'adsPorConfirmado') {
      delete out.adsPorPedidoIniciado; delete out.adsPorConfirmado
      out[k] = v
    } else out[k] = v
  }
  return out
}

function resumen(ev) {
  const c = ev.contribucion
  return {
    costoUnit: ev.costoPuesto ? (ev.costoPuesto.porUnidadVendible ?? null) : c.entradas.costoUnit,
    porIniciado: { antesAds: c.porIniciado.contribucionAntesAds, despuesAds: c.porIniciado.contribucionDespuesAds, adsMaximo: c.porIniciado.costoAdsMaximo },
    porConfirmado: { antesAds: c.porConfirmado.contribucionAntesAds, despuesAds: c.porConfirmado.contribucionDespuesAds, adsMaximo: c.porConfirmado.costoAdsMaximo },
  }
}

// escenarios(base, { adverso, favorable }) → cada uno con entradas completas,
// fuentes y diferencia contra la base. Nunca se rotula "realista": son
// hipótesis configurables, no probabilidades.
export function escenarios(base, { adverso, favorable } = {}) {
  if (!adverso || !favorable) throw err('Faltan los cambios del escenario adverso y/o favorable.')
  const evBase = evaluar(base)
  const armar = (nombre, cambios) => {
    const ent = cambios === null ? clonar(base) : aplicarCambios(base, cambios)
    const ev = cambios === null ? evBase : evaluar(ent)
    const rb = resumen(evBase), rr = resumen(ev)
    const dif = (a, b) => (a == null || b == null ? null : a - b)
    return {
      nombre,
      fuentes: (cambios && cambios.fuentes) || (nombre === 'base' ? base.fuentes ?? null : null),
      cambios: cambios ? clonar(cambios) : null,
      entradas: ent,
      resultado: ev,
      resumen: rr,
      diferenciaVsBase: {
        porIniciadoDespuesAds: dif(rr.porIniciado.despuesAds, rb.porIniciado.despuesAds),
        porConfirmadoDespuesAds: dif(rr.porConfirmado.despuesAds, rb.porConfirmado.despuesAds),
      },
    }
  }
  return {
    version: MOTOR_VERSION,
    tipo: 'escenarios',
    entradas: clonar({ base, adverso, favorable }),
    nota: 'Escenarios = hipótesis configurables, no probabilidades calibradas.',
    base: armar('base', null),
    adverso: armar('adverso', adverso),
    favorable: armar('favorable', favorable),
  }
}

const VARIABLES_NUMERICAS = ['precio', 'costoUnit', 'flete', 'costoBot', 'perdidaDevuelto', 'unidadesPorPedido', 'adsPorPedidoIniciado', 'adsPorConfirmado']
const VARIABLES_ENTERAS = new Set(['precio', 'costoUnit', 'flete'])

// sensibilidad(base, variables, pasos): pasos relativos (ej. [-0.2, -0.1, 0.1, 0.2]).
// Variables: precio, costoUnit, flete, costoBot, perdidaDevuelto, unidadesPorPedido,
// adsPorPedidoIniciado, adsPorConfirmado, tasas.confirmacion, tasas.entrega,
// tasas.devolucion, tc:USD / tc:CNY, lote.unidadesVendibles.
export function sensibilidad(base, variables, pasos) {
  if (!Array.isArray(variables) || !variables.length) throw err('sensibilidad necesita variables.')
  if (!Array.isArray(pasos) || !pasos.length) throw err('sensibilidad necesita pasos (ej. [-0.2, -0.1, 0.1, 0.2]).')
  pasos.forEach((p, i) => exigirNumero(p, `pasos[${i}]`, { min: -1 }))
  const ref = resumen(evaluar(base))
  const filas = []
  for (const v of variables) {
    for (const paso of pasos) {
      let cambios, valor, recortado = false
      if (VARIABLES_NUMERICAS.includes(v)) {
        const actual = base[v]
        if (actual == null) throw err(`La variable "${v}" no está en la base (o el costo sale del lote: usá tc:<moneda> o lote.unidadesVendibles).`)
        valor = actual * (1 + paso)
        if (VARIABLES_ENTERAS.has(v)) valor = redondear(valor)
        cambios = { [v]: valor }
      } else if (v.startsWith('tasas.')) {
        if (!base.tasas) throw err(`"${v}" requiere que la base use tasas (no ramas).`)
        const k = v.slice(6)
        if (!['confirmacion', 'entrega', 'devolucion'].includes(k)) throw err(`Tasa desconocida "${k}".`)
        valor = (base.tasas[k] ?? 0) * (1 + paso)
        if (valor > 1) { valor = 1; recortado = true }
        if (valor < 0) { valor = 0; recortado = true }
        cambios = { tasas: { [k]: valor } }
      } else if (v.startsWith('tc:')) {
        const moneda = v.slice(3)
        const linea = base.lote?.lineas?.find(l => l.moneda === moneda)
        if (!linea) throw err(`No hay líneas en ${moneda} en el lote para variar su tipo de cambio.`)
        valor = escalarTC(linea.tc_a_pyg, (1 + paso).toFixed(6))
        cambios = { tc: { [moneda]: valor } }
      } else if (v === 'lote.unidadesVendibles') {
        if (!base.lote) throw err('lote.unidadesVendibles requiere lote en la base.')
        valor = Math.min(base.lote.unidadesCompradas, Math.max(1, redondear(base.lote.unidadesVendibles * (1 + paso))))
        cambios = { lote: { unidadesVendibles: valor } }
      } else if (v.startsWith('ramas.')) {
        throw err(`"${v}": las ramas no se varían de a una (dejarían de sumar 1). Usá tasas.confirmacion / tasas.entrega / tasas.devolucion.`)
      } else throw err(`Variable de sensibilidad desconocida: "${v}".`)
      const rr = resumen(evaluar(aplicarCambios(base, cambios)))
      filas.push({
        variable: v, paso, valor, recortado,
        porIniciadoDespuesAds: rr.porIniciado.despuesAds,
        porConfirmadoDespuesAds: rr.porConfirmado.despuesAds,
        porIniciadoAntesAds: rr.porIniciado.antesAds,
        deltaPorIniciado: (rr.porIniciado.despuesAds ?? rr.porIniciado.antesAds) - (ref.porIniciado.despuesAds ?? ref.porIniciado.antesAds),
      })
    }
  }
  const impacto = variables.map(v => ({
    variable: v,
    maxDeltaAbs: Math.max(...filas.filter(f => f.variable === v).map(f => Math.abs(f.deltaPorIniciado))),
  })).sort((a, b) => b.maxDeltaAbs - a.maxDeltaAbs || a.variable.localeCompare(b.variable))
  return { version: MOTOR_VERSION, tipo: 'sensibilidad', entradas: clonar({ base, variables, pasos }), referencia: ref, filas, impacto }
}

// ─────────────────────────── caja ───────────────────────────
// Cada categoría de salida: número (una salida en el día calendario.dias[cat] o 0)
// o lista [{ dia, monto, concepto? }]. Montos de salida en positivo (PYG enteros).
// Entradas de plata: calendario.cobros [{ dia, monto }]. saldoInicial opcional (0).
// Devuelve necesidad de caja (= pico negativo en positivo), día del pico y día
// en que el saldo vuelve a ≥ 0. Sin anualizar: el horizonte es el que se cargó.
const CATEGORIAS_CAJA = ['muestras', 'primerLote', 'tributos', 'publicidad', 'logistica', 'devoluciones', 'reposicion']

export function caja(entrada = {}) {
  const cal = entrada.calendario || {}
  const movimientos = []
  const totales = {}
  const agregar = (cat, item, signo) => {
    const dia = exigirNumero(item.dia, `${cat}.dia`, { entero: true })
    const monto = exigirNumero(item.monto, `${cat}.monto`, { entero: true })
    movimientos.push({ dia, categoria: cat, concepto: item.concepto ?? cat, monto: signo * monto })
    totales[cat] = (totales[cat] || 0) + monto
  }
  for (const cat of CATEGORIAS_CAJA) {
    const v = entrada[cat]
    if (v == null) continue
    if (typeof v === 'number') agregar(cat, { dia: cal.dias?.[cat] ?? 0, monto: v }, -1)
    else if (Array.isArray(v)) v.forEach(it => agregar(cat, it, -1))
    else throw err(`"${cat}" va como número o lista de {dia, monto}.`)
  }
  for (const k of Object.keys(entrada)) if (![...CATEGORIAS_CAJA, 'calendario'].includes(k)) throw err(`Categoría de caja desconocida "${k}".`)
  ;(cal.cobros || []).forEach(it => agregar('cobros', it, +1))
  if (!movimientos.length) throw err('caja necesita al menos un movimiento.')

  const saldoInicial = cal.saldoInicial == null ? 0 : exigirNumero(cal.saldoInicial, 'saldoInicial', { entero: true, min: -Infinity })
  // Orden estable: por día; dentro del día se respeta el orden de carga.
  movimientos.forEach((m, i) => { m._i = i })
  movimientos.sort((a, b) => a.dia - b.dia || a._i - b._i)
  movimientos.forEach(m => { delete m._i })
  const dias = [...new Set(movimientos.map(m => m.dia))]
  // Dentro de un día se suman entradas y salidas antes de mirar el saldo
  // (granularidad diaria: no se inventa la hora de cada movimiento).
  let saldo = saldoInicial
  let minimo = saldoInicial, diaPico = null
  const porDia = dias.map(d => {
    const del = movimientos.filter(m => m.dia === d)
    const ent = del.filter(m => m.monto > 0).reduce((s, m) => s + m.monto, 0)
    const sal = -del.filter(m => m.monto < 0).reduce((s, m) => s + m.monto, 0)
    saldo += ent - sal
    if (saldo < minimo) { minimo = saldo; diaPico = d }
    return { dia: d, entradas: ent, salidas: sal, saldo }
  })
  // Recupera = el saldo vuelve a ser ≥ al inicial después del pico.
  let diaRecuperacion = null
  if (diaPico != null) {
    const f = porDia.find(x => x.dia > diaPico && x.saldo >= saldoInicial)
    diaRecuperacion = f ? f.dia : null
  }
  const salidas = CATEGORIAS_CAJA.reduce((s, c) => s + (totales[c] || 0), 0)
  const primerDia = dias[0]
  return {
    version: MOTOR_VERSION,
    tipo: 'caja',
    entradas: clonar(entrada),
    movimientos,
    porDia,
    totales: { ...totales, salidas, entradas: totales.cobros || 0, neto: (totales.cobros || 0) - salidas },
    saldoInicial,
    saldoMinimo: minimo,
    picoNegativo: Math.min(0, minimo - saldoInicial), // cuánto llegó a bajar respecto del inicio (≤ 0)
    necesidadCaja: Math.max(0, -minimo),               // plata que falta poner para no quedar en rojo
    diaPico,
    diaRecuperacion,
    recupera: diaPico == null || diaRecuperacion != null,
    diasRecuperacion: diaRecuperacion == null ? null : diaRecuperacion - primerDia,
    saldoFinal: saldo,
    nota: 'Sin anualizar: días medidos dentro del horizonte cargado. Si no recupera dentro de ese horizonte, diaRecuperacion = null.',
  }
}

// Genera los flujos de un piloto (valores esperados) para pasarlos a caja().
// Cobro de cada entregado a los diasHastaCobro (rendición del courier);
// publicidad y bot el día del pedido; flete el día de despacho (diasHastaFlete).
export function flujoPiloto({ desdeDia = 0, dias, pedidosIniciadosPorDia, ramas, tasas, precio, flete, adsPorPedidoIniciado = 0, costoBot = 0, diasHastaCobro, diasHastaFlete = 0 } = {}) {
  exigirNumero(dias, 'dias', { entero: true, min: 1 })
  exigirNumero(pedidosIniciadosPorDia, 'pedidosIniciadosPorDia')
  exigirNumero(precio, 'precio', { entero: true })
  exigirNumero(flete, 'flete', { entero: true })
  exigirNumero(diasHastaCobro, 'diasHastaCobro', { entero: true })
  const rr = validarRamas(ramas ? { ...ramas } : ramasDesdeTasas(tasas || {}))
  const despachados = pedidosIniciadosPorDia * (1 - rr.cancelado)
  const cobros = [], publicidad = [], logistica = []
  for (let i = 0; i < dias; i++) {
    const d = desdeDia + i
    const ads = redondear(pedidosIniciadosPorDia * (adsPorPedidoIniciado + costoBot))
    if (ads) publicidad.push({ dia: d, monto: ads, concepto: 'anuncios + bot' })
    const fl = redondear(despachados * flete)
    if (fl) logistica.push({ dia: d + diasHastaFlete, monto: fl, concepto: 'flete' })
    const cob = redondear(pedidosIniciadosPorDia * rr.entregado * precio)
    if (cob) cobros.push({ dia: d + diasHastaCobro, monto: cob, concepto: 'cobro de entregados' })
  }
  return { publicidad, logistica, cobros }
}
