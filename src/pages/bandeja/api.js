// src/pages/bandeja/api.js
// Todo el acceso a datos de la bandeja en un solo lugar.
import { supabase } from '../../lib/supabase'

const VENTANA_MS = 24 * 60 * 60 * 1000

// ¿Sigue abierta la ventana de 24 h de WhatsApp? Fuera de ella Meta solo
// acepta plantillas aprobadas, no texto libre.
export function ventanaAbierta(conv, ahora = Date.now()) {
  if (!conv?.ultima_entrada_en) return false
  return ahora - new Date(conv.ultima_entrada_en).getTime() < VENTANA_MS
}

export async function cargarConversaciones() {
  const { data, error } = await supabase
    .from('wa_conversaciones')
    .select('id, cliente_id, estado, asignado_a, ultima_entrada_en, origen_anuncio_id, creado_en, wa_clientes(nombre, telefono, wa_username)')
    .order('ultima_entrada_en', { ascending: false, nullsFirst: false })
    .limit(300)
  if (error) throw error
  return data || []
}

// Último mensaje de cada conversación (para la vista previa y el orden).
export async function cargarUltimosMensajes(ids) {
  if (!ids.length) return {}
  const { data, error } = await supabase
    .from('wa_mensajes')
    .select('id, conversacion_id, direccion, tipo, texto, contenido, estado, creado_en')
    .in('conversacion_id', ids)
    .order('creado_en', { ascending: false })
    .limit(1000)
  if (error) throw error
  const ult = {}
  for (const m of data || []) if (!ult[m.conversacion_id]) ult[m.conversacion_id] = m
  return ult
}

const COLS_MSG = 'id, conversacion_id, direccion, tipo, texto, contenido, estado, error, creado_en, wa_message_id'
export const PAGINA_MENSAJES = 100

// Los últimos `limite` mensajes (o los anteriores a `antes`), en orden cronológico.
export async function cargarMensajes(conversacionId, { antes = null, limite = PAGINA_MENSAJES } = {}) {
  let q = supabase.from('wa_mensajes').select(COLS_MSG)
    .eq('conversacion_id', conversacionId)
    .order('creado_en', { ascending: false })
    .limit(limite)
  if (antes) q = q.lt('creado_en', antes)
  const { data, error } = await q
  if (error) throw error
  return (data || []).reverse()
}

export async function cargarPalabrasProhibidas() {
  const { data } = await supabase.from('config_wa').select('valor').eq('clave', 'palabras_prohibidas').maybeSingle()
  const v = data?.valor
  return Array.isArray(v) ? v : Array.isArray(v?.lista) ? v.lista : []
}

export async function tomarConversacion(id, quien) {
  const { error } = await supabase.from('wa_conversaciones')
    .update({ estado: 'humano', asignado_a: quien || null }).eq('id', id)
  if (error) throw error
}

export async function devolverAIA(id) {
  const { error } = await supabase.from('wa_conversaciones')
    .update({ estado: 'ia', asignado_a: null }).eq('id', id)
  if (error) throw error
}

// ÚNICO punto que manda texto al cliente. Edge Function 'wa-enviar-manual'
// (supabase/functions/wa-enviar-manual): recibe { conversacion_id, texto },
// valida la sesión, exige ventana de 24 h abierta, pasa el chat a 'humano'
// (asignado_a 'enrique'), manda con enviarTexto() de _shared/wa.ts (filtro de
// palabras prohibidas + registro en wa_mensajes) y devuelve { ok, wa_message_id?, error? }.
export async function enviarMensajeManual(conversacionId, texto) {
  const { data, error } = await supabase.functions.invoke('wa-enviar-manual', {
    body: { conversacion_id: conversacionId, texto },
  })
  if (error) {
    let detalle = error.message
    try { detalle = (await error.context?.json())?.error || detalle } catch { /* sin cuerpo */ }
    if (/not found|404|Failed to send/i.test(String(detalle))) {
      detalle = 'El envío manual todavía no está activado (falta la función wa-enviar-manual).'
    }
    throw new Error(detalle)
  }
  if (data && data.ok === false) throw new Error(data.error || 'WhatsApp rechazó el mensaje')
  return data
}

// Realtime: un solo canal para las dos tablas. Devuelve la función para cortar.
export function suscribirBandeja({ onConversacion, onMensaje }) {
  const canal = supabase
    .channel('bandeja-wa')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wa_conversaciones' }, (p) => onConversacion?.(p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wa_mensajes' }, (p) => onMensaje?.(p))
    .subscribe()
  return () => { supabase.removeChannel(canal) }
}
