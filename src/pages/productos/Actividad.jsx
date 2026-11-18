// src/pages/productos/Actividad.jsx
// Pantalla Actividad (§10.6): trabajos de la cola (pi_trabajos) con estado,
// último reclamo del ejecutor (la Mac) y bloqueos accionables; mensajes a
// proveedores (pi_mensajes). Esta pantalla no envía nada.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Activity, Plus, RotateCcw, X, Laptop, ShieldAlert, MessageSquare } from 'lucide-react'
import { useToast } from '../../lib/toast'
import { listarTrabajos, crearTrabajo, actualizarTrabajo, listarMensajes, listarPoliticas, listarCandidatos, esModoDemo } from './api'
import { fmtFechaHora } from './formato'
import { Campo, Vacio, ErrorCaja, Demo, Modal } from './ui'

const ESTADOS_TRABAJO = {
  QUEUED: ['En cola', 'badge-gray'], LEASED: ['Reclamado', 'badge-blue'], RUNNING: ['Corriendo', 'badge-blue'],
  SUCCEEDED: ['Terminado', 'badge-green'], BLOCKED: ['Bloqueado: te necesita', 'badge-red'], WAITING_REPLY: ['Esperando respuesta', 'badge-purple'],
  FAILED: ['Falló', 'badge-red'], CANCELLED: ['Cancelado', 'badge-gray'],
}
const TIPOS_TRABAJO = [['investigar_py', 'Investigar en Paraguay'], ['buscar_proveedores', 'Buscar proveedores'], ['cotizar', 'Pedir cotizaciones (borradores)'], ['analizar', 'Analizar evidencia']]
const ESTADOS_MSG = { DRAFT: ['Borrador', 'badge-gray'], AUTHORIZED: ['Autorizado', 'badge-blue'], SENDING: ['Enviando', 'badge-yellow'], SENT_CONFIRMED: ['Enviado (confirmado)', 'badge-green'], SEND_UNKNOWN: ['Envío incierto: conciliar', 'badge-red'], FAILED: ['Falló', 'badge-red'] }

export default function Actividad({ onAbrir, onActivarDemo }) {
  const { toast } = useToast()
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [filtro, setFiltro] = useState('pendientes')
  const [nuevo, setNuevo] = useState(false)

  const cargar = useCallback(async () => {
    setError(null)
    try {
      const [trabajos, mensajes, politicas, candidatos] = await Promise.all([
        listarTrabajos(), listarMensajes().catch(e => (e.faltaTabla ? [] : Promise.reject(e))),
        listarPoliticas().catch(e => (e.faltaTabla ? [] : Promise.reject(e))), listarCandidatos(),
      ])
      setDatos({ trabajos, mensajes, politicas, candidatos })
    } catch (e) { setError(e) }
  }, [])
  useEffect(() => { cargar() }, [cargar])

  const nombreCand = useMemo(() => Object.fromEntries((datos?.candidatos || []).map(c => [c.id, c.nombre])), [datos])
  // Último contacto de la Mac: el trabajo más reciente que tomó un ejecutor.
  const ultimoReclamo = useMemo(() => {
    const t = (datos?.trabajos || []).filter(x => x.ejecutor).sort((a, b) => new Date(b.actualizado_en) - new Date(a.actualizado_en))[0]
    return t || null
  }, [datos])

  const lista = (datos?.trabajos || []).filter(t => filtro === 'todos' || (filtro === 'bloqueados' ? ['BLOCKED', 'FAILED'].includes(t.estado) : !['SUCCEEDED', 'CANCELLED'].includes(t.estado)))
  const nBloq = (datos?.trabajos || []).filter(t => ['BLOCKED', 'FAILED'].includes(t.estado)).length

  const cambiar = async (t, estado) => {
    const msg = estado === 'QUEUED' ? 'Vuelve a la cola: la Mac lo toma en la próxima corrida.' : '¿Cancelar este trabajo?'
    if (!confirm(msg)) return
    try {
      await actualizarTrabajo(t.id, estado === 'QUEUED' ? { estado, lease_hasta: null, ejecutor: null, bloqueo: null } : { estado })
      toast('Trabajo actualizado', 'success'); cargar()
    } catch (e) { toast(e.message, 'error') }
  }

  return (
    <div className="pi-col">
      <ErrorCaja error={error} onReintentar={cargar} />
      {error?.faltaTabla && onActivarDemo && <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onActivarDemo}>Ver con datos DEMO</button>}

      {datos && (
        <>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label"><Laptop size={11} /> Último reclamo de la Mac</div>
              <div className="kpi-value" style={{ fontSize: 18 }}>{ultimoReclamo ? fmtFechaHora(ultimoReclamo.actualizado_en) : 'nunca'}</div>
              <div className="kpi-sub">{ultimoReclamo ? `${ultimoReclamo.ejecutor} · ${ESTADOS_TRABAJO[ultimoReclamo.estado]?.[0] || ultimoReclamo.estado}` : 'Los trabajos de navegador esperan a que la Mac esté prendida y con sesión.'}</div>
            </div>
            <div className="kpi-card"><div className="kpi-label">En cola</div><div className="kpi-value">{datos.trabajos.filter(t => t.estado === 'QUEUED').length}</div></div>
            <div className="kpi-card"><div className="kpi-label">Bloqueados / fallidos</div><div className={`kpi-value ${nBloq ? 'red' : ''}`}>{nBloq}</div><div className="kpi-sub">necesitan una acción tuya</div></div>
            <div className="kpi-card"><div className="kpi-label">Esperando respuesta</div><div className="kpi-value">{datos.trabajos.filter(t => t.estado === 'WAITING_REPLY').length}</div><div className="kpi-sub">sin sondeo continuo</div></div>
          </div>

          <div className="pi-barra">
            <div className="tabs filter-scroll">
              {[['pendientes', 'Pendientes'], ['bloqueados', `Bloqueados (${nBloq})`], ['todos', 'Todos']].map(([v, l]) => <button key={v} className={`tab ${filtro === v ? 'active' : ''}`} onClick={() => setFiltro(v)}>{l}</button>)}
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setNuevo(true)}><Plus size={13} /> Nuevo trabajo</button>
          </div>

          {lista.length === 0 ? <Vacio icono={Activity} titulo="Nada en esta vista" desc="Creá un trabajo y la Mac lo reclama con la CLI (scripts/pi-cli.mjs) cuando Enrique abre Claude Code." /> : (
            <div className="table-wrapper">
              <table className="tabla-responsive">
                <thead><tr><th>Estado</th><th>Tipo</th><th>Candidato</th><th>Ejecutor · lease</th><th>Intento</th><th>Bloqueo / resultado</th><th>Actualizado</th><th></th></tr></thead>
                <tbody>
                  {lista.map(t => {
                    const [lab, badge] = ESTADOS_TRABAJO[t.estado] || [t.estado, 'badge-gray']
                    const leaseVencido = t.lease_hasta && new Date(t.lease_hasta) < new Date() && ['LEASED', 'RUNNING'].includes(t.estado)
                    return (
                      <tr key={t.id} className={t.estado === 'BLOCKED' ? 'pi-vencida' : ''}>
                        <td data-label="Estado"><span className={`badge ${badge}`}>{lab}</span>{esModoDemo() && <> <Demo /></>}</td>
                        <td data-label="Tipo">{TIPOS_TRABAJO.find(x => x[0] === t.tipo)?.[1] || t.tipo}<div className="pi-sub">{t.carga?.consulta || ''}</div></td>
                        <td data-label="Candidato">{t.candidato_id ? <button className="pi-link-btn" onClick={() => onAbrir(t.candidato_id)}>{nombreCand[t.candidato_id] || 'abrir'}</button> : '—'}</td>
                        <td data-label="Ejecutor">{t.ejecutor || '—'}<div className="pi-sub">{t.lease_hasta ? `lease hasta ${fmtFechaHora(t.lease_hasta)}` : ''}{leaseVencido ? ' · vencido: se puede reclamar de nuevo' : ''}</div></td>
                        <td data-label="Intento" className="pi-num">{t.intento ?? 0}</td>
                        <td data-label="Bloqueo" style={{ whiteSpace: 'normal', maxWidth: 320 }}>
                          {t.bloqueo ? <span className="pi-rojo">{t.bloqueo}</span> : t.resultado ? <span className="pi-sub">{JSON.stringify(t.resultado).slice(0, 140)}</span> : '—'}
                          {t.checkpoint && <div className="pi-sub">checkpoint: {JSON.stringify(t.checkpoint).slice(0, 100)}</div>}
                        </td>
                        <td data-label="Actualizado">{fmtFechaHora(t.actualizado_en)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {['BLOCKED', 'FAILED', 'CANCELLED'].includes(t.estado) && <button className="btn btn-ghost btn-sm" title="Volver a la cola" onClick={() => cambiar(t, 'QUEUED')}><RotateCcw size={12} /> Reencolar</button>}
                          {!['SUCCEEDED', 'CANCELLED'].includes(t.estado) && <button className="btn btn-ghost btn-sm btn-icon" title="Cancelar" onClick={() => cambiar(t, 'CANCELLED')}><X size={12} /></button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="pi-sub">Si una página pide CAPTCHA, login o verificación, el trabajo pasa a Bloqueado con el motivo: nunca se intenta saltar. Lo resolvés vos y lo reencolás.</p>

          <Mensajes mensajes={datos.mensajes} politicas={datos.politicas} nombreCand={nombreCand} />
        </>
      )}
      {!datos && !error && <div className="skeleton" style={{ height: 200, borderRadius: 'var(--radius)' }} />}

      {nuevo && <NuevoTrabajo candidatos={datos?.candidatos || []} onCerrar={() => setNuevo(false)} onListo={() => { setNuevo(false); cargar() }} toast={toast} />}
    </div>
  )
}

function Mensajes({ mensajes, politicas, nombreCand }) {
  const polPorId = Object.fromEntries(politicas.map(p => [p.id, p]))
  const ahora = new Date()
  return (
    <div className="card">
      <div className="section-label"><MessageSquare size={12} /> Mensajes a proveedores</div>
      <div className="alert alert-warning" style={{ marginTop: 8 }}>
        <ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>No se envía nada sin una política autorizada: un mensaje sale solo si su campaña está vigente, permite enviar y está dentro del alcance. Comprar, pagar, muestras o exclusividad necesitan tu confirmación aparte.</span>
      </div>
      {mensajes.length === 0 ? <p className="pi-desc" style={{ marginTop: 8 }}>Sin mensajes.</p> : (
        <div className="m-card-list" style={{ marginTop: 8 }}>
          {mensajes.map(m => {
            const p = polPorId[m.politica_id]
            const vigente = p?.permite_envio && (!p.vigente_hasta || new Date(p.vigente_hasta) > ahora)
            const [lab, badge] = ESTADOS_MSG[m.estado] || [m.estado, 'badge-gray']
            return (
              <div key={m.id} className="m-card pi-msg">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`badge ${badge}`}>{lab}</span>
                  <span className={`badge ${vigente ? 'badge-green' : 'badge-gray'}`}>{vigente ? 'campaña vigente' : 'sin campaña vigente: solo borrador'}</span>
                  <span className="pi-sub">{p?.candidato_id ? nombreCand[p.candidato_id] || '' : ''} · {fmtFechaHora(m.actualizado_en || m.creado_en)}</span>
                  {esModoDemo() && <Demo />}
                </div>
                <div className="pi-msg-cuerpo">
                  <div><span className="data-label">Original ({m.idioma || '—'})</span><p>{m.original || '—'}</p></div>
                  <div><span className="data-label">Traducción</span><p>{m.traduccion || '—'}</p></div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Carga estricta: solo campos conocidos (nada de comandos ni código).
function NuevoTrabajo({ candidatos, onCerrar, onListo, toast }) {
  const [f, setF] = useState({ tipo: 'investigar_py', candidato_id: candidatos[0]?.id || '', consulta: '', zonas: 'CDE, GRAN_ASUNCION, INTERIOR', notas: '' })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  const guardar = async () => {
    if (!f.consulta.trim()) { toast('Escribí qué buscar', 'error'); return }
    const carga = { consulta: f.consulta.trim().slice(0, 300), notas: f.notas.trim().slice(0, 500) || null }
    if (f.tipo === 'investigar_py') carga.zonas = f.zonas.split(',').map(z => z.trim().toUpperCase()).filter(z => ['CDE', 'GRAN_ASUNCION', 'INTERIOR', 'NACIONAL'].includes(z))
    try { await crearTrabajo({ tipo: f.tipo, candidato_id: f.candidato_id || null, carga }); toast('Trabajo en cola', 'success'); onListo() } catch (e) { toast(e.message, 'error') }
  }
  return (
    <Modal titulo="Nuevo trabajo para la Mac" onCerrar={onCerrar} pie={<><button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button><button className="btn btn-primary" onClick={guardar}>Encolar</button></>}>
      <div className="form-grid">
        <Campo label="Tipo"><select className="form-select" value={f.tipo} onChange={set('tipo')}>{TIPOS_TRABAJO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Campo>
        <Campo label="Candidato"><select className="form-select" value={f.candidato_id} onChange={set('candidato_id')}><option value="">(ninguno)</option>{candidatos.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo>
        <Campo label="Qué buscar" span={2} hint="Nombre, sinónimos, modelo. Texto plano: no se aceptan instrucciones ni comandos."><input className="form-input" value={f.consulta} onChange={set('consulta')} /></Campo>
        {f.tipo === 'investigar_py' && <Campo label="Zonas" span={2}><input className="form-input" value={f.zonas} onChange={set('zonas')} /></Campo>}
        <Campo label="Notas" span={2}><textarea className="form-textarea" value={f.notas} onChange={set('notas')} /></Campo>
      </div>
      <p className="pi-sub" style={{ marginTop: 8 }}>"Pedir cotizaciones" prepara borradores; se envían solo dentro de una campaña autorizada.</p>
    </Modal>
  )
}
