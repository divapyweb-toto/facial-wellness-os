// src/pages/rendicion/DevolucionesDobleCobro.jsx
// 21-11: tarjeta "Devoluciones por doble cobro". Lee la vista devoluciones_doble_cobro y marca/deshace en
// devoluciones_cliente. Si la migración no está aplicada, muestra un mensaje chico y no rompe la página.
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { useToast } from '../../lib/toast'
import { AlertTriangle, CheckCircle } from 'lucide-react'
import { separarDevoluciones, totalDevolver, filaMarcarDevuelta, cambioDeshacer, esFaltaVista, nombreCourier } from './logicaDevoluciones.js'

const formatGs = (n) => Math.round(n || 0).toLocaleString('es-PY') + ' Gs.'
const fechaCorta = (d) => {
  if (!d) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d))
  const f = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d)
  return f.toLocaleDateString('es-PY', { day: '2-digit', month: 'short' })
}
// pagado_en y devuelto_en son timestamptz: se muestran en hora de Paraguay.
const fechaHora = (d) => (d ? new Date(d).toLocaleDateString('es-PY', { day: '2-digit', month: 'short', timeZone: 'America/Asuncion' }) : '—')

const th = { textAlign: 'left', padding: '6px 8px', fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }
const td = { padding: '6px 8px', fontSize: 12, whiteSpace: 'nowrap' }
const boton = { padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)' }

export default function DevolucionesDobleCobro({ className = '' }) {
  const { toast } = useToast()
  const [filas, setFilas] = useState([])
  const [estado, setEstado] = useState('cargando') // 'cargando' | 'ok' | 'sin_vista' | 'error'
  const [editando, setEditando] = useState(null)   // ref con la nota abierta
  const [nota, setNota] = useState('')
  const [guardando, setGuardando] = useState(null)

  const cargar = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('devoluciones_doble_cobro').select('*')
      if (error) { setEstado(esFaltaVista(error) ? 'sin_vista' : 'error'); return }
      setFilas(data || [])
      setEstado('ok')
    } catch (e) {
      setEstado('error')
    }
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const quien = async () => {
    try { const { data } = await supabase.auth.getUser(); return data?.user?.email ?? null } catch { return null }
  }

  const marcar = async (f) => {
    setGuardando(f.ref)
    try {
      const { error } = await supabase.from('devoluciones_cliente')
        .upsert(filaMarcarDevuelta(f, nota, new Date(), await quien()), { onConflict: 'ref' })
      if (error) throw error
      toast(`${f.pedido} marcado como devuelto`, 'success')
      setEditando(null); setNota('')
      await cargar()
    } catch (e) {
      toast('No se pudo marcar: ' + (e?.message || e), 'error')
    } finally { setGuardando(null) }
  }

  const deshacer = async (f) => {
    setGuardando(f.ref)
    try {
      const { error } = await supabase.from('devoluciones_cliente').update(cambioDeshacer(new Date(), await quien())).eq('ref', f.ref)
      if (error) throw error
      toast(`${f.pedido} volvió a pendiente`, 'success')
      await cargar()
    } catch (e) {
      toast('No se pudo deshacer: ' + (e?.message || e), 'error')
    } finally { setGuardando(null) }
  }

  if (estado === 'cargando') return null
  if (estado !== 'ok') {
    return (
      <div className={`card ${className}`} style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Devoluciones por doble cobro: {estado === 'sin_vista' ? 'todavía no está activada en la base (falta aplicar la migración).' : 'no se pudo cargar.'}
      </div>
    )
  }

  const { pendientes, devueltas } = separarDevoluciones(filas)
  if (!pendientes.length && !devueltas.length) return null
  const total = totalDevolver(pendientes)

  return (
    <div className={`card ${className}`} style={{ borderLeft: `3px solid ${pendientes.length ? 'var(--red)' : 'var(--green)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        {pendientes.length ? <AlertTriangle size={16} color="var(--red)" /> : <CheckCircle size={16} color="var(--green)" />}
        <div style={{ fontSize: 13, fontWeight: 700 }}>Devoluciones por doble cobro</div>
        <div style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800, color: pendientes.length ? 'var(--red)' : 'var(--green)' }}>
          {pendientes.length ? `${formatGs(total)} a devolver · ${pendientes.length} pedido${pendientes.length !== 1 ? 's' : ''}` : 'Nada pendiente'}
        </div>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
        El cliente pagó por transferencia y el courier igual cobró al entregar: Voltra recibió la plata dos veces. Devolvé la transferencia y marcala acá.
      </p>

      {pendientes.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={th}>Pedido</th><th style={th}>Courier</th><th style={th}>Entregado el</th><th style={th}>Rendido</th>
                <th style={{ ...th, textAlign: 'right' }}>Cobró</th><th style={{ ...th, textAlign: 'right' }}>A devolver</th>
                <th style={th}>Pagado el</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {pendientes.map(f => (
                <tr key={f.ref} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...td, fontWeight: 700 }}>{f.pedido}</td>
                  <td style={td}>{nombreCourier(f.courier)}</td>
                  <td style={td}>{fechaCorta(f.fecha_entrega)}</td>
                  <td style={td}>{f.rendido ? `Sí${f.fecha_rendido ? ` (${fechaCorta(f.fecha_rendido)})` : ''}` : 'No'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{formatGs(f.cobrado)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: 'var(--red)' }}>
                    {formatGs(f.monto_devolver)}
                    {f.saldo != null && <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>saldo {formatGs(f.saldo)}</div>}
                  </td>
                  <td style={td}>{fechaHora(f.pagado_en)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {editando === f.ref ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input
                          autoFocus value={nota} onChange={e => setNota(e.target.value)} placeholder="Nota (opcional)"
                          onKeyDown={e => { if (e.key === 'Enter') marcar(f); if (e.key === 'Escape') { setEditando(null); setNota('') } }}
                          style={{ fontSize: 11, padding: '4px 6px', width: 150, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'inherit' }}
                        />
                        <button style={{ ...boton, borderColor: 'var(--green)', color: 'var(--green)' }} disabled={guardando === f.ref} onClick={() => marcar(f)}>
                          {guardando === f.ref ? 'Guardando…' : 'Confirmar'}
                        </button>
                        <button style={boton} onClick={() => { setEditando(null); setNota('') }}>Cancelar</button>
                      </span>
                    ) : (
                      <button style={boton} onClick={() => { setEditando(f.ref); setNota('') }}>Marcar devuelta</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {devueltas.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
            Ya devueltas · {devueltas.length} · {formatGs(totalDevolver(devueltas))}
          </summary>
          <div style={{ overflowX: 'auto', marginTop: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {devueltas.map(f => (
                  <tr key={f.ref} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...td, fontWeight: 700 }}>{f.pedido}</td>
                    <td style={td}>{nombreCourier(f.courier)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{formatGs(f.monto_devolver)}</td>
                    <td style={td}>devuelta el {fechaHora(f.devuelto_en)}</td>
                    <td style={{ ...td, color: 'var(--text-muted)', whiteSpace: 'normal' }}>{f.nota || ''}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button style={boton} disabled={guardando === f.ref} onClick={() => deshacer(f)}>
                        {guardando === f.ref ? '…' : 'Deshacer'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
