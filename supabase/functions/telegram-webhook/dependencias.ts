// telegram-webhook/dependencias.ts · 27-10: las dependencias reales de procesarCallback (Supabase, Shopify, WhatsApp,
// Telegram), sacadas de index.ts sin cambios para que las use también pago-verificado (mismo "Recibido").
import { db, guardarEventoCrudo } from "../_shared/db.ts";
import { agregarTags, cancelarPedido, orderGid } from "../_shared/shopify.ts";
import { marcarPagado } from "../_shared/shopify_pagos.ts";
import { enviarTexto } from "../_shared/wa.ts";
import { avisar, editarLeyenda, editarMensaje, responderCallback } from "../_shared/telegram.ts";
import type { CicloDecision, DepsDecision, EstadoVersion, VersionMin } from "../mejora-mensual/aprobacion.ts";
import type { ClaveTextoCliente, Dependencias, PedidoContexto } from "./procesar.ts";

export async function obtenerPedido(id: number): Promise<PedidoContexto | null> {
  const { data: p, error } = await db()
    .from("shopify_pedidos")
    .select("shopify_order_id, nombre, estado_confirmacion, estado_envio, tags, cliente_id, raw, courier, telefono")
    .eq("shopify_order_id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!p) return null;
  let cliente: PedidoContexto["cliente"] = null;
  let conversacion: PedidoContexto["conversacion"] = null;
  if (p.cliente_id) {
    const { data: c } = await db()
      .from("wa_clientes")
      .select("id, nombre, telefono, wa_user_id, wa_username")
      .eq("id", p.cliente_id)
      .maybeSingle();
    cliente = c ?? null;
    const { data: conv } = await db()
      .from("wa_conversaciones")
      .select("id, estado, ultima_entrada_en")
      .eq("cliente_id", p.cliente_id)
      .order("ultima_entrada_en", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    conversacion = conv ?? null;
  }
  // 12-10: courier del pedido (para el texto "YA PAGADO"): shopify_pedidos.courier o la transportadora de la venta.
  let courier = (p.courier as string | null) ?? null;
  const n = String(p.nombre ?? "").replace(/\D/g, "");
  if (!courier && n) {
    const { data: v } = await db().from("ventas").select("transportadora").eq("n_referencia", `VT-${n}`)
      .is("deleted_at", null).limit(1).maybeSingle();
    courier = (v?.transportadora as string | undefined) ?? null;
  }
  return {
    shopify_order_id: Number(p.shopify_order_id),
    nombre: p.nombre,
    estado_confirmacion: p.estado_confirmacion,
    estado_envio: p.estado_envio,
    tags: (p.tags as string[] | null) ?? null,
    cliente,
    conversacion,
    raw: (p.raw as Record<string, unknown> | null) ?? null,
    courier,
    telefono: (p.telefono as string | null) ?? null,
  };
}

// Botones mej_* (ciclo mensual de mejora, M3). Tablas de la migración 0012; la activación
// va por la función SQL mejora_activar_version (migración 0013), que archiva la activa y
// activa la nueva en una sola transacción.
function depsMejora(): DepsDecision {
  const version = async (col: "id" | "numero", valor: string | number): Promise<VersionMin | null> => {
    const { data, error } = await db().from("vendedor_versiones").select("id, numero, estado").eq(col, valor).maybeSingle();
    if (error) throw new Error(`vendedor_versiones: ${error.message}`);
    return (data as VersionMin | null) ?? null;
  };
  return {
    ahora: () => new Date(),
    async obtenerCiclo(id) {
      const { data, error } = await db()
        .from("mejora_ciclos")
        .select("id, mes, estado, propuesta_version_id, n_conversaciones, costo_usd, prueba, resumen")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`mejora_ciclos: ${error.message}`);
      return data ? { ...(data as CicloDecision), costo_usd: data.costo_usd == null ? null : Number(data.costo_usd) } : null;
    },
    versionPorId: (id) => version("id", id),
    versionPorNumero: (n) => version("numero", n),
    async versionActiva() {
      const { data, error } = await db().from("vendedor_versiones").select("id, numero, estado").eq("estado", "activa").maybeSingle();
      if (error) throw new Error(`vendedor_versiones: ${error.message}`);
      return (data as VersionMin | null) ?? null;
    },
    async activarVersion(versionId, permitidos: EstadoVersion[]) {
      const { data, error } = await db().rpc("mejora_activar_version", { p_version_id: versionId, p_permitidos: permitidos });
      if (error) return { ok: false, error: error.message };
      const r = (data ?? {}) as { ok?: boolean; ya_activa?: boolean; anterior?: number | null; error?: string };
      return { ok: !!r.ok, ya_activa: !!r.ya_activa, anterior: r.anterior ?? null, error: r.error };
    },
    async marcarVersion(id, estado) {
      const { error } = await db().from("vendedor_versiones").update({ estado }).eq("id", id).neq("estado", "activa");
      if (error) throw new Error(`vendedor_versiones: ${error.message}`);
    },
    async marcarCambiosAplicados(cicloId) {
      const { error } = await db().from("mejora_cambios").update({ aplicado: true }).eq("ciclo_id", cicloId).eq("riesgo", "bajo");
      if (error) throw new Error(`mejora_cambios: ${error.message}`);
    },
    async actualizarEstadoCiclo(id, estado) {
      const { error } = await db().from("mejora_ciclos").update({ estado, actualizado_en: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(`mejora_ciclos: ${error.message}`);
    },
    async listarCambios(cicloId) {
      const { data, error } = await db()
        .from("mejora_cambios")
        .select("tipo, riesgo, antes, despues, motivo, aplicado")
        .eq("ciclo_id", cicloId)
        .order("riesgo", { ascending: true });
      if (error) throw new Error(`mejora_cambios: ${error.message}`);
      return data ?? [];
    },
    reclamar: (clave, payload) => guardarEventoCrudo("telegram", clave, payload),
    liberar: async (clave) => {
      await db().from("eventos_crudos").delete().eq("fuente", "telegram").eq("id_externo", clave);
    },
    enviarMensaje: (html, botones) => avisar(html, botones),
  };
}

export function dependencias(chatId: string): Dependencias {
  return {
    mejora: depsMejora(),
    chatIdPermitido: chatId,
    ahora: () => new Date(),
    guardarEventoCrudo: (idExterno, payload) => guardarEventoCrudo("telegram", idExterno, payload),
    marcarEventoProcesado: async (idExterno, error) => {
      await db()
        .from("eventos_crudos")
        .update({ procesado_en: new Date().toISOString(), error: error ?? null })
        .eq("fuente", "telegram")
        .eq("id_externo", idExterno);
    },
    reclamarAccion: (clave, payload) => guardarEventoCrudo("telegram", clave, payload),
    liberarAccion: async (clave) => {
      await db().from("eventos_crudos").delete().eq("fuente", "telegram").eq("id_externo", clave);
    },
    obtenerPedido,
    cancelarEnShopify: (id) => cancelarPedido(orderGid(id), "Cancelado por Enrique desde Telegram"),
    marcarPedidoCancelado: async (id, avisado) => {
      // estado_confirmacion no tiene un valor para "cancelado por Enrique":
      // se marca el envío como CANCELADO y queda el historial en pedido_estados.
      const { error } = await db()
        .from("shopify_pedidos")
        .update({ estado_envio: "CANCELADO", actualizado_en: new Date().toISOString() })
        .eq("shopify_order_id", id);
      if (error) throw new Error(error.message);
      const r = await db()
        .from("pedido_estados")
        .upsert(
          { shopify_order_id: id, estado: "CANCELADO", fuente: "telegram", notificado: avisado },
          { onConflict: "shopify_order_id,estado", ignoreDuplicates: true },
        );
      if (r.error) throw new Error(r.error.message);
    },
    cancelarEnviosPendientes: async (id) => {
      const { error } = await db()
        .from("envios_programados")
        .update({ estado: "cancelado", ultimo_error: "pedido cancelado desde Telegram" })
        .eq("shopify_order_id", id)
        .eq("estado", "pendiente");
      if (error) throw new Error(error.message);
    },
    pasarAHumano: async (conversacionId) => {
      const { error } = await db()
        .from("wa_conversaciones")
        .update({ estado: "humano", asignado_a: "enrique" })
        .eq("id", conversacionId);
      if (error) throw new Error(error.message);
    },
    // Pago anticipado verificado en ueno (botón pagado:<id>). orderMarkAsPaid requiere write_orders.
    marcarPagadoEnShopify: (id) => marcarPagado(id),
    agregarTagsShopify: (id, tags) => agregarTags(orderGid(id), tags),
    guardarTagsPedido: async (id, tags) => {
      const { error } = await db()
        .from("shopify_pedidos")
        .update({ tags, actualizado_en: new Date().toISOString() })
        .eq("shopify_order_id", id);
      if (error) throw new Error(error.message);
    },
    textoCliente: async (clave: ClaveTextoCliente) => {
      const { data } = await db().from("config_wa").select("valor").eq("clave", "textos_decisiones").maybeSingle();
      const v = (data?.valor as Record<string, unknown> | undefined)?.[clave];
      return typeof v === "string" && v.trim() ? v : null;
    },
    enviarTextoCliente: (pedido, destino, texto) =>
      enviarTexto(destino, texto, {
        clienteId: pedido.cliente?.id ?? null,
        conversacionId: pedido.conversacion?.id ?? null,
      }),
    responderCallback: async (id, texto) => {
      await responderCallback(id, texto);
    },
    editarMensaje: async (chat, messageId, html, botones) => {
      const r = await editarMensaje(chat, messageId, html, botones);
      if (!r.ok) console.error("editMessageText:", r.error);
    },
    // 12-10: el aviso del comprobante es una foto o un PDF: se edita la leyenda.
    editarLeyenda: async (chat, messageId, html, botones) => {
      const r = await editarLeyenda(chat, messageId, html, botones);
      if (!r.ok) console.error("editMessageCaption:", r.error);
    },
    avisar: (html, botones, opts) => avisar(html, botones, opts),
    // 12-10: "Recibido" → la venta (VT-<n>) queda como pago anticipado: Despacho "Desde Ventas" sale con cobro 0 y la
    // rendición no espera ese cobro del courier. Si todavía no está en Ventas, entra pagada (tags PAGO_VERIFICADO/PAGADO).
    marcarVentaPagada: async (pedido) => {
      const n = String(pedido.nombre ?? "").replace(/\D/g, "");
      if (!n) return 0;
      const actualizar = (cambios: Record<string, unknown>) =>
        db().from("ventas").update(cambios).eq("n_referencia", `VT-${n}`).is("deleted_at", null).select("id");
      let { data, error } = await actualizar({ pago_anticipado: true, metodo_pago_nombre: "Transferencia (anticipado)" });
      // Sin la columna del nombre del método (base vieja), lo importante es pago_anticipado.
      if (error && /metodo_pago_nombre/.test(error.message)) ({ data, error } = await actualizar({ pago_anticipado: true }));
      if (error) throw new Error(error.message);
      return data?.length ?? 0;
    },
  };
}
