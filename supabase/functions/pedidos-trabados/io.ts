// pedidos-trabados · I/O real: pedidos abiertos de Supabase, candados en eventos_crudos y acciones en Shopify.
import { db } from "../_shared/db.ts";
import { gql } from "../_shared/shopify.ts";
import { enviarTexto } from "../_shared/wa.ts";
import { avisar } from "../_shared/telegram.ts";
import { type Accion, claveCobertura, type Cobertura, coordenadasPin, direccionDesdeNota, type EstadoSinCobertura, type PedidoAbierto } from "./logica.ts";

type Obj = Record<string, unknown>;
const txt = (v: unknown) => (typeof v === "string" ? v : "");

/** Pedidos de los últimos 14 días, no borrador, ni cancelados ni preparados en Shopify. */
export async function pedidosAbiertos(ahora: Date): Promise<PedidoAbierto[]> {
  const desde = new Date(ahora.getTime() - 14 * 24 * 3_600_000).toISOString();
  const { data, error } = await db().from("shopify_pedidos")
    .select("shopify_order_id,nombre,estado_confirmacion,tags,actualizado_en,raw")
    .eq("es_borrador", false).gte("creado_en", desde);
  if (error) throw new Error(`shopify_pedidos: ${error.message}`);
  return (data ?? []).flatMap((p) => {
    const r = (p.raw ?? {}) as Obj;
    if (r.cancelled_at || r.cancelledAt) return [];
    const ful = txt(r.fulfillment_status || r.displayFulfillmentStatus).toLowerCase();
    if (ful === "fulfilled") return [];
    const dir = (r.shipping_address ?? r.shippingAddress ?? {}) as Obj;
    const attrs = (r.note_attributes ?? r.customAttributes ?? []) as Array<{ name?: string; key?: string; value?: string }>;
    return [{
      shopifyOrderId: Number(p.shopify_order_id),
      nombre: String(p.nombre ?? p.shopify_order_id),
      estado: p.estado_confirmacion ?? null,
      tags: (p.tags ?? []) as string[],
      actualizadoEn: p.actualizado_en ?? null,
      direccion: [txt(dir.address1), txt(dir.address2)].filter(Boolean).join(", "),
      ciudad: txt(dir.city),
      notas: [txt(r.note), ...attrs.map((a) => `${a.name ?? a.key ?? ""}: ${a.value ?? ""}`)].join("\n"),
      productos: ((r.line_items ?? r.lineItems ?? []) as Obj[]).map((l) => txt(l.title ?? l.name)),
    }];
  });
}

/**
 * 20-10: cobertura contra entrega de cada ciudad según la rpc sugerir_courier (tabla tarifas_courier). Una llamada por
 * ciudad distinta, en paralelo. Una ciudad cuya llamada falla queda fuera del mapa (logica.ts usa la lista vieja).
 */
export async function coberturaCiudades(ciudades: string[]): Promise<Map<string, Cobertura>> {
  const unicas = [...new Set(ciudades.map(claveCobertura).filter(Boolean))];
  const mapa = new Map<string, Cobertura>();
  await Promise.all(unicas.map(async (ciudad) => {
    try {
      const { data, error } = await db().rpc("sugerir_courier", { p_ciudad: ciudad, p_cod: true });
      if (error) throw new Error(error.message);
      const r = (data ?? {}) as Obj;
      if (typeof r.sin_cobertura === "boolean" && typeof r.ciudad_reconocida === "boolean") {
        const ops = (Array.isArray(r.opciones) ? r.opciones : []) as Obj[];
        const cobra = (c: string) => ops.some((o) => o.courier === c && o.valido === true);
        mapa.set(ciudad, { sin_cobertura: r.sin_cobertura, ciudad_reconocida: r.ciudad_reconocida, lucero: cobra("lucero"), pap: cobra("pap") });
      }
    } catch (e) {
      console.warn(`pedidos-trabados: sugerir_courier('${ciudad}') falló, uso la lista vieja:`, e instanceof Error ? e.message : e);
    }
  }));
  return mapa;
}

/**
 * 21-10: para los pedidos con SIN_COBERTURA, cuándo salió el aviso (candado auto_avisar_sin_cobertura) y si el cliente
 * mandó una foto o un archivo después (posible comprobante).
 */
export async function estadoSinCobertura(pedidos: PedidoAbierto[]): Promise<Map<number, EstadoSinCobertura>> {
  const ids = pedidos.filter((p) => p.tags.some((t) => t.toUpperCase() === "SIN_COBERTURA")).map((p) => p.shopifyOrderId);
  const mapa = new Map<number, EstadoSinCobertura>();
  if (!ids.length) return mapa;
  const sb = db();
  const [{ data: cand }, { data: peds }] = await Promise.all([
    sb.from("eventos_crudos").select("id_externo,procesado_en,recibido_en").in("id_externo", ids.map((id) => idCandadoAuto("avisar_sin_cobertura", id))),
    sb.from("shopify_pedidos").select("shopify_order_id,cliente_id").in("shopify_order_id", ids),
  ]);
  for (const id of ids) {
    const c = (cand ?? []).find((x: Obj) => x.id_externo === idCandadoAuto("avisar_sin_cobertura", id)) as Obj | undefined;
    const avisoEn = c ? txt(c.procesado_en || c.recibido_en) || null : null;
    const cliente = (peds ?? []).find((x: Obj) => Number(x.shopify_order_id) === id)?.cliente_id as string | undefined;
    let adjuntoDespues = false;
    if (avisoEn && cliente) {
      const { count } = await sb.from("wa_mensajes").select("id", { count: "exact", head: true })
        .eq("cliente_id", cliente).eq("direccion", "in").in("tipo", ["image", "document"]).gte("creado_en", avisoEn);
      adjuntoDespues = (count ?? 0) > 0;
    }
    mapa.set(id, { avisoEn, adjuntoDespues });
  }
  return mapa;
}

/** 21-10: 48 h sin pago tras el aviso de "sin cobertura" → cancelar en Shopify, mensaje amable (ventana abierta) y Telegram. */
async function cancelarSinCobertura(orderId: number): Promise<string | null> {
  const sb = db();
  const { data: ped } = await sb.from("shopify_pedidos").select("nombre,cliente_id,telefono").eq("shopify_order_id", orderId).maybeSingle();
  if (!ped) return "pedido no encontrado";
  const e = await cancelarEnShopify(orderId);
  if (e) {
    await avisar(`⚠️ <b>${ped.nombre}</b>: no lo pude cancelar en Shopify (sin cobertura, 48 h sin pago): ${e}`).catch(() => null);
    return e;
  }
  await etiqueta(orderId, "SIN_COBERTURA_CANCELADO", true);
  let enviado = false, motivo = "";
  const { data: conv } = ped.cliente_id
    ? await sb.from("wa_conversaciones").select("id,ultima_entrada_en").eq("cliente_id", ped.cliente_id).order("ultima_entrada_en", { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
    : { data: null };
  const abierta = conv?.ultima_entrada_en && Date.now() - Date.parse(conv.ultima_entrada_en) < 23 * 3_600_000;
  if (!ped.telefono) motivo = "sin teléfono";
  else if (!abierta) motivo = "ventana de 24 h cerrada";
  else {
    const r = await enviarTexto(String(ped.telefono).replace(/\D/g, ""),
      `Como no pudimos coordinar el pago, cancelamos el pedido ${ped.nombre}. Si querés retomarlo, escribinos cuando quieras 🙌`,
      { clienteId: ped.cliente_id, conversacionId: conv?.id ?? null });
    enviado = r.ok;
    if (!r.ok) motivo = `WhatsApp: ${r.error ?? "falló"}`;
  }
  await avisar(`❌ <b>${ped.nombre}</b> cancelado: sin cobertura contra entrega y 48 h sin pago anticipado.\n` +
    (enviado ? "Le avisé al cliente." : `No le avisé al cliente (${motivo}).`)).catch(() => null);
  return null;
}

/** 21-10: mandó foto o archivo después del aviso → no se cancela; Enrique revisa si es el comprobante (una vez). */
async function revisarComprobanteSinCobertura(orderId: number): Promise<string | null> {
  const { data: ped } = await db().from("shopify_pedidos").select("nombre,telefono").eq("shopify_order_id", orderId).maybeSingle();
  if (!ped) return "pedido no encontrado";
  const tel = String(ped.telefono ?? "").replace(/\D/g, "");
  await avisar(`🧾 <b>${ped.nombre}</b> (sin cobertura): pasaron 48 h y el cliente mandó una foto o un archivo. No lo cancelé: ` +
    `revisá si es el comprobante y marcalo PAGADO, o cancelalo a mano.${tel ? ` https://wa.me/${tel}` : ""}`);
  return null;
}

/**
 * 21-10: JawFlex va por PaP porque Lucero no llega a la ciudad (lo asigna Despacho). Telegram, una vez por pedido; si
 * Telegram falla 3 veces se suelta el candado y el cron lo reintenta en 10 min.
 */
async function avisarJawflexPap(orderId: number): Promise<string | null> {
  const { data: ped } = await db().from("shopify_pedidos").select("nombre,raw").eq("shopify_order_id", orderId).maybeSingle();
  if (!ped) return "pedido no encontrado";
  const ciudad = txt((((ped.raw as Obj | null)?.shipping_address ?? {}) as Obj).city);
  const texto = `⚠ JawFlex ${ped.nombre} → PaP (Lucero no llega a ${ciudad || "esa ciudad"}). Entrega histórica PaP 60%. Si no querés mandarlo, avisá antes del despacho.`;
  let ultimo = "";
  for (let i = 0; i < 3; i++) {
    const r = await avisar(texto);
    if (r.ok) return null;
    ultimo = r.error ?? "Telegram falló";
    await new Promise((z) => setTimeout(z, 1500));
  }
  await db().from("eventos_crudos").delete().eq("fuente", "shopify").eq("id_externo", idCandadoAuto("avisar_jawflex_pap", orderId));
  return `Telegram: ${ultimo}`;
}

export const idCandadoAuto = (accion: Accion, orderId: number) => `auto_${accion}:${orderId}`;

/** Candados auto_* ya tomados para estos pedidos. */
export async function candadosTomados(ids: number[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const claves = ids.flatMap((id) => (["agregar_confirmado", "cancelar", "agregar_faltan_datos", "quitar_faltan_datos", "completar_direccion", "ciudad_desde_pin", "avisar_sin_cobertura", "cancelar_sin_cobertura", "revisar_comprobante_sin_cobertura", "avisar_jawflex_pap"] as Accion[]).map((a) => idCandadoAuto(a, id)));
  const { data, error } = await db().from("eventos_crudos").select("id_externo").eq("fuente", "shopify").in("id_externo", claves);
  if (error) throw new Error(`eventos_crudos: ${error.message}`);
  return new Set((data ?? []).map((x) => x.id_externo as string));
}

/** Toma el candado (false si ya existía). */
export async function tomarCandado(id: string, payload: Obj): Promise<boolean> {
  const { error } = await db().from("eventos_crudos").insert({ fuente: "shopify", id_externo: id, payload, procesado_en: new Date().toISOString() });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`eventos_crudos: ${error.message}`);
}

export async function registrarError(id: string, mensaje: string): Promise<void> {
  await db().from("eventos_crudos").update({ error: mensaje }).eq("fuente", "shopify").eq("id_externo", id);
}

const errores = (u: Array<{ message: string }> | undefined) => (u ?? []).map((e) => e.message).join("; ") || null;

export async function etiqueta(orderId: number, tag: string, agregar: boolean): Promise<string | null> {
  const m = agregar ? "tagsAdd" : "tagsRemove";
  const r = await gql<Record<string, { userErrors: Array<{ message: string }> }>>(
    `mutation($id: ID!, $tags: [String!]!) { ${m}(id: $id, tags: $tags) { userErrors { message } } }`,
    { id: `gid://shopify/Order/${orderId}`, tags: [tag] },
  );
  return errores(r[m]?.userErrors);
}

/** Cancela en Shopify sin avisar al cliente, sin reembolso (COD: no cobró) y devolviendo el stock. */
export async function cancelarEnShopify(orderId: number): Promise<string | null> {
  const r = await gql<{ orderCancel: { orderCancelUserErrors: Array<{ message: string }> } }>(
    `mutation($id: ID!) { orderCancel(orderId: $id, reason: CUSTOMER, refund: false, restock: true, notifyCustomer: false) { orderCancelUserErrors { message } } }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  return errores(r.orderCancel.orderCancelUserErrors);
}

/** 15-10: carga en Shopify la dirección que el vendedor dejó en la nota (ver direccionDesdeNota). */
export async function completarDireccion(orderId: number, notas: string): Promise<string | null> {
  const d = direccionDesdeNota(notas);
  if (!d) return "la nota no tiene ciudad y calle o mapa";
  const r = await gql<{ orderUpdate: { userErrors: Array<{ message: string }> } }>(
    `mutation($i: OrderInput!) { orderUpdate(input: $i) { userErrors { message } } }`,
    { i: { id: `gid://shopify/Order/${orderId}`, shippingAddress: { ...d, countryCode: "PY" } } },
  );
  return errores(r.orderUpdate.userErrors);
}

/**
 * 15-10: ciudad (y departamento) de un pin. Nominatim bloquea a Supabase (403): Photon con espera larga y, si no
 * responde, BigDataCloud (sin clave). Volumen mínimo: solo pedidos con ciudad "Ver mapa", una vez cada uno.
 */
export async function ciudadDePin(lat: number, lng: number): Promise<{ ciudad: string; depto: string | null } | null> {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=default`, {
      headers: { "User-Agent": "VoltraOS/1.0" }, signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const p = ((await r.json()) as { features?: Array<{ properties?: Obj }> }).features?.[0]?.properties ?? {};
      const ciudad = txt(p.city) || txt(p.town) || txt(p.village) || txt(p.county);
      if (ciudad) return { ciudad, depto: txt(p.state) || null };
    }
  } catch { /* sigue con el otro */ }
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=es`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const d = (await r.json()) as Obj;
      const ciudad = txt(d.city) || txt(d.locality);
      if (ciudad && txt(d.countryCode) === "PY") return { ciudad, depto: txt(d.principalSubdivision) || null };
    }
  } catch { /* sin ciudad */ }
  return null;
}

async function cargarCiudadDePin(orderId: number, p: Pick<PedidoAbierto, "direccion" | "notas">): Promise<string | null> {
  const c = coordenadasPin(p);
  if (!c) return "sin pin";
  const lugar = await ciudadDePin(c.lat, c.lng);
  if (!lugar) return "no se pudo leer la ciudad del pin (Photon y BigDataCloud)";
  const r = await gql<{ orderUpdate: { userErrors: Array<{ message: string }> } }>(
    `mutation($i: OrderInput!) { orderUpdate(input: $i) { userErrors { message } } }`,
    { i: { id: `gid://shopify/Order/${orderId}`, shippingAddress: { city: lugar.ciudad, ...(lugar.depto ? { province: lugar.depto } : {}) } } },
  );
  return errores(r.orderUpdate.userErrors);
}

const gs = (n: number) => n.toLocaleString("es-PY").replace(/,/g, ".");

/**
 * 15-10 (Enrique, #1056): ciudad sin cobertura contra entrega → al cliente, si la ventana de 24 h está abierta, se le
 * ofrece pagar por adelantado y mandarlo por una transportadora que llegue. Siempre: etiqueta SIN_COBERTURA y Telegram.
 */
async function avisarSinCobertura(orderId: number): Promise<string | null> {
  const sb = db();
  const { data: ped } = await sb.from("shopify_pedidos").select("nombre,cliente_id,telefono,total,raw").eq("shopify_order_id", orderId).maybeSingle();
  if (!ped) return "pedido no encontrado";
  const dir = ((ped.raw as Obj | null)?.shipping_address ?? {}) as Obj;
  const ciudad = txt(dir.city), primer = txt(dir.first_name) || txt(dir.name).split(" ")[0] || "";
  const total = Number(ped.total ?? 0);
  let enviado = false, motivo = "";
  const { data: conv } = ped.cliente_id
    ? await sb.from("wa_conversaciones").select("id,ultima_entrada_en").eq("cliente_id", ped.cliente_id).order("ultima_entrada_en", { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
    : { data: null };
  const abierta = conv?.ultima_entrada_en && Date.now() - Date.parse(conv.ultima_entrada_en) < 23 * 3_600_000;
  const { data: cfg } = await sb.from("config_wa").select("valor").eq("clave", "pago_prioridad").maybeSingle();
  const pago = (cfg?.valor ?? {}) as { alias?: string; titular?: string };
  if (!ped.telefono) motivo = "sin teléfono";
  else if (!abierta) motivo = "ventana de 24 h cerrada";
  else if (!pago.alias) motivo = "falta el alias en config_wa.pago_prioridad";
  else {
    const texto = `${primer ? `${primer}, te` : "Te"} escribo por tu pedido ${ped.nombre} 🙌\n` +
      `Nuestras transportadoras con pago al recibir no llegan a ${ciudad}.\n` +
      `Si lo pagás por adelantado, te lo mandamos por una transportadora que sí llega a tu ciudad, por el mismo total de Gs ${gs(total)}.\n` +
      `💳 Alias: ${pago.alias}${pago.titular ? ` — ${pago.titular}` : ""}\n` +
      "Mandame el comprobante por acá y lo despachamos.";
    const r = await enviarTexto(String(ped.telefono).replace(/\D/g, ""), texto, { clienteId: ped.cliente_id, conversacionId: conv?.id ?? null });
    enviado = r.ok;
    if (!r.ok) motivo = `WhatsApp: ${r.error ?? "falló"}`;
  }
  const e = await etiqueta(orderId, "SIN_COBERTURA", true);
  const tel = String(ped.telefono ?? "").replace(/\D/g, "");
  await avisar(
    `📍 <b>${ped.nombre}</b>: ${ciudad} no tiene cobertura contra entrega (ni PaP ni Lucero).\n` +
      (enviado ? "Ya le ofrecí pagar por adelantado y mandarlo por otra transportadora. Si manda el comprobante, despachalo forzado en Despacho."
        : `No le pude escribir (${motivo}). Escribile vos: https://wa.me/${tel}`),
  ).catch(() => null);
  return e ?? (enviado || motivo === "ventana de 24 h cerrada" ? null : motivo);
}

export async function ejecutar(accion: Accion, orderId: number, notas = "", direccion = ""): Promise<string | null> {
  if (accion === "avisar_sin_cobertura") return await avisarSinCobertura(orderId);
  if (accion === "avisar_jawflex_pap") return await avisarJawflexPap(orderId);
  if (accion === "cancelar_sin_cobertura") return await cancelarSinCobertura(orderId);
  if (accion === "revisar_comprobante_sin_cobertura") return await revisarComprobanteSinCobertura(orderId);
  if (accion === "ciudad_desde_pin") return await cargarCiudadDePin(orderId, { direccion, notas });
  if (accion === "completar_direccion") return await completarDireccion(orderId, notas);
  if (accion === "agregar_confirmado") return await etiqueta(orderId, "CONFIRMADO", true);
  if (accion === "agregar_faltan_datos") return await etiqueta(orderId, "FALTAN_DATOS", true);
  if (accion === "quitar_faltan_datos") return await etiqueta(orderId, "FALTAN_DATOS", false);
  return await cancelarEnShopify(orderId);
}
