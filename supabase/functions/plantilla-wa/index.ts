// plantilla-wa · herramienta de administración (solo service role): {modo:"estado", nombre} | {modo:"enviar", plantilla:{…}}
// | {modo:"subir_ejemplo", base64, tipo, archivo} (29-10: header_handle para plantillas con PDF/imagen).
// Existe porque las credenciales de WhatsApp viven solo en los secretos de las funciones (scripts/crear-plantillas-wa.mjs
// necesita WA_TOKEN en el entorno local). No decide nada: manda o consulta lo que se le pide.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { enviarPlantilla, estadoPlantilla, subirEjemplo } from "../_shared/plantilla_meta.ts";

Deno.serve(conServiceRole(async (req) => {
  const b = await req.json().catch(() => ({})) as { modo?: string; nombre?: string; plantilla?: Record<string, unknown>; base64?: string; tipo?: string; archivo?: string };
  if (b.modo === "estado" && b.nombre) return Response.json(await estadoPlantilla(b.nombre));
  if (b.modo === "enviar" && b.plantilla && typeof b.plantilla.name === "string") return Response.json(await enviarPlantilla(b.plantilla));
  if (b.modo === "subir_ejemplo" && b.base64) {
    const bytes = Uint8Array.from(atob(b.base64), (c) => c.charCodeAt(0));
    return Response.json(await subirEjemplo(bytes, b.tipo ?? "application/pdf", b.archivo ?? "ejemplo.pdf"));
  }
  return Response.json({ ok: false, error: "modo inválido" }, { status: 400 });
}));
