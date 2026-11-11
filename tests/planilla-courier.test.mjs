// Planillas de los couriers (11-11-2026): producto siempre con "xN" y REFERENCIA tomada de la nota o de Address2.
// Casos VT-1224/1225 (Raspador x2, Parches x3 sin cantidad) y VT-1226/1227 (REFERENCIA "N/A"). Datos inventados.
// FUENTE=<archivo> permite correrla contra otra versión de DespachoPagina.jsx para comparar antes/después.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const dir = new URL('../src/pages/despacho/', import.meta.url)
const fuente = readFileSync(process.env.FUENTE || new URL('DespachoPagina.jsx', dir), 'utf8')
const copia = new URL('_probe_planilla.jsx', dir)
const salida = new URL('../_probe_planilla.out.mjs', import.meta.url)
const opts = {
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  loader: { '.jsx': 'jsx', '.js': 'jsx' }, logLevel: 'silent', jsx: 'automatic',
  define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
}
const extra = /function descProductoCourier/.test(fuente) ? ', descProductoCourier' : ''
writeFileSync(copia, fuente + `\nexport { mapearGrupoAPedidos, ventaAPedido, filaVentaDePedido, colapsarPorReferencia, getDesc${extra} }\n`)
let n = 0, fallas = 0
const ok = (m, f) => { try { f(); n++; console.log('✓ ' + m) } catch (e) { fallas++; console.log('✗ ' + m + '\n   ' + e.message.split('\n')[0]) } }
const fila = (nombre, extra = {}) => ({
  Name: nombre, 'Created at': '2026-11-11 10:00:00', Tags: 'CONFIRMADO, ORIGEN_WHATSAPP', Total: '158000', Subtotal: '158000',
  'Shipping Name': 'Cliente Prueba', 'Shipping City': 'Asunción', 'Shipping Address1': 'Calle Inventada 123',
  Phone: '0981000000', Vendor: 'VOLTRA PARAGUAY', 'Lineitem name': 'Raspador de Lengua: aliento más limpio', 'Lineitem quantity': '2', 'Lineitem price': '79000',
  ...extra,
})
try {
  buildSync({ ...opts, entryPoints: [copia.pathname], outfile: salida.pathname })
  const D = await import(pathToFileURL(salida.pathname).href)
  // Lo que escribe la columna PRODUCTO de Lucero (y la DESCRIPCION de PaP) para un paquete ya colapsado.
  const producto = (p) => D.descProductoCourier ? D.descProductoCourier(p) : (p.esMultiProducto ? p.descripcionCombinada : D.getDesc(p.producto_nombre, p.cantidad))

  ok('producto: 2 raspadores → "… x2"; 3 parches → "… x3"', () => {
    const [r] = D.colapsarPorReferencia(D.mapearGrupoAPedidos([fila('#9101')]))
    assert.match(producto(r), /x2$/)
    const [pa] = D.colapsarPorReferencia(D.mapearGrupoAPedidos([fila('#9102', { 'Lineitem name': 'Parches Bucales: dormí por la nariz', 'Lineitem quantity': '3' })]))
    assert.match(producto(pa), /Parches bucales \(30 unidades\) x3$/)
  })
  ok('producto: 1 unidad → "x1"; el mixto sigue igual ("x1 + … x2")', () => {
    const [u] = D.colapsarPorReferencia(D.mapearGrupoAPedidos([fila('#9103', { 'Lineitem quantity': '1' })]))
    assert.match(producto(u), /x1$/)
    const mix = D.colapsarPorReferencia(D.mapearGrupoAPedidos([
      fila('#9104', { 'Lineitem name': 'Botella Deportiva Flexible: se enrolla y no pesa', 'Lineitem quantity': '1' }),
      { Name: '#9104', 'Lineitem name': 'Inhalador de Menta: frescura en 1 respiro', 'Lineitem quantity': '2', 'Lineitem price': '0' },
    ]))
    assert.equal(mix.length, 1)
    assert.equal(producto(mix[0]), 'Botella Flexible Flow 500 Negro x1 + Inhalador de menta (2 unidades) x2')
  })
  ok('referencia: la toma de la nota del pedido (Notes) como la escribe el bot', () => {
    const [p] = D.mapearGrupoAPedidos([fila('#9105', { 'Shipping Address2': 'Esquina Inventada', Notes: 'Pedido creado por el vendedor con IA (WhatsApp).\nCalle: Calle Inventada 123\nReferencia: Esquina Inventada' })])
    assert.equal(p.referencia_dir, 'Esquina Inventada')
    assert.equal(p.direccion, 'Calle Inventada 123, Esquina Inventada') // sin repetirla entre paréntesis
  })
  ok('referencia: sin nota, toma Address2; un link o un pin en Address2 no es referencia', () => {
    const [p] = D.mapearGrupoAPedidos([fila('#9106', { 'Shipping Address2': 'Portón verde frente a la plaza' })])
    assert.equal(p.referencia_dir, 'Portón verde frente a la plaza')
    const [q] = D.mapearGrupoAPedidos([fila('#9107', { 'Shipping Address2': 'Pin de ubicación https://maps.google.com/?q=-25.3,-57.6' })])
    assert.equal(q.referencia_dir, '')
  })
  ok('referencia: el atributo "Referencia" de Releasit sigue mandando', () => {
    const [p] = D.mapearGrupoAPedidos([fila('#9108', { 'Note Attributes': 'Referencia: Casa celeste', 'Shipping Address2': 'Otra cosa' })])
    assert.equal(p.referencia_dir, 'Casa celeste')
  })
  ok('Desde Ventas: la referencia se guarda en ventas.notas y vuelve a la planilla', () => {
    const [p] = D.mapearGrupoAPedidos([fila('#9109', { 'Shipping Address2': 'Esquina Inventada' })])
    const v = D.filaVentaDePedido({ ...p, transportadora: 'lucero', tienda: 'voltra' }, [{ id: 'r', nombre: 'Raspador de Lengua', costo_unit: 7000, precio_1u: 79000 }])
    assert.match(String(v.notas || ''), /^Referencia: Esquina Inventada$/m)
    const ped = D.ventaAPedido({ ...v, n_referencia: 'VT-9109', cantidad: 2, producto_nombre: 'Raspador de Lengua' })
    assert.equal(ped.referencia_dir, 'Esquina Inventada')
    assert.equal(D.ventaAPedido({ n_referencia: 'VT-9110', notas: 'RUC 1234567-8' }).referencia_dir, '')
  })
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true })
}
console.log(`\n${n} bloques de planilla-courier OK${fallas ? ` · ${fallas} FALLAN` : ''}`)
if (fallas) process.exit(1)
