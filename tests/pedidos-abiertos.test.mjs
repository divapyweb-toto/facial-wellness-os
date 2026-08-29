// tests/pedidos-abiertos.test.mjs
// ═══════════════════════════════════════════════════════════
// Los tres pedidos que el sistema tiene que poder registrar:
//   1. mayorista de 10 tiras + 10 parches (antes IMPOSIBLE de cargar)
//   2. pedido web con descuento
//   3. pedido común de 1 unidad a precio de lista
// Y que margen, stock, export a courier y analytics den bien en los tres.
//
// Correr:  npm test
// ═══════════════════════════════════════════════════════════
import { precioSugerido, precioUnitarioSugerido, totalLinea, avisoPrecio, totalesPedido, filasDeVenta } from '../src/lib/pedidos.js'

let f = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) f++ }

const TIRAS   = { id: 't', nombre: 'Tiras nasales',   costo_unit: 16000, grupo_envio: 'A', precio_1u: 129000, precio_2u: 199000, precio_3u: 249000 }
const PARCHES = { id: 'p', nombre: 'Parches bucales', costo_unit: 16000, grupo_envio: 'A', precio_1u: 129000, precio_2u: 199000, precio_3u: 249000 }
const FLETE = 29000
const linea = (prod, cant, precio) => ({
  producto_id: prod.id, producto_nombre: prod.nombre, cantidad: cant,
  precio: precio ?? precioSugerido(prod, cant),
  precio_lista: precioSugerido(prod, cant),
  costo_prod: prod.costo_unit * cant,
})

console.log('── 1. MAYORISTA: 10 tiras + 10 parches ──')
// Negociado a 700.000 cada mitad; la lista extrapolada daría 830.000.
const may = [linea(TIRAS, 10, 700000), linea(PARCHES, 10, 700000)]
const tMay = totalesPedido(may, { envioCliente: 0, costoEnvio: FLETE })
ok(tMay.unidades === 20, `20 unidades en 2 líneas (el <select> viejo topaba en 3)`)
ok(tMay.total === 1400000, `total ${tMay.total.toLocaleString('es-PY')} Gs`)
ok(tMay.descuento === 260000, `descuento contra lista: ${tMay.descuento.toLocaleString('es-PY')} Gs`)
const fMay = filasDeVenta({ n_referencia: 'WA-0009', es_mayorista: true, fecha: '2026-08-26' }, may, { envioCliente: 0, costoEnvio: FLETE })
ok(fMay.length === 2 && fMay.every(x => x.n_referencia === 'WA-0009'), '2 filas con la MISMA referencia = un pedido')
ok(fMay[0].costo_envio === FLETE && fMay[1].costo_envio === 0, 'flete solo en la primera línea (una caja, un flete)')
// margen y ganancia_neta son columnas generadas: total − costo_prod, y luego − flete
const margen = fMay.reduce((s, x) => s + (x.total - x.costo_prod), 0)
const ganancia = margen - FLETE
ok(margen === 1400000 - 320000, `margen ${margen.toLocaleString('es-PY')} = total − costo`)
ok(ganancia === 1051000, `ganancia neta ${ganancia.toLocaleString('es-PY')} (flete contado UNA vez)`)
ok(fMay.every(x => x.es_mayorista), 'las 2 filas quedan marcadas mayorista → excluibles del análisis de ads')
ok(fMay.reduce((s, x) => s + x.cantidad, 0) === 20, 'stock: 20 unidades a descontar, sin tope')

console.log('\n── 2. PEDIDO WEB CON DESCUENTO ──')
const web = [linea(TIRAS, 1, 99000)]   // lista 129.000, se cobró 99.000
const aviso = avisoPrecio(99000, 129000)
ok(aviso && aviso.esDescuento && aviso.pct === -23, `avisa el descuento: ${aviso.texto}`)
const tWeb = totalesPedido(web, { envioCliente: 0, costoEnvio: FLETE })
ok(tWeb.total === 99000, 'el total es el precio REALMENTE cobrado, no el de lista')
ok(tWeb.contribucion === 99000 - 16000 - FLETE, `contribución ${tWeb.contribucion.toLocaleString('es-PY')} — el descuento baja el margen, como debe`)
const fWeb = filasDeVenta({ n_referencia: '2250', es_mayorista: false }, web, { envioCliente: 0, costoEnvio: FLETE })
ok(fWeb[0].precio_lista === 129000, 'guarda el precio de lista → el descuento es reconstruible después')
ok(!fWeb[0].es_mayorista, 'no es mayorista → SÍ entra en el análisis de ads')

console.log('\n── 3. PEDIDO COMÚN: 1 unidad a precio de lista ──')
const com = [linea(TIRAS, 1)]
ok(com[0].precio === 129000, 'el precio se precarga solo de la lista')
ok(avisoPrecio(com[0].precio, com[0].precio_lista) === null, 'sin aviso: coincide con la lista')
const tCom = totalesPedido(com, { envioCliente: 0, costoEnvio: FLETE })
ok(tCom.total === 129000 && tCom.descuento === 0, 'total 129.000, sin descuento')
ok(tCom.contribucion === 84000, `contribución ${tCom.contribucion.toLocaleString('es-PY')} — coincide con la tabla de precios nuevos`)
const fCom = filasDeVenta({ n_referencia: '2251' }, com, { envioCliente: 0, costoEnvio: FLETE })
ok(fCom.length === 1, 'una sola fila: el caso común no se complica')

console.log('\n── el envío se cuenta UNA vez, no por línea ──')
const conEnvio = filasDeVenta({}, may, { envioCliente: 33000, costoEnvio: FLETE })
ok(conEnvio[0].envio_cliente === 33000 && conEnvio[1].envio_cliente === 0, 'envío cobrado solo en la primera')
ok(conEnvio.reduce((s, x) => s + x.costo_envio, 0) === FLETE, 'el flete NO se duplica entre líneas')

console.log('\n── se carga PRECIO POR UNIDAD y el total lo saca el sistema ──')
// Escribir el total a mano en un pedido de 20 unidades es justo donde se
// cuela el error de cuentas.
ok(precioUnitarioSugerido(TIRAS, 1) === 129000, 'x1 sugiere 129.000 c/u')
ok(precioUnitarioSugerido(TIRAS, 3) === 83000, 'x3 sugiere 83.000 c/u (249.000 / 3)')
ok(precioUnitarioSugerido(TIRAS, 10) === 83000, 'x10 mantiene el unitario del tramo de 3')
ok(totalLinea(70000, 10) === 700000, '10 x 70.000 negociado = 700.000')
ok(totalLinea(83000, 20) === 1660000, '20 x 83.000 = 1.660.000')
ok(totalLinea(0, 10) === 0, 'precio 0 da total 0 (muestra o regalo)')

console.log('\n── ENVÍO SIN COSTO (lo lleva un conocido) ──')
const gratis = totalesPedido([linea(TIRAS, 1)], { envioCliente: 0, costoEnvio: 0 })
ok(gratis.contribucion === 129000 - 16000, `sin flete la contribución sube a ${gratis.contribucion.toLocaleString('es-PY')}`)
const fGratis = filasDeVenta({ n_referencia: 'WA-0010' }, [linea(TIRAS, 1)], { envioCliente: 0, costoEnvio: 0 })
ok(fGratis[0].costo_envio === 0, 'el flete 0 se guarda como 0, no cae al valor por defecto')

console.log(f ? `\n✗ ${f} FALLAS` : '\n✓ los 3 pedidos se registran y calculan bien')
process.exit(f ? 1 : 0)
