// _shared · I/O de aviso_courier_wa.ts: lee el interruptor config_wa.transportadoras.avisos_por_whatsapp (solo lectura).
// PENDIENTE: conectar `enviar` con enviarACourier de _shared/courier_wa.ts (WhatsApp API) cuando esté en el repo. Hasta entonces,
// aunque el interruptor esté en true, todo sigue por el Telegram de siempre.
import { db } from "./db.ts";
import { avisosPorWhatsapp, type CanalCourier } from "./aviso_courier_wa.ts";

export async function leerCanalCourier(): Promise<CanalCourier> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "transportadoras").maybeSingle();
  if (error) return { activo: false };
  return { activo: avisosPorWhatsapp(data?.valor ?? null) };
}
