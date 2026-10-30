// pago-ueno-email · Edge Function (verify_jwt = false). 29-10-2026, pedido de Enrique: "quiero que transferencias se
// verifiquen automatico 24/7". La llama un Apps Script de voltraparaguay@gmail.com (corre en Google, sin la Mac) con
// cada correo "Transferencia recibida" de ueno: { id, cuerpo }. Autenticación: header x-voltra-secret = UENO_EMAIL_SECRET.
// Lee el aviso (logica.ts) y lo pasa a pago-verificado en modo sin pedido (nro > celular > titular; ambiguo → "Es este").
// Repetidos: el script etiqueta lo ya enviado y pago-verificado no usa dos veces la misma transferencia.
// Vuelta atrás: borrar el disparador del Apps Script (o el secreto UENO_EMAIL_SECRET); la tarea de la Mac sigue.
import { db } from "../_shared/db.ts";
import { igualesSeguro } from "../_shared/telegram.ts";
import { parsearAvisoUeno } from "./logica.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("método no permitido", { status: 405 });
  const secreto = Deno.env.get("UENO_EMAIL_SECRET") ?? "";
  if (!secreto || !igualesSeguro(req.headers.get("x-voltra-secret") ?? "", secreto)) {
    return Response.json({ ok: false, error: "no autorizado" }, { status: 401 });
  }
  const b = await req.json().catch(() => null) as { id?: string; cuerpo?: string } | null;
  const aviso = parsearAvisoUeno(String(b?.cuerpo ?? ""));
  if (!aviso) return Response.json({ ok: true, ignorado: true, id: b?.id ?? null });
  const { data, error } = await db().functions.invoke("pago-verificado", { body: { ...aviso, origen: "gmail_ueno_24h" } });
  // pago-verificado responde 422 en ambiguo/sin candidatos (ya avisó a Enrique): no es un error del correo.
  console.log("pago-ueno-email", JSON.stringify({ id: b?.id, monto: aviso.monto, fecha: aviso.fecha, con_nro: !!aviso.nro_transaccion, resultado: data?.error ?? (data?.ok ? "ok" : error?.message) }));
  return Response.json({ ok: true, id: b?.id ?? null, aviso: { monto: aviso.monto, fecha: aviso.fecha }, resultado: data ?? { error: error?.message } });
});
