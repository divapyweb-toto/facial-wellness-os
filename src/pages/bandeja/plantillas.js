// Definiciones de las plantillas (texto aprobado) para dibujar lo que se envió.
// En wa_mensajes solo quedan los parámetros; el texto sale de supabase/plantillas.
const mods = import.meta.glob('../../../supabase/plantillas/*.json', { eager: true })
export const PLANTILLAS = Object.fromEntries(
  Object.values(mods).map(m => m.default || m).filter(d => d?.name).map(d => [d.name, d]),
)
