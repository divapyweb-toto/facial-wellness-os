// src/pages/productos/calculo.js
// Puente entre el formulario de Rentabilidad (textos) y el motor financiero
// (src/lib/productos/motor.js, enteros y tasas 0-1). Puro: sin React ni base.
// La UI nunca calcula plata por su cuenta: todo pasa por el motor.
import { escenarios, sensibilidad, caja, flujoPiloto, lineasDeRuta, PLANTILLAS_RUTA } from '../../lib/productos/motor'
import { aMinor } from './formato'

export { PLANTILLAS_RUTA }

const num = (t) => {
  if (t === null || t === undefined || String(t).trim() === '') return null
  const n = Number(String(t).replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const numDec = (t) => {
  // para tasas/pesos con decimales: acepta "1,5" y "1.5"
  if (t === null || t === undefined || String(t).trim() === '') return null
  const n = Number(String(t).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const gs = (t) => aMinor(t, 'PYG')
const pct = (t) => { const n = numDec(t); return n == null ? null : n / 100 }
const tcTexto = (t) => (t === null || t === undefined || String(t).trim() === '' ? null : String(t).trim().replace(',', '.'))

// Estado inicial del formulario (todo texto, como lo tipea Enrique).
export function formularioVacio() {
  return {
    nombre: 'base',
    usarLote: true,
    lineas: [
      { concepto: 'Mercadería', monto: '', moneda: 'USD', tc: '', recuperable: false, desembolso: true, factura_a_nombre_voltra: true, incluido_en: '', fuente: '', fecha: '', rangoMin: '', rangoMax: '' },
    ],
    unidadesCompradas: '', unidadesVendibles: '', costoUnitDirecto: '', usarRango: 'max',
    precio: '', ivaPct: '10', unidadesPorPedido: '1', flete: '', costoBot: '',
    confirmacion: '', entrega: '', devolucion: '0', recuperaFallida: true, perdidaDevuelto: '',
    canceladoTrasConfirmar: '',
    adsDenominador: 'confirmado', ads: '', contribucionObjetivo: '0',
    fuentes: '',
    adverso: { precio: '', ads: '', confirmacion: '', entrega: '', flete: '', tcUSD: '', fuentes: '' },
    favorable: { precio: '', ads: '', confirmacion: '', entrega: '', flete: '', tcUSD: '', fuentes: '' },
    sensVars: ['precio', 'ads', 'tasas.confirmacion', 'tasas.entrega', 'flete'],
    sensPasos: '-20, -10, 10, 20',
    caja: {
      muestras: '', muestrasDia: '0', primerLote: '', primerLoteDia: '0', tributos: '', tributosDia: '0',
      logistica: '', logisticaDia: '0', devoluciones: '', devolucionesDia: '0', reposicion: '', reposicionDia: '0',
      publicidad: '', publicidadDia: '0',
      pilotoDesde: '', pilotoDias: '', pilotoPedidosDia: '', diasHastaCobro: '7', diasHastaFlete: '1',
    },
    semaforoCaja: 'DESCONOCIDO',
  }
}

// Formulario → entradas del motor (evaluar/escenarios). Tira error legible si falta algo.
export function armarEntradasBase(f) {
  const e = {
    nombre: f.nombre || 'base',
    precio: gs(f.precio),
    ivaPct: numDec(f.ivaPct),
    unidadesPorPedido: numDec(f.unidadesPorPedido),
    flete: gs(f.flete),
    costoBot: f.costoBot === '' ? null : gs(f.costoBot),
    tasas: { confirmacion: pct(f.confirmacion), entrega: pct(f.entrega), devolucion: pct(f.devolucion) ?? 0 },
    recuperaFallida: !!f.recuperaFallida,
    perdidaDevuelto: f.perdidaDevuelto === '' ? null : gs(f.perdidaDevuelto),
    contribucionObjetivo: gs(f.contribucionObjetivo) ?? 0,
    fuentes: f.fuentes || null,
  }
  const q = pct(f.canceladoTrasConfirmar ?? '')
  if (q != null) e.canceladoTrasConfirmar = q
  const ads = gs(f.ads)
  if (ads != null) {
    if (f.adsDenominador === 'iniciado') e.adsPorPedidoIniciado = ads
    else e.adsPorConfirmado = ads
  }
  if (f.usarLote) {
    e.lote = {
      unidadesCompradas: num(f.unidadesCompradas),
      unidadesVendibles: num(f.unidadesVendibles),
      lineas: f.lineas.filter(l => l.concepto?.trim()).map(l => {
        const linea = {
          concepto: l.concepto.trim(),
          monto_minor: aMinor(l.monto, l.moneda),
          moneda: l.moneda,
          tc_a_pyg: l.moneda === 'PYG' ? '1' : tcTexto(l.tc),
          recuperable: !!l.recuperable,
          desembolso: l.desembolso !== false,
          factura_a_nombre_voltra: l.factura_a_nombre_voltra,
          fuente: l.fuente || null,
          fecha: l.fecha || null,
        }
        if (l.incluido_en?.trim()) linea.incluido_en = l.incluido_en.trim()
        if (linea.monto_minor == null && (l.rangoMin || l.rangoMax)) {
          linea.rango = { min_minor: aMinor(l.rangoMin, l.moneda), max_minor: aMinor(l.rangoMax, l.moneda) }
        }
        return linea
      }),
    }
    e.usarRango = f.usarRango || 'max'
  } else {
    e.costoUnit = gs(f.costoUnitDirecto)
  }
  return e
}

function cambiosEscenario(s, f) {
  const c = {}
  if (s.precio !== '') c.precio = gs(s.precio)
  if (s.flete !== '') c.flete = gs(s.flete)
  if (s.ads !== '') c[f.adsDenominador === 'iniciado' ? 'adsPorPedidoIniciado' : 'adsPorConfirmado'] = gs(s.ads)
  const tasas = {}
  if (s.confirmacion !== '') tasas.confirmacion = pct(s.confirmacion)
  if (s.entrega !== '') tasas.entrega = pct(s.entrega)
  if (Object.keys(tasas).length) c.tasas = tasas
  if (s.tcUSD !== '' && f.usarLote) c.tc = { USD: tcTexto(s.tcUSD) }
  if (s.fuentes) c.fuentes = s.fuentes
  return c
}

// Variables de sensibilidad del formulario → nombres del motor.
function variablesSens(f, base) {
  const out = []
  for (const v of f.sensVars || []) {
    if (v === 'ads') {
      if (base.adsPorPedidoIniciado != null) out.push('adsPorPedidoIniciado')
      else if (base.adsPorConfirmado != null) out.push('adsPorConfirmado')
    } else if (v === 'costoUnit') {
      if (base.lote) out.push('lote.unidadesVendibles'); else out.push('costoUnit')
    } else if (v.startsWith('tc:')) {
      if (base.lote?.lineas?.some(l => l.moneda === v.slice(3))) out.push(v)
    } else out.push(v)
  }
  return [...new Set(out)]
}

// Caja: salidas fijas con su día + flujos del piloto (flujoPiloto) → caja().
export function armarEntradaCaja(f, base, ramasBase) {
  const c = f.caja || {}
  const entrada = { calendario: { dias: {}, cobros: [] } }
  const fijo = (cat) => {
    const m = gs(c[cat])
    if (m != null && m > 0) entrada[cat] = [{ dia: num(c[`${cat}Dia`]) ?? 0, monto: m, concepto: cat }]
  }
  ;['muestras', 'primerLote', 'tributos', 'logistica', 'devoluciones', 'reposicion', 'publicidad'].forEach(fijo)
  const dias = num(c.pilotoDias), ped = numDec(c.pilotoPedidosDia)
  if (dias && ped && base.precio != null && base.flete != null) {
    const ads = base.adsPorPedidoIniciado != null ? base.adsPorPedidoIniciado
      : base.adsPorConfirmado != null && ramasBase ? Math.round(base.adsPorConfirmado * (1 - ramasBase.cancelado)) : 0
    const fl = flujoPiloto({
      desdeDia: num(c.pilotoDesde) ?? 0, dias, pedidosIniciadosPorDia: ped,
      ramas: ramasBase || undefined, tasas: ramasBase ? undefined : base.tasas,
      precio: base.precio, flete: base.flete, adsPorPedidoIniciado: ads, costoBot: base.costoBot || 0,
      diasHastaCobro: num(c.diasHastaCobro) ?? 7, diasHastaFlete: num(c.diasHastaFlete) ?? 0,
    })
    if (fl.publicidad.length) entrada.publicidad = [...(entrada.publicidad || []), ...fl.publicidad]
    if (fl.logistica.length) entrada.logistica = [...(entrada.logistica || []), ...fl.logistica]
    entrada.calendario.cobros = fl.cobros
  }
  return entrada
}

// Corre todo. Devuelve { ok, resultado, errores } — cada parte con su error
// separado, para que un dato faltante en caja no tape los escenarios.
export function calcularTodo(f) {
  const errores = {}
  let base = null, esc = null, sens = null, cj = null
  try { base = armarEntradasBase(f) } catch (e) { errores.entradas = e.message }
  if (base) {
    try {
      esc = escenarios(base, { adverso: cambiosEscenario(f.adverso, f), favorable: cambiosEscenario(f.favorable, f) })
    } catch (e) { errores.escenarios = limpiar(e.message) }
  }
  if (base && esc) {
    try {
      const vars = variablesSens(f, base)
      const pasos = String(f.sensPasos || '').split(/[;\s,]+/).map(x => numDec(x)).filter(x => x != null).map(x => x / 100)
      if (vars.length && pasos.length) sens = sensibilidad(base, vars, pasos)
    } catch (e) { errores.sensibilidad = limpiar(e.message) }
  }
  if (base) {
    try {
      const ramas = esc?.base?.resultado?.contribucion?.ramas || null
      const entrada = armarEntradaCaja(f, base, ramas)
      const hay = Object.keys(entrada).some(k => k !== 'calendario') || entrada.calendario.cobros.length
      if (hay) cj = caja(entrada)
    } catch (e) { errores.caja = limpiar(e.message) }
  }
  const resultado = esc ? { resumen: resumir(esc, cj), escenarios: esc, sensibilidad: sens, caja: cj, semaforoCaja: f.semaforoCaja } : null
  return { base, resultado, errores }
}

const limpiar = (m) => String(m || '').replace(/^\[motor\]\s*/, '')

// Resumen con nombres propios de la UI (se guarda en resultado.resumen).
// Denominador explícito en cada cifra (ampliación A9).
function resumir(esc, cj) {
  const c = esc.base.resultado.contribucion
  const cp = esc.base.resultado.costoPuesto
  return {
    costoUnit: cp ? (cp.porUnidadVendible ?? null) : c.entradas.costoUnit,
    costoUnitRango: cp?.rango?.porUnidadVendible || null,
    contribAntesAdsIniciado: c.porIniciado.contribucionAntesAds,
    contribDespuesAdsIniciado: c.porIniciado.contribucionDespuesAds,
    adsMaxIniciado: c.porIniciado.costoAdsMaximo,
    contribAntesAdsConfirmado: c.porConfirmado.contribucionAntesAds,
    contribDespuesAdsConfirmado: c.porConfirmado.contribucionDespuesAds,
    adsMaxConfirmado: c.porConfirmado.costoAdsMaximo,
    adsMaxEntregado: c.porEntregado.costoAdsMaximo,
    adversoDespuesAdsConfirmado: esc.adverso.resumen.porConfirmado.despuesAds,
    favorableDespuesAdsConfirmado: esc.favorable.resumen.porConfirmado.despuesAds,
    cajaNecesaria: cj ? cj.necesidadCaja : null,
    diasRecuperacion: cj ? cj.diasRecuperacion : null,
    recupera: cj ? cj.recupera : null,
    desembolsoLote: cp ? cp.desembolsoPYG : null,
  }
}

// Lee el resumen guardado de un escenario (tolera resultados viejos o vacíos).
export function resumenDeEscenario(resultado) {
  const r = resultado?.resumen || {}
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    contribDespuesAdsIniciado: n(r.contribDespuesAdsIniciado),
    contribDespuesAdsConfirmado: n(r.contribDespuesAdsConfirmado),
    contribAntesAdsIniciado: n(r.contribAntesAdsIniciado),
    adsMaxConfirmado: n(r.adsMaxConfirmado),
    cajaNecesaria: n(r.cajaNecesaria),
    diasRecuperacion: n(r.diasRecuperacion),
    costoUnit: n(r.costoUnit),
  }
}

// Línea de flete desde una plantilla de ruta (A6), lista para el formulario.
export function lineaDesdeRuta(idRuta, { pesoKg, tcUSD }) {
  const [l] = lineasDeRuta(idRuta, { pesoCobrableKg: numDec(pesoKg) ?? 0, tcAPyg: tcTexto(tcUSD) })
  const moneda = l.moneda
  const esc = moneda === 'PYG' ? 0 : 2
  return {
    concepto: l.concepto,
    monto: l.monto_minor == null ? '' : (esc ? (l.monto_minor / 100).toFixed(2) : String(l.monto_minor)),
    moneda, tc: l.tc_a_pyg && moneda !== 'PYG' ? String(l.tc_a_pyg) : (moneda === 'PYG' ? '' : tcUSD || ''),
    recuperable: false, desembolso: true, factura_a_nombre_voltra: null, incluido_en: '',
    fuente: `${l.fuente}${l.estado ? ` (${l.estado})` : ''}`, fecha: l.fecha || '', rangoMin: '', rangoMax: '',
  }
}

// Datos reales de Voltra (pi_base_operativa, porcentajes 0-100) → tasas del motor.
// En Voltra "devuelto" = el courier lo devolvió sin entregar → rama "fallida".
// La vista no separa la devolución DESPUÉS de entregar: queda 0 (se avisa).
// "confirmacion" del motor = pedidos que SALEN ÷ iniciados (100 − % que no salió): es la base de las ramas.
// El "confirmado" de Voltra es más amplio (cuenta a los que confirman y después cancelan): esa diferencia
// va en canceladoTrasConfirmar, para que el costo por confirmado (tope ₲35.000) se convierta con la tasa
// correcta y no se infle la ganancia (revisión adversarial 18-11, hallazgo 3).
export function tasasDesdeBaseOperativa(fila) {
  const p = (v) => (v == null ? null : Number(v))
  const cancel = p(fila.pct_cancelado_antes_despacho)
  const conf = p(fila.pct_confirmado)
  const sale = cancel == null ? null : 100 - cancel
  let tras = ''
  if (sale != null && conf != null && conf > 0) tras = String(Math.max(0, Math.round((1 - sale / conf) * 1000) / 10))
  return {
    confirmacion: sale == null ? '' : String(Math.round(sale * 10) / 10),
    canceladoTrasConfirmar: tras,
    entrega: fila.pct_entregado == null ? '' : String(p(fila.pct_entregado)),
    devolucion: '0',
    flete: fila.flete_prom == null ? '' : String(fila.flete_prom),
  }
}
