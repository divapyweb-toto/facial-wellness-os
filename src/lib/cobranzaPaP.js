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

// ¿PaP hace cobranza en esta ciudad?
export function tieneCobranzaPaP(ciudad) {
  const n = normalizarCiudadPaP(ciudad)
  if (!n) return false
  if (CIUDADES_COBRANZA[n]) return true
  // Coincidencia flexible: si el nombre normalizado empieza igual (ej. "ciudad
  // del este centro" → "ciudad del este"). Evita falsos negativos por sufijos.
  for (const c of Object.keys(CIUDADES_COBRANZA)) {
    if (n === c || n.startsWith(c + ' ') || c.startsWith(n + ' ')) return true
  }
  return false
}

// Zona PaP de la ciudad (o null si no tiene cobranza)
export function zonaPaP(ciudad) {
  const n = normalizarCiudadPaP(ciudad)
  const z = CIUDADES_COBRANZA[n]
  if (z) return z
  for (const c of Object.keys(CIUDADES_COBRANZA)) {
    if (n === c || n.startsWith(c + ' ')) return CIUDADES_COBRANZA[c]
  }
  return null
}

// Cantidad de ciudades con cobranza (para mostrar en la UI)
export const TOTAL_CIUDADES_PAP = new Set(Object.values(CIUDADES_COBRANZA).map((_, i) => i)).size
