// _shared/vendedor/io.ts · Dueño: G1 (ola 2)
// I/O real del vendedor (Supabase, Shopify, WhatsApp, Telegram, Claude). La lógica está en orquestador.ts y
// herramientas.ts; acá solo se conectan las dependencias.
import { db } from "../db.ts";
import { llamarClaude } from "../claude.ts";
import { gql } from "../shopify.ts";
import { avisar } from "../telegram.ts";
import { normalizarTelefonoPY } from "../telefono.ts";
import { enviarTexto, marcarLeidoYEscribiendo } from "../wa.ts";
import { enviarInteractivo } from "../wa_interactivos.ts";
import { normalizarDesdeGraphQL, procesarPedido } from "../../shopify-webhook/procesar.ts";
import { depsReales as depsShopifyWebhook } from "../../shopify-webhook/io.ts";
import { armarConfigTurno, CLAVES_CONFIG_VENDEDOR } from "./config.ts";
import { enviarMedia } from "./enviar_wa.ts";
import { montosDeResultado } from "./filtro_salida.ts";
import type { DepsOrquestador, FilaHistorial } from "./orquestador.ts";
import type { ConfigTurno, DepsHerramientas, PedidoChat, PedidoCliente, ProductoShopify } from "./tipos.ts";
import { crearCacheVersion, type FilaVersion } from "./version_activa.ts";

function falla(contexto: string, error: { message: string } | null): void {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

// ---------- Shopify ----------

const QUERY_CATALOGO = `query($q: String) {
  products(first: 50, query: $q, sortKey: TITLE) {
    nodes {
      id handle title status
      featuredMedia { preview { image { url } } }
      variants(first: 10) { nodes { id title price availableForSale } }
    }
  }
}`;

type NodoProducto = {
  id: string;
  handle: string;
  title: string;
  status: string;
  featuredMedia: { preview?: { image?: { url?: string } | null } | null } | null;
  variants: { nodes: Array<{ id: string; title: string; price: string; availableForSale: boolean }> };
};

/** Campos del pedido que necesitan normalizarDesdeGraphQL + armarEnvios (los mismos que pide shopify-conciliar). */
const CAMPOS_PEDIDO = `id legacyResourceId name phone createdAt cancelledAt tags
  customAttributes { key value }
  totalPriceSet { shopMoney { amount } }
  lineItems(first: 20) { nodes { quantity title } }
  shippingAddress { phone name firstName lastName address1 address2 city }
  billingAddress { phone }
  customer { firstName lastName defaultPhoneNumber { phoneNumber } }`;

const MUTACION_ORDER_CREATE = `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { ${CAMPOS_PEDIDO} }
    userErrors { field message }
  }
}`;

// ---------- dependencias de las herramientas ----------

export const depsHerramientasReales: DepsHerramientas = {
  async catalogoShopify(estado) {
    const d = await gql<{ products: { nodes: NodoProducto[] } }>(QUERY_CATALOGO, { q: `status:${estado.toLowerCase()}` });
    return d.products.nodes.map((n): ProductoShopify => ({
      id: n.id,
      handle: n.handle,
      title: n.title,
      status: n.status,
      imagen: n.featuredMedia?.preview?.image?.url ?? null,
      variantes: n.variants.nodes.map((v) => ({ id: v.id, title: v.title, price: Number(v.price), disponible: v.availableForSale }))
        .filter((v) => Number.isFinite(v.price)),
    }));
  },

  async pedidosDeCliente(clienteId, telefono) {
    const { data, error } = await db().from("shopify_pedidos")
      .select("shopify_order_id,nombre,estado_confirmacion,estado_envio,courier,total,creado_en")
      .eq("es_borrador", false)
      .or(telefono ? `cliente_id.eq.${clienteId},telefono.eq.${telefono}` : `cliente_id.eq.${clienteId}`)
      .order("creado_en", { ascending: false }).limit(5);
    falla("pedidos del cliente", error);
    const pedidos = (data ?? []) as PedidoCliente[];
    if (!pedidos.length) return pedidos;
    const { data: est } = await db().from("pedido_estados").select("shopify_order_id,estado,creado_en")
      .in("shopify_order_id", pedidos.map((p) => p.shopify_order_id)).order("creado_en", { ascending: false });
    for (const p of pedidos) {
      const e = (est ?? []).find((x) => Number(x.shopify_order_id) === Number(p.shopify_order_id));
      p.ultimo_estado = e ? { estado: e.estado, creado_en: e.creado_en } : null;
    }
    return pedidos;
  },

  async guardarPedidoChat(fila) {
    const datos = {
      conversacion_id: fila.conversacion_id,
      cliente_id: fila.cliente_id,
      estado: fila.estado,
      datos: fila.datos,
      total: fila.total,
      shopify_order_id: fila.shopify_order_id,
      actualizado_en: new Date().toISOString(),
    };
    const q = fila.id
      ? db().from("wa_pedidos_chat").update(datos).eq("id", fila.id)
      : db().from("wa_pedidos_chat").insert(datos);
    const { data, error } = await q.select("*").single();
    falla("wa_pedidos_chat", error);
    return data as PedidoChat;
  },

  async ultimoPedidoChat(conversacionId) {
    const { data, error } = await db().from("wa_pedidos_chat").select("*").eq("conversacion_id", conversacionId)
      .order("creado_en", { ascending: false }).limit(1).maybeSingle();
    falla("último pedido del chat", error);
    return (data ?? null) as PedidoChat | null;
  },

  async crearOrdenShopify(input) {
    try {
      const d = await gql<{
        orderCreate: { order: Record<string, unknown> | null; userErrors: Array<{ field?: string[]; message: string }> };
      }>(MUTACION_ORDER_CREATE, input);
      const errores = d.orderCreate.userErrors ?? [];
      if (errores.length || !d.orderCreate.order) {
        return { ok: false, error: errores.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join("; ") || "orderCreate sin pedido" };
      }
      const o = d.orderCreate.order;
      const total = Number((o.totalPriceSet as { shopMoney?: { amount?: string } } | undefined)?.shopMoney?.amount);
      return {
        ok: true,
        shopify_order_id: Number(o.legacyResourceId ?? String(o.id).split("/").pop()),
        gid: String(o.id),
        nombre: String(o.name ?? ""),
        total: Number.isFinite(total) ? total : null,
        nodo: o,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async registrarComoReleasit(nodo) {
    // Mismo camino que shopify-webhook / shopify-conciliar: upsert de cliente y pedido + confirmación (+2 min),
    // recordatorio, retención y cancelación en envios_programados. Idempotente por clave_unica.
    await procesarPedido(normalizarDesdeGraphQL(nodo), depsShopifyWebhook());
  },

  async pasarAHumano(conversacionId) {
    const { error } = await db().from("wa_conversaciones").update({ estado: "humano", asignado_a: "enrique" }).eq("id", conversacionId);
    falla("pasar a humano", error);
  },

  avisar: (texto, botones) => avisar(texto, botones),
  enviarTexto: (to, texto, opts) => enviarTexto(to, texto, opts),
  enviarInteractivo: (to, interactive, opts) => enviarInteractivo(to, interactive, opts),
  enviarMedia: (to, tipo, link, caption, opts) => enviarMedia(to, tipo, link, caption, opts),
  normalizarTelefono: normalizarTelefonoPY,
};

// ---------- dependencias del orquestador ----------

let cacheConfig: { cfg: ConfigTurno; hasta: number } | null = null;

/** Versión activa del prompt (ciclo mensual de mejora), con caché de 5 min. Sin tabla o sin activa: null. */
const versionActiva = crearCacheVersion(async (): Promise<FilaVersion | null> => {
  const { data, error } = await db().from("vendedor_versiones").select("numero,prompt,ejemplos,faq,objeciones")
    .eq("estado", "activa").maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as FilaVersion | null;
});

export const depsOrquestadorReales: DepsOrquestador = {
  async config() {
    if (cacheConfig && cacheConfig.hasta > Date.now()) return cacheConfig.cfg;
    const { data, error } = await db().from("config_wa").select("clave,valor").in("clave", [...CLAVES_CONFIG_VENDEDOR]);
    falla("config_wa (vendedor)", error);
    const filas: Record<string, unknown> = Object.fromEntries((data ?? []).map((f) => [f.clave, f.valor]));
    // Versión activa de vendedor_versiones > config_wa.vendedor_prompt > prompt del archivo.
    const plantillaVersion = await versionActiva.obtener();
    if (plantillaVersion) filas.vendedor_prompt = plantillaVersion;
    const { cfg, faltantes } = armarConfigTurno(filas);
    if (faltantes.length) console.warn(`vendedor: config_wa sin ${faltantes.join(", ")}: uso los valores por defecto del código`);
    cacheConfig = { cfg, hasta: Date.now() + 60_000 };
    return cfg;
  },

  async conversacion(id) {
    let r = await db().from("wa_conversaciones").select("id,estado,cliente_id,turnos_ia,perfil_vendedor").eq("id", id).maybeSingle();
    // Sin la migración 0011 todavía aplicada: se sigue sin perfil (no se corta el vendedor).
    if (r.error && /perfil_vendedor/.test(r.error.message)) {
      console.warn("vendedor: falta la columna perfil_vendedor (migración 20261006000011): sigo sin perfil");
      r = await db().from("wa_conversaciones").select("id,estado,cliente_id,turnos_ia").eq("id", id).maybeSingle();
    }
    falla("conversación", r.error);
    const data = r.data as { id: string; estado: string; cliente_id: string; turnos_ia: number | null; perfil_vendedor?: unknown } | null;
    if (!data) return null;
    // 07-10: el tope de turnos cuenta solo las respuestas de las últimas 24 h. turnos_ia es acumulado de por
    // vida y un cliente que volvía días después (o la prueba de Enrique) chocaba el tope y el chat se callaba.
    const desde = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const c = await db().from("vendedor_turnos").select("id", { count: "exact", head: true })
      .eq("conversacion_id", id).eq("accion", "respondido").gte("creado_en", desde);
    const recientes = c.error ? Number(data.turnos_ia ?? 0) : (c.count ?? 0);
    return { ...data, turnos_ia: recientes };
  },

  async guardarPerfil(conversacionId, perfil) {
    const { error } = await db().from("wa_conversaciones").update({ perfil_vendedor: perfil }).eq("id", conversacionId);
    falla("perfil del cliente", error);
  },

  async cliente(id) {
    const { data, error } = await db().from("wa_clientes").select("id,telefono,wa_user_id,nombre").eq("id", id).maybeSingle();
    falla("cliente", error);
    return data ?? null;
  },

  async historial(conversacionId, limite) {
    const { data, error } = await db().from("wa_mensajes").select("direccion,texto,tipo,contenido,estado,wa_message_id,creado_en")
      .eq("conversacion_id", conversacionId).order("creado_en", { ascending: false }).limit(limite);
    falla("historial", error);
    return ((data ?? []) as FilaHistorial[]).reverse();
  },

  async ultimoEntranteId(conversacionId) {
    const { data } = await db().from("wa_mensajes").select("wa_message_id").eq("conversacion_id", conversacionId)
      .eq("direccion", "in").order("creado_en", { ascending: false }).limit(1).maybeSingle();
    return data?.wa_message_id ?? null;
  },

  async gastoMesUsd(desdeISO) {
    const { data, error } = await db().rpc("vendedor_gasto_desde", { p_desde: desdeISO });
    falla("gasto del mes", error);
    return Number(data ?? 0);
  },

  async preciosPrevios(conversacionId) {
    const { data, error } = await db().from("vendedor_turnos").select("herramientas").eq("conversacion_id", conversacionId)
      .order("creado_en", { ascending: false }).limit(50);
    falla("precios previos", error);
    const montos: number[] = [];
    for (const f of data ?? []) {
      for (const h of (Array.isArray(f.herramientas) ? f.herramientas : []) as Array<{ resultado?: unknown; error?: boolean }>) {
        if (!h.error) montos.push(...montosDeResultado(h.resultado));
      }
    }
    return [...new Set(montos)];
  },

  async registrarTurno(fila) {
    const { error } = await db().from("vendedor_turnos").insert(fila);
    falla("vendedor_turnos", error);
  },

  async sumarTurno(conversacionId, costoUsd) {
    const { error } = await db().rpc("vendedor_sumar_turno", { p_conversacion: conversacionId, p_costo: costoUsd });
    falla("sumar turno", error);
  },

  marcarLeidoYEscribiendo: (id) => marcarLeidoYEscribiendo(id),
  llamarModelo: (p) => llamarClaude(p),
  dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
  ahora: () => new Date(),
  herramientas: depsHerramientasReales,
};
