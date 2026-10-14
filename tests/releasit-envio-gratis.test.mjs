// 14-10: formato nuevo de Releasit (×2 y ×3 con envío 0, ×3 con descuento fijo de 49.000, mixto pack + 1 con envío 0).
// Datos inventados. Compila una copia de DespachoPagina.jsx exportando las funciones puras, como despacho-auditoria.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { filasCsvDesdePedidoShopify } from '../src/lib/pedidosVoltra.js'

const dir = new URL('../src/pages/despacho/', import.meta.url)
const copia = new URL('_probe_releasit.jsx', dir)
const salida = new URL('../_probe_releasit.out.mjs', import.meta.url)
writeFileSync(copia, readFileSync(new URL('DespachoPagina.jsx', dir), 'utf8') + '\nexport { mapearGrupoAPedidos, filaVentaDePedido }\n')
const opts = {
  bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
}
let n = 0
const ok = (m) => { n++; console.log('✓ ' + m) }

// Pedido de Shopify como lo arma Releasit (estructura real: descuento de pedido repartido en discount_allocations).
const pedido = (nombre, lineas, { envio = 0, descuento = 0, tarifa = 'Envio GRATIS' } = {}) => {
  const bruto = lineas.reduce((s, l) => s + l.price * l.quantity, 0)
  const total = bruto - descuento + envio
  return {
    shopify_order_id: 9000 + Number(nombre.replace(/\D/g, '')), nombre, total, es_borrador: false,
    tags: ['CONFIRMADO'], estado_confirmacion: 'confirmado',
    raw: {
      name: nombre, created_at: '2026-10-14T21:00:00Z', total_price: String(total), subtotal_price: String(bruto - descuento),
      total_discounts: String(descuento), tags: 'CONFIRMADO', financial_status: 'pending',
      shipping_lines: [{ title: tarifa, price: String(envio) }],
      shipping_address: { name: 'Cliente Prueba', city: 'Asunción', address1: 'Calle Inventada 123', phone: '0981000000' },
      line_items: lineas.map((l, i) => ({
        name: l.name, title: l.name, quantity: l.quantity, price: String(l.price), vendor: 'VOLTRA PARAGUAY',
        discount_allocations: descuento && i === 0 ? [{ amount: String(descuento) }] : [],
      })),
    },
  }
}
const RASP = { name: 'Raspador de Lengua: aliento más limpio', price: 79000 }
const PACK = { name: 'Pack GUDAIR: nariz abierta, boca cerrada', price: 120000 }
const casos = {
  'x2 nuevo': pedido('#9902', [{ ...RASP, quantity: 2 }]),
  'x3 nuevo': pedido('#9903', [{ ...RASP, quantity: 3 }], { descuento: 49000 }),
  'mixto pack + 1': pedido('#9904', [{ ...PACK, quantity: 1 }, { ...RASP, quantity: 1 }]),
  'x2 viejo (control)': pedido('#9905', [{ ...RASP, quantity: 2 }], { descuento: 33000, envio: 33000, tarifa: 'Envío a todo Paraguay' }),
  'mixto x3 + pack con descuento': pedido('#9906', [{ ...RASP, quantity: 3 }, { ...PACK, quantity: 1 }], { descuento: 49000 }),
}
const esperado = { 'x2 nuevo': 158000, 'x3 nuevo': 188000, 'mixto pack + 1': 199000, 'x2 viejo (control)': 158000, 'mixto x3 + pack con descuento': 308000 }

try {
  buildSync({ ...opts, entryPoints: [copia.pathname], outfile: salida.pathname })
  const D = await import(pathToFileURL(salida.pathname).href)
  for (const [nombre, p] of Object.entries(casos)) {
    const filas = filasCsvDesdePedidoShopify(p)
    const lineas = D.mapearGrupoAPedidos(filas)
    const suma = lineas.reduce((s, l) => s + (l.total || 0), 0)
    assert.equal(suma, esperado[nombre], `${nombre}: la suma de las líneas = lo que cobra el courier`)
    assert.ok(lineas.every((l) => l.total > 0), `${nombre}: ninguna línea en 0 o negativa`)
    const ventas = lineas.map((l) => D.filaVentaDePedido(l, []))
    for (const v of ventas) {
      assert.equal(v.envio_cliente, 0, `${nombre}: envio_cliente 0 (el envío ya está dentro del total)`)
      assert.equal(v.precio_unit, Math.round(v.total / (v.cantidad || 1)), `${nombre}: precio_unit = total / cantidad`)
      assert.ok(v.costo_envio > 0 || lineas.length > 1, `${nombre}: el flete del courier sigue existiendo aunque el cliente no pague envío`)
    }
    ok(`${nombre}: total ${suma}, líneas ${lineas.map((l) => l.total).join(' + ')}, precio_unit ${ventas.map((v) => v.precio_unit).join('/')}`)
  }
  // Mixto con descuento: el reparto es proporcional al precio de lista (antes el último producto quedaba en 71.000).
  const mix = D.mapearGrupoAPedidos(filasCsvDesdePedidoShopify(casos['mixto x3 + pack con descuento']))
  assert.equal(mix[0].total, Math.round(237000 / 357000 * 308000))
  assert.equal(mix[1].total, 308000 - mix[0].total)
  ok('mixto con descuento: reparto proporcional, el pack no queda subvaluado')
  console.log(`Todo OK (${n})`)
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true })
}
