// _shared/vendedor/pedidos_web_io.ts · Dueño: W2 (19-10)
// I/O real de buscar_pedido / modificar_pedido / guardar_factura (la lógica está en pedidos_web.ts).
// Supabase: shopify_pedidos (búsqueda), wa_pedidos_vinculados y wa_modificaciones_pedido (migración
// 20261019000002_modificaciones_pedido.sql), eventos_crudos (candados de Meta). Shopify: Admin GraphQL 2026-10.
// Nada de esto corre en los tests: se prueba con scripts/probar-modificar-pedido.mjs (pedidos PRUEBA).
import { db, guardarEventoCrudo } from "../db.ts";
import { gql } from "../shopify.ts";
import { idCandado } from "../../shopify-webhook/lead_meta.ts";
import { EVENTO_LEAD, EVENTO_PURCHASE } from "../meta_capi.ts";
import {
  type Atributo,
  type CandidatoPedido,
  claveTelefono,
  type DepsPedidosWeb,
  mezclarAtributos,
  type ModificacionPedido,
  type PedidoWeb,
} from "./pedidos_web.ts";

function falla(contexto: string, error: { message: string } | null): void {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

const gidOrden = (id: number | string) => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/Order/${id}`);
const idNumerico = (gid: string) => Number(String(gid).split("/").pop());
const mensajes = (ue: Array<{ field?: string[] | null; message: string }> | null | undefined) =>
  (ue ?? []).map((e) => `${(e.field ?? []).join(".")}${e.field?.length ? ": " : ""}${e.message}`).join("; ");

/** Estados del courier que significan "ya está en manos del courier": no se modifica. */
const ENVIO_EN_CURSO = new Set(["EN_PREPARACION", "DESPACHADO", "INTENTO_FALLIDO", "ENTREGADO", "NO_ENTREGADO_RESCATABLE", "NO_ENTREGADO", "RENDIDO"]);

const QUERY_PEDIDO = `query($id: ID!) {
  order(id: $id) {
    id legacyResourceId name createdAt cancelledAt phone email tags note merchantEditable displayFulfillmentStatus
    app { name }
    customAttributes { key value }
    currentTotalPriceSet { shopMoney { amount } }
    totalShippingPriceSet { shopMoney { amount } }
    customer { id firstName lastName }
    shippingAddress { firstName lastName name address1 address2 city countryCodeV2 phone }
    lineItems(first: 50) {
      nodes {
        id title currentQuantity
        variant { id product { handle } }
        discountedUnitPriceSet { shopMoney { amount } }
      }
    }
  }
}`;

type NodoPedido = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  note: string | null;
  merchantEditable: boolean | null;
  displayFulfillmentStatus: string | null;
  app: { name: string | null } | null;
  customAttributes: Atributo[];
  currentTotalPriceSet: { shopMoney: { amount: string } };
  totalShippingPriceSet: { shopMoney: { amount: string } } | null;
  customer: { id: string; firstName: string | null; lastName: string | null } | null;
  shippingAddress: {
    firstName: string | null; lastName: string | null; name: string | null; address1: string | null; address2: string | null;
    city: string | null; countryCodeV2: string | null; phone: string | null;
  } | null;
  lineItems: {
    nodes: Array<{
      id: string; title: string; currentQuantity: number;
      variant: { id: string; product: { handle: string } | null } | null;
      discountedUnitPriceSet: { shopMoney: { amount: string } };
    }>;
  };
};

/** Reintenta sin un campo si la API 2026-10 no lo conoce (nombres que Shopify fue cambiando entre versiones). */
async function conAlternativa<T>(principal: () => Promise<T>, alternativa: (() => Promise<T>) | null, campo: RegExp): Promise<T> {
  try {
    return await principal();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (alternativa && campo.test(m)) return await alternativa();
    throw e;
  }
}

export const depsPedidosWebReales: DepsPedidosWeb = {
  async idPorNumero(numero) {
    const r = await gql<{ orders: { nodes: Array<{ legacyResourceId: string }> } }>(
      `query($q: String!) { orders(first: 1, query: $q) { nodes { legacyResourceId } } }`, { q: `name:#${numero}` },
    );
    const id = Number(r.orders?.nodes?.[0]?.legacyResourceId);
    return Number.isFinite(id) && id > 0 ? id : null;
  },

  async candidatos(f) {
    let q = db().from("shopify_pedidos").select(
      "shopify_order_id,nombre,telefono,cliente_id,creado_en,estado_confirmacion,total," +
        "n1:raw->shipping_address->>name,n2:raw->shippingAddress->>name,n3:raw->customer->>first_name,n4:raw->customer->>last_name," +
        "c1:raw->>cancelled_at,c2:raw->>cancelledAt,a1:raw->note_attributes,a2:raw->customAttributes,creado_shopify:raw->>created_at",
    ).eq("es_borrador", false);
    if (f.numero) q = q.eq("nombre", `#${f.numero}`);
    if (f.telefono) {
      const clave = claveTelefono(f.telefono);
      if (clave) q = q.ilike("telefono", `%${clave}`);
    }
    if (f.desdeISO) q = q.gte("creado_en", f.desdeISO);
    const { data, error } = await q.order("creado_en", { ascending: false }).limit(f.limite ?? 50);
    falla("buscar pedidos", error);
    return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r): CandidatoPedido => {
      // REST (webhook) guarda note_attributes {name,value}; GraphQL (bot) customAttributes {key,value}.
      const attrs = [...(Array.isArray(r.a1) ? r.a1 : []), ...(Array.isArray(r.a2) ? r.a2 : [])] as Array<Record<string, unknown>>;
      const chat = attrs.find((a) => ["conversacion_id", "chat_vinculado"].includes(String(a.name ?? a.key ?? "")));
      const n34 = [r.n3, r.n4].filter(Boolean).join(" ");
      return {
        shopify_order_id: Number(r.shopify_order_id),
        nombre: String(r.nombre ?? ""),
        telefono: (r.telefono as string | null) ?? null,
        cliente_id: (r.cliente_id as string | null) ?? null,
        nombre_cliente: String(r.n1 ?? r.n2 ?? (n34 || "")) || null,
        creado_en: String(r.creado_shopify ?? r.creado_en),
        estado_confirmacion: (r.estado_confirmacion as string | null) ?? null,
        total: r.total == null ? null : Number(r.total),
        cancelado: !!(r.c1 || r.c2),
        conversacion_id: chat ? String(chat.value ?? "") || null : null,
      };
    });
  },

  async pedidoCompleto(orderId) {
    const d = await gql<{ order: NodoPedido | null }>(QUERY_PEDIDO, { id: gidOrden(orderId) });
    const o = d.order;
    if (!o) return null;
    const id = Number(o.legacyResourceId);
    const { data: fila } = await db().from("shopify_pedidos").select("cliente_id,telefono,estado_confirmacion,estado_envio")
      .eq("shopify_order_id", id).maybeSingle();
    // Si ya está cargado en ventas (VT-<n>), el stock ya se descontó con ese pedido: no se reemplaza (doble descuento).
    const n = o.name.replace(/\D/g, "");
    const { count } = n
      ? await db().from("ventas").select("id", { count: "exact", head: true }).eq("n_referencia", `VT-${n}`).is("deleted_at", null)
      : { count: 0 };
    const fs = String(o.displayFulfillmentStatus ?? "").toUpperCase();
    const a = o.shippingAddress;
    return {
      shopify_order_id: id,
      gid: o.id,
      nombre: o.name,
      creado_en: o.createdAt,
      telefono: o.phone ?? a?.phone ?? (fila?.telefono as string | null) ?? null,
      email: o.email,
      cliente_id: (fila?.cliente_id as string | null) ?? null,
      customer_gid: o.customer?.id ?? null,
      nombre_cliente: a?.name ?? ([o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ") || null),
      total: Number(o.currentTotalPriceSet.shopMoney.amount),
      envio: Number(o.totalShippingPriceSet?.shopMoney.amount ?? 0),
      cancelado: !!o.cancelledAt,
      despachado: ["FULFILLED", "PARTIALLY_FULFILLED", "IN_PROGRESS", "PENDING_FULFILLMENT"].includes(fs) ||
        ENVIO_EN_CURSO.has(String(fila?.estado_envio ?? "")) || (count ?? 0) > 0,
      estado_confirmacion: (fila?.estado_confirmacion as string | null) ?? null,
      app: o.app?.name ?? null,
      merchant_editable: o.merchantEditable,
      tags: o.tags ?? [],
      atributos: (o.customAttributes ?? []).map((x) => ({ key: x.key, value: x.value ?? "" })),
      nota: o.note,
      direccion: a ? { firstName: a.firstName, lastName: a.lastName, address1: a.address1, address2: a.address2, city: a.city, countryCode: a.countryCodeV2, phone: a.phone } : null,
      lineas: o.lineItems.nodes.filter((l) => l.currentQuantity > 0).map((l) => ({
        line_item_id: l.id,
        variante_id: l.variant?.id ?? null,
        handle: l.variant?.product?.handle ?? null,
        titulo: l.title,
        cantidad: l.currentQuantity,
        total: Math.round(Number(l.discountedUnitPriceSet.shopMoney.amount) * l.currentQuantity),
      })),
    } satisfies PedidoWeb;
  },

  async vinculados(conversacionId) {
    const { data, error } = await db().from("wa_pedidos_vinculados").select("shopify_order_id")
      .eq("conversacion_id", conversacionId).order("creado_en", { ascending: false }).limit(20);
    falla("pedidos vinculados", error);
    return (data ?? []).map((r) => Number(r.shopify_order_id));
  },

  async pedidosConChat(orderIds) {
    if (!orderIds.length) return [];
    const [v, c] = await Promise.all([
      db().from("wa_pedidos_vinculados").select("shopify_order_id").in("shopify_order_id", orderIds).neq("fuente", "busqueda"),
      db().from("wa_pedidos_chat").select("shopify_order_id").in("shopify_order_id", orderIds).eq("estado", "creado"),
    ]);
    falla("pedidos con chat (vínculos)", v.error);
    falla("pedidos con chat (bot)", c.error);
    return [...new Set([...(v.data ?? []), ...(c.data ?? [])].map((r) => Number(r.shopify_order_id)))];
  },

  async vincular(conversacionId, orderId, fuente) {
    // "busqueda" no pisa un vínculo más fuerte (confirmado / modificación / factura).
    const { error } = await db().from("wa_pedidos_vinculados").upsert(
      { conversacion_id: conversacionId, shopify_order_id: orderId, fuente, actualizado_en: new Date().toISOString() },
      { onConflict: "conversacion_id,shopify_order_id", ignoreDuplicates: fuente === "busqueda" },
    );
    falla("vincular chat y pedido", error);
    if (fuente === "busqueda") return;
    // Atributo en Shopify: chat_vinculado (NO conversacion_id, que marca "lo creó el bot desde este chat").
    await depsPedidosWebReales.actualizarAtributos(gidOrden(orderId), [{ key: "chat_vinculado", value: conversacionId }])
      .catch((e) => console.warn("vincular: atributo chat_vinculado:", e instanceof Error ? e.message : e));
  },

  async guardarModificacion(fila) {
    const datos = {
      conversacion_id: fila.conversacion_id,
      cliente_id: fila.cliente_id,
      shopify_order_id: fila.shopify_order_id,
      estado: fila.estado,
      datos: fila.datos,
      nuevo_order_id: fila.nuevo_order_id,
      nuevo_nombre: fila.nuevo_nombre,
      error: fila.error,
      actualizado_en: new Date().toISOString(),
    };
    const q = fila.id
      ? db().from("wa_modificaciones_pedido").update(datos).eq("id", fila.id)
      : db().from("wa_modificaciones_pedido").insert(datos);
    const { data, error } = await q.select("*").single();
    falla("wa_modificaciones_pedido", error);
    return data as ModificacionPedido;
  },

  async modificacion(id) {
    const { data, error } = await db().from("wa_modificaciones_pedido").select("*").eq("id", id).maybeSingle();
    falla("leer modificación", error);
    return (data ?? null) as ModificacionPedido | null;
  },

  async ultimaModificacion(conversacionId) {
    const { data, error } = await db().from("wa_modificaciones_pedido").select("*").eq("conversacion_id", conversacionId)
      .order("creado_en", { ascending: false }).limit(1).maybeSingle();
    falla("última modificación", error);
    return (data ?? null) as ModificacionPedido | null;
  },

  async tomarModificacion(id) {
    // Atómico: dos Confirmo seguidos → solo uno pasa de 'resumen' a 'ejecutando'. El índice único parcial de la
    // migración frena además dos resúmenes distintos ejecutándose a la vez sobre el mismo pedido.
    const { data, error } = await db().from("wa_modificaciones_pedido")
      .update({ estado: "ejecutando", actualizado_en: new Date().toISOString() })
      .eq("id", id).eq("estado", "resumen").select("id");
    if (error && /duplicate|unique/i.test(error.message)) return false;
    falla("tomar modificación", error);
    return (data ?? []).length > 0;
  },

  async editarOrden(gid, plan, totalEsperado) {
    try {
      const b = await gql<{ orderEditBegin: { calculatedOrder: { id: string } | null; userErrors: Array<{ field?: string[]; message: string }> } }>(
        `mutation($id: ID!) { orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } } }`, { id: gid });
      const ue = b.orderEditBegin.userErrors ?? [];
      if (ue.length || !b.orderEditBegin.calculatedOrder) {
        const m = mensajes(ue) || "orderEditBegin sin calculatedOrder";
        return { ok: false, error: m, no_editable: /cannot be edited|not editable|no se puede editar/i.test(m) };
      }
      const calc = b.orderEditBegin.calculatedOrder.id;
      let total: number | null = null;
      const leerTotal = (o: { totalPriceSet?: { shopMoney: { amount: string } } } | null | undefined) => {
        if (o?.totalPriceSet) total = Number(o.totalPriceSet.shopMoney.amount);
      };
      // El CalculatedLineItem comparte el número del LineItem.
      for (const li of plan.quitar) {
        const r = await gql<{ orderEditSetQuantity: { calculatedOrder: { totalPriceSet: { shopMoney: { amount: string } } } | null; userErrors: Array<{ field?: string[]; message: string }> } }>(
          `mutation($id: ID!, $li: ID!) { orderEditSetQuantity(id: $id, lineItemId: $li, quantity: 0, restock: true) {
            calculatedOrder { totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`,
          { id: calc, li: `gid://shopify/CalculatedLineItem/${idNumerico(li)}` });
        if (r.orderEditSetQuantity.userErrors?.length) return { ok: false, error: `setQuantity: ${mensajes(r.orderEditSetQuantity.userErrors)}` };
        leerTotal(r.orderEditSetQuantity.calculatedOrder);
      }
      for (const u of plan.agregar) {
        const r = await gql<{ orderEditAddVariant: {
          calculatedLineItem: { id: string; originalUnitPriceSet: { shopMoney: { amount: string } } } | null;
          calculatedOrder: { totalPriceSet: { shopMoney: { amount: string } } } | null;
          userErrors: Array<{ field?: string[]; message: string }>;
        } }>(
          `mutation($id: ID!, $v: ID!) { orderEditAddVariant(id: $id, variantId: $v, quantity: 1, allowDuplicates: true) {
            calculatedLineItem { id originalUnitPriceSet { shopMoney { amount } } }
            calculatedOrder { totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`,
          { id: calc, v: u.variante_id });
        const a = r.orderEditAddVariant;
        if (a.userErrors?.length || !a.calculatedLineItem) return { ok: false, error: `addVariant: ${mensajes(a.userErrors) || "sin línea"}` };
        leerTotal(a.calculatedOrder);
        const lista = Number(a.calculatedLineItem.originalUnitPriceSet.shopMoney.amount);
        const descuento = Math.round(lista - u.precio);
        if (descuento < 0) return { ok: false, error: `precio_mayor_a_lista: ${u.titulo} ${u.precio} > ${lista}` };
        if (descuento > 0) {
          // Línea de 1 unidad: el descuento fijo es por esa unidad, sin ambigüedad.
          const dsc = await gql<{ orderEditAddLineItemDiscount: { calculatedOrder: { totalPriceSet: { shopMoney: { amount: string } } } | null; userErrors: Array<{ field?: string[]; message: string }> } }>(
            `mutation($id: ID!, $li: ID!, $d: OrderEditAppliedDiscountInput!) { orderEditAddLineItemDiscount(id: $id, lineItemId: $li, discount: $d) {
              calculatedOrder { totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`,
            { id: calc, li: a.calculatedLineItem.id, d: { fixedValue: { amount: String(descuento), currencyCode: "PYG" }, description: "Precio Voltra por cantidad" } });
          if (dsc.orderEditAddLineItemDiscount.userErrors?.length) return { ok: false, error: `descuento: ${mensajes(dsc.orderEditAddLineItemDiscount.userErrors)}` };
          leerTotal(dsc.orderEditAddLineItemDiscount.calculatedOrder);
        }
      }
      // Sin commit si el total no da: la edición abierta se descarta sola y el pedido queda como estaba.
      if (total === null || Math.round(total) !== Math.round(totalEsperado)) {
        return { ok: false, error: `total_no_coincide: Shopify calcula ${total} y el resumen dijo ${totalEsperado} (no se guardó nada)` };
      }
      const c = await gql<{ orderEditCommit: { order: { currentTotalPriceSet: { shopMoney: { amount: string } } } | null; userErrors: Array<{ field?: string[]; message: string }> } }>(
        `mutation($id: ID!) { orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Cambio pedido por el cliente por WhatsApp (vendedor IA)") {
          order { currentTotalPriceSet { shopMoney { amount } } } userErrors { field message } } }`, { id: calc });
      if (c.orderEditCommit.userErrors?.length || !c.orderEditCommit.order) return { ok: false, error: `commit: ${mensajes(c.orderEditCommit.userErrors)}` };
      return { ok: true, total: Number(c.orderEditCommit.order.currentTotalPriceSet.shopMoney.amount) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async crearDesdeBorrador(input) {
    const i = (input.input ?? {}) as Record<string, unknown>;
    // Total esperado = líneas a precio fijo + envío. Si el borrador no da exacto, se borra y no se completa.
    const lineas = (i.lineItems ?? []) as Array<{ quantity: number; priceOverride: { amount: string } }>;
    const envio = Number(((i.shippingLine as { priceWithCurrency?: { amount: string } } | undefined)?.priceWithCurrency?.amount) ?? 0);
    const esperado = lineas.reduce((a, l) => a + Number(l.priceOverride.amount) * l.quantity, 0) + envio;
    const crear = (vars: Record<string, unknown>) =>
      gql<{ draftOrderCreate: { draftOrder: { id: string; totalPriceSet: { shopMoney: { amount: string } } } | null; userErrors: Array<{ field?: string[]; message: string }> } }>(
        `mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`, vars);
    const sinCliente = { ...i };
    delete sinCliente.purchasingEntity;
    const borrar = (id: string) =>
      gql(`mutation($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { message } } }`, { input: { id } })
        .catch((e) => console.error("draftOrderDelete:", e instanceof Error ? e.message : e));
    try {
      const d = await conAlternativa(() => crear({ input: i }), i.purchasingEntity ? () => crear({ input: sinCliente }) : null, /purchasingEntity/i);
      const ue = d.draftOrderCreate.userErrors ?? [];
      const borrador = d.draftOrderCreate.draftOrder;
      if (ue.length || !borrador) return { ok: false, error: `draftOrderCreate: ${mensajes(ue) || "sin borrador"}` };
      const totalBorrador = Number(borrador.totalPriceSet.shopMoney.amount);
      if (Math.round(totalBorrador) !== Math.round(esperado)) {
        await borrar(borrador.id);
        return { ok: false, error: `total_borrador_no_coincide: ${totalBorrador} ≠ ${esperado} (borrador eliminado)` };
      }
      // paymentPending: el pedido queda "pago pendiente" (contra entrega). Sin él Shopify lo marcaría PAGADO.
      const c = await gql<{ draftOrderComplete: { draftOrder: { order: { id: string; legacyResourceId: string; name: string; totalPriceSet: { shopMoney: { amount: string } } } | null } | null; userErrors: Array<{ field?: string[]; message: string }> } }>(
        `mutation($id: ID!) { draftOrderComplete(id: $id, paymentPending: true) {
          draftOrder { order { id legacyResourceId name totalPriceSet { shopMoney { amount } } } } userErrors { field message } } }`,
        { id: borrador.id });
      const o = c.draftOrderComplete.draftOrder?.order;
      if (c.draftOrderComplete.userErrors?.length || !o) {
        await borrar(borrador.id);
        return { ok: false, error: `draftOrderComplete: ${mensajes(c.draftOrderComplete.userErrors) || "sin pedido"}` };
      }
      return { ok: true, shopify_order_id: Number(o.legacyResourceId), nombre: o.name, total: Number(o.totalPriceSet.shopMoney.amount) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async reemplazoExistente(nombreOriginal) {
    const tag = `REEMPLAZA_A_${nombreOriginal.startsWith("#") ? nombreOriginal : `#${nombreOriginal}`}`;
    const d = await gql<{ orders: { nodes: Array<{ legacyResourceId: string; name: string; tags: string[]; cancelledAt: string | null }> } }>(
      `query($q: String!) { orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { legacyResourceId name tags cancelledAt } } }`,
      { q: `tag:'${tag}'` });
    const o = d.orders.nodes.find((x) => !x.cancelledAt && x.tags.includes(tag));
    return o ? { shopify_order_id: Number(o.legacyResourceId), nombre: o.name } : null;
  },

  async etiquetar(gid, tags) {
    try {
      const t = await gql<{ tagsAdd: { userErrors: Array<{ message: string }> } }>(
        `mutation($id: ID!, $t: [String!]!) { tagsAdd(id: $id, tags: $t) { userErrors { message } } }`, { id: gid, t: tags });
      return t.tagsAdd.userErrors.length ? { ok: false, error: mensajes(t.tagsAdd.userErrors) } : { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async cancelarOrden(gid, nota) {
    type R = { orderCancel: { job: { id: string } | null; orderCancelUserErrors: Array<{ field?: string[]; message: string }> } };
    const base = { orderId: gid, nota };
    const conMetodo = () => gql<R>(
      `mutation($orderId: ID!, $nota: String) { orderCancel(orderId: $orderId, reason: CUSTOMER, restock: true, notifyCustomer: false,
        staffNote: $nota, refundMethod: { originalPaymentMethodsRefund: false }) { job { id } orderCancelUserErrors { field message } } }`, base);
    // Versiones donde refundMethod no existe: el argumento viejo refund.
    const conRefund = () => gql<R>(
      `mutation($orderId: ID!, $nota: String) { orderCancel(orderId: $orderId, reason: CUSTOMER, restock: true, notifyCustomer: false,
        staffNote: $nota, refund: false) { job { id } orderCancelUserErrors { field message } } }`, base);
    try {
      const r = await conAlternativa(conMetodo, conRefund, /refundMethod|OrderCancelRefundMethodInput/i);
      const ue = r.orderCancel.orderCancelUserErrors ?? [];
      return ue.length ? { ok: false, error: mensajes(ue) } : { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async actualizarAtributos(gid, nuevos) {
    try {
      const r = await gql<{ order: { customAttributes: Array<{ key: string; value: string | null }> } | null }>(
        `query($id: ID!) { order(id: $id) { customAttributes { key value } } }`, { id: gid });
      if (!r.order) return { ok: false, error: "pedido no encontrado" };
      // orderUpdate REEMPLAZA la lista entera: se mezclan con los que ya tiene (no se pierde ninguno).
      const attrs = mezclarAtributos(r.order.customAttributes.map((a) => ({ key: a.key, value: a.value ?? "" })), nuevos);
      const u = await gql<{ orderUpdate: { userErrors: Array<{ message: string }> } }>(
        `mutation($i: OrderInput!) { orderUpdate(input: $i) { userErrors { message } } }`, { i: { id: gid, customAttributes: attrs } });
      return u.orderUpdate.userErrors.length ? { ok: false, error: mensajes(u.orderUpdate.userErrors) } : { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async transferirCandadosMeta(viejoId, nuevoId) {
    // Meta no deduplica mensajería. Por cada evento (LeadSubmitted, Purchase):
    //   - el viejo ya lo mandó → el nuevo hereda el candado ("ya_enviado" para el cron y para el webhook);
    //   - el viejo no lo mandó → se candadea el VIEJO (cancelado) para que el cron nunca lo mande; el nuevo sale normal.
    const hechos: string[] = [];
    for (const ev of [EVENTO_LEAD, EVENTO_PURCHASE] as const) {
      const viejo = idCandado(ev, viejoId);
      const nuevo = idCandado(ev, nuevoId);
      const { data, error } = await db().from("eventos_crudos").select("id").eq("fuente", "shopify").eq("id_externo", viejo).maybeSingle();
      falla("candado de Meta", error);
      const [id, marca] = data ? [nuevo, `copiado_de:${viejoId}`] : [viejo, `reemplazado_por:${nuevoId}`];
      const creado = await guardarEventoCrudo("shopify", id, { reemplazo: { viejo: viejoId, nuevo: nuevoId } });
      if (creado) {
        const u = await db().from("eventos_crudos").update({ procesado_en: new Date().toISOString(), error: marca })
          .eq("fuente", "shopify").eq("id_externo", id);
        falla("marcar candado de Meta", u.error);
        hechos.push(id);
      }
    }
    return hechos;
  },
};
