// src/lib/mayorista.js
// ═══════════════════════════════════════════════════════════
// PEDIDO MAYORISTA + DATOS DE FACTURA (RUC) — lógica pura, sin Supabase ni React.
//
// La usan la pantalla "Pedido mayorista" (src/pages/mayorista) y el modal
// "Datos de factura" (src/components/DatosFactura.jsx). La Edge Function
// pedido-mayorista valida TODO de nuevo en el servidor con las mismas reglas
// (supabase/functions/pedido-mayorista/validar.ts; un test de Deno compara las dos).
//
// RUC paraguayo: número de 3 a 8 dígitos + dígito verificador (DV).
// DV por módulo 11, la MISMA fórmula que supabase/functions/_shared/sifen/cdc.ts
// dvModulo11 (MT A002 / D102): pesos 2..11 desde la derecha, ciclando;
// resto = suma % 11; DV = resto > 1 ? 11 - resto : 0.
// Solo dígitos: la cola de facturas (desde_pedido.ts) no acepta RUC con letras.
// ═══════════════════════════════════════════════════════════

export const COBROS = ['transferencia_anticipada', 'contra_entrega']
export const CONDICIONES = ['contado', 'credito']
export const PLAZO_MAX_DIAS = 365

const enteroPositivo = (n) => Number.isInteger(n) && n > 0

/** Gs sin separadores: "1.250.000" → 1250000; número → número; vacío/no válido → NaN. */
export function aEntero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  const s = String(v ?? '').trim().replace(/[.\s]/g, '').replace(/^Gs\.?/i, '')
  if (!/^-?\d+$/.test(s)) return NaN
  return Number(s)
}

/** DV del RUC por módulo 11 (cdc.ts dvModulo11 con baseMax 11). Solo dígitos. */
export function dvRuc(numero) {
  const d = String(numero ?? '').trim()
  if (!/^\d+$/.test(d)) return null
  let k = 2
  let total = 0
  for (let i = d.length - 1; i >= 0; i--) {
    if (k > 11) k = 2
    total += Number(d[i]) * k
    k++
  }
  const resto = total % 11
  return resto > 1 ? 11 - resto : 0
}

/**
 * Separa "1.234.567-8", "1234567 8" o RUC y DV por separado.
 * Devuelve { ruc, dv } (strings, sin puntos) o null si no se reconoce la forma.
 */
export function separarRuc(texto, dvAparte) {
  const t = String(texto ?? '').trim().replace(/\./g, '')
  if (dvAparte !== undefined && dvAparte !== null && String(dvAparte).trim() !== '') {
    return /^\d+$/.test(t) ? { ruc: t, dv: String(dvAparte).trim() } : null
  }
  const m = /^(\d+)\s*[-\s]\s*(\d)$/.exec(t)
  return m ? { ruc: m[1], dv: m[2] } : null
}

/**
 * Valida RUC + DV. Acepta "1234567-8" en un solo campo o ruc y dv separados.
 * { ok: true, ruc, dv, texto: "1234567-8" } | { ok: false, error }
 */
export function validarRuc(texto, dvAparte) {
  const crudo = String(texto ?? '').trim()
  if (!crudo) return { ok: false, error: 'Falta el RUC' }
  const p = separarRuc(crudo, dvAparte)
  if (!p) return { ok: false, error: 'Escribí el RUC con el dígito verificador: 1234567-8' }
  if (!/^[1-9]\d{2,7}$/.test(p.ruc)) return { ok: false, error: 'El RUC debe tener de 3 a 8 dígitos (sin el DV) y no empezar con 0' }
  if (!/^\d$/.test(p.dv)) return { ok: false, error: 'El dígito verificador es un solo número' }
  const esperado = dvRuc(p.ruc)
  if (esperado !== Number(p.dv)) return { ok: false, error: `El dígito verificador no corresponde: para ${p.ruc} debería ser ${esperado}. Revisá el RUC.` }
  return { ok: true, ruc: p.ruc, dv: p.dv, texto: `${p.ruc}-${p.dv}` }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** RUC + razón social (obligatorios) + email (opcional). */
export function validarFiscal({ ruc, dv, razon_social, email } = {}) {
  const errores = {}
  const r = validarRuc(ruc, dv)
  if (!r.ok) errores.ruc = r.error
  const razon = String(razon_social ?? '').trim().replace(/\s+/g, ' ')
  if (razon.length < 2) errores.razon_social = 'Falta la razón social (como figura en el RUC)'
  else if (razon.length > 255) errores.razon_social = 'La razón social no puede pasar de 255 caracteres'
  const mail = String(email ?? '').trim()
  if (mail && !EMAIL.test(mail)) errores.email = 'El email no es válido'
  if (Object.keys(errores).length) return { ok: false, errores }
  return { ok: true, datos: { ruc: r.ruc, dv: r.dv, razon_social: razon, email: mail || null } }
}

/** Condición de la factura: contado, o crédito con plazo (1 a 365 días). */
export function validarCondicion({ condicion, plazo_dias } = {}) {
  const c = condicion || 'contado'
  if (!CONDICIONES.includes(c)) return { ok: false, error: 'Condición inválida (contado o crédito)' }
  if (c === 'contado') return { ok: true, condicion: 'contado', plazo_dias: null }
  const p = aEntero(plazo_dias)
  if (!enteroPositivo(p) || p > PLAZO_MAX_DIAS) return { ok: false, error: `Crédito: poné el plazo en días (1 a ${PLAZO_MAX_DIAS})` }
  return { ok: true, condicion: 'credito', plazo_dias: p }
}

/** Ítems: producto (variante de Shopify), cantidad entera > 0, precio unitario entero > 0 (Gs, IVA incluido). */
export function validarItems(items) {
  const lista = Array.isArray(items) ? items : []
  const errores = []
  const limpios = []
  if (!lista.length) return { ok: false, errores: ['Agregá al menos un producto'], items: [] }
  lista.forEach((it, i) => {
    const n = i + 1
    const variant_id = String(it?.variant_id ?? '').trim()
    const cantidad = aEntero(it?.cantidad)
    const precio = aEntero(it?.precio_unitario)
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant_id)) errores.push(`Producto ${n}: elegí un producto de la lista`)
    if (!enteroPositivo(cantidad)) errores.push(`Producto ${n}: la cantidad tiene que ser un número entero mayor a 0`)
    else if (cantidad > 10000) errores.push(`Producto ${n}: cantidad demasiado grande (${cantidad})`)
    if (!enteroPositivo(precio)) errores.push(`Producto ${n}: el precio tiene que ser mayor a 0 (Gs, sin decimales)`)
    limpios.push({ variant_id, titulo: String(it?.titulo ?? '').trim(), cantidad, precio_unitario: precio })
  })
  return errores.length ? { ok: false, errores, items: limpios } : { ok: true, errores: [], items: limpios }
}

export const subtotalItems = (items) =>
  (items || []).reduce((s, it) => s + (aEntero(it?.cantidad) || 0) * (aEntero(it?.precio_unitario) || 0), 0)

/** Total del pedido = Σ cantidad × precio + envío (todo IVA incluido, como Shopify con taxesIncluded). */
export function totalPedido(items, envio) {
  const e = aEntero(envio)
  return subtotalItems(items) + (Number.isFinite(e) && e > 0 ? e : 0)
}

/** "2026-10-03" válido como fecha de calendario. */
function fechaValida(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f ?? ''))) return false
  const d = new Date(`${f}T12:00:00-03:00`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === f
}

/** Momento de una entrega "anterior al corte": mediodía de Paraguay de ese día. */
export const instanteEntrega = (fecha) => `${fecha}T12:00:00-03:00`

/**
 * Valida el formulario completo del pedido mayorista.
 * ctx: { hoy: 'YYYY-MM-DD', facturarDesde?: string|null } (facturarDesde = config_wa.sifen.facturar_desde).
 * Devuelve { ok, errores: { campo: mensaje }, avisos: [texto], total }.
 */
export function validarPedidoMayorista(form = {}, ctx = {}) {
  const errores = {}
  const avisos = []
  const nombre = String(form.nombre ?? '').trim()
  if (nombre.length < 2) errores.nombre = 'Falta el nombre del cliente'
  const telDigitos = String(form.telefono ?? '').replace(/\D/g, '')
  if (telDigitos.length < 9 || telDigitos.length > 13) errores.telefono = 'Teléfono inválido (ej. 0981 123456)'
  if (String(form.direccion ?? '').trim().length < 3) errores.direccion = 'Falta la dirección de entrega'
  if (String(form.ciudad ?? '').trim().length < 2) errores.ciudad = 'Falta la ciudad'

  const f = validarFiscal(form)
  if (!f.ok) Object.assign(errores, f.errores)

  const it = validarItems(form.items)
  if (!it.ok) errores.items = it.errores.join(' · ')

  const envio = form.envio === '' || form.envio == null ? 0 : aEntero(form.envio)
  if (!Number.isInteger(envio) || envio < 0) errores.envio = 'El envío tiene que ser 0 o un monto en Gs'

  const cobro = form.cobro
  if (!COBROS.includes(cobro)) errores.cobro = 'Elegí cómo cobra: transferencia anticipada o contra entrega'

  const cond = validarCondicion(form)
  if (!cond.ok) errores.plazo_dias = cond.error
  else if (cond.condicion === 'credito' && cobro === 'transferencia_anticipada') {
    errores.condicion = 'Si pagó por adelantado es contado, no crédito'
  }

  if (cobro === 'transferencia_anticipada' && !form.anterior_al_corte && String(form.comprobante_ref ?? '').trim().length < 3) {
    errores.comprobante_ref = 'Transferencia anticipada: anotá la referencia del comprobante (ueno)'
  }

  if (form.anterior_al_corte) {
    const fe = String(form.fecha_entrega ?? '').trim()
    if (!fechaValida(fe)) errores.fecha_entrega = 'Poné la fecha real en que se entregó y cobró'
    else if (ctx.hoy && fe > ctx.hoy) errores.fecha_entrega = 'La fecha de entrega no puede ser futura'
    else if (ctx.facturarDesde && new Date(instanteEntrega(fe)).getTime() >= new Date(ctx.facturarDesde).getTime()) {
      errores.fecha_entrega = `Esa fecha es posterior al corte de facturación (${String(ctx.facturarDesde).slice(0, 10)}): cargalo como pedido normal`
    }
    avisos.push('Ya entregado y cobrado: no se le manda ningún mensaje al cliente, no va al courier y la factura queda retenida para la contadora.')
  } else if (cond.ok && cond.condicion === 'credito') {
    avisos.push(`Crédito a ${cond.plazo_dias} días: el courier NO tiene que cobrar en la entrega. Avisale al despachar.`)
  }
  if (it.ok && envio === 0 && !form.anterior_al_corte) avisos.push('Envío en 0: confirmá que el envío corre por tu cuenta o que el cliente retira.')

  const total = totalPedido(it.items, Number.isInteger(envio) ? envio : 0)
  return { ok: Object.keys(errores).length === 0, errores, avisos, total }
}

/** Clave para que un doble clic (o un reintento) no cree dos pedidos en Shopify. */
export function nuevaClaveIdempotencia() {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  return 'mx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
}

/**
 * Cuerpo para la Edge Function pedido-mayorista (accion 'crear'). Asume el form ya validado.
 * Contrato (lo valida de nuevo validar.ts en el servidor):
 * { accion:'crear', clave_idempotencia, cliente:{nombre,telefono,direccion,referencia,ciudad},
 *   fiscal:{ruc,dv,razon_social,email}, items:[{variant_id,titulo,cantidad,precio_unitario}], envio,
 *   cobro, comprobante_ref, condicion, plazo_dias, anterior_al_corte, fecha_entrega, nota }
 */
export function armarPayload(form, clave) {
  const f = validarFiscal(form)
  const cond = validarCondicion(form)
  const it = validarItems(form.items)
  const anterior = !!form.anterior_al_corte
  return {
    accion: 'crear',
    clave_idempotencia: String(clave || ''),
    cliente: {
      nombre: String(form.nombre ?? '').trim().replace(/\s+/g, ' '),
      telefono: String(form.telefono ?? '').trim(),
      direccion: String(form.direccion ?? '').trim(),
      referencia: String(form.referencia ?? '').trim() || null,
      ciudad: String(form.ciudad ?? '').trim(),
    },
    fiscal: f.ok ? f.datos : null,
    items: it.items,
    envio: form.envio === '' || form.envio == null ? 0 : aEntero(form.envio),
    cobro: form.cobro,
    comprobante_ref: String(form.comprobante_ref ?? '').trim() || null,
    condicion: cond.ok ? cond.condicion : form.condicion,
    plazo_dias: cond.ok ? cond.plazo_dias : null,
    anterior_al_corte: anterior,
    fecha_entrega: anterior ? String(form.fecha_entrega ?? '').trim() : null,
    nota: String(form.nota ?? '').trim() || null,
  }
}

// ─── Estado de la factura de un pedido (para el modal "Datos de factura") ───

const LEGALES = ['aprobada', 'enviada', 'pendiente']

/**
 * filas de `facturas` del pedido (shopify_order_id, tipo_documento, estado, ambiente, numero_completo).
 * - Factura de producción aprobada / enviada / emitiéndose → bloqueado (hay que hacer nota de crédito).
 * - En 'revisar' o 'error' → se puede corregir (se avisa que después hay que reintentarla en Facturas).
 * - Solo de prueba (ambiente test) → se puede, con aviso.
 */
export function estadoFacturaPedido(facturas) {
  const fe = (facturas || []).filter(f => Number(f?.tipo_documento ?? 1) === 1)
  const prodLegal = fe.find(f => f.ambiente === 'prod' && LEGALES.includes(f.estado))
  if (prodLegal) {
    const num = prodLegal.numero_completo ? ` ${prodLegal.numero_completo}` : ''
    const texto = prodLegal.estado === 'aprobada'
      ? `Este pedido ya tiene la factura${num} aprobada por la SET. Para cambiar el RUC o la razón social hay que hacer una nota de crédito y una factura nueva.`
      : `La factura${num} se está emitiendo (${prodLegal.estado}). No se pueden cambiar los datos ahora; si sale mal, se corrige con nota de crédito.`
    return { bloqueado: true, nivel: 'error', texto }
  }
  const revisar = fe.find(f => f.estado === 'revisar' || f.estado === 'error')
  if (revisar) return { bloqueado: false, nivel: 'warning', texto: `La factura quedó en "${revisar.estado}". Corregí los datos acá y después reintentala desde Facturas.` }
  const prueba = fe.find(f => f.ambiente === 'test' && LEGALES.includes(f.estado))
  if (prueba) return { bloqueado: false, nivel: 'info', texto: 'Hay una factura de PRUEBA (no vale ante la SET). Los cambios se usan en la factura real.' }
  return { bloqueado: false, nivel: null, texto: '' }
}

/** Origen de la fila al guardar desde el modal: un pedido mayorista sigue siendo 'mayorista'. */
export const origenAlGuardar = (filaExistente) => (filaExistente?.origen === 'mayorista' ? 'mayorista' : 'web_con_ruc')

/** Fila para upsert en pedido_datos_fiscales (el modal). null si no valida. */
export function filaDatosFiscales(shopifyOrderId, form, filaExistente, usuarioId) {
  const id = Number(shopifyOrderId)
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, errores: { general: 'Pedido inválido' } }
  const f = validarFiscal(form)
  const c = validarCondicion(form)
  if (!f.ok || !c.ok) return { ok: false, errores: { ...(f.ok ? {} : f.errores), ...(c.ok ? {} : { plazo_dias: c.error }) } }
  return {
    ok: true,
    fila: {
      shopify_order_id: id,
      ruc: f.datos.ruc,
      dv: f.datos.dv,
      razon_social: f.datos.razon_social,
      email: f.datos.email,
      condicion: c.condicion,
      plazo_dias: c.plazo_dias,
      origen: origenAlGuardar(filaExistente),
      cargado_por: usuarioId || null,
    },
  }
}

// ─── Lista de pedidos mayoristas ───

/** "#1003" / "VT-1003" / 1003 → "#1003" (nombre del pedido en shopify_pedidos). */
export function nombrePedidoDesdeRef(ref) {
  const m = /(\d+)\s*$/.exec(String(ref ?? '').trim())
  return m ? `#${parseInt(m[1], 10)}` : null
}

/** Estado legible de un pedido mayorista para la lista. */
export function estadoPedidoMayorista(p, retenida) {
  if (p?.estado_confirmacion?.startsWith('cancelado') || p?.estado_envio === 'CANCELADO') return { texto: 'Cancelado', color: 'var(--red)' }
  if ((p?.tags || []).includes('ANTERIOR_AL_CORTE')) return { texto: 'Anterior al corte', color: 'var(--text-muted)' }
  if (p?.estado_envio === 'RENDIDO' || p?.estado_envio === 'ENTREGADO' || p?.entregado_en) return { texto: 'Entregado', color: 'var(--green)' }
  if (p?.estado_envio) return { texto: p.estado_envio.replace(/_/g, ' ').toLowerCase(), color: 'var(--accent)' }
  if (retenida && !retenida.liberado_en) return { texto: 'Factura retenida', color: 'var(--yellow)' }
  return { texto: 'Por despachar', color: 'var(--yellow)' }
}

/** Estado de factura legible para la lista. */
export function estadoFacturaCorto(facturas, retenida) {
  const fe = (facturas || []).filter(f => Number(f?.tipo_documento ?? 1) === 1)
  const prod = fe.find(f => f.ambiente === 'prod') || fe[0]
  if (prod) return prod.ambiente === 'test' ? `${prod.estado} (prueba)` : prod.estado
  if (retenida && !retenida.liberado_en) return `retenida (${String(retenida.motivo || '').replace(/_/g, ' ')})`
  return 'al entregar'
}
