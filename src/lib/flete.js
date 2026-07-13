// src/lib/flete.js
// ═══════════════════════════════════════════════════════════
// COSTO DE FLETE DE CADA VENTA
//
// El costo de envío NO es una tarifa fija: depende de la transportadora que
// se usó (Punto a Punto, Multienvíos, Tiemsa, TSI…, cada una con su precio).
// Por eso cada venta guarda su propio `costo_envio` al crearse, tomado de la
// transportadora elegida en ese momento. Ese es el dato real e histórico.
//
// Los reportes usan ESE costo_envio. Solo si una venta no lo tiene cargado
// (importada sin dato, o muy vieja) se usa la tarifa vigente de PaP como
// respaldo, para no romper el cálculo.
// ═══════════════════════════════════════════════════════════

// Tarifa vigente de Punto a Punto — se usa como respaldo cuando una venta no
// tiene costo_envio, y como valor por defecto en formularios de venta nueva.
export const FLETE_RESPALDO = 29000

// Costo de flete de un paquete/venta: su costo_envio real, o el respaldo.
// Acepta tanto `costo_envio` (como viene de la BD) como `costoEnvio` (camel).
export function fleteDe(p) {
  const c = p?.costo_envio ?? p?.costoEnvio
  return (c != null && c > 0) ? c : FLETE_RESPALDO
}

// Suma el flete de una lista de paquetes, cada uno con SU propio costo.
export function sumarFlete(paquetes) {
  return (paquetes || []).reduce((s, p) => s + fleteDe(p), 0)
}

// Tarifa vigente hoy (valor por defecto para una venta nueva cuando todavía
// no se eligió transportadora). Es la de PaP.
export function costoFleteActual() {
  return FLETE_RESPALDO
}
