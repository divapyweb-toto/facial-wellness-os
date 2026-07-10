// src/lib/ciudades.js
// ═══════════════════════════════════════════════════════════
// NORMALIZADOR DE CIUDADES
//
// La ciudad la escribe el cliente a mano en el checkout (texto libre).
// Llegan cosas como "asuncion", "ASU", "Ciudad del este", "Fdo. de la Mora",
// "encarnacion, itapua". Sin normalizar, una misma ciudad se parte en cinco
// filas distintas y cualquier análisis por ciudad no sirve.
//
// Además de unificar el nombre, cada ciudad trae:
//   · departamento
//   · zona: 'local' (Alto Paraná, desde donde despachás) / 'metro' (Gran
//     Asunción y Central) / 'interior' (el resto). Sirve para ver si mandar
//     lejos te conviene o te come el flete.
//   · lat/lng aproximadas, para el mapa.
//
// Si una ciudad no se reconoce, NO se descarta ni se mezcla: aparece como
// viene, marcada, para que puedas agregarle un alias acá.
// ═══════════════════════════════════════════════════════════

// lat/lng aproximadas — sirven para ubicar burbujas en un mapa,
// no para navegación. Verificar antes de usarlas con precisión.
export const CIUDADES = {
  // ── Alto Paraná (zona local: despachás desde CDE) ──
  ciudad_del_este:      { nombre: 'Ciudad del Este',       depto: 'Alto Paraná', zona: 'local',    lat: -25.5095, lng: -54.6111, alias: ['cde', 'ciudad del este', 'c del este', 'cdel este', 'presidente stroessner', 'pte stroessner'] },
  presidente_franco:    { nombre: 'Presidente Franco',     depto: 'Alto Paraná', zona: 'local',    lat: -25.5333, lng: -54.6167, alias: ['presidente franco', 'pdte franco', 'pte franco', 'franco'] },
  hernandarias:         { nombre: 'Hernandarias',          depto: 'Alto Paraná', zona: 'local',    lat: -25.4000, lng: -54.6333, alias: ['hernandarias'] },
  minga_guazu:          { nombre: 'Minga Guazú',           depto: 'Alto Paraná', zona: 'local',    lat: -25.4833, lng: -54.8167, alias: ['minga guazu', 'minga'] },
  santa_rita:           { nombre: 'Santa Rita',            depto: 'Alto Paraná', zona: 'local',    lat: -25.8000, lng: -55.0667, alias: ['santa rita'] },
  santa_rosa_monday:    { nombre: 'Santa Rosa del Monday', depto: 'Alto Paraná', zona: 'local',    lat: -25.6167, lng: -54.9333, alias: ['santa rosa del monday', 'santa rosa monday'] },
  juan_leon_mallorquin: { nombre: 'Juan L. Mallorquín',    depto: 'Alto Paraná', zona: 'local',    lat: -25.4167, lng: -55.1500, alias: ['juan leon mallorquin', 'juan l mallorquin', 'mallorquin'] },

  // ── Asunción y Central (zona metro) ──
  asuncion:             { nombre: 'Asunción',              depto: 'Asunción',    zona: 'metro',    lat: -25.2637, lng: -57.5759, alias: ['asuncion', 'asu', 'capital', 'asuncion py'] },
  luque:                { nombre: 'Luque',                 depto: 'Central',     zona: 'metro',    lat: -25.2667, lng: -57.4833, alias: ['luque'] },
  san_lorenzo:          { nombre: 'San Lorenzo',           depto: 'Central',     zona: 'metro',    lat: -25.3400, lng: -57.5089, alias: ['san lorenzo', 's lorenzo'] },
  capiata:              { nombre: 'Capiatá',               depto: 'Central',     zona: 'metro',    lat: -25.3553, lng: -57.4456, alias: ['capiata'] },
  lambare:              { nombre: 'Lambaré',               depto: 'Central',     zona: 'metro',    lat: -25.3419, lng: -57.6069, alias: ['lambare'] },
  fernando_mora:        { nombre: 'Fernando de la Mora',   depto: 'Central',     zona: 'metro',    lat: -25.3200, lng: -57.5400, alias: ['fernando de la mora', 'fdo de la mora', 'fdo mora', 'fdm', 'fernando dela mora'] },
  limpio:               { nombre: 'Limpio',                depto: 'Central',     zona: 'metro',    lat: -25.1667, lng: -57.4833, alias: ['limpio'] },
  nemby:                { nombre: 'Ñemby',                 depto: 'Central',     zona: 'metro',    lat: -25.3947, lng: -57.5358, alias: ['nemby'] },
  mariano_roque_alonso: { nombre: 'Mariano R. Alonso',     depto: 'Central',     zona: 'metro',    lat: -25.2000, lng: -57.5333, alias: ['mariano roque alonso', 'mariano r alonso', 'mra', 'mariano'] },
  villa_elisa:          { nombre: 'Villa Elisa',           depto: 'Central',     zona: 'metro',    lat: -25.3667, lng: -57.5900, alias: ['villa elisa'] },
  san_antonio:          { nombre: 'San Antonio',           depto: 'Central',     zona: 'metro',    lat: -25.4167, lng: -57.5500, alias: ['san antonio'] },
  itaugua:              { nombre: 'Itauguá',               depto: 'Central',     zona: 'metro',    lat: -25.3925, lng: -57.3539, alias: ['itaugua'] },
  aregua:               { nombre: 'Areguá',                depto: 'Central',     zona: 'metro',    lat: -25.3078, lng: -57.3856, alias: ['aregua'] },
  guarambare:           { nombre: 'Guarambaré',            depto: 'Central',     zona: 'metro',    lat: -25.4894, lng: -57.4550, alias: ['guarambare'] },
  ypane:                { nombre: 'Ypané',                 depto: 'Central',     zona: 'metro',    lat: -25.4667, lng: -57.5333, alias: ['ypane'] },
  ita:                  { nombre: 'Itá',                   depto: 'Central',     zona: 'metro',    lat: -25.5075, lng: -57.3689, alias: ['ita'] },
  ypacarai:             { nombre: 'Ypacaraí',              depto: 'Central',     zona: 'metro',    lat: -25.4033, lng: -57.2839, alias: ['ypacarai'] },
  nueva_italia:         { nombre: 'Nueva Italia',          depto: 'Central',     zona: 'metro',    lat: -25.6167, lng: -57.5167, alias: ['nueva italia'] },
  villa_hayes:          { nombre: 'Villa Hayes',           depto: 'Pdte. Hayes', zona: 'metro',    lat: -25.0900, lng: -57.5239, alias: ['villa hayes'] },

  // ── Interior ──
  encarnacion:          { nombre: 'Encarnación',           depto: 'Itapúa',      zona: 'interior', lat: -27.3306, lng: -55.8667, alias: ['encarnacion'] },
  coronel_oviedo:       { nombre: 'Coronel Oviedo',        depto: 'Caaguazú',    zona: 'interior', lat: -25.4467, lng: -56.4400, alias: ['coronel oviedo', 'cnel oviedo', 'oviedo'] },
  caaguazu:             { nombre: 'Caaguazú',              depto: 'Caaguazú',    zona: 'interior', lat: -25.4667, lng: -56.0167, alias: ['caaguazu'] },
  pedro_juan_caballero: { nombre: 'Pedro Juan Caballero',  depto: 'Amambay',     zona: 'interior', lat: -22.5472, lng: -55.7333, alias: ['pedro juan caballero', 'pjc', 'pedro juan'] },
  villarrica:           { nombre: 'Villarrica',            depto: 'Guairá',      zona: 'interior', lat: -25.7500, lng: -56.4333, alias: ['villarrica'] },
  concepcion:           { nombre: 'Concepción',            depto: 'Concepción',  zona: 'interior', lat: -23.4000, lng: -57.4333, alias: ['concepcion'] },
  pilar:                { nombre: 'Pilar',                 depto: 'Ñeembucú',    zona: 'interior', lat: -26.8667, lng: -58.3000, alias: ['pilar'] },
  caacupe:              { nombre: 'Caacupé',               depto: 'Cordillera',  zona: 'interior', lat: -25.3861, lng: -57.1417, alias: ['caacupe'] },
  tobati:               { nombre: 'Tobatí',                depto: 'Cordillera',  zona: 'interior', lat: -25.2667, lng: -57.0833, alias: ['tobati'] },
  paraguari:            { nombre: 'Paraguarí',             depto: 'Paraguarí',   zona: 'interior', lat: -25.6333, lng: -57.1500, alias: ['paraguari'] },
  carapegua:            { nombre: 'Carapeguá',             depto: 'Paraguarí',   zona: 'interior', lat: -25.7833, lng: -57.2333, alias: ['carapegua'] },
  yaguaron:             { nombre: 'Yaguarón',              depto: 'Paraguarí',   zona: 'interior', lat: -25.5667, lng: -57.2667, alias: ['yaguaron'] },
  salto_guaira:         { nombre: 'Salto del Guairá',      depto: 'Canindeyú',   zona: 'interior', lat: -24.0567, lng: -54.3067, alias: ['salto del guaira', 'salto guaira'] },
  curuguaty:            { nombre: 'Curuguaty',             depto: 'Canindeyú',   zona: 'interior', lat: -24.5167, lng: -55.6833, alias: ['curuguaty'] },
  katuete:              { nombre: 'Katueté',               depto: 'Canindeyú',   zona: 'interior', lat: -24.2833, lng: -54.7500, alias: ['katuete'] },
  san_estanislao:       { nombre: 'San Estanislao',        depto: 'San Pedro',   zona: 'interior', lat: -24.6500, lng: -56.4333, alias: ['san estanislao', 'santani'] },
  san_juan_bautista:    { nombre: 'San Juan Bautista',     depto: 'Misiones',    zona: 'interior', lat: -26.6667, lng: -57.1500, alias: ['san juan bautista'] },
  ayolas:               { nombre: 'Ayolas',                depto: 'Misiones',    zona: 'interior', lat: -27.3833, lng: -56.9000, alias: ['ayolas'] },
  coronel_bogado:       { nombre: 'Coronel Bogado',        depto: 'Itapúa',      zona: 'interior', lat: -27.1667, lng: -56.2333, alias: ['coronel bogado', 'cnel bogado'] },
  filadelfia:           { nombre: 'Filadelfia',            depto: 'Boquerón',    zona: 'interior', lat: -22.3500, lng: -60.0333, alias: ['filadelfia'] },
  loma_plata:           { nombre: 'Loma Plata',            depto: 'Boquerón',    zona: 'interior', lat: -22.3667, lng: -59.8333, alias: ['loma plata'] },
}

// Índice alias → clave, ordenado por longitud desc para que
// "san juan bautista" gane antes que un alias más corto.
const INDICE = (() => {
  const pares = []
  for (const [clave, c] of Object.entries(CIUDADES)) {
    for (const a of c.alias) pares.push([a, clave])
  }
  return pares.sort((x, y) => y[0].length - x[0].length)
})()

// Deja el texto comparable: sin acentos, minúsculas, sin puntuación.
// "Fdo. de la Mora - Zona Sur" → "fdo de la mora zona sur"
export function limpiarTexto(raw) {
  return String(raw || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos (y ñ → n)
    .toLowerCase()
    .replace(/[.,;:/\\|()[\]{}"'`]/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const titulo = (s) => s.replace(/\b\w/g, c => c.toUpperCase())

// Normaliza una ciudad escrita a mano.
// → { clave, nombre, depto, zona, lat, lng, reconocida }
export function normalizarCiudad(raw) {
  const limpio = limpiarTexto(raw)
  if (!limpio) {
    return { clave: '_sin_dato', nombre: 'Sin ciudad', depto: '—', zona: 'desconocida', lat: null, lng: null, reconocida: false }
  }

  // 1) Coincidencia exacta
  for (const [alias, clave] of INDICE) {
    if (limpio === alias) return { clave, ...CIUDADES[clave], reconocida: true }
  }

  // 2) El alias aparece como palabra completa dentro del texto
  //    ("encarnacion itapua" → encarnacion · "luque zona norte" → luque)
  for (const [alias, clave] of INDICE) {
    const re = new RegExp(`(^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`)
    if (re.test(limpio)) return { clave, ...CIUDADES[clave], reconocida: true }
  }

  // 3) No reconocida: se muestra como vino, agrupada por su forma limpia.
  //    No se mezcla con nada. Si aparece seguido, agregale un alias arriba.
  return { clave: `_${limpio.replace(/\s/g, '_')}`, nombre: titulo(limpio), depto: '—', zona: 'desconocida', lat: null, lng: null, reconocida: false }
}

// Etiquetas legibles de zona
export const ZONAS = {
  local:       { label: 'Alto Paraná (local)', color: '#22c55e' },
  metro:       { label: 'Gran Asunción',       color: '#3b86c9' },
  interior:    { label: 'Interior',            color: '#e8973a' },
  desconocida: { label: 'Sin clasificar',      color: '#6b7280' },
}
