// stock-shopify · Edge Function (solo service role). 18-10-2026, aprobado por Enrique.
// Cron cada 10 min (body {origen:"pg_cron"}) o {modo:"sincronizar"}: escribe en Shopify el stock REAL de Voltra OS
// (stock_actual − pedidos válidos todavía no descontados en Despacho) y activa el control de inventario.
// {modo:"leer"}: comparación stock real ↔ Shopify sin cambiar nada. Alerta por Telegram si un producto baja de 10.
// deno-lint-ignore-file no-explicit-any
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { avisar } from "../_shared/telegram.ts";
import { gql } from "../_shared/shopify.ts";
import { activarControl, alertaTomada, fijarCantidad, inventarioShopify, pendientesSinDescontar, productos } from "./io.ts";
import { avisoStockBajo, familia, stockReal, UMBRAL_ALERTA } from "./logica.ts";

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { modo?: string; origen?: string; id?: string };
    // 18-10: prueba de Releasit con stock 0 en un producto de PRUEBA (nunca en los reales). Se crea, se mira la página y se borra.
    if (b.modo === "prueba_crear") {
      const c = await gql<Record<string, any>>(`mutation { productCreate(product: { title: "PRUEBA STOCK 0 - NO COMPRAR", status: ACTIVE, tags: ["PRUEBA_E2E"] }) {
        product { id handle variants(first: 1) { nodes { id inventoryItem { id } } } } userErrors { message } } }`);
      const prod = c.productCreate.product;
      if (!prod) return Response.json({ ok: false, error: c.productCreate.userErrors });
      const v = prod.variants.nodes[0];
      const u = await gql<Record<string, any>>(`mutation($p: ID!, $v: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $p, variants: $v) { userErrors { message } } }`,
        { p: prod.id, v: [{ id: v.id, price: "9999000", inventoryPolicy: "DENY", inventoryItem: { tracked: true } }] });
      const pubs = await gql<Record<string, any>>(`query { publications(first: 20) { nodes { id name } } }`);
      const tienda = pubs.publications.nodes.find((x: any) => /online store|tienda online/i.test(x.name));
      const pb = tienda ? await gql<Record<string, any>>(`mutation($id: ID!, $pub: ID!) { publishablePublish(id: $id, input: [{ publicationId: $pub }]) { userErrors { message } } }`, { id: prod.id, pub: tienda.id }) : null;
      const est = await gql<Record<string, any>>(`query($id: ID!) { product(id: $id) { handle variants(first: 1) { nodes { inventoryQuantity availableForSale inventoryPolicy inventoryItem { tracked } } } } }`, { id: prod.id });
      return Response.json({ ok: true, id: prod.id, handle: prod.handle, errores: [u.productVariantsBulkUpdate.userErrors, pb?.publishablePublish?.userErrors ?? "sin canal tienda"], estado: est.product });
    }
    if (b.modo === "prueba_borrar" && typeof (b as { id?: string }).id === "string" && String((b as { id?: string }).id).startsWith("gid://shopify/Product/")) {
      const d = await gql<Record<string, any>>(`query($id: ID!) { product(id: $id) { title } }`, { id: (b as { id: string }).id });
      if (!/^PRUEBA STOCK 0/.test(d.product?.title ?? "")) return Response.json({ ok: false, error: "solo se borra el producto de prueba" });
      const r = await gql<Record<string, any>>(`mutation($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { message } } }`, { id: (b as { id: string }).id });
      return Response.json({ ok: true, borrado: r.productDelete });
    }
    if (b.modo === "permisos") {
      const d = await gql<{ currentAppInstallation: { accessScopes: Array<{ handle: string }> } }>(`query { currentAppInstallation { accessScopes { handle } } }`);
      return Response.json({ ok: true, permisos: d.currentAppInstallation.accessScopes.map((x) => x.handle).sort() });
    }
    const sincronizar = b.origen === "pg_cron" || b.modo === "sincronizar";
    const [prods, pend] = await Promise.all([productos(), pendientesSinDescontar()]);
    const real = stockReal(prods, pend);
    const { variantes, locationId } = await inventarioShopify();
    const filas = [];
    for (const v of variantes) {
      const f = familia(v.producto);
      const r = real.get(f);
      const fila: Record<string, unknown> = { producto: v.producto, familia: f, stock_voltra: r?.stockActual ?? null, sin_descontar: r?.sinDescontar ?? 0,
        real: r?.real ?? null, shopify_antes: v.cantidad, controlado_antes: v.tracked };
      if (sincronizar && r) {
        const errores: string[] = [];
        if (v.cantidad !== r.real) { const e = await fijarCantidad(v.inventoryItemId, locationId, r.real, v.cantidad); if (e) errores.push(e); }
        if (!v.tracked && !errores.length) { const e = await activarControl(v.inventoryItemId); if (e) errores.push(e); }
        fila.error = errores.join("; ") || null;
      }
      filas.push(fila);
    }
    // Alerta de stock bajo (solo productos que vende la tienda), una vez por día y producto.
    const hoy = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
    const bajos = filas.filter((f) => typeof f.real === "number" && (f.real as number) < UMBRAL_ALERTA);
    if (sincronizar) {
      for (const f of bajos) {
        if (await alertaTomada(`stock_bajo:${f.familia}:${hoy}`)) {
          await avisar(`⚠️ <b>Stock bajo: ${f.familia}</b> · quedan ${f.real} unidades reales. Pausá sus anuncios hasta reponer.`, undefined, avisoStockBajo(String(f.familia))).catch(() => {});
        }
      }
    }
    let despues = null;
    if (sincronizar) despues = (await inventarioShopify()).variantes.map((v) => ({ producto: v.producto, cantidad: v.cantidad, controlado: v.tracked, vendible: v.vendible }));
    const r = { ok: filas.every((f) => !f.error), modo: sincronizar ? "sincronizar" : "leer", pendientes: pend.map((p) => p.nombre), filas, despues };
    console.log("stock-shopify", JSON.stringify({ modo: r.modo, ok: r.ok }));
    return Response.json(r);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("stock-shopify:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
