// _shared/vendedor/imagenes.ts · Que el vendedor VEA las fotos que manda el cliente (08-10).
// Antes le llegaba solo "[imagen]" y respondía "no me llegó bien la imagen". Ahora wa-webhook copia la foto a
// Storage wa-media (ya lo hacía para la Bandeja) y le pasa la ruta al vendedor; el orquestador la descarga y la
// manda a Claude como bloque de imagen base64 en el último mensaje del cliente.
// Solo las fotos sin responder (el mensaje actual y los que quedaron agrupados con él): las del historial viejo
// quedan como "[imagen]". Formatos que acepta la API: jpeg, png, gif, webp; máximo 5 MB por imagen en base64,
// así que se corta en 3,75 MB de archivo (base64 suma un tercio). Si falla, el texto queda "[imagen] (no se pudo ver)".
// Puro: la descarga entra por parámetro.
import type { Bloque } from "../claude.ts";

export const MIMES_IMAGEN = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
/** 3,75 MB de archivo ≈ 5 MB en base64 (tope de la API por imagen). */
export const MAX_BYTES_IMAGEN = 3_750_000;
/** Máximo de fotos por turno (un cliente que manda un álbum). */
export const MAX_IMAGENES_TURNO = 3;

export type ImagenEntrada = { ruta: string; mime: string };
export type BloqueImagen = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
export type Descarga = { ok: boolean; bytes?: Uint8Array; mime?: string; error?: string };

/** "image/jpeg; codecs" → "image/jpeg". */
export function mimeBase(mime: string | null | undefined): string {
  return String(mime ?? "").split(";")[0].trim().toLowerCase();
}

/** ¿Claude puede ver este formato? */
export function esImagenVisible(mime: string | null | undefined): boolean {
  return (MIMES_IMAGEN as readonly string[]).includes(mimeBase(mime));
}

const MARCA_NO_VISTA = "(no se pudo ver)";

/** "[imagen] caption" → "[imagen] (no se pudo ver) caption" (una sola vez). */
export function textoImagenNoVista(texto: string): string {
  const t = (texto ?? "").trim();
  if (t.includes(MARCA_NO_VISTA)) return t;
  const r = /^\[(imagen|documento)\]/.exec(t);
  if (r) return `[${r[1]}] ${MARCA_NO_VISTA}${t.slice(r[0].length)}`;
  return `[imagen] ${MARCA_NO_VISTA}${t ? ` ${t}` : ""}`;
}

/** Base64 en tramos (String.fromCharCode con millones de argumentos revienta la pila). */
export function aBase64(bytes: Uint8Array): string {
  let s = "";
  const paso = 0x8000;
  for (let i = 0; i < bytes.length; i += paso) s += String.fromCharCode(...bytes.subarray(i, i + paso));
  return btoa(s);
}

/** Descarga de Storage → bloque de imagen de la Messages API, o el motivo por el que no se puede ver. */
export async function cargarImagen(
  img: ImagenEntrada,
  descargar: ((ruta: string) => Promise<Descarga>) | undefined,
): Promise<{ ok: true; bloque: BloqueImagen } | { ok: false; error: string }> {
  if (!descargar) return { ok: false, error: "sin_descarga" };
  let d: Descarga;
  try {
    d = await descargar(img.ruta);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!d.ok || !d.bytes) return { ok: false, error: d.error ?? "descarga_vacia" };
  // El mime que guardó el webhook manda; el de Storage solo si el primero no sirve.
  const mime = esImagenVisible(img.mime) ? mimeBase(img.mime) : mimeBase(d.mime);
  if (!esImagenVisible(mime)) return { ok: false, error: `formato_no_soportado:${mime || "?"}` };
  if (!d.bytes.length) return { ok: false, error: "imagen_vacia" };
  if (d.bytes.length > MAX_BYTES_IMAGEN) return { ok: false, error: `imagen_muy_pesada:${d.bytes.length}` };
  return { ok: true, bloque: { type: "image", source: { type: "base64", media_type: mime, data: aBase64(d.bytes) } } };
}

type FilaImagen = { direccion: "in" | "out"; tipo: string | null; contenido: unknown; estado: string | null; wa_message_id: string | null };

/** Foto guardada en una fila de wa_mensajes (imagen, o documento con mime image/*). null si no tiene. */
export function imagenDeFila(f: FilaImagen): ImagenEntrada | null {
  if (f.direccion !== "in" || (f.tipo !== "image" && f.tipo !== "document")) return null;
  const c = (f.contenido ?? {}) as Record<string, unknown>;
  // El comprobante de pago anticipado ya lo atendió el webhook (respuesta fija + aviso a Enrique): no va al modelo.
  if (c.comprobante_pago_anticipado) return null;
  const ruta = typeof c.storage_path === "string" ? c.storage_path : null;
  const mimeContenido = typeof c.mime === "string"
    ? c.mime
    : f.tipo === "image"
    ? (c.image as { mime_type?: string } | undefined)?.mime_type ?? "image/jpeg"
    : (c.document as { mime_type?: string } | undefined)?.mime_type ?? "";
  if (!ruta || !esImagenVisible(mimeContenido)) return null;
  return { ruta, mime: mimeBase(mimeContenido) };
}

/**
 * Fotos sin responder: la del mensaje actual (`actual`, viene del webhook) y las de los mensajes del cliente desde
 * nuestro último mensaje (quedaron agrupadas en este turno). Sin repetir, en orden, máximo MAX_IMAGENES_TURNO
 * (las más nuevas).
 */
export function imagenesPendientes(filas: FilaImagen[], actual?: ImagenEntrada | null): ImagenEntrada[] {
  const out: ImagenEntrada[] = [];
  for (let i = filas.length - 1; i >= 0; i--) {
    const f = filas[i];
    if (f.direccion === "out") {
      if (f.estado === "fallido") continue;
      break;
    }
    const img = imagenDeFila(f);
    if (img) out.unshift(img);
  }
  if (actual && esImagenVisible(actual.mime) && !out.some((x) => x.ruta === actual.ruta)) out.push({ ruta: actual.ruta, mime: mimeBase(actual.mime) });
  return out.slice(-MAX_IMAGENES_TURNO);
}

/** Contenido del mensaje del cliente con las fotos adelante (así lo recomienda la API) y el texto después. */
export function contenidoConImagenes(texto: string | Bloque[], imagenes: BloqueImagen[]): string | Bloque[] {
  if (!imagenes.length) return texto;
  const resto: Bloque[] = typeof texto === "string" ? (texto.trim() ? [{ type: "text", text: texto }] : []) : texto;
  return [...imagenes, ...resto];
}
