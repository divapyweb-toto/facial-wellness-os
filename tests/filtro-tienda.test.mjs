// El cliente de métricas filtra por tienda solo en lecturas de tablas con `tienda`.
import { supabase, supabaseTienda } from '../src/lib/supabase.js'
import { setTienda, getTienda, tiendaParaEscribir } from '../src/lib/tienda.js'
import { exportLuceroAEntregas } from '../src/lib/exportLucero.js'
import { combinar } from '../src/lib/importarPaP.js'
import { placeholderEntregaLucero } from '../src/lib/rendicionLucero.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }
const url = (b) => decodeURIComponent(b.url.toString())

console.log('── filtro de lecturas ──')
setTienda('voltra')
ok(getTienda() === 'voltra', 'por defecto la tienda activa es Voltra')
ok(url(supabaseTienda.from('ventas').select('*').is('deleted_at', null)).includes('tienda=eq.voltra'), 'ventas: lee solo Voltra')
ok(url(supabaseTienda.from('entregas').select('*')).includes('tienda=eq.voltra'), 'entregas: lee solo Voltra')
ok(!url(supabaseTienda.from('productos').select('*')).includes('tienda='), 'productos (catálogo compartido): sin filtro')
ok(!url(supabase.from('ventas').select('*')).includes('tienda='), 'el cliente operativo (Despacho, importadores) NO filtra')
setTienda('fw')
ok(url(supabaseTienda.from('gastos').select('*')).includes('tienda=eq.fw'), 'cambiar a Facial Wellness cambia el filtro al instante')
setTienda('todas')
ok(!url(supabaseTienda.from('ventas').select('*')).includes('tienda='), "'Todas' no filtra")
ok(tiendaParaEscribir() === 'fw', "en 'Todas' lo que se crea queda como fw (valor por defecto de la base)")
setTienda('voltra')
ok(tiendaParaEscribir() === 'voltra', 'en Voltra lo que se crea queda marcado voltra')
const ins = supabaseTienda.from('ventas').insert({ n_referencia: 'VT-1' })
ok(typeof ins.then === 'function' && !url(ins).includes('tienda=eq'), 'las escrituras no se tocan')

console.log('\n── entregas: la tienda sale de la referencia ──')
const item = (ref) => ({ referencia: ref, codigo: ref, estado: 'Cargado', categoria: 'en_proceso', total: 1000, envioId: '', ciudad: 'X', producto: 'P' })
const f = exportLuceroAEntregas([item('VT-1003'), item('2071')])
ok(f[0].tienda === 'voltra' && f[1].tienda === 'fw', 'export de Lucero: VT-1003 → voltra, 2071 → fw')
const ph = placeholderEntregaLucero({ n_referencia: 'VT-1003', total: 1, ciudad: 'X', producto_nombre: 'P', cantidad: 1, fecha: '2026-10-07', costo_envio: 0 })
ok(ph.tienda === 'voltra', 'placeholder de Lucero al despachar: voltra')
const pap = combinar(null, { rows: [{ NroGuia: '261', NroGuiaRef: 'VT-1003', Estado: 'ENTREGADO', Importe: 1000, Ciudad: 'CDE' }] })
ok(pap[0].tienda === 'voltra', 'importador de PaP: voltra')

console.log(fallas ? `\n✗ ${fallas} falla(s)` : '\n✓ las métricas de Voltra y FW quedan separadas')
process.exit(fallas ? 1 : 0)
