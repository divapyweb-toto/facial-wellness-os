// Arnés para que los tests corran contra el CÓDIGO REAL de src/, sin copias
// que podrían divergir del que corre en producción — que es el punto de un test.
//
// Resuelve dos diferencias entre Vite y Node:
//   1. imports sin extensión (`from './estadosPaP'`)
//   2. `import.meta.env`, que solo existe bajo Vite
import { existsSync, readFileSync } from 'node:fs'
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

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.includes('/src/') && url.endsWith('.js')) {
    const código = readFileSync(fileURLToPath(url), 'utf8')
    if (código.includes('import.meta.env')) {
      // Las variables de Vite no existen en Node. Se reemplazan por un objeto
      // vacío: los módulos caen a sus valores por defecto, que es justo lo que
      // querés en un test (sin conexión ni credenciales).
      // Se le da una URL válida de mentira: el cliente de Supabase valida el
      // formato al construirse. Ningún test toca la red — solo se necesita
      // que el módulo cargue para poder probar la lógica que hay alrededor.
      return { format: 'module', shortCircuit: true,
        source: código.replaceAll('import.meta.env',
          "({ VITE_SUPABASE_URL: 'http://localhost:54321', VITE_SUPABASE_ANON_KEY: 'test' })") }
    }
  }
  return next(url, context)
}
