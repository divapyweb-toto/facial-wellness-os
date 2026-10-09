// alerta-despachos · I/O real (Supabase y Telegram).
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import type { DepsAlerta, PedidoDespacho } from "./logica.ts";

const CLAVE_ULTIMO = "alerta_despachos_ultimo";
const VENTANA_DIAS = 60;
const CANCELADOS_CONF = ["cancelado_cliente", "cancelado_sin_respuesta"];

type Fila = {
  shopify_order_id: number;
  nombre: string | null;
  estado_confirmacion: string | null;
  fulfillments: Array<{ created_at?: string; createdAt?: string }> | null;
};

export const depsReales: DepsAlerta = {
  ahora: () => new Date(),

  pedidos: async (): Promise<PedidoDespacho[]> => {
    const sb = db();
    const desde = new Date(Date.now() - VENTANA_DIAS * 86_400_000).toISOString();
    const filas: Fila[] = [];
    for (let i = 0;; i += 1000) {
      const { data, error } = await sb.from("shopify_pedidos")
        .select("shopify_order_id,nombre,estado_confirmacion,fulfillments:raw->fulfillments")
        .eq("es_borrador", false).gte("creado_en", desde)
        .order("shopify_order_id", { ascending: true }).range(i, i + 999);
      if (error) throw new Error(`shopify_pedidos: ${error.message}`);
      const d = (data ?? []) as Fila[];
      filas.push(...d);
      if (d.length < 1000) break;
    }
    const vivos = filas.filter((f) => !CANCELADOS_CONF.includes(String(f.estado_confirmacion ?? "")));
    const estados = new Map<number, Array<{ estado: string; creado_en: string }>>();
    for (let i = 0; i < vivos.length; i += 200) {
      const ids = vivos.slice(i, i + 200).map((f) => f.shopify_order_id);
      const { data, error } = await sb.from("pedido_estados").select("shopify_order_id,estado,creado_en")
        .in("shopify_order_id", ids);
      if (error) throw new Error(`pedido_estados: ${error.message}`);
      for (const e of data ?? []) {
        const k = Number(e.shopify_order_id);
        if (!estados.has(k)) estados.set(k, []);
        estados.get(k)!.push({ estado: String(e.estado), creado_en: String(e.creado_en) });
      }
    }
    return vivos.map((f) => {
      const fs = Array.isArray(f.fulfillments) ? f.fulfillments : [];
      const fechas = fs.map((x) => x?.created_at ?? x?.createdAt).filter((x): x is string => !!x).sort();
      return {
        shopify_order_id: Number(f.shopify_order_id),
        nombre: f.nombre,
        fulfilled_en: fechas[0] ?? null,
        estados: estados.get(Number(f.shopify_order_id)) ?? [],
      };
    });
  },

  ultimoAviso: async () => {
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", CLAVE_ULTIMO).maybeSingle();
    if (error) throw new Error(`config_wa.${CLAVE_ULTIMO}: ${error.message}`);
    const v = data?.valor as { dia?: unknown } | null | undefined;
    return typeof v?.dia === "string" ? v.dia : null;
  },

  guardarAviso: async (dia) => {
    const { error } = await db().from("config_wa").upsert({ clave: CLAVE_ULTIMO, valor: { dia } });
    if (error) throw new Error(`guardar ${CLAVE_ULTIMO}: ${error.message}`);
  },

  avisar: (texto) => avisar(texto),
};
