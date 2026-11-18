// src/pages/productos/Oportunidades.jsx
// Pantalla 1 (§10): lista de candidatos con estado, evidencia pendiente,
// plata requerida, contribución prevista y siguiente acción. Arriba, el
// tablero de acierto (ampliación A2, vista pi_tasa_acierto).
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Lightbulb, Target, ImageOff } from 'lucide-react'
import { useToast } from '../../lib/toast'
import { cargarResumenOportunidades, crearCandidato, leerTasaAcierto, esModoDemo } from './api'
import { fmtGs, fmtFecha, vencida, ESTADOS_CANDIDATO, fmtPct, estadoInfo } from './formato'
import { resumenDeEscenario } from './calculo'
import { alertaFoto } from '../importaciones/logica'
import { Campo, Demo, BadgeEstado, Vacio, ErrorCaja, Modal } from './ui'

export default function Oportunidades({ onAbrir, onActivarDemo }) {
  const { toast } = useToast()
  const [datos, setDatos] = useState(null)
  const [acierto, setAcierto] = useState(undefined)
  const [error, setError] = useState(null)
  const [filtro, setFiltro] = useState('activos')
  const [creando, setCreando] = useState(false)

  const cargar = useCallback(async () => {
    setError(null)
    try {
      const [d, a] = await Promise.all([cargarResumenOportunidades(), leerTasaAcierto().catch(() => null)])
      setDatos(d); setAcierto(a)
    } catch (e) { setError(e); setDatos(null) }
  }, [])
  useEffect(() => { cargar() }, [cargar])

  const filas = useMemo(() => {
    if (!datos) return []
    const ahora = new Date()
    return datos.candidatos
      .filter(c => filtro === 'todos' || (filtro === 'activos' ? c.estado !== 'DESCARTAR' : c.estado === filtro))
      .map(c => {
        const evs = datos.evidencias.filter(e => e.candidato_id === c.id)
        const pendientes = evs.filter(e => e.tipo === 'unknown' || e.tipo === 'hypothesis').length
        const vencidas = evs.filter(e => vencida(e.valido_hasta, ahora)).length
        // Último escenario "base" calculado (o el último de cualquier nombre).
        const escs = datos.escenarios.filter(e => e.candidato_id === c.id)
        const esc = escs.find(e => /base/i.test(e.nombre || '')) || escs[0]
        const r = resumenDeEscenario(esc?.resultado)
        const vendedores = new Set(datos.ofertas.filter(o => o.candidato_id === c.id).map(o => o.vendedor_clave || o.id)).size
        const cotFirmes = datos.cotizaciones.filter(q => q.candidato_id === c.id && q.tipo === 'firme').length
        // Alerta roja "sin foto" (contrato 18-11): sin foto principal marcada. Si la tabla falta, no se alerta.
        const sinFoto = datos.fotos ? alertaFoto(datos.fotos.filter(f => f.candidato_id === c.id)) : null
        return { c, evs: evs.length, pendientes, vencidas, r, esc, vendedores, cotFirmes, sinFoto }
      })
  }, [datos, filtro])

  return (
    <div className="pi-col">
      <TableroAcierto filas={acierto} />

      <div className="pi-barra">
        <div className="tabs filter-scroll">
          {[['activos', 'Activos'], ...ESTADOS_CANDIDATO.map(e => [e.v, e.label]), ['todos', 'Todos']].map(([v, l]) => (
            <button key={v} className={`tab ${filtro === v ? 'active' : ''}`} onClick={() => setFiltro(v)}>{l}</button>
          ))}
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setCreando(true)}><Plus size={13} /> Nuevo candidato</button>
      </div>

      <ErrorCaja error={error} onReintentar={cargar} />
      {error?.faltaTabla && onActivarDemo && <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onActivarDemo}>Ver con datos DEMO</button>}

      {!datos && !error ? (
        <div className="m-card-list">{[...Array(3)].map((_, i) => <div key={i} className="skeleton" style={{ height: 64, borderRadius: 10 }} />)}</div>
      ) : datos && filas.length === 0 ? (
        <Vacio icono={Lightbulb} titulo="Sin candidatos en esta vista" desc="Cargá un producto por nombre, foto, enlace o una hipótesis comercial. Se investiga antes de comprar nada.">
          <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => setCreando(true)}><Plus size={13} /> Nuevo candidato</button>
        </Vacio>
      ) : datos && (
        <div className="table-wrapper">
          <table className="tabla-responsive">
            <thead>
              <tr>
                <th>Candidato</th><th>Estado</th><th>Evidencia</th><th>Competencia</th>
                <th title="Necesidad de caja del último escenario guardado">Plata requerida</th>
                <th title="Contribución después de ads del último escenario. Se rotula el denominador.">Contribución prevista</th>
                <th>Siguiente acción</th>
              </tr>
            </thead>
            <tbody>
              {filas.map(({ c, evs, pendientes, vencidas, r, esc, vendedores, cotFirmes, sinFoto }) => (
                <tr key={c.id} className="pi-fila-click" onClick={() => onAbrir(c.id)}>
                  <td data-label="Candidato" style={{ whiteSpace: 'normal', minWidth: 180 }}>
                    <div style={{ fontWeight: 600 }}>{c.nombre} {c.demo && <Demo />}</div>
                    {sinFoto && <span className="badge badge-red" title="Subí la foto en Importaciones → ficha → a · Fotos y marcala como principal (estrella)."><ImageOff size={10} /> {sinFoto.texto}</span>}
                    <div className="pi-sub">{c.categoria || 'sin categoría'} · {c.origen === 'producto' ? 'producto primero' : c.origen === 'demanda' ? 'demanda primero' : 'origen sin definir'}</div>
                  </td>
                  <td data-label="Estado"><BadgeEstado estado={c.estado} /></td>
                  <td data-label="Evidencia">
                    <span className="pi-num">{evs}</span> datos
                    {pendientes > 0 && <span className="badge badge-red" style={{ marginLeft: 6 }}>{pendientes} pendientes</span>}
                    {vencidas > 0 && <span className="badge badge-yellow" style={{ marginLeft: 6 }}>{vencidas} vencidas</span>}
                  </td>
                  <td data-label="Competencia">
                    <span className="pi-num">{vendedores}</span> vendedores · <span className="pi-num">{cotFirmes}</span> cotiz. firmes
                  </td>
                  <td data-label="Plata requerida" className="pi-num">{r.cajaNecesaria != null ? fmtGs(r.cajaNecesaria) : <span className="pi-desc">sin calcular</span>}</td>
                  <td data-label="Contribución prevista">
                    {r.contribDespuesAdsConfirmado != null || r.contribDespuesAdsIniciado != null ? (
                      <>
                        <span className={`pi-num ${(r.contribDespuesAdsConfirmado ?? 0) < 0 ? 'pi-rojo' : ''}`}>{fmtGs(r.contribDespuesAdsConfirmado)}</span> <span className="pi-sub">por confirmado</span>
                        <div className="pi-sub">{fmtGs(r.contribDespuesAdsIniciado)} por pedido iniciado · {esc?.nombre} v{esc?.version}</div>
                      </>
                    ) : <span className="pi-desc">sin calcular</span>}
                  </td>
                  <td data-label="Siguiente acción" style={{ whiteSpace: 'normal', minWidth: 160 }}>
                    {c.siguiente_accion || <span className="pi-desc">definir</span>}
                    <div className="pi-sub">act. {fmtFecha(c.actualizado_en)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creando && <NuevoCandidato onCerrar={() => setCreando(false)} onCreado={(c) => { setCreando(false); toast('Candidato creado', 'success'); onAbrir(c.id) }} toast={toast} />}
    </div>
  )
}

// Tablero de acierto (A2): vista pi_tasa_acierto (una fila, sin candidatos DEMO).
// acierto_pct viene en 0-100: ganadores ÷ pruebas cerradas con veredicto.
function TableroAcierto({ filas }) {
  if (filas === undefined) return null
  const criterio = 'Ganador = ≥30 confirmados en 30 días a ≤₲35.000 por confirmado.'
  if (filas === null) {
    return (
      <div className="card card-sm pi-acierto">
        <div className="section-label"><Target size={12} /> Tasa de acierto</div>
        <p className="pi-desc">La vista pi_tasa_acierto todavía no está en la base (migración pendiente). {criterio}</p>
      </div>
    )
  }
  const t = filas[0] || {}
  const porEstado = t.candidatos_por_estado || {}
  const meses = Array.isArray(t.pruebas_por_mes) ? t.pruebas_por_mes : []
  return (
    <div className="card card-sm pi-acierto">
      <div className="section-label"><Target size={12} /> Tasa de acierto {esModoDemo() && <Demo />}</div>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">Acierto acumulado</div><div className="kpi-value">{t.acierto_pct == null ? '—' : fmtPct(Number(t.acierto_pct) / 100)}</div><div className="kpi-sub">ganadores ÷ pruebas cerradas con veredicto</div></div>
        <div className="kpi-card"><div className="kpi-label">Ganadores</div><div className="kpi-value green">{t.ganadores ?? 0}</div><div className="kpi-sub">no ganadores: {t.no_ganadores ?? 0}</div></div>
        <div className="kpi-card"><div className="kpi-label">Pruebas cerradas</div><div className="kpi-value">{t.pruebas_cerradas ?? 0}</div><div className="kpi-sub">sin dato de gasto: {t.cerradas_sin_dato ?? 0}</div></div>
        <div className="kpi-card"><div className="kpi-label">Pruebas en curso</div><div className="kpi-value">{t.pruebas_en_curso ?? 0}</div><div className="kpi-sub">total: {t.pruebas_total ?? 0}</div></div>
        <div className="kpi-card"><div className="kpi-label">Candidatos</div><div className="kpi-value">{t.candidatos_total ?? 0}</div><div className="kpi-sub">{Object.entries(porEstado).map(([k, v]) => `${estadoInfo(k).label}: ${v}`).join(' · ') || '—'}</div></div>
      </div>
      {meses.length > 0 && <p className="pi-sub" style={{ marginTop: 6 }}>Pruebas por mes: {meses.map(m => `${m.mes} ${m.pruebas} (${m.ganadores} ganad.)`).join(' · ')}</p>}
      <p className="pi-sub" style={{ marginTop: 6 }}>{criterio} La meta no es investigar más productos sino acertar más.</p>
    </div>
  )
}

function NuevoCandidato({ onCerrar, onCreado, toast }) {
  const [f, setF] = useState({ nombre: '', hipotesis: '', categoria: '', origen: 'demanda', familia_producto: '', siguiente_accion: 'Buscar 5 ofertas comparables en PY de al menos 3 vendedores', notas: '' })
  const [guardando, setGuardando] = useState(false)
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))

  const guardar = async () => {
    if (!f.nombre.trim()) { toast('Poné un nombre al candidato', 'error'); return }
    setGuardando(true)
    try {
      const c = await crearCandidato({
        nombre: f.nombre.trim(), hipotesis: f.hipotesis.trim() || null, categoria: f.categoria.trim() || null,
        origen: f.origen, estado: 'INVESTIGAR', familia_producto: f.familia_producto.trim() || null,
        siguiente_accion: f.siguiente_accion.trim() || null, notas: f.notas.trim() || null, demo: esModoDemo(),
      })
      onCreado(c)
    } catch (e) { toast(e.message, 'error') } finally { setGuardando(false) }
  }

  return (
    <Modal titulo="Nuevo candidato" onCerrar={onCerrar} pie={<>
      <button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
      <button className="btn btn-primary" onClick={guardar} disabled={guardando}>{guardando ? 'Guardando…' : 'Crear'}</button>
    </>}>
      <div className="form-grid">
        <Campo label="Nombre *" span={2}><input className="form-input" value={f.nombre} onChange={set('nombre')} placeholder="Ej.: lámpara de lectura con clip" autoFocus /></Campo>
        <Campo label="Hipótesis comercial" span={2} hint="Quién lo compra, qué problema resuelve y por qué acá. Es una hipótesis hasta tener evidencia.">
          <textarea className="form-textarea" value={f.hipotesis} onChange={set('hipotesis')} />
        </Campo>
        <Campo label="Punto de partida">
          <select className="form-select" value={f.origen} onChange={set('origen')}>
            <option value="demanda">Demanda primero (clientes piden / problema)</option>
            <option value="producto">Producto primero (link o foto de China)</option>
          </select>
        </Campo>
        <Campo label="Categoría"><input className="form-input" value={f.categoria} onChange={set('categoria')} placeholder="hogar, belleza, deporte…" /></Campo>
        <Campo label="Familia en Voltra (si ya existe)" hint="Solo si el producto ya está en la tabla productos. Para uno nuevo, dejalo vacío."><input className="form-input" value={f.familia_producto} onChange={set('familia_producto')} /></Campo>
        <Campo label="Siguiente acción"><input className="form-input" value={f.siguiente_accion} onChange={set('siguiente_accion')} /></Campo>
        <Campo label="Notas" span={2}><textarea className="form-textarea" value={f.notas} onChange={set('notas')} /></Campo>
      </div>
    </Modal>
  )
}
