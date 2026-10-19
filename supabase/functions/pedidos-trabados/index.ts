// pedidos-trabados · Edge Function (solo service role). 12-10-2026. Reglas en logica.ts, I/O en io.ts.
// Cron cada 10 min (body {origen:"pg_cron"}): corrige en Shopify lo que no coincide con Voltra OS (CONFIRMADO,
// cancelados por el cliente, FALTAN_DATOS). {modo:"simular"}: lista qué haría, sin tocar nada.
// A mano: {acciones: [{pedido: "#1016", quitar_etiqueta: "FALTAN_DATOS"}, {pedido: "#1005", agregar_etiqueta: "CONFIRMADO"}, {pedido: "#1019", cancelar: true}]}.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { marcarPreparado } from "../_shared/shopify_preparar.ts";
import { cancelarEnShopify, candadosTomados, ejecutar, etiqueta, idCandadoAuto, pedidosAbiertos, registrarError, tomarCandado } from "./io.ts";
import { accionesPara } from "./logica.ts";
import { avisoRutaPap } from "./aviso_ruta_pap.ts";

type AccionManual = { pedido: string; quitar_etiqueta?: string; agregar_etiqueta?: string; cancelar?: boolean; preparar?: boolean };

async function automatico(simular: boolean) {
  const ahora = new Date();
  const pedidos = await pedidosAbiertos(ahora);
  const tomados = await candadosTomados(pedidos.map((p) => p.shopifyOrderId));
  const hechos: Array<{ pedido: string; accion: string; ok: boolean; error?: string }> = [];
  for (const p of pedidos) {
    const puse = tomados.has(idCandadoAuto("agregar_faltan_datos", p.shopifyOrderId));
    for (const a of accionesPara(p, ahora, puse)) {
      const id = idCandadoAuto(a, p.shopifyOrderId);
      if (tomados.has(id)) continue; // ya se hizo una vez: si alguien lo deshizo a mano, se respeta
      if (simular) {
        hechos.push({ pedido: p.nombre, accion: a, ok: true });
        continue;
      }
      if (!(await tomarCandado(id, { pedido: p.nombre, accion: a }))) continue;
      const e = await ejecutar(a, p.shopifyOrderId, p.notas, p.direccion).catch((x) => String(x));
      if (e) await registrarError(id, e);
      hechos.push({ pedido: p.nombre, accion: a, ok: !e, ...(e ? { error: e } : {}) });
    }
  }
  // 19-10: aviso "en recorrido de reparto" para PaP (aviso_ruta_pap.ts). Un error acá no frena lo demás.
  const ruta = await avisoRutaPap(ahora, simular).catch((e) => ({ activo: true, error: e instanceof Error ? e.message : String(e), hechos: [] }));
  return { revisados: pedidos.length, acciones: hechos, aviso_ruta_pap: ruta };
}

async function manual(acciones: AccionManual[]) {
  const res: Array<{ pedido: string; accion: string; ok: boolean; error?: string }> = [];
  for (const a of acciones) {
    const { data } = await db().from("shopify_pedidos").select("shopify_order_id").eq("nombre", a.pedido).eq("es_borrador", false).maybeSingle();
    const id = data ? Number(data.shopify_order_id) : null;
    if (!id) {
      res.push({ pedido: a.pedido, accion: "buscar", ok: false, error: "no está en shopify_pedidos" });
      continue;
    }
    const pasos: Array<[string, () => Promise<string | null>]> = [];
    if (a.quitar_etiqueta) pasos.push([`quitar ${a.quitar_etiqueta}`, () => etiqueta(id, a.quitar_etiqueta!, false)]);
    if (a.agregar_etiqueta) pasos.push([`agregar ${a.agregar_etiqueta}`, () => etiqueta(id, a.agregar_etiqueta!, true)]);
    if (a.cancelar) pasos.push(["cancelar", () => cancelarEnShopify(id)]);
    // Preparado sin aviso al cliente (mismo camino que Despacho). Ej.: retiro en persona ya entregado.
    if (a.preparar) pasos.push(["preparar", async () => { const r = await marcarPreparado(id); return r.ok ? null : (r.error ?? "no se pudo"); }]);
    for (const [nombre, f] of pasos) {
      const e = await f().catch((x) => String(x));
      res.push({ pedido: a.pedido, accion: nombre, ok: !e, ...(e ? { error: e } : {}) });
    }
  }
  return { acciones: res };
}

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { origen?: string; modo?: string; acciones?: AccionManual[] };
    const r = b.acciones?.length ? await manual(b.acciones) : await automatico(b.origen !== "pg_cron" && b.modo !== "aplicar");
    console.log("pedidos-trabados", JSON.stringify(r));
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("pedidos-trabados:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
