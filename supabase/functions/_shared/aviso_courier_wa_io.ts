// _shared · I/O de aviso_courier_wa.ts: lee el interruptor config_wa.transportadoras.avisos_por_whatsapp (solo lectura).
// 18-11: `enviar` = enviarACourier de _shared/courier_wa.ts (WhatsApp API: ventana o plantilla, candado por clave, respaldo por
// "no leído" con Telegram courier_no_leyo). Solo se usa si el interruptor está en true.
import { db } from "./db.ts";
import { adaptarResultadoCourier, avisosPorWhatsapp, type CanalCourier } from "./aviso_courier_wa.ts";
import { enviarACourier } from "./courier_wa.ts";

export async function leerCanalCourier(): Promise<CanalCourier> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "transportadoras").maybeSingle();
  if (error) return { activo: false };
  return { activo: avisosPorWhatsapp(data?.valor ?? null), enviar: async (a) => adaptarResultadoCourier(await enviarACourier(a)) };
}
