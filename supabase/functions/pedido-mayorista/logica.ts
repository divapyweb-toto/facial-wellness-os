// pedido-mayorista · lógica pura (sin red ni base: todo el I/O entra por `Deps`).
// La llama la pantalla "Pedido mayorista" de Voltra OS (src/pages/mayorista) con el JWT del usuario.
//
// POST { accion: 'catalogo' }  → productos y variantes de Shopify (Voltra) para armar el pedido.
// POST { accion: 'crear', ... } → crea el pedido en Shopify (orderCreate) y guarda pedido_datos_fiscales.
//
// Circuito (contrato P1-P2 10-10, "P2 REDEFINIDO"): el pedido entra como cualquier pedido de Shopify (Despacho,
// courier, ENTREGADO/rendido, factura al entregar). Tags: MAYORISTA, CONFIRMADO (Enrique ya lo confirmó por
// WhatsApp: shopify-webhook NO programa la secuencia de confirmación), PAGO_VERIFICADO si pagó por transferencia
// anticipada (Despacho lo manda "YA PAGADO - NO COBRAR"), CREDITO si es a plazo.
//
// "Ya entregado y cobrado (anterior al corte)": además ANTERIOR_AL_CORTE + SIN_MENSAJES. Orden pensado para que
// NINGÚN camino le escriba al cliente:
//   1. CONFIRMADO → shopify-webhook frena conf/rec/avi/ult/canc (estado 'confirmado').
//   2. facturas_retenidas ('anterior_al_corte') ANTES de marcar entregado → la cola/post-entrega nunca lo factura solo.
//   3. shopify_pedidos.estado_envio = 'ENTREGADO' + entregado_en (fecha real) + pedido_estados ENTREGADO fuente
//      'manual' notificado=true → envioTerminal() frena "ya salió"/"hoy te llega" (shopify-webhook y procesar-envios).
//   4. Recién con 3 OK se marca preparado en Shopify (fulfillmentCreate notifyCustomer:false); si 3 falla, NO se
//      prepara (eso dispararía el aviso "tu pedido ya salió").
// Idempotencia: la clave del formulario se reserva en eventos_crudos ('shopify', 'mayorista:<clave>'), el mismo
// candado que usa lead_meta.ts. Doble clic o reintento con la misma clave → devuelve el pedido ya creado.

import { instanteEntrega, type PedidoMayorista, validarPedido } from "./validar.ts";

export const TAGS_BASE = ["MAYORISTA", "CONFIRMADO"];
export const TAG_PAGO_VERIFICADO = "PAGO_VERIFICADO";
export const TAG_CREDITO = "CREDITO";
export const TAG_ANTERIOR = "ANTERIOR_AL_CORTE";
export const TAG_SIN_MENSAJES = "SIN_MENSAJES";
export const CAPI_OMITIDO = "mayorista";

export type Orden = { shopify_order_id: number; gid: string; nombre: string; total: number | null; nodo: Record<string, unknown> };
export type ResultadoOrden = ({ ok: true } & Orden) | { ok: false; error: string; definitivo: boolean };
export type Resultado = { ok: boolean; error?: string };

export interface VarianteCatalogo { id: string; titulo: string; precio: number; disponible: boolean; sku: string | null }
export interface ProductoCatalogo { id: string; titulo: string; estado: string; variantes: VarianteCatalogo[] }

export interface Candado {
  shopify_order_id?: number;
  nombre?: string;
  total?: number | null;
  avisos?: string[];
  procesado: boolean;
  error: string | null;
}

export interface Deps {
  ahora(): Date;
  /** Usuario de Supabase Auth dueño del JWT, o null. */
  usuario(token: string): Promise<{ id: string } | null>;
  /** config_wa.sifen.facturar_desde (o null si no hay corte cargado). */
  facturarDesde(): Promise<string | null>;
  catalogo(): Promise<ProductoCatalogo[]>;
  /** Inserta el candado; false si la clave ya existía. */
  reservarClave(clave: string, payload: unknown): Promise<boolean>;
  leerClave(clave: string): Promise<Candado | null>;
  cerrarClave(clave: string, datos: Record<string, unknown>, error: string | null): Promise<void>;
  /** Borra el candado (solo cuando es SEGURO que Shopify no creó nada). */
  liberarClave(clave: string): Promise<void>;
  crearOrden(input: Record<string, unknown>): Promise<ResultadoOrden>;
  /** Mismo camino que shopify-webhook (procesarPedido): cliente + shopify_pedidos, sin mensajes (CONFIRMADO). */
  registrarPedido(nodo: Record<string, unknown>): Promise<void>;
  guardarDatosFiscales(fila: Record<string, unknown>): Promise<void>;
  /** shopify_pedidos.capi_omitido: post-entrega no manda la compra mayorista a Meta como conversión de anuncio. */
  omitirCapi(orderId: number, motivo: string): Promise<void>;
  marcarPagado(gid: string): Promise<Resultado>;
  /** RPC sifen_retener de P1 → facturas_retenidas. tablaFalta=true si la migración de P1 no está aplicada. */
  retenerFactura(orderId: number, motivo: string, nota: string): Promise<Resultado & { tablaFalta?: boolean }>;
  /** estado_envio ENTREGADO + entregado_en + pedido_estados ENTREGADO (fuente 'manual', notificado). */
  marcarEntregado(orderId: number, instanteISO: string, pagado: boolean): Promise<void>;
  /** fulfillmentCreate con notifyCustomer:false. */
  marcarPreparado(gid: string): Promise<Resultado>;
}

export type Respuesta = { status: number; body: Record<string, unknown> };

export function tokenDeHeader(h: string | null): string {
  return (h ?? "").replace(/^Bearer\s+/i, "").trim();
}

/** 'YYYY-MM-DD' en Asunción. */
export function hoyAsuncion(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Asuncion", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const money = (n: number) => ({ shopMoney: { amount: String(n), currencyCode: "PYG" } });

export function tagsDelPedido(p: PedidoMayorista): string[] {
  const t = [...TAGS_BASE];
  // PAGO_VERIFICADO = transferencia verificada en ueno (iTiPago 5 en la factura). Anterior al corte cobrado en
  // efectivo por el courier: pagado en Shopify pero sin esta tag (la factura saldría como transferencia).
  if (p.cobro === "transferencia_anticipada") t.push(TAG_PAGO_VERIFICADO);
  if (p.condicion === "credito") t.push(TAG_CREDITO);
  if (p.anterior_al_corte) t.push(TAG_ANTERIOR, TAG_SIN_MENSAJES);
  return t;
}

export function notaDelPedido(p: PedidoMayorista): string {
  const l = ["Pedido MAYORISTA cargado a mano desde Voltra OS (venta por WhatsApp)."];
  l.push(`Factura a: ${p.fiscal.razon_social} · RUC ${p.fiscal.ruc}-${p.fiscal.dv}`);
  l.push(p.condicion === "credito" ? `CRÉDITO a ${p.plazo_dias} días: NO COBRAR EN LA ENTREGA.` : "Contado.");
  if (p.cobro === "transferencia_anticipada") l.push(`Pagado por transferencia anticipada (ueno)${p.comprobante_ref ? ` · comprobante ${p.comprobante_ref}` : ""}.`);
  else l.push("Cobro contra entrega.");
  if (p.anterior_al_corte) l.push(`ANTERIOR AL CORTE: ya entregado y cobrado el ${p.fecha_entrega}. NO DESPACHAR. Factura retenida para la contadora.`);
  if (p.nota) l.push(`Nota: ${p.nota}`);
  return l.join("\n");
}

/** Input de orderCreate (Admin GraphQL 2026-10). Base: _shared/vendedor/herramientas.ts inputOrderCreate. */
export function inputOrderCreate(p: PedidoMayorista): Record<string, unknown> {
  const [nombre, ...resto] = p.cliente.nombre.split(/\s+/);
  const atributos = [
    { key: "origen", value: "mayorista" },
    // P1 (desde_pedido.ts) lee "Ruc" (RUC-DV) y "Razon social"; pedido_datos_fiscales igual manda sobre estos.
    { key: "Ruc", value: `${p.fiscal.ruc}-${p.fiscal.dv}` },
    { key: "Razon social", value: p.fiscal.razon_social },
    { key: "condicion", value: p.condicion },
    ...(p.condicion === "credito" ? [{ key: "plazo_dias", value: String(p.plazo_dias) }] : []),
    { key: "cobro", value: p.cobro },
    ...(p.comprobante_ref ? [{ key: "comprobante", value: p.comprobante_ref }] : []),
    ...(p.anterior_al_corte ? [{ key: "entregado_el", value: String(p.fecha_entrega) }] : []),
    { key: "voltra_os_clave", value: p.clave_idempotencia },
  ];
  return {
    order: {
      currency: "PYG",
      // Precios de Voltra con IVA incluido: sin esto Shopify suma el IVA encima (ver herramientas.ts).
      taxesIncluded: true,
      phone: p.cliente.telefono,
      financialStatus: "PENDING",
      lineItems: p.items.map((it) => ({ variantId: it.variant_id, quantity: it.cantidad, priceSet: money(it.precio_unitario) })),
      shippingLines: p.envio > 0 ? [{ title: "Envío", priceSet: money(p.envio) }] : [],
      shippingAddress: {
        firstName: nombre,
        lastName: resto.join(" ") || null,
        company: p.fiscal.razon_social,
        address1: p.cliente.direccion,
        address2: p.cliente.referencia,
        city: p.cliente.ciudad,
        countryCode: "PY",
        phone: p.cliente.telefono,
      },
      // Sin email a Shopify: así Shopify no le manda recibos ni avisos de envío por correo.
      tags: tagsDelPedido(p),
      note: notaDelPedido(p),
      customAttributes: atributos,
    },
    options: {
      // Anterior al corte: la mercadería ya salió hace tiempo; no se toca el inventario de Shopify.
      inventoryBehaviour: p.anterior_al_corte ? "BYPASS" : "DECREMENT_OBEYING_POLICY",
      sendReceipt: false,
      sendFulfillmentReceipt: false,
    },
  };
}

export function filaDatosFiscales(p: PedidoMayorista, orderId: number, usuarioId: string): Record<string, unknown> {
  return {
    shopify_order_id: orderId,
    ruc: p.fiscal.ruc,
    dv: p.fiscal.dv,
    razon_social: p.fiscal.razon_social,
    email: p.fiscal.email,
    condicion: p.condicion,
    plazo_dias: p.plazo_dias,
    origen: "mayorista",
    cargado_por: usuarioId,
  };
}

const msj = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function catalogo(token: string, d: Deps): Promise<Respuesta> {
  if (!token || !(await d.usuario(token))) return { status: 401, body: { ok: false, error: "Sesión vencida: volvé a entrar a Voltra OS" } };
  const productos = await d.catalogo();
  return { status: 200, body: { ok: true, productos } };
}

export async function crearPedidoMayorista(token: string, cuerpo: unknown, d: Deps): Promise<Respuesta> {
  if (!token) return { status: 401, body: { ok: false, error: "Falta iniciar sesión en Voltra OS" } };
  const u = await d.usuario(token);
  if (!u) return { status: 401, body: { ok: false, error: "Sesión vencida: volvé a entrar a Voltra OS" } };

  const facturarDesde = await d.facturarDesde();
  const v = validarPedido(cuerpo, { hoy: hoyAsuncion(d.ahora()), facturarDesde });
  if (!v.ok) return { status: 400, body: { ok: false, error: Object.values(v.errores).join(" · "), errores: v.errores } };
  const p = v.pedido;

  // ── Idempotencia ──
  const nuevo = await d.reservarClave(p.clave_idempotencia, { tipo: "pedido_mayorista", usuario: u.id, total: v.total });
  if (!nuevo) {
    const c = await d.leerClave(p.clave_idempotencia);
    if (c?.shopify_order_id) {
      return {
        status: 200,
        body: { ok: true, repetido: true, shopify_order_id: c.shopify_order_id, nombre: c.nombre ?? null, total: c.total ?? null, avisos: c.avisos ?? [] },
      };
    }
    if (c?.error) {
      return { status: 409, body: { ok: false, error: `Este pedido quedó en un estado incierto (${c.error}). Revisá en Shopify si se creó antes de volver a cargarlo.` } };
    }
    return { status: 409, body: { ok: false, error: "Este pedido ya se está creando (doble clic). Esperá unos segundos y actualizá la lista." } };
  }

  // ── Shopify ──
  let r: ResultadoOrden;
  try {
    r = await d.crearOrden(inputOrderCreate(p));
  } catch (e) {
    r = { ok: false, error: msj(e), definitivo: false };
  }
  if (!r.ok) {
    if (r.definitivo) {
      await d.liberarClave(p.clave_idempotencia).catch((e) => console.warn("liberarClave:", msj(e)));
      return { status: 422, body: { ok: false, reintentable: true, error: `Shopify no creó el pedido: ${r.error}` } };
    }
    await d.cerrarClave(p.clave_idempotencia, {}, r.error).catch((e) => console.warn("cerrarClave:", msj(e)));
    return { status: 502, body: { ok: false, error: `No hubo respuesta clara de Shopify (${r.error}). Revisá en Shopify si el pedido se creó antes de cargarlo de nuevo.` } };
  }
  const id = r.shopify_order_id;
  const base = { shopify_order_id: id, nombre: r.nombre, total: r.total };
  // Primero queda anotado el pedido en el candado: un reintento ya no puede duplicarlo.
  await d.cerrarClave(p.clave_idempotencia, base, null).catch((e) => console.warn("cerrarClave:", msj(e)));

  const avisos: string[] = [];
  const paso = async (nombre: string, f: () => Promise<unknown>): Promise<boolean> => {
    try {
      const x = await f() as Resultado | undefined;
      if (x && typeof x === "object" && "ok" in x && !x.ok) {
        avisos.push(`${nombre}: ${x.error ?? "error"}`);
        return false;
      }
      return true;
    } catch (e) {
      avisos.push(`${nombre}: ${msj(e)}`);
      return false;
    }
  };

  if (typeof r.total === "number" && Math.round(r.total) !== v.total) {
    avisos.push(`Ojo: Shopify calculó Gs ${r.total} y el formulario Gs ${v.total}. Revisá el pedido.`);
  }
  const registrado = await paso("No se registró el pedido en Voltra OS (lo trae el webhook de Shopify)", () => d.registrarPedido(r.nodo));
  const fiscalOk = await paso("No se guardaron los datos de factura: cargalos desde Ventas → RUC", () => d.guardarDatosFiscales(filaDatosFiscales(p, id, u.id)));
  if (registrado) await paso("No se marcó para no enviar a Meta", () => d.omitirCapi(id, CAPI_OMITIDO));

  let pagado = false;
  if (p.cobro === "transferencia_anticipada" || p.anterior_al_corte) {
    pagado = await paso("No se marcó como pagado en Shopify (marcalo a mano)", () => d.marcarPagado(r.gid));
  }

  let entregado = false;
  if (p.anterior_al_corte) {
    const nota = `Pedido mayorista anterior al corte: entregado y cobrado el ${p.fecha_entrega}.`;
    try {
      const ret = await d.retenerFactura(id, "anterior_al_corte", nota);
      if (!ret.ok) avisos.push(ret.tablaFalta
        ? "Falta la RPC sifen_retener / tabla facturas_retenidas (migración de P1): este pedido NO quedó retenido. No actives la facturación hasta aplicarla y retenerlo."
        : `No quedó en facturas retenidas: ${ret.error ?? "error"}. No actives la facturación sin retenerlo.`);
    } catch (e) {
      avisos.push(`No quedó en facturas retenidas: ${msj(e)}`);
    }
    if (registrado) {
      entregado = await paso("No se marcó como entregado (no lo prepares en Shopify a mano)", () => d.marcarEntregado(id, new Date(instanteEntrega(p.fecha_entrega!)).toISOString(), pagado));
    } else {
      avisos.push("No se marcó como entregado porque el pedido no quedó registrado. No lo prepares en Shopify a mano.");
    }
    // Solo con el estado terminal ya guardado: si no, marcarlo preparado mandaría "tu pedido ya salió".
    if (entregado) await paso("No se marcó como preparado en Shopify (no hace falta para nada más)", () => d.marcarPreparado(r.gid));
  }

  await d.cerrarClave(p.clave_idempotencia, { ...base, avisos }, null).catch((e) => console.warn("cerrarClave:", msj(e)));
  return {
    status: 200,
    body: {
      ok: true,
      repetido: false,
      ...base,
      datos_fiscales: fiscalOk,
      pagado,
      entregado,
      avisos,
    },
  };
}

export async function manejar(token: string, cuerpo: unknown, d: Deps): Promise<Respuesta> {
  const accion = cuerpo && typeof cuerpo === "object" ? (cuerpo as Record<string, unknown>).accion : null;
  if (accion === "catalogo") return await catalogo(token, d);
  if (accion === "crear") return await crearPedidoMayorista(token, cuerpo, d);
  return { status: 400, body: { ok: false, error: "accion inválida (catalogo | crear)" } };
}
