// COPIA GENERADA de src/lib/transportadoras.js por scripts/sincronizar-ruteo.mjs: no editar a mano.
// Para cambiarla, editá src/lib/transportadoras.js y corré: node scripts/sincronizar-ruteo.mjs
// El test _shared/transportadoras_sync_test.ts falla si esta copia queda vieja.
// deno-lint-ignore-file
// deno-fmt-ignore-file
// src/lib/transportadoras.js
// ═══════════════════════════════════════════════════════════
// TRANSPORTADORAS
//
// El negocio usa DOS transportadoras COD en paralelo:
//
//   · Punto a Punto (PAP) — 65 ciudades, tarifa PLANA (editable en Config),
//     rinde la plata en ~7 días o más.
//   · Lucero del Este   — 16 ciudades, tarifa POR CIUDAD, rinde al día siguiente.
//
// Las dos cobran el flete IGUAL entregue o no (las devoluciones se pagan).
// Por eso la decisión de cuál usar en cada ciudad no es solo el precio: una
// entrega adicional vale ~102.000 Gs. de margen, mucho más que la diferencia
// de flete. Cada tarifa de Lucero exige una tasa de entrega mínima para
// empatar a PaP — ver TASA_EQUILIBRIO más abajo.
//
// Decisión vigente (julio 2026): Lucero se lleva las 11 ciudades donde su
// tarifa es ≤ 30.000; PaP se queda con las de 35.000 y con las otras 49.
// ═══════════════════════════════════════════════════════════
// [sincronizar-ruteo] en las Edge Functions no hay Config cargada: rigen los valores de fábrica.
const getFlete = () => 29000 // DEFAULTS.flete_pap de src/lib/config.js
const getTarifasLuceroJSON = () => '' // vacío = tarifario de fábrica (TARIFAS_LUCERO_INFO)
import { tieneCobranzaPaP, emparejarCiudad, normalizarCiudadPaP, CIUDADES_PAP_LISTA } from './cobranzaPaP.js'
// [sincronizar-ruteo] copiada de src/lib/recompra.js (ese módulo trae Supabase y la tienda).
function familiaProducto(nombre) {
  const n = (nombre || '').toLowerCase()
  if (!n) return null
  // 26-10: Kit Deporte (botella + tiras) antes que tiras y botella: su nombre menciona a los dos. "deport" solo no
  // alcanza: la botella sola pasa a llamarse "Botella Deportiva Flexible".
  if (n.includes('kit deporte') || n.includes('kitdeporte') || (n.includes('botella') && (n.includes('tira') || n.includes('nasal')))) return 'kit'
  if (n.includes('gudair') || (n.includes('tira') && n.includes('parche'))) return 'gudair'
  if (n.includes('bebird')) return 'bebird'
  if (n.includes('raspador') || n.includes('lengua') || n.includes('limpiador') || n.includes('tongue') || n.includes('scraper')) return 'lengua'
  if (n.includes('parche') || n.includes('bucal') || n.includes('mouth') || n.includes('tape')) return 'parche'
  if (n.includes('tira') || n.includes('nasal') || n.includes('nose') || n.includes('strip')) return 'nasal'
  if (n.includes('jaw') || n.includes('mandíbula') || n.includes('mandibula') || n.includes('ejercitador')) return 'jaw'
  if (n.includes('botella') || n.includes('flexible') || n.includes('bottle') || n.includes('flow')) return 'botella'
  return null
}
// [sincronizar-ruteo] tarifas de la base (src/lib/tarifasCourier.js): en las funciones no se cargan, rige lo de antes.
const tarifaCourier = () => null
const tarifasCourierCargadas = () => false

export const TRANSPORTADORAS = {
  pap: {
    id: 'pap',
    label: 'PAP',                     // lo que se imprime en la guía
    nombre: 'Punto a Punto',
    tarifaPlana: true,
    diasRendicion: 7,
  },
  lucero: {
    id: 'lucero',
    label: 'Lucero',                  // lo que se imprime en la guía
    nombre: 'Lucero del Este',
    tarifaPlana: false,
    diasRendicion: 1,
  },
  otra: {
    id: 'otra',
    label: 'Otra',                    // lo que se imprime en la guía
    nombre: 'Otra transportadora',
    tarifaPlana: false,
    diasRendicion: null,              // desconocido: no hay conciliación automática para esta
  },
}

export const IDS_TRANSPORTADORA = Object.keys(TRANSPORTADORAS)
export const esTransportadoraValida = (id) => IDS_TRANSPORTADORA.includes(id)

// Etiqueta para imprimir en la guía. Si el dato viniera vacío o corrupto,
// cae en PAP (que es el default histórico de todas las ventas viejas).
export function labelTransportadora(id) {
  return (TRANSPORTADORAS[id] || TRANSPORTADORAS.pap).label
}

// ─── Tarifario Lucero del Este — VALORES DE FÁBRICA ─────────
// Desde F-04 este objeto es el RESPALDO: el tarifario vigente es el que se
// edita en Config (clave 'tarifas_lucero'); si está vacío o roto, rige esto.
// Todo el módulo lee vía infoLucero() — no usar este objeto directo.
// [precio, velocidad]  ·  velocidad: 'diaria' (24hs) | 'frecuente' (24-48hs) | 'programada' (48-72hs, 1-2 veces por semana)
// Claves normalizadas (minúscula, sin tildes) para cruzar con lo que escribe el cliente.
// OJO: esta lista REEMPLAZA el tarifario anterior — todas las ciudades subieron
// 5.000 y Minga Guazú 10.000. Con estos precios Lucero solo es más barato que
// PaP en Ciudad del Este.
// TODO: mover a la tabla `tarifas_envio` para tener histórico de precios.
export const TARIFAS_LUCERO_INFO = {
  'ciudad del este': [25000, 'diaria'],             // Ciudad del Este
  'asuncion': [30000, 'diaria'],                    // Asunción
  'hernandarias': [30000, 'frecuente'],             // Hernandarias
  'lambare': [30000, 'diaria'],                     // Lambaré
  'presidente franco': [30000, 'frecuente'],        // Presidente Franco
  'san lorenzo': [30000, 'diaria'],                 // San Lorenzo
  'fernando de la mora': [35000, 'frecuente'],      // Fernando de la Mora
  'loma pyta': [35000, 'frecuente'],                // Loma Pytã
  'luque': [35000, 'frecuente'],                    // Luque
  'mariano roque alonso': [35000, 'frecuente'],     // Mariano Roque Alonso
  'thompson': [35000, 'frecuente'],                 // Thompson
  'villa elisa': [35000, 'frecuente'],              // Villa Elisa
  'villeta': [35000, 'frecuente'],                  // Villeta
  'altos': [40000, 'programada'],                   // Altos (Cordillera)
  'aregua': [40000, 'programada'],                  // Areguá
  'atyra': [40000, 'programada'],                   // Atyrá
  'barrero': [40000, 'programada'],                 // Barrero
  'blas garay': [40000, 'programada'],              // Blas Garay
  'caacupe': [40000, 'programada'],                 // Caacupé
  'caaguazu': [40000, 'programada'],                // Caaguazú
  'cambyreta': [40000, 'programada'],               // Cambyreta
  'campo 9': [40000, 'programada'],                 // Campo 9
  'capiata': [40000, 'programada'],                 // Capiatá
  'capitan miranda': [40000, 'programada'],         // Capitán Miranda
  'carmen del parana': [40000, 'programada'],       // Carmen del Paraná
  'colonia torin': [40000, 'programada'],           // Colonia Torín
  'coronel oviedo': [40000, 'programada'],          // Coronel Oviedo
  'dr. j. eulogio estigarribia': [40000, 'programada'],// Dr. J. Eulogio Estigarribia
  'encarnacion': [40000, 'programada'],             // Encarnación
  'eusebio ayala': [40000, 'programada'],           // Eusebio Ayala
  'fram': [40000, 'programada'],                    // Fram
  'guarambare': [40000, 'programada'],              // Guarambaré
  'ita': [40000, 'programada'],                     // Itá
  'itacurubi': [40000, 'programada'],               // Itacurubí
  'itagua': [40000, 'programada'],                  // Itaguá
  'j. augusto saldivar': [40000, 'programada'],     // J. Augusto Saldívar
  'jose domingo ocampos': [40000, 'programada'],    // José Domingo Ocampos
  'juan e. o\'leary': [40000, 'programada'],         // Juan E. O'Leary
  'juan leon mallorquin': [40000, 'programada'],    // Juan León Mallorquín
  'juan manuel frutos': [40000, 'programada'],      // Juan Manuel Frutos
  'la paz': [40000, 'programada'],                  // La paz
  'limpio': [40000, 'programada'],                  // Limpio
  'los cedrales': [40000, 'programada'],            // Los Cedrales
  'mauricio jose troche': [40000, 'programada'],    // Mauricio Jose Troche
  'mbocajaty': [40000, 'programada'],               // Mbocajaty del Guairá
  'minga guazu': [40000, 'frecuente'],              // Minga Guazú
  'naranjal': [40000, 'programada'],                // Naranjal
  'natalicio talavera': [40000, 'programada'],      // Natalicio Talavera
  'nemby': [40000, 'programada'],                   // Ñemby
  'nueva italia': [40000, 'programada'],            // Nueva Italia
  'paraguari': [40000, 'programada'],               // Paraguarí
  'pastoreo': [40000, 'programada'],                // Pastoreo
  'piribebuy': [40000, 'programada'],               // Piribebuy
  'san antonio': [40000, 'programada'],             // San Antonio
  'san bernardino': [40000, 'programada'],          // San Bernardino
  'san juan del parana': [40000, 'programada'],     // San Juan Del Paraná
  'santa rita': [40000, 'programada'],              // Santa Rita
  'santa rosa del monday': [40000, 'programada'],   // Santa Rosa del Monday
  'tavapy': [40000, 'programada'],                  // Tavapy
  'tobati': [40000, 'programada'],                  // Tobatí
  'yaguaron': [40000, 'programada'],                // Yaguarón
  'yataity': [40000, 'programada'],                 // Yataity del Guairá
  'yguazu': [40000, 'programada'],                  // Yguazú
  'ypacarai': [40000, 'programada'],                // Ypacaraí
  'ypane': [40000, 'programada'],                   // Ypané
  'pedro juan caballero': [45000, 'programada'],    // Pedro Juan Caballero
  'san cristobal': [45000, 'programada'],           // San Cristóbal
  'villarrica': [45000, 'programada'],              // Villarrica
  'carapegua': [50000, 'programada'],               // Carapeguá
  'san jose de los arroyos': [50000, 'programada'], // San José de los Arroyos
  'villa hayes': [50000, 'programada'],             // Villa Hayes
}

export const VELOCIDADES_LUCERO = ['diaria', 'frecuente', 'programada']

// Clave normalizada del tarifario: minúscula, sin tildes, espacios simples.
// La MISMA normalización con la que están escritas las claves de fábrica.
export const claveCiudadLucero = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

// ── Tarifario VIGENTE ──
// Se parsea el JSON de Config en cada acceso: es barato (~20 ciudades) y
// evita otro caché congelado al importar — exactamente el bug F-01 del flete.
// JSON vacío/roto/sin filas válidas → fábrica: mejor la tarifa vieja que un
// despacho frenado por un error de tipeo en Config.
export function infoLucero() {
  try {
    const raw = getTarifasLuceroJSON()
    if (raw && String(raw).trim()) {
      const obj = JSON.parse(raw)
      const limpio = {}
      for (const [c, v] of Object.entries(obj || {})) {
        const precio = Number(Array.isArray(v) ? v[0] : v)
        const vel = (Array.isArray(v) && VELOCIDADES_LUCERO.includes(v[1])) ? v[1] : 'programada'
        const k = claveCiudadLucero(c)
        if (k && Number.isFinite(precio) && precio > 0) limpio[k] = [precio, vel]
      }
      if (Object.keys(limpio).length) return limpio
    }
  } catch { /* JSON roto → fábrica */ }
  return TARIFAS_LUCERO_INFO
}

// Velocidad de entrega por ciudad (del tarifario vigente)
export const velocidadLucero = (ciudadNorm) => infoLucero()[ciudadNorm]?.[1] || null

// ── Link de tracking público de Lucero ──
// Usa el ID interno de Lucero (guia_transportadora en `entregas`), NO el
// código FW-XXXX que le mandamos nosotros — ese es un identificador interno
// nuestro, Lucero no lo reconoce en esta URL.
const URL_TRACKING_LUCERO = 'https://www.luceroexpress.com.py/envio.php?id='
export function linkTrackingLucero(envioId) {
  const id = String(envioId ?? '').trim()
  return id ? `${URL_TRACKING_LUCERO}${id}` : null
}

// Nombre canónico en MAYÚSCULAS, como lo espera la planilla de Lucero.
// Si mandás la ciudad con otra grafía, su sistema la marca como no reconocida.
export const NOMBRE_OFICIAL_LUCERO = {
  'altos (cordillera)': 'ALTOS (CORDILLERA)',
  'aregua': 'AREGUÁ',
  'asuncion': 'ASUNCIÓN',
  'atyra': 'ATYRÁ',
  'barrero': 'BARRERO',
  'blas garay': 'BLAS GARAY',
  'caacupe': 'CAACUPÉ',
  'caaguazu': 'CAAGUAZÚ',
  'cambyreta': 'CAMBYRETA',
  'campo 9': 'CAMPO 9',
  'capiata': 'CAPIATÁ',
  'capitan miranda': 'CAPITÁN MIRANDA',
  'carapegua': 'CARAPEGUÁ',
  'carmen del parana': 'CARMEN DEL PARANÁ',
  'ciudad del este': 'CIUDAD DEL ESTE',
  'colonia torin': 'COLONIA TORÍN',
  'coronel oviedo': 'CORONEL OVIEDO',
  'dr. j. eulogio estigarribia': 'DR. J. EULOGIO ESTIGARRIBIA',
  'encarnacion': 'ENCARNACIÓN',
  'eusebio ayala': 'EUSEBIO AYALA',
  'fernando de la mora': 'FERNANDO DE LA MORA',
  'fram': 'FRAM',
  'guarambare': 'GUARAMBARÉ',
  'hernandarias': 'HERNANDARIAS',
  'ita': 'ITÁ',
  'itacurubi': 'ITACURUBÍ',
  'itagua': 'ITAGUÁ',
  'j. augusto saldivar': 'J. AUGUSTO SALDÍVAR',
  'jose domingo ocampos': 'JOSÉ DOMINGO OCAMPOS',
  'juan e. o\'leary': 'JUAN E. O\'LEARY',
  'juan leon mallorquin': 'JUAN LEÓN MALLORQUÍN',
  'juan manuel frutos': 'JUAN MANUEL FRUTOS',
  'la paz': 'LA PAZ',
  'lambare': 'LAMBARÉ',
  'limpio': 'LIMPIO',
  'loma pyta': 'LOMA PYTÃ',
  'los cedrales': 'LOS CEDRALES',
  'luque': 'LUQUE',
  'mariano roque alonso': 'MARIANO ROQUE ALONSO',
  'mauricio jose troche': 'MAURICIO JOSE TROCHE',
  'mbocajaty (departamento del guaira)': 'MBOCAJATY (DEPARTAMENTO DEL GUAIRA)',
  'minga guazu': 'MINGA GUAZÚ',
  'naranjal': 'NARANJAL',
  'natalicio talavera': 'NATALICIO TALAVERA',
  'nemby': 'ÑEMBY',
  'nueva italia': 'NUEVA ITALIA',
  'paraguari': 'PARAGUARÍ',
  'pastoreo': 'PASTOREO',
  'pedro juan caballero': 'PEDRO JUAN CABALLERO',
  'piribebuy': 'PIRIBEBUY',
  'presidente franco': 'PRESIDENTE FRANCO',
  'san antonio': 'SAN ANTONIO',
  'san bernardino': 'SAN BERNARDINO',
  'san cristobal': 'SAN CRISTÓBAL',
  'san jose de los arroyos': 'SAN JOSÉ DE LOS ARROYOS',
  'san juan del parana': 'SAN JUAN DEL PARANÁ',
  'san lorenzo': 'SAN LORENZO',
  'santa rita': 'SANTA RITA',
  'santa rosa del monday': 'SANTA ROSA DEL MONDAY',
  'tavapy': 'TAVAPY',
  'thompson': 'THOMPSON',
  'tobati': 'TOBATÍ',
  'villa elisa': 'VILLA ELISA',
  'villa hayes': 'VILLA HAYES',
  'villarrica': 'VILLARRICA',
  'villeta': 'VILLETA',
  'yaguaron': 'YAGUARÓN',
  'yataity (departamento del guaira)': 'YATAITY  (DEPARTAMENTO DEL GUAIRA)',
  'yguazu': 'YGUAZÚ',
  'ypacarai': 'YPACARAÍ',
  'ypane': 'YPANÉ',
}

// ─── Ruteo: qué transportadora conviene en cada ciudad ───
// Con el tarifario oficial 2026, Lucero solo es MÁS BARATO que PaP en Ciudad
// del Este. En el resto hay que pagar por la velocidad, o no conviene.
//
// El envío que le cobrás al cliente (33.000 en Grupo A) es el MISMO con las dos
// transportadoras, así que no entra en esta comparación: no cambia cuál gana.
//
// Regla:
//   1. Lucero si es más barato que PaP.
//   2. Lucero si cuesta hasta SOBREPRECIO_ACEPTABLE más Y entrega rápido
//      (diaria o frecuente) — se paga la velocidad porque rinde al día siguiente
//      y libera capital de trabajo.
//   3. PaP en todo lo demás.
//   4. Si PaP no cubre, va Lucero aunque sea caro: mejor caro que no despachar.
export const SOBREPRECIO_ACEPTABLE = 1000

// Tasa de entrega que Lucero necesita para EMPATAR a PaP según su tarifa,
// con precio nuevo (112.000 Grupo A ×1), COGS ~13.600 y PaP 29.000 al 83%.
// Sirve para revisar la decisión cuando haya datos reales de Lucero.
export const TASA_EQUILIBRIO = {
  25000: 0.755,   // Ciudad del Este — puede entregar 7.5pp PEOR y aún conviene
  30000: 0.806,   // puede entregar 2.4pp PEOR y aún conviene
  35000: 0.857,   // necesita 2.7pp MEJOR
  40000: 0.908,   // necesita 7.8pp MEJOR → no se asume
}

// Resuelve la ciudad del texto libre contra el tarifario de Lucero.
// Devuelve la clave normalizada o null.
export function ciudadLucero(ciudad) {
  return emparejarCiudad(ciudad, Object.keys(infoLucero()))
}

// 20-10: ¿PaP lleva un pedido a esta ciudad? Con la tabla de tarifas cargada (tarifasCourier.js) manda la tabla:
// contra entrega solo donde aplica_cobranza = true (la lista del código daba como "con cobranza" Ayolas, Choré,
// San José de los Arroyos y San Juan Nepomuceno, y se perdió un pedido). Pago anticipado: alcanza con que PaP llegue.
// Ciudad fuera de la tabla → la lista vieja de respaldo, salvo que la ciudad que esa lista reconoce figure en la
// tabla sin cobranza. Sin tabla cargada → la lista vieja, como antes.
function cubrePaP(ciudad, cod) {
  if (!tarifasCourierCargadas()) return tieneCobranzaPaP(ciudad)
  const t = tarifaCourier('pap', ciudad)
  if (t && !t.estimado) return cod ? t.cobranza === true : true
  const vieja = emparejarCiudad(ciudad, CIUDADES_PAP_LISTA)
  if (!vieja) return false
  const tv = tarifaCourier('pap', vieja)
  return tv && !tv.estimado ? (cod ? tv.cobranza === true : true) : true
}

// ¿La transportadora puede llevar el pedido a esta ciudad?
// cod = contra entrega (default). Con cod=false (ya pagado) PaP vale también donde llega sin cobranza.
// 'otra' no tiene lista de cobertura propia: es el catch-all manual, así que
// siempre "cubre" — la decisión de si sirve para esa ciudad la hace el admin,
// no el sistema.
export function cubre(transportadora, ciudad, { cod = true } = {}) {
  if (transportadora === 'otra') return true
  if (transportadora === 'lucero') {
    if (ciudadLucero(ciudad) != null) return true
    const t = tarifasCourierCargadas() ? tarifaCourier('lucero', ciudad) : null
    return t != null && (!cod || t.cobranza === true)
  }
  return cubrePaP(ciudad, cod)
}

// Tarifa de esa transportadora para esa ciudad, con la marca de si es estimada.
// → { precio, estimado } | null. 'otra': no hay tarifa conocida — el admin la carga a mano en Despacho.
// 20-10: con la tabla de tarifas cargada, PaP = precio de su ciudad (o de su zona, estimado, si la ciudad no está);
// Lucero = tabla primero y después el tarifario de Config/fábrica. Sin tabla: PaP plano de Config (estimado: no es
// el precio de esa ciudad), solo si la lista vieja la cubre — como antes.
export function tarifaDetalle(transportadora, ciudad) {
  if (transportadora === 'otra') return null
  if (transportadora === 'lucero') {
    const t = tarifasCourierCargadas() ? tarifaCourier('lucero', ciudad) : null
    if (t) return { precio: t.precio, estimado: false }
    const c = ciudadLucero(ciudad)
    const p = c ? (infoLucero()[c]?.[0] ?? null) : null
    return p != null ? { precio: p, estimado: false } : null
  }
  if (tarifasCourierCargadas()) {
    const t = tarifaCourier('pap', ciudad)
    return t ? { precio: t.precio, estimado: !!t.estimado } : { precio: getFlete(), estimado: true }
  }
  return tieneCobranzaPaP(ciudad) ? { precio: getFlete(), estimado: true } : null
}

// Solo el precio (null si no hay tarifa conocida, o si es 'otra').
export function tarifaDe(transportadora, ciudad) {
  return tarifaDetalle(transportadora, ciudad)?.precio ?? null
}

// ¿El flete de esa transportadora en esa ciudad es estimado? (se guarda en ventas.flete_estimado)
export const fleteEstimado = (transportadora, ciudad) => !!tarifaDetalle(transportadora, ciudad)?.estimado

// Transportadoras que pueden llevar un pedido a esa ciudad (cod: ver cubre).
export function transportadorasDisponibles(ciudad, opciones = {}) {
  return IDS_TRANSPORTADORA.filter(id => cubre(id, ciudad, opciones))
}


// ═══════════════════════════════════════════════════════════
// RUTEO OFICIAL POR CIUDAD  ·  actualizado 21/08/2026
// ═══════════════════════════════════════════════════════════
// ESTA es la lista que se actualiza cuando cambian los acuerdos con los
// couriers. Manda sobre la comparación automática de costo/velocidad: si una
// ciudad está acá, va por esa transportadora y punto.
//
// Por qué explícito y no calculado: 37 de las ciudades de Lucero también las
// cubre PaP, así que antes decidía una comparación de precio y velocidad. Eso
// está bien cuando no hay acuerdo previo, pero vos ya tenés definido quién
// lleva cada ciudad — y esa decisión tiene que ser la que gana.
//
// Las ciudades que NO estén en ninguna de las dos listas caen al criterio
// automático de siempre (sugerirTransportadora compara costo y velocidad).
// Los nombres se comparan con el emparejador difuso, así que aguantan tildes,
// abreviaturas y variantes de escritura ('cde', 'cnel oviedo').
// 09-10-2026: Fernando de la Mora pasa a Lucero y 7 ciudades de Gran Asunción
// (las que Lucero cobra ₲40.000: Areguá, Capiatá, Itauguá, J. A. Saldívar,
// Limpio, Ñemby, Ypané) pasan a PaP. Guarambaré queda en Lucero porque PaP no
// cobra contra entrega ahí. Comparación del mismo período (desde el
// 15-07-2026): en las de ₲35.000 Lucero entrega bastante más
// que PaP y en la mitad del tiempo. En esas 7 ciudades los dos entregan igual,
// PaP llega antes y cuesta ₲11.000 menos. El interior de ₲40.000 queda en
// Lucero: entrega igual o un poco más, llega ~2 días antes y cobra ~10 días antes.
const RUTEO_OFICIAL = {
  lucero: [
    'Altos',                       'Asunción',                    'Atyrá',
    'Barrero',                     'Blas Garay',                  'Caacupé',
    'Caaguazú',                    'Cambyretá',                   'Campo 9',
    'Capitán Miranda',             'Carmen del Paraná',           'Ciudad del Este',
    'Colonia Torín',               'Coronel Oviedo',              'Dr. J. Eulogio Estigarribia',
    'Encarnación',                 'Eusebio Ayala',               'Fernando de la Mora',
    'Fram',                        'Guarambaré',                  'Hernandarias',
    'Itá',                         'Itacurubí',                   'José Domingo Ocampos',
    "Juan E. O'Leary",             'Juan León Mallorquín',        'Juan Manuel Frutos',
    'La Paz',                      'Lambaré',                     'Loma Pytã',
    'Los Cedrales',                'Luque',                       'Mariano Roque Alonso',
    'Mauricio José Troche',        'Mbocajaty',                   'Minga Guazú',
    'Naranjal',                    'Natalicio Talavera',          'Nueva Italia',
    'Paraguarí',                   'Pastoreo',                    'Piribebuy',
    'Presidente Franco',           'San Bernardino',              'San Juan del Paraná',
    'San Lorenzo',                 'Santa Rita',                  'Santa Rosa del Monday',
    'Tavapy',                      'Thompson',                    'Tobatí',
    'Villa Elisa',                 'Villeta',                     'Yaguarón',
    'Yataity',                     'Yguazú',                      'Ypacaraí',
  ],
  pap: [
    'Areguá',                      'Ayolas',                      'Bella Vista Sur',
    'Caazapá',                     'Capiatá',                     'Carapeguá',
    'Choré',                       'Concepción',                  'Curuguaty',
    'Filadelfia',                  'Hohenau',                     'Independencia',
    'Itacurubí de la Cordillera',  'Itauguá',                     'J. Augusto Saldívar',
    'Limpio',                      'María Auxiliadora',           'Mariscal Estigarribia (Chaco)',
    'Natalio',                     'Neuland',                     'Ñemby',
    'Pedro Juan Caballero',        'Pilar', /* 28-10: Puente Kyjhá fuera (PaP 27-10: "No llegamos"; va por Lucero, corredor Salto del Guairá) */
    'Salto del Guairá',            'San Antonio',                 'San Cristóbal',
    'San Ignacio Misiones',        'San José de los Arroyos',     'San Juan Nepomuceno',
    'Santa Rosa del Mbutuy',       'Trinidad',                    'Villa Hayes',
    'Villarrica',                  'Ypané',
  ],
}

// Transportadora asignada por la lista oficial, o null si esa ciudad no está.
export function ruteoOficial(ciudad) {
  if (!ciudad) return null
  const k = claveCiudadLucero(ciudad)
  const lu = RUTEO_OFICIAL.lucero.map(claveCiudadLucero)
  const pa = RUTEO_OFICIAL.pap.map(claveCiudadLucero)

  // 1) Coincidencia EXACTA, y gana sobre cualquier parecido. Hace falta
  //    porque hay nombres que son prefijo de otros: 'Itacurubí' está en la
  //    lista de Lucero e 'Itacurubí de la Cordillera' en la de PaP. Sin esta
  //    pasada, el emparejador difuso mandaba la segunda a Lucero.
  if (lu.includes(k)) return 'lucero'
  if (pa.includes(k)) return 'pap'

  // 2) Recién ahí, emparejamiento difuso: aguanta tildes, abreviaturas y
  //    variantes de escritura ('cde', 'cnel oviedo', 'pjc').
  if (emparejarCiudad(ciudad, lu)) return 'lucero'
  if (emparejarCiudad(ciudad, pa)) return 'pap'
  return null
}

// Para mostrar en Configuración y para los tests.
export const ciudadesRuteo = () => ({
  lucero: [...RUTEO_OFICIAL.lucero],
  pap: [...RUTEO_OFICIAL.pap],
})

// ─── Transportadora forzada por producto ────────────────────
// Decisión de negocio, no logística: JawFlex Pro tiene ~36% de no-entrega
// estable desde abril, muy por encima de cualquier otro producto (Parches
// 7-17%). El diagnóstico: confirmar por WhatsApp no cuesta nada, el
// arrepentimiento pasa recién frente al repartidor con la plata en mano —
// forzar Lucero (entrega más rápida, menos tiempo para que el cliente dude)
// reduce esa ventana. Si Lucero no cubre la ciudad, el pedido queda SIN
// transportadora asignada — no cae solo a PaP — para que sea una decisión
// consciente del admin, no automática del sistema.
//
// Extensible: agregar otro producto acá es una línea, no un rewrite.
export const REGLA_TRANSPORTADORA_PRODUCTO = {
  jaw: 'lucero',   // familia 'jaw' = JawFlex Pro (ver familiaProducto en recompra.js)
}

// Transportadora forzada para ESE producto, o null si no tiene regla.
export function transportadoraForzada(productoNombre) {
  const fam = familiaProducto(productoNombre)
  return fam ? (REGLA_TRANSPORTADORA_PRODUCTO[fam] || null) : null
}

// ─── Preferencia temporal por Lucero ───────────────────────
// 12-10-2026: por la lluvia, Enrique pidió que SOLO ese día vaya por Lucero todo lo que Lucero cubre.
// Fechas en hora de Paraguay (AAAA-MM-DD). Para repetirlo otro día, agregar la fecha; vacío = regla normal.
export const DIAS_PREFERIR_LUCERO = ['2026-10-12']

export const hoyParaguay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' })

export function preferirLucero(fecha = hoyParaguay()) {
  return DIAS_PREFERIR_LUCERO.includes(fecha)
}

// ─── Sugerencia automática ──────────────────────────────────
// Regla vigente: Lucero si cubre la ciudad Y su tarifa es ≤ 30.000
// (más barato o +1.000 compensado por cobrar 6 días antes).
// En las de 35.000 y en todo lo que Lucero no cubre, va PaP.
// Devuelve { transportadora, motivo, tarifa, fleteEstimado } — el motivo se muestra en Despacho
// para que la decisión sea auditable y no una caja negra.
// 20-10: cod=false (pedido ya pagado) deja usar PaP donde llega sin cobranza; contra entrega, nunca.
// La tarifa sale de tarifaDetalle (tabla de tarifas si cargó; si no, como antes).
export function sugerirTransportadora(ciudad, productoNombre = '', { cod = true } = {}) {
  const conTarifa = (r) => {
    const d = r.transportadora ? tarifaDetalle(r.transportadora, ciudad) : null
    return { ...r, tarifa: d?.precio ?? null, fleteEstimado: !!d?.estimado }
  }
  // Regla de producto: pisa la comparación de tarifa/velocidad por completo.
  // Si la transportadora forzada no cubre la ciudad, NO se cae a otra
  // automáticamente salvo el caso de abajo (21-10): el otro courier cobra ahí → va por el otro con nota.
  const forzada = transportadoraForzada(productoNombre)
  if (forzada) {
    if (cubre(forzada, ciudad, { cod })) {
      return conTarifa({
        transportadora: forzada,
        motivo: `Regla de producto: solo despacha por ${labelTransportadora(forzada)}`,
        velocidad: forzada === 'lucero' ? velocidadLucero(ciudadLucero(ciudad)) : null,
        bloqueadoPorProducto: false,
      })
    }
    // 21-10 (Enrique): si el courier forzado NO llega pero el otro SÍ cobra contra entrega en esa ciudad, va por el otro
    // solo, con nota visible (fallbackProducto). Despachar rinde más que dejarlo parado (JawFlex por PaP ~60% entrega).
    // Si ninguno cobra ahí, sigue sin asignar: entra al flujo de sin cobertura (pago anticipado) de siempre.
    const otro = forzada === 'lucero' ? 'pap' : forzada === 'pap' ? 'lucero' : null
    if (otro && cubre(otro, ciudad, { cod })) {
      const nombre = { jaw: 'JawFlex' }[familiaProducto(productoNombre)] || 'Producto'
      return conTarifa({
        transportadora: otro,
        motivo: `${nombre} por ${otro === 'pap' ? 'PaP' : 'Lucero'}: ${forzada === 'pap' ? 'PaP' : 'Lucero'} no llega`,
        velocidad: otro === 'lucero' ? velocidadLucero(ciudadLucero(ciudad)) : null,
        bloqueadoPorProducto: false,
        fallbackProducto: true,
      })
    }
    return {
      transportadora: null,
      motivo: `Este producto solo despacha por ${labelTransportadora(forzada)} y ninguna transportadora cobra contra entrega en esta ciudad — sin cobertura`,
      tarifa: null, fleteEstimado: false, velocidad: null,
      bloqueadoPorProducto: true,
    }
  }

  const cL = ciudadLucero(ciudad)
  const hayLucero = cubre('lucero', ciudad, { cod })
  const hayPaP = cubre('pap', ciudad, { cod })
  const flete = tarifaDe('pap', ciudad) ?? getFlete()

  // ── Preferencia temporal por Lucero (lluvia) ──
  // Después de la regla de producto y ANTES de la lista oficial: esos días, todo lo que Lucero cubre va por Lucero.
  if (hayLucero && preferirLucero()) {
    return conTarifa({
      transportadora: 'lucero',
      motivo: 'Hoy por lluvia: Lucero en toda ciudad que cubre',
      velocidad: velocidadLucero(cL),
      bloqueadoPorProducto: false,
    })
  }

  // ── La lista oficial manda ──
  // Va DESPUÉS de la regla por producto (esa es de negocio y pesa más) pero
  // ANTES de la comparación de costo: si vos ya definiste quién lleva esa
  // ciudad, no hay nada que comparar.
  const oficial = ruteoOficial(ciudad)
  if (oficial === 'lucero' && hayLucero) {
    return conTarifa({
      transportadora: 'lucero',
      motivo: 'Asignada a Lucero en la lista oficial de ciudades',
      velocidad: velocidadLucero(cL),
    })
  }
  if (oficial === 'pap' && hayPaP) {
    return conTarifa({ transportadora: 'pap', motivo: 'Asignada a PaP en la lista oficial de ciudades', velocidad: null })
  }

  if (hayLucero) {
    const tarifa = tarifaDe('lucero', ciudad)
    const vel = velocidadLucero(cL)
    const dif = tarifa - flete
    const rapida = vel === 'diaria' || vel === 'frecuente'

    if (!hayPaP) {
      return conTarifa({ transportadora: 'lucero', motivo: 'PaP no cubre esta ciudad', velocidad: vel })
    }
    if (dif < 0) {
      return conTarifa({
        transportadora: 'lucero',
        motivo: `${Math.abs(dif).toLocaleString('es-PY')} más barato que PaP${rapida ? ' y más rápido' : ''}`,
        velocidad: vel,
      })
    }
    if (dif <= SOBREPRECIO_ACEPTABLE && rapida) {
      return conTarifa({
        transportadora: 'lucero',
        motivo: dif === 0 ? 'Misma tarifa y rinde al día siguiente' : `+${dif.toLocaleString('es-PY')} pero entrega ${vel === 'diaria' ? 'en 24hs' : 'en 24-48hs'} y rinde al día siguiente`,
        velocidad: vel,
      })
    }
    // Más caro de lo aceptable, o lento: va PaP.
    const porQue = vel === 'programada'
      ? `Lucero sale ${tarifa.toLocaleString('es-PY')} y entrega 1-2 veces por semana`
      : `Lucero sale +${dif.toLocaleString('es-PY')} acá — no compensa`
    return conTarifa({ transportadora: 'pap', motivo: porQue, velocidad: null })
  }

  if (hayPaP) return conTarifa({ transportadora: 'pap', motivo: 'Lucero no cubre esta ciudad', velocidad: null })
  return {
    transportadora: null,
    motivo: 'Ninguna transportadora cubre esta ciudad',
    tarifa: null, fleteEstimado: false, velocidad: null,
  }
}

// Nombre de ciudad tal cual lo espera la planilla de Lucero.
// Si no la reconoce, devuelve lo que vino en mayúsculas (Lucero lo va a marcar
// para que lo corrijas a mano, que es mejor que mandarlo vacío).
export function ciudadParaPlanillaLucero(ciudad) {
  const c = ciudadLucero(ciudad)
  if (c && NOMBRE_OFICIAL_LUCERO[c]) return NOMBRE_OFICIAL_LUCERO[c]
  return String(ciudad || '').toUpperCase().trim()
}

// ─── Ciudades conocidas (para autocompletar al corregir un pedido) ───
// Une la cobertura de las dos transportadoras. Se usa en Despacho: cuando el
// cliente escribió mal su ciudad, se corrige eligiendo de esta lista en vez de
// tipear libre — así una corrección no introduce un typo nuevo que después
// deje el pedido sin cobertura.
export function ciudadesConocidas() {
  const set = new Set()
  Object.keys(infoLucero()).forEach(c => set.add(c))
  CIUDADES_PAP_LISTA.forEach(c => set.add(c))
  return [...set]
    .map(c => c.replace(/\b\w/g, m => m.toUpperCase()))
    .sort((a, b) => a.localeCompare(b, 'es'))
}

// Info de cobertura de una ciudad, para mostrar el efecto de la corrección
// antes de guardarla.
export function coberturaCiudad(ciudad, opciones = {}) {
  const cL = ciudadLucero(ciudad)
  const lucero = cubre('lucero', ciudad, opciones)
  return {
    pap: cubre('pap', ciudad, opciones),
    lucero,
    tarifaLucero: lucero ? tarifaDe('lucero', ciudad) : null,
    velocidadLucero: cL ? velocidadLucero(cL) : null,
  }
}

export { normalizarCiudadPaP }
