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
import { getFlete, getTarifasLuceroJSON } from './config'
import { tieneCobranzaPaP, emparejarCiudad, normalizarCiudadPaP, CIUDADES_PAP_LISTA } from './cobranzaPaP'
import { familiaProducto } from './recompra'

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
  'altos (cordillera)': [40000, 'programada'],      // Altos (Cordillera)
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
  'mbocajaty (departamento del guaira)': [40000, 'programada'],// Mbocajaty (departamento del Guaira)
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
  'yataity (departamento del guaira)': [40000, 'programada'],// Yataity  (departamento del Guaira)
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

// ¿La transportadora hace COD en esta ciudad?
// 'otra' no tiene lista de cobertura propia: es el catch-all manual, así que
// siempre "cubre" — la decisión de si sirve para esa ciudad la hace el admin,
// no el sistema.
export function cubre(transportadora, ciudad) {
  if (transportadora === 'otra') return true
  if (transportadora === 'lucero') return ciudadLucero(ciudad) != null
  return tieneCobranzaPaP(ciudad)
}

// Tarifa de esa transportadora para esa ciudad.
// PaP: tarifa plana editable en Config. Lucero: por ciudad. 'otra': no hay
// tarifa conocida — el admin la carga a mano en Despacho.
// Devuelve null si la transportadora no cubre la ciudad, o si es 'otra'.
export function tarifaDe(transportadora, ciudad) {
  if (transportadora === 'otra') return null
  if (transportadora === 'lucero') {
    const c = ciudadLucero(ciudad)
    return c ? (infoLucero()[c]?.[0] ?? null) : null
  }
  return tieneCobranzaPaP(ciudad) ? getFlete() : null
}

// Transportadoras que pueden llevar un pedido a esa ciudad.
export function transportadorasDisponibles(ciudad) {
  return IDS_TRANSPORTADORA.filter(id => cubre(id, ciudad))
}

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

// ─── Sugerencia automática ──────────────────────────────────
// Regla vigente: Lucero si cubre la ciudad Y su tarifa es ≤ 30.000
// (más barato o +1.000 compensado por cobrar 6 días antes).
// En las de 35.000 y en todo lo que Lucero no cubre, va PaP.
// Devuelve { transportadora, motivo } — el motivo se muestra en Despacho
// para que la decisión sea auditable y no una caja negra.
export function sugerirTransportadora(ciudad, productoNombre = '') {
  // Regla de producto: pisa la comparación de tarifa/velocidad por completo.
  // Si la transportadora forzada no cubre la ciudad, NO se cae a otra
  // automáticamente — queda sin asignar, bloqueado, para que el admin decida.
  const forzada = transportadoraForzada(productoNombre)
  if (forzada) {
    if (cubre(forzada, ciudad)) {
      return {
        transportadora: forzada,
        motivo: `Regla de producto: solo despacha por ${labelTransportadora(forzada)}`,
        tarifa: tarifaDe(forzada, ciudad),
        velocidad: forzada === 'lucero' ? velocidadLucero(ciudadLucero(ciudad)) : null,
        bloqueadoPorProducto: false,
      }
    }
    return {
      transportadora: null,
      motivo: `Este producto solo despacha por ${labelTransportadora(forzada)} y no cubre esta ciudad — requiere decisión manual`,
      tarifa: null, velocidad: null,
      bloqueadoPorProducto: true,
    }
  }

  const cL = ciudadLucero(ciudad)
  const hayPaP = tieneCobranzaPaP(ciudad)
  const flete = getFlete()

  if (cL) {
    const tarifa = infoLucero()[cL]?.[0]
    const vel = velocidadLucero(cL)
    const dif = tarifa - flete
    const rapida = vel === 'diaria' || vel === 'frecuente'

    if (!hayPaP) {
      return { transportadora: 'lucero', motivo: 'PaP no cubre esta ciudad', tarifa, velocidad: vel }
    }
    if (dif < 0) {
      return {
        transportadora: 'lucero',
        motivo: `${Math.abs(dif).toLocaleString('es-PY')} más barato que PaP${rapida ? ' y más rápido' : ''}`,
        tarifa, velocidad: vel,
      }
    }
    if (dif <= SOBREPRECIO_ACEPTABLE && rapida) {
      return {
        transportadora: 'lucero',
        motivo: dif === 0 ? 'Misma tarifa y rinde al día siguiente' : `+${dif.toLocaleString('es-PY')} pero entrega ${vel === 'diaria' ? 'en 24hs' : 'en 24-48hs'} y rinde al día siguiente`,
        tarifa, velocidad: vel,
      }
    }
    // Más caro de lo aceptable, o lento: va PaP.
    const porQue = vel === 'programada'
      ? `Lucero sale ${tarifa.toLocaleString('es-PY')} y entrega 1-2 veces por semana`
      : `Lucero sale +${dif.toLocaleString('es-PY')} acá — no compensa`
    return { transportadora: 'pap', motivo: porQue, tarifa: flete, velocidad: null }
  }

  if (hayPaP) return { transportadora: 'pap', motivo: 'Lucero no cubre esta ciudad', tarifa: flete, velocidad: null }
  return { transportadora: null, motivo: 'Ninguna transportadora cubre esta ciudad', tarifa: null, velocidad: null }
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
export function coberturaCiudad(ciudad) {
  const cL = ciudadLucero(ciudad)
  return {
    pap: tieneCobranzaPaP(ciudad),
    lucero: cL != null,
    tarifaLucero: cL ? (infoLucero()[cL]?.[0] ?? null) : null,
    velocidadLucero: cL ? velocidadLucero(cL) : null,
  }
}

export { normalizarCiudadPaP }
