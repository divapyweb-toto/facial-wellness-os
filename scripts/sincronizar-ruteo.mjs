#!/usr/bin/env node
// scripts/sincronizar-ruteo.mjs · 12-10: copia el ruteo de la web a las Edge Functions.
//
// Las Edge Functions (Deno) no pueden importar de src/. Este script genera:
//   supabase/functions/_shared/transportadoras.js  ← src/lib/transportadoras.js
//   supabase/functions/_shared/cobranzaPaP.js      ← src/lib/cobranzaPaP.js
// con los imports locales resueltos para Deno (ESM puro, con extensión, sin Supabase):
//   './config'      → valores de fábrica: en las funciones no hay Config cargada (flete = DEFAULTS.flete_pap de
//                     src/lib/config.js; tarifario de Lucero vacío = el de fábrica de transportadoras.js).
//   './cobranzaPaP' → './cobranzaPaP.js' (la copia de al lado).
//   './recompra'    → solo familiaProducto, copiada tal cual (recompra.js trae Supabase y la tienda).
// Si transportadoras.js suma otro import, el script frena con un error en vez de generar una copia rota.
//
// Uso:  node scripts/sincronizar-ruteo.mjs              escribe las copias
//       node scripts/sincronizar-ruteo.mjs --verificar  no escribe; sale con error si están desactualizadas
// El test supabase/functions/_shared/transportadoras_sync_test.ts falla si se cambia el ruteo y no se corre esto.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Rutas relativas a la raíz del repo. */
export const FUENTES = {
  transportadoras: 'src/lib/transportadoras.js',
  cobranza: 'src/lib/cobranzaPaP.js',
  config: 'src/lib/config.js',
  recompra: 'src/lib/recompra.js',
}
export const DESTINO = 'supabase/functions/_shared'

const cabecera = (origen) => [
  `// COPIA GENERADA de ${origen} por scripts/sincronizar-ruteo.mjs: no editar a mano.`,
  `// Para cambiarla, editá ${origen} y corré: node scripts/sincronizar-ruteo.mjs`,
  '// El test _shared/transportadoras_sync_test.ts falla si esta copia queda vieja.',
  '// deno-lint-ignore-file',
  '// deno-fmt-ignore-file',
  '',
].join('\n')

const RE_IMPORT = /^import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm
const nombres = (lista) => lista.split(',').map((s) => s.trim()).filter(Boolean)

function falla(msg) {
  throw new Error(`sincronizar-ruteo: ${msg}`)
}

/** Valor de fábrica del flete de PaP (DEFAULTS.flete_pap en src/lib/config.js). */
function fleteDeFabrica(config) {
  const m = /\bflete_pap:\s*(\d+)/.exec(config)
  if (!m) falla('no encontré flete_pap en DEFAULTS de src/lib/config.js')
  return Number(m[1])
}

/** Código de `export function familiaProducto(...) {...}` de recompra.js, sin el export. */
function familiaProductoDe(recompra) {
  const m = /^export function familiaProducto\([^)]*\) \{\n[\s\S]*?\n\}\n/m.exec(recompra)
  if (!m) falla('no encontré "export function familiaProducto" en src/lib/recompra.js')
  return m[0].replace(/^export /, '')
}

/** Reemplazo de cada import local de transportadoras.js. */
function reemplazoImport(modulo, lista, fuentes) {
  const permitidos = (ok) => {
    const otros = lista.filter((n) => !ok.includes(n))
    if (otros.length) falla(`transportadoras.js importa ${otros.join(', ')} de '${modulo}' y la copia no lo resuelve: agregalo a scripts/sincronizar-ruteo.mjs`)
  }
  if (modulo === './config') {
    permitidos(['getFlete', 'getTarifasLuceroJSON'])
    const shim = {
      getFlete: `const getFlete = () => ${fleteDeFabrica(fuentes.config)} // DEFAULTS.flete_pap de src/lib/config.js`,
      getTarifasLuceroJSON: "const getTarifasLuceroJSON = () => '' // vacío = tarifario de fábrica (TARIFAS_LUCERO_INFO)",
    }
    return ['// [sincronizar-ruteo] en las Edge Functions no hay Config cargada: rigen los valores de fábrica.', ...lista.map((n) => shim[n])].join('\n')
  }
  if (modulo === './cobranzaPaP') return `import { ${lista.join(', ')} } from './cobranzaPaP.js'`
  if (modulo === './recompra') {
    permitidos(['familiaProducto'])
    return `// [sincronizar-ruteo] copiada de src/lib/recompra.js (ese módulo trae Supabase y la tienda).\n${familiaProductoDe(fuentes.recompra).trimEnd()}`
  }
  return falla(`import no previsto en transportadoras.js: '${modulo}'. Agregalo a scripts/sincronizar-ruteo.mjs`)
}

/**
 * Contenido de las copias a partir del texto de las fuentes. Función pura: la usan este script y el test.
 * @param {{ transportadoras: string, cobranza: string, config: string, recompra: string }} fuentes
 * @returns {Record<string, string>} nombre de archivo en _shared → contenido
 */
export function generarCopias(fuentes) {
  if (/^\s*import\s/m.test(fuentes.cobranza)) falla('src/lib/cobranzaPaP.js ahora importa otro módulo: agregalo a scripts/sincronizar-ruteo.mjs')
  const transportadoras = fuentes.transportadoras.replace(RE_IMPORT, (_l, lista, modulo) => reemplazoImport(modulo, nombres(lista), fuentes))
  if (/^\s*import\s(?!\{[^}]*\}\s+from\s+'\.\/cobranzaPaP\.js')/m.test(transportadoras)) {
    falla('transportadoras.js tiene un import con otra forma (default, *, varias líneas): adaptá scripts/sincronizar-ruteo.mjs')
  }
  return {
    'transportadoras.js': cabecera(FUENTES.transportadoras) + transportadoras,
    'cobranzaPaP.js': cabecera(FUENTES.cobranza) + fuentes.cobranza,
  }
}

function main() {
  const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const leer = (p) => readFileSync(resolve(raiz, p), 'utf8')
  const fuentes = Object.fromEntries(Object.entries(FUENTES).map(([k, p]) => [k, leer(p)]))
  const copias = generarCopias(fuentes)
  const verificar = process.argv.includes('--verificar')
  let viejas = 0
  for (const [nombre, contenido] of Object.entries(copias)) {
    const ruta = `${DESTINO}/${nombre}`
    let actual = null
    try { actual = leer(ruta) } catch { /* todavía no existe */ }
    if (actual === contenido) { console.log(`= ${ruta} (al día)`); continue }
    viejas++
    if (verificar) console.log(`✗ ${ruta} desactualizada`)
    else { writeFileSync(resolve(raiz, ruta), contenido); console.log(`✓ ${ruta} actualizada`) }
  }
  if (verificar && viejas) {
    console.error('Corré: node scripts/sincronizar-ruteo.mjs')
    process.exit(1)
  }
}

// Solo corre si se ejecuta directo (el test de Deno importa generarCopias sin escribir nada).
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()
