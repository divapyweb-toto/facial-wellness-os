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
// respaldo. Esa tarifa ahora es EDITABLE desde Config (getFlete()).
// ═══════════════════════════════════════════════════════════
import { getFlete } from './config'

// Respaldo cableado por si la config no cargó (nunca debería, pero no rompe).
const FLETE_FALLBACK = 29000

// Tarifa vigente de Punto a Punto — editable desde Config. Se usa como respaldo
// cuando una venta no tiene costo_envio, y como default en venta nueva.
export function costoFleteActual() {
  return getFlete() || FLETE_FALLBACK
}

// Compat: algunos módulos importaban FLETE_RESPALDO como constante. Se mantiene
// como getter para no romperlos, leyendo el valor configurado.
export const FLETE_RESPALDO = costoFleteActual()

// Costo de flete de un paquete/venta: su costo_envio real, o el respaldo.
// Acepta tanto `costo_envio` (como viene de la BD) como `costoEnvio` (camel).
export function fleteDe(p) {
  const c = p?.costo_envio ?? p?.costoEnvio
  return (c != null && c > 0) ? c : costoFleteActual()
}

// Suma el flete de una lista de paquetes, cada uno con SU propio costo.
export function sumarFlete(paquetes) {
  return (paquetes || []).reduce((s, p) => s + fleteDe(p), 0)
}
