// pedidos-trabados · cancelaciones de Shopify → ventas de Voltra OS (Enrique 21-10-2026).
// Lee la vista ventas_cancelacion_shopify (migración 20261021000003). Cada 10 min:
//   · clase 'cancelar' (la venta no salió: sin despachado_at ni estado real del courier) → rpc cancelar_venta_por_shopify:
//     devuelve el stock, manda la venta a la papelera y la saca de Despacho.
//   · clase 'cancelado_en_courier' → NO se cancela sola: Telegram una vez por pedido.
//   · clase 'reemplazo_en_courier' → el pedido nuevo (REEMPLAZA_A_#n) no se carga como envío nuevo; Telegram informativo una vez.
import { db } from "../_shared/db.ts";
import { avisar, type OpcionesAviso } from "../_shared/telegram.ts";
import { tomarCandado } from "./io.ts";

export type ClaseCancelacion = "cancelar" | "cancelado_en_courier" | "reemplazo_en_courier";
export interface FilaCancelacion { shopify_order_id: number; nombre: string; clase: ClaseCancelacion; courier: string }

const NOMBRE_COURIER: Record<string, string> = { lucero: "Lucero", pap: "PaP" };

export function textoAviso(f: FilaCancelacion): string {
  const c = NOMBRE_COURIER[f.courier] ?? "el courier";
  return f.clase === "reemplazo_en_courier"
    ? `ℹ ${f.nombre} fue reemplazado por un pedido nuevo y el paquete ya está en ${c}: el nuevo no se carga como envío aparte. Si cambió el total o el producto, avisale a ${c}.`
    : `⚠ ${f.nombre} cancelado por el cliente pero ya está en ${c}: pedir que lo retengan o devuelvan`;
}

/**
 * 27-10: tipo y destino (telegram_politica.ts). Cancelado ya en el courier (#48): misma clave que wa-webhook
 * (shopify_order_id) y unaVezPorDia, así sale una sola vez aunque lo detecten los dos. Reemplazo (#15): cambia qué se despacha.
 */
export function opcionesAviso(f: FilaCancelacion): OpcionesAviso {
  return f.clase === "reemplazo_en_courier"
    ? { tipo: "reemplazo_en_courier", destino: "enrique", pedido: f.nombre }
    : { tipo: "cancelado_en_courier", destino: "enrique", pedido: f.nombre, clave: String(f.shopify_order_id), unaVezPorDia: true };
}

export async function filasCancelacion(): Promise<FilaCancelacion[]> {
  const { data, error } = await db().from("ventas_cancelacion_shopify")
    .select("shopify_order_id,nombre,ref,clase,courier_real,transportadora");
  if (error) throw new Error(`ventas_cancelacion_shopify: ${error.message}`);
  return (data ?? []).map((x: Record<string, unknown>) => ({
    shopify_order_id: Number(x.shopify_order_id), nombre: String(x.nombre), clase: x.clase as ClaseCancelacion,
    courier: String(x.courier_real ?? x.transportadora ?? ""),
    ref: String(x.ref),
  } as FilaCancelacion & { ref: string }));
}

export async function sincronizarCancelaciones(simular = false) {
  const filas = (await filasCancelacion()) as Array<FilaCancelacion & { ref: string }>;
  const hechos: Array<{ pedido: string; clase: string; resultado: string }> = [];
  for (const f of filas) {
    if (simular) { hechos.push({ pedido: f.nombre, clase: f.clase, resultado: "simulado" }); continue; }
    if (f.clase === "cancelar") {
      const { data, error } = await db().rpc("cancelar_venta_por_shopify", { p_ref: f.ref });
      hechos.push({ pedido: f.nombre, clase: f.clase, resultado: error ? `error: ${error.message}` : JSON.stringify(data) });
      continue;
    }
    const candado = `auto_${f.clase}:${f.shopify_order_id}`;
    if (!(await tomarCandado(candado, { pedido: f.nombre, clase: f.clase }))) continue; // ya avisado
    let ultimo = "";
    for (let i = 0; i < 3; i++) {
      const r = await avisar(textoAviso(f), undefined, opcionesAviso(f));
      if (r.ok) { ultimo = ""; break; }
      ultimo = r.error ?? "Telegram falló";
      await new Promise((z) => setTimeout(z, 1500));
    }
    if (ultimo) await db().from("eventos_crudos").delete().eq("fuente", "shopify").eq("id_externo", candado); // se reintenta en 10 min
    hechos.push({ pedido: f.nombre, clase: f.clase, resultado: ultimo ? `Telegram: ${ultimo}` : "avisado" });
  }
  return hechos;
}
