// tests/cobranza.test.mjs
// ═══════════════════════════════════════════════════════════
// GUARDIÁN: subir un archivo de courier NUNCA puede borrar plata cobrada.
//
// Origen: exportLucero escribía `rendido: it.rendido` sin condición. Si
// conciliabas un pago desde la planilla de rendición y después subías un
// export descargado ANTES de que Lucero lo registrara, volvía `rendido` a
// false y borraba fecha_rendido. Había 83 filas rendidas por 7.704.000 Gs
// expuestas a perderse en la próxima subida.
//
// La regla que este test protege: el export es fuente de TRACKING; la
// rendición es la fuente CONTABLE. El tracking nunca degrada lo contable.
//
// Correr:  node --import ./tests/registrar.mjs tests/cobranza.test.mjs
// ═══════════════════════════════════════════════════════════
import { exportLuceroAEntregas, categoriaLucero as catExport } from '../src/lib/exportLucero.js'
import { categoriaLucero as catRendicion } from '../src/lib/rendicionLucero.js'
import { combinar } from '../src/lib/importarPaP.js'
import { normalizarRef, normalizarTel } from '../src/lib/referencias.js'
import { calcularMetricasAds } from '../src/lib/metricasAds.js'
import { sanearEntrega } from '../src/lib/estadosPaP.js'
import { esArchivoRendicion, parsearFilasRendicion, conciliarRendicion } from '../src/lib/conciliacionRendicion.js'
import { indexarVentas } from '../src/lib/vinculacion.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

console.log('── el export de Lucero no puede des-rendir ──')
{
  const item = (rendido) => ({
    referencia: '2018', estado: 'Entregado', categoria: 'entregado',
    total: 98000, rendido, fechaRendicion: rendido ? '2026-07-15' : null,
    fechaCreado: '2026-07-10', fechaUltimoEstado: '2026-07-14',
    ciudad: 'ASUNCION', producto: 'JawFlex', tarifa: null, multa: 0,
  })
  const sinRendir = exportLuceroAEntregas([item(false)])[0]
  const conRendir = exportLuceroAEntregas([item(true)])[0]

  ok(!('rendido' in sinRendir),
    'si el export dice que NO está rendido, omite la clave en vez de escribir false')
  ok(!('fecha_rendido' in sinRendir),
    'tampoco borra fecha_rendido')
  ok(conRendir.rendido === true && conRendir.fecha_rendido === '2026-07-15',
    'si el export dice que SÍ está rendido, lo escribe con su fecha')
}

console.log('\n── la clave de guía siempre deriva de la referencia ──')
{
  // Las 2 filas fantasma de julio salieron de usar el EnvioID de Lucero como
  // clave. La clave tiene que depender SOLO de la referencia propia.
  const r = exportLuceroAEntregas([{
    referencia: '2018', estado: 'Entregado', categoria: 'entregado', total: 98000,
    envioId: '14763', rendido: false, fechaCreado: '2026-07-10', ciudad: 'X', producto: 'Y',
  }])[0]
  ok(r.nro_guia_pap === 'L-2018', 'la clave es L-<referencia>, nunca el EnvioID')
  ok(!String(r.nro_guia_pap).includes('14763'), 'el EnvioID no contamina la clave')
}

console.log('\n── las dos categoriaLucero difieren a propósito ──')
{
  ok(catExport('Fallido') === 'en_proceso',
    'en el export EN VIVO, fallido sigue en tránsito (Lucero reintenta)')
  ok(catRendicion('Fallido') === 'devuelto',
    'en la rendición (cierre), fallido ya es una devolución')
  ok(catExport('Entregado') === 'entregado' && catRendicion('Entregado') === 'entregado',
    'coinciden en lo que sí es terminal')
}

console.log('\n── el importador de PaP avisa de los entregados sin plata ──')
{
  const gestion = { rows: [
    { NroGuia: '111', NroGuiaRef: '1891', Estado: 'ENTREGADO', Importe: 0, Ciudad: 'CDE' },
    { NroGuia: '222', NroGuiaRef: '1892', Estado: 'ENTREGADO', Importe: 98000, Ciudad: 'CDE' },
    { NroGuia: '333', NroGuiaRef: '1893', Estado: 'DEVUELTO', Importe: 0, Ciudad: 'CDE' },
  ] }
  const out = combinar(null, gestion)
  const avisos = out.entregadosSinImporte || []
  ok(avisos.length === 1, 'reporta exactamente el entregado con importe 0')
  ok(avisos[0]?.ref === '1891', 'y dice cuál es')
  ok(Array.isArray(out.importesDescartados), 'sigue reportando los importes corruptos')
}

console.log('\n── una sola normalización de referencias ──')
{
  // Rendición tenía su propia copia: 'WA-0007' le daba '0007' mientras el resto
  // del sistema daba '7', así que los prepagos de WhatsApp no se reconocían.
  ok(normalizarRef('WA-0007') === '7', "'WA-0007' normaliza a '7'")
  ok(normalizarRef('L-2018') === '2018', "'L-2018' normaliza a '2018'")
  ok(normalizarRef('00123') === '123', "'00123' normaliza a '123'")
  ok(normalizarRef('WA-0007') === normalizarRef('wa-7'),
    'el mismo pedido escrito de dos formas da la misma clave')
}

console.log('\n── el teléfono cruza al mismo cliente escriba como escriba ──')
{
  // Los números copiados de WhatsApp o del iPhone vienen envueltos en marcas
  // de dirección de texto INVISIBLES. limpiarTel solo sacaba espacios, guiones
  // y paréntesis, así que '\u202a+595 973 337800\u202c' quedaba como
  // '0\u202a+595973337800\u202c' y ese cliente no cruzaba con ninguna otra venta
  // suya: se rompían recompra, riesgo y la vinculación por teléfono.
  const casos = [
    ['\u202a+595 973 337800\u202c', '0973337800', 'con marcas invisibles de iOS/WhatsApp'],
    ['+595 981 101281', '0981101281', 'con prefijo internacional y espacios'],
    ['595981101281', '0981101281', 'sin el +'],
    ['981101281', '0981101281', 'sin el 0 inicial'],
    ['(0981) 101-281', '0981101281', 'con paréntesis y guion'],
    ['0981101281', '0981101281', 'ya canónico'],
  ]
  for (const [entrada, esperado, desc] of casos) {
    ok(normalizarTel(entrada) === esperado, `${desc} → ${esperado}`)
  }
  ok(normalizarTel('\u202a+595 981 101281\u202c') === normalizarTel('0981101281'),
    'el mismo cliente pegado de WhatsApp y tipeado a mano dan la misma clave')
  ok(normalizarTel('') === '' && normalizarTel(null) === '',
    'vacío y null no revientan')
}

console.log('\n── el CPA cuenta pedidos, no líneas ──')
{
  // Un pedido de 2 productos son 2 filas en `ventas`. Contarlas como 2 pedidos
  // abarataba el CPA a la mitad y hacía ver campañas mejores de lo que son.
  const unPedidoDosLineas = [
    { n_referencia: '5001', fecha: '2026-08-10', total: 129000, estado: 'entregado', costo_prod: 20000, costo_envio: 29000 },
    { n_referencia: '5001', fecha: '2026-08-10', total: 99000,  estado: 'entregado', costo_prod: 15000, costo_envio: 0 },
  ]
  const m = calcularMetricasAds(100000, unPedidoDosLineas, {}, 12000)
  ok(m.despachados === 1, 'dos líneas de la misma referencia son UN pedido despachado')
  ok(m.entregados === 1, 'y UN pedido entregado')
  ok(m.cpaReal === 100000, 'el CPA real es el gasto entero sobre 1 pedido, no la mitad')
  ok(m.cobrado === 228000, 'la plata sí se suma por línea (129.000 + 99.000)')

  // El flete va una sola vez: la línea secundaria tiene costo_envio 0 y ese 0
  // no puede caer al flete por defecto (era un `||` en vez de un `??`).
  ok(m.flete === 29000, 'el flete se cuenta una sola vez, no una por línea')

  const mixto = [
    { n_referencia: '5002', fecha: '2026-08-11', total: 129000, estado: 'entregado', costo_prod: 20000, costo_envio: 29000 },
    { n_referencia: '5002', fecha: '2026-08-11', total: 99000,  estado: 'devuelto',  costo_prod: 15000, costo_envio: 0 },
  ]
  const m2 = calcularMetricasAds(50000, mixto, {}, 12000)
  ok(m2.entregados + m2.devueltos === 1, 'un pedido mitad entregado y mitad devuelto cuenta UNA vez')
  ok(m2.tasaEntrega <= 1, 'la tasa de entrega nunca pasa de 100%')

  const dosPedidos = [
    { n_referencia: '6001', fecha: '2026-08-12', total: 129000, estado: 'entregado', costo_prod: 20000, costo_envio: 29000 },
    { n_referencia: '6002', fecha: '2026-08-12', total: 129000, estado: 'entregado', costo_prod: 20000, costo_envio: 29000 },
  ]
  const m3 = calcularMetricasAds(100000, dosPedidos, {}, 12000)
  ok(m3.entregados === 2, 'dos referencias distintas siguen siendo dos pedidos')
  ok(m3.cpaReal === 50000, 'y el CPA se reparte entre los dos')
}

console.log('\n── sanearEntrega no le aplica las reglas de PaP a Lucero ──')
{
  // categorizarPaP conoce el vocabulario de Punto a Punto. Las filas de Lucero
  // ya vienen categorizadas por su propio módulo. Aplicarles las de PaP hacía
  // que 3 envíos 'Cancelado' guardados como devueltos pasaran a 'en_proceso',
  // o sea a figurar como plata en tránsito para siempre.
  const luceroCancelado = { transportadora: 'lucero', estado_pap: 'Cancelado', categoria: 'devuelto', importe: 98000, motivo: '' }
  ok(sanearEntrega(luceroCancelado).categoria === 'devuelto',
    "un 'Cancelado' de Lucero sigue siendo devuelto")

  const luceroEntregado = { transportadora: 'lucero', estado_pap: 'Entregado', categoria: 'entregado', importe: 98000, motivo: '' }
  const sl = sanearEntrega(luceroEntregado)
  ok(sl.categoria === 'entregado' && sl.cobrado === 98000, 'y un entregado de Lucero se cobra')

  // Las filas de PaP sí se siguen recategorizando: para eso existe la función.
  const papViejo = { transportadora: 'pap', estado_pap: 'ENTREGADO', categoria: 'en_proceso', importe: 98000, motivo: '' }
  ok(sanearEntrega(papViejo).categoria === 'entregado',
    'una fila vieja de PaP mal guardada se corrige igual que antes')

  // El tope de sanidad del importe es universal, no depende del courier.
  const veneno = { transportadora: 'lucero', estado_pap: 'Entregado', categoria: 'entregado', importe: 2147483647, motivo: '' }
  ok(Math.abs(sanearEntrega(veneno).importe) <= 2000000,
    'el tope de importe se sigue aplicando a Lucero')
}

console.log('\n── la rendición no acepta el archivo equivocado ──')
{
  // El reporte de Gestión también trae NroGuia. Si se subía ahí, sus filas no
  // tienen Cobrado, quedaban todas en null, y la conciliación las leía como
  // "no cobrado": proponía tocar decenas de guías que nunca se rindieron.
  const rendicion = [{ NroGuia: '26214651', Cobrado: 110000, FormaPago: 'Efectivo', Importe: 110000 }]
  const gestion = [{ NroGuia: '26214651', Estado: 'ENTREGADO', Ciudad: 'CDE', FechaEnt: '2026-08-01' }]
  ok(esArchivoRendicion(rendicion) === true, 'la planilla de rendición se acepta')
  ok(esArchivoRendicion(gestion) === false, 'el reporte de Gestión se rechaza')
  ok(esArchivoRendicion([]) === false && esArchivoRendicion(null) === false,
    'vacío y null se rechazan sin reventar')
  ok(esArchivoRendicion([{ ' NroGuia ': '1', ' Cobrado ': 0 }]) === true,
    'las cabeceras con espacios de más se reconocen igual')
}

console.log('\n── ninguna forma de pago desaparece del resumen ──')
{
  // Lo que no dice "efectivo" ni "transfer" (POS, QR, "Pagado"…) no entraba en
  // ningún total: la guía se marcaba rendida y esa plata desaparecía.
  const filas = parsearFilasRendicion([
    { NroGuia: '1', Cobrado: 100000, FormaPago: 'Efectivo', Importe: 100000 },
    { NroGuia: '2', Cobrado: null,   FormaPago: 'Transferencia', Importe: 120000 },
    { NroGuia: '3', Cobrado: 90000,  FormaPago: 'Pagado', Importe: 90000 },
    { NroGuia: '4', Cobrado: 80000,  FormaPago: 'POS', Importe: 80000 },
  ])
  const c = conciliarRendicion(filas, [])
  ok(c.totalEfectivo === 100000, 'el efectivo se cuenta como antes')
  ok(c.totalTransferencia === 120000, 'la transferencia también')
  ok(c.countOtra === 2 && c.totalOtra === 170000,
    'las dos formas no reconocidas suman 170.000 en su propio total')
  const nombres = c.formasNoReconocidas.map(f => f.forma).sort()
  ok(nombres.join(',') === 'POS,Pagado', 'y se dice exactamente cuáles fueron')
  ok(c.totalEfectivo + c.totalTransferencia + c.totalOtra === 390000,
    'nada de la planilla queda fuera de algún total')
}

console.log('\n── la vinculación entiende el monto de un pedido de varias líneas ──')
{
  // La entrega trae el importe del BULTO entero; cada fila de `ventas` guarda
  // el total de SU línea. Sin sumar el pedido, el desempate por monto no
  // acertaba nunca en un pedido de 2 productos.
  const ventas = [
    { id: 'a1', n_referencia: '7001', total: 129000, cliente_telefono: '0981000001', fecha: '2026-08-20' },
    { id: 'a2', n_referencia: '7001', total: 99000,  cliente_telefono: '0981000001', fecha: '2026-08-20' },
    { id: 'b1', n_referencia: '7002', total: 150000, cliente_telefono: '0981000002', fecha: '2026-08-20' },
  ]
  const ix = indexarVentas(ventas)
  ok(ix.totalPedidoPorVenta.get('a1') === 228000, 'las 2 líneas del pedido suman 228.000')
  ok(ix.totalPedidoPorVenta.get('a2') === 228000, 'y las dos filas conocen ese total')
  ok(ix.totalPedidoPorVenta.get('b1') === 150000, 'un pedido de una línea sigue valiendo su total')
  ok(ix.grupos.get('7001').ancla.id === 'a1', 'el ancla del pedido es estable (menor id)')
}

console.log(fallas ? `\n✗ ${fallas} falla(s)` : '\n✓ la plata cobrada está protegida')
process.exit(fallas ? 1 : 0)
