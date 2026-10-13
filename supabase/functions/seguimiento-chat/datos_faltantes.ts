// seguimiento-chat · datos_faltantes · 12-10 (contrato con FUNCIONES / pedidos-trabados):
// cuando pedidos-trabados le pone FALTAN_DATOS a un pedido (candado auto_agregar_faltan_datos:<order_id> en
// eventos_crudos), se le pide al cliente la calle o el pin con la plantilla voltra_completar_direccion, UNA vez
// por pedido (envios_programados.clave_unica = dir:<order_id>; procesar-envios la manda en horario).
// Con la respuesta, el vendedor actualiza la dirección (actualizar_direccion) y pedidos-trabados saca la etiqueta.
// No se escribe a pedidos cancelados ni a RETIRO_EN_CASA.
import { db } from "../_shared/db.ts";

export type PedidoFaltan = {
  shopify_order_id: number;
  nombre: string | null;
  cliente_id: string | null;
  estado_confirmacion: string | null;
  tags: string[];
  cancelado: boolean;
  primer_nombre: string | null;
};

const CANCELADOS = new Set(["cancelado_cliente", "cancelado_sin_respuesta", "cancelado"]);

/** Pedidos a los que corresponde pedir la dirección (puro). */
export function elegirParaPedirDatos(pedidos: PedidoFaltan[], conCandado: Set<number>): PedidoFaltan[] {
  return pedidos.filter((p) => {
    const t = p.tags.map((x) => x.toUpperCase());
    return conCandado.has(p.shopify_order_id) && t.includes("FALTAN_DATOS") && !t.includes("RETIRO_EN_CASA") &&
      !t.includes("CANCELADO_CLIENTE") && !p.cancelado && !CANCELADOS.has(String(p.estado_confirmacion ?? "")) && !!p.cliente_id;
  });
}

export async function pedirDatosFaltantes(ahora = new Date()): Promise<{ candidatos: number; programados: number }> {
  const sb = db();
  const { data: ev, error: e1 } = await sb.from("eventos_crudos").select("id_externo").eq("fuente", "shopify")
    .like("id_externo", "auto_agregar_faltan_datos:%").limit(500);
  if (e1) throw new Error(`eventos_crudos: ${e1.message}`);
  const ids = new Set((ev ?? []).map((x) => Number(String(x.id_externo).split(":")[1])).filter(Number.isFinite));
  if (!ids.size) return { candidatos: 0, programados: 0 };
  const { data, error } = await sb.from("shopify_pedidos")
    .select("shopify_order_id,nombre,cliente_id,estado_confirmacion,tags,raw->>cancelled_at,raw->shipping_address->>first_name")
    .in("shopify_order_id", [...ids]).eq("es_borrador", false);
  if (error) throw new Error(`shopify_pedidos: ${error.message}`);
  const pedidos: PedidoFaltan[] = (data ?? []).map((x: Record<string, unknown>) => ({
    shopify_order_id: Number(x.shopify_order_id),
    nombre: (x.nombre as string) ?? null,
    cliente_id: (x.cliente_id as string) ?? null,
    estado_confirmacion: (x.estado_confirmacion as string) ?? null,
    tags: (x.tags as string[]) ?? [],
    cancelado: !!x.cancelled_at,
    primer_nombre: String(x.first_name ?? "").trim().split(/\s+/)[0] || null,
  }));
  const elegidos = elegirParaPedirDatos(pedidos, ids);
  if (!elegidos.length) return { candidatos: 0, programados: 0 };
  const filas = elegidos.map((p) => ({
    cliente_id: p.cliente_id,
    shopify_order_id: p.shopify_order_id,
    plantilla: "voltra_completar_direccion",
    variables: { nombre: p.primer_nombre ? p.primer_nombre[0].toUpperCase() + p.primer_nombre.slice(1).toLowerCase() : "Hola", pedido: p.nombre ?? `#${p.shopify_order_id}` },
    categoria: "utilidad",
    enviar_desde: ahora.toISOString(),
    clave_unica: `dir:${p.shopify_order_id}`, // una sola vez por pedido (ignoreDuplicates)
  }));
  const { error: e2 } = await sb.from("envios_programados").upsert(filas, { onConflict: "clave_unica", ignoreDuplicates: true });
  if (e2) throw new Error(`envios_programados: ${e2.message}`);
  return { candidatos: elegidos.length, programados: filas.length };
}
