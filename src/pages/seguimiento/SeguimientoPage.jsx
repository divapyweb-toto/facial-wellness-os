// src/pages/seguimiento/SeguimientoPage.jsx
// ═══════════════════════════════════════════════════════════
// SEGUIMIENTO POST-DESPACHO
//
// Pantalla de trabajo para los pedidos COD que salieron hace días y siguen sin
// resolverse. Toda la lógica de a-quién-escribirle vive en lib/seguimiento.js;
// acá está el flujo de trabajo: abrir WhatsApp, registrar qué contestó y
// cerrar la venta cuando corresponde.
//
// El objetivo NO es mandar mensajes: es cerrar pedidos. Por eso cada fila
// termina en una decisión registrada, no en un "mensaje enviado".
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import {
  pedidosParaSeguimiento, resumenSeguimiento, linkWhatsApp, PLANTILLAS,
  DIAS_SEGUIMIENTO_DEFAULT, telefonoWhatsApp,
} from '../../lib/seguimiento'
import { MessageCircle, CheckCircle, X, Clock, AlertTriangle, Wallet, RefreshCw } from 'lucide-react'

export default function SeguimientoPage() {
  const [ventas, setVentas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [diasMin, setDiasMin] = useState(DIAS_SEGUIMIENTO_DEFAULT)
  const [plantillaPorVenta, setPlantillaPorVenta] = useState({})
  const [guardando, setGuardando] = useState(null)
  const [columnasFaltantes, setColumnasFaltantes] = useState(false)
  const toast = useToast()

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      // Solo pedidos abiertos: no tiene sentido traer meses de historial cerrado.
      const data = await fetchAll(() => supabase
        .from('ventas')
        .select('id, n_referencia, fecha, cliente_nombre, cliente_telefono, producto_nombre, ciudad, total, estado, pago_anticipado, transportadora, seguimiento_at, seguimiento_estado')
        .is('deleted_at', null)
        .in('estado', ['pendiente', 'en_tramite', 'en_camino'])
        .order('fecha', { ascending: true }))
      setVentas(data || [])
      setColumnasFaltantes(false)
    } catch (e) {
      // Si faltan las columnas de seguimiento, se avisa en pantalla en vez de
      // dejar la página en blanco sin explicación.
      if (/seguimiento_at|seguimiento_estado/.test(e?.message || '')) setColumnasFaltantes(true)
      else toast('No se pudieron cargar los pedidos: ' + (e?.message || e), 'error')
      setVentas([])
    } finally {
      setCargando(false)
    }
  }, [toast])

  useEffect(() => { cargar() }, [cargar])

  const pendientes = useMemo(
    () => pedidosParaSeguimiento(ventas, { diasMin }),
    [ventas, diasMin]
  )
  const resumen = useMemo(() => resumenSeguimiento(pendientes), [pendientes])

  // Abrir WhatsApp = dar por contactado. Se registra la fecha para que el
  // pedido salga de la lista por unos días y no se le escriba dos veces.
  const abrirWhatsApp = async (v) => {
    const plantilla = plantillaPorVenta[v.id] || v.plantillaSugerida
    const link = linkWhatsApp(v, plantilla, v.dias)
    if (!link) { toast('Ese número no es un celular válido', 'error'); return }
    window.open(link, '_blank', 'noopener')
    await marcar(v, { seguimiento_at: new Date().toISOString().slice(0, 10), seguimiento_estado: 'contactado' }, null)
  }

  // Registra el resultado. `nuevoEstadoVenta` cierra la venta cuando el cliente
  // confirma que recibió: sin esto la tasa de entrega registrada queda siempre
  // por debajo de la real, esperando un reporte que a veces nunca llega.
  const marcar = async (v, patchSeguimiento, nuevoEstadoVenta) => {
    setGuardando(v.id)
    try {
      const patch = { ...patchSeguimiento }
      if (nuevoEstadoVenta) patch.estado = nuevoEstadoVenta
      let { error } = await supabase.from('ventas').update(patch).eq('id', v.id)
      // Guardado tolerante: si faltan las columnas de seguimiento, al menos se
      // aplica el cambio de estado, que es lo que mueve la plata.
      if (error && /Could not find the '(\w+)' column/.test(error.message || '')) {
        setColumnasFaltantes(true)
        if (nuevoEstadoVenta) {
          const r = await supabase.from('ventas').update({ estado: nuevoEstadoVenta }).eq('id', v.id)
          error = r.error
        } else error = null
      }
      if (error) throw error
      if (nuevoEstadoVenta) toast(`#${v.n_referencia || v.id} marcado como ${nuevoEstadoVenta}`, 'success')
      await cargar()
    } catch (e) {
      toast('No se pudo guardar: ' + (e?.message || e), 'error')
    } finally {
      setGuardando(null)
    }
  }

  const hoyISO = () => new Date().toISOString().slice(0, 10)

  if (cargando) {
    return (
      <div style={{ padding: 24 }}>
        <h1 className="page-title">Seguimiento</h1>
        <p className="page-subtitle">Cargando pedidos…</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 'clamp(16px, 4vw, 24px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Seguimiento · Contra entrega</h1>
          <p className="page-subtitle">
            Pedidos COD que salieron hace {diasMin}+ días y siguen sin resolverse. Escribile al cliente antes de que el courier los marque como devolución.
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

      {columnasFaltantes && (
        <div className="card" style={{ padding: '12px 16px', borderLeft: '3px solid var(--yellow)', fontSize: 12 }}>
          <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          Faltan las columnas <b>seguimiento_at</b> y <b>seguimiento_estado</b> en la tabla ventas.
          Podés usar la pantalla igual (los cambios de estado se guardan), pero no se recuerda a quién ya le escribiste.
        </div>
      )}

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div className="kpi-card" style={{ borderLeft: '3px solid var(--accent)' }}>
          <div className="kpi-label"><MessageCircle size={11} /> Para contactar</div>
          <div className="kpi-value" style={{ fontSize: 22 }}>{resumen.total}</div>
          <div className="kpi-sub">{resumen.sinContactar} nuevos · {resumen.reintentos} reintentos</div>
        </div>
        <div className="kpi-card" style={{ borderLeft: '3px solid var(--yellow)' }}>
          <div className="kpi-label"><Wallet size={11} /> Plata en juego</div>
          <div className="kpi-value" style={{ fontSize: 22, color: 'var(--yellow)' }}>{formatGs(resumen.montoEnJuego)}</div>
          <div className="kpi-sub">Se cobra solo si se entrega</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label"><Clock size={11} /> Más viejo</div>
          <div className="kpi-value" style={{ fontSize: 22 }}>{resumen.masViejo} días</div>
          <div className="kpi-sub">Desde el despacho</div>
        </div>
        {resumen.sinTelefono > 0 && (
          <div className="kpi-card" style={{ borderLeft: '3px solid var(--red)' }}>
            <div className="kpi-label"><AlertTriangle size={11} /> Sin WhatsApp</div>
            <div className="kpi-value" style={{ fontSize: 22, color: 'var(--red)' }}>{resumen.sinTelefono}</div>
            <div className="kpi-sub">Número fijo o inválido</div>
          </div>
        )}
      </div>

      {/* Lista */}
      {!pendientes.length ? (
        <div className="card" style={{ textAlign: 'center', padding: 'clamp(32px, 8vw, 64px) 24px' }}>
          <CheckCircle size={40} color="var(--green)" style={{ margin: '0 auto 16px' }} />
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>No hay nada pendiente de seguimiento</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 460, margin: '0 auto', lineHeight: 1.5 }}>
            Todos los pedidos COD de más de {diasMin} días ya están resueltos o ya fueron contactados hace poco.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pendientes.map(v => {
            const plantilla = plantillaPorVenta[v.id] || v.plantillaSugerida
            const ocupado = guardando === v.id
            const urgente = v.dias >= diasMin + 3
            return (
              <div key={v.id} className="card" style={{ padding: '14px 18px', borderLeft: `3px solid ${urgente ? 'var(--red)' : 'var(--border)'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 220, flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>
                      {v.cliente_nombre || '—'}
                      {v.n_referencia && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>#{v.n_referencia}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      {v.producto_nombre} · {v.ciudad || 'sin ciudad'} · {formatGs(v.total)}
                    </div>
                    <div style={{ fontSize: 11, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ color: urgente ? 'var(--red)' : 'var(--text-dim)', fontWeight: urgente ? 700 : 400 }}>
                        {v.dias} días desde el despacho
                      </span>
                      {v.yaContactado && (
                        <span style={{ color: 'var(--accent)' }}>
                          ya contactado hace {v.diasDesdeContacto} día{v.diasDesdeContacto === 1 ? '' : 's'}
                        </span>
                      )}
                      {!v.telefonoValido && (
                        <span style={{ color: 'var(--red)' }}>sin celular válido ({v.cliente_telefono || 'vacío'})</span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <select
                        className="form-select"
                        style={{ width: 'auto', fontSize: 11, padding: '4px 8px', height: 'auto' }}
                        value={plantilla}
                        onChange={e => setPlantillaPorVenta(p => ({ ...p, [v.id]: e.target.value }))}
                        disabled={!v.telefonoValido}
                      >
                        {Object.values(PLANTILLAS).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!v.telefonoValido || ocupado}
                        onClick={() => abrirWhatsApp(v)}
                        title={v.telefonoValido ? 'Abre WhatsApp con el mensaje listo' : 'No es un celular paraguayo válido'}
                      >
                        <MessageCircle size={13} /> WhatsApp
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn-sm" disabled={ocupado}
                        style={{ background: 'var(--green)', color: '#000', border: 'none', fontWeight: 700 }}
                        onClick={() => marcar(v, { seguimiento_at: hoyISO(), seguimiento_estado: 'recibido' }, 'entregado')}
                        title="El cliente confirmó que lo recibió — se marca entregado"
                      >Ya lo recibió</button>
                      <button
                        className="btn btn-sm" disabled={ocupado}
                        style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                        onClick={() => marcar(v, { seguimiento_at: hoyISO(), seguimiento_estado: 'esperando' }, null)}
                        title="Dijo que todavía no le llegó — sigue en tránsito"
                      >Todavía espera</button>
                      <button
                        className="btn btn-sm" disabled={ocupado}
                        style={{ background: 'transparent', color: 'var(--red)', border: '1px solid var(--red)' }}
                        onClick={() => marcar(v, { seguimiento_at: hoyISO(), seguimiento_estado: 'no_quiere' }, 'devuelto')}
                        title="Ya no lo quiere — se marca devuelto"
                      >Ya no lo quiere</button>
                      <button
                        className="btn btn-sm" disabled={ocupado}
                        style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                        onClick={() => marcar(v, { seguimiento_at: hoyISO(), seguimiento_estado: 'descartado' }, null)}
                        title="Sacar de la lista sin cambiar el estado del pedido"
                      >Descartar</button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
