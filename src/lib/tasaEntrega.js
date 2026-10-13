// src/lib/tasaEntrega.js
// ═══════════════════════════════════════════════════════════
// TASA DE ENTREGA REALISTA (12-10)
//
// Problema: "entregados / resueltos" con pocos resueltos miente. Con 4
// entregados, 0 devueltos y 23 en camino daba "100%" en verde, cuando en
// realidad no se sabe todavía cómo cierran esos 23.
//
// Regla común a todas las pantallas:
//   - Mostrar "~esperada%" + "rango min–max%" + "N en camino".
//   - min      = solo lo ya entregado sobre todo lo enviado (si TODO lo que
//                vuela volviera).
//   - max      = entregados + en camino (si TODO lo que vuela se entregara).
//   - esperada = entregados + en camino × tasa usada (histórica con suficientes
//                resueltos, o la referencia del rubro si no hay historia).
//   - NUNCA un 100% verde que salga de pocos resueltos: con muestraChica el
//     color es neutro.
// ═══════════════════════════════════════════════════════════

export const REFERENCIA_TASA = 0.8        // si hay pocos resueltos
export const MIN_RESUELTOS = 20

const num = (x) => Math.max(0, Number(x) || 0)

// entregados, devueltos, enCamino (despachados sin resolver),
// hist opcional { entregados, resueltos } de períodos con datos.
export function tasaEntregaRealista({ entregados = 0, devueltos = 0, enCamino = 0, hist = null } = {}) {
  const e = num(entregados), d = num(devueltos), c = num(enCamino)
  const enviados = e + d + c
  const resueltos = e + d
  const hEnt = num(hist?.entregados), hRes = num(hist?.resueltos)
  const usaHist = hRes >= MIN_RESUELTOS && hEnt <= hRes
  const tasaUsada = usaHist ? hEnt / hRes : REFERENCIA_TASA
  const pct = (x) => (enviados ? (x / enviados) * 100 : null)
  return {
    enviados,
    resueltos,
    sobreResueltos: resueltos ? (e / resueltos) * 100 : null,
    min: pct(e),
    max: pct(e + c),
    esperada: pct(e + c * tasaUsada),
    tasaUsada,
    fuente: usaHist ? 'historica' : 'referencia',
    muestraChica: resueltos < MIN_RESUELTOS,
    enCamino: c,
  }
}

// ── Ayudas de presentación (mismo criterio en todas las pantallas) ──

const r0 = (x) => Math.round(x)

// "~72%" (o "—" si no hay enviados)
export function textoEsperada(t) {
  return t?.esperada == null ? '—' : `~${r0(t.esperada)}%`
}

// "rango 15–100% · 23 en camino" (sin rango si no hay nada en camino)
export function textoRango(t) {
  if (!t || t.esperada == null) return 'sin envíos'
  const partes = []
  if (t.enCamino > 0) partes.push(`rango ${r0(t.min)}–${r0(t.max)}%`, `${t.enCamino} en camino`)
  else partes.push(`${t.resueltos} resueltos`)
  if (t.muestraChica) partes.push('muestra chica')
  return partes.join(' · ')
}

// De dónde sale la tasa con la que se proyecta lo que está en camino.
export function textoFuente(t) {
  if (!t) return ''
  return t.fuente === 'historica'
    ? `en camino proyectado al ${r0(t.tasaUsada * 100)}% histórico`
    : `en camino proyectado al ${r0(REFERENCIA_TASA * 100)}% de referencia (poca historia)`
}

// Color: neutro con muestra chica; si no, según la esperada.
export function colorTasa(t, { verde = 70, amarillo = 50 } = {}) {
  if (!t || t.esperada == null || t.muestraChica) return 'var(--text-secondary)'
  return t.esperada >= verde ? 'var(--green)' : t.esperada >= amarillo ? 'var(--yellow)' : 'var(--red)'
}
