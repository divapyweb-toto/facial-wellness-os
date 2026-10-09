// procesar-envios · Edge Function que corre cada minuto (Supabase Cron).
// Toma de envios_programados los 'pendiente' vencidos (lote con bloqueo) y los manda,
// los reprograma o ejecuta la acción (retener / cancelar). La lógica está en procesar.ts.
//
// Bloqueo: usa la función SQL reclamar_envios_programados (migración 20261006000002).
// Si todavía no está aplicada, cae a un bloqueo optimista fila por fila
// (update ... where estado='pendiente' and enviar_desde=<valor leído> returning).

import { db } from "../_shared/db.ts";
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { dentroHorarioMarketing, proximaAperturaMarketing } from "../_shared/horario.ts";
import { enviarBotones, enviarPlantilla, enviarTexto } from "../_shared/wa.ts";
import { agregarTags, cancelarPedido, orderGid } from "../_shared/shopify.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { registrarBaja } from "../recompra/baja.ts";
import { envioSeguimientoParaPedido } from "../factura/io.ts";
import { type CambioEnvio, configDesdeFilas, type Contexto, type Deps, type Envio, procesarLote } from "./procesar.ts";

const CLAVES_CONFIG = [
  "horario_marketing",
  "horario_avisos_envio",
  "usar_texto_libre_en_ventana",
  "textos_libres",
  "procesar_envios",
  "ola4.factura",
];
const COLUMNAS =
  "id,cliente_id,shopify_order_id,plantilla,variables,categoria,enviar_desde,estado,clave_unica,intentos,ultimo_error";

async function reclamar(lote: number, leaseMin: number): Promise<Envio[]> {
  const sb = db();
  const { data, error } = await sb.rpc("reclamar_envios_programados", { p_lote: lote, p_lease_min: leaseMin });
  if (!error) return (data ?? []) as Envio[];
  // PGRST202 / 42883: la función no existe todavía → bloqueo optimista.
  if (error.code !== "PGRST202" && error.code !== "42883") throw new Error(`reclamar: ${error.message}`);

  const ahora = new Date();
  const { data: filas, error: e2 } = await sb.from("envios_programados").select(COLUMNAS)
    .eq("estado", "pendiente").lte("enviar_desde", ahora.toISOString())
    .order("enviar_desde", { ascending: true }).limit(lote);
  if (e2) throw new Error(`reclamar (select): ${e2.message}`);
  const lease = new Date(ahora.getTime() + leaseMin * 60_000).toISOString();
  const tomados: Envio[] = [];
  for (const f of (filas ?? []) as Envio[]) {
    const { data: ok } = await sb.from("envios_programados").update({ enviar_desde: lease })
      .eq("id", f.id).eq("estado", "pendiente").eq("enviar_desde", f.enviar_desde).select(COLUMNAS);
    if (ok && ok.length) tomados.push(ok[0] as Envio);
  }
  return tomados;
}

async function contexto(e: Envio): Promise<Contexto> {
  const sb = db();
  const [cli, ped, cons, conv] = await Promise.all([
    e.cliente_id
      ? sb.from("wa_clientes").select("telefono,wa_user_id,nombre").eq("id", e.cliente_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    e.shopify_order_id != null
      ? sb.from("shopify_pedidos").select("shopify_order_id,nombre,estado_confirmacion,tags,total,raw,estado_envio")
        .eq("shopify_order_id", e.shopify_order_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    e.cliente_id
      ? sb.from("wa_consentimientos").select("estado").eq("cliente_id", e.cliente_id).eq("tipo", "marketing")
        .order("creado_en", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    e.cliente_id
      ? sb.from("wa_conversaciones").select("id,ultima_entrada_en").eq("cliente_id", e.cliente_id)
        .order("ultima_entrada_en", { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  for (const r of [cli, ped, cons, conv]) if (r.error) throw new Error(`contexto: ${r.error.message}`);
  const c = conv.data as { id: string; ultima_entrada_en: string | null } | null;
  return {
    cliente: cli.data as Contexto["cliente"],
    pedido: ped.data as Contexto["pedido"],
    consentimientoMarketing: (cons.data as { estado: "si" | "no" | "baja" } | null)?.estado ?? null,
    ultimaEntrada: c?.ultima_entrada_en ? new Date(c.ultima_entrada_en) : null,
    conversacionId: c?.id ?? null,
  };
}

async function actualizarEnvio(id: string, cambio: CambioEnvio): Promise<void> {
  let { error } = await db().from("envios_programados").update(cambio).eq("id", id);
  // 09-10: mientras no exista la columna wa_message_id, se guarda el resto igual.
  if (error && cambio.wa_message_id && /wa_message_id/.test(error.message)) {
    const { wa_message_id: _, ...resto } = cambio;
    ({ error } = await db().from("envios_programados").update(resto).eq("id", id));
  }
  if (error) throw new Error(`actualizarEnvio: ${error.message}`);
}

async function marcarPedido(orderId: number, estado: string, tag?: string): Promise<void> {
  const sb = db();
  const { data } = await sb.from("shopify_pedidos").select("tags").eq("shopify_order_id", orderId).maybeSingle();
  const tags = new Set<string>((data?.tags as string[] | null) ?? []);
  if (tag) tags.add(tag);
  const { error } = await sb.from("shopify_pedidos")
    .update({ estado_confirmacion: estado, tags: [...tags] }).eq("shopify_order_id", orderId);
  if (error) throw new Error(`marcarPedido: ${error.message}`);
}

const deps = (cfg: Deps["cfg"]): Deps => ({
  ahora: () => new Date(),
  cfg,
  horario: { dentro: dentroHorarioMarketing, proxima: proximaAperturaMarketing },
  reclamar,
  contexto,
  actualizarEnvio,
  enviarPlantilla,
  enviarTexto,
  enviarBotones,
  retenerPedido: async (id) => {
    const r = await agregarTags(orderGid(id), ["RETENIDO_SIN_RESPUESTA"]);
    if (!r.ok) return { ok: false, error: r.error };
    await marcarPedido(id, "retenido", "RETENIDO_SIN_RESPUESTA");
    return { ok: true };
  },
  cancelarPedidoSinRespuesta: async (id) => {
    const r = await cancelarPedido(orderGid(id), "Sin confirmación por WhatsApp en 72 h");
    if (!r.ok) return { ok: false, error: r.error };
    await marcarPedido(id, "cancelado_sin_respuesta");
    await db().from("envios_programados").update({
      estado: "cancelado",
      ultimo_error: "pedido_cancelado_sin_respuesta",
    })
      .eq("shopify_order_id", id).eq("estado", "pendiente");
    return { ok: true };
  },
  avisar,
  escapar: escaparHtml,
  registrarBaja: (clienteId) => registrarBaja(clienteId, "meta_131050"),
  seguimientoConFactura: (orderId, variables) => envioSeguimientoParaPedido(orderId, variables),
});

Deno.serve(conServiceRole(async (_req) => {
  try {
    const { data, error } = await db().from("config_wa").select("clave,valor").in("clave", CLAVES_CONFIG);
    if (error) throw new Error(`config_wa: ${error.message}`);
    const resumen = await procesarLote(deps(configDesdeFilas(data ?? [])));
    return Response.json({ ok: true, ...resumen });
  } catch (e) {
    console.error("procesar-envios:", e);
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}));
