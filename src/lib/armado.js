// 26-10 (administrador): JawFlex en 3 unidades = el kit de los 3 niveles. Quien arma el paquete tiene que poner uno de
// cada uno. Se muestra en Despacho y en la guía; el aviso de Telegram del bot usa la misma regla
// (supabase/functions/_shared/telegram_formato.ts → notaArmado).
export const NOTA_ARMADO_JAWFLEX = 'ARMAR: 1 suave + 1 medio + 1 duro'

export function notaArmado(nombre, cantidad) {
  const n = String(nombre || '').toLowerCase()
  const esJaw = n.includes('jaw') || n.includes('mandíbula') || n.includes('mandibula') || n.includes('ejercitador')
  return esJaw && (parseInt(cantidad) || 1) === 3 ? NOTA_ARMADO_JAWFLEX : ''
}
