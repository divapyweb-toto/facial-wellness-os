// src/pages/bandeja/useMedia.js
// URL firmada (1 h) de un archivo del bucket privado `wa-media`, con caché
// compartido: un mismo archivo no se pide dos veces aunque lo usen varias burbujas.
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

const BUCKET = 'wa-media'
const VIDA_MS = 50 * 60 * 1000 // se renueva antes de que venza la hora de la firma
const cache = new Map() // ruta → { url, hasta } | { promesa }

export function urlDeMedia(ruta) {
  const hit = cache.get(ruta)
  if (hit?.url && hit.hasta > Date.now()) return Promise.resolve(hit.url)
  if (hit?.promesa) return hit.promesa
  const promesa = supabase.storage.from(BUCKET).createSignedUrl(ruta, 3600)
    .then(({ data, error }) => {
      if (error || !data?.signedUrl) throw new Error(error?.message || 'sin URL')
      cache.set(ruta, { url: data.signedUrl, hasta: Date.now() + VIDA_MS })
      return data.signedUrl
    })
    .catch((e) => { cache.delete(ruta); throw e })
  cache.set(ruta, { promesa })
  return promesa
}

// → { url, error, cargando }.  `directa` (link de un envío saliente) gana si existe.
export function useMedia(ruta, directa = null) {
  const [estado, setEstado] = useState(() => {
    const hit = ruta && cache.get(ruta)
    return { url: directa || (hit?.url && hit.hasta > Date.now() ? hit.url : null), error: false }
  })
  useEffect(() => {
    if (directa) { setEstado({ url: directa, error: false }); return }
    if (!ruta) { setEstado({ url: null, error: false }); return }
    let vivo = true
    urlDeMedia(ruta)
      .then(url => { if (vivo) setEstado({ url, error: false }) })
      .catch(() => { if (vivo) setEstado({ url: null, error: true }) })
    return () => { vivo = false }
  }, [ruta, directa])
  return { ...estado, cargando: !estado.url && !estado.error && !!(ruta || directa) }
}

