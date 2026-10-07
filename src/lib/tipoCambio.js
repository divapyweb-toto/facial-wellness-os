// src/lib/tipoCambio.js
// ═══════════════════════════════════════════════════════════
// TIPO DE CAMBIO POR FECHA (USD → guaraníes)
//
// Un gasto en dólares se convierte con el cambio del DÍA en que se pagó, no con
// uno solo para todo el período: el dólar se mueve y el reporte de ayer tiene
// que seguir dando lo mismo mañana.
//
// Orden de búsqueda para cada día:
//   1. tabla `tipo_cambio` (lo guardado antes, o lo corregido a mano)
//   2. memoria del navegador (por si la tabla todavía no existe)
//   3. fuente pública por fecha (currency-api, sin clave) — y se guarda
//   4. el valor de respaldo de Config (usd_pyg), si lo cargaste
// Nada se inventa: si no hay ninguno, ese día queda sin convertir y se avisa.
//
// OJO: la fuente pública da la cotización de referencia del mercado, no
// necesariamente la que cobró tu banco o tarjeta. Para ese día, corregí la
// fila en la tabla `tipo_cambio` y se usa la tuya.
// ═══════════════════════════════════════════════════════════

const URLS = (f) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${f}/v1/currencies/usd.json`,
  `https://${f}.currency-api.pages.dev/v1/currencies/usd.json`,
]

export async function traerTasaOnline(fecha, fetchFn = globalThis.fetch) {
  for (const url of URLS(fecha)) {
    try {
      const r = await fetchFn(url)
      if (!r.ok) continue
      const j = await r.json()
      const t = Number(j?.usd?.pyg)
      if (t > 0) return t
    } catch { /* prueba el espejo */ }
  }
  return null
}

// Cotización para un día: la exacta; si ese día no hay (feriado, fuente caída),
// la del día anterior más cercano; si no, la posterior; si no, el respaldo.
export function tasaDelDia(tasas, dia, respaldo = 0) {
  if (!dia || !tasas || !tasas.size) return Number(respaldo) || 0
  if (tasas.has(dia)) return tasas.get(dia)
  const fechas = [...tasas.keys()].sort()
  const antes = fechas.filter(f => f < dia).pop()
  if (antes) return tasas.get(antes)
  const despues = fechas.find(f => f > dia)
  return despues ? tasas.get(despues) : (Number(respaldo) || 0)
}

const memoria = (almacen) => ({
  leer: (f) => { try { const v = Number(almacen?.getItem(`fw-os-tc-${f}`)); return v > 0 ? v : null } catch { return null } },
  guardar: (f, v) => { try { almacen?.setItem(`fw-os-tc-${f}`, String(v)) } catch { /* sin almacenamiento */ } },
})

// Devuelve Map(fecha → guaraníes por dólar) para todos los días pedidos.
export async function cargarTasas(cliente, fechas, { fetchFn, almacen = globalThis.localStorage, hoy = new Date().toISOString().slice(0, 10) } = {}) {
  const dias = [...new Set((fechas || []).filter(Boolean))].sort()
  const tasas = new Map()
  const fallidas = []
  if (!dias.length) return { tasas, fallidas, nuevas: 0 }

  try {
    const { data } = await cliente.from('tipo_cambio').select('fecha, usd_pyg').gte('fecha', dias[0]).lte('fecha', dias[dias.length - 1])
    ;(data || []).forEach(r => { if (Number(r.usd_pyg) > 0) tasas.set(String(r.fecha).slice(0, 10), Number(r.usd_pyg)) })
  } catch { /* la tabla todavía no existe: se sigue con memoria y fuente pública */ }

  const mem = memoria(almacen)
  const aGuardar = []
  for (const d of dias.filter(x => !tasas.has(x)).slice(0, 62)) {
    let t = mem.leer(d)
    if (!t) {
      t = await traerTasaOnline(d, fetchFn)
      // Hoy todavía se mueve: se usa pero no se guarda como definitiva.
      if (t && d < hoy) { mem.guardar(d, t); aGuardar.push({ fecha: d, usd_pyg: t, fuente: 'currency-api' }) }
    }
    if (t) tasas.set(d, t); else fallidas.push(d)
  }
  if (aGuardar.length) {
    try { await cliente.from('tipo_cambio').upsert(aGuardar, { onConflict: 'fecha', ignoreDuplicates: true }) } catch { /* se reintenta la próxima vez */ }
  }
  return { tasas, fallidas, nuevas: aGuardar.length }
}
