// Pedidos del vendedor IA de WhatsApp: el teléfono viene en Phone / Shipping Phone
// y la nota trae "origen: whatsapp" (eso NO es un teléfono). Datos inventados.
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const dir = new URL('../src/pages/despacho/', import.meta.url)
const copia = new URL('_probe_tel.jsx', dir)
const salida = new URL('../_probe_tel.out.mjs', import.meta.url)
writeFileSync(copia, readFileSync(new URL('DespachoPagina.jsx', dir), 'utf8') + '\nexport { parseCSVRobust, mapearGrupoAPedidos }\n')
try {
  buildSync({
    entryPoints: [copia.pathname], bundle: true, platform: 'node', format: 'esm', packages: 'external',
    loader: { '.jsx': 'jsx' }, outfile: salida.pathname, logLevel: 'silent',
    define: { 'import.meta.env': '{"VITE_SUPABASE_URL":"http://localhost","VITE_SUPABASE_ANON_KEY":"x"}' },
  })
  const { parseCSVRobust, mapearGrupoAPedidos } = await import(pathToFileURL(salida.pathname).href)

  const cab = 'Name,Billing Phone,Shipping Name,Shipping Address1,Shipping City,Shipping Phone,Note Attributes,Tags,Vendor,Total,Subtotal,Created at,Lineitem quantity,Lineitem name,Lineitem price,Phone'
  const fila = (n, tel) => `${n},,Cliente Uno,Calle 1,Capiatá,${tel},"origen: whatsapp\nconversacion_id: abc\nfactura: 1-0 Cliente Uno",CONFIRMADO ORIGEN_WHATSAPP,VOLTRA PARAGUAY,112000,79000,2026-10-07 16:45:30 -0300,1,Tiras Nasales,79000,${tel}`
  const filas = parseCSVRobust(`${cab}\n${fila('#1003', '+595984000001')}\n${fila('#1004', '+595981000002')}\n`)
  const tels = filas.map(f => mapearGrupoAPedidos([f])[0].telefono)
  assert.deepEqual(tels, ['0984000001', '0981000002'])

  // Si no hay ningún teléfono, queda vacío (y se avisa como faltante), no "whatsapp".
  const sin = parseCSVRobust(`${cab}\n${fila('#1005', '')}\n`)
  assert.equal(mapearGrupoAPedidos([sin[0]])[0].telefono, '')
  console.log('✓ teléfono de pedidos del vendedor IA (2 casos + sin teléfono)')
} finally {
  rmSync(copia, { force: true }); rmSync(salida, { force: true })
}
