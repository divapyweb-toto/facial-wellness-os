// src/pages/productos/derivados.js
// Datos derivados (puros, sin React) que usan Decisión y Dossier:
// evidencia contada como la rúbrica la necesita y los datos del dossier.
import { fmtFecha, fmtDinero, vencida, claveVendedor } from './formato'

// ── Datos derivados que usan Decisión y Dossier ──
export function derivar(d) {
  const ahora = new Date()
  const ultimaFicha = d.fichas[d.fichas.length - 1] || null
  const comparables = d.ofertas.filter(o => o.comparacion !== 'sustituto')
  const vendedores = new Set(comparables.map(o => o.vendedor_clave || claveVendedor(o.vendedor))).size
  const firmes = d.cotizaciones.filter(c => c.tipo === 'firme' && !vencida(c.valida_hasta, ahora) && (!ultimaFicha || !c.ficha_version || c.ficha_version === ultimaFicha.version))
  const provConCot = new Set(d.cotizaciones.filter(c => !vencida(c.valida_hasta, ahora)).map(c => c.proveedor_id)).size
  const provPorId = Object.fromEntries(d.proveedores.map(p => [p.id, p]))
  const importa = d.cotizaciones.some(c => ['alibaba', '1688'].includes(provPorId[c.proveedor_id]?.plataforma))
  const esc = d.escenarios[0] || null
  const caso = d.casos[d.casos.length - 1] || d.casos[0] || null
  const ultimoCaso = d.casos.reduce((m, c) => (!m || (c.version || 0) > (m.version || 0) ? c : m), null) || caso
  const pilotoMaduro = d.experimentos.some(x => x.estado === 'CERRADO' && x.resultado?.maduro === true)
  return { ultimaFicha, comparables, vendedores, firmes, provConCot, provPorId, importa, esc, ultimoCaso, pilotoMaduro }
}

export function armarDatosDossier(d) {
  const der = derivar(d)
  const c = der.ultimoCaso
  const esc = der.esc
  const R = esc?.resultado || {}
  const fuenteEsc = esc ? `escenario "${esc.nombre}" v${esc.version}, ${fmtFecha(esc.calculado_en)}` : null
  const spec = der.ultimaFicha?.spec || {}
  return {
    candidato: d.candidato,
    generadoEn: new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion' }),
    ficha: der.ultimaFicha ? { version: der.ultimaFicha.version, resumen: Object.entries(spec).filter(([, v]) => v).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') || null } : null,
    segmentos: c?.segmento ? [{ nombre: c.segmento, tipo: 'hypothesis', descripcion: spec.clientes || null, fuente: `caso v${c.version}` }] : [],
    problema: d.candidato.hipotesis ? { texto: d.candidato.hipotesis, fuente: 'hipótesis del candidato (sin validar)' } : null,
    porQueAqui: null,
    preciosLocales: d.ofertas.map(o => ({ vendedor: o.vendedor, vendedorClave: o.vendedor_clave, comparacion: o.comparacion, zona: o.zona, precio: o.moneda === 'PYG' ? o.precio_minor : null, observadoEn: fmtFecha(o.observado_en), fuente: o.url || null })),
    oferta: c?.oferta ? { descripcion: c.oferta, canal: c.canal, fuente: `caso v${c.version}` } : null,
    precioPrueba: c?.precio_prueba_minor != null ? { valor: c.precio_prueba_minor, fuente: `caso v${c.version}` } : null,
    cotizaciones: d.cotizaciones.map(q => {
      const e0 = (q.escalones || [])[0]
      return { proveedor: der.provPorId[q.proveedor_id]?.razon_social_declarada || null, tipo: q.tipo, precioUnitTexto: e0 ? `${fmtDinero(e0.precio_unit_minor, q.moneda)} (${e0.cantidad} u)` : null, moq: q.moq, fichaVersion: q.ficha_version, validaHasta: q.valida_hasta ? fmtFecha(q.valida_hasta) : null, fuente: der.provPorId[q.proveedor_id]?.url || `cotización cargada ${fmtFecha(q.creado_en)}` }
    }),
    costoPuesto: R.escenarios?.base?.resultado?.costoPuesto || null,
    costoPuestoFuente: fuenteEsc,
    escenarios: R.escenarios || null,
    escenariosFuente: fuenteEsc,
    caja: R.caja || null,
    cajaFuente: fuenteEsc,
    decision: c?.rubrica?.sugerida || null,
    puntaje: c?.rubrica?.puntaje || null,
    riesgos: d.evidencias.filter(e => e.tipo === 'unknown').map(e => ({ texto: `dato desconocido: ${e.campo}${e.cobertura ? ` (${e.cobertura})` : ''}`, fuente: 'registro de evidencia' })),
  }
}


// ── Permiso para negociar (antes "campaña"). Contrato FUNCIONES 18-11 ──
// Permiso general = la única fila de pi_politicas con candidato_id NULL (vale para todos los productos).
export const esPermisoGeneral = (p) => !!p && p.candidato_id == null && p.alcance?.tipo === 'general'

// Igual que el disparador de la base: el general no vence si vigente_hasta es NULL; el por producto, sí.
export function politicaVigente(p, ahora = new Date()) {
  if (!p?.permite_envio) return false
  if (p.vigente_hasta) return new Date(p.vigente_hasta) > ahora
  return p.candidato_id == null
}

const NEGOCIA_TEXTO = { precio: 'precio', cantidades: 'cantidades', color_variante: 'color o variante', calidad: 'calidad', empaque: 'empaque', plazos: 'plazos', condiciones: 'condiciones' }
export const NUNCA_CUBRE = ['aceptar o confirmar una orden', 'pagar', 'comprar muestras', 'prometer exclusividad', 'aceptar términos']

// "precio, cantidades, color o variante, … y condiciones"
export function textoNegocia(alcance) {
  const l = (Array.isArray(alcance?.negocia) ? alcance.negocia : []).map(k => NEGOCIA_TEXTO[k] || String(k).replace(/_/g, ' '))
  if (!l.length) return 'nada cargado'
  return l.length === 1 ? l[0] : `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}`
}

export function topesPermisoGeneral(alcance) {
  const n = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def)
  return { proveedores: n(alcance?.proveedores_max_por_producto, 10), rondas: n(alcance?.rondas_max_por_producto, 3), seguimientoDias: n(alcance?.seguimiento_dias_habiles, 2) }
}
