// src/pages/vinculos/VinculosPage.jsx
// ═══════════════════════════════════════════════════════════
// COLA DE VÍNCULOS PENDIENTES
//
// Cuando llega el Excel del courier, la mayoría de las guías se pegan solas a
// su venta por el N° REFERENCIA (98% de las últimas cargas). El resto cae acá.
//
// La regla que define esta pantalla: ante la duda NO se vincula solo. Antes el
// sistema desempataba agarrando el primer candidato de la lista, y con 51
// clientes que repitieron compra eso significaba marcar la venta equivocada
// como entregada, sin que nadie se enterara. Un vínculo dudoso resuelto a
// ciegas es peor que uno pendiente: el pendiente se ve y se arregla en un clic.
//
// Esta es la ÚNICA pantalla del flujo de vinculación que escribe. Lo que se
// confirma acá queda marcado como 'manual' y ninguna carga automática
// posterior lo pisa (además del trigger que lo blinda en la base).
// ═══════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase, formatGs } from '../../lib/supabase'
import { fetchAll, fetchAllSafe } from '../../lib/fetchAll'
import { useToast } from '../../lib/toast'
import { logAccion } from '../../lib/audit'
import { normalizarRef } from '../../lib/referencias'
import { normTexto, refUtil, fechaCorta } from '../../lib/buscadorPedidos'
import { calcularVinculos, METODOS } from '../../lib/vinculacion'
import {
  Link2, AlertTriangle, CheckCircle, Search, RefreshCw, X, Ban, Package, Truck,
} from 'lucide-react'

const COLS_ENT = 'nro_guia_pap, n_referencia, transportadora, estado_pap, categoria, motivo, importe, ciudad, producto, fecha_ingreso, fecha_entrega, venta_id, vinculo_metodo, vinculo_at, telefono_courier, nombre_courier, direccion_courier'
const COLS_VTA = 'id, n_referencia, fecha, cliente_nombre, cliente_telefono, ciudad, producto_nombre, cantidad, total, estado'

// ─── Buscador manual, para cuando no hay candidatos sugeridos ───
function BuscarVenta({ ventas, onElegir, onCancelar }) {
  const [q, setQ] = useState('')
  const res = useMemo(() => {
    const n = normTexto(q), d = q.replace(/\D/g, '')
    if (n.length < 2 && d.length < 2) return []
    return ventas.filter(v =>
      (n.length >= 2 && normTexto(v.cliente_nombre).includes(n)) ||
      (d.length >= 2 && (refUtil(v.n_referencia) === refUtil(q) || String(v.cliente_telefono ?? '').replace(/\D/g, '').includes(d)))
    ).slice(0, 8)
  }, [ventas, q])
  return (
    <div style={{ marginTop: 8, padding: 10, background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <Search size={15} color="var(--text-muted)" />
        <input autoFocus className="form-input" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Nombre, referencia o teléfono" style={{ flex: 1 }} />
        <button className="btn-icon" onClick={onCancelar}><X size={15} /></button>
      </div>
      {res.map(v => (
        <button key={v.id} className="btn btn-sm btn-secondary" onClick={() => onElegir(v)}
          style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }}>
          #{v.n_referencia} · {v.cliente_nombre} · {v.ciudad} · {formatGs(v.total)} · {fechaCorta(v.fecha)}
        </button>
      ))}
      {q.length >= 2 && !res.length && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin resultados</div>
      )}
    </div>
  )
}

// ─── Una guía pendiente, con sus opciones ───
function FilaPendiente({ item, ventas, onConfirmar, onSinVenta, guardando }) {
  const [buscando, setBuscando] = useState(false)
  const e = item.entrega
  const ocupado = guardando === e.nro_guia_pap
  return (
    <div className="card" style={{ padding: 14, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 15, fontWeight: 700 }}>
            {e.nro_guia_pap}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {e.transportadora === 'lucero' ? 'Lucero' : 'Punto a Punto'}
            {e.fecha_ingreso ? ` · ${fechaCorta(e.fecha_ingreso)}` : ''}
            {e.ciudad ? ` · ${e.ciudad}` : ''}
            {e.importe ? ` · ${formatGs(e.importe)}` : ''}
          </div>
          {(e.nombre_courier || e.telefono_courier) && (
            <div style={{ fontSize: 12, marginTop: 3 }}>
              El courier dice: <strong>{e.nombre_courier || '—'}</strong>
              {e.telefono_courier ? ` · ${e.telefono_courier}` : ''}
            </div>
          )}
        </div>
        {e.categoria && (
          <span className="badge badge-gray" style={{ height: 'fit-content' }}>{e.estado_pap || e.categoria}</span>
        )}
      </div>

      <div style={{ fontSize: 12, color: 'var(--yellow)', marginTop: 8, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <AlertTriangle size={13} style={{ marginTop: 2, flexShrink: 0 }} />
        <span>{item.razon}</span>
      </div>

      {/* Los candidatos que el sistema encontró pero no se animó a elegir solo */}
      {item.candidatos?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>
            ¿Cuál de estas es?
          </div>
          {item.candidatos.map(c => (
            <button key={c.venta_id} disabled={ocupado}
              onClick={() => onConfirmar(e, c.venta_id, `#${c.n_referencia} ${c.cliente_nombre}`)}
              className="card" style={{
                display: 'block', width: '100%', textAlign: 'left', padding: 10, marginBottom: 6,
                cursor: ocupado ? 'wait' : 'pointer', background: 'var(--bg-hover)', border: '1px solid var(--border)',
              }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>#{c.n_referencia} · {c.cliente_nombre}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                {c.ciudad} · {formatGs(c.total)} · {fechaCorta(c.fecha)} · {c.producto_nombre}
              </div>
              <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 2 }}>coincide por {c.motivo}</div>
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {!buscando && (
          <button className="btn btn-sm btn-secondary" disabled={ocupado} onClick={() => setBuscando(true)}>
            <Search size={13} /> Buscar la venta a mano
          </button>
        )}
        {/* Sin esto la cola no llega nunca a cero: los paquetes viejos de PaP
            que volvieron sin referencia no van a cruzar con nada jamás. */}
        <button className="btn btn-sm btn-ghost" disabled={ocupado}
          onClick={() => onSinVenta(e)} style={{ color: 'var(--text-muted)' }}>
          <Ban size={13} /> No corresponde a ninguna venta
        </button>
      </div>

      {buscando && (
        <BuscarVenta ventas={ventas} onCancelar={() => setBuscando(false)}
          onElegir={v => { setBuscando(false); onConfirmar(e, v.id, `#${v.n_referencia} ${v.cliente_nombre}`) }} />
      )}
    </div>
  )
}

export default function VinculosPage() {
  const { toast } = useToast()
  const [entregas, setEntregas] = useState([])
  const [ventas, setVentas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [faltaMigracion, setFaltaMigracion] = useState(false)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('pendientes')
  const [guardando, setGuardando] = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true); setError(null)
    try {
      const { data: ents, error: errEnt } = await fetchAllSafe(
        () => supabase.from('entregas').select(COLS_ENT), { columnaOrden: 'nro_guia_pap' })
      if (errEnt) {
        // La migración 001 agrega estas columnas. Sin ella esta pantalla no
        // tiene de qué agarrarse: se dice claramente en vez de mostrar vacío.
        if (/venta_id|vinculo_metodo|telefono_courier/.test(errEnt.message || '')) {
          setFaltaMigracion(true); setEntregas([]); setVentas([]); return
        }
        throw errEnt
      }
      const vts = await fetchAll(() => supabase.from('ventas').select(COLS_VTA).is('deleted_at', null))
      setFaltaMigracion(false)
      setEntregas(ents || [])
      setVentas(vts || [])
    } catch (e) {
      setError(e?.message || String(e))
    } finally { setCargando(false) }
  }, [])

  useEffect(() => { cargar() }, [cargar])

  // Se recalcula la cascada completa para saber qué candidatos ofrecer. Es el
  // MISMO cálculo que corre al importar, así que lo que se ve acá es
  // exactamente lo que el importador no se animó a decidir.
  const calculo = useMemo(
    () => calcularVinculos(entregas, ventas),
    [entregas, ventas]
  )

  const pendientes = calculo.pendientes
  // Las vinculadas por nombre son las de menor confianza: se listan aparte
  // para poder repasarlas, no porque estén mal.
  const porNombre = useMemo(
    () => entregas.filter(e => e.vinculo_metodo === 'nombre' && e.venta_id),
    [entregas]
  )
  const ventaPorId = useMemo(() => new Map(ventas.map(v => [v.id, v])), [ventas])

  // ── Confirmar un vínculo a mano ──
  // Escribe el vínculo Y arrastra el estado de la venta, igual que hace el
  // importador. Si solo escribiera el vínculo, el pedido quedaría pegado pero
  // en "pendiente", y la plata seguiría mal contada.
  const confirmar = async (entrega, ventaId, etiqueta) => {
    setGuardando(entrega.nro_guia_pap)
    try {
      const { error: errV } = await supabase.from('entregas').upsert({
        nro_guia_pap: entrega.nro_guia_pap,
        venta_id: ventaId,
        vinculo_metodo: 'manual',
        vinculo_at: new Date().toISOString(),
      }, { onConflict: 'nro_guia_pap' })
      if (errV) throw errV

      if (entrega.categoria === 'entregado' || entrega.categoria === 'devuelto') {
        const estado = entrega.categoria
        const v = ventaPorId.get(ventaId)
        const ref = v ? normalizarRef(v.n_referencia) : null
        // Por referencia, no por id: un pedido de 2 productos son 2 filas.
        const hermanas = ref
          ? ventas.filter(x => normalizarRef(x.n_referencia) === ref && x.estado !== estado)
          : (v && v.estado !== estado ? [v] : [])
        if (hermanas.length) {
          const { error: errU } = await supabase.from('ventas')
            .update({ estado }).in('id', hermanas.map(x => x.id))
          if (errU) toast('Vínculo guardado, pero no se pudo cambiar el estado de la venta: ' + errU.message, 'error')
        }
      }

      await logAccion({
        accion: 'vincular_manual', entidad: 'entrega', entidadId: entrega.nro_guia_pap,
        detalle: `Guía ${entrega.nro_guia_pap} → ${etiqueta}`,
      })
      toast(`Vinculada a ${etiqueta}`, 'success')
      await cargar()
    } catch (e) {
      toast('No se pudo vincular: ' + (e?.message || e), 'error')
    } finally { setGuardando(null) }
  }

  const marcarSinVenta = async (entrega) => {
    setGuardando(entrega.nro_guia_pap)
    try {
      const { error: err } = await supabase.from('entregas').upsert({
        nro_guia_pap: entrega.nro_guia_pap,
        venta_id: null,
        vinculo_metodo: 'sin_venta',
        vinculo_at: new Date().toISOString(),
      }, { onConflict: 'nro_guia_pap' })
      if (err) throw err
      await logAccion({
        accion: 'marcar_sin_venta', entidad: 'entrega', entidadId: entrega.nro_guia_pap,
        detalle: `Guía ${entrega.nro_guia_pap} marcada como sin venta asociada`,
      })
      toast('Marcada como sin venta', 'success')
      await cargar()
    } catch (e) {
      toast('No se pudo marcar: ' + (e?.message || e), 'error')
    } finally { setGuardando(null) }
  }

  // ── Falta la migración ──
  if (faltaMigracion) return (
    <div className="page-content">
      <div className="page-header"><div><h1 className="page-title">Vínculos</h1></div></div>
      <div className="alert alert-warning">
        <AlertTriangle size={16} />
        <div>
          <div style={{ fontWeight: 600 }}>Falta correr la migración 001</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            La tabla <code>entregas</code> todavía no tiene las columnas del vínculo. Abrí el
            SQL Editor de Supabase y pegá el contenido de <code>migraciones/001-vinculo-entregas-ventas.sql</code>.
            Hasta entonces, las cargas de Excel siguen funcionando como siempre — solo que sin vincular.
          </div>
        </div>
      </div>
    </div>
  )

  const items = tab === 'pendientes' ? pendientes : porNombre

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Vínculos</h1>
          <p className="page-subtitle">Guías que el sistema no pudo pegar solo a su venta</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-sm" onClick={cargar} disabled={cargando}>
            <RefreshCw size={14} className={cargando ? 'spinning' : ''} /> Actualizar
          </button>
        </div>
      </div>

      {/* Resumen de salud del vínculo, para saber de un vistazo si hay deuda */}
      {!cargando && !error && (
        <div className="kpi-grid" style={{ marginBottom: 14 }}>
          <div className="kpi-card">
            <div className="kpi-label">Vinculadas</div>
            <div className="kpi-value" style={{ color: 'var(--green)' }}>
              {entregas.filter(e => e.venta_id).length}
            </div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Pendientes</div>
            <div className="kpi-value" style={{ color: pendientes.length ? 'var(--yellow)' : 'var(--text-muted)' }}>
              {pendientes.length}
            </div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Sin venta</div>
            <div className="kpi-value" style={{ color: 'var(--text-muted)' }}>
              {entregas.filter(e => e.vinculo_metodo === 'sin_venta').length}
            </div>
          </div>
        </div>
      )}

      <div className="tabs" style={{ marginBottom: 12 }}>
        <button className={`tab${tab === 'pendientes' ? ' active' : ''}`} onClick={() => setTab('pendientes')}>
          Pendientes {pendientes.length > 0 && `(${pendientes.length})`}
        </button>
        <button className={`tab${tab === 'nombre' ? ' active' : ''}`} onClick={() => setTab('nombre')}>
          Repasar por nombre {porNombre.length > 0 && `(${porNombre.length})`}
        </button>
      </div>

      {cargando && (
        <div className="empty-state">
          <div className="spinning" style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} />
          <div className="empty-state-desc" style={{ marginTop: 12 }}>Cargando…</div>
        </div>
      )}

      {error && !cargando && <div className="alert alert-error"><AlertTriangle size={16} /><span>{error}</span></div>}

      {!cargando && !error && tab === 'pendientes' && (
        pendientes.length === 0 ? (
          <div className="empty-state">
            <CheckCircle size={30} color="var(--green)" className="empty-state-icon" />
            <div className="empty-state-title">No hay nada pendiente</div>
            <div className="empty-state-desc">Todas las guías están pegadas a su venta o marcadas como sin venta.</div>
          </div>
        ) : pendientes.map(item => (
          <FilaPendiente key={item.nro_guia_pap} item={item} ventas={ventas}
            onConfirmar={confirmar} onSinVenta={marcarSinVenta} guardando={guardando} />
        ))
      )}

      {!cargando && !error && tab === 'nombre' && (
        porNombre.length === 0 ? (
          <div className="empty-state">
            <Link2 size={30} className="empty-state-icon" />
            <div className="empty-state-title">Ninguna vinculada por nombre</div>
            <div className="empty-state-desc">
              Todas las guías cruzaron por referencia o teléfono, que son más confiables.
            </div>
          </div>
        ) : (
          <>
            <div className="alert alert-info" style={{ marginBottom: 10 }}>
              <AlertTriangle size={15} />
              <span>
                Estas cruzaron por nombre + importe + ciudad, que es la vía menos segura.
                Están bien salvo prueba en contrario — revisalas si algún número no cierra.
              </span>
            </div>
            {porNombre.map(e => {
              const v = ventaPorId.get(e.venta_id)
              return (
                <div key={e.nro_guia_pap} className="card" style={{ padding: 12, marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 14, fontWeight: 700 }}>{e.nro_guia_pap}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        courier: {e.nombre_courier || '—'} · {e.ciudad} · {formatGs(e.importe)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {v ? `#${v.n_referencia} · ${v.cliente_nombre}` : 'venta no encontrada'}
                      </div>
                      {v && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{v.ciudad} · {formatGs(v.total)} · {fechaCorta(v.fecha)}</div>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn btn-sm btn-secondary" disabled={guardando === e.nro_guia_pap}
                      onClick={() => confirmar(e, e.venta_id, v ? `#${v.n_referencia} ${v.cliente_nombre}` : 'esa venta')}>
                      <CheckCircle size={13} /> Está bien, confirmar
                    </button>
                    <button className="btn btn-sm btn-ghost" disabled={guardando === e.nro_guia_pap}
                      onClick={() => marcarSinVenta(e)} style={{ color: 'var(--red)' }}>
                      <X size={13} /> Está mal, desvincular
                    </button>
                  </div>
                </div>
              )
            })}
          </>
        )
      )}
    </div>
  )
}
