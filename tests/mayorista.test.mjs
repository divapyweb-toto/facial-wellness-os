// Pedido mayorista + Datos de factura (RUC): lógica pura de src/lib/mayorista.js.
// Datos inventados (repo público): RUC de prueba con el DV calculado, no de empresas reales.
import {
  dvRuc, validarRuc, separarRuc, validarFiscal, validarCondicion, validarItems, totalPedido,
  validarPedidoMayorista, armarPayload, estadoFacturaPedido, filaDatosFiscales, origenAlGuardar,
  nombrePedidoDesdeRef, nuevaClaveIdempotencia, aEntero, estadoPedidoMayorista, estadoFacturaCorto,
} from '../src/lib/mayorista.js'

let fallas = 0
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fallas++ }

// DV de referencia calculado a mano con la fórmula del MT (pesos 2..11 desde la derecha):
// 1234567 → 7·2+6·3+5·4+4·5+3·6+2·7+1·8 = 14+18+20+20+18+14+8 = 112; 112 % 11 = 2; DV = 11-2 = 9.
console.log('── RUC: DV módulo 11 (misma fórmula que cdc.ts dvModulo11) ──')
ok(dvRuc('1234567') === 9, 'DV de 1234567 = 9 (cuenta a mano)')
// 80177762 (el emisor del contrato, dato público del propio Voltra): DV 3.
ok(dvRuc('80177762') === 3, 'DV del RUC del emisor (80177762) = 3, como el Form. 364')
ok(dvRuc('12a') === null && dvRuc('') === null, 'letras o vacío → null')
ok(validarRuc('1234567-9').ok && validarRuc('1.234.567-9').ok && validarRuc('1234567 9').ok, 'acepta 1234567-9, con puntos y con espacio')
ok(validarRuc('1234567', '9').ok, 'acepta RUC y DV por separado')
ok(!validarRuc('1234567-8').ok && /debería ser 9/.test(validarRuc('1234567-8').error), 'DV mal → dice cuál debería ser')
ok(!validarRuc('12345679').ok, 'sin guion no se adivina el DV (pedí el formato)')
ok(!validarRuc('').ok && !validarRuc('01234-5').ok && !validarRuc('12-1').ok && !validarRuc('123456789-1').ok, 'vacío, con 0 adelante, muy corto o muy largo → inválido')
ok(JSON.stringify(separarRuc('1.234.567-9')) === JSON.stringify({ ruc: '1234567', dv: '9' }), 'separarRuc saca los puntos')

console.log('\n── Datos fiscales y condición ──')
ok(validarFiscal({ ruc: '1234567-9', razon_social: 'Empresa  Prueba  S.A.' }).datos?.razon_social === 'Empresa Prueba S.A.', 'razón social sin espacios dobles')
ok(!validarFiscal({ ruc: '1234567-9', razon_social: ' ' }).ok, 'razón social obligatoria')
ok(validarFiscal({ ruc: '1234567-9', razon_social: 'X SA', email: 'malo' }).errores?.email, 'email opcional pero si viene tiene que ser válido')
ok(validarFiscal({ ruc: '1234567-9', razon_social: 'X SA', email: '' }).datos?.email === null, 'email vacío → null')
ok(validarCondicion({ condicion: 'contado', plazo_dias: '30' }).plazo_dias === null, 'contado ignora el plazo')
ok(!validarCondicion({ condicion: 'credito' }).ok && !validarCondicion({ condicion: 'credito', plazo_dias: '366' }).ok, 'crédito exige plazo 1..365')
ok(validarCondicion({ condicion: 'credito', plazo_dias: '30' }).plazo_dias === 30, 'crédito 30 días')

console.log('\n── Ítems y total ──')
const V = 'gid://shopify/ProductVariant/111'
ok(aEntero('1.250.000') === 1250000 && aEntero('Gs. 50.000') === 50000 && Number.isNaN(aEntero('12,5')), 'montos con puntos de miles; decimales no')
ok(!validarItems([]).ok, 'sin ítems → error')
ok(!validarItems([{ variant_id: V, cantidad: 0, precio_unitario: 1000 }]).ok, 'cantidad 0 → error')
ok(!validarItems([{ variant_id: V, cantidad: 2, precio_unitario: '0' }]).ok, 'precio 0 → error')
ok(!validarItems([{ variant_id: '', cantidad: 2, precio_unitario: 10 }]).ok, 'sin producto elegido → error')
ok(validarItems([{ variant_id: V, cantidad: '12', precio_unitario: '45.000' }]).items[0].precio_unitario === 45000, 'precio editable con puntos')
ok(totalPedido([{ cantidad: 12, precio_unitario: 45000 }, { cantidad: 3, precio_unitario: 10000 }], '25.000') === 12 * 45000 + 30000 + 25000, 'total = Σ + envío')

console.log('\n── Formulario completo ──')
const base = {
  nombre: 'Cliente Prueba', telefono: '0981 000000', direccion: 'Calle Falsa 123', ciudad: 'Ciudad del Este',
  ruc: '1234567-9', razon_social: 'EMPRESA DE PRUEBA S.A.', email: '',
  items: [{ variant_id: V, titulo: 'Producto A', cantidad: '10', precio_unitario: '50.000' }],
  envio: '30.000', cobro: 'contra_entrega', comprobante_ref: '', condicion: 'contado', plazo_dias: '',
  anterior_al_corte: false, fecha_entrega: '', nota: '',
}
const ctx = { hoy: '2026-10-10', facturarDesde: null }
const v0 = validarPedidoMayorista(base, ctx)
ok(v0.ok && v0.total === 530000, `válido, total 530.000 (${v0.total})`)
ok(!validarPedidoMayorista({ ...base, ruc: '1234567-1' }, ctx).ok, 'RUC con DV mal frena el pedido')
ok(!validarPedidoMayorista({ ...base, razon_social: '' }, ctx).ok, 'sin razón social frena el pedido')
ok(validarPedidoMayorista({ ...base, cobro: 'transferencia_anticipada' }, ctx).errores.comprobante_ref, 'transferencia sin comprobante → error')
ok(validarPedidoMayorista({ ...base, condicion: 'credito', plazo_dias: '30', cobro: 'transferencia_anticipada', comprobante_ref: 'X123' }, ctx).errores.condicion, 'crédito + transferencia anticipada → error (es contado)')
const cred = validarPedidoMayorista({ ...base, condicion: 'credito', plazo_dias: '30' }, ctx)
ok(cred.ok && cred.avisos.some(a => a.includes('NO tiene que cobrar')), 'crédito → aviso de no cobrar en la entrega')
ok(!validarPedidoMayorista({ ...base, anterior_al_corte: true }, ctx).ok, 'anterior al corte exige fecha')
ok(!validarPedidoMayorista({ ...base, anterior_al_corte: true, fecha_entrega: '2026-10-12' }, ctx).ok, 'fecha futura → error')
ok(validarPedidoMayorista({ ...base, anterior_al_corte: true, fecha_entrega: '2026-09-12' }, ctx).ok, 'anterior al corte con fecha real → ok')
ok(!validarPedidoMayorista({ ...base, anterior_al_corte: true, fecha_entrega: '2026-10-06' }, { hoy: '2026-10-10', facturarDesde: '2026-10-05T00:00:00-03:00' }).ok, 'fecha posterior al corte → error')

const pl = armarPayload({ ...base, condicion: 'credito', plazo_dias: '45', nota: '  urgente ' }, 'clave-0001')
ok(pl.accion === 'crear' && pl.clave_idempotencia === 'clave-0001', 'payload: acción y clave')
ok(pl.fiscal.ruc === '1234567' && pl.fiscal.dv === '9', 'payload: RUC y DV separados')
ok(pl.items[0].cantidad === 10 && pl.items[0].precio_unitario === 50000 && pl.envio === 30000, 'payload: números enteros')
ok(pl.condicion === 'credito' && pl.plazo_dias === 45 && pl.nota === 'urgente' && pl.fecha_entrega === null, 'payload: condición, plazo, nota')
const k1 = nuevaClaveIdempotencia(), k2 = nuevaClaveIdempotencia()
ok(k1 !== k2 && /^[A-Za-z0-9-]{8,64}$/.test(k1), 'claves de idempotencia distintas y con el formato que acepta el servidor')

console.log('\n── Modal "Datos de factura" ──')
ok(!estadoFacturaPedido([]).bloqueado, 'sin factura → se puede cargar')
ok(estadoFacturaPedido([{ tipo_documento: 1, estado: 'aprobada', ambiente: 'prod', numero_completo: '001-001-0000007' }]).bloqueado, 'factura aprobada en producción → bloqueado (nota de crédito)')
ok(/nota de crédito/.test(estadoFacturaPedido([{ tipo_documento: 1, estado: 'aprobada', ambiente: 'prod' }]).texto), 'el aviso dice nota de crédito')
ok(estadoFacturaPedido([{ tipo_documento: 1, estado: 'pendiente', ambiente: 'prod' }]).bloqueado, 'emitiéndose → bloqueado')
const rev = estadoFacturaPedido([{ tipo_documento: 1, estado: 'revisar', ambiente: 'prod' }])
ok(!rev.bloqueado && rev.nivel === 'warning', "en 'revisar' → se puede corregir, con aviso")
ok(!estadoFacturaPedido([{ tipo_documento: 1, estado: 'aprobada', ambiente: 'test' }]).bloqueado, 'factura de prueba no bloquea')
ok(!estadoFacturaPedido([{ tipo_documento: 1, estado: 'rechazada', ambiente: 'prod' }]).bloqueado, 'rechazada → se puede corregir')
ok(!estadoFacturaPedido([{ tipo_documento: 5, estado: 'aprobada', ambiente: 'prod' }]).bloqueado, 'una nota de crédito sola no bloquea')
ok(origenAlGuardar({ origen: 'mayorista' }) === 'mayorista' && origenAlGuardar(null) === 'web_con_ruc' && origenAlGuardar({ origen: 'web_con_ruc' }) === 'web_con_ruc', 'origen: un mayorista sigue mayorista; si no, web_con_ruc')
const fila = filaDatosFiscales('9001', { ruc: '1234567-9', razon_social: 'Empresa Prueba', email: 'a@b.com', condicion: 'credito', plazo_dias: '15' }, null, 'u-1')
ok(fila.ok && fila.fila.shopify_order_id === 9001 && fila.fila.origen === 'web_con_ruc' && fila.fila.plazo_dias === 15 && fila.fila.cargado_por === 'u-1', 'fila para upsert')
ok(!filaDatosFiscales('abc', { ruc: '1234567-9', razon_social: 'X SA' }).ok, 'pedido inválido → no')
ok(!filaDatosFiscales(1, { ruc: '1234567-2', razon_social: 'X SA' }).ok, 'DV mal → no se guarda')

console.log('\n── Lista y referencias ──')
ok(nombrePedidoDesdeRef('VT-1003') === '#1003' && nombrePedidoDesdeRef('#1003') === '#1003' && nombrePedidoDesdeRef('VT-01003') === '#1003', 'VT-1003 / #1003 → #1003')
ok(nombrePedidoDesdeRef('sin número') === null, 'sin número → null')
ok(estadoPedidoMayorista({ tags: ['MAYORISTA', 'ANTERIOR_AL_CORTE'], estado_envio: 'ENTREGADO' }).texto === 'Anterior al corte', 'anterior al corte se distingue')
ok(estadoPedidoMayorista({ tags: ['MAYORISTA'], estado_envio: null }).texto === 'Por despachar', 'sin envío → por despachar')
ok(estadoPedidoMayorista({ tags: [], estado_confirmacion: 'cancelado_cliente' }).texto === 'Cancelado', 'cancelado')
ok(estadoFacturaCorto([], { motivo: 'anterior_al_corte', liberado_en: null }).startsWith('retenida'), 'factura retenida')
ok(estadoFacturaCorto([], null) === 'al entregar', 'sin factura → al entregar')

console.log(fallas ? `\n✗ ${fallas} falla(s)` : '\n✓ todo bien')
process.exit(fallas ? 1 : 0)
