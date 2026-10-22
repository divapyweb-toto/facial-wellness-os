// src/pages/despacho/LineaMotor.jsx · 21-10-2026
// Línea chica por pedido con lo que decide el motor de courier (ganancia esperada), con el motivo que armó la base.
// Motor apagado: es una SUGERENCIA (amarillo) y no cambia nada. Motor activo: informa por qué se asignó ese courier;
// se marca en amarillo si el courier que quedó es otro (cambio manual o venta ya cargada).
import { textoMotor } from '../../lib/motorCourier'
import { labelTransportadora } from '../../lib/transportadoras'

export default function LineaMotor({ decision, asignada, activo = false }) {
  const t = textoMotor(decision)
  if (!t) return null
  const sinCob = decision.sin_cobertura === true
  const difiere = !!decision.ganador && !!asignada && asignada !== 'otra' && asignada !== decision.ganador
  const amarillo = !sinCob && (!activo || difiere)
  const color = sinCob ? 'var(--red)' : amarillo ? 'var(--yellow)' : 'var(--text-dim)'
  return (
    <div
      style={{ fontSize: 9, color, whiteSpace: 'normal', maxWidth: 260, lineHeight: 1.3, fontWeight: sinCob || difiere ? 600 : 400 }}
      title={activo
        ? 'Motor de courier: elige el que deja más ganancia esperada. Si lo cambiás a mano, queda registrado.'
        : 'Motor de courier (apagado): solo sugiere, no cambia la transportadora.'}
    >
      {activo ? 'Motor' : 'Sugerencia motor'}: {t}{difiere ? ` · ≠ asignada (${labelTransportadora(asignada)})` : ''}
    </div>
  )
}
