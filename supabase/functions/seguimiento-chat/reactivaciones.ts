// seguimiento-chat · cierre de las reactivaciones (21-10-2026, Enrique). Reglas en _shared/reactivaciones.ts.
// Cliente que dijo que no (decisión del webhook) o que no contestó hasta `vence`:
//   · en_courier → Telegram a Enrique para que el courier devuelva el paquete (no se toca Shopify: ya está anulado).
//   · reabrir → se cancela de verdad en Shopify (sin aviso, devolviendo stock) + Telegram.
// Una sola vez por pedido (candado reactivacion_cierre:<id>). Un "sí" no se cierra acá: lo hizo el webhook.
import {
  idCierreReactivacion,
  idDecisionReactivacion,
  leerReactivaciones,
  type Reactivacion,
  telegramNo,
} from "../_shared/reactivaciones.ts";

export type Cierre = { r: Reactivacion; motivo: "no" | "vencido" };

/** Puro. `decisiones`: id del pedido → resultado guardado; `cerrados`: pedidos con el candado de cierre ya tomado. */
export function cierresPendientes(lista: Reactivacion[], decisiones: ReadonlyMap<string, string>, cerrados: ReadonlySet<string>, ahora: Date): Cierre[] {
  const out: Cierre[] = [];
  for (const r of lista) {
    if (cerrados.has(r.shopify_order_id)) continue;
    const d = decisiones.get(r.shopify_order_id);
    if (d === "si") continue;
    if (d === "no") out.push({ r, motivo: "no" });
    else if (ahora.getTime() >= Date.parse(r.vence)) out.push({ r, motivo: "vencido" });
  }
  return out;
}

export type DepsReactivaciones = {
  config(): Promise<unknown>;
  /** Filas de eventos_crudos con esos id_externo (cualquier fuente): id_externo + payload. */
  eventos(ids: string[]): Promise<Array<{ id_externo: string; payload: unknown }>>;
  /** Toma un candado (false si ya existía). */
  tomar(id: string, payload: unknown): Promise<boolean>;
  cancelarEnShopify(orderId: number): Promise<string | null>;
  avisar(texto: string): Promise<unknown>;
};

export async function correrReactivaciones(deps: DepsReactivaciones, ahora: Date, simular: boolean) {
  const lista = leerReactivaciones(await deps.config());
  if (!lista.length) return { activas: 0, hechos: [] as Array<Record<string, unknown>> };
  const ids = lista.flatMap((r) => [idDecisionReactivacion(r.shopify_order_id), idCierreReactivacion(r.shopify_order_id)]);
  const filas = await deps.eventos(ids);
  const decisiones = new Map<string, string>();
  const cerrados = new Set<string>();
  for (const f of filas) {
    const dec = /^reactivacion:(\d+)$/.exec(f.id_externo);
    const cie = /^reactivacion_cierre:(\d+)$/.exec(f.id_externo);
    const res = (f.payload as { resultado?: unknown } | null)?.resultado;
    if (dec && typeof res === "string") decisiones.set(dec[1], res);
    if (cie) cerrados.add(cie[1]);
  }
  const hechos: Array<Record<string, unknown>> = [];
  for (const { r, motivo } of cierresPendientes(lista, decisiones, cerrados, ahora)) {
    if (simular) {
      hechos.push({ pedido: r.pedido, motivo, accion: r.modo === "reabrir" ? "cancelar" : "avisar" });
      continue;
    }
    if (!(await deps.tomar(idCierreReactivacion(r.shopify_order_id), { pedido: r.pedido, motivo }))) continue;
    // Sin respuesta: queda la decisión "vencido" (un "sí" tardío ya no reactiva; lo atiende el vendedor como siempre).
    if (motivo === "vencido") await deps.tomar(idDecisionReactivacion(r.shopify_order_id), { resultado: "vencido", en: ahora.toISOString() });
    let error: string | null = null;
    if (r.modo === "reabrir") error = await deps.cancelarEnShopify(Number(r.shopify_order_id)).catch((e) => String(e));
    const aviso = error ? `${telegramNo(r, motivo).replace("quedó cancelado en Shopify", "NO se pudo cancelar en Shopify")} (${error})` : telegramNo(r, motivo);
    await deps.avisar(aviso).catch((e) => console.error("reactivación: Telegram:", e));
    hechos.push({ pedido: r.pedido, motivo, accion: r.modo === "reabrir" ? "cancelar" : "avisar", ok: !error, ...(error ? { error } : {}) });
  }
  return { activas: lista.length, hechos };
}
