// stock-shopify · I/O: Supabase (lectura de stock y pedidos), Shopify (inventario), Telegram (alerta de stock bajo).
import { db } from "../_shared/db.ts";
import { gql } from "../_shared/shopify.ts";
import type { PedidoPendiente, Producto } from "./logica.ts";

type Obj = Record<string, unknown>;

export async function productos(): Promise<Producto[]> {
  const { data, error } = await db().from("productos")
    .select("id,nombre,stock_actual,es_combo,componente_1_id,componente_1_qty,componente_2_id,componente_2_qty").eq("activo", true);
  if (error) throw new Error(`productos: ${error.message}`);
  return (data ?? []).map((p: Obj) => ({
    id: String(p.id), nombre: String(p.nombre), stock: Number(p.stock_actual) || 0, esCombo: p.es_combo === true,
    componentes: [[p.componente_1_id, p.componente_1_qty], [p.componente_2_id, p.componente_2_qty]]
      .filter(([id]) => id).map(([id, q]) => ({ id: String(id), qty: Number(q) || 1 })),
  }));
}

/** Pedidos válidos (sin cancelar, sin pruebas) de los últimos 30 días que todavía no tienen venta en Voltra OS (= no descontados). */
export async function pendientesSinDescontar(): Promise<Array<PedidoPendiente & { nombre: string }>> {
  const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await db().from("shopify_pedidos")
    .select("nombre,tags,estado_confirmacion,es_borrador,raw->>cancelled_at,raw->>note,raw->line_items").gte("creado_en", desde).eq("es_borrador", false);
  if (error) throw new Error(`shopify_pedidos: ${error.message}`);
  const validos = (data ?? []).filter((p: Obj) => {
    const tags = ((p.tags ?? []) as string[]).map((t) => t.toUpperCase());
    return !p.cancelled_at && !/PRUEBA/i.test(String(p.nombre)) && !/PRUEBA/i.test(String(p.note ?? "")) &&
      !tags.some((t) => t.includes("PRUEBA") || t.startsWith("CANCELADO")) && !String(p.estado_confirmacion ?? "").startsWith("cancelado");
  });
  const refs = validos.map((p: Obj) => `VT-${String(p.nombre).replace(/^#/, "")}`);
  const conVenta = new Set<string>();
  for (let i = 0; i < refs.length; i += 200) {
    const { data: v, error: e } = await db().from("ventas").select("n_referencia").in("n_referencia", refs.slice(i, i + 200)).is("deleted_at", null);
    if (e) throw new Error(`ventas: ${e.message}`);
    for (const x of v ?? []) conVenta.add(String((x as Obj).n_referencia));
  }
  return validos.filter((p: Obj) => !conVenta.has(`VT-${String(p.nombre).replace(/^#/, "")}`)).map((p: Obj) => ({
    nombre: String(p.nombre),
    lineas: ((p.line_items ?? []) as Obj[]).map((l) => ({ titulo: String(l.title ?? l.name ?? ""), cantidad: Number(l.quantity) || 1 })),
  }));
}

export interface VarianteShopify { producto: string; inventoryItemId: string; tracked: boolean; cantidad: number; vendible: boolean }

const Q_INV = `query { products(first: 50, query: "status:active") { nodes { title variants(first: 10) { nodes {
  inventoryQuantity availableForSale inventoryItem { id tracked } } } } }
  locations(first: 10) { nodes { id isActive fulfillsOnlineOrders } } }`;

export async function inventarioShopify(): Promise<{ variantes: VarianteShopify[]; locationId: string }> {
  const d = await gql<{ products: { nodes: Obj[] }; locations: { nodes: Obj[] } }>(Q_INV);
  const loc = d.locations.nodes.find((l) => l.isActive && l.fulfillsOnlineOrders) ?? d.locations.nodes.find((l) => l.isActive);
  if (!loc) throw new Error("Shopify: no hay ubicación activa");
  const variantes: VarianteShopify[] = [];
  for (const p of d.products.nodes) {
    for (const v of ((p.variants as Obj).nodes as Obj[])) {
      const it = v.inventoryItem as Obj;
      variantes.push({ producto: String(p.title), inventoryItemId: String(it.id), tracked: it.tracked === true, cantidad: Number(v.inventoryQuantity) || 0, vendible: v.availableForSale === true });
    }
  }
  return { variantes, locationId: String(loc.id) };
}

const errs = (u: unknown) => ((u ?? []) as Array<{ message: string }>).map((e) => e.message).join("; ") || null;

/** Pone la cantidad disponible exacta (corrección). Compara contra la actual para no pisar una venta que entró recién. */
export async function fijarCantidad(inventoryItemId: string, locationId: string, cantidad: number, actual: number): Promise<string | null> {
  // API 2026-10: la mutación exige @idempotent (un reintento con la misma clave no aplica el cambio dos veces).
  const m = `mutation($input: InventorySetQuantitiesInput!, $clave: String!) { inventorySetQuantities(input: $input) @idempotent(key: $clave) { userErrors { field message } } }`;
  const clave = crypto.randomUUID();
  const base = { name: "available", reason: "correction", referenceDocumentUri: "logistics://voltra-os/stock-real" };
  try {
    const r = await gql<Obj>(m, { clave, input: { ...base, quantities: [{ inventoryItemId, locationId, quantity: cantidad, changeFromQuantity: actual }] } });
    return errs((r.inventorySetQuantities as Obj)?.userErrors);
  } catch (e) {
    // Versiones de la API sin changeFromQuantity: se usa la forma vieja.
    if (!/changeFromQuantity/i.test(String(e))) return e instanceof Error ? e.message : String(e);
    const r = await gql<Obj>(m, { clave, input: { ...base, ignoreCompareQuantity: true, quantities: [{ inventoryItemId, locationId, quantity: cantidad }] } });
    return errs((r.inventorySetQuantities as Obj)?.userErrors);
  }
}

export async function activarControl(inventoryItemId: string): Promise<string | null> {
  const r = await gql<Obj>(`mutation($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: true }) { userErrors { message } } }`, { id: inventoryItemId });
  return errs((r.inventoryItemUpdate as Obj)?.userErrors);
}

// Alerta de stock bajo: una por producto por día (candado en eventos_crudos).
export async function alertaTomada(id: string): Promise<boolean> {
  const { error } = await db().from("eventos_crudos").insert({ fuente: "telegram", id_externo: id, payload: { tipo: "stock_bajo" }, procesado_en: new Date().toISOString() });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`eventos_crudos: ${error.message}`);
}
