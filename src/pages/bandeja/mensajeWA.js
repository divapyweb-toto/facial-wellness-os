// src/pages/bandeja/mensajeWA.js
// ═══════════════════════════════════════════════════════════
// De una fila de `wa_mensajes` a lo que se dibuja, igual que WhatsApp.
//
// Todo puro (sin React ni red): se prueba con datos reales de la base.
// Cada mensaje devuelve { kind, ... } y la burbuja sabe pintar cada kind:
//   text · image · video · audio · sticker · document · location · reaction
//   botones · lista · cta (botón con enlace) · plantilla · respuesta (a un botón)
// ═══════════════════════════════════════════════════════════

const s = (v) => (v == null ? '' : String(v))

// ─── Formato de texto de WhatsApp: *negrita* _cursiva_ ~tachado~ `código` ───
const RE_INLINE = new RegExp([
  '(https?:\\/\\/[^\\s]+)',                                          // 1 enlace
  '(?<![\\w*])\\*(?!\\s)([^*\\n]+?)(?<!\\s)\\*(?![\\w*])',            // 2 negrita
  '(?<![\\w_])_(?!\\s)([^_\\n]+?)(?<!\\s)_(?![\\w_])',                // 3 cursiva
  '(?<![\\w~])~(?!\\s)([^~\\n]+?)(?<!\\s)~(?![\\w~])',                // 4 tachado
  '`([^`\\n]+)`',                                                    // 5 código en línea
].join('|'), 'g')

function parseInline(txt, nivel = 0) {
  const out = []
  let ultimo = 0
  for (const m of txt.matchAll(RE_INLINE)) {
    if (m.index > ultimo) out.push({ t: 'text', v: txt.slice(ultimo, m.index) })
    if (m[1]) {
      // Los signos finales (. , ) etc.) no son parte del enlace.
      const url = m[1].replace(/[.,;:!?)\]]+$/, '')
      out.push({ t: 'link', v: url, href: url })
      if (url.length < m[1].length) out.push({ t: 'text', v: m[1].slice(url.length) })
    } else if (m[2] != null) out.push({ t: 'b', c: nivel < 3 ? parseInline(m[2], nivel + 1) : [{ t: 'text', v: m[2] }] })
    else if (m[3] != null) out.push({ t: 'i', c: nivel < 3 ? parseInline(m[3], nivel + 1) : [{ t: 'text', v: m[3] }] })
    else if (m[4] != null) out.push({ t: 's', c: nivel < 3 ? parseInline(m[4], nivel + 1) : [{ t: 'text', v: m[4] }] })
    else if (m[5] != null) out.push({ t: 'code', v: m[5] })
    ultimo = m.index + m[0].length
  }
  if (ultimo < txt.length) out.push({ t: 'text', v: txt.slice(ultimo) })
  return out
}

export function formatearTextoWA(texto) {
  const txt = s(texto)
  if (!txt) return []
  // Bloques ```monoespaciado``` primero: adentro no se aplica ningún otro formato.
  const partes = []
  let ultimo = 0
  for (const m of txt.matchAll(/```([\s\S]+?)```/g)) {
    if (m.index > ultimo) partes.push(...parseInline(txt.slice(ultimo, m.index)))
    partes.push({ t: 'pre', v: m[1].replace(/^\n|\n$/g, '') })
    ultimo = m.index + m[0].length
  }
  if (ultimo < txt.length) partes.push(...parseInline(txt.slice(ultimo)))
  return partes
}

// Texto plano (vista previa de la lista, citas): sin los signos de formato.
export function textoPlano(texto) {
  const aplanar = (ts) => ts.map(t => t.c ? aplanar(t.c) : t.v).join('')
  return aplanar(formatearTextoWA(texto))
}

// ─── Plantillas: {{1}} {{2}} → los valores enviados ───
export function rellenarPlantilla(texto, params) {
  return s(texto).replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => (params?.[Number(n) - 1] ?? `{{${n}}}`))
}

function interpretarPlantilla(c, def) {
  const t = c.template || {}
  const comps = Array.isArray(t.components) ? t.components : []
  const cuerpoParams = (comps.find(x => x.type === 'body')?.parameters || []).map(p => s(p.text))
  const headerParam = comps.find(x => x.type === 'header')?.parameters?.[0]
  const defs = Array.isArray(def?.components) ? def.components : []
  const body = defs.find(x => x.type === 'BODY')
  const header = defs.find(x => x.type === 'HEADER')
  const footer = defs.find(x => x.type === 'FOOTER')
  const botones = (defs.find(x => x.type === 'BUTTONS')?.buttons || []).map(b => ({
    titulo: s(b.text), tipo: b.type === 'URL' ? 'url' : b.type === 'PHONE_NUMBER' ? 'tel' : 'respuesta',
  }))
  return {
    cuerpo: body ? rellenarPlantilla(body.text, cuerpoParams) : null,
    cabecera: header?.format === 'TEXT' ? rellenarPlantilla(header.text, [s(headerParam?.text)]) : null,
    cabeceraImagen: headerParam?.type === 'image' ? (headerParam.image?.link || null) : null,
    pie: footer?.text || null,
    botones,
  }
}

// ─── El intérprete ───
// ctx: { porWamid: Map(wa_message_id → fila), plantillas: { nombre → definición } }
export function interpretarMensaje(m, ctx = {}) {
  const c = m?.contenido && typeof m.contenido === 'object' ? m.contenido : {}
  const dir = m.direccion === 'out' ? 'out' : 'in'
  const base = { id: m.id, dir, hora: m.creado_en, estado: m.estado, wamid: m.wa_message_id || c.id || null }
  const cita = (() => {
    const id = c.context?.id
    const orig = id && ctx.porWamid?.get(id)
    return orig ? { dir: orig.direccion === 'out' ? 'out' : 'in', texto: textoVistaPrevia(orig, ctx) } : null
  })()
  const ruta = c.storage_path || null

  switch (m.tipo) {
    case 'text':
      return { ...base, kind: 'text', texto: s(c.text?.body || m.texto), cita }

    case 'image':
      return { ...base, kind: 'image', src: dir === 'out' ? (c.image?.link || null) : null, ruta,
        caption: s(c.image?.caption || (dir === 'in' && m.texto && !/^\[imagen\]$/i.test(m.texto) ? m.texto : '')), cita,
        fallo: !!c.storage_error }

    case 'video':
      return { ...base, kind: 'video', src: dir === 'out' ? (c.video?.link || null) : null, ruta, caption: s(c.video?.caption), cita, fallo: !!c.storage_error }

    case 'audio':
      return { ...base, kind: 'audio', ruta, voz: c.audio?.voice !== false, mime: s(c.mime || c.audio?.mime_type),
        transcripcion: s(c.transcripcion), cita, fallo: !!c.storage_error }

    case 'sticker':
      return { ...base, kind: 'sticker', ruta, animado: !!c.sticker?.animated, fallo: !!c.storage_error }

    case 'document':
      return { ...base, kind: 'document', src: dir === 'out' ? (c.document?.link || null) : null, ruta,
        nombre: s(c.document?.filename || 'Documento'), mime: s(c.document?.mime_type || c.mime), caption: s(c.document?.caption), cita }

    case 'location':
      return { ...base, kind: 'location', lat: Number(c.location?.latitude), lon: Number(c.location?.longitude),
        nombre: s(c.location?.name), direccion: s(c.location?.address) }

    case 'reaction':
      return { ...base, kind: 'reaction', emoji: s(c.reaction?.emoji), a: s(c.reaction?.message_id) }

    case 'button': // el cliente tocó un botón de una plantilla
      return { ...base, kind: 'respuesta', texto: s(c.button?.text || m.texto), cita }

    case 'interactive': {
      const i = c.interactive || {}
      if (dir === 'in') {
        const r = i.button_reply || i.list_reply
        return { ...base, kind: 'respuesta', texto: s(r?.title || m.texto), detalle: s(i.list_reply?.description), lista: !!i.list_reply, cita }
      }
      const cuerpo = s(i.body?.text)
      const cab = i.header
      const comun = {
        cuerpo, pie: s(i.footer?.text),
        cabecera: cab?.type === 'text' ? s(cab.text) : null,
        cabeceraImagen: cab?.type === 'image' ? (cab.image?.link || null) : null,
        cabeceraVideo: cab?.type === 'video' ? (cab.video?.link || null) : null,
      }
      if (i.type === 'button') {
        return { ...base, kind: 'botones', ...comun, botones: (i.action?.buttons || []).map(b => ({ id: s(b.reply?.id), titulo: s(b.reply?.title) })) }
      }
      if (i.type === 'list') {
        return { ...base, kind: 'lista', ...comun, boton: s(i.action?.button || 'Ver opciones'),
          secciones: (i.action?.sections || []).map(sec => ({ titulo: s(sec.title), filas: (sec.rows || []).map(r => ({ id: s(r.id), titulo: s(r.title), descripcion: s(r.description) })) })) }
      }
      if (i.type === 'cta_url') {
        return { ...base, kind: 'cta', ...comun, boton: s(i.action?.parameters?.display_text || 'Abrir'), url: s(i.action?.parameters?.url) }
      }
      return { ...base, kind: 'text', texto: s(cuerpo || m.texto) }
    }

    case 'template': {
      const def = ctx.plantillas?.[c.template?.name]
      const t = interpretarPlantilla(c, def)
      if (!t.cuerpo) return { ...base, kind: 'text', texto: s(m.texto).replace(/^\[plantilla [^\]]+\]\s*/, '') || `Plantilla ${s(c.template?.name)}` }
      return { ...base, kind: 'plantilla', nombre: s(c.template?.name), ...t }
    }

    default:
      return { ...base, kind: 'text', texto: s(m.texto) || `[${s(m.tipo) || 'mensaje'}]` }
  }
}

// Una línea para la lista de chats y para las citas.
export function textoVistaPrevia(m, ctx = {}) {
  if (!m) return ''
  const v = interpretarMensaje(m, ctx)
  const cap = (e, c) => (c ? `${e} ${textoPlano(c)}` : e)
  switch (v.kind) {
    case 'text': return textoPlano(v.texto)
    case 'image': return cap('📷', v.caption) === '📷' ? '📷 Foto' : cap('📷', v.caption)
    case 'video': return cap('🎥', v.caption) === '🎥' ? '🎥 Video' : cap('🎥', v.caption)
    case 'audio': return '🎤 Mensaje de voz'
    case 'sticker': return 'Sticker'
    case 'document': return `📄 ${v.nombre}`
    case 'location': return '📍 Ubicación'
    case 'reaction': return `Reaccionó con ${v.emoji}`
    case 'respuesta': return v.texto
    case 'botones': case 'lista': case 'cta': return textoPlano(v.cuerpo)
    case 'plantilla': return textoPlano(v.cuerpo)
    default: return ''
  }
}

// ─── Agrupar para dibujar: separadores de día y burbujas seguidas ───
export function etiquetaDia(iso, ahora = new Date()) {
  const d = new Date(iso)
  const mismo = (a, b) => a.toDateString() === b.toDateString()
  if (mismo(d, ahora)) return 'HOY'
  const ayer = new Date(ahora); ayer.setDate(ahora.getDate() - 1)
  if (mismo(d, ayer)) return 'AYER'
  const dif = (ahora - d) / 86400000
  if (dif < 7) return d.toLocaleDateString('es-PY', { weekday: 'long' }).toUpperCase()
  return d.toLocaleDateString('es-PY', { day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase()
}

// Misma fila → mismo objeto: las burbujas no se redibujan si nada cambió.
const cacheV = new WeakMap()

// → [{ tipo:'dia', id, label } | { tipo:'msg', id, v, primero, ultimo }]
// `primero` = abre un tramo (lleva cola); mismo remitente a menos de 5 min seguidos = mismo tramo.
export function armarLineaDeTiempo(mensajes, ctx = {}, ahora = new Date()) {
  const out = []
  let diaPrev = ''
  let prev = null
  for (const m of mensajes) {
    if (m.tipo === 'reaction') continue // WhatsApp la muestra pegada al mensaje, no como burbuja
    const d = new Date(m.creado_en).toDateString()
    if (d !== diaPrev) { out.push({ tipo: 'dia', id: `d-${d}`, label: etiquetaDia(m.creado_en, ahora) }); diaPrev = d; prev = null }
    let v = cacheV.get(m)
    if (!v) { v = interpretarMensaje(m, ctx); cacheV.set(m, v) }
    const seguido = prev && prev.dir === v.dir && (new Date(m.creado_en) - new Date(prev.hora)) < 5 * 60000
    out.push({ tipo: 'msg', id: m.id, v, primero: !seguido })
    prev = v
  }
  // `ultimo` se calcula mirando al siguiente.
  for (let i = 0; i < out.length; i++) {
    if (out[i].tipo !== 'msg') continue
    const sig = out[i + 1]
    out[i].ultimo = !(sig && sig.tipo === 'msg' && !sig.primero)
  }
  return out
}

// Reacciones por mensaje: { wamid: ['👍', ...] }
export function reaccionesPorMensaje(mensajes) {
  const r = {}
  for (const m of mensajes) {
    if (m.tipo !== 'reaction') continue
    const a = m.contenido?.reaction?.message_id
    const e = m.contenido?.reaction?.emoji
    if (a) r[a] = e ? [...(r[a] || []).filter(x => x.dir !== m.direccion), { dir: m.direccion, emoji: e }] : (r[a] || []).filter(x => x.dir !== m.direccion)
  }
  return r
}

// Barras del audio, siempre las mismas para el mismo mensaje (como WhatsApp, que dibuja la onda real).
export function barrasAudio(id, n = 32) {
  let h = 2166136261
  for (const ch of s(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  const out = []
  for (let i = 0; i < n; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5
    out.push(0.25 + (Math.abs(h) % 1000) / 1000 * 0.75)
  }
  return out
}

export function formatoDuracion(seg) {
  if (!isFinite(seg) || seg < 0) return '0:00'
  const m = Math.floor(seg / 60), r = Math.floor(seg % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}

// Color del avatar, estable por nombre (como los círculos de colores de WhatsApp).
const COLORES = ['#00a884', '#53bdeb', '#e26ab6', '#ffa726', '#7e57c2', '#26a69a', '#ef5350', '#8d6e63', '#5c6bc0', '#9ccc65']
export function colorAvatar(nombre) {
  let h = 0
  for (const ch of s(nombre)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORES[h % COLORES.length]
}
