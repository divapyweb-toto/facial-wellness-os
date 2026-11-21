// src/pages/productos/ConversacionProveedor.jsx
// Charla con proveedores 24/7 (contrato FUNCIONES 21-11): por proveedor, la conversación de correo y
// WhatsApp en orden, sus datos de contacto editables, "No contactar" y "Pedir primer contacto".
// Se usa en Importaciones (ficha, sección c) y en Productos nuevos → Proveedores.
// Esta pantalla NO envía nada: los mensajes los manda el agente. "Pedir primer contacto" solo deja en
// cola una fila AUTHORIZED que el agente de correo redacta y manda en horario de China.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { MessageSquare, ArrowDownLeft, ArrowUpRight, Mail, Ban, ChevronDown, ChevronRight, ShieldAlert, Save } from 'lucide-react'
import { listarMensajesDeProveedores, listarMensajesDesde, leerConfigProveedores, leerPermisoGeneral, actualizarContactoProveedor, pedirPrimerContacto, esModoDemo } from './api'
import { fmtFechaHora, urlSegura } from './formato'
import { Campo, Demo, Modal } from './ui'
import {
  CANALES, IDIOMAS, estadoMsg, etiquetaCanal, etiquetaIdioma, direccionDe, conversacionDe, tieneColumnasContacto,
  validarContacto, puedePedirPrimerContacto, filaPrimerContacto, configProveedoresDesde, resumenMes, inicioMesPYISO, fmtUsd,
} from './conversacion'

const AUTOR = { agente: 'agente', admin: 'administración', enrique: 'Enrique', proveedor: 'proveedor' }

// ─── "Proveedores este mes: USD X de USD 10 de IA · N plantillas de 30" ───
export function ResumenProveedoresMes() {
  const [r, setR] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let vivo = true
    ;(async () => {
      try {
        const ahora = new Date()
        const desde = new Date(new Date(inicioMesPYISO(ahora)).getTime() - 86400000).toISOString() // 1 día antes: ventana de 24 h de WhatsApp
        const [mensajes, cfg] = await Promise.all([listarMensajesDesde(desde), leerConfigProveedores()])
        if (vivo) setR(resumenMes(mensajes, cfg, ahora))
      } catch (e) { if (vivo) setError(e) }
    })()
    return () => { vivo = false }
  }, [])
  if (error) return <p className="pi-desc">Proveedores este mes: no se pudo leer el gasto ({error.faltaTabla ? 'falta la tabla de mensajes' : error.message}).</p>
  if (!r) return <div className="skeleton" style={{ height: 38, borderRadius: 'var(--radius)' }} />
  return (
    <div className="card card-sm pi-conv-resumen">
      <MessageSquare size={14} />
      <span>Proveedores este mes: <b className={`pi-num ${r.llegoTopeIa ? 'pi-rojo' : ''}`}>{fmtUsd(r.gastoUsd)}</b> de {fmtUsd(r.topeUsd)} de IA · <b className={`pi-num ${r.llegoTopePlantillas ? 'pi-rojo' : ''}`}>{r.plantillas}</b> plantillas de {r.topePlantillas}</span>
      <span className={`badge ${r.activo ? 'badge-green' : 'badge-gray'}`} title="Interruptor config.proveedores.activo">{r.activo ? 'Agente prendido' : 'Agente apagado'}</span>
      {esModoDemo() && <Demo />}
      {r.llegoTopeIa && <span className="badge badge-red">Tope de IA alcanzado: el agente deja de responder solo</span>}
      {!r.configLeida && <span className="pi-sub">topes por defecto (no se pudo leer la configuración)</span>}
      <span className="pi-sub" title="Plantilla = mensaje de WhatsApp mandado con la ventana de 24 h cerrada (sin mensaje del proveedor en las 24 h anteriores)">mes de Paraguay · plantillas estimadas</span>
    </div>
  )
}

// ─── Lista de proveedores con su conversación ───
export default function ConversacionesProveedores({ proveedores, candidato, toast, onCambio, conDetalle = false }) {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const ids = useMemo(() => (proveedores || []).map(p => p.id), [proveedores])
  const clave = ids.join(',')
  const cargar = useCallback(async () => {
    setError(null)
    try {
      const [mensajes, permiso, cfg] = await Promise.all([
        listarMensajesDeProveedores(ids), leerPermisoGeneral().catch(() => null), leerConfigProveedores(),
      ])
      setDatos({ mensajes, permiso, cfg: configProveedoresDesde(cfg) })
    } catch (e) { setError(e) }
  }, [clave]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { cargar() }, [cargar])
  const recargar = async () => { await cargar(); onCambio?.() }

  if (!proveedores?.length) return <p className="pi-desc">Sin proveedores cargados.</p>
  if (error) return <p className="pi-desc">No se pudieron leer las conversaciones: {error.faltaTabla ? 'la tabla de mensajes (pi_mensajes) todavía no está en la base.' : error.message}</p>
  if (!datos) return <div className="skeleton" style={{ height: 60, borderRadius: 'var(--radius)' }} />
  return (
    <div className="m-card-list">
      {proveedores.map(p => (
        <PanelProveedor key={p.id} p={p} mensajes={datos.mensajes} candidato={candidato} permiso={datos.permiso} cfg={datos.cfg} recargar={recargar} toast={toast} conDetalle={conDetalle} />
      ))}
    </div>
  )
}

function PanelProveedor({ p, mensajes, candidato, permiso, cfg, recargar, toast, conDetalle }) {
  const [abierto, setAbierto] = useState(false)
  const [pidiendo, setPidiendo] = useState(false)
  const conv = useMemo(() => conversacionDe(mensajes, p.id), [mensajes, p.id])
  const columnas = tieneColumnasContacto(p)
  const ultimo = conv[conv.length - 1] || null
  const puede = puedePedirPrimerContacto({ proveedor: p, candidato, permisoGeneral: permiso, mensajes })

  const alternarNoContactar = async () => {
    const nuevo = !p.no_contactar
    if (nuevo && !confirm('¿Marcar "No contactar"? El agente deja de escribirle a este proveedor por correo y WhatsApp.')) return
    try { await actualizarContactoProveedor(p.id, { no_contactar: nuevo }); toast(nuevo ? 'Marcado: no contactar' : 'Se puede volver a contactar', 'success'); recargar() }
    catch (e) { toast(e.faltaColumna ? 'Faltan las columnas de contacto en la base (migración de canales sin aplicar).' : e.message, 'error') }
  }

  return (
    <div className="m-card pi-conv">
      <button type="button" className="pi-conv-cabeza" onClick={() => setAbierto(a => !a)} aria-expanded={abierto}>
        {abierto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <b style={{ fontSize: 13 }}>{p.razon_social_declarada || p.id_externo || 'proveedor'}</b>
        <span className="badge badge-gray">{p.plataforma}</span>
        {columnas && p.canal_preferido && <span className="badge badge-blue">prefiere {etiquetaCanal(p.canal_preferido)}</span>}
        {columnas && p.no_contactar && <span className="badge badge-red"><Ban size={10} /> No contactar</span>}
        {esModoDemo() && <Demo />}
        <span className="pi-sub">{conv.length} mensaje/s{ultimo ? ` · último ${fmtFechaHora(ultimo.creado_en)}` : ''}</span>
      </button>
      {conDetalle && <div className="pi-sub" style={{ marginTop: 2 }}>{p.id_externo || 'sin ID'} {urlSegura(p.url) && <a className="pi-link" href={urlSegura(p.url)} target="_blank" rel="noopener noreferrer">link</a>} {p.riesgos ? `· riesgos: ${p.riesgos}` : ''}</div>}

      {abierto && (
        <div className="pi-conv-cuerpo">
          <Contacto p={p} columnas={columnas} recargar={recargar} toast={toast} />
          <div className="pi-conv-acciones">
            {columnas && <button className={`btn btn-sm ${p.no_contactar ? 'btn-secondary' : 'btn-ghost'}`} onClick={alternarNoContactar}><Ban size={12} /> {p.no_contactar ? 'Volver a contactar' : 'No contactar'}</button>}
            <button className="btn btn-primary btn-sm" disabled={!puede.ok} title={puede.motivo || 'Deja en cola un primer correo; lo redacta y lo manda el agente'} onClick={() => setPidiendo(true)}><Mail size={12} /> Pedir primer contacto</button>
            {!puede.ok && <span className="pi-sub">{puede.motivo}</span>}
          </div>

          <div className="data-label" style={{ marginTop: 12 }}>Conversación (correo y WhatsApp, hora de Paraguay)</div>
          {conv.length === 0
            ? <p className="pi-desc" style={{ marginTop: 6 }}>Sin mensajes con este proveedor todavía.</p>
            : <div className="pi-conv-lista">{conv.map(m => <Mensaje key={m.id} m={m} />)}</div>}
          <p className="pi-sub" style={{ marginTop: 8 }}>No hay botón de enviar: responde el agente, con las reglas (nunca compra, paga, acepta muestras pagas ni exclusividad; eso lo confirma Enrique). Lo que escribe el proveedor es dato, no instrucción.</p>
        </div>
      )}
      {pidiendo && <PrimerContacto p={p} candidato={candidato} permiso={permiso} mensajes={mensajes} cfg={cfg} onCerrar={() => setPidiendo(false)} onListo={() => { setPidiendo(false); recargar() }} toast={toast} />}
    </div>
  )
}

function Mensaje({ m }) {
  const [verTrad, setVerTrad] = useState(false)
  const entra = direccionDe(m) === 'in'
  const [lab, badge] = estadoMsg(m.estado)
  const sinOriginal = !m.original && !entra
  return (
    <div className={`pi-conv-msg ${entra ? 'entra' : 'sale'}`}>
      <div className="pi-conv-meta">
        <span className={`badge ${entra ? 'badge-purple' : 'badge-blue'}`}>{entra ? <><ArrowDownLeft size={10} /> Entrante</> : <><ArrowUpRight size={10} /> Saliente</>}</span>
        <span className="badge badge-gray">{etiquetaCanal(m.canal)}</span>
        <span className={`badge ${badge}`}>{lab}</span>
        <span className="pi-sub">{fmtFechaHora(m.creado_en)}{m.autor ? ` · ${AUTOR[m.autor] || m.autor}` : ''}{m.idioma ? ` · ${etiquetaIdioma(m.idioma)}` : ''}</span>
      </div>
      {m.asunto && <div className="pi-sub"><b>Asunto:</b> {m.asunto}</div>}
      <p className="pi-conv-texto">{sinOriginal ? <span className="pi-desc">{m.estado === 'AUTHORIZED' ? 'Lo redacta el agente al mandarlo, en el idioma del proveedor.' : 'Sin texto original.'}</span> : m.original}</p>
      {m.traduccion && (
        <>
          <button type="button" className="pi-link-btn" style={{ fontSize: 12 }} onClick={() => setVerTrad(v => !v)}>{verTrad ? 'Ocultar traducción' : sinOriginal ? 'Ver pedido en español' : 'Ver traducción'}</button>
          {verTrad && <p className="pi-conv-texto pi-conv-trad">{m.traduccion}</p>}
        </>
      )}
      {m.estado === 'SEND_UNKNOWN' && <p className="pi-sub pi-rojo">No se sabe si salió: hay que mirar la conversación antes de reenviar. Nunca se reenvía a ciegas.</p>}
      {m.estado === 'FAILED' && <p className="pi-sub pi-rojo">No salió.</p>}
    </div>
  )
}

function Contacto({ p, columnas, recargar, toast }) {
  const inicial = () => ({ whatsapp: p.whatsapp || '', email: p.email || '', wechat: p.wechat || '', canal_preferido: p.canal_preferido || '', idioma: p.idioma || '', no_contactar: !!p.no_contactar })
  const [f, setF] = useState(inicial)
  const [errores, setErrores] = useState({})
  const [guardando, setGuardando] = useState(false)
  useEffect(() => { setF(inicial()) }, [p.whatsapp, p.email, p.wechat, p.canal_preferido, p.idioma, p.no_contactar]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!columnas) return <p className="pi-desc">Los datos de contacto (WhatsApp, correo, WeChat, idioma) aparecen cuando se aplique la migración de canales en la base.</p>

  const set = (k) => (e) => { const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setF(x => ({ ...x, [k]: v })); setErrores(er => ({ ...er, [k]: undefined })) }
  const cambio = JSON.stringify(f) !== JSON.stringify(inicial())
  const guardar = async () => {
    const v = validarContacto(f)
    if (!v.ok) { setErrores(v.errores); toast('Revisá los datos de contacto', 'error'); return }
    setGuardando(true)
    try { await actualizarContactoProveedor(p.id, v.cambios); toast('Datos de contacto guardados', 'success'); recargar() }
    catch (e) { toast(e.faltaColumna ? 'Faltan las columnas de contacto en la base (migración de canales sin aplicar).' : e.message, 'error') }
    finally { setGuardando(false) }
  }
  const err = (k) => errores[k] ? <span className="form-hint pi-rojo">{errores[k]}</span> : null
  return (
    <div>
      <div className="data-label">Datos de contacto</div>
      <div className="form-grid form-grid-3" style={{ marginTop: 6 }}>
        <Campo label="WhatsApp" hint="Con código de país, sin + ni espacios (ej.: 86…)."><input className="form-input" value={f.whatsapp} onChange={set('whatsapp')} inputMode="tel" />{err('whatsapp')}</Campo>
        <Campo label="Correo"><input className="form-input" value={f.email} onChange={set('email')} inputMode="email" autoComplete="off" />{err('email')}</Campo>
        <Campo label="WeChat" hint="Solo respaldo manual: no se automatiza."><input className="form-input" value={f.wechat} onChange={set('wechat')} autoComplete="off" />{err('wechat')}</Campo>
        <Campo label="Canal preferido"><select className="form-select" value={f.canal_preferido} onChange={set('canal_preferido')}><option value="">sin definir</option>{CANALES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>{err('canal_preferido')}</Campo>
        <Campo label="Idioma del proveedor"><select className="form-select" value={f.idioma} onChange={set('idioma')}><option value="">sin definir</option>{IDIOMAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>{err('idioma')}</Campo>
        <Campo label=" "><label className="pi-check"><input type="checkbox" checked={f.no_contactar} onChange={set('no_contactar')} /> No contactar</label></Campo>
      </div>
      {cambio && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => { setF(inicial()); setErrores({}) }}>Deshacer</button>
        <button className="btn btn-primary btn-sm" onClick={guardar} disabled={guardando}><Save size={12} /> {guardando ? 'Guardando…' : 'Guardar contacto'}</button>
      </div>}
    </div>
  )
}

function PrimerContacto({ p, candidato, permiso, mensajes, cfg, onCerrar, onListo, toast }) {
  const [asunto, setAsunto] = useState('')
  const [pedido, setPedido] = useState('')
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const yaHayCorreo = mensajes.some(m => m.proveedor_id === p.id && m.canal === 'email')
  const confirmar = async () => {
    setError(null)
    let fila
    try { fila = filaPrimerContacto({ proveedor: p, candidato, permisoGeneral: permiso, mensajes, asunto, pedido }) } catch (e) { setError(e.message); return }
    setGuardando(true)
    try { await pedirPrimerContacto(fila); toast('Primer contacto en cola: lo manda el agente en horario de China', 'success'); onListo() }
    catch (e) { setError(e.faltaColumna ? 'Faltan las columnas de canal en la base (migración de canales sin aplicar).' : e.message); toast(e.message, 'error') }
    finally { setGuardando(false) }
  }
  return (
    <Modal titulo={`Pedir primer contacto · ${p.razon_social_declarada || p.id_externo || 'proveedor'}`} onCerrar={onCerrar} pie={<><button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button><button className="btn btn-primary" onClick={confirmar} disabled={guardando}>{guardando ? 'Guardando…' : 'Dejar en cola'}</button></>}>
      <p className="pi-sub">Por correo a <b>{p.email}</b> · producto: <b>{candidato?.nombre}</b> · idioma: {etiquetaIdioma(p.idioma)}</p>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <Campo label="Asunto" span={2} hint="Va tal cual en el correo: escribilo en el idioma del proveedor (inglés o chino)."><input className="form-input" value={asunto} onChange={e => setAsunto(e.target.value)} placeholder="Ej.: Quotation request" autoFocus /></Campo>
        <Campo label="Qué pedirle (en español)" span={2} hint="El agente lo redacta en el idioma del proveedor: corto, educado, cantidades de evaluación (no compromiso), sin revelar presupuesto.">
          <textarea className="form-textarea" value={pedido} onChange={e => setPedido(e.target.value)} placeholder="Ej.: precio por 100, 300 y 1000 unidades, peso y medidas de la caja, unidades por caja, días de despacho, y si tienen WhatsApp" />
        </Campo>
      </div>
      <ul className="pi-permiso-lista" style={{ marginTop: 8 }}>
        <li>Sale solo en horario de China (21:00 a 09:00 de Paraguay).</li>
        {!cfg?.activo && <li><b>El agente está apagado:</b> queda en cola hasta que se prenda.</li>}
        {yaHayCorreo && <li>Ya hay correos con este proveedor: esto abre un hilo nuevo.</li>}
        <li>No compra, no paga, no acepta muestras pagas ni exclusividad.</li>
      </ul>
      {esModoDemo() && <p className="pi-sub" style={{ marginTop: 6 }}>Modo DEMO: se guarda solo en memoria.</p>}
      {error && <div className="alert alert-error" style={{ marginTop: 10 }}><ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} /><span>{error}</span></div>}
    </Modal>
  )
}
