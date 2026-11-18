// pedidos-trabados · avisos DIRECTOS a la transportadora por WhatsApp (Enrique 18-11: que el bot avise a las transportadoras
// desde el número de Voltra, sin copiar y pegar). Interruptor config_wa.transportadoras.avisos_por_whatsapp: si falta o no es
// true, todo sale por el Telegram de siempre.
// El envío real (ventana de 24 h o plantilla voltra_aviso_transportadora, candado por clave, registro en wa_mensajes y la red
// de seguridad de 3 h sin leído) es de _shared/courier_wa.ts (WhatsApp API). Acá solo: si va por WhatsApp, con qué texto
// (el que hoy Enrique reenvía, en texto plano, nunca el Telegram para Enrique) y con qué clave; si falla, el Telegram de siempre.
import type { OpcionesAviso } from "../_shared/telegram_politica.ts";
import { diaPy } from "./entregas_actuar.ts";

export type CourierWa = "lucero" | "pap";
export type EnviarACourier = (a: { courier: CourierWa; ref: string; texto: string; clave: string }) =>
  Promise<{ ok: boolean; wamid?: string; error?: string }>;
type Avisar = (texto: string, botones?: undefined, opts?: OpcionesAviso) => Promise<{ ok: boolean; error?: string }>;
export type ResultadoAvisoCourier = { ok: boolean; error?: string; via: "whatsapp" | "telegram"; errorWhatsapp?: string };

/** Canal hacia la transportadora. `enviar` falta hasta que _shared/courier_wa.ts esté conectado: ahí todo va por Telegram. */
export interface CanalCourier { activo: boolean; enviar?: EnviarACourier }

/** config_wa.transportadoras → ¿avisar por WhatsApp? Solo `true` explícito prende. */
export function avisosPorWhatsapp(valorTransportadoras: unknown): boolean {
  return !!valorTransportadoras && typeof valorTransportadoras === "object" &&
    (valorTransportadoras as Record<string, unknown>).avisos_por_whatsapp === true;
}

export const courierWa = (c: string | null | undefined): CourierWa | null => {
  const x = String(c ?? "").trim().toLowerCase();
  return x === "lucero" || x === "pap" ? x : null;
};

/** Clave estable: tipo + pedido (o lote) + día de Paraguay. */
export const claveAvisoCourier = (ref: string, tipo: string, ahora: Date) => `${tipo}:${ref}:${diaPy(ahora)}`;

/**
 * Devuelve un `avisar` con la misma firma: si el canal está prendido y conectado y el courier es Lucero o PaP, manda
 * `textoCourier` por WhatsApp a la transportadora (nada a Enrique); si no aplica o falla, avisa a Enrique con su texto de siempre.
 */
export function avisarPorCourier(
  canal: CanalCourier | undefined, base: Avisar, a: { courier: string; ref: string; textoCourier: string; clave: string },
) {
  return async (textoEnrique: string, botones?: undefined, opts?: OpcionesAviso): Promise<ResultadoAvisoCourier> => {
    const courier = courierWa(a.courier);
    let errorWhatsapp: string | undefined;
    if (canal?.activo && canal.enviar && courier) {
      try {
        const r = await canal.enviar({ courier, ref: a.ref, texto: a.textoCourier, clave: a.clave });
        if (r.ok) return { ok: true, via: "whatsapp" };
        errorWhatsapp = r.error ?? "WhatsApp falló";
      } catch (e) {
        errorWhatsapp = e instanceof Error ? e.message : String(e);
      }
    }
    const r = await base(textoEnrique, botones, opts);
    return { ...r, via: "telegram", ...(errorWhatsapp ? { errorWhatsapp } : {}) };
  };
}
