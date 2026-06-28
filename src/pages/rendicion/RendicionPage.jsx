// src/pages/rendicion/RendicionPage.jsx
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Truck, Clock, AlertTriangle, TrendingUp, CheckCircle, Wallet, CalendarClock } from 'lucide-react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts'

const formatGs = (n) => Math.round(n || 0).toLocaleString('es-PY') + ' Gs.'
const fechaCorta = (d) => d ? new Date(d).toLocaleDateString('es-PY', { day: '2-digit', month: 'short' }) : '—'

function categorizar(estado, motivo) {
  const e = (estado || '').toLowerCase(); const m = (motivo || '').toLowerCase()
  if (e.includes('entregado')) return 'entregado'
  if (e.includes('devuelto')) return 'devuelto'
  if (m.includes('rechaz') || m.includes('inubicable') || m.includes('fuera de cobertura') ||
      m.includes('fin de custodia') || m.includes('problema de direccion') || m.includes('no desea') ||
      m.includes('cancelad') || m.includes('no ingreso') || m.includes('rehus')) return 'devuelto'
  if (e.includes('devolucion') || m.includes('devolucion')) return 'devuelto'
  return 'en_proceso'
}

export default function RendicionPage() {
  const { toast } = useToast()
  const [historico, setHistorico] = useState([])
  const [cargando, setCargando] = useState(true)

  // ── Selección manual ───────────────────────────────────
  const [seleccionados, setSeleccionados] = useState(new Set())
  const [marcando, setMarcando] = useState(false)

  const cargarHistorico = async () => {
    try {
      const { data } = await supabase.from('entregas').select('*').order('fecha_entrega', { ascending: false })
      setHistorico(data || [])
      setSeleccionados(new Set())
    } catch (e) { /* tabla vacía o sin acceso */ }
  }

  useEffect(() => {
    let activo = true
    ;(async () => {
      try {
        const { data } = await supabase.from('entregas').select('*').order('fecha_entrega', { ascending: false })
        if (activo) setHistorico(data || [])
      } catch (e) { /* tabla vacía o sin acceso */ }
      if (activo) setCargando(false)
    })()
    return () => { activo = false }
  }, [])

  const stats = useMemo(() => {
    const items = historico.map(h => ({ ...h, categoria: categorizar(h.estado_pap, h.motivo) }))
    const entregados = items.filter(m => m.categoria === 'entregado')
    const proceso = items.filter(m => m.categoria === 'en_proceso')
    const rendidos = entregados.filter(m => m.rendido)
    const sinRendir = entregados.filter(m => !m.rendido)

    const yaRendido = rendidos.reduce((s, m) => s + (m.importe || 0), 0)
    const porCobrar = sinRendir.reduce((s, m) => s + (m.importe || 0), 0)
    const enTransito = proceso.reduce((s, m) => s + (m.importe || 0), 0)

    const diasRend = rendidos.map(m => m.dias_rendicion).filter(d => d != null && d >= 0)
    const diasProm = diasRend.length ? diasRend.reduce((a, b) => a + b, 0) / diasRend.length : null

    const hoy = new Date()
    const listaSinRendir = sinRendir.map(m => {
      const fEnt = m.fecha_entrega ? new Date(m.fecha_entrega) : null
      const diasSinRendir = fEnt ? Math.max(0, Math.round((hoy - fEnt) / 86400000)) : null
      const fechaEstimada = (fEnt && diasProm != null) ? new Date(fEnt.getTime() + diasProm * 86400000) : null
      return { ...m, diasSinRendir, fechaEstimada }
    }).sort((a, b) => (b.diasSinRendir ?? -1) - (a.diasSinRendir ?? -1))

    const umbralDemora = diasProm != null ? Math.max(15, diasProm * 2) : 15
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

    return {
      yaRendido, porCobrar, enTransito, diasProm, listaSinRendir, historicoRend, datosGrafico,
      nRendidos: rendidos.length, nSinRendir: sinRendir.length, nProceso: proceso.length,
      demoradas, montoDemorado, cobroEstimadoHasta, hayDatos, tasaCobrado, umbralDemora,
    }
  }, [historico])

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
        <h1 className="page-title">Rendición · Cobranza con Punto a Punto</h1>
        <p className="page-subtitle">
          PaP cobra al cliente y te deposita después. Acá controlás esa plata: {stats.nRendidos} rendidas · {stats.nSinRendir} por cobrar.
        </p>
      </div>

      {/* Alerta de demoras */}
      {stats.demoradas.length > 0 && (
        <div className="alert alert-warning">
          <AlertTriangle size={15} />
          <div>
            <div style={{ fontWeight: 600 }}>
              {stats.demoradas.length} entregas llevan más de {Math.round(stats.umbralDemora)} días sin que te depositen · {formatGs(stats.montoDemorado)}
            </div>
            <div style={{ fontSize: 12, marginTop: 2 }}>Reclamá estas a PaP — están en la lista de abajo, marcadas en rojo.</div>
          </div>
        </div>
      )}

      {/* KPIs principales */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <div className="card" style={{ borderLeft: '3px solid var(--yellow)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
            <Clock size={13} /> PAP TE DEBE
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
        <div className="card">
          <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
            <CalendarClock size={13} /> TIEMPO DE COBRO
          </div>
          <div style={{ fontSize: 'clamp(20px, 5vw, 26px)', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{stats.diasProm != null ? `${stats.diasProm.toFixed(1)} días` : '—'}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>De la entrega al depósito</div>
        </div>
      </div>

      {/* Proyección de cobro */}
      {stats.porCobrar > 0 && stats.cobroEstimadoHasta && (
        <div className="card" style={{ background: 'var(--green-dim)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <TrendingUp size={20} color="var(--green)" />
          <div style={{ fontSize: 13 }}>
            Al ritmo actual de <b>{stats.diasProm.toFixed(1)} días</b>, deberías terminar de cobrar
            los <b style={{ color: 'var(--green)' }}>{formatGs(stats.porCobrar)}</b> pendientes
            alrededor del <b>{stats.cobroEstimadoHasta.toLocaleDateString('es-PY', { day: '2-digit', month: 'long' })}</b>.
          </div>
        </div>
      )}

      {/* Histórico de rendiciones */}
      {stats.datosGrafico.length > 0 && (
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Histórico de depósitos de PaP</div>
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
                  Lo que PaP te debe rendir · {formatGs(stats.porCobrar)}
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
                  <th style={{ padding: '8px 6px' }}>Guía PaP</th>
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
