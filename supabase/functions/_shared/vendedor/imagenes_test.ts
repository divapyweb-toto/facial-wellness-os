// Fotos del cliente → bloques de imagen para el vendedor. Datos inventados (repo público).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  aBase64,
  cargarImagen,
  contenidoConImagenes,
  esImagenVisible,
  imagenDeFila,
  imagenesPendientes,
  MAX_BYTES_IMAGEN,
  textoImagenNoVista,
} from "./imagenes.ts";

const fila = (over: Record<string, unknown> = {}) => ({
  direccion: "in" as "in" | "out",
  tipo: "image" as string | null,
  contenido: { storage_path: "media/cli-1/wamid.A.jpg", mime: "image/jpeg" } as unknown,
  estado: "recibido" as string | null,
  wa_message_id: "wamid.A" as string | null,
  ...over,
});

Deno.test("imagenes: formatos que la API acepta", () => {
  for (const m of ["image/jpeg", "image/png", "image/gif", "image/webp", "IMAGE/JPEG; x=1"]) assert(esImagenVisible(m), m);
  for (const m of ["image/heic", "application/pdf", "video/mp4", "", null, undefined]) assert(!esImagenVisible(m), String(m));
});

Deno.test("imagenes: texto cuando no se pudo ver (una sola vez, con o sin caption)", () => {
  assertEquals(textoImagenNoVista("[imagen]"), "[imagen] (no se pudo ver)");
  assertEquals(textoImagenNoVista("[imagen] ¿tienen este?"), "[imagen] (no se pudo ver) ¿tienen este?");
  assertEquals(textoImagenNoVista("[documento] foto.png"), "[documento] (no se pudo ver) foto.png");
  assertEquals(textoImagenNoVista("[imagen] (no se pudo ver)"), "[imagen] (no se pudo ver)");
  assertEquals(textoImagenNoVista("algo"), "[imagen] (no se pudo ver) algo");
});

Deno.test("imagenes: base64 igual al de la plataforma, también con archivos grandes", () => {
  assertEquals(aBase64(new TextEncoder().encode("hola")), btoa("hola"));
  const grande = new Uint8Array(200_000).map((_, i) => i % 256);
  const b = aBase64(grande);
  assertEquals(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)), grande);
});

Deno.test("imagenes: cargar → bloque base64; fallas (sin descarga, error, excepción, formato, tamaño) → motivo", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const ok = await cargarImagen({ ruta: "media/c/w.jpg", mime: "image/jpeg" }, (ruta) => {
    assertEquals(ruta, "media/c/w.jpg");
    return Promise.resolve({ ok: true, bytes, mime: "image/jpeg" });
  });
  assertEquals(ok, { ok: true, bloque: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: aBase64(bytes) } } });
  // Mime del webhook raro → usa el de Storage.
  const r2 = await cargarImagen({ ruta: "r", mime: "application/octet-stream" }, () => Promise.resolve({ ok: true, bytes, mime: "image/png" }));
  assert(r2.ok && r2.bloque.source.media_type === "image/png");
  assertEquals((await cargarImagen({ ruta: "r", mime: "image/jpeg" }, undefined)).ok, false);
  assertEquals(await cargarImagen({ ruta: "r", mime: "image/jpeg" }, () => Promise.resolve({ ok: false, error: "404" })), { ok: false, error: "404" });
  assertEquals(await cargarImagen({ ruta: "r", mime: "image/jpeg" }, () => Promise.reject(new Error("red caída"))), { ok: false, error: "red caída" });
  const heic = await cargarImagen({ ruta: "r", mime: "image/heic" }, () => Promise.resolve({ ok: true, bytes, mime: "image/heic" }));
  assert(!heic.ok && heic.error.startsWith("formato_no_soportado"));
  const pesada = await cargarImagen({ ruta: "r", mime: "image/jpeg" }, () => Promise.resolve({ ok: true, bytes: new Uint8Array(MAX_BYTES_IMAGEN + 1) }));
  assert(!pesada.ok && pesada.error.startsWith("imagen_muy_pesada"));
  assertEquals((await cargarImagen({ ruta: "r", mime: "image/jpeg" }, () => Promise.resolve({ ok: true, bytes: new Uint8Array() }))).ok, false);
});

Deno.test("imagenes: foto de una fila (imagen o documento imagen/*; no comprobantes, ni salientes, ni PDF)", () => {
  assertEquals(imagenDeFila(fila()), { ruta: "media/cli-1/wamid.A.jpg", mime: "image/jpeg" });
  assertEquals(imagenDeFila(fila({ tipo: "document", contenido: { storage_path: "media/c/d.png", document: { mime_type: "image/png" } } })), { ruta: "media/c/d.png", mime: "image/png" });
  assertEquals(imagenDeFila(fila({ tipo: "document", contenido: { storage_path: "media/c/d.pdf", mime: "application/pdf" } })), null);
  assertEquals(imagenDeFila(fila({ contenido: { storage_path: "comprobantes/c/x.jpg", mime: "image/jpeg", comprobante_pago_anticipado: "123" } })), null);
  assertEquals(imagenDeFila(fila({ direccion: "out" })), null);
  assertEquals(imagenDeFila(fila({ contenido: { storage_error: "x" } })), null);
  assertEquals(imagenDeFila(fila({ tipo: "sticker" })), null);
});

Deno.test("imagenes: pendientes = fotos desde nuestro último mensaje + la actual, sin repetir, máximo 3", () => {
  const filas = [
    fila({ wa_message_id: "wamid.VIEJA", contenido: { storage_path: "media/c/vieja.jpg", mime: "image/jpeg" } }),
    { direccion: "out" as const, tipo: "text", contenido: {}, estado: "enviado", wa_message_id: "wamid.OUT" },
    { direccion: "out" as const, tipo: "text", contenido: {}, estado: "fallido", wa_message_id: "wamid.OUTF" },
    fila({ wa_message_id: "wamid.B", contenido: { storage_path: "media/c/b.jpg", mime: "image/jpeg" } }),
    fila({ tipo: "text", contenido: {}, wa_message_id: "wamid.T" }),
  ];
  assertEquals(imagenesPendientes(filas, { ruta: "media/c/b.jpg", mime: "image/jpeg" }), [{ ruta: "media/c/b.jpg", mime: "image/jpeg" }]);
  assertEquals(imagenesPendientes(filas, { ruta: "media/c/actual.png", mime: "image/png" }).map((x) => x.ruta), ["media/c/b.jpg", "media/c/actual.png"]);
  assertEquals(imagenesPendientes(filas, null).map((x) => x.ruta), ["media/c/b.jpg"]);
  const album = [1, 2, 3, 4].map((n) => fila({ wa_message_id: `w${n}`, contenido: { storage_path: `media/c/${n}.jpg`, mime: "image/jpeg" } }));
  assertEquals(imagenesPendientes(album).map((x) => x.ruta), ["media/c/2.jpg", "media/c/3.jpg", "media/c/4.jpg"]);
});

Deno.test("imagenes: contenido con fotos adelante y el texto después", () => {
  const img = { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg", data: "AAAA" } };
  assertEquals(contenidoConImagenes("hola", []), "hola");
  assertEquals(contenidoConImagenes("[imagen] ¿tienen?", [img]), [img, { type: "text", text: "[imagen] ¿tienen?" }]);
});
