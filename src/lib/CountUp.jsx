// src/lib/CountUp.jsx
// ═══════════════════════════════════════════════════════════
// Número que "cuenta" hacia arriba con animación suave.
// Uso: <CountUp value={1250000} format={formatGs} />
//      <CountUp value={42} />  (números simples)
//
// Respeta prefers-reduced-motion (accesibilidad).
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useRef } from 'react'

export default function CountUp({ value = 0, format = (n) => Math.round(n).toLocaleString('es-PY'), duration = 700, className, style }) {
  const [display, setDisplay] = useState(value)
  const rafRef = useRef(null)
  const fromRef = useRef(value)
  const startRef = useRef(null)

  useEffect(() => {
    // Si el usuario prefiere menos movimiento, saltar directo al valor
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (reduce || duration <= 0) { setDisplay(value); return }

    const desde = fromRef.current
    const hasta = value
    if (desde === hasta) return
    startRef.current = null

    const step = (ts) => {
      if (startRef.current === null) startRef.current = ts
      const elapsed = ts - startRef.current
      const t = Math.min(1, elapsed / duration)
      // easeOutCubic — arranca rápido, frena suave
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(desde + (hasta - desde) * eased)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        setDisplay(hasta)
        fromRef.current = hasta
      }
    }
    rafRef.current = requestAnimationFrame(step)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [value, duration])

  return <span className={className} style={style}>{format(display)}</span>
}
