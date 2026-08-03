// src/lib/estadosPaP.js
// ═══════════════════════════════════════════════════════════
// FUENTE ÚNICA de la interpretación de los datos de Punto a Punto.
//
// Antes esta lógica estaba COPIADA en 5 archivos (Entregas, Rendición, Despacho,
// Campañas e Inteligencia). Cada copia tenía pequeñas diferencias, así que
// arreglar un bug en una dejaba las otras cuatro mal — fue exactamente lo que
// pasó con los importes corruptos de los borradores: se arregló la importación
// y Rendición siguió mostrando 2.948 millones porque recalcula con su copia.
//
// Si cambia una regla, se cambia ACÁ y vale para todo el sistema.
// ═══════════════════════════════════════════════════════════

// Tope de sanidad para el Importe que manda PaP.
// El pedido más caro razonable es Bebird Pro ×3 (~1.100.000). PaP manda los
// borradores con el Importe corrupto (se vieron valores de 900+ millones) y un
// solo registro basura envenena todas las sumas del sistema.
export const IMPORTE_MAX_RAZONABLE = 2000000

// Devuelve el importe usable: 0 si el valor es evidentemente basura.
export function importeSano(valor) {
  const n = typeof valor === 'number' ? valor : (parseInt(valor, 10) || 0)
  if (!Number.isFinite(n) || n < 0) return 0
  return n > IMPORTE_MAX_RAZONABLE ? 0 : n
}

export const esImporteCorrupto = (valor) => {
  const n = typeof valor === 'number' ? valor : (parseInt(valor, 10) || 0)
  return Number.isFinite(n) && n > IMPORTE_MAX_RAZONABLE
}

// ─── Columnas REALES de la tabla `entregas` ─────────────────
// Supabase rechaza el insert entero si le mandás una clave que no es columna
// ("Could not find the 'X' column of 'entregas' in the schema cache"), así que
// todo registro se filtra por esta lista antes de guardar.
// OJO: `nombre_cliente` y `telefono` NO son columnas de esta tabla — el nombre
// del cliente vive en `ventas` y se cruza por n_referencia.
export const COLS_ENTREGAS = [
  'nro_guia_pap', 'n_referencia', 'estado_pap', 'categoria', 'motivo', 'importe',
  'cobrado', 'costo_envio', 'fecha_ingreso', 'fecha_entrega', 'dias_entrega',
  'rendido', 'fecha_rendido', 'dias_rendicion', 'mensajero', 'ciudad', 'producto',
  'mes', 'transportadora',
  // Lucero neta el flete al momento de rendir (a diferencia de PaP, que deposita
  // el bruto). `neto_depositado` guarda lo que REALMENTE cae al banco por ese
  // ítem; `guia_transportadora` guarda el ID interno de Lucero (solo referencia,
  // no se usa para cruzar — eso lo hace `nro_guia_pap` vía guiaLucero()).
  'neto_depositado', 'guia_transportadora',
]

// Deja solo las claves que son columnas de `entregas`.
export function soloColumnasEntregas(reg) {
  const o = {}
  COLS_ENTREGAS.forEach(c => { if (reg?.[c] !== undefined) o[c] = reg[c] })
  return o
}

// Motivos que implican devolución aunque el estado sea intermedio (Custodio, etc.)
const MOTIVOS_DEVOLUCION = [
  'rechaz', 'inubicable', 'fuera de cobertura', 'fin de custodia',
  'problema de direccion', 'no desea', 'cancelad', 'no ingreso', 'rehus',
]

// Categoriza un registro de PaP.
//   'entregado'     → cobrado, cerrado a favor
//   'devuelto'      → cerrado en contra (el flete se paga igual)
//   'no_despachado' → NUNCA salió: borrador de PaP o no ingresó al sistema.
//                     No está en tránsito, no hay flete comprometido y no debe
//                     entrar en ninguna proyección de cierre.
//   'en_proceso'    → todavía volando
export function categorizarPaP(estado, motivo) {
  const e = (estado || '').toLowerCase()
  const m = (motivo || '').toLowerCase()
  if (e.includes('borrador') || e.includes('no ingreso')) return 'no_despachado'
  if (e.includes('entregado')) return 'entregado'
  if (e.includes('devuelto')) return 'devuelto'
  if (MOTIVOS_DEVOLUCION.some(k => m.includes(k))) return 'devuelto'
  if (e.includes('devolucion') || m.includes('devolucion')) return 'devuelto'
  return 'en_proceso'
}

// Normaliza un registro de `entregas` leído de la base: recalcula la categoría
// y sanea el importe. Usar SIEMPRE esto al leer, porque las filas viejas fueron
// guardadas antes de estas reglas y traen la categoría y el importe mal.
export function sanearEntrega(e) {
  const categoria = categorizarPaP(e?.estado_pap, e?.motivo)
  const importe = importeSano(e?.importe)
  // PaP deposita el BRUTO (el flete se factura aparte, nunca se descuenta del
  // depósito). Lucero neta el flete/multa ANTES de depositar, así que
  // `neto_depositado` puede ser menor que `importe`. `depositoReal` es "lo que
  // efectivamente cae al banco por este ítem" para cualquiera de las dos: si
  // no hay neto guardado (PaP, o Lucero viejo sin este campo), cae al bruto.
  const netoRaw = e?.neto_depositado
  const depositoReal = (netoRaw != null && netoRaw !== '') ? importeSano(netoRaw) : importe
  return {
    ...e,
    categoria,
    importe,
    depositoReal,
    // Solo lo entregado se considera cobrado.
    cobrado: categoria === 'entregado' ? importe : 0,
  }
}
