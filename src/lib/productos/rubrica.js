// src/lib/productos/rubrica.js
// ═══════════════════════════════════════════════════════════
// RÚBRICA Y DECISIÓN del módulo de inteligencia de productos (Voltra).
// Funciones puras y deterministas.
//
// Orden (especificación §7): primero BLOQUEOS DUROS, después PUNTAJE.
//  - Un bloqueo duro gana siempre: ningún puntaje lo neutraliza.
//  - Los bloqueos frenan COMPROMISOS DE COMPRA (muestra, lote, reorden,
//    escalar). Un candidato bloqueado puede seguir en investigación o
//    pidiendo cotizaciones.
//  - El puntaje es de PRIORIDAD (0 a 100). NUNCA es una probabilidad de éxito.
//  - Cada decisión trae la siguiente acción más barata que puede refutar la tesis.
// ═══════════════════════════════════════════════════════════

export const RUBRICA_VERSION = '1.0.0'

export const ESTADOS = Object.freeze(['INVESTIGAR', 'DESCARTAR', 'SOLICITAR_COTIZACION', 'PROBAR_MUESTRA', 'PROBAR_OFERTA', 'REORDENAR', 'ESCALAR'])
export const ESTADOS_COMPRA = Object.freeze(['PROBAR_MUESTRA', 'PROBAR_OFERTA', 'REORDENAR', 'ESCALAR'])

// Pesos iniciales editables (especificación §7).
export const PESOS_INICIALES = Object.freeze({
  demanda: 25,         // demanda y disposición a pagar respaldadas
  contribucion: 25,    // contribución después de adquisición y fallos
  caja: 20,            // caja requerida y recuperación
  abastecimiento: 15,  // fiabilidad de abastecimiento y logística
  diferenciacion: 10,  // diferenciación y repetibilidad comercial
  operacion: 5,        // facilidad operativa y carga posventa
})

export const NOMBRES_DIMENSION = Object.freeze({
  demanda: 'Demanda y disposición a pagar respaldadas',
  contribucion: 'Contribución después de adquisición y fallos',
  caja: 'Caja requerida y recuperación',
  abastecimiento: 'Fiabilidad de abastecimiento y logística',
  diferenciacion: 'Diferenciación y repetibilidad comercial',
  operacion: 'Facilidad operativa y carga posventa',
})

// Evidencia mínima para cada compromiso (editable vía opciones.requisitos).
// Un precio de escaparate NO cuenta como cotización firme.
export const REQUISITOS_EVIDENCIA = Object.freeze({
  INVESTIGAR: {},
  DESCARTAR: {},
  SOLICITAR_COTIZACION: {},
  PROBAR_MUESTRA: { cotizacionesFirmes: 1, ofertasComparables: 3, vendedoresIndependientes: 2 },
  PROBAR_OFERTA: { cotizacionesFirmes: 1, ofertasComparables: 5, vendedoresIndependientes: 3, muestraConforme: true },
  REORDENAR: { cotizacionesFirmes: 1, muestraConforme: true, pilotoMaduro: true },
  ESCALAR: { cotizacionesFirmes: 1, muestraConforme: true, pilotoMaduro: true },
})

const SEMAFOROS = ['VERDE', 'AMARILLO', 'ROJO', 'DESCONOCIDO']

function err(msg) { return new Error(`[rubrica] ${msg}`) }

// ─────────────────────────── bloqueos duros ───────────────────────────
// caso = {
//   compromiso: estado al que se quiere pasar (por defecto PROBAR_MUESTRA),
//   presupuesto: { disponible, requerido }               (PYG enteros)
//   contribucion: { valor, validada, denominador }       (después de ads, PYG por pedido)
//   costosDesconocidos: [{ concepto, maximoPorPedido }]  (null = sin cota)
//   importacion: { requerida, verificada }
//   muestra: { estado: 'CONFORME'|'DEFECTUOSA'|'PENDIENTE'|'NO_PEDIDA' }
//   abastecimiento: { proveedoresDisponibles }
//   evidencia: { ofertasComparables, vendedoresIndependientes, cotizacionesFirmes, pilotoMaduro }
//   semaforoCaja: 'VERDE'|'AMARILLO'|'ROJO'|'DESCONOCIDO'  (A3, socio/caja/REGLAS-CAJA.md)
//   proveedorFactura: true|false|null                    (A4: factura a nombre de Voltra)
// }
// Devuelve { bloqueos[], avisos[], bloqueaCompra, entradas }.
export function bloqueosDuros(caso = {}, opciones = {}) {
  const compromiso = caso.compromiso ?? 'PROBAR_MUESTRA'
  if (!ESTADOS.includes(compromiso)) throw err(`Compromiso "${compromiso}" desconocido. Estados: ${ESTADOS.join(', ')}.`)
  const requisitos = { ...REQUISITOS_EVIDENCIA, ...(opciones.requisitos || {}) }
  const bloqueos = []
  const avisos = []
  const b = (codigo, mensaje, dato = null) => bloqueos.push({ codigo, mensaje, dato })
  const a = (codigo, mensaje, dato = null) => avisos.push({ codigo, mensaje, dato })
  const esCompra = ESTADOS_COMPRA.includes(compromiso)

  // 1) Presupuesto
  const p = caso.presupuesto
  if (p && p.requerido != null && p.disponible != null) {
    if (p.requerido > p.disponible) b('presupuesto_excedido', `El compromiso pide ₲${miles(p.requerido)} y el presupuesto autorizado es ₲${miles(p.disponible)}.`, { ...p })
  } else if (esCompra) {
    b('presupuesto_excedido', 'No hay presupuesto autorizado y/o monto requerido definido para este compromiso: no se puede comprobar que entre.', p ?? null)
  }

  // 2) Costo crítico desconocido que puede invertir el resultado
  const c = caso.contribucion
  const desconocidos = caso.costosDesconocidos || []
  if (desconocidos.length) {
    const sinCota = desconocidos.filter(d => d.maximoPorPedido == null)
    const sumaMax = desconocidos.reduce((s, d) => s + (d.maximoPorPedido || 0), 0)
    if (sinCota.length) {
      b('costo_critico_desconocido', `Costo(s) desconocido(s) sin cota: ${sinCota.map(d => d.concepto).join(', ')}. No se puede saber si invierten el resultado.`, desconocidos)
    } else if (c?.valor == null || sumaMax >= c.valor) {
      b('costo_critico_desconocido', `Los costos desconocidos (hasta ₲${miles(sumaMax)} por pedido) pueden dejar la contribución${c?.valor == null ? ' (desconocida)' : ` de ₲${miles(c.valor)}`} en cero o negativa.`, { desconocidos, sumaMax })
    } else {
      a('costo_desconocido_acotado', `Hay costos desconocidos, pero su máximo (₲${miles(sumaMax)}) no invierte la contribución.`, { desconocidos, sumaMax })
    }
  }

  // 3) Importación pendiente de verificación
  if (caso.importacion?.requerida && caso.importacion?.verificada !== true) {
    b('importacion_sin_verificar', 'La importación (clasificación, tributos, documentación y quién importa) no está verificada por escrito.', caso.importacion)
  }

  // 4) Muestra defectuosa
  if (caso.muestra?.estado === 'DEFECTUOSA') b('muestra_defectuosa', 'La muestra no cumple la ficha de especificación.', caso.muestra)

  // 5) Contribución negativa validada
  if (c?.valor != null && c.valor < 0) {
    if (c.validada) b('contribucion_negativa_validada', `La contribución después de ads es ₲${miles(c.valor)} por ${c.denominador || 'pedido'} con datos validados.`, c)
    else a('contribucion_negativa_estimada', `La contribución estimada es negativa (₲${miles(c.valor)}), pero no está validada con datos propios.`, c)
  }

  // 6) Sin abastecimiento
  const prov = caso.abastecimiento?.proveedoresDisponibles
  if (prov === 0) b('sin_abastecimiento', 'No hay ningún proveedor que pueda abastecer la ficha.', caso.abastecimiento)
  else if (prov == null && esCompra) a('abastecimiento_sin_confirmar', 'No se informó cuántos proveedores pueden abastecer.')

  // 7) Evidencia insuficiente para el siguiente compromiso
  const req = requisitos[compromiso] || {}
  const ev = caso.evidencia || {}
  const faltan = []
  for (const k of ['cotizacionesFirmes', 'ofertasComparables', 'vendedoresIndependientes']) {
    if (req[k] != null && (ev[k] ?? 0) < req[k]) faltan.push(`${k}: ${ev[k] ?? 0} de ${req[k]}`)
  }
  if (req.muestraConforme && caso.muestra?.estado !== 'CONFORME') faltan.push('muestra conforme')
  if (req.pilotoMaduro && ev.pilotoMaduro !== true) faltan.push('piloto con datos propios maduros (cobro, entrega y devolución)')
  if (faltan.length) b('evidencia_insuficiente', `Evidencia insuficiente para ${compromiso}: falta ${faltan.join('; ')}.`, { compromiso, faltan })

  // 8) A3 · Semáforo de caja (socio/caja/REGLAS-CAJA.md): amarillo o rojo bloquean comprar stock o muestras.
  const sem = caso.semaforoCaja ?? 'DESCONOCIDO'
  if (!SEMAFOROS.includes(sem)) throw err(`semaforoCaja "${sem}" no válido: ${SEMAFOROS.join(', ')}.`)
  if (sem === 'AMARILLO' || sem === 'ROJO') {
    b('caja_semaforo', `Caja en ${sem}: no se compra stock ni muestras hasta volver a VERDE (REGLAS-CAJA.md: stock nuevo solo con semáforo verde).`, { semaforoCaja: sem })
  } else if (sem === 'DESCONOCIDO') {
    a('caja_semaforo_desconocido', 'Semáforo de caja desconocido: confirmarlo en el parte del día antes de comprar.')
  }

  // A4 · Factura a nombre de Voltra (aviso, no bloquea)
  if (caso.proveedorFactura === false) a('proveedor_sin_factura', 'El proveedor no factura a nombre de Voltra: el stock sin factura no se deduce del IRE y su IVA no se recupera.')
  else if (caso.proveedorFactura == null && esCompra) a('factura_sin_confirmar', 'Confirmar que el proveedor factura a nombre de Voltra (desde el 29-10 todo stock va con factura).')

  // Los bloqueos frenan compras; para INVESTIGAR / SOLICITAR_COTIZACION / DESCARTAR quedan como información.
  return {
    version: RUBRICA_VERSION,
    entradas: JSON.parse(JSON.stringify(caso)),
    compromiso,
    bloqueos,
    avisos,
    bloqueaCompra: bloqueos.length > 0,
  }
}

// ─────────────────────────── puntaje ───────────────────────────
// dimensiones = { demanda: { valor 0-100 | null, evidencia: [], faltantes: [], razon }, ... }
// pesos editables (por defecto 25/25/20/15/10/5).
export function puntaje(dimensiones = {}, pesos = PESOS_INICIALES) {
  const claves = Object.keys(PESOS_INICIALES)
  for (const k of Object.keys(dimensiones)) if (!claves.includes(k)) throw err(`Dimensión desconocida "${k}". Dimensiones: ${claves.join(', ')}.`)
  for (const k of Object.keys(pesos)) if (!claves.includes(k)) throw err(`Peso para dimensión desconocida "${k}".`)
  const ps = claves.map(k => {
    const w = pesos[k] ?? 0
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) throw err(`Peso de "${k}" inválido (${w}).`)
    return w
  })
  const totalPesos = ps.reduce((a, b) => a + b, 0)
  if (totalPesos <= 0) throw err('Los pesos suman 0.')
  let suma = 0, pesoConDato = 0
  const detalle = claves.map((k, i) => {
    const d = dimensiones[k] || {}
    const v = d.valor
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) throw err(`Valor de "${k}" fuera de 0-100 (${v}).`)
    const aporte = v == null ? 0 : (ps[i] * v) / totalPesos
    suma += aporte
    if (v != null) pesoConDato += ps[i]
    return {
      dimension: k, nombre: NOMBRES_DIMENSION[k], peso: ps[i], valor: v ?? null,
      aporte: Math.round(aporte * 10) / 10,
      evidencia: d.evidencia || [],
      faltantes: v == null ? [...(d.faltantes || []), 'sin valoración: cuenta 0'] : (d.faltantes || []),
      razon: d.razon ?? null,
    }
  })
  return {
    version: RUBRICA_VERSION,
    entradas: { dimensiones: JSON.parse(JSON.stringify(dimensiones)), pesos: { ...pesos } },
    puntaje: Math.round(suma * 10) / 10,
    escala: '0 a 100',
    advertencia: 'Puntaje de prioridad, NO probabilidad de éxito.',
    cobertura: pesoConDato / totalPesos, // qué parte del peso tiene valoración (calidad de la evidencia aparte)
    detalle,
    pesos: Object.fromEntries(claves.map((k, i) => [k, ps[i]])),
  }
}

// ─────────────────────────── decisión sugerida ───────────────────────────
// Elige el estado y la siguiente acción más barata que puede refutar la tesis.
// opciones: { umbralEscalar (70), requisitos, puntaje (salida de puntaje()) }
const ACCIONES = {
  INVESTIGAR: {
    accion: 'Relevar en Paraguay 5 ofertas comparables de al menos 3 vendedores independientes (CDE, Gran Asunción, interior), con fecha, variante y envío.',
    costo: 'tiempo de investigación, ₲0 de compra',
    refutaSi: 'el precio local comparable (con envío) deja el precio de prueba sin margen, o no aparece demanda observable',
  },
  SOLICITAR_COTIZACION: {
    accion: 'Pedir cotización firme por escrito para la ficha versionada (primero mayorista local en CDE, después Alibaba/1688 en borrador), con escalones chicos y costo de muestra.',
    costo: 'mensajes en borrador, ₲0 de compra',
    refutaSi: 'el costo puesto por unidad vendible deja la contribución por confirmado ≤ 0 al precio de prueba',
  },
  PROBAR_MUESTRA: {
    accion: 'Comprar la muestra (o el lote mínimo local) y revisarla contra los criterios de aceptación de la ficha.',
    costo: 'costo de la muestra + envío',
    refutaSi: 'la muestra no cumple la ficha o el costo real difiere de la cotización',
  },
  PROBAR_OFERTA: {
    accion: 'Correr un piloto chico con presupuesto y pérdida máxima definidos, midiendo costo por confirmado, entrega y devolución con datos propios.',
    costo: 'presupuesto de la prueba (tope fijado en el experimento)',
    refutaSi: 'el costo por confirmado supera el máximo pagable o la entrega cae por debajo del supuesto',
  },
  REORDENAR: {
    accion: 'Reponer un lote del tamaño que la caja permita, manteniendo el mismo canal y oferta del piloto.',
    costo: 'lote de reposición',
    refutaSi: 'la contribución del segundo lote cae por debajo de la del piloto',
  },
  ESCALAR: {
    accion: 'Subir presupuesto por escalones semanales, con freno si el costo por confirmado pasa el máximo.',
    costo: 'aumento de pauta + capital de stock',
    refutaSi: 'el costo por confirmado al escalar supera el máximo pagable dos semanas seguidas',
  },
  DESCARTAR: {
    accion: 'Cerrar el caso y anotar por qué; reabrir solo si cambia el costo o el precio validado.',
    costo: '₲0',
    refutaSi: 'aparece un costo o precio que vuelva positiva la contribución',
  },
}

// Acción alternativa cuando un bloqueo frena una compra (orden de prioridad).
const SALIDA_POR_BLOQUEO = [
  ['contribucion_negativa_validada', 'DESCARTAR', null],
  ['muestra_defectuosa', 'SOLICITAR_COTIZACION', 'Pedir muestra a otro proveedor con la misma ficha versionada (o descartar si no hay otro).'],
  ['sin_abastecimiento', 'SOLICITAR_COTIZACION', 'Buscar al menos un proveedor que cumpla la ficha (mayorista CDE primero).'],
  ['costo_critico_desconocido', 'SOLICITAR_COTIZACION', 'Conseguir por escrito el/los costo(s) desconocido(s) de mayor impacto antes de comprar.'],
  ['importacion_sin_verificar', 'SOLICITAR_COTIZACION', 'Pedir al despachante/forwarder clasificación, tributos y quién importa, por escrito.'],
  ['presupuesto_excedido', 'SOLICITAR_COTIZACION', 'Renegociar MOQ o lote mixto, o probar con lote chico de mayorista local para que entre en el presupuesto.'],
  ['caja_semaforo', 'INVESTIGAR', 'Esperar semáforo VERDE; mientras, avanzar solo lo que no compra (ofertas locales, cotizaciones en borrador).'],
]

export function decisionSugerida(caso = {}, opciones = {}) {
  const umbralEscalar = opciones.umbralEscalar ?? 70
  const ev = caso.evidencia || {}
  const req = { ...REQUISITOS_EVIDENCIA, ...(opciones.requisitos || {}) }
  const cumple = (estado) => {
    const r = req[estado] || {}
    for (const k of ['cotizacionesFirmes', 'ofertasComparables', 'vendedoresIndependientes']) if (r[k] != null && (ev[k] ?? 0) < r[k]) return false
    if (r.muestraConforme && caso.muestra?.estado !== 'CONFORME') return false
    if (r.pilotoMaduro && ev.pilotoMaduro !== true) return false
    return true
  }

  // Escalera de evidencia: el primer escalón que falta define el estado objetivo.
  let objetivo
  if ((ev.ofertasComparables ?? 0) < (req.PROBAR_MUESTRA.ofertasComparables ?? 0) || (ev.vendedoresIndependientes ?? 0) < (req.PROBAR_MUESTRA.vendedoresIndependientes ?? 0)) objetivo = 'INVESTIGAR'
  else if ((ev.cotizacionesFirmes ?? 0) < 1) objetivo = 'SOLICITAR_COTIZACION'
  else if (caso.muestra?.estado !== 'CONFORME') objetivo = 'PROBAR_MUESTRA'
  else if (ev.pilotoMaduro !== true) objetivo = cumple('PROBAR_OFERTA') ? 'PROBAR_OFERTA' : 'INVESTIGAR'
  else objetivo = 'REORDENAR'

  const razones = []
  const bd = bloqueosDuros({ ...caso, compromiso: objetivo }, opciones)
  let estado = objetivo
  let accionAlternativa = null

  if (bd.bloqueos.some(x => x.codigo === 'contribucion_negativa_validada')) {
    estado = 'DESCARTAR'
    razones.push('Contribución negativa con datos validados: un bloqueo duro gana siempre.')
  } else if (ESTADOS_COMPRA.includes(objetivo) && bd.bloqueaCompra) {
    const codigos = new Set(bd.bloqueos.map(x => x.codigo))
    const salida = SALIDA_POR_BLOQUEO.find(([cod]) => codigos.has(cod))
    if (salida) { estado = salida[1]; accionAlternativa = salida[2] }
    else if (codigos.has('evidencia_insuficiente')) estado = (ev.cotizacionesFirmes ?? 0) < 1 ? 'SOLICITAR_COTIZACION' : 'INVESTIGAR'
    razones.push(`Bloqueos duros frenan ${objetivo}: ${bd.bloqueos.map(x => x.codigo).join(', ')}.`)
  }

  // ESCALAR: solo con muestra conforme, piloto maduro, contribución validada > 0, sin bloqueos y puntaje alto.
  const p = opciones.puntaje?.puntaje
  if (estado === 'REORDENAR') {
    const c = caso.contribucion
    const puedeEscalar = caso.muestra?.estado === 'CONFORME' && ev.pilotoMaduro === true && c?.validada === true && (c?.valor ?? -1) > 0 && !bd.bloqueaCompra && p != null && p >= umbralEscalar
    if (puedeEscalar) {
      const bdEsc = bloqueosDuros({ ...caso, compromiso: 'ESCALAR' }, opciones)
      if (!bdEsc.bloqueaCompra) { estado = 'ESCALAR'; razones.push(`Piloto maduro con contribución validada y puntaje ${p} ≥ ${umbralEscalar}.`) }
    } else if (ev.pilotoMaduro === true) {
      razones.push('No se escala: hace falta muestra conforme, piloto maduro, contribución validada positiva, sin bloqueos y puntaje ≥ umbral.')
    }
  }
  if (!razones.length) razones.push(`Siguiente escalón de evidencia pendiente: ${objetivo}.`)

  const acc = ACCIONES[estado]
  return {
    version: RUBRICA_VERSION,
    entradas: { caso: JSON.parse(JSON.stringify(caso)), opciones: JSON.parse(JSON.stringify({ ...opciones, puntaje: opciones.puntaje ? { puntaje: opciones.puntaje.puntaje } : undefined })) },
    estado,
    objetivoEvidencia: objetivo,
    siguienteAccion: accionAlternativa ?? acc.accion,
    costoDeLaAccion: accionAlternativa ? 'sin compra' : acc.costo,
    refutaSi: acc.refutaSi,
    razones,
    bloqueos: bd.bloqueos,
    avisos: bd.avisos,
    puntaje: p ?? null,
    advertencia: 'El puntaje es de prioridad, no una probabilidad de éxito.',
  }
}

function miles(n) {
  const v = Math.round(Number(n))
  return `${v < 0 ? '−' : ''}${String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
}
