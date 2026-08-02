// src/pages/rendicion/RendicionPage.jsx
import { useState, useEffect, useMemo, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import { sanearEntrega } from '../../lib/estadosPaP'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { parsearFilasRendicion, conciliarRendicion, combinarArchivosRendicion } from '../../lib/conciliacionRendicion'
import { esRendicionLucero, parsearRendicionLucero, rendicionLuceroAEntregas, resumenRendicionLucero } from '../../lib/rendicionLucero'
import { soloColumnasEntregas } from '../../lib/estadosPaP'
import { Truck, Clock, AlertTriangle, TrendingUp, CheckCircle, Wallet, CalendarClock, Upload, FileCheck } from 'lucide-react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts'

const formatGs = (n) => Math.round(n || 0).toLocaleString('es-PY') + ' Gs.'
const fechaCorta = (d) => d ? new Date(d).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' }) : '—'

export default function RendicionPage() {
  const { toast } = useToast()
  const [historico, setHistorico] = useState([])
  const [resumenLucero, setResumenLucero] = useState(null)
  const [cargando, setCargando] = useState(true)

  // ── Importar reporte de rendición del martes ──
  const [conciliacion, setConciliacion] = useState(null) // resultado a confirmar
  const [nombreArchivo, setNombreArchivo] = useState('')
  const [importando, setImportando] = useState(false)
  const fileRendRef = useRef(null)

  // ── Selección manual ───────────────────────────────────
  const [seleccionados, setSeleccionados] = useState(new Set())
  const [marcando, setMarcando] = useState(false)
  // Referencias de ventas pagadas por adelantado: PaP no las cobra ni te las
  // rinde (ya tenés esa plata), así que se excluyen de "por cobrar".
  const [refsPrepago, setRefsPrepago] = useState(new Set())

  const cargarHistorico = async () => {
    try {
      const data = await fetchAll(
        () => supabase.from('entregas').select('*').order('fecha_entrega', { ascending: false }),
        { columnaOrden: 'nro_guia_pap' })
      setHistorico(data || [])
      setSeleccionados(new Set())
    } catch (e) { /* tabla vacía o sin acceso */ }
  }

  useEffect(() => {
    let activo = true
    ;(async () => {
      try {
        const data = await fetchAll(
          () => supabase.from('entregas').select('*').order('fecha_entrega', { ascending: false }),
          { columnaOrden: 'nro_guia_pap' })
        if (activo) setHistorico(data || [])
      } catch (e) { /* tabla vacía o sin acceso */ }
      // Cargar qué ventas fueron prepago (para no contarlas como "PaP me debe")
      try {
        const prep = await fetchAll(() => supabase
          .from('ventas').select('n_referencia').eq('pago_anticipado', true))
        if (activo) {
          const norm = (r) => String(r || '').replace(/[^0-9]/g, '')
          setRefsPrepago(new Set((prep || []).map(v => norm(v.n_referencia))))
        }
      } catch (e) { /* la columna puede no existir todavía; se ignora */ }
      if (activo) setCargando(false)
    })()
    return () => { activo = false }
  }, [])

  // Calcula el bloque completo de KPIs de cobranza para una lista de items YA
  // saneados y filtrados (por transportadora, o todos juntos). Función pura
  // para poder calcularla por separado en PaP, Lucero y el total, sin mezclar
  // ciclos de cobro que no tienen nada que ver entre sí (PaP rinde en ~7 días,
  // Lucero al día siguiente — promediarlos da un número que no describe a nadie).
  function calcularStatsCobranza(items) {
    const entregados = items.filter(m => m.categoria === 'entregado')
    const proceso = items.filter(m => m.categoria === 'en_proceso')
    const rendidos = entregados.filter(m => m.rendido)
    const sinRendir = entregados.filter(m => !m.rendido && !m._prepago)

    const yaRendido = rendidos.reduce((s, m) => s + (m.importe || 0), 0)
    const porCobrar = sinRendir.reduce((s, m) => s + (m.importe || 0), 0)
    const enTransito = proceso.reduce((s, m) => s + (m.importe || 0), 0)

    const diasRend = rendidos.map(m => m.dias_rendicion).filter(d => d != null && d >= 0)
    const diasProm = diasRend.length ? diasRend.reduce((a, b) => a + b, 0) / diasRend.length : null
    const ordenados = [...diasRend].sort((a, b) => a - b)
    const diasMediana = ordenados.length
      ? (ordenados.length % 2
          ? ordenados[(ordenados.length - 1) / 2]
          : (ordenados[ordenados.length / 2 - 1] + ordenados[ordenados.length / 2]) / 2)
      : null
    const trancados = diasRend.filter(d => d > 14).length

    const hoy = new Date()
    const listaSinRendir = sinRendir.map(m => {
      const fEnt = m.fecha_entrega ? new Date(m.fecha_entrega) : null
      const diasSinRendir = fEnt ? Math.max(0, Math.round((hoy - fEnt) / 86400000)) : null
      const fechaEstimada = (fEnt && diasMediana != null) ? new Date(fEnt.getTime() + diasMediana * 86400000) : null
      return { ...m, diasSinRendir, fechaEstimada }
    }).sort((a, b) => (b.diasSinRendir ?? -1) - (a.diasSinRendir ?? -1))

    const umbralDemora = diasMediana != null ? Math.max(15, diasMediana * 2) : 15
    const demoradas = listaSinRendir.filter(m => m.diasSinRendir != null && m.diasSinRendir > umbralDemora)
    const montoDemorado = demoradas.reduce((s, m) => s + (m.importe || 0), 0)

    const porFecha = {}
    rendidos.forEach(m => {
      if (m.fecha_rendido) {
        const f = String(m.fecha_rendido).slice(0, 10)
        if (!porFecha[f]) porFecha[f] = { fecha: f, monto: 0, count: 0 }
        porFecha[f].monto += (m.importe || 0)
        porFecha[f].count++
      }
    })
    const historicoRend = Object.values(porFecha).sort((a, b) => new Date(a.fecha) - new Date(b.fecha))
    const datosGrafico = historicoRend.map(r => ({ ...r, label: fechaCorta(r.fecha) }))

    const fechasEst = listaSinRendir.map(m => m.fechaEstimada).filter(Boolean)
    const cobroEstimadoHasta = fechasEst.length ? new Date(Math.max(...fechasEst.map(d => d.getTime()))) : null

    const hayDatos = items.some(m => m.rendido || m.fecha_rendido)
    const totalGestionado = yaRendido + porCobrar
    const tasaCobrado = totalGestionado ? Math.round(yaRendido / totalGestionado * 100) : 0

    // Costo de flete de lo YA entregado (útil sobre todo para Lucero, donde el
    // flete es el real de la tarifa, no una estimación).
    const fleteTotal = entregados.reduce((s, m) => s + (m.costo_envio || 0), 0)

    return {
      yaRendido, porCobrar, enTransito, diasProm, diasMediana, trancados, umbralDemora,
      listaSinRendir, historicoRend, datosGrafico, fleteTotal,
      nEntregados: entregados.length, nRendidos: rendidos.length, nSinRendir: sinRendir.length, nProceso: proceso.length,
      demoradas, montoDemorado, cobroEstimadoHasta, hayDatos, tasaCobrado,
    }
  }

  const [vista, setVista] = useState('todas')  // 'todas' | 'pap' | 'lucero'

  const { statsPaP, statsLucero, statsTotal, hayLucero } = useMemo(() => {
    const norm = (r) => String(r || '').replace(/[^0-9]/g, '')
    const esPrepago = (m) => refsPrepago.has(norm(m.n_referencia)) || refsPrepago.has(norm(m.nro_guia_ref))
    const items = historico.map(h => ({ ...sanearEntrega(h), _prepago: esPrepago(h) }))
    const itemsPaP = items.filter(m => (m.transportadora || 'pap') === 'pap')
    const itemsLucero = items.filter(m => m.transportadora === 'lucero')
    return {
      statsPaP: calcularStatsCobranza(itemsPaP),
      statsLucero: calcularStatsCobranza(itemsLucero),
      statsTotal: calcularStatsCobranza(items),
      hayLucero: itemsLucero.length > 0,
    }
  }, [historico, refsPrepago])

  // La pestaña activa decide qué alimenta los KPIs y la tabla de pendientes.
  const stats = vista === 'pap' ? statsPaP : vista === 'lucero' ? statsLucero : statsTotal
  const NOMBRE_TRANSP = { pap: 'PaP', lucero: 'Lucero', todas: 'todas las transportadoras' }

  // ── Selección ─────────────────────────────────────────
  const toggleSel = (guia) => {
    setSeleccionados(prev => {
      const next = new Set(prev)
      if (next.has(guia)) next.delete(guia)
      else next.add(guia)
      return next
    })
  }

  const todosSeleccionados = stats.listaSinRendir.length > 0 &&
    stats.listaSinRendir.every(m => seleccionados.has(m.nro_guia_pap))

  const toggleTodos = () => {
    if (todosSeleccionados) setSeleccionados(new Set())
    else setSeleccionados(new Set(stats.listaSinRendir.map(m => m.nro_guia_pap)))
  }

  const montoSeleccionado = stats.listaSinRendir
    .filter(m => seleccionados.has(m.nro_guia_pap))
    .reduce((s, m) => s + (m.importe || 0), 0)

  // ── Marcar como rendido manual ─────────────────────────
  const marcarRendidoManual = async () => {
    if (!seleccionados.size) return
    setMarcando(true)
    const hoy = new Date().toISOString().split('T')[0]
    const items = stats.listaSinRendir.filter(m => seleccionados.has(m.nro_guia_pap))

    const updates = items.map(m => {
      const fEnt = m.fecha_entrega ? new Date(m.fecha_entrega) : null
      const dias = fEnt ? Math.max(0, Math.round((Date.now() - fEnt.getTime()) / 86400000)) : null
      return supabase.from('entregas')
        .update({ rendido: true, fecha_rendido: hoy, dias_rendicion: dias })
        .eq('nro_guia_pap', m.nro_guia_pap)
    })

    const results = await Promise.all(updates)
    const ok = results.filter(r => !r.error).length
    const fail = results.filter(r => r.error).length

    if (ok > 0) {
      await cargarHistorico()
      toast(`${ok} entrega${ok !== 1 ? 's' : ''} marcada${ok !== 1 ? 's' : ''} como rendida${ok !== 1 ? 's' : ''}`, 'success')
    }
    if (fail > 0) toast(`${fail} no se pudieron actualizar`, 'error')
    setMarcando(false)
  }

  // ── Importar reporte(s) de rendición del martes (uno o varios) ──
  const handleArchivosRendicion = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    const invalidos = files.filter(f => !/\.xlsx?$/i.test(f.name))
    if (invalidos.length) { toast('Solo archivos Excel (.xlsx)', 'error'); return }
    setNombreArchivo(files.length === 1 ? files[0].name : `${files.length} archivos`)
    setImportando(true)
    try {
      // Se lee cada archivo en los dos formatos: como matriz cruda (para detectar
      // y parsear el de Lucero, cuyo encabezado NO está en la primera fila) y como
      // objetos (para el de PaP, que sí lo tiene).
      const leerArchivo = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = (e) => {
          try {
            const wb = XLSX.read(e.target.result, { cellDates: true })
            const ws = wb.Sheets[wb.SheetNames[0]]
            resolve({
              nombre: file.name,
              crudo: XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }),
              objetos: XLSX.utils.sheet_to_json(ws, { defval: '' }),
            })
          } catch (err) { reject(err) }
        }
        reader.onerror = reject
        reader.readAsArrayBuffer(file)
      })
      const leidos = await Promise.all(files.map(leerArchivo))

      // ── Se separan por transportadora según el formato del archivo ──
      const deLucero = leidos.filter(a => esRendicionLucero(a.crudo))
      const dePaP = leidos.filter(a => !esRendicionLucero(a.crudo))

      // ── LUCERO: el archivo crea los registros de entrega (no existen todavía) ──
      if (deLucero.length) {
        const lotes = deLucero.map(a => parsearRendicionLucero(a.crudo))
        // Solo columnas reales de la tabla: una clave de más rechaza el insert entero.
        const registros = lotes.flatMap(rendicionLuceroAEntregas).map(soloColumnasEntregas)
        const resumenes = lotes.map(l => ({ ...resumenRendicionLucero(l), lote: l.lote, fecha: l.fecha, estadoLote: l.estadoLote, pagado: l.pagado, totalPago: l.totalPago, tarifas: l.tarifas, bruto: l.bruto }))
        const noCuadra = resumenes.filter(r => !r.todoCuadra)
        // Guardado tolerante: si la base todavía no tiene alguna columna (ej.
        // `transportadora` cuando falta correr la migración), se la saca y se
        // reintenta en vez de perder toda la importación.
        let guardados = 0, errorLucero = null
        const omitidas = []
        for (let i = 0; i < registros.length; i += 100) {
          let chunk = registros.slice(i, i + 100)
          for (let intento = 0; intento < 5; intento++) {
            const { error } = await supabase.from('entregas').upsert(chunk, { onConflict: 'nro_guia_pap' })
            if (!error) { guardados += chunk.length; break }
            const falta = /Could not find the '([^']+)' column/.exec(error.message || '')
            if (falta) {
              const col = falta[1]
              if (!omitidas.includes(col)) omitidas.push(col)
              chunk = chunk.map(r => { const o = { ...r }; delete o[col]; return o })
              continue
            }
            if (!errorLucero) errorLucero = error.message
            break
          }
        }
        setResumenLucero(resumenes)
        if (errorLucero) {
          toast('Lucero: error al guardar — ' + errorLucero, 'error')
        } else if (noCuadra.length) {
          toast(`Lucero: ${guardados} envíos guardados, pero ${noCuadra.length} lote(s) NO cuadran con su propia cabecera`, 'error')
        } else if (omitidas.length) {
          toast(`Lucero: ${guardados} envíos guardados, pero falta(n) la(s) columna(s) ${omitidas.join(', ')} en la tabla entregas — corré la migración`, 'error')
        } else {
          toast(`Lucero: ${guardados} envíos del lote ${resumenes.map(r => r.lote).join(', ')} — todo cuadra`, 'success')
        }
        await cargarHistorico()
      }

      // ── PaP: flujo de conciliación de siempre ──
      if (dePaP.length) {
        const listas = dePaP.map(a => parsearFilasRendicion(a.objetos))
        const filas = combinarArchivosRendicion(listas)
        if (!filas.length) {
          if (!deLucero.length) toast('No se encontraron guías en el/los archivo(s)', 'error')
        } else {
          const resultado = conciliarRendicion(filas, historico)
          setConciliacion(resultado)
          toast(`${filas.length} guías de PaP leídas — revisá la conciliación`, 'success')
        }
      }
    } catch (err) {
      toast('No se pudo leer: ' + (err?.message || err), 'error')
    } finally {
      setImportando(false)
    }
  }


  // Confirmar: marca como rendidas las guías conciliadas
  const confirmarRendicion = async () => {
    if (!conciliacion?.marcarRendido.length) return
    setImportando(true)
    const hoy = new Date().toISOString().split('T')[0]
    // Mapa guía → fecha_entrega para calcular días
    const fechaPorGuia = {}
    for (const h of historico) fechaPorGuia[String(h.nro_guia_pap)] = h.fecha_entrega

    const updates = conciliacion.marcarRendido.map(m => {
      const fEnt = fechaPorGuia[String(m.nro_guia_pap)] ? new Date(fechaPorGuia[String(m.nro_guia_pap)]) : null
      const dias = fEnt ? Math.max(0, Math.round((Date.now() - fEnt.getTime()) / 86400000)) : null
      return supabase.from('entregas')
        .update({ rendido: true, fecha_rendido: hoy, dias_rendicion: dias })
        .eq('nro_guia_pap', m.nro_guia_pap)
    })
    const results = await Promise.all(updates)
    const ok = results.filter(r => !r.error).length
    if (ok > 0) {
      await cargarHistorico()
      toast(`${ok} guías marcadas como rendidas`, 'success')
    }
    setConciliacion(null)
    setNombreArchivo('')
    setImportando(false)
  }

  // ── CARGANDO ───────────────────────────────────────────
  if (cargando) {
    return (
      <div style={{ padding: 24 }}>
        <h1 className="page-title">Rendición</h1>
        <p className="page-subtitle">Cargando datos de cobranza…</p>
      </div>
    )
  }

  // ── SIN DATOS (entregas vacía) ─────────────────────────
  if (historico.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 'clamp(16px, 4vw, 24px)' }}>
        <div>
          <h1 className="page-title">Rendición · Cobranza con Punto a Punto</h1>
          <p className="page-subtitle">Cuánto te debe PaP, cuándo lo cobrás y qué reclamar.</p>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: 'clamp(32px, 8vw, 64px) 24px' }}>
          <Wallet size={40} color="var(--text-muted)" style={{ margin: '0 auto 16px' }} />
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Todavía no hay datos de cobranza</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 460, margin: '0 auto', lineHeight: 1.5 }}>
            Esta sección se llena sola desde Entregas. Cuando descargues el reporte de Gestión de PaP,
            tildá <b>"Incluir Tesorería"</b> y subilo en Entregas. Acá vas a ver qué te rindió PaP,
            qué te debe y cuándo lo cobrás.
          </p>
        </div>
      </div>
    )
  }

  // ── DASHBOARD ──────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 'clamp(16px, 4vw, 24px)' }}>
      <div>
        <h1 className="page-title">Rendición · Cobranza</h1>
        <p className="page-subtitle">
          Cada transportadora cobra al cliente y te deposita después, con su propio ritmo — por eso van separadas.
          {' '}Viendo {NOMBRE_TRANSP[vista]}: {stats.nRendidos} rendidas · {stats.nSinRendir} por cobrar.
        </p>
      </div>

      {/* Selector de transportadora: cada una tiene un ciclo de cobro distinto,
          mezclarlas en un solo número no describe a ninguna de las dos. */}
      {hayLucero && (
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            ['todas', 'Todas'],
            ['pap', 'PAP'],
            ['lucero', 'Lucero'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setVista(id)}
              style={{
                padding: '7px 16px', fontSize: 12, fontWeight: 700, borderRadius: 8, cursor: 'pointer',
                border: vista === id ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: vista === id ? 'var(--accent)' : 'transparent',
                color: vista === id ? '#0a0a0a' : 'var(--text-secondary)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Importar reporte de rendición del martes */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: '0 0 2px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <FileCheck size={16} color="var(--accent)" /> Importar rendición del martes
            </h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              Subí los Excel de PaP o de Lucero — el formato se detecta solo. PaP concilia lo ya entregado; Lucero además da de alta sus envíos.
            </p>
          </div>
          <input ref={fileRendRef} type="file" accept=".xlsx,.xls" multiple style={{ display: "none" }}
            onChange={e => handleArchivosRendicion(e.target.files)} />
          <button className="btn btn-primary" onClick={() => fileRendRef.current?.click()} disabled={importando}>
            <Upload size={14} /> {importando ? "Procesando…" : "Subir Excel(es)"}
          </button>
        </div>

        {/* Resultado de la rendición de Lucero */}
        {resumenLucero && resumenLucero.length > 0 && (
          <div className="card" style={{ padding: '14px 18px', marginTop: 12, borderLeft: '3px solid var(--accent)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Rendición de Lucero del Este</h3>
              <button className="btn" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => setResumenLucero(null)}>Cerrar</button>
            </div>
            {resumenLucero.map((r, i) => (
              <div key={i} style={{ marginBottom: i < resumenLucero.length - 1 ? 14 : 0 }}>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  <b>Lote {r.lote}</b> · {r.fecha} · {r.cantidad} envío{r.cantidad !== 1 ? 's' : ''} ·{' '}
                  <span style={{ color: r.pagado ? 'var(--green)' : 'var(--orange, #f59e0b)', fontWeight: 700 }}>
                    {r.pagado ? 'ya depositado' : `${r.estadoLote} — todavía no te depositaron`}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
                  <div className="kpi-card"><div className="kpi-label">Bruto cobrado</div><div className="kpi-value" style={{ fontSize: 16 }}>{formatGs(r.bruto)}</div></div>
                  <div className="kpi-card"><div className="kpi-label">Fletes Lucero</div><div className="kpi-value" style={{ fontSize: 16, color: 'var(--red)' }}>−{formatGs(r.tarifas)}</div></div>
                  <div className="kpi-card"><div className="kpi-label">Te depositan</div><div className="kpi-value" style={{ fontSize: 16, color: 'var(--green)' }}>{formatGs(r.totalPago)}</div></div>
                </div>
                <div style={{ fontSize: 11, marginTop: 6, color: r.todoCuadra ? 'var(--text-muted)' : 'var(--red)' }}>
                  {r.todoCuadra
                    ? 'Las sumas del detalle cuadran con la cabecera del archivo.'
                    : '⚠ El detalle NO cuadra con la cabecera del archivo — revisalo con Lucero antes de darlo por bueno.'}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Panel de conciliación (previo a confirmar) */}
        {conciliacion && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            {/* Alerta fuerte si PaP rindió de menos */}
            {conciliacion.totalFaltante > 0 && (
              <div style={{ padding: '12px 16px', borderRadius: 8, background: 'rgba(239,68,68,0.12)', border: '2px solid var(--red)', marginBottom: 14 }}>
                <div style={{ fontWeight: 800, color: 'var(--red)', fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AlertTriangle size={18} /> ¡PaP te rindió {formatGs(conciliacion.totalFaltante)} DE MENOS!
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6 }}>
                  {conciliacion.discrepancias.length} guía(s) donde PaP cobró menos de lo que valía el pedido. Es tu plata — reclamala:
                </div>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {conciliacion.discrepancias.slice(0, 8).map((d, i) => (
                    <div key={i} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <span>{d.nombre || d.ref} (guía {d.nroGuia})</span>
                      <span style={{ color: 'var(--red)', fontWeight: 600 }}>esperabas {formatGs(d.esperado)}, cobró {formatGs(d.cobrado)} · falta {formatGs(d.falta)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Resumen de la conciliación */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 14 }}>
              <ConcKPI label="PaP te rinde (efectivo)" valor={formatGs(conciliacion.totalEfectivo)} sub={`${conciliacion.countEfectivo} guías`} color="var(--green)" />
              <ConcKPI label="Ya cobraste (transferencia)" valor={formatGs(conciliacion.totalTransferencia)} sub={`${conciliacion.countTransf} prepagos`} />
              <ConcKPI label="Se marcan rendidas" valor={conciliacion.marcarRendido.length} sub={`de ${conciliacion.totalGuias} del archivo`} color="var(--accent)" />
              {conciliacion.noEncontradas.length > 0 && (
                <ConcKPI label="No están en el sistema" valor={conciliacion.noEncontradas.length} sub="revisar" color="var(--yellow)" />
              )}
            </div>

            {conciliacion.noEncontradas.length > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12 }}>
                ⚠️ {conciliacion.noEncontradas.length} guía(s) del archivo no están cargadas en el sistema (importá primero el reporte de Gestión en Entregas para que crucen): {conciliacion.noEncontradas.slice(0, 5).map(n => n.nroGuia).join(', ')}{conciliacion.noEncontradas.length > 5 ? '…' : ''}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => { setConciliacion(null); setNombreArchivo(''); }}>Cancelar</button>
              <button className="btn btn-primary" onClick={confirmarRendicion} disabled={importando || !conciliacion.marcarRendido.length}>
                <CheckCircle size={14} /> Confirmar y marcar {conciliacion.marcarRendido.length} rendidas
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Alerta de demoras */}
      {stats.demoradas.length > 0 && (
        <div className="alert alert-warning">
          <AlertTriangle size={15} />
          <div>
            <div style={{ fontWeight: 600 }}>
              {stats.demoradas.length} entregas llevan más de {Math.round(stats.umbralDemora)} días sin que te depositen · {formatGs(stats.montoDemorado)}
            </div>
            <div style={{ fontSize: 12, marginTop: 2 }}>Reclamá estas a {NOMBRE_TRANSP[vista]} — están en la lista de abajo, marcadas en rojo.</div>
          </div>
        </div>
      )}

      {/* KPIs principales */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <div className="card" style={{ borderLeft: '3px solid var(--yellow)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
            <Clock size={13} /> TE DEBE ({NOMBRE_TRANSP[vista].toUpperCase()})
          </div>
          <div style={{ fontSize: 'clamp(20px, 5vw, 26px)', fontWeight: 800, color: 'var(--yellow)', fontFamily: 'var(--font-display)' }}>{formatGs(stats.porCobrar)}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{stats.nSinRendir} entregas sin rendir</div>
        </div>
        <div className="card" style={{ borderLeft: '3px solid var(--green)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
            <CheckCircle size={13} /> YA TE DEPOSITARON
          </div>
          <div style={{ fontSize: 'clamp(20px, 5vw, 26px)', fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--font-display)' }}>{formatGs(stats.yaRendido)}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{stats.nRendidos} rendidas · {stats.tasaCobrado}% del total</div>
        </div>
        <div className="card">
          <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
            <Truck size={13} /> EN TRÁNSITO
          </div>
          <div style={{ fontSize: 'clamp(20px, 5vw, 26px)', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{formatGs(stats.enTransito)}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{stats.nProceso} en camino, sin resolver</div>
        </div>
        {vista === 'lucero' && (
          <div className="card">
            <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
              <Truck size={13} /> FLETE PAGADO A LUCERO
            </div>
            <div style={{ fontSize: 'clamp(20px, 5vw, 26px)', fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--red)' }}>−{formatGs(stats.fleteTotal)}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>Tarifa real por ciudad, no estimada · {stats.nEntregados} entregados</div>
          </div>
        )}
        <div className="card">
          <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
            <CalendarClock size={13} /> TIEMPO DE COBRO
          </div>
          <div style={{ fontSize: 'clamp(20px, 5vw, 26px)', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{stats.diasMediana != null ? `${stats.diasMediana.toFixed(1)} días` : '—'}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            Típico (mediana), de la entrega al depósito
            {stats.diasProm != null ? ` · prom. ${stats.diasProm.toFixed(1)}d` : ''}
            {stats.trancados > 0 ? ` · ${stats.trancados} trancada${stats.trancados > 1 ? 's' : ''} +14d` : ''}
          </div>
        </div>
      </div>

      {/* Proyección de cobro */}
      {stats.porCobrar > 0 && stats.cobroEstimadoHasta && stats.diasMediana != null && (
        <div className="card" style={{ background: 'var(--green-dim)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <TrendingUp size={20} color="var(--green)" />
          <div style={{ fontSize: 13 }}>
            Al ritmo típico de <b>{stats.diasMediana.toFixed(1)} días</b>, deberías terminar de cobrar
            los <b style={{ color: 'var(--green)' }}>{formatGs(stats.porCobrar)}</b> pendientes
            alrededor del <b>{stats.cobroEstimadoHasta.toLocaleDateString('es-PY', { day: '2-digit', month: 'long' })}</b>.
          </div>
        </div>
      )}

      {/* Histórico de rendiciones */}
      {stats.datosGrafico.length > 0 && (
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Histórico de depósitos · {NOMBRE_TRANSP[vista]}</div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>Cuánto te rindió PaP en cada fecha.</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={stats.datosGrafico} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={36} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                formatter={(v) => [formatGs(v), 'Depositado']}
                labelFormatter={l => `Fecha: ${l}`}
              />
              <Bar dataKey="monto" radius={[4, 4, 0, 0]}>
                {stats.datosGrafico.map((e, i) => <Cell key={i} fill="var(--green)" />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ─── Lista "PaP te debe" con selección manual ─────── */}
      {stats.listaSinRendir.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--yellow)' }}>
                  Lo que {NOMBRE_TRANSP[vista]} te debe rendir · {formatGs(stats.porCobrar)}
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  Ordenado por antigüedad. Rojo = más de {Math.round(stats.umbralDemora)} días. Usá el checkbox para marcar manualmente lo que ya te depositaron.
                </p>
              </div>

              {/* Botón marcar manual */}
              {seleccionados.size > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    <b style={{ color: 'var(--text-primary)' }}>{seleccionados.size}</b> seleccionada{seleccionados.size !== 1 ? 's' : ''} · <b style={{ color: 'var(--green)' }}>{formatGs(montoSeleccionado)}</b>
                  </span>
                  <button
                    onClick={marcarRendidoManual}
                    disabled={marcando}
                    style={{
                      padding: '7px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8, cursor: 'pointer', border: 'none',
                      background: 'var(--green)', color: '#fff',
                      display: 'flex', alignItems: 'center', gap: 6,
                      opacity: marcando ? 0.6 : 1,
                    }}
                  >
                    <CheckCircle size={13} />
                    {marcando ? 'Guardando…' : 'Marcar como rendido'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
            <table className="tabla-responsive" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 580 }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1 }}>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase' }}>
                  <th style={{ padding: '8px 8px 8px 16px', width: 36 }}>
                    <input
                      type="checkbox"
                      checked={todosSeleccionados}
                      onChange={toggleTodos}
                      title={todosSeleccionados ? 'Deseleccionar todas' : 'Seleccionar todas'}
                      style={{ cursor: 'pointer', accentColor: 'var(--green)', width: 14, height: 14 }}
                    />
                  </th>
                  <th style={{ padding: '8px 6px' }}>Ref</th>
                  {vista === 'todas' && <th style={{ padding: '8px 6px' }}>Transp.</th>}
                  <th style={{ padding: '8px 6px' }}>Guía</th>
                  <th style={{ padding: '8px 6px' }}>Ciudad</th>
                  <th style={{ padding: '8px 6px' }}>Entregado</th>
                  <th style={{ padding: '8px 6px', textAlign: 'center' }}>Días</th>
                  <th style={{ padding: '8px 16px', textAlign: 'right' }}>Importe</th>
                </tr>
              </thead>
              <tbody>
                {stats.listaSinRendir.map((m, i) => {
                  const demorada = m.diasSinRendir != null && m.diasSinRendir > stats.umbralDemora
                  const esSel = seleccionados.has(m.nro_guia_pap)
                  return (
                    <tr
                      key={i}
                      onClick={() => toggleSel(m.nro_guia_pap)}
                      style={{
                        borderTop: '1px solid var(--border)',
                        background: esSel
                          ? 'var(--green-dim)'
                          : demorada ? 'rgba(239,68,68,0.06)' : 'transparent',
                        cursor: 'pointer',
                        transition: 'background 0.1s',
                      }}
                    >
                      <td style={{ padding: '8px 8px 8px 16px' }}>
                        <input
                          type="checkbox"
                          checked={esSel}
                          onChange={() => toggleSel(m.nro_guia_pap)}
                          onClick={e => e.stopPropagation()}
                          style={{ cursor: 'pointer', accentColor: 'var(--green)', width: 14, height: 14 }}
                        />
                      </td>
                      <td data-label="Ref" style={{ padding: '8px 6px', fontWeight: 600 }}>{m.n_referencia ? '#' + m.n_referencia : '—'}</td>
                      {vista === 'todas' && (
                        <td data-label="Transp." style={{ padding: '8px 6px' }}>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                            background: m.transportadora === 'lucero' ? 'var(--accent-dim, rgba(200,241,53,0.15))' : 'var(--border)',
                            color: m.transportadora === 'lucero' ? 'var(--accent)' : 'var(--text-secondary)',
                          }}>
                            {m.transportadora === 'lucero' ? 'Lucero' : 'PAP'}
                          </span>
                        </td>
                      )}
                      <td data-label="Guía PaP" style={{ padding: '8px 6px', color: 'var(--text-muted)' }}>{m.nro_guia_pap}</td>
                      <td data-label="Ciudad" style={{ padding: '8px 6px' }}>{m.ciudad || '—'}</td>
                      <td data-label="Entregado" style={{ padding: '8px 6px', color: 'var(--text-muted)' }}>{fechaCorta(m.fecha_entrega)}</td>
                      <td data-label="Días" style={{ padding: '8px 6px', textAlign: 'center' }}>
                        {m.diasSinRendir != null
                          ? <span style={{ color: demorada ? 'var(--red)' : m.diasSinRendir > 8 ? 'var(--yellow)' : 'var(--text-muted)', fontWeight: demorada ? 700 : 400 }}>{m.diasSinRendir}d</span>
                          : '—'}
                      </td>
                      <td data-label="Importe" style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 600 }}>{formatGs(m.importe)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ConcKPI({ label, valor, sub, color }) {
  return (
    <div style={{ background: 'var(--bg-surface)', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || 'var(--text-primary)', marginTop: 2 }}>{valor}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}
