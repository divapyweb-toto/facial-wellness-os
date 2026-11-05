// seguimiento-chat · pedidos_48h_io · 05-11. La parte con base y Telegram de pedidos_48h.ts (la lógica está ahí).
// Carga: la MISMA de la lista de despacho (lista-despacho/carga.ts). Candados en eventos_crudos (fuente 'shopify'),
// lo del cliente por envios_programados (procesar-envios lo manda) y el aviso por avisar() (tipo pedido_48h).
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { cargarListaDespacho } from "../lista-despacho/carga.ts";
import { correrPedidos48h, type Deps48h } from "./pedidos_48h.ts";

/** Ventana de 24 h de WhatsApp: último mensaje entrante del cliente hace menos de 23 h (igual que pedidos-trabados). */
export async function ventanasAbiertas(clienteIds: string[], ahora: Date): Promise<Map<string, boolean>> {
  const m = new Map<string, boolean>(clienteIds.map((c) => [c, false]));
  const { data, error } = await db().from("wa_conversaciones").select("cliente_id,ultima_entrada_en").in("cliente_id", clienteIds);
  if (error) throw new Error(`wa_conversaciones: ${error.message}`);
  for (const r of data ?? []) {
    const t = r.ultima_entrada_en ? Date.parse(String(r.ultima_entrada_en)) : NaN;
    if (Number.isFinite(t) && ahora.getTime() - t < 23 * 3_600_000) m.set(String(r.cliente_id), true);
  }
  return m;
}

export async function candadosExistentes(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db().from("eventos_crudos").select("id_externo").eq("fuente", "shopify").in("id_externo", ids.slice(i, i + 200));
    if (error) throw new Error(`eventos_crudos: ${error.message}`);
    for (const r of data ?? []) out.add(String(r.id_externo));
  }
  return out;
}

export const depsPedidos48h: Deps48h = {
  config: async () => (await db().from("config_wa").select("valor").eq("clave", "pedidos_48h").maybeSingle()).data?.valor ?? null,
  cargar: (ahora) => cargarListaDespacho(ahora),
  candados: candadosExistentes,
  ventanas: ventanasAbiertas,
  async tomar(id, payload) {
    const { error } = await db().from("eventos_crudos").insert({ fuente: "shopify", id_externo: id, payload, procesado_en: new Date().toISOString() });
    if (!error) return true;
    if (error.code === "23505") return false;
    throw new Error(`eventos_crudos: ${error.message}`);
  },
  async soltar(id) {
    await db().from("eventos_crudos").delete().eq("fuente", "shopify").eq("id_externo", id);
  },
  async encolar(fila) {
    const { error } = await db().from("envios_programados").upsert([fila], { onConflict: "clave_unica", ignoreDuplicates: true });
    return error ? `envios_programados: ${error.message}` : null;
  },
  avisar: (texto, c) => avisar(texto, undefined, { tipo: "pedido_48h", destino: "enrique", pedido: c.pedido, clave: c.orderId }),
};

export const correrPedidos48hReal = (ahora = new Date(), simular = false) => correrPedidos48h(depsPedidos48h, ahora, simular);
