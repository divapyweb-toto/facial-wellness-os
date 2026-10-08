// src/pages/bandeja/BurbujaWA.jsx
// Burbujas iguales a WhatsApp: texto con formato, fotos, videos, audios,
// stickers, documentos, ubicación, botones, listas, enlaces y plantillas.
import { memo, useEffect, useRef, useState, useCallback } from 'react'
import {
  Check, CheckCheck, Clock, AlertTriangle, Play, Pause, Mic, FileText, Download, MapPin,
  ExternalLink, List as ListIcon, Reply, X, ImageOff, CornerUpLeft,
} from 'lucide-react'
import { useMedia } from './useMedia'
import { formatearTextoWA, barrasAudio, formatoDuracion } from './mensajeWA'

const horaDe = (iso) => new Date(iso).toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' })

export function Tilde({ estado }) {
  if (estado === 'leido') return <CheckCheck size={15} className="wa-tilde leido" aria-label="Leído" />
  if (estado === 'entregado') return <CheckCheck size={15} className="wa-tilde" aria-label="Entregado" />
  if (estado === 'enviado') return <Check size={15} className="wa-tilde" aria-label="Enviado" />
  if (estado === 'fallido') return <AlertTriangle size={14} className="wa-tilde fallo" aria-label="Falló" />
  if (estado === 'pendiente') return <Clock size={13} className="wa-tilde" aria-label="Enviando" />
  return null
}

// ─── Texto con *negrita* _cursiva_ ~tachado~ `código` y enlaces ───
function Nodos({ nodos }) {
  return nodos.map((n, i) => {
    switch (n.t) {
      case 'b': return <strong key={i}><Nodos nodos={n.c} /></strong>
      case 'i': return <em key={i}><Nodos nodos={n.c} /></em>
      case 's': return <s key={i}><Nodos nodos={n.c} /></s>
      case 'code': return <code key={i} className="wa-code">{n.v}</code>
      case 'pre': return <pre key={i} className="wa-pre">{n.v}</pre>
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">{n.v}</a>
      default: return n.v
    }
  })
}
export function TextoWA({ texto }) {
  return <span className="wa-texto"><Nodos nodos={formatearTextoWA(texto)} /></span>
}

// ─── Visor de fotos a pantalla completa ───
function Visor({ src, onCerrar }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onCerrar() }
    window.addEventListener('keydown', k)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = prev }
  }, [onCerrar])
  return (
    <div className="wa-visor" onClick={onCerrar} role="dialog" aria-label="Foto">
      <button className="wa-visor-x" onClick={onCerrar} aria-label="Cerrar"><X size={22} /></button>
      <a className="wa-visor-dl" href={src} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} aria-label="Abrir original"><Download size={20} /></a>
      <img src={src} alt="" onClick={e => e.stopPropagation()} />
    </div>
  )
}

function MediaFalta({ icono, texto }) {
  return <div className="wa-media-falta">{icono}<span>{texto}</span></div>
}

function Imagen({ v }) {
  const { url, error, cargando } = useMedia(v.ruta, v.src)
  const [abierta, setAbierta] = useState(false)
  const [lista, setLista] = useState(false)
  const [rota, setRota] = useState(false)
  if (!v.ruta && !v.src) return <MediaFalta icono={<ImageOff size={20} />} texto={v.fallo ? 'No se pudo guardar la foto' : 'Foto no disponible (anterior a la activación)'} />
  if (error || rota) return <MediaFalta icono={<ImageOff size={20} />} texto="No se pudo cargar la foto" />
  return (
    <>
      <button className={`wa-imagen ${lista ? 'lista' : ''}`} onClick={() => url && setAbierta(true)} aria-label="Ver foto">
        {(cargando || !lista) && <span className="wa-shimmer" />}
        {url && <img src={url} alt="" loading="lazy" decoding="async" onLoad={() => setLista(true)} onError={() => setRota(true)} />}
      </button>
      {abierta && url && <Visor src={url} onCerrar={() => setAbierta(false)} />}
    </>
  )
}

function Video({ v }) {
  const { url, error, cargando } = useMedia(v.ruta, v.src)
  if (!v.ruta && !v.src) return <MediaFalta icono={<Play size={20} />} texto={v.fallo ? 'No se pudo guardar el video' : 'Video no disponible (anterior a la activación)'} />
  if (error) return <MediaFalta icono={<Play size={20} />} texto="No se pudo cargar el video" />
  return (
    <div className="wa-video">
      {cargando && <span className="wa-shimmer" />}
      {url && <video src={url} controls preload="metadata" playsInline controlsList="nodownload" />}
    </div>
  )
}

// ─── Audio: botón, onda, velocidad, duración (como la nota de voz) ───
const VELOCIDADES = [1, 1.5, 2]
function Audio({ v }) {
  const { url, error, cargando } = useMedia(v.ruta)
  const ref = useRef(null)
  const [suena, setSuena] = useState(false)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(0)
  const [vel, setVel] = useState(1)
  const barras = useRef(barrasAudio(v.id)).current

  const alternar = useCallback(() => {
    const a = ref.current
    if (!a) return
    if (a.paused) {
      // Un solo audio a la vez, como WhatsApp.
      document.querySelectorAll('audio.wa-audio-el').forEach(o => { if (o !== a) o.pause() })
      a.play().catch(() => setSuena(false))
    } else a.pause()
  }, [])

  const saltar = (e) => {
    const a = ref.current
    if (!a || !isFinite(a.duration)) return
    const r = e.currentTarget.getBoundingClientRect()
    a.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * a.duration
  }
  const cambiarVel = () => {
    const sig = VELOCIDADES[(VELOCIDADES.indexOf(vel) + 1) % VELOCIDADES.length]
    setVel(sig)
    if (ref.current) ref.current.playbackRate = sig
  }

  if (!v.ruta) return <MediaFalta icono={<Mic size={20} />} texto={v.fallo ? 'No se pudo guardar el audio' : 'Audio no disponible'} />
  if (error) return <MediaFalta icono={<Mic size={20} />} texto="No se pudo cargar el audio" />

  const prog = dur ? t / dur : 0
  return (
    <div className="wa-audio">
      <button className="wa-audio-play" onClick={alternar} disabled={!url} aria-label={suena ? 'Pausar' : 'Reproducir'}>
        {suena ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
      </button>
      <div className="wa-audio-centro">
        <div className="wa-onda" onClick={saltar} role="slider" aria-label="Posición del audio" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(prog * 100)}>
          {barras.map((h, i) => <i key={i} className={i / barras.length < prog ? 'on' : ''} style={{ height: `${h * 100}%` }} />)}
          <b className="wa-onda-punto" style={{ left: `${prog * 100}%` }} />
        </div>
        <div className="wa-audio-meta">
          <span>{formatoDuracion(suena || t > 0 ? t : dur)}</span>
          {(suena || t > 0) && <button className="wa-vel" onClick={cambiarVel}>{vel}×</button>}
        </div>
      </div>
      {cargando && <span className="wa-audio-cargando" />}
      {url && (
        <audio ref={ref} src={url} preload="metadata" className="wa-audio-el"
          onLoadedMetadata={e => setDur(e.currentTarget.duration)}
          onDurationChange={e => isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
          onTimeUpdate={e => setT(e.currentTarget.currentTime)}
          onPlay={() => { setSuena(true); if (ref.current) ref.current.playbackRate = vel }}
          onPause={() => setSuena(false)}
          onEnded={() => { setSuena(false); setT(0) }} />
      )}
    </div>
  )
}

function Sticker({ v }) {
  const { url, error } = useMedia(v.ruta)
  if (!v.ruta || error) return <MediaFalta icono={<ImageOff size={20} />} texto="Sticker no disponible" />
  return url ? <img className="wa-sticker" src={url} alt="Sticker" loading="lazy" decoding="async" /> : <span className="wa-sticker wa-shimmer" />
}

function Documento({ v }) {
  const { url } = useMedia(v.ruta, v.src)
  const ext = (v.nombre.split('.').pop() || '').toUpperCase().slice(0, 4)
  return (
    <a className="wa-doc" href={url || undefined} target="_blank" rel="noopener noreferrer" download={v.nombre} aria-disabled={!url}>
      <FileText size={30} />
      <span className="wa-doc-info"><b>{v.nombre}</b><small>{ext || 'Archivo'}</small></span>
      <Download size={18} />
    </a>
  )
}

function Ubicacion({ v }) {
  const ok = isFinite(v.lat) && isFinite(v.lon)
  const href = ok ? `https://www.google.com/maps?q=${v.lat},${v.lon}` : undefined
  return (
    <a className="wa-ubic" href={href} target="_blank" rel="noopener noreferrer">
      <span className="wa-ubic-mapa"><MapPin size={28} /></span>
      <span className="wa-ubic-txt"><b>{v.nombre || 'Ubicación'}</b>{(v.direccion || ok) && <small>{v.direccion || `${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}`}</small>}</span>
    </a>
  )
}

// ─── Botones de respuesta rápida / lista / enlace ───
function ListaSheet({ v, onCerrar }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onCerrar() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onCerrar])
  return (
    <div className="wa-sheet-fondo" onClick={onCerrar}>
      <div className="wa-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label={v.boton}>
        <div className="wa-sheet-cab"><button onClick={onCerrar} aria-label="Cerrar"><X size={20} /></button><span>{v.boton}</span></div>
        <div className="wa-sheet-cuerpo">
          {v.secciones.map((sec, i) => (
            <div key={i}>
              {sec.titulo && <div className="wa-sheet-sec">{sec.titulo}</div>}
              {sec.filas.map(f => (
                <div key={f.id || f.titulo} className="wa-sheet-fila">
                  <span className="wa-radio" />
                  <span><b>{f.titulo}</b>{f.descripcion && <small>{f.descripcion}</small>}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Cuerpo({ v }) {
  const [sheet, setSheet] = useState(false)
  const cita = v.cita && (
    <div className={`wa-cita ${v.cita.dir}`}><CornerUpLeft size={11} /> <span>{v.cita.texto}</span></div>
  )
  switch (v.kind) {
    case 'text': return <>{cita}<TextoWA texto={v.texto} /></>
    case 'image': return <>{cita}<Imagen v={v} />{v.caption && <div className="wa-caption"><TextoWA texto={v.caption} /></div>}</>
    case 'video': return <>{cita}<Video v={v} />{v.caption && <div className="wa-caption"><TextoWA texto={v.caption} /></div>}</>
    case 'audio': return <>{cita}<Audio v={v} />{v.transcripcion && <div className="wa-transcripcion">{v.transcripcion}</div>}</>
    case 'document': return <>{cita}<Documento v={v} />{v.caption && <div className="wa-caption"><TextoWA texto={v.caption} /></div>}</>
    case 'location': return <Ubicacion v={v} />
    case 'respuesta': return <>{cita}<span className="wa-resp"><Reply size={13} /> <TextoWA texto={v.texto} /></span>{v.detalle && <small className="wa-resp-det">{v.detalle}</small>}</>
    case 'botones': case 'lista': case 'cta': case 'plantilla': {
      const botones = v.kind === 'botones' ? v.botones.map(b => ({ t: b.titulo, k: 'resp' }))
        : v.kind === 'plantilla' ? v.botones.map(b => ({ t: b.titulo, k: b.tipo }))
        : []
      return (
        <>
          {v.cabeceraImagen && <img className="wa-cab-img" src={v.cabeceraImagen} alt="" loading="lazy" />}
          {v.cabeceraVideo && <video className="wa-cab-img" src={v.cabeceraVideo} controls preload="metadata" playsInline />}
          {v.cabecera && <div className="wa-cabecera"><TextoWA texto={v.cabecera} /></div>}
          <TextoWA texto={v.cuerpo} />
          {v.pie && <div className="wa-pie-txt">{v.pie}</div>}
          {botones.length > 0 && <BotonesFila botones={botones} />}
          {v.kind === 'lista' && <button className="wa-btn" onClick={() => setSheet(true)}><ListIcon size={15} /> {v.boton}</button>}
          {v.kind === 'cta' && <a className="wa-btn" href={v.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /> {v.boton}</a>}
          {sheet && <ListaSheet v={v} onCerrar={() => setSheet(false)} />}
        </>
      )
    }
    default: return null
  }
}

function BotonesFila({ botones }) {
  return botones.map((b, i) => (
    <span key={i} className="wa-btn" role="note">
      {b.k === 'url' ? <ExternalLink size={15} /> : <Reply size={15} />} {b.t}
    </span>
  ))
}

const SOLO_MEDIA = new Set(['sticker'])
const SIN_RELLENO = new Set(['image', 'video'])

function Burbuja({ item, reacciones }) {
  const { v, primero, ultimo } = item
  if (v.kind === 'reaction') return null
  const sticker = SOLO_MEDIA.has(v.kind)
  const sinTexto = SIN_RELLENO.has(v.kind) && !!(v.ruta || v.src) && !v.caption && !v.cita
  const clases = [
    'wa-fila', v.dir, primero ? 'primero' : '', ultimo ? 'ultimo' : '',
  ].join(' ')
  const burbuja = [
    'wa-burbuja', v.dir, `k-${v.kind}`, primero ? 'cola' : '',
    sinTexto ? 'solo-media' : '', v.estado === 'fallido' ? 'fallido' : '',
  ].join(' ')
  return (
    <div className={clases}>
      <div className={sticker ? 'wa-sticker-box' : burbuja}>
        {sticker ? <Sticker v={v} /> : <Cuerpo v={v} />}
        <span className={`wa-hora ${sinTexto || sticker ? 'sobre' : ''}`}>
          {horaDe(v.hora)}{v.dir === 'out' && <Tilde estado={v.estado} />}
        </span>
        {reacciones?.length > 0 && <span className="wa-reacciones">{reacciones.map(r => r.emoji).join('')}</span>}
      </div>
    </div>
  )
}

export default memo(Burbuja, (a, b) => a.item.v === b.item.v && a.item.primero === b.item.primero && a.item.ultimo === b.item.ultimo && a.reacciones === b.reacciones)
