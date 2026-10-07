// pago-qr-webhook · recibe las notificaciones de pago del proveedor QR (AdamsPay / arnipay / simulador).
// Necesita verify_jwt = false en supabase/config.toml (el proveedor no manda JWT de Supabase): la
// autenticación es la firma del proveedor, que se verifica ANTES de leer o guardar nada.
// Orden: firma → bandera → guardar crudo (descarta repetidos) → 200 rápido → procesar con waitUntil.

import { verificarWebhookQR } from "../_shared/pago_qr.ts";
import { procesarPagoQR } from "./procesar.ts";
import { depsReales, guardarEventoQR, leerConfigQR, marcarEventoProcesado } from "./io.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/** Rutas con las que el proveedor pudo firmar (Supabase puede quitar el prefijo /functions/v1). */
export function urisCandidatas(url: string): string[] {
  const u = new URL(url);
  const ruta = u.pathname + u.search;
  const conPrefijo = u.pathname.startsWith("/functions/v1/") ? ruta : `/functions/v1${u.pathname.startsWith("/") ? "" : "/"}${ruta}`;
  const sinPrefijo = ruta.replace(/^\/functions\/v1/, "");
  return [...new Set([ruta, conPrefijo, sinPrefijo])];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("método no permitido", { status: 405 });
  const raw = await req.text();
  const v = await verificarWebhookQR(raw, req.headers, { metodo: "POST", uris: urisCandidatas(req.url) });
  if (!v.ok || !v.evento || !v.proveedor) {
    console.warn("pago-qr-webhook: rechazado", v.proveedor ?? "", v.error);
    return Response.json({ ok: false, error: v.error }, { status: 401 });
  }
  try {
    const cfg = await leerConfigQR();
    if (!cfg.activo) return Response.json({ ok: true, ignorado: "bandera_apagada" });
    const nuevo = await guardarEventoQR(v.proveedor, v.evento.id_evento, JSON.parse(raw));
    if (!nuevo) return Response.json({ ok: true, repetido: true });
    const tarea = procesarPagoQR(v.proveedor, v.evento, cfg, depsReales)
      .then(() => marcarEventoProcesado(v.proveedor!, v.evento!.id_evento, null))
      .catch((e) => marcarEventoProcesado(v.proveedor!, v.evento!.id_evento, e instanceof Error ? e.message : String(e)));
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(tarea);
    else await tarea;
    return Response.json({ ok: true });
  } catch (e) {
    console.error("pago-qr-webhook:", e);
    return Response.json({ ok: false, error: "interno" }, { status: 500 });
  }
});
