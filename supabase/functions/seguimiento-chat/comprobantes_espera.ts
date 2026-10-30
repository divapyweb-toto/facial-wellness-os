// seguimiento-chat · comprobantes en espera (29-10, Enrique: "arregla lo del comprobante de pago").
// wa-webhook marca el mensaje del comprobante con contenido.aviso_comprobante_pendiente (vence = llegada + 40 min, o
// a las 7:40 si cae de noche). En cada corrida (cada 10 min): si el pedido ya figura pagado (lo cruzó la tarea
// voltra-verificar-pagos-ueno con el correo de ueno, o Enrique tocó "Recibido") → se cierra sin aviso; si venció y
// sigue sin pagar → UN Telegram a Enrique con la foto y el botón "Recibido" (el mismo de siempre). Se marca
// contenido.aviso_comprobante_resuelto para no repetir; si Telegram falla, queda para la próxima corrida.
import { db } from "../_shared/db.ts";
import { avisarConArchivo, avisar, type OpcionesAviso } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { pedidoPagado } from "../_shared/pago_anticipado.ts";
import { decidirEspera } from "../_shared/comprobante.ts";

export type Pendiente = {
  id: string;
  contenido: Record<string, unknown>;
  aviso: { pedido: string; etiqueta?: string; total?: string; mime?: string; vence: string; media_id?: string };
};

export type DepsEspera = {
  ahora: Date;
  /** null = el pedido no está en la base. */
  pedido(orderId: string): Promise<{ tags: unknown; raw: unknown; cancelado: boolean } | null>;
  /** ¿la tarea de ueno ya registró un pago para este pedido? */
  verificadoAuto(orderId: string): Promise<boolean>;
  avisar(p: Pendiente, storagePath: string | null): Promise<{ ok: boolean; error?: string }>;
  marcar(p: Pendiente, resuelto: Record<string, unknown>): Promise<void>;
};

export async function procesarComprobantesEspera(filas: Pendiente[], d: DepsEspera) {
  const r = { pagados: 0, avisados: 0, esperando: 0, cancelados: 0, fallas: [] as string[] };
  for (const f of filas) {
    try {
      const ped = await d.pedido(f.aviso.pedido);
      if (!ped || ped.cancelado) {
        await d.marcar(f, { estado: "pedido_cancelado_o_sin_pedido", en: d.ahora.toISOString() });
        r.cancelados++;
        continue;
      }
      const pagado = pedidoPagado(ped) || await d.verificadoAuto(f.aviso.pedido);
      const est = decidirEspera({ pagado, vence: new Date(f.aviso.vence), ahora: d.ahora });
      if (est === "esperar") {
        r.esperando++;
        continue;
      }
      if (est === "pagado") {
        await d.marcar(f, { estado: "pagado", en: d.ahora.toISOString() });
        r.pagados++;
        continue;
      }
      const a = await d.avisar(f, typeof f.contenido.storage_path === "string" ? f.contenido.storage_path : null);
      if (!a.ok) {
        r.fallas.push(`${f.aviso.etiqueta ?? f.aviso.pedido}: ${a.error ?? "Telegram falló"}`);
        continue; // se reintenta en la próxima corrida
      }
      await d.marcar(f, { estado: "avisado", en: d.ahora.toISOString() });
      r.avisados++;
    } catch (e) {
      r.fallas.push(`${f.aviso.pedido}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return r;
}

/** Texto del aviso (HTML ya escapado). */
export function textoAvisoComprobante(a: Pendiente["aviso"]): string {
  const et = escaparHtml(a.etiqueta ?? `#${a.pedido}`);
  return [
    `💸 <b>${et}</b>: el cliente mandó un comprobante y en 40 min no apareció la transferencia en ueno.`,
    `Monto a verificar: Gs ${escaparHtml(a.total ?? "?")} (total del pedido).`,
    "Verificalo y tocá Recibido. Hasta que lo toques, el pedido no cambia.",
  ].join("\n");
}

const BOTONES = (id: string) => [[{ texto: "Recibido", callback: `pagado:${id}` }], [{ texto: "Le escribo yo", callback: `escribo:${id}` }]];

export async function correrComprobantesEspera(ahora = new Date()) {
  const desde = new Date(ahora.getTime() - 3 * 86_400_000).toISOString();
  const { data, error } = await db().from("wa_mensajes").select("id,contenido")
    .not("contenido->aviso_comprobante_pendiente", "is", null)
    .is("contenido->aviso_comprobante_resuelto", null)
    .gte("creado_en", desde).limit(50);
  if (error) throw new Error(`wa_mensajes: ${error.message}`);
  const filas: Pendiente[] = (data ?? []).map((x: { id: string; contenido: Record<string, unknown> }) => ({
    id: x.id, contenido: x.contenido, aviso: x.contenido.aviso_comprobante_pendiente as Pendiente["aviso"],
  })).filter((f) => f.aviso?.pedido && f.aviso?.vence);
  if (!filas.length) return null;
  return await procesarComprobantesEspera(filas, {
    ahora,
    async pedido(orderId) {
      const { data: p } = await db().from("shopify_pedidos").select("tags,raw").eq("shopify_order_id", orderId).maybeSingle();
      if (!p) return null;
      const raw = (p.raw ?? {}) as Record<string, unknown>;
      return { tags: p.tags, raw, cancelado: !!raw.cancelled_at };
    },
    async verificadoAuto(orderId) {
      const { data: v } = await db().from("pagos_verificados").select("id").eq("shopify_order_id", orderId).limit(1);
      return !!v?.length;
    },
    async avisar(p, ruta) {
      const opts: OpcionesAviso = { tipo: "comprobante_pago", destino: "enrique", pedido: p.aviso.etiqueta ?? p.aviso.pedido, clave: p.aviso.pedido };
      const texto = textoAvisoComprobante(p.aviso);
      if (ruta) {
        const { data: f, error: e } = await db().storage.from("wa-media").download(ruta);
        if (!e && f) {
          const ext = ruta.split(".").pop() ?? "jpg";
          return await avisarConArchivo(texto, { bytes: new Uint8Array(await f.arrayBuffer()), mime: p.aviso.mime ?? f.type, nombre: `comprobante-${p.aviso.pedido}.${ext}` }, BOTONES(p.aviso.pedido), opts);
        }
      }
      return await avisar(`${texto}\nComprobante: ${escaparHtml(ruta ? `Storage wa-media/${ruta}` : `media ${p.aviso.media_id ?? "?"}`)}`, BOTONES(p.aviso.pedido), opts);
    },
    async marcar(p, resuelto) {
      const { error: e } = await db().from("wa_mensajes").update({ contenido: { ...p.contenido, aviso_comprobante_resuelto: resuelto } }).eq("id", p.id);
      if (e) throw new Error(`marcar ${p.id}: ${e.message}`);
    },
  });
}
