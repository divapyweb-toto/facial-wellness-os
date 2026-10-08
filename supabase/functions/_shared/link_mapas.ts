// _shared/link_mapas.ts · 07-10-2026
// Links de Google Maps que el cliente pega como texto (maps.app.goo.gl/…, goo.gl/maps/…, google.com/maps/…).
// Se siguen las redirecciones del link corto hasta la URL larga y de ahí se sacan las coordenadas y, si
// viene, el nombre del lugar o la dirección. Así el vendedor lo trata igual que el pin de WhatsApp.
// Puro salvo resolverLinkMapas, que recibe fetch por parámetro (en tests se simula).

const RE_LINK = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\S*/i;

export type LinkMapas = { latitud: number | null; longitud: number | null; lugar: string | null; url: string };

export function detectarLinkMapas(texto: string | null | undefined): string | null {
  const m = RE_LINK.exec(texto ?? "");
  return m ? m[0].replace(/[).,;]+$/, "") : null;
}

const valida = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Coordenadas y lugar desde una URL larga de Google Maps (prioridad: !3d!4d del lugar > q=/ll= > @lat,lng). */
export function parsearUrlMapas(url: string): Omit<LinkMapas, "url"> {
  let u = url;
  try { u = decodeURIComponent(url); } catch { /* queda como vino */ }
  let lat: number | null = null, lng: number | null = null;
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(u);
  const q = /[?&](?:q|ll|query|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(u);
  const arroba = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(u);
  for (const m of [pin, q, arroba]) {
    if (m && valida(Number(m[1]), Number(m[2]))) { lat = Number(m[1]); lng = Number(m[2]); break; }
  }
  const p = /\/maps\/place\/([^/@?]+)/.exec(u) ?? /[?&]q=([^&]+)/.exec(u);
  let lugar = p ? p[1].replace(/\+/g, " ").trim() : null;
  if (lugar && /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(lugar)) lugar = null; // q= con coordenadas no es un lugar
  return { latitud: lat, longitud: lng, lugar: lugar ? lugar.slice(0, 160) : null };
}

/** Sigue hasta 4 redirecciones del link corto (sin descargar páginas grandes) y parsea la URL final. */
export async function resolverLinkMapas(url: string, f: typeof fetch = fetch): Promise<LinkMapas> {
  let actual = url;
  for (let i = 0; i < 4; i++) {
    const datos = parsearUrlMapas(actual);
    if (datos.latitud !== null) return { ...datos, url: actual };
    let r: Response;
    try {
      r = await f(actual, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
    } catch {
      break;
    }
    const sig = r.headers.get("location");
    try { await r.body?.cancel(); } catch { /* nada */ }
    if (!sig) break;
    actual = new URL(sig, actual).toString();
  }
  return { ...parsearUrlMapas(actual), url: actual };
}

/** Texto que se le agrega al mensaje del cliente para el vendedor. */
export function textoLinkMapas(l: LinkMapas): string {
  const partes = [l.latitud !== null ? `${l.latitud},${l.longitud}` : null, l.lugar].filter(Boolean);
  return partes.length
    ? `[ubicación por link] ${partes.join(" · ")} (tomalo como el pin: no pidas la dirección de nuevo)`
    : "[ubicación por link] no pude leer el link (pedile el pin con pedir_ubicacion o la dirección escrita)";
}
