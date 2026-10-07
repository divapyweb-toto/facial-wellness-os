// recompra · Edge Function de cron diario (9:00 Asunción; migración 20261006000009_cron_recompra.sql).
// Solo service role (_shared/auth_servicio.ts). La lógica está en logica.ts y calendario.ts.
//
// POST sin cuerpo: corrida normal.
// POST {"lanzamiento": {clave, nombre, precio_cliente, fecha_hasta, segmento: [claves], dia_objetivo?}}:
//   además planifica un lanzamiento para los clientes del segmento afín con consentimiento 'si'
//   (cuenta dentro de los topes; sale el día objetivo o cuando el tope lo deje).
//
// Fecha de entrega: shopify_pedidos.entregado_en (la crea H2, migración 0006). Si la columna todavía
// no existe o está vacía, usa pedido_estados (estado ENTREGADO).creado_en, que es la hora en que se
// importó el reporte del courier (puede ser 1 o 2 días después de la entrega real).

import { db } from "../_shared/db.ts";
import { conServiceRole } from "../_shared/auth_servicio.ts";
import {
  clavesQueTiene,
  configDesdeValor,
  diaLocalMas,
  type ItemPlan,
  lineasDesdeRaw,
  type MensajeMk,
  planLanzamiento,
  type RecompraCfg,
} from "./calendario.ts";
import { type Consentimiento, type Deps, ejecutarRecompra, type PedidoFila, type PlanFila } from "./logica.ts";

const PREFIJO_MK = "voltra_mk_";
const CANCELADOS_CONF = ["cancelado_cliente", "cancelado_sin_respuesta"];
const CANCELADOS_ENVIO = ["CANCELADO", "NO_ENTREGADO", "RENDIDO"];

function falla(donde: string, error: { message: string } | null): void {
  if (error) throw new Error(`${donde}: ${error.message}`);
}

async function leerPaginado<T>(
  consulta: (
    desde: number,
    hasta: number,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
): Promise<{ filas: T[]; error: { message: string; code?: string } | null }> {
  const filas: T[] = [];
  for (let i = 0;; i += 1000) {
    const { data, error } = await consulta(i, i + 999);
    if (error) return { filas, error };
    const d = (data ?? []) as T[];
    filas.push(...d);
    if (d.length < 1000) return { filas, error: null };
  }
}

type FilaPedido = {
  shopify_order_id: number;
  cliente_id: string | null;
  creado_en: string;
  estado_confirmacion: string;
  estado_envio: string | null;
  raw: unknown;
  entregado_en?: string | null;
  wa_clientes: { nombre: string | null } | null;
};

async function pedidos(desde: Date): Promise<PedidoFila[]> {
  const sb = db();
  const base = "shopify_order_id,cliente_id,creado_en,estado_confirmacion,estado_envio,raw,wa_clientes(nombre)";
  const q = (cols: string) => (a: number, b: number) =>
    sb.from("shopify_pedidos").select(cols).eq("es_borrador", false).not("cliente_id", "is", null)
      .gte("creado_en", desde.toISOString()).order("shopify_order_id").range(a, b);
  let r = await leerPaginado<FilaPedido>(q(base + ",entregado_en"));
  if (r.error && (r.error.code === "42703" || /entregado_en/.test(r.error.message))) {
    console.log("recompra: shopify_pedidos.entregado_en no existe todavía; uso pedido_estados");
    r = await leerPaginado<FilaPedido>(q(base));
  }
  falla("pedidos", r.error);

  const ids = r.filas.map((f) => f.shopify_order_id);
  const entregaEstado = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await sb.from("pedido_estados").select("shopify_order_id,creado_en")
      .eq("estado", "ENTREGADO").in("shopify_order_id", ids.slice(i, i + 500));
    falla("pedido_estados", error);
    for (const e of (data ?? []) as { shopify_order_id: number; creado_en: string }[]) {
      entregaEstado.set(e.shopify_order_id, e.creado_en);
    }
  }
  return r.filas.map((f) => {
    const ent = f.entregado_en ?? entregaEstado.get(f.shopify_order_id) ?? null;
    return {
      shopify_order_id: f.shopify_order_id,
      cliente_id: f.cliente_id,
      nombre_cliente: f.wa_clientes?.nombre ?? null,
      creado_en: new Date(f.creado_en),
      entregado_en: ent ? new Date(ent) : null,
      cancelado: CANCELADOS_CONF.includes(f.estado_confirmacion) ||
        (!ent && CANCELADOS_ENVIO.includes(f.estado_envio ?? "")),
      lineas: lineasDesdeRaw(f.raw),
    };
  });
}

async function consentimientos(ids: string[]): Promise<Map<string, Consentimiento>> {
  const m = new Map<string, Consentimiento>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await db().from("wa_consentimientos").select("cliente_id,estado,creado_en")
      .eq("tipo", "marketing").in("cliente_id", ids.slice(i, i + 500)).order("creado_en", { ascending: false });
    falla("consentimientos", error);
    for (const c of (data ?? []) as { cliente_id: string; estado: "si" | "no" | "baja" }[]) {
      if (!m.has(c.cliente_id)) m.set(c.cliente_id, c.estado); // la más reciente manda
    }
  }
  return m;
}

async function insertarPlanes(items: ItemPlan[]): Promise<number> {
  const filas = items.map((i) => ({
    cliente_id: i.cliente_id,
    shopify_order_id: i.shopify_order_id,
    tipo: i.tipo,
    producto_clave: i.producto_clave,
    dia_objetivo: i.dia_objetivo,
    plantilla: i.plantilla,
    variables: i.variables,
    clave_unica: i.clave_unica,
  }));
  const { data, error } = await db().from("recompra_plan")
    .upsert(filas, { onConflict: "clave_unica", ignoreDuplicates: true }).select("id");
  falla("insertarPlanes", error);
  return (data ?? []).length;
}

async function planesAbiertos(): Promise<PlanFila[]> {
  const sb = db();
  const r = await leerPaginado<PlanFila>((a, b) =>
    sb.from("recompra_plan").select(
      "id,cliente_id,shopify_order_id,tipo,producto_clave,dia_objetivo,estado,plantilla,variables,clave_unica,envio_id",
    ).in("estado", ["planificado", "programado"]).order("dia_objetivo").range(a, b)
  );
  falla("planesAbiertos", r.error);
  // Los 'programado' cuyo envío ya salió (o se canceló/falló) se cierran con el estado del envío.
  const prog = r.filas.filter((p) => p.estado === "programado" && p.envio_id);
  const estadoEnvio = new Map<string, string>();
  for (let i = 0; i < prog.length; i += 500) {
    const { data, error } = await sb.from("envios_programados").select("id,estado")
      .in("id", prog.slice(i, i + 500).map((p) => p.envio_id!));
    falla("estado envios", error);
    for (const e of (data ?? []) as { id: string; estado: string }[]) estadoEnvio.set(e.id, e.estado);
  }
  const abiertos: PlanFila[] = [];
  for (const p of r.filas) {
    const ee = p.envio_id ? estadoEnvio.get(p.envio_id) : undefined;
    if (p.estado === "programado" && ee && ee !== "pendiente") {
      await actualizarPlan(p.id, { estado: ee === "enviado" ? "enviado" : "cancelado", motivo: `envio_${ee}` });
      continue;
    }
    abiertos.push(p);
  }
  return abiertos;
}

async function actualizarPlan(id: string, cambio: Record<string, unknown>): Promise<void> {
  const fila = { ...cambio, actualizado_en: new Date().toISOString() };
  if (!("motivo" in cambio)) delete (fila as Record<string, unknown>).motivo;
  else if (cambio.motivo === undefined) (fila as Record<string, unknown>).motivo = null;
  const { error } = await db().from("recompra_plan").update(fila).eq("id", id);
  falla("actualizarPlan", error);
}

async function historialMarketing(clienteId: string): Promise<{ mensajes: MensajeMk[]; enCola: Date[] }> {
  const sb = db();
  const [cola, salientes, entrada] = await Promise.all([
    sb.from("envios_programados").select("enviar_desde").eq("cliente_id", clienteId)
      .eq("categoria", "marketing").eq("estado", "pendiente"),
    sb.from("wa_mensajes").select("creado_en,estado,contenido").eq("cliente_id", clienteId)
      .eq("direccion", "out").eq("tipo", "template").neq("estado", "fallido")
      .order("creado_en", { ascending: false }).limit(50),
    sb.from("wa_mensajes").select("creado_en").eq("cliente_id", clienteId).eq("direccion", "in")
      .order("creado_en", { ascending: false }).limit(1).maybeSingle(),
  ]);
  falla("cola marketing", cola.error);
  falla("salientes", salientes.error);
  falla("entrante", entrada.error);
  const ultimaEntrada = entrada.data ? new Date((entrada.data as { creado_en: string }).creado_en) : null;
  const mensajes = ((salientes.data ?? []) as { creado_en: string; estado: string; contenido: unknown }[])
    .filter((m) => {
      const nombre = String((m.contenido as { template?: { name?: string } } | null)?.template?.name ?? "");
      return nombre.startsWith(PREFIJO_MK);
    })
    .map((m) => {
      const enviado_en = new Date(m.creado_en);
      // "Leído": confirmación de lectura o el cliente escribió después (hay quien apaga las confirmaciones).
      return { enviado_en, leido: m.estado === "leido" || (!!ultimaEntrada && ultimaEntrada > enviado_en) };
    });
  return {
    mensajes,
    enCola: ((cola.data ?? []) as { enviar_desde: string }[]).map((x) => new Date(x.enviar_desde)),
  };
}

async function programarEnvio(e: Parameters<Deps["programarEnvio"]>[0]): Promise<string | null> {
  const sb = db();
  const { data, error } = await sb.from("envios_programados").upsert({
    cliente_id: e.cliente_id,
    shopify_order_id: e.shopify_order_id,
    plantilla: e.plantilla,
    variables: e.variables,
    categoria: "marketing",
    enviar_desde: e.enviar_desde,
    clave_unica: e.clave_unica,
  }, { onConflict: "clave_unica", ignoreDuplicates: true }).select("id");
  falla("programarEnvio", error);
  if (data && data.length) return (data[0] as { id: string }).id;
  const ya = await sb.from("envios_programados").select("id").eq("clave_unica", e.clave_unica).maybeSingle();
  falla("programarEnvio (existente)", ya.error);
  return (ya.data as { id: string } | null)?.id ?? null;
}

async function cancelarEnvio(id: string, motivo: string): Promise<void> {
  const { error } = await db().from("envios_programados").update({ estado: "cancelado", ultimo_error: motivo })
    .eq("id", id).eq("estado", "pendiente");
  falla("cancelarEnvio", error);
}

async function guardarTope(f: Parameters<Deps["guardarTope"]>[0]): Promise<void> {
  const { error } = await db().from("wa_marketing_tope")
    .upsert({ ...f, actualizado_en: new Date().toISOString() }, { onConflict: "cliente_id,mes" });
  falla("guardarTope", error);
}

async function lanzamiento(body: unknown, cfg: RecompraCfg, d: Deps): Promise<number> {
  const l = (body as { lanzamiento?: Record<string, unknown> } | null)?.lanzamiento;
  if (!l) return 0;
  const segmento = Array.isArray(l.segmento) ? (l.segmento as unknown[]).map(String) : [];
  if (!l.clave || !l.nombre || !(Number(l.precio_cliente) > 0) || !l.fecha_hasta || !segmento.length) {
    throw new Error("lanzamiento: faltan clave, nombre, precio_cliente, fecha_hasta o segmento");
  }
  const ahora = d.ahora();
  const ps = (await d.pedidos(new Date(ahora.getTime() - cfg.ventana_dias * 86_400_000)))
    .filter((p) => p.cliente_id && p.entregado_en && !p.cancelado);
  const cons = await d.consentimientos([...new Set(ps.map((p) => p.cliente_id!))]);
  const porCliente = new Map<string, { cliente_id: string; shopify_order_id: number; tiene: Set<string> }>();
  for (const p of ps) {
    if (cons.get(p.cliente_id!) !== "si") continue;
    const c = porCliente.get(p.cliente_id!) ??
      { cliente_id: p.cliente_id!, shopify_order_id: p.shopify_order_id, tiene: new Set<string>() };
    for (const k of clavesQueTiene(p.lineas, cfg.productos)) c.tiene.add(k);
    if (p.shopify_order_id > c.shopify_order_id) c.shopify_order_id = p.shopify_order_id;
    porCliente.set(p.cliente_id!, c);
  }
  const items = planLanzamiento(
    {
      clave: String(l.clave),
      nombre: String(l.nombre),
      precio_cliente: Number(l.precio_cliente),
      fecha_hasta: String(l.fecha_hasta),
      dia_objetivo: typeof l.dia_objetivo === "string" ? l.dia_objetivo : diaLocalMas(ahora, 0),
      segmento,
    },
    [...porCliente.values()],
    cfg,
  );
  return items.length ? await d.insertarPlanes(items) : 0;
}

Deno.serve(conServiceRole(async (req) => {
  try {
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", "recompra").maybeSingle();
    falla("config_wa", error);
    if (!data) console.log("recompra: falta config_wa.recompra (seed_recompra.sql); no hay productos para planificar");
    const cfg = configDesdeValor((data as { valor: unknown } | null)?.valor);
    const deps: Deps = {
      ahora: () => new Date(),
      cfg,
      pedidos,
      consentimientos,
      insertarPlanes,
      planesAbiertos,
      actualizarPlan: (id, c) => actualizarPlan(id, c as Record<string, unknown>),
      historialMarketing,
      programarEnvio,
      cancelarEnvio,
      guardarTope,
    };
    const body = await req.json().catch(() => null);
    const lanz = await lanzamiento(body, cfg, deps);
    const resumen = await ejecutarRecompra(deps);
    return Response.json({ ok: true, lanzamiento_planes: lanz, ...resumen });
  } catch (e) {
    console.error("recompra:", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}));
