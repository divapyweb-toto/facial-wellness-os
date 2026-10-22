// plantilla-wa · herramienta de administración (solo service role): {modo:"estado", nombre} | {modo:"enviar", plantilla:{…}}.
// Existe porque las credenciales de WhatsApp viven solo en los secretos de las funciones (scripts/crear-plantillas-wa.mjs
// necesita WA_TOKEN en el entorno local). No decide nada: manda o consulta lo que se le pide.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { enviarPlantilla, estadoPlantilla } from "../_shared/plantilla_meta.ts";

Deno.serve(conServiceRole(async (req) => {
  const b = await req.json().catch(() => ({})) as { modo?: string; nombre?: string; plantilla?: Record<string, unknown> };
  if (b.modo === "estado" && b.nombre) return Response.json(await estadoPlantilla(b.nombre));
  if (b.modo === "enviar" && b.plantilla && typeof b.plantilla.name === "string") return Response.json(await enviarPlantilla(b.plantilla));
  return Response.json({ ok: false, error: "modo inválido" }, { status: 400 });
}));
