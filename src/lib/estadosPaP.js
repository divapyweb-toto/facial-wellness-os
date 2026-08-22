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

// ─── DOS POLÍTICAS DISTINTAS, NO CONFUNDIRLAS ──────────────
// `importeSano`  → para montos que NUNCA pueden ser negativos (lo que paga
//                  el cliente, lo que cobra el courier). Un negativo ahí es
//                  un dato roto y se lleva a 0.
// `esImporteCorrupto` → solo mide MAGNITUD (valor absoluto). Es el que usan
//                  los parsers de Lucero, porque ahí SÍ hay negativos
//                  legítimos: `neto_depositado` es lo que realmente cae al
//                  banco, y en un prepago o una devolución vos le DEBÉS el
//                  flete a Lucero. Casos reales medidos: FW-2031 devuelto
//                  con −25.000 y FW-2152 prepago con −30.000.
//
// Si alguna vez aplicás `importeSano` a `neto_depositado`, borrás esos
// negativos legítimos en silencio. No lo hagas: usá el chequeo de magnitud.

// Devuelve el importe usable: 0 si el valor es evidentemente basura.
export function importeSano(valor) {
  const n = typeof valor === 'number' ? valor : (parseInt(valor, 10) || 0)
  if (!Number.isFinite(n) || n < 0) return 0
  return n > IMPORTE_MAX_RAZONABLE ? 0 : n
}

// Tope de sanidad para CANTIDADES. El pedido más grande de la historia del
// negocio son 4 unidades; 100 deja aire de sobra y a la vez ataja el dato
// basura. Misma lógica que el importe: sin esto, una cantidad imposible
// desborda el integer de Postgres y tumba el lote entero.
export const CANTIDAD_MAX_RAZONABLE = 100

export function cantidadSana(valor) {
  const n = typeof valor === 'number' ? Math.round(valor) : (parseInt(valor, 10) || 0)
  if (!Number.isFinite(n) || n < 1) return 1
  return n > CANTIDAD_MAX_RAZONABLE ? 1 : n
}

export const esCantidadCorrupta = (valor) => {
  const n = typeof valor === 'number' ? Math.round(valor) : (parseInt(valor, 10) || 0)
  // Simétrico a propósito: una cantidad negativa es tan imposible como una
  // de mil millones, y colarse por abajo es igual de dañino.
  return !Number.isFinite(n) || Math.abs(n) > CANTIDAD_MAX_RAZONABLE
}

// OJO — el chequeo es por VALOR ABSOLUTO. La versión que solo miraba el tope
// superior dejaba pasar los negativos extremos: un -2.147.483.648 del archivo
// se colaba intacto y envenenaba los totales. Lo encontró el test de valores
// venenosos, no una lectura del código.
export const esImporteCorrupto = (valor) => {
  const n = typeof valor === 'number' ? valor : (parseInt(valor, 10) || 0)
  return !Number.isFinite(n) || Math.abs(n) > IMPORTE_MAX_RAZONABLE
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
  // Vínculo con la venta. Antes no existía: cada parte del sistema recalculaba
  // el cruce normalizando `n_referencia` por su cuenta, en 8 archivos distintos.
  'venta_id', 'vinculo_metodo', 'vinculo_at',
  // Datos del cliente SEGÚN EL COURIER. Los reportes los traen (Gestión de PaP
  // y el export de Lucero) y hasta ahora se descartaban al guardar, que es por
  // lo que los 199 paquetes viejos sin referencia ya no se pueden recuperar.
  // OJO: son lo que dice el courier, NO la fuente de verdad — el dato bueno
  // del cliente sigue viviendo en `ventas`. Sirven para cruzar y para auditar.
  'telefono_courier', 'nombre_courier', 'direccion_courier',
]

// Las que llegaron con la migración 001. Se listan aparte para poder detectar
// si la migración todavía no se corrió: si Postgres rechaza una de éstas, la
// carga sigue funcionando sin vincular en vez de fallar entera.
export const COLS_VINCULO = [
  'venta_id', 'vinculo_metodo', 'vinculo_at',
  'telefono_courier', 'nombre_courier', 'direccion_courier',
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
