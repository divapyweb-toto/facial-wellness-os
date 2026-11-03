// factura-recibida-email · Edge Function (verify_jwt = false). 03-11-2026, pedido de Enrique: la contadora necesita en
// papel todas las facturas a nombre de Voltra. Las electrónicas llegan a voltraparaguay@gmail.com; un Apps Script
// (scripts/apps-script/facturas-recibidas.gs, mismo proyecto que pago-ueno-email.gs) manda cada correo con adjuntos:
//   { id (gmail), remitente, asunto, fecha ISO, adjuntos: [{ nombre, tipo, base64 }] }  — solo PDF/XML, ≤5 MB, ≤6.
// Autenticación: header x-voltra-secret = UENO_EMAIL_SECRET (el mismo secreto del script de ueno).
// Hace: sube cada adjunto a facturas/recibidas/<id>/<nombre>, lee el XML de SIFEN (logica.ts) y hace upsert por gmail_id
// en public.facturas_recibidas (repetido = no duplica). Otro receptor → descartada = true.
// Respuestas: 200 { ok, id, guardada, pdf, xml, es_de_voltra } · 401 secreto · 400 cuerpo · 500 Storage/base (el
// script no etiqueta y reintenta en la pasada siguiente).
// Vuelta atrás: desinstalarFacturas() en el Apps Script; la tabla y los archivos quedan (no se borra nada).
import { db } from "../_shared/db.ts";
import { igualesSeguro } from "../_shared/telegram.ts";
import { armarFila, prepararAdjuntos, validarCuerpo } from "./logica.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("método no permitido", { status: 405 });
  const secreto = Deno.env.get("UENO_EMAIL_SECRET") ?? "";
  if (!secreto || !igualesSeguro(req.headers.get("x-voltra-secret") ?? "", secreto)) {
    return Response.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }
  const v = validarCuerpo(await req.json().catch(() => null));
  if (!v.ok) return Response.json({ ok: false, error: v.error }, { status: 400 });
  const c = v.datos;

  const { listos, omitidos } = prepararAdjuntos(c.id, c.adjuntos);
  if (listos.length === 0) {
    // Nada que guardar (ej. solo imágenes): 200 para que el script lo etiquete y no lo mande de nuevo.
    console.log("factura-recibida-email", JSON.stringify({ id: c.id, guardada: false, omitidos }));
    return Response.json({ ok: true, id: c.id, guardada: false, pdf: false, xml: false, es_de_voltra: null, omitidos });
  }

  try {
    for (const a of listos) {
      const { error } = await db().storage.from("facturas").upload(a.ruta, a.bytes, { contentType: a.contentType, upsert: true });
      if (error) throw new Error(`storage ${a.ruta}: ${error.message}`);
    }
    const fila = armarFila(c, listos);
    const { error } = await db().from("facturas_recibidas").upsert(fila, { onConflict: "gmail_id" });
    if (error) throw new Error(`base: ${error.message}`);
    console.log("factura-recibida-email", JSON.stringify({
      id: c.id, guardada: true, pdf: !!fila.pdf_path, xml: !!fila.xml_path, es_de_voltra: fila.es_de_voltra,
      numero: fila.numero, omitidos,
    }));
    return Response.json({
      ok: true, id: c.id, guardada: true, pdf: !!fila.pdf_path, xml: !!fila.xml_path, es_de_voltra: fila.es_de_voltra,
      ...(omitidos.length ? { omitidos } : {}),
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("factura-recibida-email", JSON.stringify({ id: c.id, error }));
    return Response.json({ ok: false, id: c.id, error }, { status: 500 });
  }
});
