// src/lib/beep.js
// Feedback sonoro para las estaciones de escaneo.
// Permite trabajar sin mirar la pantalla: un tono agudo corto = ok,
// uno grave y largo = algo anda mal (repetido, no encontrado, ya procesado).

export function beep(ok = true) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = ok ? 880 : 220
    gain.gain.setValueAtTime(0.08, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (ok ? 0.12 : 0.3))
    osc.start()
    osc.stop(ctx.currentTime + (ok ? 0.12 : 0.3))
    setTimeout(() => ctx.close(), 500)
  } catch {
    /* sin audio disponible: no pasa nada */
  }
}
