// src/pages/dashboard/cargaDashboard.js
// ═══════════════════════════════════════════════════════════
// CARGA DE DATOS DEL DASHBOARD (en paralelo y por bloques)
//
// Antes el Dashboard hacía ~20 consultas una detrás de otra y recién al final
// mostraba algo: desde Paraguay cada consulta tarda 150-300 ms, así que eran
// varios segundos de pantalla gris.
//
// Ahora todas las consultas que no dependen de otra salen JUNTAS al principio.
// Cada bloque (números del mes, gráfico, alertas, saldo…) avisa con `emitir`
// apenas tiene sus datos, sin esperar a los demás.
//
// Las CUENTAS son exactamente las mismas que antes (misma fórmula que Reportes):
// solo cambió el orden en que se piden los datos, no qué se hace con ellos.
//
// Única dependencia real: los gastos automáticos necesitan saber de qué días
// hay gastos en dólares para pedir el tipo de cambio de esos días.
//
// emitir(bloque, datos):
//   datos === undefined → ese bloque falló (no se toca lo que había en pantalla).
//   Bloques: heroHoy, principal, historico, enCalle, saldo, chart7, top,
//            alertas, acciones, recientes.
// Devuelve { fallas }: lista de lo que no se pudo leer, en orden fijo.
// ═══════════════════════════════════════════════════════════
import { formatGs } from '../../lib/supabase'
import { calcularPiramide, indexarCostos, contarPedidos, categoriaVenta } from '../../lib/contribucion'
import { armarGastosAutomaticos, cargarGastosAutomaticos, diaLocal, claveCampanaManual, gastosSinDobleAds } from '../../lib/gastosAutomaticos'
import { cargarTasas } from '../../lib/tipoCambio'
import { construirAlertasNegocio } from '../../lib/alertasNegocio'
import { rangoMesAnteriorEquivalente, hoyLocal } from '../../lib/fechas'
import { construirAcciones } from '../../lib/centroAcciones'
import { entregasPaPAtascadas } from '../../lib/seguimiento'
import { getUmbralesSeguimientoPaP, getGastosAutomaticosConfig } from '../../lib/config'
import { fetchAll } from '../../lib/fetchAll'

// Costo estimado cuando una venta no tiene el costo real cargado (igual que Entregas)
export const COGS_PROMEDIO = 12000

// Orden fijo del aviso "No se pudo cargar" (antes era el orden de las consultas
// en serie; ahora llegan en cualquier orden y se reordenan con esta lista).
export const ORDEN_FALLAS = [
  'ventas del mes', 'gastos del mes', 'gasto de Campañas', 'gastos automáticos',
  'histórico de 6 meses', 'plata en la calle', 'saldo del banco', 'gráfico de 7 días',
  'top productos', 'stock de productos', 'pendientes viejos', 'comparación de ventas',
  'recompra', 'plata sin rendir', 'tasa de entrega', 'centro de acciones',
  'ventas recientes', 'datos del panel',
]

// Una promesa que nunca rechaza: así se puede lanzar ya y esperarla más tarde
// sin que el navegador avise "rechazo sin manejar" mientras tanto.
const settle = (p) => Promise.resolve().then(() => p).then(v => ({ ok: true, v }), e => ({ ok: false, e }))

export async function cargarDashboard({ supabase, supabaseCrudo, tienda, vigente = () => true, emitir = () => {}, avisar = console.warn }) {
  const fallas = []
  const fallar = (texto, etiqueta, e) => { fallas.push(texto); avisar(`[dashboard] ${etiqueta}:`, e?.message || e) }
  const emit = (bloque, datos) => { if (vigente()) emitir(bloque, datos) }
  // Cada bloque corre solo; si explota algo inesperado, se anota y avisa igual
  // que terminó (para que su skeleton no quede girando para siempre).
  const bloque = (nombre, fn) => (async () => {
    let datos
    try { datos = await fn() } catch (e) { fallar('datos del panel', 'error inesperado', e) }
    emit(nombre, datos)
  })()

  const ahora = new Date()
  const hoyStr = hoyLocal(ahora) // día de Paraguay (con toISOString, de 21 a 24 h ya era 'mañana')
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString().split('T')[0]
  const finMes = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).toISOString().split('T')[0]
  const inicio6m = new Date(ahora.getFullYear(), ahora.getMonth() - 5, 1).toISOString().split('T')[0]

  // ═══ RONDA 1: todo lo que no depende de nada sale a la vez ═══

  // Paginado: con más de 1.000 ventas en el mes, Supabase cortaba en silencio y los totales salían bajos.
  const pVentasMes = fetchAll(() => supabase
    .from('ventas').select('*').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', finMes))
    .catch(e => { fallar('ventas del mes', 'ventas del mes', e); return null })

  // ── Costos del mes: MISMA fórmula que Reportes ──
  // gastos (Finanzas) + publicidad (Campañas a mano + Meta sincronizado) +
  // gastos automáticos (WhatsApp, Claude, ElevenLabs, fijos).
  const pGastos = fetchAll(() => supabase
    .from('gastos').select('id, monto, categoria').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', finMes))
    .then(data => ({ ok: true, data }), e => { fallar('gastos del mes', 'gastos', e); return { ok: false, data: [] } })

  const pCampanas = (async () => {
    const { data: adsRows, error } = await supabase.from('campanas_ads').select('gasto, mes, tienda').eq('mes', inicioMes.slice(0, 7))
    if (error) throw error
    return { ok: true, data: adsRows || [] }
  })().catch(e => { fallar('gasto de Campañas', 'campañas', e); return { ok: false, data: [] } })

  // Meta sincronizado + WhatsApp/Claude/ElevenLabs/fijos. El tipo de cambio
  // depende de los días con gastos en dólares: esta es la única cadena (2 pasos).
  const pAutoCrudo = settle((async () => {
    const rawAuto = await cargarGastosAutomaticos(supabaseCrudo, { inicio: inicioMes, fin: finMes })
    const cfgAuto = getGastosAutomaticosConfig()
    const fechaTasaFijos = finMes < hoyStr ? finMes : hoyStr
    const diasUsd = [...rawAuto.waMensajes, ...rawAuto.turnosIA, ...rawAuto.ciclosMejora].map(r => diaLocal(r.creado_en))
      .concat(rawAuto.gastosReales.map(r => String(r.fecha).slice(0, 10)), fechaTasaFijos)
    const { tasas } = await cargarTasas(supabaseCrudo, diasUsd)
    return { rawAuto, cfgAuto, tasas, fechaTasaFijos }
  })())

  // Consultas de los bloques secundarios: también arrancan YA.
  const pVentas6m = settle(fetchAll(() => supabase
    .from('ventas').select('id, fecha, total, ganancia_neta, estado').is('deleted_at', null).gte('fecha', inicio6m)))
  // Plata en la calle = TODO lo despachado y sin resolver, sin importar el mes.
  const pSinResolver = settle(fetchAll(() => supabase
    .from('ventas').select('id, n_referencia, fecha, total')
    .is('deleted_at', null)
    .in('estado', ['pendiente', 'en_camino', 'en_tramite'])))
  const pSaldo = settle(supabase
    .from('saldo_banco').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle())
  const hace7 = new Date(); hace7.setDate(hace7.getDate() - 6)
  const pVentasChart = settle(fetchAll(() => supabase
    .from('ventas').select('id, n_referencia, fecha, total, estado, ganancia_neta')
    .is('deleted_at', null)
    .gte('fecha', hoyLocal(hace7))))
  const pTopProds = settle(fetchAll(() => supabase
    .from('ventas').select('id, producto_nombre, total, ganancia_neta, estado, cantidad')
    .is('deleted_at', null)
    .gte('fecha', inicioMes).lte('fecha', finMes).eq('estado', 'entregado')))

  // Alertas
  const pProds = settle(supabase.from('productos')
    .select('id, nombre, stock_actual, stock_alerta, es_combo, componente_1_id, componente_1_qty, componente_2_id, componente_2_qty')
    .eq('activo', true))
  const hace5 = new Date(); hace5.setDate(hace5.getDate() - 5)
  // Conteo exacto (sin traer filas): no se corta en 1.000.
  const pViejos = settle(supabase.from('ventas').select('id', { count: 'exact', head: true })
    .is('deleted_at', null).eq('estado', 'pendiente').lt('fecha', hoyLocal(hace5)))
  // Ventas mes actual vs mes anterior — mismo tramo de días en los dos,
  // no mes parcial contra mes completo (ver rangoMesAnteriorEquivalente).
  const { inicio: inicioMesAnt, fin: finMesAnt, dias: diasComparados } = rangoMesAnteriorEquivalente(ahora)
  const pComparacion = settle(Promise.all([
    fetchAll(() => supabase.from('ventas').select('id, total').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', hoyStr)),
    fetchAll(() => supabase.from('ventas').select('id, total').is('deleted_at', null).gte('fecha', inicioMesAnt).lte('fecha', finMesAnt)),
  ]))
  // Recompra pendientes (clientes listos hoy, estimación)
  const desdeR = new Date(); desdeR.setMonth(desdeR.getMonth() - 8)
  const pRecompra = settle(Promise.all([
    fetchAll(() => supabase.from('ventas').select('id, cliente_telefono, fecha, estado').eq('estado', 'entregado').is('deleted_at', null).gte('fecha', hoyLocal(desdeR))),
    supabase.from('recompra_log').select('telefono, fecha_envio').gte('fecha_envio', new Date(Date.now() - 25 * 86400000).toISOString()),
  ]))
  // Plata de PaP sin rendir. `cobrado` es el IMPORTE cobrado (un entero), no
  // un booleano: con .eq('cobrado', true) Postgres rechazaba la consulta entera.
  const pSinRend = settle(fetchAll(() => supabase.from('entregas').select('cobrado').gt('cobrado', 0).eq('rendido', false), { columnaOrden: 'nro_guia_pap' }))
  // Tasa de entrega este mes vs mes anterior (mismo tramo de días), por pedido
  const { inicio: inicioMesAnt2, fin: finMesAnt2 } = rangoMesAnteriorEquivalente(ahora)
  const pTasaEntrega = settle(Promise.all([
    fetchAll(() => supabase.from('ventas').select('id, n_referencia, fecha, estado').is('deleted_at', null).gte('fecha', inicioMes).lte('fecha', hoyStr)),
    fetchAll(() => supabase.from('ventas').select('id, n_referencia, fecha, estado').is('deleted_at', null).gte('fecha', inicioMesAnt2).lte('fecha', finMesAnt2)),
  ]))

  // Centro de acciones
  const pAcciones = settle(Promise.all([
    fetchAll(() => supabase.from('ventas')
      .select('id, fecha, total, estado, pago_anticipado, cliente_telefono, seguimiento_at')
      .is('deleted_at', null).in('estado', ['pendiente', 'en_tramite', 'en_camino'])),
    supabase.from('entregas').select('fecha_entrega')
      .not('fecha_entrega', 'is', null).order('fecha_entrega', { ascending: false }).limit(1),
    // La columna es stock_alerta, NO alerta_stock: con el nombre invertido
    // la consulta fallaba entera y la alerta de stock bajo nunca disparó.
    supabase.from('productos').select('nombre, stock_actual, stock_alerta').eq('activo', true),
    supabase.from('ventas').select('id', { count: 'exact', head: true })
      .is('deleted_at', null).is('transportadora', null),
    // Entregas cobradas al cliente que la transportadora todavía no depositó.
    fetchAll(() => supabase.from('entregas').select('importe, fecha_entrega')
      .eq('categoria', 'entregado').eq('rendido', false).not('fecha_entrega', 'is', null), { columnaOrden: 'nro_guia_pap' }),
    // Guías de PaP en tránsito, para la alerta de "sin moverse".
    fetchAll(() => supabase.from('entregas')
      .select('estado_pap, categoria, ciudad, fecha_ingreso, transportadora')
      .eq('transportadora', 'pap').eq('categoria', 'en_proceso'), { columnaOrden: 'nro_guia_pap' }),
  ]))

  const pRecientes = settle(supabase.from('ventas').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(8))

  // ═══ Costos del mes (espera gastos + Campañas + automáticos) ═══
  const pCostos = (async () => {
    const [g, c, a] = await Promise.all([pGastos, pCampanas, pAutoCrudo])
    let costosOk = g.ok && c.ok
    const campanasMes = c.data
    const adsManualMes = campanasMes.reduce((s, x) => s + (Number(x.gasto) || 0), 0)
    let auto = { metaTotal: 0, totalGs: 0 }
    try {
      if (!a.ok) throw a.e
      const { rawAuto, cfgAuto, tasas, fechaTasaFijos } = a.v
      auto = armarGastosAutomaticos({
        ...rawAuto, productos: [], tasas, fechaTasaFijos,
        mesesConCampanas: new Set(campanasMes.filter(x => Number(x.gasto) > 0).map(x => claveCampanaManual(x.tienda, x.mes))),
        tienda, usdPyg: cfgAuto.usdPyg, gastosFijosTexto: cfgAuto.gastosFijosTexto,
        fraccionMes: 1, // el Dashboard mira el mes entero, igual que Reportes con un mes elegido
      })
    } catch (e) { costosOk = false; fallar('gastos automáticos', 'gastos automáticos', e) }

    const totalAdsMes = adsManualMes + auto.metaTotal
    // Protección anti-doble: ¿hay ads (Campañas o Meta sync) Y también un gasto de "Publicidad"?
    // Se resta SOLO el ads y el aviso se mantiene para que se borre el duplicado.
    const { totalGastos: totalGastosMes, gastoPublicidad, posibleDoble } = gastosSinDobleAds(g.data, totalAdsMes)
    // Total que se descuenta de la ganancia = gastos + ads + automáticos (como Reportes)
    const totalGastosConAds = totalGastosMes + totalAdsMes + (auto.totalGs || 0)
    return { costosOk, totalAdsMes, totalGastosConAds, gastoPublicidad, posibleDoble }
  })()
  // Si pCostos explotara por algo inesperado, cada bloque que lo espera lo anota.
  pCostos.catch(() => {})

  // ═══ BLOQUES: cada uno se pinta apenas tiene lo suyo ═══
  const bloques = [
    // Hero de hoy: derivado de lo YA traído, sin consultas nuevas.
    bloque('heroHoy', async () => {
      const ventasMes = await pVentasMes
      if (!ventasMes) return undefined
      const deHoy = ventasMes.filter(v => v.fecha === hoyStr)
      return {
        hoyCount: contarPedidos(deHoy, categoriaVenta).total, // pedidos, no líneas
        hoyMonto: deHoy.reduce((s, v) => s + (v.total || 0), 0),
      }
    }),

    // Bloque principal: ventas/ganancia del mes, KPIs y punto de equilibrio.
    bloque('principal', async () => {
      const [ventasMes, costos] = await Promise.all([pVentasMes, pCostos])
      if (!(ventasMes && costos.costosOk)) {
        // Sin ventas o sin costos no se puede calcular la ganancia: mejor nada que un número falso.
        return { kpis: null }
      }
      const { totalGastosConAds, totalAdsMes, posibleDoble } = costos
      const entregadas = ventasMes.filter(v => v.estado === 'entregado')

      // ── Fuente única de verdad: el mismo módulo que usan Entregas y Reportes ──
      const paquetes = ventasMes.map(v => ({
        n_referencia: v.n_referencia,
        importe: v.total || 0,
        fecha: v.fecha,
        costo_envio: v.costo_envio,  // flete real de esta venta (su transportadora)
        costo_prod: v.costo_prod,    // costo de ESTA línea (un pedido multiproducto tiene uno por línea)
        categoria: v.estado === 'entregado' ? 'entregado'
                 : v.estado === 'devuelto' ? 'devuelto'
                 : 'en_proceso',
      }))
      const piramide = calcularPiramide(paquetes, indexarCostos(ventasMes), COGS_PROMEDIO, totalGastosConAds)
      // Conteos por PEDIDO (no por línea), como la pirámide.
      const ped = contarPedidos(ventasMes, categoriaVenta)

      // ── Desglose de cobro sobre lo entregado ──
      // Transferencia (prepago): plata que YA está en tu cuenta.
      // COD: la cobra PaP y te la rinde después.
      const ingresoTransferencia = entregadas.filter(v => v.pago_anticipado).reduce((s, v) => s + (v.total || 0), 0)
      const ingresoCOD = entregadas.filter(v => !v.pago_anticipado).reduce((s, v) => s + (v.total || 0), 0)
      const cantTransferencia = contarPedidos(entregadas.filter(v => v.pago_anticipado), categoriaVenta).total

      // Cada paquete resuelto de más aporta la contribución por envío.
      const margenPromedio = piramide.contribPorEnvio
      const gananciaReal = piramide.gananciaFirme
      const faltaParaCubrir = (gananciaReal < 0 && margenPromedio > 0)
        ? Math.ceil(Math.abs(gananciaReal) / margenPromedio)
        : 0

      return {
        kpis: {
          ventasBrutas: piramide.ingreso,
          // Contribución firme: lo que deja la operación después de flete y producto
          ingresosNetos: piramide.contribucionFirme,
          // Margen de contribución sobre lo cobrado
          margenPct: piramide.ingreso ? (piramide.contribucionFirme / piramide.ingreso) * 100 : 0,
          paquetesEnviados: ped.total,
          entregados: ped.entregados,
          devueltos: ped.devueltos,
          pendientesCount: ped.porCat.pendiente || 0,
          // Tasa sobre lo RESUELTO (entregados + devueltos), no sobre los que aún vuelan
          tasaEntrega: piramide.tasaEntrega,
          sangradoFlete: piramide.sangradoFlete,
          // Punto de equilibrio: TODO lo que se descuenta (gastos + ads + automáticos),
          // así "Meta" y "Cubierto" usan la misma base que la ganancia.
          gastosMes: totalGastosConAds,
          gastoAds: totalAdsMes,
          posibleDobleAds: posibleDoble,
          margenPromedio,
          gananciaReal,
          faltaParaCubrir,
          cubierto: gananciaReal >= 0,
          // Desglose de cobro
          ingresoTransferencia,
          ingresoCOD,
          cantTransferencia,
        },
      }
    }),

    // ── Histórico de 6 meses (tendencia de mediano plazo) ──
    bloque('historico', async () => {
      const r = await pVentas6m
      try {
        if (!r.ok) throw r.e
        const ventas6m = r.v
        const mesesData = []
        for (let i = 5; i >= 0; i--) {
          const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1)
          const ini = hoyLocal(d)
          const fin = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0]
          const vMes = (ventas6m || []).filter(v => v.fecha >= ini && v.fecha <= fin)
          const entMes = vMes.filter(v => v.estado === 'entregado')
          mesesData.push({
            mes: d.toLocaleDateString('es-PY', { month: 'short' }),
            ventas: entMes.reduce((s, v) => s + (v.total || 0), 0),
            neto: entMes.reduce((s, v) => s + (v.ganancia_neta || 0), 0),
          })
        }
        return mesesData
      } catch (e) { fallar('histórico de 6 meses', 'histórico', e) }
    }),

    // Plata en la calle (antes salía del mes en curso y cada día 1 se reseteaba).
    bloque('enCalle', async () => {
      const r = await pSinResolver
      try {
        if (!r.ok) throw r.e
        const sinResolver = r.v
        return {
          enCalleCount: contarPedidos(sinResolver, () => 'en_proceso').total,
          enCalleMonto: sinResolver.reduce((s, v) => s + (v.total || 0), 0),
        }
      } catch (e) { fallar('plata en la calle', 'sin plata en la calle', e) }
    }),

    // Saldo banco
    bloque('saldo', async () => {
      const r = await pSaldo
      const error = r.ok ? r.v.error : r.e
      if (error) { fallar('saldo del banco', 'saldo del banco', error); return undefined }
      return { saldo: r.v.data }
    }),

    // Chart 7 días + tasa de entrega de la semana (hero)
    bloque('chart7', async () => {
      const r = await pVentasChart
      try {
        if (!r.ok) throw r.e
        const ventasChart = r.v
        // Tasa de entrega de los últimos 7 días, sobre lo RESUELTO y por pedido.
        const p7 = contarPedidos(ventasChart, categoriaVenta)
        const porDia = {}
        for (let i = 0; i < 7; i++) {
          const d = new Date(); d.setDate(d.getDate() - (6 - i))
          const key = hoyLocal(d)
          const label = d.toLocaleDateString('es-PY', { weekday: 'short', day: 'numeric' })
          porDia[key] = { fecha: label, ventas: 0, neto: 0 }
        }
        ventasChart.forEach(v => {
          if (porDia[v.fecha] && v.estado === 'entregado') {
            porDia[v.fecha].ventas += v.total
            porDia[v.fecha].neto += v.ganancia_neta
          }
        })
        return {
          tasa7d: p7.resueltos ? p7.entregados / p7.resueltos : null,
          resueltos7d: p7.resueltos,
          chartData: Object.values(porDia),
        }
      } catch (e) { fallar('gráfico de 7 días', '7 días', e) }
    }),

    // Top productos
    bloque('top', async () => {
      const r = await pTopProds
      try {
        if (!r.ok) throw r.e
        const agrupado = {}
        r.v.forEach(v => {
          if (!agrupado[v.producto_nombre]) agrupado[v.producto_nombre] = { nombre: v.producto_nombre, ventas: 0, ingresos: 0 }
          agrupado[v.producto_nombre].ventas += v.cantidad
          agrupado[v.producto_nombre].ingresos += v.ganancia_neta
        })
        return Object.values(agrupado).sort((a, b) => b.ingresos - a.ingresos).slice(0, 5)
      } catch (e) { fallar('top productos', 'top productos', e) }
    }),

    // Alertas (cada dato por separado: si uno falla, las demás igual salen,
    // y la que falló NO se arma)
    bloque('alertas', async () => {
      const [rProds, rViejos, rComp, rRecompra, rSinRend, rTasa, costos] =
        await Promise.all([pProds, pViejos, pComparacion, pRecompra, pSinRend, pTasaEntrega, pCostos])
      const alertasActivas = []

      const todosProds = rProds.ok ? rProds.v.data : null
      const errProds = rProds.ok ? rProds.v.error : rProds.e
      if (errProds) fallas.push('stock de productos')
      if (todosProds) {
        const porId = todosProds.reduce((a, p) => { a[p.id] = p; return a }, {})
        // Stock real considerando combos (combo = mínimo de sus componentes disponibles)
        const stockReal = (p) => {
          if (!p.es_combo) return p.stock_actual
          const disp = []
          const c1 = porId[p.componente_1_id], c2 = porId[p.componente_2_id]
          if (c1) disp.push(Math.floor((c1.stock_actual || 0) / (p.componente_1_qty || 1)))
          if (c2) disp.push(Math.floor((c2.stock_actual || 0) / (p.componente_2_qty || 1)))
          return disp.length ? Math.min(...disp) : 0
        }
        todosProds
          .filter(p => stockReal(p) <= p.stock_alerta)
          .forEach(p => {
            const s = stockReal(p)
            alertasActivas.push({
              tipo: 'stock', color: 'red',
              msg: p.es_combo
                ? `Stock bajo: ${p.nombre} — ${s} armables`
                : `Stock bajo: ${p.nombre} — ${s} uds`,
            })
          })
      }

      const errViejos = rViejos.ok ? rViejos.v.error : rViejos.e
      const viejos = rViejos.ok ? rViejos.v.count : null
      if (errViejos) fallas.push('pendientes viejos')
      else if (viejos) alertasActivas.push({ tipo: 'pendiente', color: 'yellow', msg: `${viejos} pedido(s) pendiente(s) con más de 5 días sin resolver` })

      // Aviso anti-doble-conteo: ads (Campañas o Meta sync) Y gasto de Publicidad
      if (costos.posibleDoble) {
        alertasActivas.push({
          tipo: 'doble_ads', color: 'yellow', ruta: '/finanzas', accion: 'Revisar gastos',
          msg: `Hay Meta Ads este mes y también un gasto de "Publicidad" (${formatGs(costos.gastoPublicidad)}). Para no restarlo dos veces se usa solo el de Meta Ads; borrá el gasto de Publicidad para que quede limpio.`,
        })
      }

      // ── Alertas inteligentes de negocio ──
      const datosAlertas = {}
      try {
        if (!rComp.ok) throw rComp.e
        const [vAct, vAnt] = rComp.v
        datosAlertas.ventasMesActual = vAct.reduce((s, v) => s + (v.total || 0), 0)
        datosAlertas.ventasMesAnterior = vAnt.reduce((s, v) => s + (v.total || 0), 0)
        datosAlertas.diasComparados = diasComparados
      } catch (e) { fallar('comparación de ventas', 'sin comparación de ventas', e) }

      try {
        if (!rRecompra.ok) throw rRecompra.e
        const [vEnt, { data: logs, error: errLogs }] = rRecompra.v
        if (errLogs) throw errLogs
        const enCooldown = new Set((logs || []).map(l => String(l.telefono).replace(/\D/g, '')))
        const hace15 = Date.now() - 15 * 86400000
        const candidatos = new Set()
        for (const v of vEnt) {
          const tel = String(v.cliente_telefono || '').replace(/\D/g, '')
          if (!tel || enCooldown.has(tel)) continue
          if (v.fecha && new Date(v.fecha).getTime() < hace15) candidatos.add(tel)
        }
        datosAlertas.recompraPendientes = candidatos.size
      } catch (e) { fallar('recompra', 'sin alerta de recompra', e) }

      try {
        if (!rSinRend.ok) throw rSinRend.e
        const sinRend = rSinRend.v
        datosAlertas.montoSinRendir = sinRend.reduce((s, e) => s + (Number(e.cobrado) || 0), 0)
        datosAlertas.cantSinRendir = sinRend.length
      } catch (e) { fallar('plata sin rendir', 'sin alerta de rendición', e) }

      try {
        if (!rTasa.ok) throw rTasa.e
        const tasa = (arr) => {
          const p = contarPedidos(arr, categoriaVenta)
          return { tasa: p.resueltos ? p.entregados / p.resueltos : 0, resueltos: p.resueltos }
        }
        const [vMesTasa, vAntTasa] = rTasa.v
        const tAct = tasa(vMesTasa), tAnt = tasa(vAntTasa)
        datosAlertas.tasaEntregaActual = tAct.tasa
        datosAlertas.tasaEntregaAnterior = tAnt.tasa
        datosAlertas.entregasResueltas = tAct.resueltos
      } catch (e) { fallar('tasa de entrega', 'sin alerta de entrega', e) }

      const alertasInteligentes = construirAlertasNegocio(datosAlertas)
      return [...alertasActivas, ...alertasInteligentes]
    }),

    // ── Centro de acciones: qué falta hacer, priorizado por plata en juego ──
    bloque('acciones', async () => {
      const [r, costos] = await Promise.all([pAcciones, pCostos])
      try {
        if (!r.ok) throw r.e
        const [abiertas, ultEnt, prodsBajos, sinTransp, trancadas, pap] = r.v
        const errAcc = ultEnt.error || prodsBajos.error || sinTransp.error
        if (errAcc) throw errAcc
        // Trancadas = entregadas hace más de 14 días y todavía sin depositar.
        const hace14 = new Date(); hace14.setDate(hace14.getDate() - 14)
        const limite = hoyLocal(hace14)
        const trancadasList = trancadas.filter(e => e.fecha_entrega < limite)
        const bajos = (prodsBajos.data || []).filter(p =>
          (p.stock_actual ?? 0) <= (p.stock_alerta ?? 0))
        return construirAcciones({
          ventasAbiertas: abiertas,
          ultimaEntregaImportada: ultEnt.data?.[0]?.fecha_entrega || null,
          // Todo el ads del mes (Campañas + Meta sincronizado).
          gastoAdsMes: costos.totalAdsMes,
          productosBajos: bajos,
          sinRendir: {
            monto: trancadasList.reduce((s2, e) => s2 + (e.importe || 0), 0),
            cantidad: trancadas.length,
            trancados: trancadasList.length,
          },
          ventasSinTransportadora: sinTransp.count || 0,
          papAtascado: entregasPaPAtascadas(pap, getUmbralesSeguimientoPaP()),
        })
      } catch (e) { fallar('centro de acciones', 'el centro de acciones es complementario: si falla, no rompe el dashboard', e) }
    }),

    // Ventas recientes
    bloque('recientes', async () => {
      const r = await pRecientes
      const error = r.ok ? r.v.error : r.e
      if (error) { fallas.push('ventas recientes'); return undefined }
      return r.v.data || []
    }),
  ]

  await Promise.all(bloques)
  const unicas = [...new Set(fallas)]
  unicas.sort((a, b) => ORDEN_FALLAS.indexOf(a) - ORDEN_FALLAS.indexOf(b))
  return { fallas: unicas }
}
