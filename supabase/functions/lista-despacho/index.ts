// lista-despacho · Edge Function (solo service role). 27-10-2026.
// Cron L-V 12:30 PY (15:30 UTC, migración 20261027000001): UN mensaje a Enrique con lo confirmado y despachable,
// agrupado por courier, con la nota de armado. Sin pedidos, no manda nada. Una vez por día (telegram_enviados).
// Interruptor: config.lista_despacho {"activo": true|false}. Body {prueba:true}: arma el texto con los pedidos reales y NO lo manda.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { armarLista, ciudadesAConsultar, type CoberturaCiudad, type PedidoShopify, textoLista, type VentaDespacho } from "./logica.ts";

/** 29-10: cobertura según la tabla de tarifas (rpc sugerir_courier, contra entrega). Una ciudad cuya llamada falla queda afuera. */
async function coberturas(ciudades: string[]): Promise<Map<string, CoberturaCiudad>> {
  const m = new Map<string, CoberturaCiudad>();
  await Promise.all(ciudades.map(async (c) => {
    const { data, error } = await db().rpc("sugerir_courier", { p_ciudad: c, p_cod: true });
    const r = (data ?? {}) as Record<string, unknown>;
    if (!error && typeof r.ciudad_reconocida === "boolean") {
      m.set(c, { ciudad_reconocida: r.ciudad_reconocida, sin_cobertura: r.sin_cobertura === true, sugerido: typeof r.sugerido === "string" ? r.sugerido : null });
    } else console.warn(`lista-despacho: sugerir_courier('${c}') falló:`, error?.message ?? "sin dato");
  }));
  return m;
}

async function activa(): Promise<boolean> {
  const { data } = await db().from("config").select("valor").eq("clave", "lista_despacho").maybeSingle();
  try { return JSON.parse(String(data?.valor ?? "{}"))?.activo === true; } catch { return false; }
}

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as { prueba?: boolean };
    const prueba = b.prueba === true;
    if (!prueba && !(await activa())) return Response.json({ ok: true, omitido: "apagada" });
    const ahora = new Date();
    const desde = new Date(ahora.getTime() - 30 * 86400_000).toISOString();
    const { data: filas, error } = await db().from("shopify_pedidos").select("nombre, estado_envio, es_borrador, creado_en, raw").gte("creado_en", desde).order("creado_en");
    if (error) throw new Error(`shopify_pedidos: ${error.message}`);
    const refs = (filas ?? []).map((f) => `VT-${String(f.nombre ?? "").replace(/^#/, "")}`);
    const [{ data: ventas, error: ev }, { data: ents, error: ee }] = await Promise.all([
      db().from("ventas").select("n_referencia, transportadora, despachado_at").in("n_referencia", refs).is("deleted_at", null),
      db().from("entregas").select("n_referencia").in("n_referencia", refs),
    ]);
    if (ev) throw new Error(`ventas: ${ev.message}`);
    if (ee) throw new Error(`entregas: ${ee.message}`);
    const enCourier = new Set((ents ?? []).map((e) => String(e.n_referencia)));
    let lista = armarLista((filas ?? []) as PedidoShopify[], (ventas ?? []) as VentaDespacho[], enCourier, ahora);
    // 29-10: los que quedaron sin courier se vuelven a mirar con la tabla de tarifas (ciudad mal escrita ≠ sin cobertura).
    const consultar = ciudadesAConsultar(lista);
    if (consultar.length) lista = armarLista((filas ?? []) as PedidoShopify[], (ventas ?? []) as VentaDespacho[], enCourier, ahora, await coberturas(consultar));
    const texto = textoLista(lista, ahora, prueba);
    const resumen = { despachar: [...lista.porCourier.values()].reduce((s, l) => s + l.length, 0), retiros: lista.retiros.length, no_despachar: lista.noDespachar.length, sin_confirmar: lista.sinConfirmar };
    if (prueba || !texto) return Response.json({ ok: true, prueba, enviado: false, ...resumen, texto });
    const hoy = new Date(ahora.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    const r = await avisar(texto, undefined, { tipo: "lista_despacho", destino: "enrique", unaVezPorDia: true, clave: hoy });
    console.log("lista-despacho", JSON.stringify({ hoy, ...resumen, ok: r.ok }));
    return Response.json({ ok: r.ok, enviado: r.ok, ...resumen, error: r.error, texto });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("lista-despacho:", msg);
    await avisar(`<b>Lista de despacho: falló</b>\n${msg.replace(/[<>&]/g, " ").slice(0, 400)}`, undefined, { tipo: "lista_despacho_error", destino: "enrique", unaVezPorDia: true, clave: "corrida" }).catch(() => {});
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
