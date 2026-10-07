// recompra · orquestación del cron diario (todo el I/O entra por `Deps`; los tests usan una base en memoria).
//
// 1. Pedidos ENTREGADOS de la ventana + consentimiento de marketing 'si' → filas en recompra_plan
//    (clave_unica rc:<order>:<tipo>; si ya existe no se duplica).
// 2. Cancela lo que ya no corresponde: M2 si recompró; planes viejos reemplazados por una entrega nueva
//    del mismo producto; todo si el cliente no tiene consentimiento 'si'.
// 3. Planes vencidos (dia_objetivo <= hoy): uno por cliente por corrida, con topes. Si pasa → fila en
//    envios_programados categoría 'marketing' (procesar-envios respeta horario y consentimiento).
//    Si el tope lo frena → se corre dia_objetivo. 60 días sin leer o baja → se cancelan todos.

import {
  calcularPlan,
  clavesQueTiene,
  diaLocalMas,
  diasEntre,
  evaluarTope,
  instanteLocal,
  type ItemPlan,
  type LineaPedido,
  type MensajeMk,
  type RecompraCfg,
  recompro,
} from "./calendario.ts";

export interface PedidoFila {
  shopify_order_id: number;
  cliente_id: string | null;
  nombre_cliente: string | null;
  creado_en: Date;
  entregado_en: Date | null;
  cancelado: boolean;
  lineas: LineaPedido[];
}

export interface PlanFila {
  id: string;
  cliente_id: string;
  shopify_order_id: number | null;
  tipo: ItemPlan["tipo"];
  producto_clave: string;
  dia_objetivo: string;
  estado: "planificado" | "programado" | "enviado" | "cancelado";
  plantilla: string;
  variables: (string | number)[];
  clave_unica: string;
  envio_id: string | null;
}

export type Consentimiento = "si" | "no" | "baja" | null;

export interface Deps {
  ahora(): Date;
  cfg: RecompraCfg;
  pedidos(desde: Date): Promise<PedidoFila[]>;
  consentimientos(clienteIds: string[]): Promise<Map<string, Consentimiento>>;
  /** Inserta ignorando las claves que ya existen. Devuelve cuántas eran nuevas. */
  insertarPlanes(items: ItemPlan[]): Promise<number>;
  planesAbiertos(): Promise<PlanFila[]>;
  actualizarPlan(id: string, cambio: Partial<PlanFila> & { motivo?: string }): Promise<void>;
  /** Marketing ya enviado (con lectura) y en cola, por cliente. */
  historialMarketing(clienteId: string): Promise<{ mensajes: MensajeMk[]; enCola: Date[] }>;
  /** Inserta en envios_programados (ignora si la clave_unica ya existe). Devuelve el id o null. */
  programarEnvio(e: {
    cliente_id: string;
    shopify_order_id: number | null;
    plantilla: string;
    variables: (string | number)[];
    enviar_desde: string;
    clave_unica: string;
  }): Promise<string | null>;
  cancelarEnvio(envioId: string, motivo: string): Promise<void>;
  guardarTope(fila: {
    cliente_id: string;
    mes: string;
    enviados: number;
    sin_leer_seguidos: number;
    ultimo_envio: string | null;
    fuera: boolean;
    motivo: string | null;
  }): Promise<void>;
}

export interface Resumen {
  pedidos_entregados: number;
  planes_nuevos: number;
  programados: number;
  postergados: number;
  cancelados: number;
}

export async function ejecutarRecompra(d: Deps): Promise<Resumen> {
  const ahora = d.ahora();
  const hoy = diaLocalMas(ahora, 0);
  const cfg = d.cfg;
  const r: Resumen = { pedidos_entregados: 0, planes_nuevos: 0, programados: 0, postergados: 0, cancelados: 0 };

  const pedidos = await d.pedidos(new Date(ahora.getTime() - cfg.ventana_dias * 86_400_000));
  const clientes = [...new Set(pedidos.map((p) => p.cliente_id).filter((x): x is string => !!x))];
  const cons = await d.consentimientos(clientes);

  // ── 1. Planificar ──
  const entregados = pedidos.filter((p) => p.cliente_id && p.entregado_en && !p.cancelado);
  r.pedidos_entregados = entregados.length;
  const nuevos: ItemPlan[] = [];
  for (const p of entregados) {
    if (cons.get(p.cliente_id!) !== "si") continue;
    const items = calcularPlan({
      shopify_order_id: p.shopify_order_id,
      cliente_id: p.cliente_id!,
      nombre_cliente: p.nombre_cliente,
      entregado_en: p.entregado_en!,
      lineas: p.lineas,
    }, cfg);
    // Arranque con entregas viejas: no se crean avisos cuyo día pasó hace más de dias_gracia.
    nuevos.push(...items.filter((i) => diasEntre(i.dia_objetivo, hoy) <= cfg.dias_gracia));
  }
  if (nuevos.length) r.planes_nuevos = await d.insertarPlanes(nuevos);

  // ── 2. Cancelar lo que ya no corresponde ──
  const porCliente = new Map<string, PedidoFila[]>();
  for (const p of pedidos) if (p.cliente_id) porCliente.set(p.cliente_id, [...(porCliente.get(p.cliente_id) ?? []), p]);
  const tieneDe = (p: PedidoFila) => clavesQueTiene(p.lineas, cfg.productos);

  const abiertos = await d.planesAbiertos();
  const vivos: PlanFila[] = [];
  for (const pl of abiertos) {
    const motivo = motivoCancelacion(pl, cons.get(pl.cliente_id) ?? null, porCliente.get(pl.cliente_id) ?? [], tieneDe);
    if (motivo) {
      await cancelarPlan(d, pl, motivo);
      r.cancelados++;
    } else vivos.push(pl);
  }

  // ── 3. Programar los vencidos, uno por cliente, con topes ──
  const vencidos = vivos.filter((p) => p.estado === "planificado" && p.dia_objetivo <= hoy);
  const grupos = new Map<string, PlanFila[]>();
  for (const p of vencidos) grupos.set(p.cliente_id, [...(grupos.get(p.cliente_id) ?? []), p]);

  for (const [clienteId, lista] of grupos) {
    // M1 y M2 del mismo pedido vencidos a la vez (M1 quedó postergado): manda M2, M1 se cancela.
    const conM2 = new Set(lista.filter((p) => p.tipo === "M2").map((p) => p.shopify_order_id));
    for (const p of lista.filter((p) => p.tipo === "M1" && conM2.has(p.shopify_order_id))) {
      await cancelarPlan(d, p, "reemplazado_por_m2");
      r.cancelados++;
    }
    const candidatos = lista.filter((p) => !(p.tipo === "M1" && conM2.has(p.shopify_order_id)))
      .sort((a, b) => a.dia_objetivo.localeCompare(b.dia_objetivo));
    if (!candidatos.length) continue;
    const elegido = candidatos[0];

    const h = await d.historialMarketing(clienteId);
    const dec = evaluarTope(cons.get(clienteId) ?? null, h.mensajes, h.enCola, hoy, ahora, cfg);
    const mes = hoy.slice(0, 7);
    const ultimo = [...h.mensajes.map((m) => m.enviado_en), ...h.enCola].sort((a, b) => b.getTime() - a.getTime())[0];

    if (!dec.ok && dec.fuera) {
      for (const p of vivos.filter((x) => x.cliente_id === clienteId)) {
        await cancelarPlan(d, p, dec.motivo);
        r.cancelados++;
      }
      await d.guardarTope({
        cliente_id: clienteId,
        mes,
        enviados: 0,
        sin_leer_seguidos: 0,
        ultimo_envio: ultimo?.toISOString() ?? null,
        fuera: true,
        motivo: dec.motivo,
      });
      continue;
    }
    if (!dec.ok) {
      await d.actualizarPlan(elegido.id, { dia_objetivo: dec.desde, motivo: dec.motivo });
      r.postergados++;
      continue;
    }
    const nueve = instanteLocal(hoy, cfg.hora_envio);
    const envioId = await d.programarEnvio({
      cliente_id: clienteId,
      shopify_order_id: elegido.shopify_order_id,
      plantilla: elegido.plantilla,
      variables: elegido.variables,
      enviar_desde: (nueve > ahora ? nueve : ahora).toISOString(),
      clave_unica: elegido.clave_unica,
    });
    await d.actualizarPlan(elegido.id, { estado: "programado", envio_id: envioId, motivo: undefined });
    r.programados++;
    await d.guardarTope({
      cliente_id: clienteId,
      mes,
      enviados: dec.enviados_mes + 1,
      sin_leer_seguidos: dec.sin_leer_seguidos,
      ultimo_envio: ahora.toISOString(),
      fuera: false,
      motivo: null,
    });
  }
  return r;
}

/** Por qué un plan abierto ya no corresponde (o null si sigue vigente). */
export function motivoCancelacion(
  pl: PlanFila,
  consentimiento: Consentimiento,
  pedidosCliente: PedidoFila[],
  tieneDe: (p: PedidoFila) => Set<string>,
): string | null {
  if (consentimiento !== "si") return `sin_consentimiento:${consentimiento ?? "ninguno"}`;
  if (pl.tipo === "LANZAMIENTO") return null;
  const origen = pedidosCliente.find((p) => p.shopify_order_id === pl.shopify_order_id);
  if (!origen?.entregado_en) return null;
  const otros = pedidosCliente.map((p) => ({
    shopify_order_id: p.shopify_order_id,
    creado_en: p.creado_en,
    cancelado: p.cancelado,
    tiene: tieneDe(p),
  }));
  const o = { shopify_order_id: origen.shopify_order_id, entregado_en: origen.entregado_en };
  if ((pl.tipo === "M1" || pl.tipo === "M2") && recompro(o, pl.producto_clave, otros)) return "recompro";
  if (pl.tipo === "CRUZADA" && recompro(o, pl.producto_clave, otros)) return "ya_compro_afin";
  return null;
}

async function cancelarPlan(d: Deps, pl: PlanFila, motivo: string): Promise<void> {
  if (pl.envio_id) await d.cancelarEnvio(pl.envio_id, `recompra:${motivo}`);
  await d.actualizarPlan(pl.id, { estado: "cancelado", motivo });
}
