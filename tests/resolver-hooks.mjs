// Resuelve los imports sin extensión de src/ (`from './estadosPaP'`).
// Vite los resuelve solo; Node exige el `.js`. Este hook permite que los tests
// corran contra el CÓDIGO REAL, sin copias ni adaptaciones que podrían
// divergir del que corre en producción — que es justo el punto de un test.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try {
      const url = new URL(specifier + '.js', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(specifier + '.js', context)
    } catch { /* cae al resolvedor normal */ }
  }
  return next(specifier, context)
}
