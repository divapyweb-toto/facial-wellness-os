// src/lib/productos/dossier.js
// ═══════════════════════════════════════════════════════════
// DOSSIER DE DECISIÓN (especificación §10) → Markdown.
// Responde las 11 preguntas, cada cifra con su fuente/versión y lo que
// falta escrito como "desconocido". Puro y determinista: la fecha de
// generación se pasa como dato (no se lee el reloj).
// ═══════════════════════════════════════════════════════════

import { formatoPYG, formatoPct } from './dinero.js'

export const DOSSIER_VERSION = '1.0.0'
const DESC = '**desconocido**'

export const PREGUNTAS = Object.freeze([
  'Qué vender',
  'A quién',
  'Qué problema resuelve',
  'Por qué comprarían aquí',
  'Con qué oferta y canal',
  'A qué precio se probará',
  'Quién abastece',
  'Cuánto cuesta realmente',
  'Cuánto dinero exige',
  'Qué podría invalidarlo',
  'Qué hacer ahora',
])

// Texto con fuente: { texto, fuente } | string | null
function txt(x, motivo) {
  if (x == null || x === '' || (typeof x === 'object' && (x.texto == null || x.texto === ''))) return `${DESC}${motivo ? ` (${motivo})` : ''}`
  if (typeof x === 'string') return `${x} _(sin fuente: verificar)_`
  return `${x.texto}${fte(x.fuente)}`
}

function fte(f) { return f ? ` _(fuente: ${f})_` : ' _(sin fuente: verificar)_' }

// Cifra en PYG con su fuente. valor null → desconocido.
function pyg(valor, fuente, motivo) {
  if (valor == null) return `${DESC}${motivo ? ` (${motivo})` : ''}`
  return `${formatoPYG(valor)}${fte(fuente)}`
}

function versionDe(r) { return r ? `motor ${r.version ?? '?'}` : null }

export function armarDossier(datos = {}) {
  const d = datos
  const cand = d.candidato || {}
  if (!cand.nombre) throw new Error('[dossier] Falta el nombre del candidato.')
  const L = []
  const add = (...l) => L.push(...l)

  add(`# Dossier · ${cand.nombre}`)
  if (cand.demo) add('', '> **DEMO**: datos de demostración, no son de Voltra.')
  add('', `Estado: **${cand.estado ?? 'INVESTIGAR'}** · ${d.ficha?.version != null ? `ficha v${d.ficha.version}` : 'ficha sin versión'} · dossier ${DOSSIER_VERSION}${d.generadoEn ? ` · generado ${d.generadoEn}` : ''}`)
  add('', '> Contribución ≠ utilidad neta (no descuenta fijos, IRE ni sueldo). El puntaje es de prioridad, NO una probabilidad de éxito.')

  // 1. Qué vender
  add('', `## 1. ${PREGUNTAS[0]}`)
  add(cand.hipotesis ? `${cand.nombre}: ${cand.hipotesis}` : `${cand.nombre}. Hipótesis: ${DESC}`)
  if (d.ficha?.resumen) add('', `Ficha v${d.ficha.version}: ${d.ficha.resumen}`)
  else add('', `Ficha: ${DESC} (sin ficha de especificación versionada)`)

  // 2. A quién
  add('', `## 2. ${PREGUNTAS[1]}`)
  const segs = d.segmentos || []
  if (!segs.length) add(`${DESC} (no hay segmentos cargados)`)
  segs.forEach(s => add(`- **${s.nombre}** [${s.tipo ?? 'hypothesis'}]: ${s.descripcion ?? DESC}${fte(s.fuente)}`))

  // 3. Problema
  add('', `## 3. ${PREGUNTAS[2]}`, txt(d.problema, 'sin evidencia del problema'))

  // 4. Por qué aquí
  add('', `## 4. ${PREGUNTAS[3]}`, txt(d.porQueAqui, 'sin diferencial respaldado'))
  const ofs = d.preciosLocales || []
  if (ofs.length) {
    add('', '| Vendedor | Comparación | Zona | Precio | Observado | Fuente |', '|---|---|---|---:|---|---|')
    ofs.forEach(o => add(`| ${o.vendedor ?? DESC} | ${o.comparacion ?? DESC} | ${o.zona ?? 'DESCONOCIDA'} | ${o.precio == null ? DESC : formatoPYG(o.precio)} | ${o.observadoEn ?? DESC} | ${o.fuente ?? 'sin fuente: verificar'} |`))
    const vendedores = new Set(ofs.map(o => o.vendedorClave ?? o.vendedor)).size
    add('', `Cobertura: ${ofs.length} oferta(s) de ${vendedores} vendedor(es) independiente(s). Un precio publicado no prueba ventas.`)
  } else add('', `Ofertas locales: ${DESC} (no relevadas)`)

  // 5. Oferta y canal
  add('', `## 5. ${PREGUNTAS[4]}`)
  add(d.oferta ? `${d.oferta.descripcion ?? DESC} · canal: ${d.oferta.canal ?? DESC}${fte(d.oferta.fuente)}` : `${DESC} (sin oferta definida)`)

  // 6. Precio de prueba
  add('', `## 6. ${PREGUNTAS[5]}`)
  add(`Precio de prueba (con IVA): ${pyg(d.precioPrueba?.valor, d.precioPrueba?.fuente, 'sin precio de prueba')}`)

  // 7. Quién abastece
  add('', `## 7. ${PREGUNTAS[6]}`)
  const cots = d.cotizaciones || []
  if (!cots.length) add(`${DESC} (sin cotizaciones)`)
  else {
    add('| Proveedor | Tipo | Precio unit. | MOQ | Ficha | Válida hasta | Fuente |', '|---|---|---:|---:|---|---|---|')
    cots.forEach(c => add(`| ${c.proveedor ?? DESC} | ${c.tipo ?? 'estimada'}${c.tipo === 'escaparate' ? ' (no es cotización firme)' : ''} | ${c.precioUnitTexto ?? DESC} | ${c.moq ?? DESC} | v${c.fichaVersion ?? '?'} | ${c.validaHasta ?? DESC} | ${c.fuente ?? 'sin fuente: verificar'} |`))
    const firmes = cots.filter(c => c.tipo === 'firme').length
    add('', `Cotizaciones firmes: ${firmes} de ${cots.length}.${firmes <= 1 ? ' Concentración: evidencia de abastecimiento insuficiente para comparar.' : ''}`)
  }

  // 8. Cuánto cuesta realmente
  add('', `## 8. ${PREGUNTAS[7]}`)
  const cp = d.costoPuesto
  const fCp = d.costoPuestoFuente ?? versionDe(cp)
  if (!cp) add(`Costo puesto por unidad vendible: ${DESC} (sin cálculo)`)
  else if (cp.porUnidadVendible != null) add(`Costo puesto por unidad vendible: ${pyg(cp.porUnidadVendible, fCp)} · total ${pyg(cp.totalPYG, fCp)} · merma ${formatoPct(cp.merma?.pct)}`)
  else add(`Costo puesto por unidad vendible: rango ${formatoPYG(cp.rango.porUnidadVendible.min)} a ${formatoPYG(cp.rango.porUnidadVendible.max)}${fte(fCp)} · desconocido: ${cp.desconocidos.map(x => x.concepto).join(', ')}`)
  if (cp?.avisos?.length) cp.avisos.forEach(a => add(`- Aviso: ${a}`))

  const esc = d.escenarios
  const fEsc = d.escenariosFuente ?? versionDe(esc)
  if (esc) {
    add('', '| Escenario | Costo unit. | Antes de ads / iniciado | Después de ads / iniciado | Después de ads / confirmado | Ads máx. / confirmado | Fuentes |', '|---|---:|---:|---:|---:|---:|---|')
    for (const k of ['adverso', 'base', 'favorable']) {
      const e = esc[k]
      if (!e) continue
      const r = e.resumen
      const v = (x) => (x == null ? DESC : formatoPYG(x))
      add(`| ${k} | ${v(r.costoUnit)} | ${v(r.porIniciado.antesAds)} | ${v(r.porIniciado.despuesAds)} | ${v(r.porConfirmado.despuesAds)} | ${v(r.porConfirmado.adsMaximo)} | ${e.fuentes ? (Array.isArray(e.fuentes) ? e.fuentes.join('; ') : e.fuentes) : 'sin fuente: verificar'} |`)
    }
    add('', `Cálculo: ${fEsc ?? 'sin versión'}. Denominadores rotulados: "iniciado" = todo pedido creado; "confirmado" = iniciado ÷ (1 − % cancelado). Escenarios = hipótesis, no probabilidades.`)
  } else add('', `Escenarios: ${DESC} (sin calcular)`)

  // 9. Cuánto dinero exige
  add('', `## 9. ${PREGUNTAS[8]}`)
  const cj = d.caja
  const fCj = d.cajaFuente ?? versionDe(cj)
  if (!cj) add(`Necesidad de caja: ${DESC} (sin calendario de caja)`)
  else {
    add(`Necesidad de caja (pico): ${pyg(cj.necesidadCaja, fCj)}${cj.diaPico != null ? ` el día ${cj.diaPico}` : ''}`)
    add(`Recuperación: ${cj.recupera ? (cj.diasRecuperacion != null ? `${cj.diasRecuperacion} días` : 'no baja del saldo inicial') : `${DESC} (no recupera dentro del horizonte cargado)`} · sin anualizar${fte(fCj)}`)
    const t = cj.totales || {}
    add(`Salidas: ${['muestras', 'primerLote', 'tributos', 'publicidad', 'logistica', 'devoluciones', 'reposicion'].filter(k => t[k] != null).map(k => `${k} ${formatoPYG(t[k])}`).join(' · ') || DESC}${fte(fCj)}`)
  }

  // 10. Qué podría invalidarlo
  add('', `## 10. ${PREGUNTAS[9]}`)
  const dec = d.decision
  const bloqueos = dec?.bloqueos || d.bloqueos || []
  const avisos = dec?.avisos || d.avisos || []
  if (bloqueos.length) bloqueos.forEach(b => add(`- **Bloqueo duro** \`${b.codigo}\`: ${b.mensaje}`))
  avisos.forEach(a => add(`- Aviso \`${a.codigo}\`: ${a.mensaje}`))
  ;(d.riesgos || []).forEach(r => add(`- Riesgo: ${txt(r)}`))
  if (!bloqueos.length && !avisos.length && !(d.riesgos || []).length) add(`${DESC} (no se registraron riesgos: revisar con el revisor independiente)`)
  if (dec?.refutaSi) add('', `La tesis se cae si ${dec.refutaSi}.`)

  // 11. Qué hacer ahora
  add('', `## 11. ${PREGUNTAS[10]}`)
  if (!dec) add(`${DESC} (sin decisión calculada)`)
  else {
    add(`Decisión sugerida: **${dec.estado}**`)
    add(`Siguiente acción más barata que puede refutar la tesis: ${dec.siguienteAccion} (${dec.costoDeLaAccion}).`)
    if (dec.razones?.length) add(`Razones: ${dec.razones.join(' ')}`)
  }
  if (d.puntaje) add('', `Puntaje de prioridad: ${d.puntaje.puntaje} / 100 (cobertura de la evidencia ${formatoPct(d.puntaje.cobertura, 0)}). ${d.puntaje.advertencia}`)

  add('', '---', `Generado por dossier ${DOSSIER_VERSION}. Toda cifra lleva su fuente; lo que dice "desconocido" no se completó con supuestos.`)
  return L.join('\n') + '\n'
}
