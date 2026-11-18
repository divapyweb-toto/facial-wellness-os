// src/pages/productos/PermisoGeneral.jsx
// Permiso general para negociar (pedido de Enrique, FUNCIONES 18-11): UNA sola
// autorización que vale para todos los productos y no vence. Se muestra arriba en
// Importaciones y en Productos nuevos → Proveedores. Autorizar solo funciona con
// la sesión de Enrique (lo frena la base); revocar, cualquiera.
import { useState, useEffect, useCallback } from 'react'
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import { useToast } from '../../lib/toast'
import { leerPermisoGeneral, autorizarPolitica, apagarPolitica, esModoDemo } from './api'
import { politicaVigente, textoNegocia, topesPermisoGeneral, NUNCA_CUBRE } from './derivados'
import { fmtFechaHora } from './formato'
import { Campo, Demo, Modal } from './ui'

export default function PermisoGeneral({ onCambio }) {
  const { toast } = useToast()
  const [p, setP] = useState(undefined) // undefined = cargando · null = no existe todavía
  const [error, setError] = useState(null)
  const [autorizando, setAutorizando] = useState(null) // { texto, error }
  const [guardando, setGuardando] = useState(false)

  const cargar = useCallback(async () => {
    setError(null)
    try { setP(await leerPermisoGeneral()) } catch (e) { setError(e); setP(null) }
  }, [])
  useEffect(() => { cargar() }, [cargar])

  const autorizar = async () => {
    const texto = (autorizando?.texto || '').trim()
    if (texto.length < 3) { setAutorizando(a => ({ ...a, error: 'Escribí tu autorización con tus palabras (queda guardada textual).' })); return }
    setGuardando(true)
    try {
      await autorizarPolitica(p, texto)
      toast('Permiso general autorizado', 'success'); setAutorizando(null); await cargar(); onCambio?.()
    } catch (e) {
      // La base rechaza si quien está logueado no es Enrique (pi_config.usuario_autorizado).
      setAutorizando(a => ({ ...a, error: e.message })); toast(e.message, 'error')
    } finally { setGuardando(false) }
  }
  const revocar = async () => {
    if (!confirm('¿Revocar el permiso general? Los mensajes que no salieron vuelven a borrador hasta que lo autorices de nuevo.')) return
    try { await apagarPolitica(p.id); toast('Permiso general revocado', 'success'); await cargar(); onCambio?.() }
    catch (e) { toast(e.message, 'error') }
  }

  if (p === undefined && !error) return <div className="skeleton" style={{ height: 90, borderRadius: 'var(--radius)' }} />
  if (!p) return (
    <div className="card card-sm">
      <div className="section-label"><ShieldAlert size={12} /> Permiso general para negociar</div>
      <p className="pi-desc" style={{ marginTop: 6 }}>{error ? `No se pudo leer el permiso general: ${error.message}` : 'El permiso general todavía no está en la base (falta aplicar su migración). Mientras tanto vale solo el permiso por producto.'}</p>
    </div>
  )

  const vigente = politicaVigente(p)
  const tope = topesPermisoGeneral(p.alcance)
  return (
    <div className="card card-sm">
      <div className="pi-barra">
        <div className="section-label">{vigente ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />} Permiso general para negociar · todos los productos {esModoDemo() && <Demo />}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`badge ${vigente ? 'badge-green' : p.permite_envio ? 'badge-yellow' : 'badge-red'}`}>{vigente ? 'Autorizado' : p.permite_envio ? 'Vencido' : 'Sin autorizar'}</span>
          {!p.permite_envio && <button className="btn btn-primary btn-sm" onClick={() => setAutorizando({ texto: '', error: null })}>Autorizar</button>}
          {p.permite_envio && <button className="btn btn-ghost btn-sm" onClick={revocar}>Revocar</button>}
        </div>
      </div>
      {vigente
        ? <p className="pi-sub" style={{ marginTop: 6 }}>Autorizado{p.autorizada_en ? ` desde ${fmtFechaHora(p.autorizada_en)}` : ''}{p.autorizada_por ? ` por ${p.autorizada_por}` : ''}. No vence: sigue hasta que lo revoques.</p>
        : <p className="pi-sub" style={{ marginTop: 6 }}>Sin autorizar: Claude prepara los mensajes pero quedan en borrador (salvo un permiso por producto vigente).</p>}
      {p.autorizada_texto && (
        <div className="copy-block" style={{ marginTop: 8 }}>
          <span className="data-label">Lo que escribió Enrique (textual)</span><br />"{p.autorizada_texto}"
        </div>
      )}
      <ul className="pi-permiso-lista">
        <li><b>Negocia sin preguntarte:</b> {textoNegocia(p.alcance)}.</li>
        <li><b>Topes por producto:</b> hasta {tope.proveedores} proveedores y {tope.rondas} rondas de negociación; seguimiento a los {tope.seguimientoDias} días hábiles si no contestan.</li>
        <li><b>Nunca cubre (siempre te pregunta aparte):</b> {NUNCA_CUBRE.join(', ')}.</li>
      </ul>

      {autorizando && (
        <Modal titulo="Autorizar el permiso general para negociar" onCerrar={() => setAutorizando(null)} pie={<><button className="btn btn-ghost" onClick={() => setAutorizando(null)}>Cancelar</button><button className="btn btn-primary" onClick={autorizar} disabled={guardando}>{guardando ? 'Guardando…' : 'Autorizar'}</button></>}>
          <Campo label="Tu autorización (textual)" hint="Queda guardada tal cual. Solo vale con tu sesión: la base no acepta la de nadie más.">
            <textarea className="form-textarea" value={autorizando.texto} onChange={e => setAutorizando(a => ({ ...a, texto: e.target.value, error: null }))} placeholder="Ej.: autorizo a negociar precio, color, calidad y empaque con todos los proveedores" autoFocus />
          </Campo>
          <p className="pi-sub" style={{ marginTop: 8 }}>Vale para todos los productos y no vence. Cubre {textoNegocia(p.alcance)}, con tope de {tope.proveedores} proveedores y {tope.rondas} rondas por producto. Nunca: {NUNCA_CUBRE.join(', ')}.</p>
          {esModoDemo() && <p className="pi-sub" style={{ marginTop: 6 }}>Modo DEMO: se guarda solo en memoria, no en la base.</p>}
          {autorizando.error && <div className="alert alert-error" style={{ marginTop: 10 }}><ShieldAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} /><span>{autorizando.error}</span></div>}
        </Modal>
      )}
    </div>
  )
}
