// pedidos-trabados · I/O de pagados_con_cobro.ts: entregas con monto, su venta y su pedido de Shopify; config
// alerta_pagados_cobro; candados y Telegram reales (depsReales de entregas_actuar_io.ts). Solo lectura salvo candados.
import { db } from "../_shared/db.ts";
import { depsReales } from "./entregas_actuar_io.ts";
import { leerCanalCourier } from "../_shared/aviso_courier_wa_io.ts";
import {
  armarFilas, CLAVE_CFG_PAGADOS_COBRO, configPagadoCobro, type DepsPagadoCobro, type EntregaCruda, type PedidoCrudo,
  procesarPagadosConCobro, type VentaCruda,
} from "./pagados_con_cobro.ts";

type Obj = Record<string, unknown>;

async function leerCfg() {
  const { data } = await db().from("config").select("valor").eq("clave", CLAVE_CFG_PAGADOS_COBRO).maybeSingle();
  return configPagadoCobro(data?.valor ?? null);
}

/** Entregas de Voltra en camino o entregadas con monto > 0, creadas desde `desde`, con su venta y su pedido. */
export async function leerFilas(desde: string) {
  const s = db();
  const { data: es, error } = await s.from("entregas")
    .select("nro_guia_pap,guia_transportadora,transportadora,categoria,importe,cobrado,fecha_entrega,ciudad,n_referencia,venta_id,created_at,tienda,estado_pap")
    .eq("tienda", "voltra").in("categoria", ["en_proceso", "entregado"]).gte("created_at", `${desde}T00:00:00Z`)
    .or("importe.gt.0,cobrado.gt.0");
  if (error) throw new Error(`entregas: ${error.message}`);
  const entregas = (es ?? []) as EntregaCruda[];
  if (!entregas.length) return [];
  const ids = [...new Set(entregas.map((e) => e.venta_id).filter(Boolean))] as string[];
  const refs = [...new Set(entregas.map((e) => e.n_referencia).filter(Boolean))] as string[];
  const sel = "id,n_referencia,pago_anticipado,deleted_at";
  const [a, b] = await Promise.all([
    ids.length ? s.from("ventas").select(sel).in("id", ids) : Promise.resolve({ data: [], error: null }),
    refs.length ? s.from("ventas").select(sel).in("n_referencia", refs) : Promise.resolve({ data: [], error: null }),
  ]);
  if (a.error) throw new Error(`ventas: ${a.error.message}`);
  if (b.error) throw new Error(`ventas: ${b.error.message}`);
  const ventas = [...(a.data ?? []), ...(b.data ?? [])] as VentaCruda[];
  const nombres = [...new Set([...ventas.map((v) => v.n_referencia), ...refs].filter(Boolean).map((r) => `#${String(r).replace(/^VT-/i, "")}`))];
  const { data: ps, error: e3 } = nombres.length
    ? await s.from("shopify_pedidos").select("nombre,tags,raw->>financial_status").eq("es_borrador", false).in("nombre", nombres)
    : { data: [], error: null };
  if (e3) throw new Error(`shopify_pedidos: ${e3.message}`);
  const pedidos: PedidoCrudo[] = (ps ?? []).map((p: Obj) => ({ nombre: String(p.nombre), tags: p.tags ?? [], financiero: p.financial_status == null ? null : String(p.financial_status) }));
  return armarFilas(entregas, ventas, pedidos, desde);
}

/** ¿Ya salió "entregar SIN COBRAR" (pago_courier_no_cobrar) para este pedido al verificar el pago? */
async function yaAvisadoAlVerificar(pedido: string): Promise<boolean> {
  const { data } = await db().from("telegram_enviados").select("id").eq("tipo", "pago_courier_no_cobrar").eq("ok", true).eq("pedido", pedido).limit(1);
  if ((data?.length ?? 0) > 0) return true;
  // 18-11: o ya salió directo a la transportadora por WhatsApp (candado de _shared/courier_wa.ts, clave pago_courier_no_cobrar:VT-n:<día>).
  const ref = `VT-${pedido.replace(/\D/g, "")}`;
  const { data: wa } = await db().from("eventos_crudos").select("id").like("id_externo", `transp_envio:pago_courier_no_cobrar:${ref}:%`).limit(1);
  return (wa?.length ?? 0) > 0;
}

const deps: DepsPagadoCobro = { ...depsReales, yaAvisadoAlVerificar };

/** Entrada del cron de 10 min. */
export async function alertaPagadosConCobro(ahora: Date, simular: boolean) {
  const cfg = await leerCfg();
  if (!cfg.activo) return { activo: false, hechos: [] };
  const canalCourier = await leerCanalCourier(); // 18-11: aviso directo a la transportadora (apagado = Telegram de siempre)
  return { activo: true, hechos: await procesarPagadosConCobro(await leerFilas(cfg.desde), ahora, cfg, { ...deps, canalCourier }, simular) };
}
