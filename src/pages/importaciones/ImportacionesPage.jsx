// src/pages/importaciones/ImportacionesPage.jsx
// Menú "Importaciones" (decisión de Enrique 18-11 (3)): la mesa de decisión.
// Tablero en columnas por etapa del embudo; al tocar una tarjeta se abre la
// ficha de propuesta (una página, tipo memo de inversión). "Productos nuevos"
// sigue siendo el taller de investigación donde se cargan los datos.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Ship, FlaskConical, ImageOff, AlertTriangle, Clock } from 'lucide-react'
import { esModoDemo, setModoDemo } from '../productos/api'
import { fmtGs, fmtFecha } from '../productos/formato'
import { Demo, ErrorCaja, Vacio } from '../productos/ui'
import { cargarTablero } from './api'
import { ETAPAS, armarTarjetas } from './logica'
import Ficha from './Ficha'
import FotoImg from './FotoImg'
import PermisoGeneral from '../productos/PermisoGeneral'
import '../productos/productos.css'
import './importaciones.css'

export default function ImportacionesPage() {
  const [params, setParams] = useSearchParams()
  const [demo, setDemo] = useState(esModoDemo())
  const [version, setVersion] = useState(0)
  const candidatoId = params.get('c')
  const abrir = (id) => { const p = new URLSearchParams(params); if (id) p.set('c', id); else p.delete('c'); setParams(p) }
  const alternarDemo = () => { const n = !demo; setModoDemo(n); setDemo(n); setVersion(v => v + 1); abrir(null) }

  return (
    <div className="pi-page" key={version}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Importaciones</h1>
          <p className="page-subtitle">Mesa de decisión: qué importar, de quién, cuánto y con qué plata. Los datos se cargan en <Link to="/productos" className="pi-link">Productos nuevos</Link>.</p>
        </div>
        <div className="page-actions">
          <button className={`btn btn-sm ${demo ? 'btn-primary' : 'btn-ghost'}`} onClick={alternarDemo} title="Datos inventados en memoria; no se guarda nada en la base">
            <FlaskConical size={13} /> {demo ? 'Salir de DEMO' : 'Ver con datos DEMO'}
          </button>
        </div>
      </div>
      {demo && (
        <div className="alert alert-warning">
          <FlaskConical size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span><b>Modo DEMO:</b> productos, fotos y números inventados; nada se guarda en la base.</span>
        </div>
      )}
      {!candidatoId && <PermisoGeneral />}
      {candidatoId
        ? <Ficha candidatoId={candidatoId} onVolver={() => abrir(null)} />
        : <Tablero onAbrir={abrir} onActivarDemo={!demo ? alternarDemo : null} />}
    </div>
  )
}

function Tablero({ onAbrir, onActivarDemo }) {
  const [t, setT] = useState(null)
  const [error, setError] = useState(null)
  const cargar = useCallback(async () => {
    setError(null)
    try { setT(await cargarTablero()) } catch (e) { setError(e) }
  }, [])
  useEffect(() => { cargar() }, [cargar])
  const tarjetas = useMemo(() => (t ? armarTarjetas(t) : []), [t])

  if (error) return (
    <div className="pi-col">
      <ErrorCaja error={error} onReintentar={cargar} />
      {error.faltaTabla && onActivarDemo && <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onActivarDemo}>Ver con datos DEMO</button>}
    </div>
  )
  if (!t) return <div className="imp-tablero">{ETAPAS.slice(0, 4).map(e => <div key={e.v} className="skeleton" style={{ height: 260, minWidth: 240, borderRadius: 'var(--radius)' }} />)}</div>
  if (!tarjetas.length) return <Vacio icono={Ship} titulo="Sin propuestas todavía" desc="Los candidatos que se crean en Productos nuevos aparecen acá, en la columna Sugerido." />

  return (
    <div className="pi-col">
      {t.fotos === null && <p className="pi-desc">La tabla de fotos (pi_fotos) todavía no está en la base: las tarjetas salen sin foto.</p>}
      <div className="imp-tablero">
        {ETAPAS.map(e => {
          const col = tarjetas.filter(x => x.etapa === e.v)
          return (
            <div key={e.v} className="imp-columna">
              <div className="imp-col-titulo"><span>{e.label}</span><span className="badge badge-gray">{col.length}</span></div>
              {col.length === 0 ? <p className="pi-sub imp-col-vacia">—</p> : col.map(x => <Tarjeta key={x.c.id} x={x} onAbrir={onAbrir} />)}
            </div>
          )
        })}
      </div>
      <p className="pi-sub">Semáforo: verde = pasa todas las reglas cargadas; amarillo = falta algún dato; rojo = bloqueo duro. Ganancia = por pedido confirmado, después de anuncios, escenario base.</p>
    </div>
  )
}

const COLOR_SEM = { verde: 'var(--green)', amarillo: 'var(--yellow)', rojo: 'var(--red)' }

function Tarjeta({ x, onAbrir }) {
  return (
    <button className="imp-tarjeta" onClick={() => onAbrir(x.c.id)}>
      <div className="imp-foto">
        {x.principal ? <FotoImg foto={x.principal} alt={x.principal.descripcion || x.c.nombre} /> : <div className="imp-sin-foto imp-foto-aviso"><ImageOff size={20} /><span>Sin foto</span></div>}
        <span className="imp-sem" style={{ background: COLOR_SEM[x.semaforo.color] }} title={x.semaforo.motivos.join(' · ')} aria-label={`Semáforo ${x.semaforo.color}`} />
      </div>
      <div className="imp-tarjeta-cuerpo">
        <div className="imp-nombre">{x.c.nombre} {x.c.demo && <Demo />}</div>
        <div className="imp-datos">
          <div><span className="data-label">Precio</span><span className="pi-num">{x.precio != null ? fmtGs(x.precio) : '—'}</span></div>
          <div><span className="data-label">Ganancia / confirmado</span><span className={`pi-num ${x.ganancia != null && x.ganancia < 0 ? 'pi-rojo' : ''}`}>{x.ganancia != null ? fmtGs(x.ganancia) : '—'}</span></div>
          <div><span className="data-label">Plata necesaria</span><span className="pi-num">{x.plata != null ? fmtGs(x.plata) : '—'}</span></div>
          <div><span className="data-label">Recupera en</span><span className="pi-num">{x.dias != null ? `${x.dias} días` : x.recupera === false ? 'no recupera' : '—'}</span></div>
        </div>
        <div className="pi-sub" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={11} /> {x.vence ? `cotización hasta ${fmtFecha(x.vence)}` : 'sin cotización vigente'} · {x.nFotos} foto(s)</div>
        {x.alertaFoto && <div className="imp-alertas"><span className="badge badge-red" title="Toda propuesta necesita una foto principal: subila en la ficha (a · Fotos) y marcala con la estrella."><ImageOff size={10} /> {x.alertaFoto.texto}</span></div>}
        {x.alertas.length > 0 && (
          <div className="imp-alertas">{x.alertas.map((a, i) => <span key={i} className={`badge ${a.tipo === 'vencida' ? 'badge-red' : 'badge-yellow'}`}><AlertTriangle size={10} /> {a.texto}</span>)}</div>
        )}
        {x.orden && <div className="pi-sub">Orden: {x.orden.estado.replace(/_/g, ' ').toLowerCase()}</div>}
      </div>
    </button>
  )
}
