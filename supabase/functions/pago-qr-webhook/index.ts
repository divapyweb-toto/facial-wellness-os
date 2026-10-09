// pago-qr-webhook · recibe las notificaciones de pago del proveedor QR (AdamsPay / arnipay / simulador).
// Necesita verify_jwt = false en supabase/config.toml (el proveedor no manda JWT de Supabase): la
// autenticación es la firma del proveedor, que se verifica ANTES de leer o guardar nada.
// Orden: firma → guardar crudo (descarta repetidos) → procesar → 200 (o 500 + marca borrada si falla).

import { verificarWebhookQR } from "../_shared/pago_qr.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { atenderEventoQR, procesarPagoQR } from "./procesar.ts";
import { borrarEventoQR, depsReales, guardarEventoQR, leerConfigQR, marcarEventoProcesado } from "./io.ts";

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
    // La bandera NO se mira acá: solo frena crear cobros nuevos. Se procesa en línea (no waitUntil)
    // para poder devolver 500 si falla y que el proveedor reintente.
    const prov = v.proveedor, ev = v.evento;
    const r = await atenderEventoQR({
      guardarEvento: () => guardarEventoQR(prov, ev.id_evento, JSON.parse(raw)),
      procesar: () => procesarPagoQR(prov, ev, cfg, depsReales),
      marcarProcesado: (err) => marcarEventoProcesado(prov, ev.id_evento, err),
      borrarEvento: () => borrarEventoQR(prov, ev.id_evento),
      avisar: (t) => avisar(t),
      escapar: escaparHtml,
    }, ev.id_evento);
    return Response.json(r.cuerpo, { status: r.status });
  } catch (e) {
    console.error("pago-qr-webhook:", e);
    return Response.json({ ok: false, error: "interno" }, { status: 500 });
  }
});
