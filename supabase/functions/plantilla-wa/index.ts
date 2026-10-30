// plantilla-wa · herramienta de administración (solo service role): {modo:"estado", nombre} | {modo:"enviar", plantilla:{…}}
// | {modo:"subir_ejemplo", base64, tipo, archivo} (29-10: header_handle para plantillas con PDF/imagen)
// | {modo:"correo_prueba", para, kude_path?} (29-10: prueba de Resend; solo a casillas internas de Voltra).
// Existe porque las credenciales de WhatsApp viven solo en los secretos de las funciones (scripts/crear-plantillas-wa.mjs
// necesita WA_TOKEN en el entorno local). No decide nada: manda o consulta lo que se le pide.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { correoFactura, enviarCorreo } from "../_shared/correo.ts";
import { enviarPlantilla, estadoPlantilla, subirEjemplo } from "../_shared/plantilla_meta.ts";

const CASILLAS_INTERNAS = ["voltraparaguay@gmail.com", "j.eramirez025@gmail.com"];

Deno.serve(conServiceRole(async (req) => {
  const b = await req.json().catch(() => ({})) as { modo?: string; nombre?: string; plantilla?: Record<string, unknown>; base64?: string; tipo?: string; archivo?: string; para?: string; kude_path?: string };
  if (b.modo === "estado" && b.nombre) return Response.json(await estadoPlantilla(b.nombre));
  if (b.modo === "enviar" && b.plantilla && typeof b.plantilla.name === "string") return Response.json(await enviarPlantilla(b.plantilla));
  if (b.modo === "subir_ejemplo" && b.base64) {
    const bytes = Uint8Array.from(atob(b.base64), (c) => c.charCodeAt(0));
    return Response.json(await subirEjemplo(bytes, b.tipo ?? "application/pdf", b.archivo ?? "ejemplo.pdf"));
  }
  if (b.modo === "correo_prueba" && b.para) {
    if (!CASILLAS_INTERNAS.includes(b.para.trim().toLowerCase())) return Response.json({ ok: false, error: "solo a casillas internas" }, { status: 400 });
    const c = correoFactura({ nombre: "Voltra (prueba)", numeroCompleto: "001-001-0000001", total: 112000 });
    const url = b.kude_path ? (await db().storage.from("facturas").createSignedUrl(b.kude_path, 3600)).data?.signedUrl : undefined;
    return Response.json(await enviarCorreo({ para: b.para, asunto: `[PRUEBA] ${c.asunto ?? "Factura"}`, texto: c.texto, html: c.html, adjuntos: url ? [{ filename: "Factura 001-001-0000001.pdf", path: url }] : [] }));
  }
  return Response.json({ ok: false, error: "modo inválido" }, { status: 400 });
}));
