// pedidos-trabados · I/O real de entregas_actuar.ts: vistas de Supabase, candados en eventos_crudos, Telegram y la cola
// envios_programados. Un error en una sección no frena a las demás (cada una se atrapa por separado).
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { avisoParaCourier, datosCourierDesdeRaw } from "../_shared/texto_courier.ts";
import { couriersPorCiudad, leerPedidosParados } from "../resumen-diario/io.ts";
import { tomarCandado } from "./io.ts";
import {
  avisarParadosDiario, avisarRendicionAtrasada, PEDIDO_REINTENTO, pedidoDeRef, CFG_REPROGRAMAR_APAGADA, claveEnvioReprogramar, configReprogramar, type DepsActuar,
  type FilaActuar, type FilaRendicion, HORA_PARADOS, horaPy, PLANTILLA_REPROGRAMAR, procesarEntregasActuar, type ResultadoReprogramar,
  type TipoActuar,
} from "./entregas_actuar.ts";

type Obj = Record<string, unknown>;
const TERMINALES = ["ENTREGADO", "NO_ENTREGADO", "CANCELADO", "RENDIDO", "DEVUELTO"];
const primerNombre = (s: unknown) => {
  const n = String(s ?? "").trim().split(/\s+/)[0] ?? "";
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : null;
};

/** Mensaje al cliente para reprogramar (plantilla voltra_entrega_reprogramar), por la misma cola que el aviso de ruta de PaP. */
export async function encolarReprogramar(f: FilaActuar): Promise<ResultadoReprogramar> {
  const s = db();
  const nombre = `#${f.ref.replace(/^VT-/, "")}`;
  const { data, error } = await s.from("shopify_pedidos")
    .select("shopify_order_id,cliente_id,telefono,estado_confirmacion,estado_envio,tags,raw->>cancelled_at,raw->shipping_address->>first_name,raw->shipping_address->>name")
    .eq("nombre", nombre).eq("es_borrador", false).maybeSingle();
  if (error) throw new Error(`shopify_pedidos: ${error.message}`);
  if (!data) return "sin_pedido";
  const p = data as Obj;
  const tags = ((p.tags ?? []) as string[]).map((t) => String(t).toUpperCase());
  if (p.cancelled_at || p.estado_confirmacion !== "confirmado" || TERMINALES.includes(String(p.estado_envio ?? "")) || tags.includes("RETIRO_EN_CASA")) {
    return "no_corresponde";
  }
  if (!p.cliente_id || !String(p.telefono ?? "").replace(/\D/g, "")) return "sin_telefono";
  const id = Number(p.shopify_order_id);
  const { error: e2 } = await s.from("envios_programados").upsert({
    cliente_id: p.cliente_id, shopify_order_id: id, plantilla: PLANTILLA_REPROGRAMAR, categoria: "utilidad",
    variables: { nombre: primerNombre(p.first_name) ?? primerNombre(p.name) },
    enviar_desde: new Date().toISOString(), clave_unica: claveEnvioReprogramar(id, f.fechaIngreso), estado: "pendiente",
  }, { onConflict: "clave_unica", ignoreDuplicates: true });
  if (e2) throw new Error(`envios_programados: ${e2.message}`);
  return "encolado";
}

/** 27-10: texto para reenviar a Lucero (#37 + #42 en un solo aviso). null si no está el pedido. */
export async function textoCourierLucero(f: FilaActuar): Promise<string | null> {
  const nombre = pedidoDeRef(f.ref);
  const { data, error } = await db().from("shopify_pedidos").select("nombre,raw,telefono")
    .eq("nombre", nombre).eq("es_borrador", false).maybeSingle();
  if (error || !data) return null;
  const p = data as Obj;
  const tel = p.telefono == null ? null : String(p.telefono);
  return avisoParaCourier(datosCourierDesdeRaw(nombre, (p.raw ?? null) as Obj | null, tel), PEDIDO_REINTENTO, "lucero");
}

export const depsReales: DepsActuar = {
  tomarCandado: (id, payload) => tomarCandado(id, payload),
  soltarCandado: async (id) => { await db().from("eventos_crudos").delete().eq("fuente", "shopify").eq("id_externo", id); },
  existeCandado: async (id) => {
    const { data } = await db().from("eventos_crudos").select("id_externo").eq("fuente", "shopify").eq("id_externo", id).maybeSingle();
    return !!data;
  },
  avisar: (texto, botones, opts) => avisar(texto, botones, opts),
  textoCourierLucero,
  encolarReprogramar,
  esperar: (ms) => new Promise((z) => setTimeout(z, ms)),
};

async function leerCfgReprogramar() {
  const { data } = await db().from("config").select("valor").eq("clave", "reprogramar_lucero").maybeSingle();
  return data ? configReprogramar(data.valor) : CFG_REPROGRAMAR_APAGADA;
}

export async function filasActuar(): Promise<FilaActuar[]> {
  const { data, error } = await db().from("entregas_para_actuar").select("ref,courier,estado,motivo,fecha_ingreso,tipo");
  if (error) throw new Error(`entregas_para_actuar: ${error.message}`);
  return (data ?? []).filter((x: Obj) => x.tipo === "lucero_fallido" || x.tipo === "pap_ultima_chance").map((x: Obj) => ({
    ref: String(x.ref), courier: String(x.courier ?? ""), estado: String(x.estado ?? ""), motivo: String(x.motivo ?? ""),
    fechaIngreso: x.fecha_ingreso == null ? null : String(x.fecha_ingreso), tipo: x.tipo as TipoActuar,
  }));
}

export async function filasRendicion(): Promise<FilaRendicion[]> {
  const { data, error } = await db().from("rendicion_atrasada").select("ref,courier,fecha_entrega,dias,monto_neto");
  if (error) throw new Error(`rendicion_atrasada: ${error.message}`);
  return (data ?? []).map((x: Obj) => ({
    ref: String(x.ref), courier: String(x.courier ?? ""), dias: Number(x.dias) || 0, montoNeto: Number(x.monto_neto) || 0,
    fechaEntrega: x.fecha_entrega == null ? null : String(x.fecha_entrega),
  }));
}

/** Entrada del cron de 10 min: entregas que piden acción, pedidos parados (9:00) y rendición atrasada. */
export async function entregasParaActuar(ahora: Date, simular: boolean) {
  const atrapar = (nombre: string) => (e: unknown) => ({ error: `${nombre}: ${e instanceof Error ? e.message : String(e)}` });
  const entregas = await (async () => {
    const filas = await filasActuar();
    const cfg = filas.some((f) => f.tipo === "lucero_fallido") ? await leerCfgReprogramar() : CFG_REPROGRAMAR_APAGADA;
    return await procesarEntregasActuar(filas, ahora, cfg, depsReales, simular);
  })().catch(atrapar("entregas_para_actuar"));
  const h = horaPy(ahora);
  const parados = await (async () => {
    if (h < HORA_PARADOS.desde || h >= HORA_PARADOS.hasta) return { resultado: "fuera_de_hora", n: 0 };
    const ps = await leerPedidosParados();
    const cpc = ps.length ? await couriersPorCiudad(ps.map((p) => p.ciudad ?? "")).catch(() => ({})) : {};
    return await avisarParadosDiario(ps, ahora, cpc, depsReales, simular);
  })().catch(atrapar("pedidos_parados"));
  const rendicion = await filasRendicion().then((rs) => avisarRendicionAtrasada(rs, depsReales, simular)).catch(atrapar("rendicion_atrasada"));
  return { entregas, parados, rendicion };
}
