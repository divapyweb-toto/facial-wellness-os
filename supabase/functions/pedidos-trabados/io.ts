// pedidos-trabados · I/O real: pedidos abiertos de Supabase, candados en eventos_crudos y acciones en Shopify.
import { db } from "../_shared/db.ts";
import { gql } from "../_shared/shopify.ts";
import type { Accion, PedidoAbierto } from "./logica.ts";

type Obj = Record<string, unknown>;
const txt = (v: unknown) => (typeof v === "string" ? v : "");

/** Pedidos de los últimos 14 días, no borrador, ni cancelados ni preparados en Shopify. */
export async function pedidosAbiertos(ahora: Date): Promise<PedidoAbierto[]> {
  const desde = new Date(ahora.getTime() - 14 * 24 * 3_600_000).toISOString();
  const { data, error } = await db().from("shopify_pedidos")
    .select("shopify_order_id,nombre,estado_confirmacion,tags,actualizado_en,raw")
    .eq("es_borrador", false).gte("creado_en", desde);
  if (error) throw new Error(`shopify_pedidos: ${error.message}`);
  return (data ?? []).flatMap((p) => {
    const r = (p.raw ?? {}) as Obj;
    if (r.cancelled_at || r.cancelledAt) return [];
    const ful = txt(r.fulfillment_status || r.displayFulfillmentStatus).toLowerCase();
    if (ful === "fulfilled") return [];
    const dir = (r.shipping_address ?? r.shippingAddress ?? {}) as Obj;
    const attrs = (r.note_attributes ?? r.customAttributes ?? []) as Array<{ name?: string; key?: string; value?: string }>;
    return [{
      shopifyOrderId: Number(p.shopify_order_id),
      nombre: String(p.nombre ?? p.shopify_order_id),
      estado: p.estado_confirmacion ?? null,
      tags: (p.tags ?? []) as string[],
      actualizadoEn: p.actualizado_en ?? null,
      direccion: [txt(dir.address1), txt(dir.address2)].filter(Boolean).join(", "),
      ciudad: txt(dir.city),
      notas: [txt(r.note), ...attrs.map((a) => `${a.name ?? a.key ?? ""}: ${a.value ?? ""}`)].join("\n"),
    }];
  });
}

export const idCandadoAuto = (accion: Accion, orderId: number) => `auto_${accion}:${orderId}`;

/** Candados auto_* ya tomados para estos pedidos. */
export async function candadosTomados(ids: number[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const claves = ids.flatMap((id) => (["agregar_confirmado", "cancelar", "agregar_faltan_datos", "quitar_faltan_datos"] as Accion[]).map((a) => idCandadoAuto(a, id)));
  const { data, error } = await db().from("eventos_crudos").select("id_externo").eq("fuente", "shopify").in("id_externo", claves);
  if (error) throw new Error(`eventos_crudos: ${error.message}`);
  return new Set((data ?? []).map((x) => x.id_externo as string));
}

/** Toma el candado (false si ya existía). */
export async function tomarCandado(id: string, payload: Obj): Promise<boolean> {
  const { error } = await db().from("eventos_crudos").insert({ fuente: "shopify", id_externo: id, payload, procesado_en: new Date().toISOString() });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`eventos_crudos: ${error.message}`);
}

export async function registrarError(id: string, mensaje: string): Promise<void> {
  await db().from("eventos_crudos").update({ error: mensaje }).eq("fuente", "shopify").eq("id_externo", id);
}

const errores = (u: Array<{ message: string }> | undefined) => (u ?? []).map((e) => e.message).join("; ") || null;

export async function etiqueta(orderId: number, tag: string, agregar: boolean): Promise<string | null> {
  const m = agregar ? "tagsAdd" : "tagsRemove";
  const r = await gql<Record<string, { userErrors: Array<{ message: string }> }>>(
    `mutation($id: ID!, $tags: [String!]!) { ${m}(id: $id, tags: $tags) { userErrors { message } } }`,
    { id: `gid://shopify/Order/${orderId}`, tags: [tag] },
  );
  return errores(r[m]?.userErrors);
}

/** Cancela en Shopify sin avisar al cliente, sin reembolso (COD: no cobró) y devolviendo el stock. */
export async function cancelarEnShopify(orderId: number): Promise<string | null> {
  const r = await gql<{ orderCancel: { orderCancelUserErrors: Array<{ message: string }> } }>(
    `mutation($id: ID!) { orderCancel(orderId: $id, reason: CUSTOMER, refund: false, restock: true, notifyCustomer: false) { orderCancelUserErrors { message } } }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  return errores(r.orderCancel.orderCancelUserErrors);
}

export async function ejecutar(accion: Accion, orderId: number): Promise<string | null> {
  if (accion === "agregar_confirmado") return await etiqueta(orderId, "CONFIRMADO", true);
  if (accion === "agregar_faltan_datos") return await etiqueta(orderId, "FALTAN_DATOS", true);
  if (accion === "quitar_faltan_datos") return await etiqueta(orderId, "FALTAN_DATOS", false);
  return await cancelarEnShopify(orderId);
}
