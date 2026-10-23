// src/pages/ads/AdsPage.jsx
import { useState, useEffect, useMemo, useCallback } from 'react'
import { mesesRecientes, etiquetaMes } from '../../lib/fechas'
import { supabaseTienda as supabase, supabase as supabaseCrudo, formatGs } from '../../lib/supabase'
import { categorizarPaP as categoriaPaP } from '../../lib/estadosPaP'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { familiaProducto } from '../../lib/recompra'
import { tiendaParaEscribir, useTienda } from '../../lib/tienda'
import { calcularMetricasAds, textoVeredicto, leerCampanasManual, filtroBorradoCampanas, gastoEfectivoAds } from '../../lib/metricasAds'
import { armarGastosAutomaticos, claveCampanaManual } from '../../lib/gastosAutomaticos'
import { textoEsperada, textoRango, colorTasa } from '../../lib/tasaEntrega'
import { Megaphone, Loader2, Save, Info } from 'lucide-react'

// Nombre visible de cada familia (orden en que se muestran)
const FAMILIAS = [
  ['nasal', 'Tiras Nasales'],
  ['parche', 'Parches Bucales'],
  ['gudair', 'Pack Gudair'],
  ['lengua', 'Raspador de Lengua'],
  ['jaw', 'JawFlex Pro'],
  ['botella', 'Botella Flexible'],
  ['bebird', 'Bebird Pro'],
]
const NOMBRE_FAMILIA = Object.fromEntries(FAMILIAS)

const normRef = (ref) => {
  if (!ref) return ''
  let r = String(ref).replace(/[#\s.\-/]/g, '').trim()
  if (/^\d+$/.test(r)) r = String(parseInt(r, 10))
  return r
}

const VEREDICTO_CFG = {
  gana:      { color: 'var(--green)',  bg: 'var(--green-dim)',        label: '🟢 Rinde' },
  ajustar:   { color: 'var(--yellow)', bg: 'rgba(234,179,8,0.12)',    label: '🟡 Ajustar' },
  pierde:    { color: 'var(--red)',    bg: 'rgba(239,68,68,0.12)',    label: '🔴 Pierde' },
  sin_gasto: { color: 'var(--text-muted)', bg: 'transparent',         label: '—' },
  // 12-10: muestra chica con pedidos en camino → ni cortar ni escalar todavía.
  esperar:   { color: 'var(--text-secondary)', bg: 'var(--bg-hover)', label: '⏳ Esperá' },
}
const IDS_FAMILIAS = FAMILIAS.map(([f]) => f)

export default function AdsPage() {
  const { toast } = useToast()
  const [mes, setMes] = useState(new Date().toISOString().substring(0, 7))
  // Últimos 6 meses siempre disponibles con un clic, aunque el mes todavía
  // no tenga gasto cargado (a diferencia de Entregas, acá se quiere poder
  // cargar retroactivo, no solo ver lo que ya existe).
  const mesesRapidos = useMemo(() => mesesRecientes(6), [])
  const [modo, setModo] = useState('producto')       // 'producto' | 'total'
  const [gastos, setGastos] = useState({})            // familia → gasto (string)
  const [ventas, setVentas] = useState([])
  const [estadoPaP, setEstadoPaP] = useState({})
  const [loading, setLoading] = useState(true)
  const [guardando, setGuardando] = useState(false)
  // 12-10: gasto de Meta sincronizado (gasto_ads_diario) del mes y la tienda.
  // Se usa cuando el mes no tiene carga manual en campanas_ads.
  const tienda = useTienda()
  const enTodas = tienda === 'todas'
  const [meta, setMeta] = useState(null)            // { porFamilia, total } | null
  const [cargaManual, setCargaManual] = useState(false) // pisar Meta con carga a mano

  // Cargar ventas del mes + estado real de PaP + gasto ya guardado
  const cargar = useCallback(async () => {
    setLoading(true)
    const [y, m] = mes.split('-').map(Number)
    const inicio = `${mes}-01`
    const fin = new Date(y, m, 0).toISOString().slice(0, 10)
    const finBuf = new Date(y, m, 0); finBuf.setDate(finBuf.getDate() + 31)
    const finBufStr = finBuf.toISOString().slice(0, 10)

    // Cada consulta va POR SEPARADO: si una falla, las otras igual funcionan.
    // (Antes un Promise.all hacía que un error en entregas borrara las ventas.)

    // 1. Ventas del mes (lo más importante)
    let vts = []
    try {
      vts = await fetchAll(() => supabase.from('ventas')
        .select('n_referencia, total, estado, costo_prod, costo_envio, producto_nombre, fecha')
        .is('deleted_at', null).gte('fecha', inicio).lte('fecha', fin))
    } catch (e) {
      toast('No se pudieron cargar las ventas: ' + (e?.message || e), 'error')
    }
    setVentas(vts || [])

    // 2. Estado real de PaP (si falla, se usa ventas.estado y listo)
    const est = {}
    try {
      const ents = await fetchAll(() => supabase.from('entregas')
        .select('n_referencia, nro_guia_ref, estado_pap, motivo')
        .gte('fecha_entrega', inicio).lte('fecha_entrega', finBufStr))
      for (const e of (ents || [])) {
        const k = normRef(e.n_referencia) || normRef(e.nro_guia_ref)
        if (k) est[k] = categoriaPaP(e.estado_pap, e.motivo)
      }
    } catch (e) { /* sin datos de PaP: se usa el estado guardado en la venta */ }
    setEstadoPaP(est)

    // 3. Gasto ya guardado del mes (si falla, se carga vacío)
    // La familia se guarda en `nombre` (o `familia` en datos viejos).
    // 12-10: en "Todas" se SUMAN las dos tiendas (antes una pisaba a la otra).
    let campFilas = []
    try {
      const camp = await supabase.from('campanas_ads').select('*').eq('mes', mes)
      campFilas = camp.data || []
      const { gastos: gs, modo: modoGuardado } = leerCampanasManual(campFilas)
      setGastos(gs)
      if (Object.keys(gs).length) setModo(modoGuardado)
    } catch (e) { setGastos({}) /* sin gasto guardado todavía */ }
    setCargaManual(false)

    // 4. Meta sincronizado (12-10). Antes la pantalla solo leía campanas_ads y
    // en Voltra (que carga Meta por sincronización) mostraba gasto 0 y
    // "Cargá el gasto". Cliente crudo + filtro de tienda adentro, igual que
    // Dashboard/Reportes. Las tiendas con carga manual del mes quedan afuera.
    try {
      // Paginado (Supabase corta en 1.000). Único por (fecha, adset_id).
      const leerAds = (cols) => fetchAll(() => supabaseCrudo.from('gasto_ads_diario').select(cols)
        .gte('fecha', inicio).lte('fecha', fin).order('adset_id'), { columnaOrden: 'fecha' })
      // Sin la columna `tienda` (migración sin correr): todo es de Facial Wellness.
      const ads = await leerAds('fecha, gasto, producto_id, tienda')
        .catch(() => leerAds('fecha, gasto, producto_id'))
      const { data: prods } = await supabaseCrudo.from('productos').select('id, nombre')
      const auto = armarGastosAutomaticos({
        adsDiario: ads, productos: prods || [], tienda,
        mesesConCampanas: new Set(campFilas.filter(c => Number(c.gasto) > 0).map(c => claveCampanaManual(c.tienda, c.mes))),
      })
      setMeta(auto.metaTotal > 0 ? { porFamilia: auto.metaPorFamilia, total: auto.metaTotal } : null)
    } catch (e) { setMeta(null) /* sin Meta sincronizado: queda la carga manual */ }

    setLoading(false)
  }, [mes, tienda])

  useEffect(() => { cargar() }, [cargar])

  // Meta sincronizado manda salvo que se elija cargar a mano (solo con una tienda).
  const usaMeta = !!meta && (enTodas || !cargaManual)
  // Se puede tipear el gasto solo con una tienda elegida y sin Meta en uso.
  const editable = !enTodas && !usaMeta
  const efectivo = useMemo(
    () => gastoEfectivoAds({ modo, gastos, familias: IDS_FAMILIAS, meta, usaMeta }),
    [modo, gastos, meta, usaMeta])

  // Ventas agrupadas por familia
  const ventasPorFamilia = useMemo(() => {
    const map = {}
    for (const v of ventas) {
      const fam = familiaProducto(v.producto_nombre)
      if (!fam) continue
      if (!map[fam]) map[fam] = []
      map[fam].push(v)
    }
    return map
  }, [ventas])

  // Métricas por familia (modo producto) o del total (modo simple)
  const filas = useMemo(() => {
    if (modo === 'total') {
      const gastoTotal = efectivo.total
      return [{ familia: 'total', nombre: 'Todo el mes', ventas: ventas.filter(v => familiaProducto(v.producto_nombre)), m: calcularMetricasAds(gastoTotal, ventas.filter(v => familiaProducto(v.producto_nombre)), estadoPaP) }]
    }
    return FAMILIAS.map(([fam, nombre]) => {
      const vs = ventasPorFamilia[fam] || []
      return { familia: fam, nombre, ventas: vs, m: calcularMetricasAds(efectivo.porFamilia[fam] || 0, vs, estadoPaP) }
    })
    // Mostramos todas las familias siempre, así siempre podés cargar el gasto
    // aunque ese producto todavía no tenga ventas registradas este mes.
  }, [modo, efectivo, ventasPorFamilia, ventas, estadoPaP])

  // Totales del mes (para el resumen de arriba)
  // 12-10: incluye el Meta sincronizado sin producto asignado (catálogo mixto).
  const totalMes = useMemo(() => {
    const todas = ventas.filter(v => familiaProducto(v.producto_nombre))
    return calcularMetricasAds(efectivo.total, todas, estadoPaP)
  }, [efectivo, ventas, estadoPaP])

  const setGasto = (fam, val) => setGastos(g => ({ ...g, [fam]: val.replace(/[^\d]/g, '') }))

  const guardar = async () => {
    // 12-10: en "Todas" no hay una sola tienda donde guardar. Antes el borrado
    // de abajo no filtraba tienda: guardar en Voltra borraba las filas de FW.
    const filtro = filtroBorradoCampanas({ mes, tienda: enTodas ? 'todas' : tiendaParaEscribir(), familias: IDS_FAMILIAS })
    if (!filtro) { toast('Elegí Voltra o Facial Wellness arriba para guardar el gasto', 'error'); return }
    setGuardando(true)
    try {
      // Reemplazar el gasto del mes: borrar lo anterior e insertar lo nuevo.
      // Guardamos la familia en la columna `nombre` (que YA existe en la tabla),
      // así funciona sin depender de ningún cambio de esquema.
      // Solo la tienda elegida y solo las familias que esta pantalla muestra.
      const del = await supabase.from('campanas_ads').delete()
        .eq('mes', filtro.mes).eq('tienda', filtro.tienda).in('nombre', filtro.nombres)
      if (del.error) throw del.error
      // FIX plataforma: la tabla viene de un esquema anterior donde `plataforma` es
      // obligatoria Y tiene un CHECK con lista blanca de valores. No sabemos con qué
      // grafía se creó, así que probamos variantes de Meta/Facebook hasta que una pase.
      let filasIns = []
      if (modo === 'total') {
        const g = Number(gastos.total) || 0
        if (g > 0) filasIns.push({ mes, nombre: 'total', gasto: g })
      } else {
        filasIns = FAMILIAS
          .filter(([f]) => (Number(gastos[f]) || 0) > 0)
          .map(([f]) => ({ mes, nombre: f, gasto: Number(gastos[f]) }))
      }
      if (filasIns.length) {
        const CANDIDATOS_PLATAFORMA = ['meta', 'Meta', 'META', 'facebook', 'Facebook', 'FACEBOOK', 'meta_ads', 'Meta Ads', 'facebook_ads']
        let guardado = false
        let ultimoError = null
        for (const plat of CANDIDATOS_PLATAFORMA) {
          const { error } = await supabase.from('campanas_ads').insert(filasIns.map(f => ({ ...f, plataforma: plat, tienda: filtro.tienda })))
          if (!error) { guardado = true; break }
          ultimoError = error
          // Si el error no es por la columna plataforma, no tiene sentido seguir probando.
          if (!/plataforma/i.test(error.message || '')) break
        }
        if (!guardado) throw ultimoError
      }
      toast('Gasto de ads guardado', 'success')
      cargar() // relee: con carga manual, el Meta sincronizado de ese mes deja de sumarse
    } catch (e) {
      toast('Error al guardar: ' + e.message, 'error')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Meta Ads</h1>
          <p className="page-subtitle">El gasto sale de Meta sincronizado (o de tu carga a mano) y el sistema calcula CPA y ROAS reales con tus entregas</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="month" className="form-select" style={{ width: 'auto' }} value={mes}
            onChange={e => setMes(e.target.value)} />
          <button className="btn btn-primary" onClick={guardar} disabled={loading || guardando || !editable}
            title={enTodas ? 'Elegí Voltra o Facial Wellness arriba para guardar' : usaMeta ? 'El gasto viene de Meta sincronizado: no hace falta guardar' : undefined}>
            {guardando ? <Loader2 size={14} className="spinning" /> : <Save size={14} />} Guardar
          </button>
        </div>
      </div>

      {/* Selector de mes — antes solo estaba el input nativo, que en Chrome no
          siempre se nota como clickeable para volver a un mes anterior. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 4 }}>Mes:</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {mesesRapidos.map(mm => (
            <button
              key={mm}
              onClick={() => setMes(mm)}
              className="btn btn-sm"
              style={{
                background: mes === mm ? 'var(--accent)' : 'var(--bg-hover)',
                color: mes === mm ? '#000' : 'var(--text-secondary)',
                border: 'none', fontWeight: mes === mm ? 700 : 500,
                whiteSpace: 'nowrap',
              }}
            >
              {etiquetaMes(mm)}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          ¿más atrás de {etiquetaMes(mesesRapidos[mesesRapidos.length - 1])}? usá el campo de fecha de arriba
        </span>
      </div>

      {/* 12-10: de dónde sale el gasto y por qué no se puede guardar */}
      {!loading && (enTodas || meta || cargaManual) && (
        <div className="card" style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Info size={15} color="var(--accent)" style={{ flexShrink: 0 }} />
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6, flex: 1, minWidth: 220 }}>
            {usaMeta && <>Gasto <strong>de Meta sincronizado</strong> (diario, automático): {formatGs(meta.total)} este mes
              {efectivo.metaSinFamilia > 0 && <> · {formatGs(efectivo.metaSinFamilia)} sin producto asignado (catálogo mixto: suma en el total, no en un producto)</>}
              {efectivo.manual > 0 && <> · + {formatGs(efectivo.manual)} cargados a mano en otra tienda</>}.</>}
            {!usaMeta && cargaManual && <>Carga a mano: al guardar, este mes de esta tienda deja de usar Meta sincronizado.</>}
            {enTodas && <> Con <strong>Todas</strong> elegido no se puede guardar: no hay una sola tienda donde anotarlo. Elegí Voltra o Facial Wellness arriba.</>}
          </p>
          {meta && !enTodas && (
            <button className="btn btn-ghost btn-sm" onClick={() => setCargaManual(c => !c)}>
              {cargaManual ? 'Volver a Meta sincronizado' : 'Cargar a mano'}
            </button>
          )}
        </div>
      )}

      {/* Toggle de modo */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div className="tabs">
          <button className={`tab ${modo === 'producto' ? 'active' : ''}`} onClick={() => setModo('producto')}>Por producto</button>
          <button className={`tab ${modo === 'total' ? 'active' : ''}`} onClick={() => setModo('total')}>Total del mes</button>
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {modo === 'producto' ? (editable ? 'Cargá cuánto gastaste en cada producto' : 'Gasto de cada producto') : 'Un solo número para todo el mes'}
        </span>
      </div>

      {loading ? (
        <div className="empty-state" style={{ padding: 60 }}><Loader2 size={28} className="spinning" /><p>Cargando ventas del mes…</p></div>
      ) : (
        <>
          {/* Resumen del mes */}
          {totalMes.gasto > 0 && (
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 14 }}>
                <ResumenKPI label="Gasto total" valor={formatGs(totalMes.gasto)} sub={usaMeta ? 'de Meta sincronizado' : 'cargado a mano'} />
                <ResumenKPI label="CPA real" valor={formatGs(totalMes.cpaReal)} sub={`por entrega · Meta: ${formatGs(totalMes.cpaPedido)}`} />
                <ResumenKPI label="ROAS real" valor={`${totalMes.roasReal}x`} sub={`cobrado · bruto: ${totalMes.roasBruto}x`} color={totalMes.veredicto === 'esperar' ? 'var(--text-secondary)' : totalMes.roasReal >= 2 ? 'var(--green)' : 'var(--yellow)'} />
                {/* 12-10: con muestra chica y pedidos en camino, color neutro (no es plata cerrada) */}
                <ResumenKPI label={totalMes.enProceso > 0 ? 'Ganancia hasta hoy' : 'Ganancia neta'} valor={formatGs(totalMes.gananciaNeta)}
                  sub={totalMes.enProceso > 0 && totalMes.veredicto !== 'esperar' ? `proyectada: ${formatGs(totalMes.gananciaProyectada)} (${totalMes.enProceso} en camino)` : totalMes.veredicto === 'esperar' ? `esperá: ${totalMes.enProceso} en camino` : undefined}
                  color={totalMes.veredicto === 'esperar' ? 'var(--text-secondary)' : totalMes.gananciaProyectada >= 0 ? 'var(--green)' : 'var(--red)'} />
                <ResumenKPI label="Entrega" valor={textoEsperada(totalMes.tasa)} sub={textoRango(totalMes.tasa)} color={colorTasa(totalMes.tasa)} />
              </div>
            </div>
          )}

          {/* Explicación del insight */}
          <div className="card" style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <Info size={15} color="var(--accent)" style={{ flexShrink: 0, marginTop: 1 }} />
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
              Meta cuenta pedidos <em>hechos</em>. El <strong>CPA real</strong> y el <strong>ROAS real</strong> se calculan sobre lo <strong>entregado y cobrado</strong> — el número que decide si la campaña gana plata de verdad.
            </p>
          </div>

          {/* Lista de productos con gasto + métricas */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Ultrawide (≥1900 px): tarjetas de producto en 2-3 columnas. Abajo de 1900 este envoltorio no existe. */}
            <div className="ultra-contents ultra-grid ultra-grid-3 ultra-estirar">
            {modo === 'total' && (
              <div className="card ultra-span" style={{ padding: '14px 18px' }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Gasto total del mes en Meta{usaMeta ? ' (de Meta sincronizado)' : ''}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Gs.</span>
                  <input className="form-input" type="text" inputMode="numeric" placeholder="2000000"
                    value={editable ? (gastos.total ? Number(gastos.total).toLocaleString('es-PY') : '') : (efectivo.total ? efectivo.total.toLocaleString('es-PY') : '')}
                    disabled={!editable}
                    onChange={e => setGasto('total', e.target.value)} style={{ maxWidth: 200, fontSize: 16, fontWeight: 700 }} />
                </div>
              </div>
            )}

            {filas.map(({ familia, nombre, ventas: vs, m }) => {
              const cfg = VEREDICTO_CFG[m.veredicto] || VEREDICTO_CFG.sin_gasto
              return (
                <div key={familia} className="card" style={{ padding: '14px 18px', borderLeft: `3px solid ${cfg.color}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: 15 }}>{nombre}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: cfg.bg, color: cfg.color }}>
                          {m.veredicto === 'esperar' ? `${cfg.label}: ${m.enProceso} en camino` : cfg.label}
                        </span>
                      </div>
                      {/* 12-10: "~esperada%" + rango + en camino; nunca un 100% de pocos resueltos */}
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                        {m.despachados} pedidos · {m.entregados} entregados · <span style={{ color: colorTasa(m.tasa), fontWeight: 600 }}>{textoEsperada(m.tasa)} entrega</span> · {textoRango(m.tasa)}
                      </div>
                    </div>
                    {modo === 'producto' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{usaMeta ? 'Meta sinc. Gs.' : 'Gasté Gs.'}</span>
                        <input className="form-input" type="text" inputMode="numeric" placeholder="0"
                          value={editable
                            ? (gastos[familia] ? Number(gastos[familia]).toLocaleString('es-PY') : '')
                            : (efectivo.porFamilia[familia] ? efectivo.porFamilia[familia].toLocaleString('es-PY') : '')}
                          disabled={!editable}
                          onChange={e => setGasto(familia, e.target.value)}
                          style={{ maxWidth: 130, fontWeight: 700 }} />
                      </div>
                    )}
                  </div>

                  {m.gasto > 0 && (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 10, marginTop: 12 }}>
                        <MetricaMini label="CPA real" valor={formatGs(m.cpaReal)} />
                        <MetricaMini label="ROAS real" valor={`${m.roasReal}x`} color={m.veredicto === 'esperar' ? 'var(--text-secondary)' : m.roasReal >= 2 ? 'var(--green)' : 'var(--yellow)'} />
                        <MetricaMini label="Cobrado" valor={formatGs(m.cobrado)} />
                        <MetricaMini label={m.enProceso > 0 ? 'Ganancia hasta hoy' : 'Ganancia neta'} valor={formatGs(m.gananciaNeta)} color={m.veredicto === 'esperar' ? 'var(--text-secondary)' : m.gananciaNeta >= 0 ? 'var(--green)' : 'var(--red)'} />
                        {m.enProceso > 0 && m.veredicto !== 'esperar' && (
                          <MetricaMini label="Proyectada" valor={formatGs(m.gananciaProyectada)} color={m.gananciaProyectada >= 0 ? 'var(--green)' : 'var(--red)'} />
                        )}
                      </div>
                      <p style={{ fontSize: 12.5, color: cfg.color, marginTop: 10, marginBottom: 0, fontWeight: 500 }}>
                        {textoVeredicto(m, nombre)}
                      </p>
                    </>
                  )}
                </div>
              )
            })}

            {filas.length === 0 && (
              <div className="empty-state ultra-span" style={{ padding: 40 }}>
                <div className="empty-state-icon"><Megaphone size={26} /></div>
                <p style={{ fontWeight: 600 }}>Sin ventas ni gasto este mes</p>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Elegí un mes con ventas o cargá el gasto de un producto.</p>
              </div>
            )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ResumenKPI({ label, valor, sub, color }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'var(--font-display)', color: color || 'var(--text-primary)', marginTop: 2 }}>{valor}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function MetricaMini({ label, valor, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color || 'var(--text-primary)', marginTop: 1 }}>{valor}</div>
    </div>
  )
}
