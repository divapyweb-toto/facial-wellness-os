// pedidos-trabados · activa sola la plantilla voltra_entrega_reprogramar cuando Meta la aprueba (Enrique 22-10-2026).
// Mientras está pendiente, cada corrida de 10 min consulta su estado en Meta (barato). Al figurar APPROVED:
//   · config `reprogramar_lucero` = {"plantilla_aprobada": true, ...}: desde ahí importar-courier manda ESA plantilla en la
//     falla de Lucero, en lugar del aviso de reintento (UN solo mensaje por falla, misma clave courier:<id>:INTENTO_FALLIDO:<fecha>);
//   · Telegram "quedó activa" una sola vez (candado). Si Meta la rechaza, Telegram una sola vez y no se activa.
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { estadoPlantilla } from "../_shared/plantilla_meta.ts";
import { tomarCandado } from "./io.ts";

export const PLANTILLA = "voltra_entrega_reprogramar";
export const CLAVE_CONFIG = "reprogramar_lucero";

export interface DepsActivar {
  leerConfig(): Promise<unknown>;
  estado(nombre: string): Promise<{ estado: string | null; error?: string }>;
  guardarConfig(valor: Record<string, unknown>): Promise<void>;
  candado(id: string): Promise<boolean>;
  telegram(texto: string): Promise<boolean>;
  ahora(): Date;
}

export const yaActiva = (valor: unknown): boolean => {
  try {
    const j = (typeof valor === "string" ? JSON.parse(valor) : valor) as { plantilla_aprobada?: boolean } | null;
    return j?.plantilla_aprobada === true;
  } catch {
    return false;
  }
};

export async function activarPlantillaReprogramar(d: DepsActivar, simular = false): Promise<{ resultado: string }> {
  if (yaActiva(await d.leerConfig())) return { resultado: "ya_activa" };
  const { estado, error } = await d.estado(PLANTILLA);
  if (error) return { resultado: `sin_dato: ${error}` };
  if (estado === "APPROVED") {
    if (simular) return { resultado: "se_activaría" };
    await d.guardarConfig({ plantilla_aprobada: true, activada_en: d.ahora().toISOString() });
    if (await d.candado(`auto_plantilla_activa:${PLANTILLA}`)) {
      await d.telegram(`✅ La plantilla <b>${PLANTILLA}</b> fue aprobada por Meta y quedó ACTIVA: desde ahora, cada entrega fallida de Lucero manda UN solo mensaje al cliente (Lucero reintenta el próximo día hábil y pide confirmar el horario; si el motivo es la ubicación, pide el pin). Reemplaza al aviso de reintento anterior.`);
    }
    return { resultado: "activada" };
  }
  if (estado === "REJECTED") {
    if (!simular && await d.candado(`auto_plantilla_rechazada:${PLANTILLA}`)) {
      await d.telegram(`⚠ Meta RECHAZÓ la plantilla <b>${PLANTILLA}</b>. Sigue el aviso de reintento de siempre. Hay que ajustar el texto y volver a mandarla.`);
    }
    return { resultado: "rechazada" };
  }
  return { resultado: `pendiente (${estado ?? "no existe"})` };
}

export const depsReales: DepsActivar = {
  leerConfig: async () => (await db().from("config").select("valor").eq("clave", CLAVE_CONFIG).maybeSingle()).data?.valor ?? null,
  estado: (n) => estadoPlantilla(n),
  guardarConfig: async (valor) => {
    const { error } = await db().from("config").upsert({ clave: CLAVE_CONFIG, valor: JSON.stringify(valor) }, { onConflict: "clave" });
    if (error) throw new Error(`config: ${error.message}`);
  },
  candado: (id) => tomarCandado(id, { plantilla: PLANTILLA }),
  telegram: async (t) => (await avisar(t)).ok,
  ahora: () => new Date(),
};
