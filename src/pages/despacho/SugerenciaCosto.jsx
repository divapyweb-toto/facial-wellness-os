// src/pages/despacho/SugerenciaCosto.jsx · 20-10-2026
// Línea chica por pedido: qué courier conviene por costo por entregado (flete ÷ tasa de entrega), con las cuentas.
// Solo informa: NO asigna nada (la preasignación de sugerirTransportadora sigue igual). Si difiere de la
// transportadora asignada, se marca en amarillo. Sin tabla de tarifas cargada no muestra nada.
import { sugerirCourier, textoSugerenciaCosto } from '../../lib/tarifasCourier'
import { labelTransportadora } from '../../lib/transportadoras'

export default function SugerenciaCosto({ ciudad, cod = true, asignada }) {
  const s = sugerirCourier(ciudad, { cod })
  const t = textoSugerenciaCosto(s, { cod })
  if (!t) return null
  const difiere = t.nivel === 'ok' && !!asignada && asignada !== 'otra' && s.sugerido !== asignada
  const color = t.nivel === 'sin_cobertura' ? 'var(--red)' : difiere ? 'var(--yellow)' : 'var(--text-dim)'
  return (
    <div
      style={{ fontSize: 9, color, whiteSpace: 'normal', maxWidth: 260, lineHeight: 1.3, fontWeight: difiere || t.nivel === 'sin_cobertura' ? 600 : 400 }}
      title="Costo por entregado = flete ÷ tasa de entrega del courier. Solo informa: no cambia la transportadora."
    >
      {t.texto}{difiere ? ` · ≠ asignada (${labelTransportadora(asignada)})` : ''}
    </div>
  )
}
