// src/lib/flete.js
// ═══════════════════════════════════════════════════════════
// TARIFA DE FLETE DE PUNTO A PUNTO
//
// El costo por envío cambió con el tiempo. Para que los reportes históricos
// queden EXACTOS, cada envío se valoriza con la tarifa que regía en su fecha,
// no con la tarifa de hoy.
//
// Si mañana sube de nuevo, agregás una línea más acá y todo el sistema queda
// consistente — es el único lugar donde vive esta tabla.
// ═══════════════════════════════════════════════════════════

// Tramos de tarifa, del más nuevo al más viejo. `desde` = primera fecha (incl.)
// en que rige ese precio.
const TRAMOS = [
  { desde: '2026-07-10', costo: 29000 }, // subió el 10-jul-2026
  { desde: '0000-00-00', costo: 27000 }, // tarifa histórica hasta el 09-jul-2026
]

// Costo de flete para un envío según su fecha (YYYY-MM-DD).
// Si no hay fecha, usa la tarifa vigente hoy (la más nueva).
export function costoFlete(fecha) {
  const f = fecha ? String(fecha).slice(0, 10) : TRAMOS[0].desde
  for (const t of TRAMOS) {
    if (f >= t.desde) return t.costo
  }
  return TRAMOS[TRAMOS.length - 1].costo
}

// Tarifa vigente hoy (para formularios de venta nueva, calculadora, etc.)
export function costoFleteActual() {
  return TRAMOS[0].costo
}

// Suma el flete de una lista de paquetes, cada uno a la tarifa de SU fecha.
// paquetes: [{ fecha }]
export function sumarFlete(paquetes) {
  return (paquetes || []).reduce((s, p) => s + costoFlete(p.fecha), 0)
}
