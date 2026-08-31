// tests/seguimiento-couriers.test.mjs
// ═══════════════════════════════════════════════════════════
// Seguimiento a PaP (guías atascadas) y aviso de tracking a clientes
// (Lucero) — las dos funciones nuevas construidas a pedido de Enrique el
// 31/08/2026. Los casos de PaP usan las 8 guías reales que estaban en
// "Asignado a ruta" ese día (todas del interior, 7-11 días), para probar
// contra un caso real y no solo inventado.
//
// Correr:  node --import ./tests/registrar.mjs tests/seguimiento-couriers.test.mjs
// ═══════════════════════════════════════════════════════════
import {
  entregasPaPAtascadas, mensajeSeguimientoPaP, numeroEmoji,
  mensajeTrackingLucero, linkWhatsAppTracking,
} from '../src/lib/seguimiento.js'
import { linkTrackingLucero } from '../src/lib/transportadoras.js'
import { exportLuceroAEntregas } from '../src/lib/exportLucero.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

const HOY = new Date(2026, 7, 31)   // 31/08/2026, mes 0-indexado

console.log('── numeroEmoji ──')
{
  ok(numeroEmoji(1) === '1️⃣' && numeroEmoji(10) === '🔟', '1 y 10 dan keycap')
  ok(numeroEmoji(11) === '11.' && numeroEmoji(23) === '23.', 'pasado 10 cae a "N."')
}

console.log('\n── entregasPaPAtascadas: caso real del 31/08/2026 ──')
{
  // Las 8 guías reales verificadas en Supabase ese día, todas "Asignado a
  // ruta", todas de ciudades del interior.
  const entregas = [
    { transportadora: 'pap', categoria: 'en_proceso', estado_pap: 'Asignado a ruta', n_referencia: '2207', nro_guia_pap: '26350001', ciudad: 'CORONEL OVIEDO', fecha_ingreso: '2026-08-24', nombre_courier: 'Cliente A' },
    { transportadora: 'pap', categoria: 'en_proceso', estado_pap: 'Asignado a ruta', n_referencia: '2171', nro_guia_pap: '26350002', ciudad: 'CORONEL OVIEDO', fecha_ingreso: '2026-08-20', nombre_courier: 'Cliente B' },
    { transportadora: 'pap', categoria: 'en_proceso', estado_pap: 'Asignado a ruta', n_referencia: '2224', nro_guia_pap: '26350003', ciudad: 'SANTA ROSA DEL AGUARAY', fecha_ingreso: '2026-08-24', nombre_courier: 'Cliente C' },
    { transportadora: 'pap', categoria: 'en_proceso', estado_pap: 'Asignado a ruta', n_referencia: '2164', nro_guia_pap: '26350004', ciudad: 'PILAR', fecha_ingreso: '2026-08-20', nombre_courier: 'Cliente D' },
    // Una fresca (recién ingresada hoy) — NO debería aparecer todavía.
    { transportadora: 'pap', categoria: 'en_proceso', estado_pap: 'Asignado a ruta', n_referencia: '9999', nro_guia_pap: '26359999', ciudad: 'CIUDAD DEL ESTE', fecha_ingreso: '2026-08-31', nombre_courier: 'Cliente Fresco' },
    // Una entregada — NO debería aparecer (no es en_proceso).
    { transportadora: 'pap', categoria: 'entregado', estado_pap: 'Entregado', n_referencia: '1000', nro_guia_pap: '26350005', ciudad: 'CORONEL OVIEDO', fecha_ingreso: '2026-08-20', nombre_courier: 'Cliente Entregado' },
    // Una de Lucero — NO debería mezclarse acá (es un flujo distinto).
    { transportadora: 'lucero', categoria: 'en_proceso', estado_pap: 'Cargado', n_referencia: '2000', nro_guia_pap: 'L-2000', ciudad: 'ASUNCION', fecha_ingreso: '2026-08-20', nombre_courier: 'Cliente Lucero' },
    // Otro estado crudo distinto, para probar que agrupa dinámicamente.
    { transportadora: 'pap', categoria: 'en_proceso', estado_pap: 'No Gestionado', n_referencia: '3000', nro_guia_pap: '26350006', ciudad: 'ASUNCION', fecha_ingreso: '2026-08-25', nombre_courier: 'Cliente E' },
  ]

  const r = entregasPaPAtascadas(entregas, { diasCerca: 1, diasLejos: 2, hoy: HOY })
  ok(r.total === 5, `5 guías atascadas (no la fresca, no la entregada, no la de Lucero) — dio ${r.total}`)
  ok(!r.items.some(i => i.n_referencia === '9999'), 'la recién ingresada hoy no aparece (0 días < umbral)')
  ok(!r.items.some(i => i.n_referencia === '1000'), 'la ya entregada no aparece')
  ok(!r.items.some(i => i.transportadora === 'lucero'), 'Lucero no se mezcla con la lista de PaP')
  ok(r.masViejoDias === 11, `la más vieja tiene 11 días — dio ${r.masViejoDias}`)

  const grupoAsignado = r.grupos.find(g => g.estado === 'Asignado a ruta')
  ok(grupoAsignado?.items.length === 4, 'las 4 "Asignado a ruta" quedan agrupadas juntas')
  const grupoNoGestionado = r.grupos.find(g => g.estado === 'No Gestionado')
  ok(grupoNoGestionado?.items.length === 1, 'un estado crudo distinto ("No Gestionado") arma SU PROPIO grupo, sin lista fija')
  ok(grupoAsignado.items[0].dias === 11 && grupoAsignado.items[1].dias === 11 || grupoAsignado.items[0].dias >= grupoAsignado.items[1].dias,
    'dentro de cada grupo, las más viejas van primero')
}

console.log('\n── el umbral es distinto según la zona de la ciudad ──')
{
  const entregas = [
    // Asunción es zona 'metro': con diasCerca=1, un día ya alcanza.
    { transportadora: 'pap', categoria: 'en_proceso', estado_pap: 'X', n_referencia: '1', nro_guia_pap: 'g1', ciudad: 'ASUNCION', fecha_ingreso: '2026-08-30', nombre_courier: 'A' },
    // Villarrica es 'interior': con diasLejos=2, un solo día NO alcanza todavía.
    { transportadora: 'pap', categoria: 'en_proceso', estado_pap: 'X', n_referencia: '2', nro_guia_pap: 'g2', ciudad: 'VILLARRICA', fecha_ingreso: '2026-08-30', nombre_courier: 'B' },
  ]
  const r = entregasPaPAtascadas(entregas, { diasCerca: 1, diasLejos: 2, hoy: HOY })
  ok(r.items.some(i => i.n_referencia === '1'), 'Asunción (metro) con 1 día ya está atascada')
  ok(!r.items.some(i => i.n_referencia === '2'), 'Villarrica (interior) con 1 día todavía NO — tolera hasta 2')
}

console.log('\n── mensajeSeguimientoPaP: mismo formato que arma a mano ──')
{
  const grupos = [{
    estado: 'Asignados a ruta',
    items: [
      { nro_guia_pap: '26354272', nombre_courier: 'Joséma Caballero', fecha_ingreso: '2026-07-31' },
    ],
  }]
  const msg = mensajeSeguimientoPaP(grupos, 'Hola! Necesito seguimiento:')
  ok(msg.includes('📦 Asignados a ruta'), 'lleva el header con el emoji de paquete')
  ok(msg.includes('1️⃣ 26354272 – Joséma Caballero'), 'la línea numerada tiene guía y nombre, formato exacto')
  ok(msg.includes('📅 31/07/2026'), 'la fecha va completa con año, como en el ejemplo de Enrique')
  ok(msg.startsWith('Hola! Necesito seguimiento:'), 'usa la plantilla que se le pasó, no una fija')
}

console.log('\n── tracking de Lucero: reemplazo de plantilla y validaciones ──')
{
  const PLANTILLA = 'Hola {{nombre}}! Tu pedido va en camino: {{link}}'
  const entrega = { nombre_courier: 'María López', guia_transportadora: '17030', telefono_courier: '0981234567' }
  const msg = mensajeTrackingLucero(entrega, PLANTILLA)
  ok(msg === 'Hola María! Tu pedido va en camino: https://www.luceroexpress.com.py/envio.php?id=17030',
    `el mensaje reemplaza nombre (solo el primero) y link — dio: "${msg}"`)

  const link = linkWhatsAppTracking(entrega, PLANTILLA)
  ok(link?.startsWith('https://wa.me/595981234567?text='), 'el link de WhatsApp usa el teléfono en formato internacional')

  ok(linkWhatsAppTracking({ ...entrega, guia_transportadora: null }, PLANTILLA) === null,
    'sin EnvioID, no hay link (evita mandar un tracking roto)')
  ok(linkWhatsAppTracking({ ...entrega, telefono_courier: '021234567' }, PLANTILLA) === null,
    'con un fijo (no celular), no hay link')
}

console.log('\n── linkTrackingLucero ──')
{
  ok(linkTrackingLucero('17030') === 'https://www.luceroexpress.com.py/envio.php?id=17030', 'arma la URL con el ID')
  ok(linkTrackingLucero(null) === null && linkTrackingLucero('') === null, 'sin ID, no hay link')
}

console.log('\n── exportLuceroAEntregas ahora SÍ guarda el EnvioID ──')
{
  // Antes se parseaba (it.envioId) pero nunca se escribía: ~31% de los envíos
  // de Lucero se quedaban sin este dato, aunque el export SÍ lo traía.
  const items = [{ referencia: '2245', estado: 'Cargado', categoria: 'en_proceso', total: 129000, envioId: '17030', ciudad: 'ASUNCION', producto: 'X' }]
  const filas = exportLuceroAEntregas(items)
  ok(filas[0].guia_transportadora === '17030', 'el EnvioID del export se guarda en guia_transportadora')

  const sinEnvioId = exportLuceroAEntregas([{ referencia: '9', estado: 'Cargado', categoria: 'en_proceso', total: 0, envioId: '', ciudad: 'X', producto: 'Y' }])
  ok(!('guia_transportadora' in sinEnvioId[0]), 'sin EnvioID en el archivo, se omite la clave (no pisa un ID bueno con vacío)')
}

console.log(fallas ? `\n✗ ${fallas} falla(s)` : '\n✓ seguimiento a PaP y tracking de Lucero funcionan como se pidió')
process.exit(fallas ? 1 : 0)
