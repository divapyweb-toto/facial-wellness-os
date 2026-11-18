// src/pages/importaciones/api.js
// Datos de la mesa de decisión "Importaciones" (decisión de Enrique 18-11 (3)).
// Reutiliza la capa del módulo Productos nuevos (misma sesión, mismo modo DEMO)
// y suma: fotos (tabla pi_fotos + bucket PRIVADO pi-fotos con URLs firmadas),
// etapa del embudo (pi_candidatos.etapa) y decisiones (pi_decisiones).
import { supabase } from '../../lib/supabase'
import { listar, insertar, actualizar, borrar, esModoDemo, cargarDetalle } from '../productos/api'
import { urlFotoExternaValida } from './logica'

export const BUCKET_FOTOS = 'pi-fotos'
const opcional = (p) => p.catch(e => { if (e.faltaTabla) return null; throw e })

// Tablero: todo lo que necesitan las tarjetas, en paralelo.
export async function cargarTablero() {
  const [candidatos, escenarios, casos, cotizaciones, fotos, ordenes, decisiones] = await Promise.all([
    listar('pi_candidatos', { orden: 'actualizado_en' }),
    listar('pi_escenarios_costo', { columnas: 'id,candidato_id,nombre,version,resultado,entradas,calculado_en', orden: 'calculado_en' }),
    listar('pi_casos', { columnas: 'id,candidato_id,version,bloqueos,rubrica,decision,creado_en', orden: 'creado_en' }),
    listar('pi_cotizaciones', { columnas: 'id,candidato_id,proveedor_id,moneda,escalones,valida_hasta,tipo,creado_en', orden: 'creado_en' }),
    opcional(listar('pi_fotos', { orden: 'orden', asc: true })),
    opcional(listar('pi_ordenes_compra', { columnas: 'id,candidato_id,estado,total_minor,moneda', orden: 'creado_en' })),
    opcional(listar('pi_decisiones', { orden: 'creado_en' })),
  ])
  const conUrls = fotos ? await firmarFotos(fotos) : null
  return { candidatos, escenarios, casos, cotizaciones, fotos: conUrls, ordenes, decisiones }
}

// Ficha: el detalle completo de Productos nuevos + fotos, decisiones y mensajes.
export async function cargarFicha(candidatoId) {
  const [d, fotos, decisiones] = await Promise.all([
    cargarDetalle(candidatoId),
    opcional(listar('pi_fotos', { eq: { candidato_id: candidatoId }, orden: 'orden', asc: true })),
    opcional(listar('pi_decisiones', { eq: { candidato_id: candidatoId }, orden: 'creado_en' })),
  ])
  return { ...d, fotos: fotos ? await firmarFotos(fotos) : null, decisiones }
}

// URLs firmadas (1 hora) para las fotos del bucket privado. Las externas van tal cual.
export async function firmarFotos(fotos) {
  if (esModoDemo()) return fotos.map(f => ({ ...f, url: f.url_externa || null }))
  const paths = fotos.filter(f => f.storage_path).map(f => f.storage_path)
  let firmadas = {}
  if (paths.length) {
    const { data, error } = await supabase.storage.from(BUCKET_FOTOS).createSignedUrls(paths, 3600)
    if (!error) firmadas = Object.fromEntries((data || []).map(x => [x.path, x.signedUrl]))
  }
  return fotos.map(f => ({ ...f, url: f.storage_path ? (firmadas[f.storage_path] || null) : (f.url_externa || null) }))
}

const leerComoDataURL = (file) => new Promise((ok, mal) => {
  const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => mal(new Error('No se pudo leer el archivo')); r.readAsDataURL(file)
})

// Sube una foto al bucket privado y la registra. En DEMO queda en memoria.
export async function subirFoto(candidatoId, file, { fuente, descripcion, esPrincipal, orden }) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Solo fotos JPG, PNG o WEBP.')
  if (file.size > 8 * 1024 * 1024) throw new Error('La foto pesa más de 8 MB: achicala antes de subirla.')
  if (esModoDemo()) {
    return insertar('pi_fotos', { candidato_id: candidatoId, storage_path: null, url_externa: await leerComoDataURL(file), fuente, es_principal: !!esPrincipal, orden, descripcion: descripcion || null })
  }
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
  const id = globalThis.crypto?.randomUUID?.() || String(Date.now())
  const path = `${candidatoId}/${id}.${ext}`
  const { error } = await supabase.storage.from(BUCKET_FOTOS).upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw new Error(`No se pudo subir la foto al bucket privado "${BUCKET_FOTOS}": ${error.message}`)
  return insertar('pi_fotos', { candidato_id: candidatoId, storage_path: path, url_externa: null, fuente, es_principal: !!esPrincipal, orden, descripcion: descripcion || null })
}

// Link externo: fuera de DEMO solo http/https (nunca data: ni otro esquema; las fotos subidas van al bucket).
export async function agregarFotoExterna(candidatoId, url, { fuente, descripcion, esPrincipal, orden }) {
  if (!esModoDemo() && !urlFotoExternaValida(url)) throw new Error('El link de la foto tiene que empezar con http:// o https://. Para una foto de tu compu usá "Elegir archivo".')
  return insertar('pi_fotos', { candidato_id: candidatoId, storage_path: null, url_externa: String(url).trim(), fuente, es_principal: !!esPrincipal, orden, descripcion: descripcion || null })
}

// Primero se desmarca la principal vieja y después se marca la nueva: al revés choca con el índice único
// pi_fotos_una_principal_uq (revisión 18-11, hallazgo 7).
export async function marcarPrincipal(fotos, id) {
  for (const f of fotos) if (f.es_principal && f.id !== id) await actualizar('pi_fotos', f.id, { es_principal: false })
  const nueva = fotos.find(f => f.id === id)
  if (nueva && !nueva.es_principal) await actualizar('pi_fotos', id, { es_principal: true })
}

export async function borrarFoto(foto) {
  if (!esModoDemo() && foto.storage_path) {
    const { error } = await supabase.storage.from(BUCKET_FOTOS).remove([foto.storage_path])
    if (error) throw new Error(`No se pudo borrar la foto del bucket: ${error.message}`)
  }
  await borrar('pi_fotos', foto.id)
}

export const cambiarEtapa = (candidatoId, etapa) => actualizar('pi_candidatos', candidatoId, { etapa })

// Decisión de Enrique: siempre con su texto textual y una foto de los números.
export function registrarDecision(candidatoId, { decision, texto_enrique, motivo, snapshot }) {
  if (!texto_enrique || !texto_enrique.trim()) throw new Error('Falta el texto de Enrique: toda decisión se registra con lo que escribió, textual.')
  return insertar('pi_decisiones', { candidato_id: candidatoId, decision, texto_enrique: texto_enrique.trim(), motivo: motivo?.trim() || null, snapshot: snapshot || null })
}
