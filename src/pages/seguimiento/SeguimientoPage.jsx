// src/pages/seguimiento/SeguimientoPage.jsx
// ═══════════════════════════════════════════════════════════
// BANDEJA DE SEGUIMIENTO
//
// Flujo de trabajo, no lista de mensajes. Tres cosas que definen el diseño:
//
// 1. El pedido NO desaparece al escribirle. Cambia de estado y queda visible
//    con los botones de respuesta a la vista — antes desaparecía apenas se
//    abría WhatsApp y no había dónde registrar qué contestó el cliente.
//
// 2. Los botones de respuesta están SIEMPRE en la fila, no en un modal. Volver
//    de WhatsApp y registrar la respuesta tiene que ser un clic, no tres.
//
// 3. El reclamo al courier es AGRUPADO: un mensaje con todos los códigos
//    pendientes, no uno por pedido.
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { labelTransportadora } from '../../lib/transportadoras'
import {
  construirBandeja, resumenBandeja, linkWhatsApp, pedidosParaReclamar, mensajeReclamo,
  efectividad, mensajeReclamoIndividual, codigoCourier, PLANTILLAS, ESTADOS_SEG, RESPUESTAS, DIAS_SEGUIMIENTO_DEFAULT, hoyISO,
} from '../../lib/seguimiento'
import {
  MessageCircle, CheckCircle, AlertTriangle, Wallet, RefreshCw, Send, Clock, TrendingUp,
} from 'lucide-react'

export default function SeguimientoPage() {
  const [ventas, setVentas] = useState([])
  const [historicas, setHistoricas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [diasMin, setDiasMin] = useState(DIAS_SEGUIMIENTO_DEFAULT)
  const [filtroEstado, setFiltroEstado] = useState('todos')
  const [plantillaPorVenta, setPlantillaPorVenta] = useState({})
  const [guardando, setGuardando] = useState(null)
  const [pidiendoFecha, setPidiendoFecha] = useState(null)   // venta esperando fecha
  const [faltanColumnas, setFaltanColumnas] = useState(false)
  const toast = useToast()

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const cols = 'id, n_referencia, fecha, cliente_nombre, cliente_telefono, producto_nombre, ciudad, total, estado, pago_anticipado, transportadora, seguimiento_at, seguimiento_estado, seguimiento_intentos, seguimiento_nota, seguimiento_fecha_prometida'
      const abiertas = await fetchAll(() => supabase.from('ventas').select(cols)
        .is('deleted_at', null).in('estado', ['pendiente', 'en_tramite', 'en_camino'])
        .order('fecha', { ascending: true }))
      // Guías reales desde `entregas`: el courier busca por SU número, no por
      // nuestra referencia interna. Sin esto el reclamo llega incompleto.
      let guiaPorRef = {}
      try {
        const ents = await fetchAll(() => supabase.from('entregas')
          .select('n_referencia, nro_guia_pap, guia_transportadora'), { columnaOrden: 'nro_guia_pap' })
        ;(ents || []).forEach(e => {
          const k = String(e.n_referencia || '').replace(/\D/g, '')
          if (k) guiaPorRef[k] = { nro_guia: e.nro_guia_pap, guia_transportadora: e.guia_transportadora }
        })
      } catch { /* sin guías: el mensaje sale con referencia igual */ }
      setVentas((abiertas || []).map(v => ({
        ...v, ...(guiaPorRef[String(v.n_referencia || '').replace(/\D/g, '')] || {}),
      })))
      // Histórico solo para medir efectividad (ya cerradas y contactadas).
      try {
        const cerradas = await fetchAll(() => supabase.from('ventas')
          .select('estado, total, seguimiento_at').is('deleted_at', null)
          .in('estado', ['entregado', 'devuelto']).not('seguimiento_at', 'is', null))
        setHistoricas(cerradas || [])
      } catch { setHistoricas([]) }
      setFaltanColumnas(false)
    } catch (e) {
      if (/seguimiento_/.test(e?.message || '')) setFaltanColumnas(true)
      else toast('No se pudieron cargar los pedidos: ' + (e?.message || e), 'error')
      setVentas([])
    } finally { setCargando(false) }
  }, [toast])

  useEffect(() => { cargar() }, [cargar])

  const bandeja = useMemo(() => construirBandeja(ventas, { diasMin }), [ventas, diasMin])
  const resumen = useMemo(() => resumenBandeja(bandeja), [bandeja])
  const reclamos = useMemo(() => pedidosParaReclamar(bandeja), [bandeja])
  const efect = useMemo(() => efectividad(historicas), [historicas])
  const visibles = useMemo(
    () => filtroEstado === 'todos' ? bandeja : bandeja.filter(v => v.estado === filtroEstado),
    [bandeja, filtroEstado]
  )

  // Guardado tolerante: si faltan las columnas de seguimiento, igual se aplica
  // el cambio de estado de la venta, que es lo que mueve la plata.
  const guardar = async (v, patchSeg, estadoVenta) => {
    setGuardando(v.id)
    try {
      const patch = { ...patchSeg }
      if (estadoVenta) patch.estado = estadoVenta
      let { error } = await supabase.from('ventas').update(patch).eq('id', v.id)
      if (error && /Could not find the '(\w+)' column/.test(error.message || '')) {
        setFaltanColumnas(true)
        if (estadoVenta) {
          const r = await supabase.from('ventas').update({ estado: estadoVenta }).eq('id', v.id)
          error = r.error
        } else error = null
      }
      if (error) throw error
      await cargar()
    } catch (e) {
      toast('No se pudo guardar: ' + (e?.message || e), 'error')
    } finally { setGuardando(null) }
  }

  // Abrir WhatsApp = queda "esperando respuesta". El pedido NO se va de la
  // lista: se queda con los botones de respuesta a la vista.
  const abrirWhatsApp = async (v) => {
    const plantilla = plantillaPorVenta[v.id] || v.plantillaSugerida
    const link = linkWhatsApp(v, plantilla)
    if (!link) { toast('Ese número no es un celular válido', 'error'); return }
    window.open(link, '_blank', 'noopener')
    await guardar(v, {
      seguimiento_at: hoyISO(),
      seguimiento_estado: 'esperando',
      seguimiento_intentos: (v.intentos || 0) + 1,
    }, null)
    toast('Mensaje abierto — registrá la respuesta cuando conteste', 'success')
  }

  const registrarRespuesta = async (v, resp, fechaPrometida = null) => {
    const cfg = ESTADOS_SEG[resp.estado]
    await guardar(v, {
      seguimiento_estado: resp.estado,
      seguimiento_nota: resp.label,
      ...(fechaPrometida ? { seguimiento_fecha_prometida: fechaPrometida } : {}),
    }, cfg?.cierra || null)
    toast(cfg?.cierra ? `Venta cerrada como ${cfg.cierra}` : `Marcado: ${resp.label}`, 'success')
  }

  // Aviso por UN pedido puntual (sin esperar a agrupar).
  const avisarUno = async (v) => {
    const texto = mensajeReclamoIndividual(v)
    await navigator.clipboard.writeText(texto).catch(() => {})
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener')
    await guardar(v, { seguimiento_estado: 'escalado', seguimiento_at: hoyISO() }, null)
    toast('Mensaje copiado — avisado al courier', 'success')
  }

  // Reclamo agrupado: un mensaje con TODOS los códigos de ese courier.
  const reclamarA = async (courierId, pedidos) => {
    const texto = mensajeReclamo(pedidos)
    await navigator.clipboard.writeText(texto).catch(() => {})
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener')
    for (const p of pedidos) {
      await supabase.from('ventas').update({
        seguimiento_estado: 'escalado', seguimiento_at: hoyISO(),
      }).eq('id', p.id).then(() => {}, () => {})
    }
    toast(`${pedidos.length} pedidos reclamados a ${labelTransportadora(courierId)} — mensaje copiado`, 'success')
    await cargar()
  }

  if (cargando) return (
    <div style={{ padding: 24 }}>
      <h1 className="page-title">Seguimiento</h1>
      <p className="page-subtitle">Cargando bandeja…</p>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 'clamp(16px, 4vw, 24px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Seguimiento · Contra entrega</h1>
          <p className="page-subtitle">
            Pedidos COD sin resolver. El objetivo es cerrarlos: cada uno que se rescata es una devolución menos.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Desde</span>
          <select className="form-select" style={{ width: 'auto' }} value={diasMin} onChange={e => setDiasMin(Number(e.target.value))}>
            {[3, 4, 5, 7, 10].map(d => <option key={d} value={d}>{d} días</option>)}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={cargar}><RefreshCw size={13} /> Actualizar</button>
        </div>
      </div>

      {faltanColumnas && (
        <div className="card" style={{ padding: '12px 16px', borderLeft: '3px solid var(--yellow)', fontSize: 12 }}>
          <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          Faltan columnas de seguimiento en la tabla ventas. Los cambios de estado se guardan, pero no se recuerda
          el historial de contactos. Corré la migración que te pasé.
        </div>
      )}

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div className="kpi-card" style={{ borderLeft: '3px solid var(--accent)' }}>
          <div className="kpi-label"><MessageCircle size={11} /> En la bandeja</div>
          <div className="kpi-value" style={{ fontSize: 22 }}>{resumen.total}</div>
          <div className="kpi-sub">{resumen.porContactar} listos para escribir</div>
        </div>
        <div className="kpi-card" style={{ borderLeft: '3px solid var(--yellow)' }}>
          <div className="kpi-label"><Wallet size={11} /> Plata en juego</div>
          <div className="kpi-value" style={{ fontSize: 22, color: 'var(--yellow)' }}>{formatGs(resumen.montoEnJuego)}</div>
          <div className="kpi-sub">Se cobra solo si se entrega</div>
        </div>
        <div className="kpi-card" style={{ borderLeft: resumen.paraReclamar ? '3px solid var(--red)' : undefined }}>
          <div className="kpi-label"><Send size={11} /> Para reclamar</div>
          <div className="kpi-value" style={{ fontSize: 22, color: resumen.paraReclamar ? 'var(--red)' : undefined }}>{resumen.paraReclamar}</div>
          <div className="kpi-sub">Falla del courier, no del cliente</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Clock size={11} /> Más viejo</div>
          <div className="kpi-value" style={{ fontSize: 22 }}>{resumen.masViejo} días</div>
          <div className="kpi-sub">Desde el despacho</div>
        </div>
        {efect.tasaRescate != null && (
          <div className="kpi-card" style={{ borderLeft: '3px solid var(--green)' }}>
            <div className="kpi-label"><TrendingUp size={11} /> Efectividad</div>
            <div className="kpi-value" style={{ fontSize: 22, color: 'var(--green)' }}>{Math.round(efect.tasaRescate)}%</div>
            <div className="kpi-sub">{formatGs(efect.montoRescatado)} rescatados</div>
          </div>
        )}
      </div>

      {/* Reclamo agrupado por courier */}
      {Object.keys(reclamos).length > 0 && (
        <div className="card" style={{ padding: '14px 18px', borderLeft: '3px solid var(--red)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Reclamar al courier</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Un solo mensaje con todos los códigos. Un reclamo con varias guías se atiende igual de rápido que uno con una.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(reclamos).map(([courier, pedidos]) => (
              <button key={courier} className="btn btn-primary btn-sm" onClick={() => reclamarA(courier, pedidos)}>
                <Send size={13} /> {labelTransportadora(courier)} · {pedidos.length} pedido{pedidos.length > 1 ? 's' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filtro por estado */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className={`tab ${filtroEstado === 'todos' ? 'active' : ''}`} onClick={() => setFiltroEstado('todos')}>
          Todos ({bandeja.length})
        </button>
        {Object.values(ESTADOS_SEG).filter(e => e.abierto).map(e => {
          const n = resumen.porEstado[e.id] || 0
          if (!n) return null
          return (
            <button key={e.id} className={`tab ${filtroEstado === e.id ? 'active' : ''}`} onClick={() => setFiltroEstado(e.id)}>
              {e.label} ({n})
            </button>
          )
        })}
      </div>

      {/* Lista */}
      {!visibles.length ? (
        <div className="card" style={{ textAlign: 'center', padding: 'clamp(32px, 8vw, 64px) 24px' }}>
          <CheckCircle size={40} color="var(--green)" style={{ margin: '0 auto 16px' }} />
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Nada pendiente acá</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 460, margin: '0 auto', lineHeight: 1.5 }}>
            {filtroEstado === 'todos'
              ? `Todos los pedidos COD de más de ${diasMin} días están resueltos.`
              : 'No hay pedidos en este estado. Probá con otro filtro.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visibles.map(v => {
            const plantilla = plantillaPorVenta[v.id] || v.plantillaSugerida
            const ocupado = guardando === v.id
            const urgente = v.dias >= diasMin + 3
            return (
              <div key={v.id} className="card" style={{ padding: '14px 18px', borderLeft: `3px solid ${v.cfg.color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 240, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{v.cliente_nombre || '—'}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                        background: 'var(--bg-hover)', color: v.cfg.color,
                      }}>{v.cfg.label}</span>
                      {v.n_referencia && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>#{v.n_referencia}</span>}
                      {codigoCourier(v) && (
                        <span style={{ fontSize: 10, color: 'var(--text-dim)' }} title="Código que reconoce el courier">
                          guía {codigoCourier(v)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                      {v.producto_nombre} · {v.ciudad || 'sin ciudad'} · {formatGs(v.total)} · {labelTransportadora(v.transportadora || 'pap')}
                    </div>
                    <div style={{ fontSize: 11, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ color: urgente ? 'var(--red)' : 'var(--text-dim)', fontWeight: urgente ? 700 : 400 }}>
                        {v.dias} días desde el despacho
                      </span>
                      {v.intentos > 0 && <span style={{ color: 'var(--text-muted)' }}>{v.intentos} mensaje{v.intentos > 1 ? 's' : ''} enviado{v.intentos > 1 ? 's' : ''}</span>}
                      {v.seguimiento_fecha_prometida && <span style={{ color: 'var(--purple)' }}>prometido para el {v.seguimiento_fecha_prometida}</span>}
                      {v.motivoBloqueo && <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>{v.motivoBloqueo}</span>}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <select
                        className="form-select"
                        style={{ width: 'auto', fontSize: 11, padding: '4px 8px', height: 'auto' }}
                        value={plantilla}
                        onChange={e => setPlantillaPorVenta(p => ({ ...p, [v.id]: e.target.value }))}
                        disabled={!v.puedeContactar}
                      >
                        {Object.values(PLANTILLAS).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!v.puedeContactar || ocupado}
                        onClick={() => abrirWhatsApp(v)}
                        title={v.motivoBloqueo || 'Abre WhatsApp con el mensaje listo'}
                      >
                        <MessageCircle size={13} /> {v.intentos > 0 ? 'Escribir de nuevo' : 'WhatsApp'}
                      </button>
                    </div>
                    {/* Aviso al courier: aparece solo cuando hay algo concreto
                        que reclamar (fecha pedida o cliente sin contactar). */}
                    {(v.estado === 'sin_contacto' || (v.estado === 'reprogramado' && v.seguimiento_fecha_prometida)) && (
                      <button
                        className="btn btn-sm" disabled={ocupado}
                        style={{ background: 'var(--red)', color: '#fff', border: 'none', fontWeight: 700, fontSize: 11 }}
                        onClick={() => avisarUno(v)}
                        title="Copia el texto con ref, guía, nombre y celular para mandarle al courier"
                      >
                        <Send size={12} /> Avisar al courier
                      </button>
                    )}

                    {/* Botones de respuesta SIEMPRE visibles: volver de WhatsApp
                        y registrar qué contestó tiene que ser un clic. */}
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {RESPUESTAS.map(r => (
                        <button
                          key={r.id} className="btn btn-sm" disabled={ocupado}
                          style={{
                            background: 'transparent', border: `1px solid ${r.color}`, color: r.color,
                            fontSize: 11, padding: '3px 9px',
                          }}
                          onClick={() => r.pideFecha ? setPidiendoFecha(v) : registrarRespuesta(v, r)}
                          title={ESTADOS_SEG[r.estado]?.ayuda}
                        >{r.label}</button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Fecha prometida, inline (sin modal: menos fricción) */}
                {pidiendoFecha?.id === v.id && (
                  <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--bg-hover)', borderRadius: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12 }}>¿Para qué día lo pidió?</span>
                    <input
                      type="date" className="form-input" style={{ width: 'auto', fontSize: 12 }}
                      min={hoyISO()}
                      onChange={e => {
                        if (!e.target.value) return
                        registrarRespuesta(v, RESPUESTAS.find(r => r.id === 'reprograma'), e.target.value)
                        setPidiendoFecha(null)
                      }}
                    />
                    <button className="btn btn-ghost btn-sm" onClick={() => setPidiendoFecha(null)}>Cancelar</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
