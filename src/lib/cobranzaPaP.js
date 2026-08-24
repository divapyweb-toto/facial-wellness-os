// src/lib/cobranzaPaP.js
// ═══════════════════════════════════════════════════════════
// CIUDADES CON COBRANZA DE PUNTO A PUNTO
//
// Punto a Punto solo hace cobranza contra entrega (COD) en estas ciudades.
// Si un pedido es de una ciudad que NO está acá, PaP no lo puede cobrar, así
// que no tiene sentido importarlo para despacho por PaP.
//
// Fuente: listado oficial de zonas de cobertura PaP 2026 (65 localidades).
// Si PaP suma o saca ciudades, se edita esta lista.
// ═══════════════════════════════════════════════════════════

// Zonas y su tiempo de gestión (informativo)
export const ZONAS_PAP = {
  gran_asuncion: { label: 'Gran Asunción', tiempo: '24HS' },
  central: { label: 'Central', tiempo: '24/48HS' },
  interior1: { label: 'Interior 1', tiempo: '24/72HS' },
  interior2: { label: 'Interior 2', tiempo: '72/96HS' },
}

// Ciudad → zona. Los nombres se guardan normalizados (sin tildes, minúscula).
const CIUDADES_COBRANZA = {
  // Gran Asunción
  'asuncion': 'gran_asuncion',
  'fernando de la mora': 'gran_asuncion',
  'lambare': 'gran_asuncion',
  'luque': 'gran_asuncion',
  'mariano roque alonso': 'gran_asuncion',
  'san lorenzo': 'gran_asuncion',
  // Central
  'aregua': 'central',
  'capiata': 'central',
  'itaugua': 'central',
  'limpio': 'central',
  'nemby': 'central',
  'san antonio': 'central',
  'villa elisa': 'central',
  // Interior 1
  'ita': 'interior1',
  'ypane': 'interior1',
  'villeta': 'interior1',
  'j. augusto saldivar': 'interior1',
  'julian augusto saldivar': 'interior1',
  'carapegua': 'interior1',
  'ypacarai': 'interior1',
  'ciudad del este': 'interior1',
  'san bernardino': 'interior1',
  'tobati': 'interior1',
  'altos': 'interior1',
  'atyra': 'interior1',
  'piribebuy': 'interior1',
  'encarnacion': 'interior1',
  'coronel oviedo': 'interior1',
  'eusebio ayala': 'interior1',
  'caacupe': 'interior1',
  'caaguazu': 'interior1',
  'campo 9': 'interior1',
  'coronel bogado': 'interior1',
  'presidente franco': 'interior1',
  'concepcion': 'interior1',
  'villarrica': 'interior1',
  'santa rita': 'interior1',
  'minga guazu': 'interior1',
  'paraguari': 'interior1',
  'hernandarias': 'interior1',
  'cambyreta': 'interior1',
  'san ignacio misiones': 'interior1',
  'san ignacio': 'interior1',
  // Interior 2
  'maria auxiliadora': 'interior2',
  'obligado': 'interior2',
  'pirayu': 'interior2',
  'pedro juan caballero': 'interior2',
  'san juan bautista': 'interior2',
  'pilar': 'interior2',
  'salto del guaira': 'interior2',
  'saltos del guaira': 'interior2',
  'caazapa': 'interior2',
  'san alberto': 'interior2',
  'guayaibi': 'interior2',
  'horqueta': 'interior2',
  'katuete': 'interior2',
  'liberacion': 'interior2',
  'villa hayes': 'interior2',
  'santa rosa del aguaray': 'interior2',
  'santani': 'interior2',
  'hohenau': 'interior2',
  'yby yau': 'interior2',
  'bella vista sur': 'interior2',
  'capitan miranda': 'interior2',
  'trinidad': 'interior2',
  'colonia independencia': 'interior2',
  'independencia': 'interior2',
  'juan leon mallorquin': 'interior2',
  'loma plata': 'interior2',
  // ── Agregadas 21/08/2026 desde la lista oficial de ruteo ──
  // Todas del interior profundo (incluido el Chaco), por eso interior2.
  // Si alguna resulta más rápida en la práctica, se baja a interior1.
  'ayolas': 'interior2',
  'chore': 'interior2',
  'curuguaty': 'interior2',
  'filadelfia': 'interior2',
  'itacurubi de la cordillera': 'interior1',
  'mariscal estigarribia': 'interior2',
  'natalio': 'interior2',
  'neuland': 'interior2',
  'puente kyjha': 'interior2',
  'san cristobal': 'interior2',
  'san jose de los arroyos': 'interior1',
  'san juan nepomuceno': 'interior2',
  'santa rosa del mbutuy': 'interior2',
}

// Normaliza un nombre de ciudad para comparar (sin tildes, minúscula, sin acentos)
export function normalizarCiudadPaP(raw) {
  if (!raw) return ''
  return String(raw)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita tildes
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Abreviaturas y apodos comunes que la gente escribe en Shopify.
// Se resuelven ANTES del matching flexible, para que "CDE" → Ciudad del Este.
const ABREVIATURAS = {
  'cde': 'ciudad del este',
  'cde capital': 'ciudad del este',
  'c del este': 'ciudad del este',
  'cdel este': 'ciudad del este',
  'este': 'ciudad del este',
  'asu': 'asuncion',
  'asuncion py': 'asuncion',
  'minga': 'minga guazu',
  'mariano': 'mariano roque alonso',
  'franco': 'presidente franco',
  'oviedo': 'coronel oviedo',
  'pedro juan': 'pedro juan caballero',
  's lorenzo': 'san lorenzo',
  'pjc': 'pedro juan caballero',
  'pj caballero': 'pedro juan caballero',
  'fdm': 'fernando de la mora',
  'fdo de la mora': 'fernando de la mora',
  'mra': 'mariano roque alonso',
  'm roque alonso': 'mariano roque alonso',
  'san lo': 'san lorenzo',
  'cnel oviedo': 'coronel oviedo',
  'coronel oviedo': 'coronel oviedo',
  'encarna': 'encarnacion',
  'pdte franco': 'presidente franco',
  'pte franco': 'presidente franco',
  'sj bautista': 'san juan bautista',
  'campo nueve': 'campo 9',
  'campo9': 'campo 9',
  'dr juan eulogio estigarribia': 'campo 9', // Campo 9 = Dr. J. E. Estigarribia
  'j augusto saldivar': 'j. augusto saldivar',
  'san ber': 'san bernardino',
}

// Distancia de Levenshtein (cuántas ediciones para pasar de a → b).
// Sirve para tolerar errores de tipeo: "estw" vs "este" = 1 edición.
function distancia(a, b) {
  const m = a.length, n = b.length
  if (Math.abs(m - n) > 3) return 99 // muy distintas, ni calcular
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + costo)
    }
  }
  return dp[m][n]
}

// ¿Dos nombres son "el mismo" tolerando typos? Umbral según el largo:
// nombres largos toleran más ediciones, cortos casi ninguna (para no confundir
// ciudades distintas que se parecen).
function esParecido(a, b) {
  if (a === b) return true
  const largo = Math.max(a.length, b.length)
  if (largo < 5) return false            // muy corto: solo exacto
  const d = distancia(a, b)
  if (largo >= 8) return d <= 2           // "ciudad del este" tolera 2 typos
  return d <= 1                           // 5–7 letras: 1 typo
}

// Resuelve el nombre real de una ciudad tras normalizar y aplicar abreviaturas.
function resolverNombre(raw) {
  const n = normalizarCiudadPaP(raw)
  if (!n) return ''
  return ABREVIATURAS[n] || n
}

// Busca, dentro de CUALQUIER lista de ciudades, la que corresponde al texto ingresado.
// Aplica normalización + abreviaturas + coincidencia parcial + tolerancia a typos.
// Se exporta para que otras transportadoras (Lucero) reutilicen la misma inteligencia
// en vez de duplicarla. `lista` = array de nombres ya normalizados.
export function emparejarCiudad(raw, lista) {
  const n = resolverNombre(raw)
  if (!n) return null
  // 1) exacto
  if (lista.includes(n)) return n
  // 2) el texto contiene el nombre de una ciudad de la lista
  //    (ej. "luque centro" → contiene "luque")
  for (const c of lista) {
    if (n === c) return c
    if (n.startsWith(c + ' ') || n.endsWith(' ' + c) || n.includes(' ' + c + ' ')) return c
  }
  // 3) tolerancia a errores de tipeo (Levenshtein)
  let mejor = null, mejorD = 99
  for (const c of lista) {
    if (esParecido(n, c)) {
      const d = distancia(n, c)
      if (d < mejorD) { mejorD = d; mejor = c }
    }
  }
  return mejor
}

// Busca la ciudad de cobranza que corresponde al texto ingresado.
// Devuelve la clave de la ciudad (normalizada) o null.
function buscarCiudad(raw) {
  return emparejarCiudad(raw, Object.keys(CIUDADES_COBRANZA))
}

// ¿PaP hace cobranza en esta ciudad?
// Lista de ciudades con cobranza PaP (para autocompletado en Despacho).
export const CIUDADES_PAP_LISTA = Object.keys(CIUDADES_COBRANZA)

export function tieneCobranzaPaP(ciudad) {
  return buscarCiudad(ciudad) != null
}

// Zona PaP de la ciudad (o null si no tiene cobranza)
export function zonaPaP(ciudad) {
  const c = buscarCiudad(ciudad)
  return c ? CIUDADES_COBRANZA[c] : null
}

// Cantidad de ciudades con cobranza (para mostrar en la UI)
export const TOTAL_CIUDADES_PAP = new Set(Object.values(CIUDADES_COBRANZA).map((_, i) => i)).size
