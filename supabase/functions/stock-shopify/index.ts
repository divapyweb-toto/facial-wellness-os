// stock-shopify · Edge Function (solo service role). 18-10-2026.
// Paso 1 (este): {modo:"leer"} → inventario de Shopify por variante (solo lectura, no cambia nada).
// La sincronización Voltra OS → Shopify se agrega después de que Enrique apruebe.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { gql } from "../_shared/shopify.ts";

const Q = `query { products(first: 50, query: "status:active") { nodes { title status
  variants(first: 10) { nodes { id title sku inventoryPolicy inventoryQuantity availableForSale
    inventoryItem { id tracked } } } } } }`;

Deno.serve(conServiceRole(async () => {
  try {
    const r = await gql<Record<string, unknown>>(Q);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}));
