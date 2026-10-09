// src/pages/bandeja/BandejaPage.jsx
// ═══════════════════════════════════════════════════════════
// Bandeja de WhatsApp de Voltra: conversaciones en vivo (Supabase Realtime
// sobre wa_conversaciones y wa_mensajes), filtro IA/humano, leer, responder
// y tomar/devolver el chat. Escritorio: dos columnas. Celular: lista y, al
// tocar, el chat a pantalla completa.
// ═══════════════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext'
import { useToast } from '../../lib/toast'
import ListaConversaciones from './ListaConversaciones'
import ChatPanel from './ChatPanel'
import {
  cargarConversaciones, cargarUltimosMensajes, cargarMensajes, cargarPalabrasProhibidas, PAGINA_MENSAJES,
  tomarConversacion, devolverAIA, enviarMensajeManual, suscribirBandeja,
} from './api'
import { mensajesDeConv, fusionarMensajes } from './cacheChat'
import './bandeja.css'

const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export default function BandejaPage() {
  const { user } = useAuth() || {}
  const { toast } = useToast() || {}
  const avisar = useCallback((msg, tipo = 'info') => toast?.(msg, tipo), [toast])

  const [convs, setConvs] = useState([])
  const [ultimos, setUltimos] = useState({})
  const [cargando, setCargando] = useState(true)
  const [errorCarga, setErrorCarga] = useState('')
  const [filtro, setFiltro] = useState('todas')
  const [busqueda, setBusqueda] = useState('')
  const [activaId, setActivaId] = useState(null)
  const [mensajes, setMensajes] = useState([])
  const [cargandoChat, setCargandoChat] = useState(false)
  const [hayMas, setHayMas] = useState(false)
  const [cargandoMas, setCargandoMas] = useState(false)
  const [pendientes, setPendientes] = useState([]) // enviados a la vista, aún sin confirmar
  const cacheChats = useRef(new Map()) // conversación → mensajes: reabrir un chat es instantáneo
  const [prohibidas, setProhibidas] = useState([])
  const [recarga, setRecarga] = useState(0) // sube → se vuelven a pedir los mensajes del chat abierto

  const activaRef = useRef(null)
  activaRef.current = activaId
  const convsRef = useRef([])
  convsRef.current = convs

  // ?c=<id> (link del aviso de auditoría): al cargar la lista, abre esa conversación una sola vez.
  const [searchParams] = useSearchParams()
  const convPedida = searchParams.get('c')
  const convPedidaAplicada = useRef(null)
  useEffect(() => {
    if (!convPedida || convPedidaAplicada.current === convPedida) return
    if (convs.some(c => c.id === convPedida)) {
      convPedidaAplicada.current = convPedida
      setActivaId(convPedida)
    }
  }, [convPedida, convs])

  const cargar = useCallback(async () => {
    setErrorCarga('')
    try {
      const lista = await cargarConversaciones()
      setConvs(lista)
      setUltimos(await cargarUltimosMensajes(lista.map(c => c.id)))
    } catch (e) {
      setErrorCarga(`No se pudieron cargar los chats (${e?.message || 'error'}). Revisá la conexión y tocá Actualizar.`)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    cargar()
    cargarPalabrasProhibidas().then(setProhibidas).catch(() => {})
  }, [cargar])

  // Mensajes del chat abierto: lo guardado se muestra al instante y se refresca de fondo.
  useEffect(() => {
    if (!activaId) { setMensajes([]); return }
    let vivo = true
    const previo = cacheChats.current.get(activaId)
    setMensajes(previo || [])
    setHayMas(previo ? previo.length >= PAGINA_MENSAJES : false)
    setCargandoChat(!previo)
    cargarMensajes(activaId)
      .then(m => {
        if (!vivo) return
        // Conserva lo que Realtime haya sumado mientras tanto (solo de este chat).
        setMensajes(ms => fusionarMensajes(m, ms, activaId))
        setHayMas(m.length >= PAGINA_MENSAJES)
      })
      .catch(e => avisar(`No se pudo abrir el chat: ${e?.message || 'error'}`, 'error'))
      .finally(() => { if (vivo) setCargandoChat(false) })
    return () => { vivo = false }
  }, [activaId, avisar, recarga])

  // Caché: solo mensajes de la conversación activa (al cambiar de chat, la
  // lista del render intermedio todavía es la del chat anterior).
  useEffect(() => {
    const propios = mensajesDeConv(activaId, mensajes)
    if (propios.length) cacheChats.current.set(activaId, propios.slice(-400))
  }, [activaId, mensajes])

  // Lo que pasó con la pestaña suspendida o el canal caído no llega por
  // Realtime: al volver, se recargan la lista y el chat abierto.
  const ultimoRefresco = useRef(0)
  const refrescar = useCallback(() => {
    if (Date.now() - ultimoRefresco.current < 5000) return
    ultimoRefresco.current = Date.now()
    cargar()
    setRecarga(n => n + 1)
  }, [cargar])
  useEffect(() => {
    const alVolver = () => { if (document.visibilityState === 'visible') refrescar() }
    document.addEventListener('visibilitychange', alVolver)
    return () => document.removeEventListener('visibilitychange', alVolver)
  }, [refrescar])

  const cargarMas = useCallback(async () => {
    const id = activaRef.current
    if (!id || cargandoMas || !hayMas) return
    const primero = mensajes[0]
    if (!primero) return
    setCargandoMas(true)
    try {
      const viejos = await cargarMensajes(id, { antes: primero.creado_en })
      if (activaRef.current !== id) return
      setMensajes(ms => {
        const ids = new Set(ms.map(x => x.id))
        return [...viejos.filter(x => !ids.has(x.id)), ...ms]
      })
      setHayMas(viejos.length >= PAGINA_MENSAJES)
    } catch (e) {
      avisar(`No se pudieron cargar los mensajes anteriores: ${e?.message || 'error'}`, 'error')
    } finally { setCargandoMas(false) }
  }, [cargandoMas, hayMas, mensajes, avisar])

  // Tiempo real.
  useEffect(() => {
    const cortar = suscribirBandeja({
      onConversacion: ({ eventType, new: nueva, old }) => {
        if (eventType === 'DELETE') { setConvs(cs => cs.filter(c => c.id !== old?.id)); return }
        if (!nueva?.id) return
        const existe = convsRef.current.some(c => c.id === nueva.id)
        if (!existe) { cargar(); return } // conversación nueva: trae el cliente con el join
        setConvs(cs => cs.map(c => (c.id === nueva.id ? { ...c, ...nueva } : c)))
      },
      onMensaje: ({ eventType, new: m }) => {
        if (!m?.id || !m.conversacion_id) return
        if (eventType === 'INSERT') {
          setUltimos(u => ({ ...u, [m.conversacion_id]: m }))
          if (!convsRef.current.some(c => c.id === m.conversacion_id)) cargar()
        } else if (eventType === 'UPDATE') {
          setUltimos(u => (u[m.conversacion_id]?.id === m.id ? { ...u, [m.conversacion_id]: { ...u[m.conversacion_id], ...m } } : u))
        }
        if (eventType === 'INSERT' && m.direccion === 'out') {
          setPendientes(ps => { const i = ps.findIndex(p => p.conversacion_id === m.conversacion_id && p.texto === m.texto); return i === -1 ? ps : ps.filter((_, j) => j !== i) })
        }
        if (m.conversacion_id === activaRef.current) {
          setMensajes(ms => {
            const i = ms.findIndex(x => x.id === m.id)
            if (i === -1) return eventType === 'INSERT' ? [...ms, m] : ms
            const copia = ms.slice(); copia[i] = { ...copia[i], ...m }; return copia
          })
        }
      },
      onReconectar: refrescar,
    })
    return cortar
  }, [cargar, refrescar])

  // Orden: el último movimiento (mensaje o entrada) arriba.
  const ordenadas = useMemo(() => {
    const t = (c) => new Date(ultimos[c.id]?.creado_en || c.ultima_entrada_en || c.creado_en || 0).getTime()
    return [...convs].sort((a, b) => t(b) - t(a))
  }, [convs, ultimos])

  const conteos = useMemo(() => ({
    todas: convs.length,
    humano: convs.filter(c => c.estado === 'humano').length,
    ia: convs.filter(c => c.estado === 'ia').length,
    cerrada: convs.filter(c => c.estado === 'cerrada').length,
  }), [convs])

  const visibles = useMemo(() => {
    const q = sinTildes(busqueda).trim()
    const qDig = busqueda.replace(/\D/g, '')
    return ordenadas.filter(c => {
      if (filtro !== 'todas' && c.estado !== filtro) return false
      if (!q) return true
      const cli = c.wa_clientes || {}
      return sinTildes(cli.nombre).includes(q) || sinTildes(cli.wa_username).includes(q) ||
        (qDig.length >= 3 && String(cli.telefono || '').replace(/\D/g, '').includes(qDig))
    })
  }, [ordenadas, filtro, busqueda])

  const activa = convs.find(c => c.id === activaId) || null
  const quien = user?.email || user?.id || null

  const cambiarEstadoLocal = (id, cambios) => setConvs(cs => cs.map(c => (c.id === id ? { ...c, ...cambios } : c)))

  async function tomar() {
    if (!activa) return
    try {
      await tomarConversacion(activa.id, quien)
      cambiarEstadoLocal(activa.id, { estado: 'humano', asignado_a: quien })
      avisar('Tomaste el chat: la IA no responde hasta que lo devuelvas.', 'success')
    } catch (e) { avisar(`No se pudo tomar el chat: ${e?.message || 'error'}`, 'error') }
  }

  async function devolver() {
    if (!activa) return
    try {
      await devolverAIA(activa.id)
      cambiarEstadoLocal(activa.id, { estado: 'ia', asignado_a: null })
      avisar('Chat devuelto a la IA.', 'success')
    } catch (e) { avisar(`No se pudo devolver el chat: ${e?.message || 'error'}`, 'error') }
  }

  async function enviar(texto) {
    if (!activa) return
    // Responder a mano implica tomar el chat: si no, la IA contestaría encima.
    if (activa.estado !== 'humano') await tomar()
    // Burbuja al instante con el reloj; se reemplaza por la real cuando llega.
    const falso = { id: `pend-${Date.now()}`, conversacion_id: activa.id, direccion: 'out', tipo: 'text', texto, contenido: { text: { body: texto } }, estado: 'pendiente', creado_en: new Date().toISOString() }
    setPendientes(ps => [...ps, falso])
    try {
      await enviarMensajeManual(activa.id, texto)
    } catch (e) {
      setPendientes(ps => ps.filter(p => p.id !== falso.id))
      throw e
    }
    // Red de seguridad: si Realtime no trae el mensaje, no queda el reloj para siempre.
    setTimeout(() => setPendientes(ps => ps.filter(p => p.id !== falso.id)), 20000)
  }

  const mensajesVista = useMemo(
    () => (pendientes.length ? [...mensajes, ...pendientes.filter(p => p.conversacion_id === activaId)] : mensajes),
    [mensajes, pendientes, activaId],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Bandeja</h1>
          <p className="page-subtitle">
            WhatsApp de Voltra en vivo · {conteos.humano} con vos · {conteos.ia} con la IA
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => { setCargando(true); cargar() }} aria-label="Actualizar">
            <RefreshCw size={14} className={cargando ? 'spinning' : ''} /> <span className="desktop-only" style={{ display: 'inline' }}>Actualizar</span>
          </button>
        </div>
      </div>

      {errorCarga && <div className="alert alert-error">{errorCarga}</div>}

      {cargando && !convs.length ? (
        <div className="skeleton skeleton-page" />
      ) : (
        <div className={`bandeja ${activaId ? 'con-chat' : ''}`}>
          <ListaConversaciones
            conversaciones={visibles}
            ultimos={ultimos}
            filtro={filtro}
            setFiltro={setFiltro}
            busqueda={busqueda}
            setBusqueda={setBusqueda}
            conteos={conteos}
            activaId={activaId}
            onElegir={setActivaId}
          />
          <ChatPanel
            conv={activa}
            mensajes={mensajesVista}
            cargando={cargandoChat}
            hayMas={hayMas}
            cargandoMas={cargandoMas}
            onMas={cargarMas}
            prohibidas={prohibidas}
            onVolver={() => setActivaId(null)}
            onTomar={tomar}
            onDevolver={devolver}
            onEnviar={enviar}
          />
        </div>
      )}
    </div>
  )
}
