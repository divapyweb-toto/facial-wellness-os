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

console.log(fallas ? `\n✗ ${fallas} falla(s)` : '\n✓ la plata cobrada está protegida')
process.exit(fallas ? 1 : 0)
