// 13-10: entregas programadas en Despacho. Se despachan el mismo día como cualquier pedido; Despacho lee la
// fecha/franja (tag ENTREGA_PROGRAMADA + atributos, o tag viejo ENTREGAR_…), la muestra y la pasa al courier en
// la planilla de Lucero (NOTAS), la cabecera de PaP (DESCRIPCION) y la guía. Corre contra el código real (lib +
// copia compilada de DespachoPagina.jsx). Datos de prueba inventados.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import {
  leerProgramacion, estadoProgramacion, programacionDesdeShopify, textoEntregaCourier, nombreDia, listaTags,
} from '../src/lib/entregaProgramada.js'
import { filasCsvDesdePedidoShopify } from '../src/lib/pedidosVoltra.js'

let n = 0
const ok = (m) => { n++; console.log('✓ ' + m) }
const HOY = '2026-10-13' // martes

// ─── 1. Leer la fecha ───────────────────────────────────────
{
  assert.equal(nombreDia('2026-10-16'), 'viernes 16/10')
  assert.equal(nombreDia('2026-10-19'), 'lunes 19/10')
  assert.deepEqual(listaTags('CONFIRMADO, entrega_programada'), ['CONFIRMADO', 'ENTREGA_PROGRAMADA'])
  assert.deepEqual(listaTags(['A', ' b ']), ['A', 'B'])

  const notas = 'Nombre y apellido: Cliente Prueba\nentrega_programada: 2026-10-16\nentrega_franja: antes de las 12'
  assert.deepEqual(leerProgramacion({ tags: 'CONFIRMADO, ENTREGA_PROGRAMADA', notas, hoy: HOY }),
    { fecha: '2026-10-16', franja: 'antes de las 12', origen: 'atributos', revisar: false, detalle: '' })
  // Sin franja
  assert.equal(leerProgramacion({ tags: 'ENTREGA_PROGRAMADA', notas: 'entrega_programada: 2026-10-19' }).franja, '')
  // No programado
  assert.equal(leerProgramacion({ tags: 'CONFIRMADO, ENTREGADO', notas: 'ciudad: Asunción' }), null)
  assert.equal(leerProgramacion({}), null)
  // Una clave parecida no cuenta como atributo
  assert.equal(leerProgramacion({ tags: 'CONFIRMADO', notas: 'nota_entrega_programada_x: 2026-10-16' }), null)
  // Tag con fecha inválida → se marca para revisar
  const mal = leerProgramacion({ tags: 'ENTREGA_PROGRAMADA', notas: 'entrega_programada: 2026-02-30', hoy: HOY })
  assert.equal(mal.fecha, null)
  assert.equal(mal.revisar, true)
  ok('Tag ENTREGA_PROGRAMADA + atributos entrega_programada / entrega_franja; sin tag ni atributo → null')

  // Formato viejo: tag ENTREGAR_VIERNES_16_10 + nota
  const viejo = leerProgramacion({ tags: 'CONFIRMADO, ENTREGAR_VIERNES_16_10', nota: 'ENTREGAR EL VIERNES 16/10 antes de las 12', hoy: HOY })
  assert.equal(viejo.fecha, '2026-10-16')
  assert.equal(viejo.franja, 'antes de las 12')
  assert.equal(viejo.origen, 'formato_viejo')
  assert.equal(viejo.revisar, true)
  // Solo la nota tiene la fecha
  assert.equal(leerProgramacion({ tags: 'ENTREGAR_VIERNES', nota: 'Entregar el viernes 16/10 por la tarde', hoy: HOY }).fecha, '2026-10-16')
  assert.equal(leerProgramacion({ tags: 'ENTREGAR_VIERNES', nota: 'Entregar el viernes 16/10 por la tarde', hoy: HOY }).franja, 'por la tarde')
  // Sin fecha legible
  assert.equal(leerProgramacion({ tags: 'ENTREGAR_PRONTO', hoy: HOY }).fecha, null)
  // Diciembre → enero: la fecha es del año que viene
  assert.equal(leerProgramacion({ tags: 'ENTREGAR_LUNES_04_01', hoy: '2026-12-28' }).fecha, '2027-01-04')
  ok('Formato viejo ENTREGAR_…: fecha del tag o de la nota, franja de la nota, siempre con aviso')

  // JSON de Shopify: REST note_attributes y GraphQL customAttributes + tags en lista
  const rest = programacionDesdeShopify({ tags: 'ENTREGA_PROGRAMADA', note_attributes: [{ name: 'entrega_programada', value: '2026-10-16' }, { name: 'entrega_franja', value: 'antes de las 12' }] }, HOY)
  assert.equal(rest.fecha, '2026-10-16')
  assert.equal(rest.franja, 'antes de las 12')
  const gql = programacionDesdeShopify({ tags: ['CONFIRMADO', 'ENTREGA_PROGRAMADA'], customAttributes: [{ key: 'entrega_programada', value: '2026-10-19' }] }, HOY)
  assert.equal(gql.fecha, '2026-10-19')
  assert.equal(programacionDesdeShopify({ tags: 'CONFIRMADO' }, HOY), null)
  assert.equal(programacionDesdeShopify(null, HOY), null)
  ok('Desde el JSON de Shopify: note_attributes (REST) y customAttributes (GraphQL)')

  // pedidosVoltra: el botón "Traer pedidos de Voltra" arma las mismas columnas que el CSV, con atributos, tags y nota
  const filas = filasCsvDesdePedidoShopify({ raw: {
    name: '#9100', id: 1, created_at: '2026-10-13T09:00:00-03:00', tags: ['CONFIRMADO', 'ENTREGA_PROGRAMADA'],
    customAttributes: [{ key: 'entrega_programada', value: '2026-10-16' }], note: 'ENTREGAR EL VIERNES 16/10',
    line_items: [{ name: 'Tiras nasales', quantity: 1, price: '129000' }],
  } })
  assert.equal(filas[0].Tags, 'CONFIRMADO, ENTREGA_PROGRAMADA')
  assert.match(filas[0]['Note Attributes'], /^entrega_programada: 2026-10-16$/m)
  assert.equal(filas[0].Notes, 'ENTREGAR EL VIERNES 16/10')
  ok('pedidosVoltra: Tags en texto, customAttributes en Note Attributes y la nota en Notes')
}

// ─── 2. Texto para el courier y badge ───────────────────────
{
  assert.equal(textoEntregaCourier('2026-10-16', 'antes de las 12'), 'Entregar el viernes 16/10 antes de las 12')
  assert.equal(textoEntregaCourier('2026-10-16', ''), 'Entregar el viernes 16/10')
  assert.equal(textoEntregaCourier('2026-10-16', 'mañana'), 'Entregar el viernes 16/10 (mañana)')

  const e = estadoProgramacion({ fecha: '2026-10-16', franja: 'antes de las 12', revisar: false, detalle: '' }, { hoy: HOY })
  assert.equal(e.badge, '📅 Entregar el viernes 16/10 (antes de las 12)')
  assert.equal(e.textoCourier, 'Entregar el viernes 16/10 antes de las 12')
  assert.equal(e.aviso, false)
  // El mismo día también va el texto
  assert.equal(estadoProgramacion({ fecha: '2026-10-13', franja: '', revisar: false }, { hoy: HOY }).textoCourier, 'Entregar el martes 13/10')
  // Fecha pasada: aviso y sin texto al courier
  const pasada = estadoProgramacion({ fecha: '2026-10-12', franja: '', revisar: false }, { hoy: HOY })
  assert.equal(pasada.textoCourier, '')
  assert.equal(pasada.aviso, true)
  assert.match(pasada.badge, /ya pasó/)
  // Formato viejo con fecha: va el texto y el badge avisa
  const vieja = estadoProgramacion(leerProgramacion({ tags: 'ENTREGAR_VIERNES_16_10', nota: 'ENTREGAR EL VIERNES 16/10 antes de las 12', hoy: HOY }), { hoy: HOY })
  assert.equal(vieja.textoCourier, 'Entregar el viernes 16/10 antes de las 12')
  assert.equal(vieja.aviso, true)
  assert.match(vieja.badge, /^📅 Entregar el viernes 16\/10 \(antes de las 12\) · ⚠ formato viejo/)
  // Sin fecha legible
  const sinFecha = estadoProgramacion(leerProgramacion({ tags: 'ENTREGAR_PRONTO', hoy: HOY }), { hoy: HOY })
  assert.equal(sinFecha.textoCourier, '')
  assert.match(sinFecha.badge, /fecha sin leer/)
  assert.equal(estadoProgramacion(null, { hoy: HOY }), null)
  ok('Texto "Entregar el viernes 16/10 antes de las 12" y badge "📅 Entregar el viernes 16/10 (antes de las 12)"')
}

// ─── 3. Despacho real: no frena y el texto llega a la planilla ───
const dir = new URL('../src/pages/despacho/', import.meta.url)
const fuente = readFileSync(new URL('DespachoPagina.jsx', dir), 'utf8')
const copia = new URL('_probe_entrega_programada.jsx', dir)
const salida = new URL('../_probe_entrega_programada.out.mjs', import.meta.url)
writeFileSync(copia, fuente + '\nexport { mapearGrupoAPedidos, agruparFilasPorReferencia, notasLucero, descripcionPaP, colapsarPorReferencia, ventaAPedido, programadasPorRef }\n')
try {
  buildSync({
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
    define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
    entryPoints: [copia.pathname], outfile: salida.pathname,
  })
  const D = await import(pathToFileURL(salida.pathname).href)
  // Fecha lejana: el test no depende del día en que se corre.
  const FECHA = '2099-10-16'
  const texto = `Entregar el ${nombreDia(FECHA)} antes de las 12`
  const fila = (nombre, tags, extra = {}) => ({
    Name: nombre, 'Created at': '2026-10-13 10:00:00', Tags: tags, Total: '129000', Subtotal: '129000',
    'Shipping Name': 'Cliente Prueba', 'Shipping City': 'Asunción', 'Shipping Address1': 'Calle Inventada 123',
    Phone: '0981000000', Vendor: 'VOLTRA PARAGUAY', 'Lineitem name': 'Tiras nasales', 'Lineitem quantity': '1', 'Lineitem price': '129000',
    ...extra,
  })
  const pedidos = D.agruparFilasPorReferencia([
    fila('#9101', 'CONFIRMADO, ENTREGA_PROGRAMADA', { 'Note Attributes': `entrega_programada: ${FECHA}\nentrega_franja: antes de las 12` }),
    fila('#9102', 'CONFIRMADO'),
  ]).flatMap(D.mapearGrupoAPedidos)
  const [prog, normal] = pedidos
  // Programado: se despacha igual que uno normal (mismo estado, sin bloqueo)
  assert.equal(prog.despachar, true)
  assert.equal(prog.cfg.despachar, true)
  assert.equal(prog.cfg.label, normal.cfg.label)
  assert.equal(prog.entregaProgramada.textoCourier, texto)
  assert.equal(prog.entregaProgramada.badge, `📅 Entregar el ${nombreDia(FECHA)} (antes de las 12)`)
  assert.equal(normal.entregaProgramada, null)
  ok('CSV: el programado se despacha el mismo día (no se excluye) y lleva la fecha')

  // Lucero: NOTAS. PaP: DESCRIPCION. Sin programación, igual que antes.
  assert.equal(D.notasLucero(prog), texto)
  assert.equal(D.notasLucero({ ...prog, prepago: true }), `YA PAGADO - NO COBRAR · ${texto}`)
  assert.equal(D.notasLucero(normal), 'N/A')
  assert.equal(D.descripcionPaP(prog), `Tiras nasales (30 unidades) · ${texto}`)
  assert.equal(D.descripcionPaP(normal), 'Tiras nasales (30 unidades)')
  // Multiproducto colapsado en un paquete: conserva el texto
  const multi = D.agruparFilasPorReferencia([
    fila('#9103', 'CONFIRMADO, ENTREGA_PROGRAMADA', { 'Note Attributes': `entrega_programada: ${FECHA}\nentrega_franja: antes de las 12` }),
    { Name: '#9103', 'Lineitem name': 'Parche bucal', 'Lineitem quantity': '1', 'Lineitem price': '0' },
  ]).flatMap(D.mapearGrupoAPedidos)
  const [paquete] = D.colapsarPorReferencia(multi)
  assert.match(D.descripcionPaP(paquete), new RegExp(` · ${texto}$`))
  assert.match(fuente, /fila\('ENTREGA', textoEntrega\(p\), \{ destacado: true \}\)/)
  ok('Planillas: NOTAS de Lucero, DESCRIPCION de PaP y fila ENTREGA en la guía')

  // Desde Ventas: se cruza con shopify_pedidos por referencia
  const mapa = D.programadasPorRef([
    { nombre: '#9104', raw: { name: '#9104', tags: 'CONFIRMADO, ENTREGA_PROGRAMADA', note_attributes: [{ name: 'entrega_programada', value: FECHA }, { name: 'entrega_franja', value: 'antes de las 12' }] } },
    { nombre: '#9105', raw: { name: '#9105', tags: 'CONFIRMADO, ENTREGADO' } },
  ])
  assert.deepEqual([...mapa.keys()], ['VT-9104'])
  const pedidoVenta = D.ventaAPedido({ n_referencia: 'VT-9104', ciudad: 'Asunción', producto_nombre: 'Tiras nasales', cantidad: 1, total: 129000, estado_releasit: 'confirmado', entregaProgramada: mapa.get('VT-9104') })
  assert.equal(D.notasLucero(pedidoVenta), texto)
  assert.equal(D.ventaAPedido({ n_referencia: 'VT-9105', ciudad: 'Asunción' }).entregaProgramada, null)
  ok('Desde Ventas: la fecha sale de shopify_pedidos por referencia y llega a la planilla')
} finally {
  for (const f of [copia, salida]) { try { rmSync(f) } catch { /* nada */ } }
}
console.log(`\n${n} bloques OK`)
