// src/pages/sistema/SistemaPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { Trash2, RotateCcw, AlertCircle, ClipboardList, Shield, CheckCircle, X } from 'lucide-react'

const fmtFecha = (ts) => {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString('es-PY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// Config de las tablas con papelera
const TABLAS_PAPELERA = [
  { key: 'ventas', label: 'Ventas', getLabel: (r) => `#${r.n_referencia || '—'} · ${r.producto_nombre || ''}`, getSub: (r) => `${formatGs(r.total || 0)} · ${r.ciudad || ''}` },
  { key: 'gastos', label: 'Gastos', getLabel: (r) => `${r.categoria || ''} · ${r.concepto || ''}`, getSub: (r) => formatGs(r.monto || 0) },
  { key: 'campanas_ads', label: 'Campañas', getLabel: (r) => r.nombre || '—', getSub: (r) => formatGs(r.gasto || 0) },
]

export default function SistemaPage() {
  const { toast } = useToast()
  const [tab, setTab] = useState('papelera')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Sistema</h1>
          <p className="page-subtitle">Papelera, registro de errores y auditoría</p>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'papelera' ? 'active' : ''}`} onClick={() => setTab('papelera')}>
          <Trash2 size={13} /> Papelera
        </button>
        <button className={`tab ${tab === 'errores' ? 'active' : ''}`} onClick={() => setTab('errores')}>
          <AlertCircle size={13} /> Errores
        </button>
        <button className={`tab ${tab === 'auditoria' ? 'active' : ''}`} onClick={() => setTab('auditoria')}>
          <ClipboardList size={13} /> Auditoría
        </button>
      </div>

      {tab === 'papelera' && <Papelera toast={toast} />}
      {tab === 'errores' && <Errores toast={toast} />}
      {tab === 'auditoria' && <Auditoria />}
    </div>
  )
}

// ─── PAPELERA ─────────────────────────────────────────────
function Papelera({ toast }) {
  const [tablaActiva, setTablaActiva] = useState('ventas')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  const cfg = TABLAS_PAPELERA.find(t => t.key === tablaActiva)

  const cargar = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from(tablaActiva).select('*')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(100)
    setItems(data || [])
    setLoading(false)
  }, [tablaActiva])

  useEffect(() => { cargar() }, [cargar])

  const restaurar = async (id) => {
    const { error } = await supabase.from(tablaActiva).update({ deleted_at: null }).eq('id', id)
    if (error) { toast('Error al restaurar', 'error'); return }
    toast('Restaurado correctamente', 'success')
    cargar()
  }

  const borrarDefinitivo = async (id) => {
    if (!confirm('¿Borrar DEFINITIVAMENTE? Esto no se puede deshacer.')) return
    const { error } = await supabase.from(tablaActiva).delete().eq('id', id)
    if (error) { toast('Error al borrar', 'error'); return }
    toast('Borrado definitivo', 'info')
    cargar()
  }

  const vaciarPapelera = async () => {
    if (!items.length) return
    if (!confirm(`¿Vaciar la papelera de ${cfg.label}? Se borrarán ${items.length} registro(s) DEFINITIVAMENTE.`)) return
    const ids = items.map(i => i.id)
    const { error } = await supabase.from(tablaActiva).delete().in('id', ids)
    if (error) { toast('Error al vaciar', 'error'); return }
    toast('Papelera vaciada', 'info')
    cargar()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="alert" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Shield size={14} color="var(--accent)" />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Lo borrado se guarda acá y se puede recuperar. Restaurar una venta vuelve a descontar su stock.
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div className="tabs filter-scroll">
          {TABLAS_PAPELERA.map(t => (
            <button key={t.key} className={`tab ${tablaActiva === t.key ? 'active' : ''}`} onClick={() => setTablaActiva(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {items.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={vaciarPapelera} style={{ color: 'var(--red)' }}>
            <Trash2 size={12} /> Vaciar papelera
          </button>
        )}
      </div>

      {loading ? (
        <div className="m-card-list">{[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 60, borderRadius: 10 }} />)}</div>
      ) : items.length === 0 ? (
        <div className="empty-state" style={{ padding: 40 }}>
          <div className="empty-state-icon"><CheckCircle size={22} /></div>
          <p className="empty-state-title">Papelera vacía</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No hay {cfg.label.toLowerCase()} borrados</p>
        </div>
      ) : (
        <div className="m-card-list">
          {items.map(it => (
            <div key={it.id} className="m-card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {cfg.getLabel(it)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {cfg.getSub(it)} · borrado {fmtFecha(it.deleted_at)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => restaurar(it.id)}>
                  <RotateCcw size={12} /> Restaurar
                </button>
                <button className="btn btn-ghost btn-sm btn-icon" onClick={() => borrarDefinitivo(it.id)} style={{ color: 'var(--red)', opacity: 0.6 }} title="Borrar definitivo">
                  <X size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── ERRORES ──────────────────────────────────────────────
function Errores({ toast }) {
  const [errores, setErrores] = useState([])
  const [loading, setLoading] = useState(true)
  const [soloPendientes, setSoloPendientes] = useState(true)

  const cargar = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('error_log').select('*').order('created_at', { ascending: false }).limit(100)
    if (soloPendientes) q = q.eq('resuelto', false)
    const { data } = await q
    setErrores(data || [])
    setLoading(false)
  }, [soloPendientes])

  useEffect(() => { cargar() }, [cargar])

  const marcarResuelto = async (id) => {
    await supabase.from('error_log').update({ resuelto: true }).eq('id', id)
    toast('Marcado como resuelto', 'success')
    cargar()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={soloPendientes} onChange={e => setSoloPendientes(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
          Solo pendientes
        </label>
      </div>

      {loading ? (
        <div className="m-card-list">{[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 60, borderRadius: 10 }} />)}</div>
      ) : errores.length === 0 ? (
        <div className="empty-state" style={{ padding: 40 }}>
          <div className="empty-state-icon"><CheckCircle size={22} color="var(--green)" /></div>
          <p className="empty-state-title">Sin errores</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>El sistema viene funcionando bien</p>
        </div>
      ) : (
        <div className="m-card-list">
          {errores.map(e => (
            <div key={e.id} className="m-card" style={{ padding: '12px 14px', borderLeft: '3px solid var(--red)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                    <span className="badge badge-red" style={{ fontSize: 10 }}>{e.contexto}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtFecha(e.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{e.mensaje}</div>
                  {e.detalle && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, fontFamily: 'monospace' }}>{e.detalle}</div>}
                  {e.usuario_nombre && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>por {e.usuario_nombre}</div>}
                </div>
                {!e.resuelto && (
                  <button className="btn btn-ghost btn-sm" onClick={() => marcarResuelto(e.id)} style={{ flexShrink: 0, color: 'var(--green)' }}>
                    <CheckCircle size={12} /> Resuelto
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── AUDITORÍA ────────────────────────────────────────────
function Auditoria() {
  const [acciones, setAcciones] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      setLoading(true)
      const { data } = await supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(150)
      setAcciones(data || [])
      setLoading(false)
    })()
  }, [])

  const colorAccion = (a) => a === 'eliminar' ? 'var(--red)' : a === 'crear' ? 'var(--green)' : 'var(--accent)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="alert" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <ClipboardList size={14} color="var(--accent)" />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Registro de quién creó, editó o eliminó cada cosa. Últimas 150 acciones.
        </span>
      </div>

      {loading ? (
        <div className="m-card-list">{[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 50, borderRadius: 10 }} />)}</div>
      ) : acciones.length === 0 ? (
        <div className="empty-state" style={{ padding: 40 }}>
          <div className="empty-state-icon"><ClipboardList size={22} /></div>
          <p className="empty-state-title">Sin registros aún</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {acciones.map((a, i) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)' }}>
              <span className="badge" style={{ background: `${colorAccion(a.accion)}22`, color: colorAccion(a.accion), fontSize: 10, flexShrink: 0, textTransform: 'capitalize' }}>
                {a.accion}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{a.entidad}</span> {a.detalle}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{a.usuario_nombre || '—'}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtFecha(a.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
