// src/lib/buscadorPedidos.js
// ═══════════════════════════════════════════════════════════
// BUSCADOR DE PEDIDOS — PARA ATENDER RECLAMOS
//
// Caso de uso: un cliente escribe por WhatsApp diciendo que su pedido no
// llegó. Hay que encontrarlo en segundos y tener a mano el número de guía
// para reclamarle al courier. Nada más.
//
// ── POR QUÉ NO SE REUSÓ LA BANDEJA DE SEGUIMIENTO ──
// SeguimientoPage solo carga ventas en estado pendiente/en_tramite/en_camino
// y descarta las prepagas: hoy son 32 de 671 pedidos (5%). El reclamo más
// común que llega es "me figura entregado y no lo recibí", y ese pedido ya
// está cerrado como `entregado` — invisible ahí. Por eso este módulo mira
// TODO el histórico.
//
// ── POR QUÉ EL FILTRADO ES EN MEMORIA Y NO EN POSTGRES ──
// `ilike` de Postgres NO ignora tildes: buscar "jose" no encuentra "José".
// Con 671 pedidos (~150 KB) traer todo una vez y filtrar acá sale instantáneo
// y permite normalizar tildes, mayúsculas y teléfonos como haga falta.
// Aguanta cómodo hasta ~5.000 pedidos; pasado eso hay que mover la búsqueda
// al servidor con la extensión `unaccent`.
//
// ESTE MÓDULO NO ESCRIBE NADA. Solo lee.
// ═══════════════════════════════════════════════════════════
import { normalizarRef, limpiarTel } from './referencias'

// ─── Normalización de texto ─────────────────────────────────
// Sin tildes, sin mayúsculas, sin espacios de más. 'José Ñandú' → 'jose nandu'
export function normTexto(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim()
}

const soloDig = (s) => String(s ?? '').replace(/\D/g, '')

// ─── Fechas ─────────────────────────────────────────────────
export function diasDesde(fecha, hoy = new Date()) {
  if (!fecha) return null
  const f = new Date(String(fecha).slice(0, 10) + 'T00:00:00')
  if (isNaN(f)) return null
  const h = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())
  return Math.floor((h - f) / 86400000)
}

// ─── ¿Esta referencia sirve para cruzar? ────────────────────
// 16 ventas tienen texto suelto en `n_referencia` ('NO TIENE', 'no hay',
// hasta el nombre del cliente). Sin este filtro, todas las que dicen lo mismo
// se agrupan en UN pedido y la ficha mezcla clientes distintos: se vio a tres
// personas con productos ajenos en la misma ficha. Una referencia sin ningún
// dígito no identifica nada, así que no agrupa ni cruza con `entregas`.
export function refUtil(ref) {
  const r = normalizarRef(ref)
  return /\d/.test(r) ? r : ''
}

// Referencia lista para mostrar. Algunas ventas tienen el '#' de Shopify
// guardado dentro del campo y otras no; sin esto unas salen '#1742' y otras
// '##1299'.
export function refMostrar(ref) {
  const r = String(ref ?? '').replace(/^#+/, '').trim()
  if (!r) return null
  // Hay ventas con texto suelto en el campo ('NO TIENE', 'no hay'). Ponerles
  // '#' adelante las hace parecer un número de pedido que no existe.
  return /\d/.test(r) ? `#${r}` : r
}

// '2026-06-19' → '19/06/2026'
export function fechaCorta(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ? String(iso) : '—')
}

// ═══════════════════════════════════════════════════════════
// ÍNDICE
// ═══════════════════════════════════════════════════════════
// Un PEDIDO no es una fila de `ventas`: un pedido de varios productos genera
// varias filas con la MISMA referencia (48 referencias tuyas tienen 2+ filas,
// una llega a 6). Si no se agrupan, la ficha muestra el pedido a medias y el
// importe queda mal. Se agrupa por referencia normalizada.
//
// Las ventas SIN referencia no se pueden agrupar ni cruzar: van solas,
// identificadas por su id.
export function construirIndice(ventas, entregas) {
  // Entrega por referencia normalizada. Si hay más de una fila para la misma
  // referencia (pasa en 4 casos), gana la que tenga fecha de ingreso más
  // reciente: es el despacho vigente.
  const entPorRef = new Map()
  const entSueltas = []
  for (const e of (entregas || [])) {
    const k = refUtil(e.n_referencia)
    if (!k) { entSueltas.push(e); continue }
    const prev = entPorRef.get(k)
    if (!prev || String(e.fecha_ingreso || '') > String(prev.fecha_ingreso || '')) {
      entPorRef.set(k, e)
    }
  }

  const porClave = new Map()
  for (const v of (ventas || [])) {
    const ref = refUtil(v.n_referencia)
    const clave = ref || `id:${v.id}`
    let p = porClave.get(clave)
    if (!p) {
      p = {
        clave, ref,
        n_referencia: v.n_referencia || null,
        cliente_nombre: v.cliente_nombre || '',
        cliente_telefono: v.cliente_telefono || '',
        cliente_direccion: v.cliente_direccion || '',
        ciudad: v.ciudad || '',
        fecha: v.fecha || null,
        estado: v.estado || null,
        transportadora: v.transportadora || 'pap',
        pago_anticipado: !!v.pago_anticipado,
        despachado_at: v.despachado_at || null,
        lineas: [], total: 0, unidades: 0,
        ventaIds: [], soloEntrega: false,
      }
      porClave.set(clave, p)
    }
    p.lineas.push({
      producto_nombre: v.producto_nombre || 'Producto sin nombre',
      cantidad: v.cantidad || 1,
      total: v.total || 0,
    })
    p.total += (v.total || 0)
    p.unidades += (v.cantidad || 1)
    p.ventaIds.push(v.id)
    // La fecha del pedido es la más vieja de sus líneas.
    if (v.fecha && (!p.fecha || v.fecha < p.fecha)) p.fecha = v.fecha
    // Un despacho registrado en cualquier línea vale para todo el pedido.
    if (v.despachado_at && !p.despachado_at) p.despachado_at = v.despachado_at
    // Datos de cliente: la primera línea que los tenga.
    if (!p.cliente_telefono && v.cliente_telefono) p.cliente_telefono = v.cliente_telefono
    if (!p.cliente_direccion && v.cliente_direccion) p.cliente_direccion = v.cliente_direccion
  }

  // Enganchar la entrega
  for (const p of porClave.values()) {
    p.entrega = p.ref ? (entPorRef.get(p.ref) || null) : null
  }

  // ── Entregas sin venta ──
  // 199 filas de PaP volvieron sin referencia (todas anteriores a marzo 2026,
  // cuando el reporte todavía no la devolvía) y otras tienen una referencia
  // que no cruza con ninguna venta viva. No se pueden descartar: son paquetes
  // reales y se pueden buscar por su número de guía.
  const refsConVenta = new Set([...porClave.values()].map(p => p.ref).filter(Boolean))
  const huerfanas = [
    ...entSueltas,
    ...[...entPorRef.entries()].filter(([k]) => !refsConVenta.has(k)).map(([, e]) => e),
  ]
  for (const e of huerfanas) {
    porClave.set(`guia:${e.nro_guia_pap}`, {
      clave: `guia:${e.nro_guia_pap}`,
      ref: refUtil(e.n_referencia) || null,
      n_referencia: e.n_referencia || null,
      cliente_nombre: '', cliente_telefono: '', cliente_direccion: '',
      ciudad: e.ciudad || '',
      fecha: e.fecha_ingreso || null,
      estado: null,
      transportadora: e.transportadora || 'pap',
      pago_anticipado: false,
      despachado_at: null,
      lineas: e.producto ? [{ producto_nombre: e.producto, cantidad: 1, total: e.importe || 0 }] : [],
      total: e.importe || 0, unidades: 1,
      ventaIds: [], soloEntrega: true, entrega: e,
    })
  }

  // Campos pre-normalizados: se calculan UNA vez acá, no en cada tecla.
  return [...porClave.values()].map(p => ({
    ...p,
    _nom: normTexto(p.cliente_nombre),
    _tel: limpiarTel(p.cliente_telefono),
    _telDig: soloDig(p.cliente_telefono),
    _ciudad: normTexto(p.ciudad),
    _guias: guiasBuscables(p),
  }))
}

// Todos los códigos por los que este pedido se puede encontrar.
function guiasBuscables(p) {
  const g = []
  const e = p.entrega
  if (e?.nro_guia_pap) g.push(soloDig(e.nro_guia_pap) || String(e.nro_guia_pap))
  if (e?.guia_transportadora) g.push(soloDig(e.guia_transportadora))
  if (p.transportadora === 'lucero' && p.ref) g.push(soloDig(p.ref))
  return g.filter(Boolean)
}

// ═══════════════════════════════════════════════════════════
// BÚSQUEDA
// ═══════════════════════════════════════════════════════════
// Un solo campo que acepta referencia, nombre, teléfono o número de guía.
// No se le pide al usuario que elija el tipo: se puntúa contra todos los
// campos y gana el más específico. Por eso escribir "1611" da primero el
// pedido con esa referencia y no un cliente cuyo teléfono contenga 1611.
const PUNTOS = {
  refExacta: 100, guiaExacta: 95, telExacto: 90,
  guiaParcial: 70, nomEmpieza: 65, nomPalabra: 58, nomContiene: 50,
  telParcial: 45, ciudadContiene: 25,
}

export function buscarPedidos(indice, consulta, limite = 40) {
  const q = String(consulta ?? '').trim()
  if (q.length < 2) return []

  const qNorm = normTexto(q)
  const qDig = soloDig(q)
  const qRef = refUtil(q)
  const qTel = limpiarTel(q)

  const out = []
  for (const p of indice) {
    let punt = 0, motivo = null

    if (qRef && p.ref && p.ref === qRef) { punt = PUNTOS.refExacta; motivo = 'referencia' }

    if (qDig.length >= 4) {
      for (const g of p._guias) {
        if (g === qDig && PUNTOS.guiaExacta > punt) { punt = PUNTOS.guiaExacta; motivo = 'guía' }
        else if (g.includes(qDig) && PUNTOS.guiaParcial > punt) { punt = PUNTOS.guiaParcial; motivo = 'guía' }
      }
    }

    if (qTel && p._tel && p._tel === qTel && PUNTOS.telExacto > punt) {
      punt = PUNTOS.telExacto; motivo = 'teléfono'
    } else if (qDig.length >= 5 && p._telDig.includes(qDig) && PUNTOS.telParcial > punt) {
      punt = PUNTOS.telParcial; motivo = 'teléfono'
    }

    if (p._nom && qNorm.length >= 2) {
      if (p._nom.startsWith(qNorm) && PUNTOS.nomEmpieza > punt) { punt = PUNTOS.nomEmpieza; motivo = 'nombre' }
      else if (p._nom.split(' ').some(w => w.startsWith(qNorm)) && PUNTOS.nomPalabra > punt) { punt = PUNTOS.nomPalabra; motivo = 'nombre' }
      else if (p._nom.includes(qNorm) && PUNTOS.nomContiene > punt) { punt = PUNTOS.nomContiene; motivo = 'nombre' }
    }

    if (p._ciudad && qNorm.length >= 3 && p._ciudad.includes(qNorm) && PUNTOS.ciudadContiene > punt) {
      punt = PUNTOS.ciudadContiene; motivo = 'ciudad'
    }

    if (punt > 0) out.push({ ...p, _punt: punt, _motivo: motivo })
  }

  // Mismo puntaje: primero lo más reciente — un reclamo casi siempre es del
  // pedido más nuevo de ese cliente.
  out.sort((a, b) => b._punt - a._punt || String(b.fecha || '').localeCompare(String(a.fecha || '')))
  return out.slice(0, limite)
}

// ═══════════════════════════════════════════════════════════
// GUÍA DEL COURIER
// ═══════════════════════════════════════════════════════════
// Cada transportadora identifica el envío con un código distinto y mandar el
// equivocado hace que el reclamo no sirva de nada:
//
//   PaP    → su número de guía (ej. 26280786), el que ellos generan.
//   Lucero → el código FW-XXXX que les mandamos en la cabecera. OJO: en la
//            tabla `entregas` guardamos 'L-2025' como clave INTERNA nuestra;
//            Lucero no conoce ese formato. Su EnvioID se agrega aparte cuando
//            lo tenemos (hoy en 34 de 82 envíos) porque es lo que ellos filtran
//            más rápido.
//
// Misma regla que `codigoCourier()` de lib/seguimiento.js, pero devolviendo
// las partes por separado para poder mostrar el número grande y copiar SOLO
// el número. Si cambia la regla, hay que cambiarla en los dos lados.
export function guiaCourier(p) {
  const t = p?.transportadora || 'pap'
  const e = p?.entrega

  if (t === 'lucero') {
    if (!p?.ref) return { falta: 'Este pedido no tiene número de referencia, así que no hay código que darle a Lucero.' }
    return {
      numero: `FW-${p.ref}`,
      etiqueta: 'Código Lucero',
      extra: e?.guia_transportadora ? `EnvioID ${e.guia_transportadora}` : null,
      courier: 'Lucero del Este',
    }
  }

  if (t === 'pap') {
    const g = e?.nro_guia_pap
    // Nunca devolver una clave interna 'L-xxx' como si fuera guía de PaP.
    if (!g || String(g).startsWith('L-')) {
      return {
        falta: e
          ? 'El paquete figura en el sistema pero sin número de guía de PaP.'
          : 'Todavía no aparece en ningún reporte de PaP. La guía se asigna cuando el paquete llega a su oficina.',
      }
    }
    return { numero: String(g), etiqueta: 'Guía Punto a Punto', extra: null, courier: 'Punto a Punto' }
  }

  return { falta: 'Este pedido salió por un courier sin integración: no hay guía en el sistema.' }
}

// ═══════════════════════════════════════════════════════════
// FECHA DE DESPACHO
// ═══════════════════════════════════════════════════════════
// `entregas.fecha_ingreso` es la buena: está en 713 de 715 filas y marca
// cuándo el paquete entró al sistema del courier. `ventas.despachado_at` solo
// está en 164 de 671 ventas, así que va de respaldo. Cuando no hay ninguna de
// las dos se usa la fecha del PEDIDO, pero avisando que no es la del despacho:
// pasarle al courier una fecha inventada arruina el reclamo.
export function despachoPedido(p, hoy = new Date()) {
  const fi = p?.entrega?.fecha_ingreso
  if (fi) return { fecha: String(fi).slice(0, 10), dias: diasDesde(fi, hoy), fuente: 'courier', exacta: true }
  if (p?.despachado_at) return { fecha: String(p.despachado_at).slice(0, 10), dias: diasDesde(p.despachado_at, hoy), fuente: 'sistema', exacta: true }
  if (p?.fecha) return { fecha: String(p.fecha).slice(0, 10), dias: diasDesde(p.fecha, hoy), fuente: 'venta', exacta: false }
  return { fecha: null, dias: null, fuente: null, exacta: false }
}

// ═══════════════════════════════════════════════════════════
// ESTADO
// ═══════════════════════════════════════════════════════════
// Hay dos verdades y no siempre coinciden: lo que dice `ventas.estado` (lo que
// vos registraste) y lo que dice el courier en `entregas`. Cuando difieren NO
// se elige una y se esconde la otra: esa discrepancia es justamente el reclamo
// más común ("me figura entregado y no me llegó"), y verla es el dato útil.
const EST = {
  entregado:     { label: 'Entregado',     color: 'var(--green)' },
  devuelto:      { label: 'Devuelto',      color: 'var(--red)' },
  transito:      { label: 'En tránsito',   color: 'var(--yellow)' },
  sin_despachar: { label: 'Sin despachar', color: 'var(--text-muted)' },
  no_despachado: { label: 'Nunca despachado', color: 'var(--red)' },
}

export function estadoPedido(p) {
  const e = p?.entrega
  const cat = e?.categoria || null
  let base

  if (!e) {
    base = p?.estado === 'entregado' ? EST.entregado
      : p?.estado === 'devuelto' ? EST.devuelto
      : { ...EST.sin_despachar, label: p?.despachado_at ? 'Despachado, sin datos del courier' : 'Sin despachar aún' }
  } else if (cat === 'entregado') base = EST.entregado
  else if (cat === 'devuelto') base = EST.devuelto
  else if (cat === 'no_despachado') base = EST.no_despachado
  else base = EST.transito

  // ¿El courier y tu sistema dicen lo mismo?
  let discrepancia = null
  if (e && p?.estado) {
    const delCourier = cat === 'entregado' ? 'entregado' : cat === 'devuelto' ? 'devuelto' : null
    if (delCourier && delCourier !== p.estado) {
      discrepancia = `El courier lo da por ${delCourier} y en tu sistema figura como ${p.estado}.`
    }
  }

  return {
    label: base.label,
    color: base.color,
    detalleCourier: e?.estado_pap || null,
    motivo: e?.motivo || null,
    mensajero: e?.mensajero || null,
    fechaEntrega: e?.fecha_entrega ? String(e.fecha_entrega).slice(0, 10) : null,
    discrepancia,
  }
}

// ─── ¿La plata ya entró? ────────────────────────────────────
// `entregas.cobrado` es un IMPORTE (int), no un booleano. `rendido` dice si el
// courier ya te depositó lo que cobró — son dos cosas distintas y las dos
// importan para saber si un reclamo tiene plata detrás.
export function cobroPedido(p) {
  if (p?.pago_anticipado) {
    return { label: 'Prepago — ya cobrado antes de enviar', color: 'var(--green)', rendido: null }
  }
  const e = p?.entrega
  if (!e) return { label: 'Sin cobrar', color: 'var(--text-muted)', rendido: null }
  const cobrado = (e.cobrado || 0) > 0
  return {
    label: cobrado ? 'Cobrado al cliente' : 'Sin cobrar',
    color: cobrado ? 'var(--green)' : 'var(--text-muted)',
    monto: cobrado ? e.cobrado : null,
    rendido: cobrado ? !!e.rendido : null,
  }
}
