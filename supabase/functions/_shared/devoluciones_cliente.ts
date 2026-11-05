// _shared/devoluciones_cliente.ts · 05-11 (Enrique): cuántos pedidos ANTERIORES del cliente fueron devueltos / no
// entregados, sumando las dos tiendas (Voltra y la vieja FW). Lo usa el pago anticipado obligatorio
// (_shared/pago_anticipado.ts exigePagoRequerido) en wa-webhook y procesar-envios.
//
// Qué cuenta como "devuelto / no entregado" (un pedido cuenta una sola vez aunque aparezca en varias tablas):
//   1. ventas.estado = 'devuelto' (sin deleted_at), Voltra y FW. Es el resultado consolidado de los reportes del
//      courier: PaP Devuelto Definitivo / Devolución en proceso / fin de custodia / no gestionado; Lucero Devuelto /
//      Cancelado. Es la fuente principal (la única con el historial de FW con teléfono).
//   2. entregas (reporte del courier) con pérdida definitiva según la regla de Enrique (19-10):
//        PaP no reintenta → categoria 'devuelto' o estado Custodio, Inubicable, No Gestionado, Fuera de cobertura,
//        Devolución en proceso, Devuelto, Cancelado.
//        Lucero → solo 'devuelto' o 'cancelado' (Fallido, reagendado, etc. siguen en gestión: NO cuentan).
//      Si la entrega está vinculada a una venta 'entregado', manda la venta (se reentregó): no cuenta.
//   3. shopify_pedidos.estado_envio = 'NO_ENTREGADO' del mismo cliente (Voltra recientes que ventas todavía no marcó).
//      CANCELADO no cuenta: también lo escribe Enrique al cancelar desde Telegram (no es una falla de entrega).
// Cruce: teléfono normalizado (últimos 9 dígitos, sin +595 / 0 / 00) y, para shopify_pedidos, cliente_id. Se excluye
// el pedido actual. Sin límite de fecha: cualquier devolución histórica cuenta.

import { normalizarEstado } from "./estados_courier.ts";

type Obj = Record<string, unknown>;
const esObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** '+595 981 123 456', '0981123456', '595981123456', '00595981…' → '981123456'. Menos de 9 dígitos → null. */
export function ultimos9(x: unknown): string | null {
  if (typeof x !== "string" && typeof x !== "number") return null;
  let d = String(x).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("595")) d = d.slice(3);
  d = d.replace(/^0+/, "");
  return d.length >= 9 ? d.slice(-9) : null;
}

/** Teléfonos del pedido de Shopify (raw): principal, envío, facturación y cliente. */
export function telefonosDeRaw(raw: unknown): string[] {
  const r = esObj(raw) ? raw : {};
  const sub = (k: string) => (esObj(r[k]) ? (r[k] as Obj).phone : null);
  return [r.phone, sub("shipping_address"), sub("billing_address"), sub("customer")].filter((x): x is string => typeof x === "string" && !!x.trim());
}

/** Referencia → clave común entre tablas: ('voltra', 'VT-1234') y ('voltra', '#1234') → 'voltra:1234'. Sin dígitos → null. */
export function claveRef(tienda: unknown, ref: unknown): string | null {
  const r = String(ref ?? "").trim().toUpperCase().replace(/^#/, "").replace(/^VT-/, "");
  if (!/\d/.test(r)) return null;
  return `${String(tienda ?? "").trim().toLowerCase() || "?"}:${r}`;
}

export type FilaVenta = { id: string; tienda: string | null; n_referencia: string | null; cliente_telefono: string | null; estado: string | null };
export type FilaEntrega = {
  tienda: string | null;
  n_referencia: string | null;
  transportadora: string | null;
  categoria: string | null;
  estado_pap: string | null;
  telefono_courier: string | null;
  venta_id: string | null;
  nro_guia_pap?: string | null;
  guia_transportadora?: string | null;
};
export type FilaPedido = { shopify_order_id: number | string; nombre: string | null };

const PAP_PERDIDO = ["custodio", "inubicable", "no_gestionado", "fuera_de_cobertura", "devolucion_en_proceso", "devuelto", "cancelado"];
const LUCERO_PERDIDO = ["devuelto", "cancelado"];

/** Pérdida definitiva según el courier (regla del 19-10). */
export function entregaPerdida(e: Pick<FilaEntrega, "categoria" | "transportadora" | "estado_pap">): boolean {
  if (String(e.categoria ?? "").toLowerCase() === "devuelto") return true;
  const est = normalizarEstado(e.estado_pap);
  if (!est) return false;
  const c = String(e.transportadora ?? "").toLowerCase();
  if (c === "pap") return PAP_PERDIDO.some((p) => est === p || est.startsWith(`${p}_`));
  if (c === "lucero") return LUCERO_PERDIDO.includes(est);
  return false;
}

/** Lectura de las tablas (index.ts la arma con Supabase; los tests, con filas inventadas). */
export interface FuentesDevoluciones {
  /** ventas con estado 'devuelto' y sin deleted_at (las dos tiendas). */
  ventasDevueltas(): Promise<FilaVenta[]>;
  /** entregas que pueden ser pérdida (categoria 'devuelto' o 'en_proceso'); el filtro fino es entregaPerdida. */
  entregasCandidatas(): Promise<FilaEntrega[]>;
  /** ventas sin deleted_at por id (las vinculadas a una entrega perdida que no están en ventasDevueltas). */
  ventasPorId(ids: string[]): Promise<FilaVenta[]>;
  /** shopify_pedidos del cliente con estado_envio 'NO_ENTREGADO'. */
  pedidosNoEntregados(clienteId: string): Promise<FilaPedido[]>;
}

export type ConsultaDevoluciones = {
  clienteId?: string | null;
  telefonos: unknown[];
  /** Pedido actual (Voltra): se excluye. */
  pedidoActual: { nombre?: string | null; shopifyOrderId?: number | string | null };
};

/** Pedidos anteriores devueltos / no entregados del cliente (claves únicas 'tienda:ref', sin el actual). */
export async function devolucionesPrevias(f: FuentesDevoluciones, q: ConsultaDevoluciones): Promise<{ total: number; claves: string[] }> {
  const tels = new Set(q.telefonos.map(ultimos9).filter((x): x is string => !!x));
  const actual = claveRef("voltra", q.pedidoActual.nombre);
  const idActual = q.pedidoActual.shopifyOrderId != null ? String(q.pedidoActual.shopifyOrderId) : null;
  const claves = new Set<string>();
  const sumar = (k: string) => { if (k !== actual) claves.add(k); };
  const claveVenta = (v: FilaVenta) => claveRef(v.tienda, v.n_referencia) ?? `venta:${v.id}`;

  const [ventas, entregas, pedidos] = await Promise.all([
    tels.size ? f.ventasDevueltas() : Promise.resolve([] as FilaVenta[]),
    tels.size ? f.entregasCandidatas() : Promise.resolve([] as FilaEntrega[]),
    q.clienteId ? f.pedidosNoEntregados(q.clienteId) : Promise.resolve([] as FilaPedido[]),
  ]);

  // 1) ventas devueltas
  const ventaPorId = new Map<string, FilaVenta>();
  for (const v of ventas) {
    ventaPorId.set(v.id, v);
    const t = ultimos9(v.cliente_telefono);
    if (t && tels.has(t)) sumar(claveVenta(v));
  }

  // 2) entregas con pérdida definitiva (las vinculadas a una venta se leen con el teléfono y el estado de la venta)
  const perdidas = entregas.filter(entregaPerdida);
  const faltan = [...new Set(perdidas.map((e) => e.venta_id).filter((id): id is string => !!id && !ventaPorId.has(id)))];
  if (faltan.length) for (const v of await f.ventasPorId(faltan)) ventaPorId.set(v.id, v);
  for (const e of perdidas) {
    const v = e.venta_id ? ventaPorId.get(e.venta_id) : undefined;
    if (v && String(v.estado ?? "").toLowerCase() === "entregado") continue; // se reentregó: manda la venta
    const t1 = ultimos9(e.telefono_courier), t2 = ultimos9(v?.cliente_telefono);
    if (!((t1 && tels.has(t1)) || (t2 && tels.has(t2)))) continue;
    const guia = e.nro_guia_pap || e.guia_transportadora;
    const k = v ? claveVenta(v) : claveRef(e.tienda, e.n_referencia) ?? (guia ? `guia:${e.transportadora ?? "?"}:${guia}` : null);
    if (k) sumar(k);
  }

  // 3) pedidos de Voltra no entregados del mismo cliente
  for (const p of pedidos) {
    if (idActual && String(p.shopify_order_id) === idActual) continue;
    sumar(claveRef("voltra", p.nombre) ?? `pedido:${p.shopify_order_id}`);
  }

  return { total: claves.size, claves: [...claves].sort() };
}

// ─── Lectura con Supabase (solo service role) ───

type Respuesta<T> = { data: T[] | null; error: { message: string } | null };
// deno-lint-ignore no-explicit-any
type Sb = { from(t: string): any };

const PAGINA = 1000;
async function todas<T>(armar: (desde: number, hasta: number) => PromiseLike<Respuesta<T>>, que: string): Promise<T[]> {
  const out: T[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await armar(desde, desde + PAGINA - 1);
    if (error) throw new Error(`${que}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGINA) return out;
  }
}

const COLS_VENTA = "id,tienda,n_referencia,cliente_telefono,estado";

/**
 * Fuentes reales. Las ventas devueltas se traen todas (cientos de filas) y el teléfono se compara acá: hay teléfonos
 * con espacios o '+595' que un filtro LIKE en la base no encontraría.
 */
export function fuentesSupabase(sb: Sb): FuentesDevoluciones {
  return {
    ventasDevueltas: () =>
      todas<FilaVenta>((a, b) => sb.from("ventas").select(COLS_VENTA).eq("estado", "devuelto").is("deleted_at", null).order("id").range(a, b), "ventas devueltas"),
    entregasCandidatas: () =>
      todas<FilaEntrega>((a, b) =>
        sb.from("entregas").select("tienda,n_referencia,transportadora,categoria,estado_pap,telefono_courier,venta_id,nro_guia_pap,guia_transportadora")
          .in("categoria", ["devuelto", "en_proceso"]).order("nro_guia_pap").range(a, b), "entregas"),
    async ventasPorId(ids) {
      const out: FilaVenta[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await sb.from("ventas").select(COLS_VENTA).in("id", ids.slice(i, i + 100)).is("deleted_at", null) as Respuesta<FilaVenta>;
        if (error) throw new Error(`ventas por id: ${error.message}`);
        out.push(...(data ?? []));
      }
      return out;
    },
    async pedidosNoEntregados(clienteId) {
      const { data, error } = await sb.from("shopify_pedidos").select("shopify_order_id,nombre")
        .eq("cliente_id", clienteId).eq("estado_envio", "NO_ENTREGADO") as Respuesta<FilaPedido>;
      if (error) throw new Error(`shopify_pedidos no entregados: ${error.message}`);
      return data ?? [];
    },
  };
}
