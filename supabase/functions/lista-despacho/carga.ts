// lista-despacho/carga.ts · 05-11 (Enrique: "un secretario super inteligente"). La carga de la lista de despacho, sacada
// de index.ts para que seguimiento-chat (pedidos_48h) vea EXACTAMENTE el mismo motivo que la lista y Despacho.
// Solo lee: shopify_pedidos (30 días), ventas, entregas y la tabla de tarifas (rpc sugerir_courier).
import { db } from "../_shared/db.ts";
import { armarLista, ciudadesAConsultar, type CoberturaCiudad, type ListaDespacho, type PedidoShopify, type VentaDespacho } from "./logica.ts";

/** Fila de shopify_pedidos con lo que usa la lista y lo que necesita quien escribe al cliente. */
export interface FilaPedido extends PedidoShopify {
  shopify_order_id: number | string;
  cliente_id: string | null;
  estado_confirmacion: string | null;
  confirmado_en: string | null;
}

/** 29-10: cobertura según la tabla de tarifas (rpc sugerir_courier, contra entrega). Una ciudad cuya llamada falla queda afuera. */
export async function coberturas(ciudades: string[]): Promise<Map<string, CoberturaCiudad>> {
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

/** Lee los pedidos de los últimos 30 días y arma la lista (con la segunda pasada por la tabla de tarifas). */
export async function cargarListaDespacho(ahora = new Date()): Promise<{ lista: ListaDespacho; filas: FilaPedido[] }> {
  const desde = new Date(ahora.getTime() - 30 * 86400_000).toISOString();
  const { data, error } = await db().from("shopify_pedidos")
    .select("shopify_order_id, nombre, estado_envio, es_borrador, creado_en, raw, cliente_id, estado_confirmacion, confirmado_en")
    .gte("creado_en", desde).order("creado_en");
  if (error) throw new Error(`shopify_pedidos: ${error.message}`);
  const filas = (data ?? []) as FilaPedido[];
  const refs = filas.map((f) => `VT-${String(f.nombre ?? "").replace(/^#/, "")}`);
  const [{ data: ventas, error: ev }, { data: ents, error: ee }] = await Promise.all([
    db().from("ventas").select("n_referencia, transportadora, despachado_at").in("n_referencia", refs).is("deleted_at", null),
    db().from("entregas").select("n_referencia").in("n_referencia", refs),
  ]);
  if (ev) throw new Error(`ventas: ${ev.message}`);
  if (ee) throw new Error(`entregas: ${ee.message}`);
  const enCourier = new Set((ents ?? []).map((e) => String(e.n_referencia)));
  let lista = armarLista(filas, (ventas ?? []) as VentaDespacho[], enCourier, ahora);
  // 29-10: los que quedaron sin courier se vuelven a mirar con la tabla de tarifas (ciudad mal escrita ≠ sin cobertura).
  const consultar = ciudadesAConsultar(lista);
  if (consultar.length) lista = armarLista(filas, (ventas ?? []) as VentaDespacho[], enCourier, ahora, await coberturas(consultar));
  return { lista, filas };
}
