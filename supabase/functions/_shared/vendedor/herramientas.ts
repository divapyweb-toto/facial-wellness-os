// _shared/vendedor/herramientas.ts · Dueño: G1 (ola 2)
// Herramientas del vendedor con IA: definiciones (JSON Schema para la Messages API) + ejecutores.
// Los ejecutores no tocan red ni base directamente: todo entra por `DepsHerramientas` (io.ts en producción,
// dobles en los tests). Reglas duras que NO dependen del modelo:
//   - Los precios y totales salen del catálogo de Shopify (+ ofertas por cantidad y envío de config_wa); el
//     modelo nunca calcula.
//   - crear_pedido_cod en dos pasos: resumen con botones (confirmar=false) y creación (confirmar=true) solo con
//     un sí claro del cliente en el mensaje actual o el botón Confirmar; se usan los datos del resumen guardado,
//     no lo que el modelo reescriba.
//   - Todo texto que el modelo pone dentro de un interactivo pasa por el mismo filtro que su respuesta.
import type { Herramienta } from "../claude.ts";
import {
  botonesSiNo,
  carruselOpciones,
  flowFormulario,
  pedirContacto,
  type Tarjeta,
  ubicacionRequest,
} from "../wa_interactivos.ts";
import { enlaceWaMe, formatoChatNecesitaEnrique, formatoPedidoNuevo } from "../telegram_formato.ts";
import { botonEnlace } from "./interactivos.ts";
import type { CtxTurno, DatosPedidoChat, DepsHerramientas, LineaPedido, PedidoChat, ProductoShopify } from "./tipos.ts";

// ---------- utilidades puras ----------

export function gs(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** "si dale", "ok", "mandame katu"… (misma regla que wa-webhook: todas las palabras en la lista). */
export function esAceptacion(texto: string, aceptaciones: string[]): boolean {
  const n = normalizar(texto);
  if (!n) return false;
  const frases = new Set(aceptaciones.map(normalizar).filter(Boolean));
  if (frases.has(n)) return true;
  const palabras = new Set([...frases].flatMap((f) => f.split(" ")));
  return n.split(" ").every((w) => palabras.has(w));
}

function texto(t: Record<string, string>, clave: string, porDefecto: string, vars: Record<string, string> = {}): string {
  let s = (typeof t[clave] === "string" && t[clave].trim()) ? t[clave] : porDefecto;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s.replace(/\s+([,.])/g, "$1").replace(/ {2,}/g, " ").trim();
}

export const TEXTOS_DEFAULT: Record<string, string> = {
  resumen: "Te resumo: {lineas}. Envío Gs {envio}. Total Gs {total}, pagás al recibir. Lo entregamos en {direccion}, {ciudad}.",
  boton_confirmar: "Confirmar",
  boton_corregir: "Corregir",
  pedido_creado: "Listo {nombre}, ya cargamos tu pedido {pedido}. En unos minutos te llega la confirmación por acá.",
  derivacion: "Te paso con Enrique para que lo vea personalmente. Tocá el botón y le llega tu caso ya escrito.",
  derivacion_sin_boton: "Le paso tu caso a Enrique y te escribe por acá apenas lo vea.",
  // Cuando el texto del modelo ya dice que lo pasa con Enrique, solo se agrega la llamada a la acción.
  derivacion_cta: "Tocá el botón y le llega tu caso ya escrito.",
  derivacion_cta_sin_boton: "Enrique te escribe por acá apenas lo vea.",
  // Derivación por salud: va primero si el texto del modelo no manda ya al médico.
  derivacion_salud: "Eso te conviene consultarlo con tu médico.",
  boton_enrique: "Hablar con Enrique",
  mensaje_a_enrique: "Hola Enrique, soy {nombre}. {resumen}",
  formulario_titulo: "Datos para tu pedido",
  formulario_cta: "Completar datos",
};

// ---------- definiciones ----------

const MOTIVOS = [
  "salud", "reclamo", "devolucion", "enojo", "pide_persona", "mayorista", "direccion_dudosa",
  "audio_confuso", "sin_avance", "falla_herramienta", "otro",
] as const;
export type MotivoDerivacion = typeof MOTIVOS[number] | "falla_ia" | "tope_gasto" | "tope_turnos" | "filtro";

const MOTIVO_LEGIBLE: Record<string, string> = {
  salud: "Consulta de salud",
  reclamo: "Reclamo (paso 3 o más)",
  devolucion: "Pide devolución",
  enojo: "Cliente enojado",
  pide_persona: "Pide hablar con una persona",
  mayorista: "Compra mayorista",
  direccion_dudosa: "Dirección dudosa",
  audio_confuso: "Audio que no se entiende",
  sin_avance: "3 mensajes sin avance",
  falla_herramienta: "Falló una herramienta",
  otro: "Otro",
  falla_ia: "La IA no respondió (API caída o error)",
  tope_gasto: "Se llegó al tope mensual de gasto de IA",
  tope_turnos: "La conversación pasó el límite de turnos de IA",
  filtro: "La respuesta de la IA no pasó el filtro dos veces",
};

export const HERRAMIENTAS: Herramienta[] = [
  {
    name: "consultar_catalogo",
    description:
      "Precios, ofertas por cantidad, disponibilidad, envío y totales reales desde Shopify. Usala antes de dar cualquier precio. Los totales ya incluyen el envío: no hagas cuentas.",
    input_schema: {
      type: "object",
      properties: { busqueda: { type: "string", description: "Producto que busca el cliente (opcional), por ejemplo 'tiras'." } },
    },
  },
  {
    name: "estado_pedido",
    description: "Estado de los últimos pedidos de este cliente (confirmación y envío según el último reporte del courier).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "crear_pedido_cod",
    description:
      "Pedido contra entrega. confirmar=false: valida los datos, calcula el total y le muestra al cliente el resumen con botones Confirmar/Corregir (no escribas nada después). confirmar=true: SOLO después de un sí claro o del botón Confirmar; crea el pedido en Shopify con los datos del último resumen y devuelve el texto para responder.",
    input_schema: {
      type: "object",
      properties: {
        confirmar: { type: "boolean" },
        nombre: { type: "string", description: "Nombre y apellido" },
        ciudad: { type: "string" },
        direccion: { type: "string", description: "Calle, número o barrio" },
        referencia: { type: "string", description: "Referencia para el courier (opcional)" },
        ubicacion: { type: "string", description: "Pin de ubicación si lo mandó, lat,long (opcional)" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { handle: { type: "string" }, cantidad: { type: "integer", minimum: 1 } },
            required: ["handle", "cantidad"],
          },
        },
        factura: { type: "string", description: "RUC y razón social si pide factura (opcional)" },
      },
      required: ["confirmar"],
    },
  },
  {
    name: "derivar_a_enrique",
    description:
      "Pasa la conversación a Enrique: el cliente recibe un botón para hablarle con el resumen ya escrito y Enrique recibe el mismo resumen por Telegram. El texto que escribas junto con esta llamada va arriba del botón (en salud: \"Eso te conviene consultarlo con tu médico.\"). Después no escribas nada más.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", enum: [...MOTIVOS] },
        resumen: { type: "string", description: "Qué pasó, en 1 a 3 oraciones, para que Enrique entienda sin leer el chat." },
        shopify_order_id: { type: "integer", description: "Pedido relacionado, si hay (opcional)." },
      },
      required: ["motivo", "resumen"],
    },
  },
  {
    name: "enviar_media",
    description: "Manda la foto o el video real de un producto (prueba concreta ante dudas o desconfianza, o el video de uso en un reclamo de uso).",
    input_schema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        tipo: { type: "string", enum: ["foto", "video", "uso"] },
        texto: { type: "string", description: "Pie corto (opcional, 1 línea)." },
      },
      required: ["handle", "tipo"],
    },
  },
  {
    name: "pedir_ubicacion",
    description: "Le pide al cliente el pin de su casa con un toque (menos rechazos por dirección mal cargada). Después no escribas nada más.",
    input_schema: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"] },
  },
  {
    name: "enviar_formulario",
    description: "Formulario dentro del chat para nombre, ciudad, dirección, referencia y cantidad en una sola pantalla. Después no escribas nada más.",
    input_schema: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"] },
  },
  {
    name: "enviar_opciones",
    description: "Carrusel con ×1, ×2 y ×3 del producto, con foto, precio y botón para elegir. Usalo una sola vez por conversación. Después no escribas nada más.",
    input_schema: {
      type: "object",
      properties: { handle: { type: "string" }, texto: { type: "string" } },
      required: ["handle", "texto"],
    },
  },
  {
    name: "pedir_telefono",
    description: "Botón para que el cliente comparta su número con un toque (cuando el chat no tiene teléfono). Necesario antes de crear el pedido. Después no escribas nada más.",
    input_schema: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"] },
  },
];

// ---------- resultado de un ejecutor ----------

export type ResultadoHerramienta = {
  resultado: Record<string, unknown>;
  esError?: boolean;
  /** Ya se le mandó un mensaje al cliente: el turno termina sin otra respuesta. */
  terminal?: boolean;
  derivado?: boolean;
  pedidoCreado?: { shopify_order_id: number; nombre: string };
};

const error = (mensaje: string, extra: Record<string, unknown> = {}): ResultadoHerramienta => ({
  resultado: { ok: false, error: mensaje, ...extra },
  esError: true,
});

// ---------- catálogo (caché de 10 min por worker) ----------

let cacheCatalogo: { estado: string; hasta: number; productos: ProductoShopify[] } | null = null;

/** Solo tests. */
export function _limpiarCacheCatalogo(): void {
  cacheCatalogo = null;
}

export async function catalogo(deps: DepsHerramientas, ctx: CtxTurno): Promise<ProductoShopify[]> {
  const ahora = deps.ahoraMs?.() ?? Date.now();
  const estado = ctx.cfg.vendedor.catalogo_estado || "ACTIVE";
  if (cacheCatalogo && cacheCatalogo.estado === estado && cacheCatalogo.hasta > ahora) return cacheCatalogo.productos;
  const productos = await deps.catalogoShopify(estado);
  cacheCatalogo = { estado, productos, hasta: ahora + (ctx.cfg.vendedor.catalogo_cache_min || 10) * 60_000 };
  return productos;
}

export type OfertaCatalogo = { cantidad: number; precio: number; precio_texto: string; total: number; total_texto: string };
export type ItemCatalogo = {
  handle: string;
  titulo: string;
  variante_id: string;
  precio: number;
  precio_texto: string;
  disponible: boolean;
  total: number;
  total_texto: string;
  ofertas: OfertaCatalogo[];
  imagen: string | null;
};

/** Precio total de `cantidad` unidades: la oferta por cantidad si existe; si no, lista × cantidad. */
export function precioPorCantidad(precio: number, cantidad: number, ofertas: Record<string, number> | undefined): number {
  const o = ofertas?.[String(cantidad)];
  return typeof o === "number" && o > 0 ? o : precio * cantidad;
}

export function itemsCatalogo(productos: ProductoShopify[], ctx: CtxTurno): ItemCatalogo[] {
  const envio = ctx.cfg.envio.costo_gs;
  return productos.map((p) => {
    const v = p.variantes.find((x) => x.disponible) ?? p.variantes[0];
    if (!v) return null;
    const ofertas = Object.entries(ctx.cfg.ofertas[p.handle] ?? {})
      .map(([c, precio]) => ({ cantidad: Number(c), precio }))
      .filter((o) => Number.isInteger(o.cantidad) && o.cantidad > 1 && o.precio > 0)
      .sort((a, b) => a.cantidad - b.cantidad)
      .map((o) => ({ ...o, precio_texto: gs(o.precio), total: o.precio + envio, total_texto: gs(o.precio + envio) }));
    return {
      handle: p.handle,
      titulo: p.title,
      variante_id: v.id,
      precio: v.price,
      precio_texto: gs(v.price),
      disponible: p.variantes.some((x) => x.disponible),
      total: v.price + envio,
      total_texto: gs(v.price + envio),
      ofertas,
      imagen: p.imagen,
    };
  }).filter((x): x is ItemCatalogo => x !== null);
}

function buscar(items: ItemCatalogo[], q: string | undefined): ItemCatalogo[] {
  const n = normalizar(q ?? "");
  if (!n) return items;
  const palabras = n.split(" ").filter((w) => w.length > 2);
  const r = items.filter((i) => {
    const h = normalizar(`${i.titulo} ${i.handle.replace(/-/g, " ")}`);
    return palabras.some((w) => h.includes(w) || h.includes(w.replace(/s$/, "")));
  });
  return r.length ? r : items;
}

// ---------- ejecutores ----------

async function consultarCatalogo(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  let productos: ProductoShopify[];
  try {
    productos = await catalogo(deps, ctx);
  } catch (e) {
    return error(`catalogo_no_disponible: ${e instanceof Error ? e.message : e}. Derivá a Enrique si el cliente necesita el precio.`);
  }
  const items = buscar(itemsCatalogo(productos, ctx), typeof input.busqueda === "string" ? input.busqueda : undefined);
  return {
    resultado: {
      ok: true,
      moneda: "PYG",
      envio: ctx.cfg.envio.costo_gs,
      envio_texto: gs(ctx.cfg.envio.costo_gs),
      plazo: ctx.cfg.envio.plazo,
      productos: items.map(({ imagen: _i, ...resto }) => resto),
      nota: "total = precio + envío. Usá solo estos montos.",
    },
  };
}

async function estadoPedido(_i: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const pedidos = await deps.pedidosDeCliente(ctx.clienteId, ctx.telefono);
  if (!pedidos.length) return { resultado: { ok: true, pedidos: [], nota: "No encontré pedidos de este cliente. Ofrecé derivar a Enrique si dice que compró." } };
  return {
    resultado: {
      ok: true,
      plazo: ctx.cfg.envio.plazo,
      pedidos: pedidos.slice(0, 3).map((p) => ({
        pedido: p.nombre ?? p.shopify_order_id,
        shopify_order_id: p.shopify_order_id,
        confirmacion: p.estado_confirmacion,
        envio: p.estado_envio ?? "todavía sin datos del courier",
        courier: p.courier,
        total: p.total,
        fecha: p.creado_en,
        ultimo_estado: p.ultimo_estado ?? null,
      })),
    },
  };
}

/** Valida los datos y arma las líneas con los precios del catálogo. Puro (salvo el catálogo ya leído). */
export function armarPedido(
  input: Record<string, unknown>,
  items: ItemCatalogo[],
  ctx: CtxTurno,
): { ok: true; datos: DatosPedidoChat } | { ok: false; faltan: string[]; error?: string } {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
  const faltan: string[] = [];
  if (!s("nombre")) faltan.push("nombre");
  if (!s("ciudad")) faltan.push("ciudad");
  if (!s("direccion")) faltan.push("direccion");
  if (!ctx.telefono) faltan.push("telefono (usá pedir_telefono)");
  const pedidos = Array.isArray(input.items) ? input.items as Array<Record<string, unknown>> : [];
  if (!pedidos.length) faltan.push("items");
  if (faltan.length) return { ok: false, faltan };

  const lineas: LineaPedido[] = [];
  for (const it of pedidos) {
    const handle = String(it.handle ?? "");
    const cantidad = Number(it.cantidad);
    const prod = items.find((x) => x.handle === handle) ??
      items.find((x) => normalizar(x.titulo).includes(normalizar(handle)) && normalizar(handle).length > 3);
    if (!prod) return { ok: false, faltan: [], error: `producto_desconocido:${handle}. Usá un handle de consultar_catalogo.` };
    if (!prod.disponible) return { ok: false, faltan: [], error: `sin_stock:${prod.handle}` };
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > ctx.cfg.vendedor.cantidad_max) {
      return { ok: false, faltan: [], error: `cantidad_invalida:${cantidad} (1 a ${ctx.cfg.vendedor.cantidad_max}; más es mayorista: derivá)` };
    }
    lineas.push({
      handle: prod.handle,
      titulo: prod.titulo,
      variante_id: prod.variante_id,
      cantidad,
      total: precioPorCantidad(prod.precio, cantidad, ctx.cfg.ofertas[prod.handle]),
    });
  }
  const envio = ctx.cfg.envio.costo_gs;
  const subtotal = lineas.reduce((a, l) => a + l.total, 0);
  return {
    ok: true,
    datos: {
      nombre: s("nombre"),
      ciudad: s("ciudad"),
      direccion: s("direccion"),
      referencia: s("referencia") || null,
      ubicacion: s("ubicacion") || null,
      telefono: ctx.telefono!,
      lineas,
      envio,
      total: subtotal + envio,
      factura: s("factura") || null,
    },
  };
}

/**
 * Líneas de Shopify. PYG no tiene decimales: si la oferta no se divide justo por la cantidad,
 * la diferencia va en una línea aparte de 1 unidad (la suma da exacto el precio de la oferta).
 */
export function lineasShopify(lineas: LineaPedido[]): Array<Record<string, unknown>> {
  const money = (n: number) => ({ shopMoney: { amount: String(n), currencyCode: "PYG" } });
  const out: Array<Record<string, unknown>> = [];
  for (const l of lineas) {
    const unit = Math.floor(l.total / l.cantidad);
    const resto = l.total - unit * l.cantidad;
    if (resto === 0) out.push({ variantId: l.variante_id, quantity: l.cantidad, priceSet: money(unit) });
    else {
      if (l.cantidad > 1) out.push({ variantId: l.variante_id, quantity: l.cantidad - 1, priceSet: money(unit) });
      out.push({ variantId: l.variante_id, quantity: 1, priceSet: money(unit + resto) });
    }
  }
  return out;
}

/** Input de orderCreate (Admin GraphQL 2026-10): pago pendiente como un pedido contra entrega de Releasit. */
export function inputOrderCreate(d: DatosPedidoChat, ctx: CtxTurno): Record<string, unknown> {
  const [nombre, ...resto] = d.nombre.split(/\s+/);
  const notas = [`Pedido creado por el vendedor con IA (WhatsApp).`];
  if (d.ubicacion) notas.push(`Ubicación: ${d.ubicacion}`);
  if (d.factura) notas.push(`Factura: ${d.factura}`);
  return {
    order: {
      currency: "PYG",
      phone: d.telefono,
      financialStatus: "PENDING",
      lineItems: lineasShopify(d.lineas),
      shippingLines: [{ title: "Envío", priceSet: { shopMoney: { amount: String(d.envio), currencyCode: "PYG" } } }],
      shippingAddress: {
        firstName: nombre,
        lastName: resto.join(" ") || null,
        address1: d.direccion,
        address2: d.referencia,
        city: d.ciudad,
        countryCode: "PY",
        phone: d.telefono,
      },
      tags: ["ORIGEN_WHATSAPP"],
      note: notas.join("\n"),
      customAttributes: [
        { key: "origen", value: "whatsapp" },
        { key: "conversacion_id", value: ctx.conversacionId },
      ],
    },
    options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: false, sendFulfillmentReceipt: false },
  };
}

export function textoResumen(d: DatosPedidoChat, ctx: CtxTurno): string {
  const lineas = d.lineas.map((l) => `${l.titulo} x${l.cantidad} (Gs ${gs(l.total)})`).join(", ");
  return texto(ctx.cfg.textos, "resumen", TEXTOS_DEFAULT.resumen, {
    lineas,
    envio: gs(d.envio),
    total: gs(d.total),
    direccion: [d.direccion, d.referencia].filter(Boolean).join(", "),
    ciudad: d.ciudad,
  });
}

function opts(ctx: CtxTurno) {
  return { clienteId: ctx.clienteId, conversacionId: ctx.conversacionId };
}

async function crearPedidoCod(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  if (input.confirmar !== true) {
    let productos: ProductoShopify[];
    try {
      productos = await catalogo(deps, ctx);
    } catch (e) {
      return error(`catalogo_no_disponible: ${e instanceof Error ? e.message : e}. Derivá a Enrique.`);
    }
    const a = armarPedido(input, itemsCatalogo(productos, ctx), ctx);
    if (!a.ok) return error(a.error ?? `faltan_datos: ${a.faltan.join(", ")}. Pedí solo el que falta.`, { faltan: a.faltan });
    const fila = await deps.guardarPedidoChat({
      conversacion_id: ctx.conversacionId,
      cliente_id: ctx.clienteId,
      estado: "resumen",
      datos: a.datos,
      total: a.datos.total,
      shopify_order_id: null,
    });
    const cuerpo = textoResumen(a.datos, ctx);
    const r = await deps.enviarInteractivo(
      ctx.destino,
      botonesSiNo(cuerpo, `vend_conf:${fila.id}`, `vend_corr:${fila.id}`, {
        si: texto(ctx.cfg.textos, "boton_confirmar", TEXTOS_DEFAULT.boton_confirmar),
        no: texto(ctx.cfg.textos, "boton_corregir", TEXTOS_DEFAULT.boton_corregir),
      }),
      opts(ctx),
    );
    if (!r.ok) return error(`no_se_pudo_mostrar_el_resumen: ${r.error}. Derivá a Enrique.`);
    return {
      resultado: { ok: true, resumen_enviado: true, total: a.datos.total, total_texto: gs(a.datos.total), pedido_chat_id: fila.id },
      terminal: true,
    };
  }

  // confirmar = true
  const previo = await deps.ultimoPedidoChat(ctx.conversacionId);
  if (!previo) return error("no_hay_resumen: primero llamá crear_pedido_cod con confirmar=false.");
  if (previo.estado === "creado" && previo.shopify_order_id) {
    return {
      resultado: { ok: true, ya_creado: true, shopify_order_id: previo.shopify_order_id, texto_respuesta: "Tu pedido ya está cargado; en unos minutos te llega la confirmación." },
    };
  }
  if (previo.estado !== "resumen") return error(`resumen_en_estado_${previo.estado}: armá un resumen nuevo.`);
  const vencido = ctx.ahora.getTime() - new Date(previo.creado_en).getTime() > 24 * 3600_000;
  if (vencido) return error("resumen_vencido: mostrá el resumen de nuevo con confirmar=false.");
  const boton = new RegExp(`\\(vend_conf:${previo.id}\\)`).test(ctx.textoEntrada);
  if (!boton && !esAceptacion(ctx.textoEntrada, ctx.cfg.aceptaciones)) {
    return error("falta_si_claro: el último mensaje del cliente no es un sí claro ni el botón Confirmar. Preguntá si confirma.");
  }

  const d = previo.datos;
  const r = await deps.crearOrdenShopify(inputOrderCreate(d, ctx));
  if (!r.ok || !r.shopify_order_id) {
    await deps.guardarPedidoChat({ ...previo, estado: "fallido" });
    await deps.avisar(
      `<b>Falló crear un pedido de WhatsApp</b>\nCliente: ${escapar(d.nombre)} · ${escapar(d.telefono)}\nTotal: Gs ${gs(d.total)}\nError: ${escapar(r.error ?? "desconocido")}\nCargalo a mano o escribile.`,
    );
    return error(`shopify_fallo: ${r.error}. Derivá a Enrique con motivo falla_herramienta.`);
  }
  await deps.guardarPedidoChat({ ...previo, estado: "creado", shopify_order_id: r.shopify_order_id });
  const avisos: string[] = [];
  if (r.nodo) {
    try {
      await deps.registrarComoReleasit(r.nodo);
    } catch (e) {
      avisos.push(`No se programó la confirmación: ${e instanceof Error ? e.message : e}`);
    }
  } else avisos.push("Shopify no devolvió el pedido completo: la confirmación la programa el webhook o la conciliación.");
  if (typeof r.total === "number" && Math.round(r.total) !== Math.round(d.total)) {
    avisos.push(`Ojo: Shopify calculó Gs ${gs(r.total)} y el chat le dijo Gs ${gs(d.total)}.`);
  }
  const aviso = formatoPedidoNuevo({
    shopify_order_id: r.shopify_order_id,
    nombre_pedido: r.nombre ?? null,
    total: d.total,
    productos: d.lineas.map((l) => `${l.titulo} x${l.cantidad}`),
    ciudad: d.ciudad,
    origen: "whatsapp (vendedor IA)",
    cliente: { nombre: d.nombre, telefono: d.telefono, wa_user_id: ctx.waUserId },
  });
  await deps.avisar([aviso.texto, ...avisos.map((a) => `• ${escapar(a)}`)].join("\n"), aviso.botones);
  const primer = d.nombre.split(/\s+/)[0] ?? "";
  return {
    resultado: {
      ok: true,
      shopify_order_id: r.shopify_order_id,
      pedido: r.nombre,
      total: d.total,
      texto_respuesta: texto(ctx.cfg.textos, "pedido_creado", TEXTOS_DEFAULT.pedido_creado, { nombre: primer, pedido: r.nombre ?? "" }),
    },
    pedidoCreado: { shopify_order_id: r.shopify_order_id, nombre: r.nombre ?? String(r.shopify_order_id) },
  };
}

function escapar(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ¿El texto ya manda al médico? (médico/médica, con o sin tilde). */
export function mencionaMedico(t: string | null | undefined): boolean {
  return /\bmedic[oa]s?\b/.test(normalizar(t ?? ""));
}

/**
 * Texto que ve el cliente al derivar (cuerpo del botón o mensaje suelto), en este orden:
 * 1) si el motivo es salud y el texto del modelo no nombra al médico, `derivacion_salud`;
 * 2) el texto del modelo que acompañó la herramienta (ya pasó el filtro de salida; si no pasó, llega null);
 * 3) la llamada a la acción: `derivacion` / `derivacion_sin_boton`, o la versión corta (`derivacion_cta*`)
 *    si el texto del modelo ya dice que lo pasa con Enrique, para no repetirlo.
 */
export function textoClienteDerivacion(p: { motivo: string; textoModelo?: string | null; conBoton: boolean; textos: Record<string, string> }): string {
  const modelo = (p.textoModelo ?? "").trim();
  const partes: string[] = [];
  if (p.motivo === "salud" && !mencionaMedico(modelo)) partes.push(texto(p.textos, "derivacion_salud", TEXTOS_DEFAULT.derivacion_salud));
  if (modelo) partes.push(modelo);
  const yaLoPasa = /\benrique\b|\bte paso\b|\bte (comunico|derivo)\b/.test(normalizar(modelo));
  const clave = p.conBoton ? (yaLoPasa ? "derivacion_cta" : "derivacion") : (yaLoPasa ? "derivacion_cta_sin_boton" : "derivacion_sin_boton");
  partes.push(texto(p.textos, clave, TEXTOS_DEFAULT[clave]));
  return partes.join("\n");
}

/**
 * Deriva a Enrique. Lo usa la herramienta y también el orquestador (API caída, topes, filtro).
 * `texto_previo`: lo que el modelo escribió junto con la llamada, YA revisado por el filtro de salida
 * (el orquestador lo pasa en null si el filtro lo rechazó).
 */
export async function derivarAEnrique(
  input: { motivo: string; resumen: string; shopify_order_id?: number | null; texto_previo?: string | null },
  ctx: CtxTurno,
  deps: DepsHerramientas,
): Promise<ResultadoHerramienta> {
  await deps.pasarAHumano(ctx.conversacionId);
  let orderId: number | null = Number.isFinite(Number(input.shopify_order_id)) && input.shopify_order_id ? Number(input.shopify_order_id) : null;
  let nombrePedido: string | null = null;
  try {
    const pedidos = await deps.pedidosDeCliente(ctx.clienteId, ctx.telefono);
    const p = orderId ? pedidos.find((x) => x.shopify_order_id === orderId) : pedidos[0];
    if (p) {
      orderId = p.shopify_order_id;
      nombrePedido = p.nombre;
    }
  } catch { /* sin pedido: el aviso sale igual */ }

  const nombre = ctx.nombreCliente?.split(/\s+/)[0] ?? "";
  const resumen = (input.resumen || MOTIVO_LEGIBLE[input.motivo] || "Necesito ayuda").trim();
  const t = ctx.cfg.textos;
  const numero = ctx.cfg.vendedor.whatsapp_enrique;
  const mensajeEnrique = texto(t, "mensaje_a_enrique", TEXTOS_DEFAULT.mensaje_a_enrique, {
    nombre: nombre || "cliente de Voltra",
    resumen: `${resumen}${nombrePedido ? ` (pedido ${nombrePedido})` : ""}`,
  });
  const url = numero ? enlaceWaMe(numero, mensajeEnrique) : null;
  const textoCliente = textoClienteDerivacion({ motivo: input.motivo, textoModelo: input.texto_previo, conBoton: !!url, textos: t });
  const rCliente = url
    ? await deps.enviarInteractivo(ctx.destino, botonEnlace(textoCliente, texto(t, "boton_enrique", TEXTOS_DEFAULT.boton_enrique), url), opts(ctx))
    : await deps.enviarTexto(ctx.destino, textoCliente, opts(ctx));

  const aviso = formatoChatNecesitaEnrique({
    motivo: MOTIVO_LEGIBLE[input.motivo] ?? input.motivo,
    resumen,
    shopify_order_id: orderId,
    nombre_pedido: nombrePedido,
    cliente: { nombre: ctx.nombreCliente, telefono: ctx.telefono, wa_user_id: ctx.waUserId },
    ofrecerReponer: input.motivo === "reclamo",
  });
  const extra: string[] = ["El chat pasó a humano: el vendedor IA ya no responde."];
  if (!rCliente.ok) extra.push(`No pude avisarle al cliente: ${rCliente.error}`);
  if (!numero) extra.push("Falta config_wa.vendedor.whatsapp_enrique: el cliente no recibió el botón para escribirte.");
  const rTg = await deps.avisar([aviso.texto, ...extra.map((e) => `• ${escapar(e)}`)].join("\n"), aviso.botones);
  return {
    resultado: { ok: true, derivado: true, aviso_cliente: rCliente.ok, aviso_telegram: rTg.ok, texto_cliente: textoCliente, nota: "No escribas nada más." },
    terminal: true,
    derivado: true,
  };
}

function textoRevisado(input: Record<string, unknown>, ctx: CtxTurno): { ok: true; texto: string } | { ok: false; r: ResultadoHerramienta } {
  const t = typeof input.texto === "string" ? input.texto.trim() : "";
  if (!t) return { ok: false, r: error("falta_texto") };
  const rev = ctx.revisar(t);
  if (!rev.ok) return { ok: false, r: error(`texto_bloqueado: ${rev.motivos.join(", ")}. Reescribilo.`) };
  return { ok: true, texto: t };
}

async function enviarInteractivoRevisado(
  input: Record<string, unknown>,
  ctx: CtxTurno,
  deps: DepsHerramientas,
  construir: (t: string) => Record<string, unknown>,
  ok: Record<string, unknown> = {},
): Promise<ResultadoHerramienta> {
  const t = textoRevisado(input, ctx);
  if (!t.ok) return t.r;
  let interactivo: Record<string, unknown>;
  try {
    interactivo = construir(t.texto);
  } catch (e) {
    return error(`interactivo_invalido: ${e instanceof Error ? e.message : e}`);
  }
  const r = await deps.enviarInteractivo(ctx.destino, interactivo, opts(ctx));
  if (!r.ok) return error(`envio_fallido: ${r.error}`);
  return { resultado: { ok: true, enviado: true, ...ok, nota: "Ya se le mandó al cliente. No escribas nada más." }, terminal: true };
}

async function enviarMediaHerr(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  const handle = String(input.handle ?? "");
  const tipo = String(input.tipo ?? "foto");
  let caption: string | null = null;
  if (typeof input.texto === "string" && input.texto.trim()) {
    const t = textoRevisado(input, ctx);
    if (!t.ok) return t.r;
    caption = t.texto;
  }
  const media = ctx.cfg.media[handle] ?? {};
  let link: string | null = tipo === "foto" ? (media.foto ?? null) : (media[tipo] ?? null);
  if (!link && tipo === "foto") {
    try {
      link = (await catalogo(deps, ctx)).find((p) => p.handle === handle)?.imagen ?? null;
    } catch { /* sin catálogo */ }
  }
  if (!link) return error(`no_hay_${tipo}_cargado_para:${handle}. Seguí sin el archivo o ofrecé otra prueba.`);
  const r = await deps.enviarMedia(ctx.destino, tipo === "foto" ? "image" : "video", link, caption, opts(ctx));
  if (!r.ok) return error(`envio_fallido: ${r.error}`);
  return { resultado: { ok: true, enviado: true, nota: "Se mandó el archivo. Si hace falta, escribí una línea corta con una pregunta." } };
}

async function enviarOpciones(input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas): Promise<ResultadoHerramienta> {
  let items: ItemCatalogo[];
  try {
    items = itemsCatalogo(await catalogo(deps, ctx), ctx);
  } catch (e) {
    return error(`catalogo_no_disponible: ${e instanceof Error ? e.message : e}`);
  }
  const prod = items.find((x) => x.handle === input.handle);
  if (!prod) return error(`producto_desconocido:${input.handle}`);
  if (!prod.imagen?.startsWith("https://")) return error("producto_sin_foto: ofrecé las cantidades por texto.");
  if (!prod.ofertas.length) return error("sin_ofertas_por_cantidad: ofrecé solo ×1.");
  const tarjetas: Tarjeta[] = [
    { cantidad: 1, precio: prod.precio },
    ...prod.ofertas.map((o) => ({ cantidad: o.cantidad, precio: o.precio })),
  ].slice(0, 10).map((o) => ({
    imagenUrl: prod.imagen!,
    titulo: `×${o.cantidad} · Gs ${gs(o.precio)}`,
    cuerpo: `+ envío Gs ${gs(ctx.cfg.envio.costo_gs)} = Gs ${gs(o.precio + ctx.cfg.envio.costo_gs)}`,
    botonId: `vend_cant:${prod.handle}:${o.cantidad}`,
    botonTexto: `Quiero ×${o.cantidad}`,
  }));
  return await enviarInteractivoRevisado(input, ctx, deps, (t) => carruselOpciones(t, tarjetas));
}

/** Datos del turno que no vienen en el input de la herramienta (los pone el orquestador). */
export type ExtraEjecucion = {
  /** Texto que el modelo escribió junto con la llamada, ya revisado por el filtro (null si lo rechazó). */
  textoModelo?: string | null;
};

export type Ejecutor = (input: Record<string, unknown>, ctx: CtxTurno, deps: DepsHerramientas, extra?: ExtraEjecucion) => Promise<ResultadoHerramienta>;

export const EJECUTORES: Record<string, Ejecutor> = {
  consultar_catalogo: consultarCatalogo,
  estado_pedido: estadoPedido,
  crear_pedido_cod: crearPedidoCod,
  derivar_a_enrique: (i, c, d, x) =>
    derivarAEnrique({
      motivo: String(i.motivo ?? "otro"),
      resumen: String(i.resumen ?? ""),
      shopify_order_id: i.shopify_order_id as number | undefined,
      texto_previo: x?.textoModelo ?? null,
    }, c, d),
  enviar_media: enviarMediaHerr,
  pedir_ubicacion: (i, c, d) => enviarInteractivoRevisado(i, c, d, (t) => ubicacionRequest(t)),
  enviar_formulario: (i, c, d) => {
    const flowId = c.cfg.vendedor.flow_id;
    if (!flowId) return Promise.resolve(error("formulario_no_configurado: pedí los datos por texto, de a uno."));
    return enviarInteractivoRevisado(i, c, d, (t) =>
      flowFormulario({
        flowId,
        token: `pedido:${c.conversacionId}`,
        titulo: texto(c.cfg.textos, "formulario_titulo", TEXTOS_DEFAULT.formulario_titulo),
        cta: texto(c.cfg.textos, "formulario_cta", TEXTOS_DEFAULT.formulario_cta),
        texto: t,
        pantalla: c.cfg.vendedor.flow_pantalla ?? undefined,
      }));
  },
  enviar_opciones: enviarOpciones,
  pedir_telefono: (i, c, d) => {
    if (c.telefono) return Promise.resolve({ resultado: { ok: true, ya_tiene_telefono: true, nota: "El cliente ya tiene teléfono; seguí." } });
    return enviarInteractivoRevisado(i, c, d, (t) => pedirContacto(t));
  },
};

/** Ejecuta una herramienta; nunca lanza (un error vuelve al modelo como tool_result con is_error). */
export async function ejecutarHerramienta(
  nombre: string,
  input: Record<string, unknown>,
  ctx: CtxTurno,
  deps: DepsHerramientas,
  extra?: ExtraEjecucion,
): Promise<ResultadoHerramienta> {
  const ej = EJECUTORES[nombre];
  if (!ej) return error(`herramienta_desconocida:${nombre}`);
  try {
    return await ej(input ?? {}, ctx, deps, extra);
  } catch (e) {
    return error(`falla_interna: ${e instanceof Error ? e.message : String(e)}. Derivá a Enrique con motivo falla_herramienta.`);
  }
}

export type { PedidoChat };
