// stock-shopify · Edge Function (solo service role). 18-10-2026, aprobado por Enrique.
// Cron cada 10 min (body {origen:"pg_cron"}) o {modo:"sincronizar"}: escribe en Shopify el stock REAL de Voltra OS
// (stock_actual − pedidos válidos todavía no descontados en Despacho) y activa el control de inventario.
// {modo:"leer"}: comparación stock real ↔ Shopify sin cambiar nada. Alerta por Telegram si un producto baja de 10.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { avisar } from "../_shared/telegram.ts";
import { activarControl, alertaTomada, fijarCantidad, inventarioShopify, pendientesSinDescontar, productos } from "./io.ts";
import { familia, stockReal, UMBRAL_ALERTA } from "./logica.ts";

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { modo?: string; origen?: string };
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
          await avisar(`⚠️ <b>Stock bajo: ${f.familia}</b> · quedan ${f.real} unidades reales. Pausá sus anuncios hasta reponer.`).catch(() => {});
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
