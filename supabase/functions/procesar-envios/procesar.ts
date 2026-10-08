// procesar-envios · lógica pura (sin red ni base de datos).
// Todo el I/O entra por `Deps`, así los tests no tocan Supabase, Meta, Shopify ni Telegram.
//
// Qué hace con cada fila vencida de envios_programados:
//   - 'ret' (48 h) / 'canc' (72 h): no manda WhatsApp. Retiene o cancela el pedido solo si
//     sigue sin respuesta, y avisa por Telegram.
//   - Mensajes: marketing solo con consentimiento 'si' vigente y en horario (si no, reprograma
//     a la próxima apertura o cancela). Utilidad sale las 24 h. Si la ventana de 24 h está
//     abierta y config_wa.usar_texto_libre_en_ventana = true, va como texto libre (o botones).
//   - Avisos de envío (despachado, entrega hoy, no entregado): solo dentro de
//     config_wa.horario_avisos_envio (8 a 20 h); si vencen de noche (p. ej. el reporte se
//     importó a las 22:00) se reprograman a la próxima apertura (8:00). Confirmación y
//     recordatorio siguen las 24 h.
//   - Errores: 131049 → reintento en 24 h; 131050 (el cliente apagó las ofertas en WhatsApp) → baja de
//     marketing (recompra/baja.ts) y no se reintenta; otros → espera creciente; al máximo, 'fallido'.
//   - voltra_seguimiento_entrega: con config_wa['ola4.factura'].activo, antes se pregunta a factura/io.ts
//     si hay factura emitida con PDF; si la hay, sale esa plantilla en lugar del seguimiento normal.

import { PLANTILLAS_RECOMPRA } from "../recompra/calendario.ts";

export type Categoria = "utilidad" | "marketing";

export interface Envio {
  id: string;
  cliente_id: string | null;
  shopify_order_id: number | null;
  plantilla: string;
  variables: unknown;
  categoria: Categoria;
  enviar_desde: string;
  estado: string;
  clave_unica: string | null;
  intentos: number;
  ultimo_error: string | null;
}

export interface Cliente {
  telefono: string | null;
  wa_user_id: string | null;
  nombre: string | null;
}

export interface Pedido {
  shopify_order_id: number;
  nombre: string | null;
  estado_confirmacion: string;
  tags: string[];
  total: number | null;
  raw: unknown;
}

export interface Contexto {
  cliente: Cliente | null;
  pedido: Pedido | null;
  /** Estado de la fila más reciente de wa_consentimientos (tipo 'marketing'), o null si no hay. */
  consentimientoMarketing: "si" | "no" | "baja" | null;
  /** wa_conversaciones.ultima_entrada_en más reciente del cliente. */
  ultimaEntrada: Date | null;
  conversacionId: string | null;
}

export interface Config {
  horario: { desde: number; hasta: number };
  /** config_wa.horario_avisos_envio: ventana para AVISOS_ENVIO_CON_HORARIO. */
  horarioAvisosEnvio: { desde: number; hasta: number };
  usarTextoLibreEnVentana: boolean;
  /** config_wa.textos_libres: { nombre_plantilla: "Hola {{1}}, ..." } para mandar dentro de la ventana. */
  textosLibres: Record<string, string>;
  lote: number;
  leaseMin: number;
  maxIntentos: number;
  /** Espera (min) antes del reintento N (índice = intentos ya hechos - 1). */
  esperasMin: number[];
  reintento131049H: number;
  /** config_wa['ola4.factura'].activo: seguimiento con la factura adjunta (mejora 7). */
  facturaActiva: boolean;
}

export const CONFIG_DEFECTO: Config = {
  horario: { desde: 8, hasta: 21 },
  horarioAvisosEnvio: { desde: 8, hasta: 20 },
  usarTextoLibreEnVentana: false,
  textosLibres: {},
  lote: 50,
  leaseMin: 10,
  maxIntentos: 3,
  esperasMin: [5, 30],
  reintento131049H: 24,
  facturaActiva: false,
};

export const IDIOMA = "es"; // Meta no tiene es_PY; "es" es el español genérico
const VENTANA_MS = 24 * 3_600_000;

// ─── Catálogo de plantillas (estructura; los textos están en supabase/plantillas/*.json) ───
// `vars`: claves de envios_programados.variables en el orden de {{1}}, {{2}}, ...
// `botones`: prefijo del payload (llega al webhook como "<prefijo>:<shopify_order_id>") y etiqueta.
export interface DefPlantilla {
  vars: string[];
  botones: { prefijo: string; titulo: string }[];
  /** Solo tiene sentido mientras el pedido espera confirmación. */
  soloPendiente?: boolean;
}

const CONF = [
  { prefijo: "conf_si", titulo: "Confirmar" },
  { prefijo: "conf_corregir", titulo: "Corregir datos" },
  { prefijo: "conf_cancelar", titulo: "Cancelar" },
];
const AYUDA = [{ prefijo: "ayuda", titulo: "Necesito ayuda" }];
// 07-10: confirmación con el formato de Facial Wellness (supabase/plantillas/voltra_confirmacion_pedido_v2.json).
const CONF_V2 = [
  { prefijo: "conf_si", titulo: "Confirmar pedido" },
  { prefijo: "conf_cancelar", titulo: "Cancelar pedido" },
  { prefijo: "ayuda", titulo: "Necesito ayuda" },
];

export const PLANTILLAS: Record<string, DefPlantilla> = {
  voltra_confirmacion_pedido: {
    vars: ["nombre", "productos", "total", "direccion", "ciudad"],
    botones: CONF,
    soloPendiente: true,
  },
  voltra_confirmacion_pedido_v2: {
    vars: ["pedido", "nombre", "productos", "total", "direccion", "ciudad"],
    botones: CONF_V2,
    soloPendiente: true,
  },
  // 07-10: igual que la v2 con las etiquetas en negrita.
  voltra_confirmacion_pedido_v3: {
    vars: ["pedido", "nombre", "productos", "total", "direccion", "ciudad"],
    botones: CONF_V2,
    soloPendiente: true,
  },
  voltra_recordatorio_confirmacion: { vars: ["nombre", "productos"], botones: CONF, soloPendiente: true },
  voltra_pedido_despachado: { vars: ["nombre", "productos", "courier", "plazo", "total"], botones: AYUDA },
  voltra_entrega_hoy: { vars: ["nombre", "total"], botones: AYUDA },
  voltra_no_entregado: {
    vars: ["nombre", "productos"],
    botones: [
      { prefijo: "ne_reintentar", titulo: "Volver a intentar" },
      { prefijo: "ne_direccion", titulo: "Cambiar dirección" },
      { prefijo: "ne_cancelar", titulo: "Cancelar" },
    ],
  },
  voltra_seguimiento_entrega: {
    vars: ["nombre", "productos"],
    botones: [
      { prefijo: "seg_bien", titulo: "Todo bien" },
      { prefijo: "seg_problema", titulo: "Tuve un problema" },
    ],
  },
  // Ola 4 (I1). Hoy la manda recuperar-borradores directo; queda acá por si se programa por cola.
  voltra_recuperar_borrador: { vars: ["nombre", "producto"], botones: [] },
  // Ola 3 (H1): marketing de recompra. Botones mk_* (los atiende wa-webhook; mk_baja → registrarBaja).
  ...PLANTILLAS_RECOMPRA,
};

/** Las de marketing llevan botones aunque el envío no tenga pedido (lanzamiento): payload "<prefijo>:0". */
export const esPlantillaMarketing = (nombre: string) => nombre.startsWith("voltra_mk_");

/** Plantillas de utilidad que no salen de noche (documento de mensajes, sección G). */
export const AVISOS_ENVIO_CON_HORARIO = new Set([
  "voltra_pedido_despachado",
  "voltra_entrega_hoy",
  "voltra_no_entregado",
]);

/** Acepta el nombre con o sin prefijo "voltra_". */
export function nombrePlantilla(p: string): string {
  const n = (p ?? "").trim();
  return n.startsWith("voltra_") ? n : `voltra_${n}`;
}

export type Tipo = "ret" | "canc" | "mensaje";

/** 'ret' / 'canc': shopify-webhook los programa con plantilla 'accion:retener' / 'accion:cancelar'
 *  y clave_unica "ret:<id>" / "canc:<id>". Se reconoce cualquiera de las dos marcas. */
export function tipoEnvio(e: Pick<Envio, "plantilla" | "clave_unica">): Tipo {
  const pref = (e.clave_unica ?? "").split(":")[0];
  const p = (e.plantilla ?? "").replace(/^voltra_/, "");
  if (pref === "ret" || p === "accion:retener" || p === "ret") return "ret";
  if (pref === "canc" || p === "accion:cancelar" || p === "canc") return "canc";
  return "mensaje";
}

// ─── Variables ───

/** 129000 → "129.000" (separador de miles de Paraguay). */
export function formatearGs(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Meta rechaza parámetros con saltos de línea, tabulaciones o más de 4 espacios seguidos. */
export function limpiarParametro(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return formatearGs(v);
  return String(v ?? "").replace(/[\n\r\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

/** Datos que se pueden sacar del pedido guardado (raw REST del webhook o nodo GraphQL). */
export function datosDesdePedido(p: Pedido | null): Obj {
  if (!p) return {};
  const raw = obj(p.raw);
  const ship = obj(raw.shipping_address ?? raw.shippingAddress);
  const cust = obj(raw.customer);
  const items: unknown[] = Array.isArray(raw.line_items)
    ? raw.line_items
    : Array.isArray(obj(raw.lineItems).nodes)
    ? obj(raw.lineItems).nodes as unknown[]
    : Array.isArray(obj(raw.lineItems).edges)
    ? (obj(raw.lineItems).edges as unknown[]).map((e) => obj(e).node)
    : [];
  const productos = items
    .map((i) => {
      const it = obj(i);
      const titulo = str(it.title) ?? str(it.name);
      const cant = Number(it.quantity ?? 1);
      return titulo ? `${cant} ${titulo}` : null;
    })
    .filter(Boolean)
    .join(", ");
  const direccion = [str(ship.address1), str(ship.address2)].filter(Boolean).join(" ");
  const out: Obj = {};
  if (productos) out.productos = productos;
  if (direccion) out.direccion = direccion;
  if (str(ship.city)) out.ciudad = str(ship.city);
  const nombre = str(ship.first_name) ?? str(ship.firstName) ?? str(cust.first_name) ?? str(cust.firstName);
  if (nombre) out.nombre = nombre;
  if (p.total != null) out.total = p.total;
  return out;
}

/**
 * Arma los parámetros {{1}}..{{n}}. `variables` puede ser un arreglo posicional
 * o un objeto con nombres (nombre, productos, total, ...) o con claves "1", "2", ...
 * Lo que falte se completa con el pedido guardado. Devuelve null y la clave faltante si no alcanza.
 */
export function armarParametros(
  def: DefPlantilla,
  variables: unknown,
  pedido: Pedido | null,
  cliente: Cliente | null,
): { ok: true; valores: string[] } | { ok: false; falta: string } {
  if (Array.isArray(variables)) {
    const valores = variables.map(limpiarParametro);
    if (valores.length !== def.vars.length || valores.some((v) => !v)) {
      return { ok: false, falta: `se esperaban ${def.vars.length} variables` };
    }
    return { ok: true, valores };
  }
  const v = obj(variables);
  const extra = datosDesdePedido(pedido);
  const valores: string[] = [];
  for (const [i, clave] of def.vars.entries()) {
    // shopify-webhook guarda `total` (número) y `total_texto` ("129.000"): manda el texto si está.
    let x = (clave === "total" ? v.total_texto ?? v.total : v[clave]) ?? v[String(i + 1)] ?? extra[clave];
    if (clave === "nombre") x = x ?? cliente?.nombre;
    if (clave === "nombre" && typeof x === "string") x = x.trim().split(/\s+/)[0]; // solo el primer nombre
    const s = limpiarParametro(x);
    if (!s) return { ok: false, falta: clave };
    valores.push(s);
  }
  return { ok: true, valores };
}

/** Componentes de la plantilla para la API de mensajes (body + payload dinámico de cada botón). */
export function construirComponentes(def: DefPlantilla, valores: string[], orderId: number | null): unknown[] {
  const comps: unknown[] = [];
  if (valores.length) {
    comps.push({ type: "body", parameters: valores.map((text) => ({ type: "text", text })) });
  }
  if (orderId != null) {
    def.botones.forEach((b, i) => {
      comps.push({
        type: "button",
        sub_type: "quick_reply",
        index: String(i),
        parameters: [{ type: "payload", payload: `${b.prefijo}:${orderId}` }],
      });
    });
  }
  return comps;
}

export function rellenarTexto(plantillaTexto: string, valores: string[]): string {
  return plantillaTexto.replace(/\{\{(\d+)\}\}/g, (_, n) => valores[Number(n) - 1] ?? "");
}

// ─── Decisión ───

export type Decision =
  | { accion: "plantilla"; to: string; nombre: string; idioma: string; componentes: unknown[]; valores?: string[] }
  | { accion: "texto"; to: string; texto: string }
  | { accion: "botones"; to: string; texto: string; botones: { id: string; titulo: string }[] }
  | { accion: "reprogramar"; enviar_desde: Date; motivo: string }
  | { accion: "cancelar"; motivo: string }
  | { accion: "fallar"; motivo: string }
  | { accion: "retener" }
  | { accion: "cancelar_pedido" };

const CANCELADOS = ["cancelado_cliente", "cancelado_sin_respuesta"];

export function ventanaAbierta(ultimaEntrada: Date | null, ahora: Date): boolean {
  return !!ultimaEntrada && ahora.getTime() - ultimaEntrada.getTime() < VENTANA_MS;
}

export interface Horario {
  dentro(d: Date, cfg: { desde: number; hasta: number }): boolean;
  proxima(d: Date, cfg: { desde: number; hasta: number }): Date;
}

export function decidir(e: Envio, ctx: Contexto, cfg: Config, ahora: Date, horario: Horario): Decision {
  const tipo = tipoEnvio(e);
  const estadoPedido = ctx.pedido?.estado_confirmacion ?? null;

  if (tipo === "ret") {
    if (!ctx.pedido) return { accion: "cancelar", motivo: "pedido_no_encontrado" };
    return estadoPedido === "pendiente"
      ? { accion: "retener" }
      : { accion: "cancelar", motivo: `pedido_${estadoPedido}` };
  }
  if (tipo === "canc") {
    if (!ctx.pedido) return { accion: "cancelar", motivo: "pedido_no_encontrado" };
    // 'retenido' también es "sigue sin respuesta": lo puso la retención de las 48 h.
    return estadoPedido === "pendiente" || estadoPedido === "retenido"
      ? { accion: "cancelar_pedido" }
      : { accion: "cancelar", motivo: `pedido_${estadoPedido}` };
  }

  const nombre = nombrePlantilla(e.plantilla);
  const def = PLANTILLAS[nombre];
  if (!def) return { accion: "fallar", motivo: `plantilla_desconocida:${nombre}` };

  if (e.shopify_order_id != null && estadoPedido) {
    if (CANCELADOS.includes(estadoPedido)) return { accion: "cancelar", motivo: `pedido_${estadoPedido}` };
    if (def.soloPendiente && estadoPedido !== "pendiente" && estadoPedido !== "retenido") {
      return { accion: "cancelar", motivo: `pedido_${estadoPedido}` };
    }
  }

  const to = ctx.cliente?.telefono ?? ctx.cliente?.wa_user_id ?? null;
  if (!to) return { accion: "fallar", motivo: "cliente_sin_telefono" };

  if (e.categoria === "marketing") {
    if (ctx.consentimientoMarketing !== "si") {
      return { accion: "cancelar", motivo: `sin_consentimiento_marketing:${ctx.consentimientoMarketing ?? "ninguno"}` };
    }
    if (!horario.dentro(ahora, cfg.horario)) {
      return { accion: "reprogramar", enviar_desde: horario.proxima(ahora, cfg.horario), motivo: "fuera_de_horario" };
    }
  }

  if (AVISOS_ENVIO_CON_HORARIO.has(nombre) && !horario.dentro(ahora, cfg.horarioAvisosEnvio)) {
    return {
      accion: "reprogramar",
      enviar_desde: horario.proxima(ahora, cfg.horarioAvisosEnvio),
      motivo: "fuera_de_horario_avisos_envio",
    };
  }

  const p = armarParametros(def, e.variables, ctx.pedido, ctx.cliente);
  if (!p.ok) return { accion: "fallar", motivo: `falta_variable:${p.falta}` };

  const textoLibre = cfg.textosLibres[nombre];
  if (
    e.categoria === "utilidad" && cfg.usarTextoLibreEnVentana && textoLibre &&
    ventanaAbierta(ctx.ultimaEntrada, ahora)
  ) {
    const texto = rellenarTexto(textoLibre, p.valores);
    if (def.botones.length && e.shopify_order_id != null) {
      return {
        accion: "botones",
        to,
        texto,
        botones: def.botones.map((b) => ({ id: `${b.prefijo}:${e.shopify_order_id}`, titulo: b.titulo })),
      };
    }
    if (!def.botones.length) return { accion: "texto", to, texto };
  }

  return {
    accion: "plantilla",
    to,
    nombre,
    idioma: IDIOMA,
    componentes: construirComponentes(
      def,
      p.valores,
      e.shopify_order_id ?? (esPlantillaMarketing(nombre) ? 0 : null),
    ),
    valores: p.valores,
  };
}

// ─── Errores y reintentos ───

/** Código de error de Meta desde el texto de wa.ts ("131049: mensaje") o un objeto {code}. */
export function codigoError(error: unknown): number | null {
  if (error && typeof error === "object") {
    const c = (error as { code?: unknown }).code ?? (error as { error?: { code?: unknown } }).error?.code;
    return typeof c === "number" ? c : typeof c === "string" && /^\d+$/.test(c) ? Number(c) : null;
  }
  const m = String(error ?? "").match(/^\s*(\d{3,})\b/);
  return m ? Number(m[1]) : null;
}

export interface CambioEnvio {
  estado: "pendiente" | "enviado" | "cancelado" | "fallido";
  intentos?: number;
  enviar_desde?: string;
  ultimo_error?: string | null;
}

/** Meta: el usuario dejó de recibir mensajes de marketing de la empresa. */
export const CODIGO_BAJA_META = 131050;

export function cambioPorError(e: Envio, error: unknown, ahora: Date, cfg: Config): CambioEnvio {
  const intentos = (e.intentos ?? 0) + 1;
  const texto = typeof error === "string" ? error : JSON.stringify(error);
  const ultimo_error = String(texto).slice(0, 500);
  if (intentos >= cfg.maxIntentos) return { estado: "fallido", intentos, ultimo_error };
  const espera = codigoError(error) === 131049
    ? cfg.reintento131049H * 60
    : cfg.esperasMin[Math.min(intentos - 1, cfg.esperasMin.length - 1)] ?? 30;
  return {
    estado: "pendiente",
    intentos,
    ultimo_error,
    enviar_desde: new Date(ahora.getTime() + espera * 60_000).toISOString(),
  };
}

// ─── Orquestación ───

export type ResultadoEnvio = { ok: boolean; wa_message_id?: string; error?: string };
export type Resultado = { ok: boolean; error?: string };
export type BotonTg = { texto: string; callback?: string; url?: string };

export interface Deps {
  ahora(): Date;
  cfg: Config;
  horario: Horario;
  /** Toma hasta `lote` filas 'pendiente' vencidas y las bloquea (lease) para esta ejecución. */
  reclamar(lote: number, leaseMin: number): Promise<Envio[]>;
  contexto(e: Envio): Promise<Contexto>;
  actualizarEnvio(id: string, cambio: CambioEnvio): Promise<void>;
  enviarPlantilla(to: string, nombre: string, idioma: string, comps: unknown[], op: Opciones): Promise<ResultadoEnvio>;
  enviarTexto(to: string, texto: string, op: Opciones): Promise<ResultadoEnvio>;
  enviarBotones(
    to: string,
    texto: string,
    botones: { id: string; titulo: string }[],
    op: Opciones,
  ): Promise<ResultadoEnvio>;
  /** Tag RETENIDO_SIN_RESPUESTA en Shopify + estado_confirmacion 'retenido'. */
  retenerPedido(orderId: number): Promise<Resultado>;
  /** cancelarPedido en Shopify + estado_confirmacion 'cancelado_sin_respuesta' + cancela envíos pendientes. */
  cancelarPedidoSinRespuesta(orderId: number): Promise<Resultado>;
  /** Telegram (texto ya escapado para HTML). */
  avisar(texto: string, botones?: BotonTg[][]): Promise<unknown>;
  escapar(s: unknown): string;
  /** Error 131050: baja de marketing del cliente (recompra/baja.ts, origen 'meta_131050'). Opcional. */
  registrarBaja?(clienteId: string): Promise<{ ok: boolean; error?: string }>;
  /** factura/io.ts envioSeguimientoParaPedido: plantilla con la factura o null. Solo con cfg.facturaActiva. */
  seguimientoConFactura?(
    orderId: number,
    variables: { nombre: string | null; productos: string | null },
  ): Promise<{ plantilla: string; idioma: string; componentes: unknown[] } | null>;
}

export type Opciones = { clienteId?: string | null; conversacionId?: string | null };

export interface Resumen {
  tomados: number;
  enviados: number;
  reprogramados: number;
  cancelados: number;
  reintentos: number;
  fallidos: number;
  acciones: number;
}

export async function procesarLote(d: Deps): Promise<Resumen> {
  const r: Resumen = {
    tomados: 0,
    enviados: 0,
    reprogramados: 0,
    cancelados: 0,
    reintentos: 0,
    fallidos: 0,
    acciones: 0,
  };
  const envios = await d.reclamar(d.cfg.lote, d.cfg.leaseMin);
  r.tomados = envios.length;
  for (const e of envios) {
    try {
      await procesarUno(e, d, r);
    } catch (err) {
      // Error inesperado (base, red): cuenta como intento fallido y no frena el lote.
      const cambio = cambioPorError(
        e,
        `excepcion: ${err instanceof Error ? err.message : String(err)}`,
        d.ahora(),
        d.cfg,
      );
      await d.actualizarEnvio(e.id, cambio).catch(() => {});
      cambio.estado === "fallido" ? r.fallidos++ : r.reintentos++;
    }
  }
  return r;
}

async function procesarUno(e: Envio, d: Deps, r: Resumen): Promise<void> {
  const ahora = d.ahora();
  const ctx = await d.contexto(e);
  const dec = decidir(e, ctx, d.cfg, ahora, d.horario);
  const pedidoTxt = d.escapar(ctx.pedido?.nombre ?? `#${e.shopify_order_id ?? "?"}`);
  const op: Opciones = { clienteId: e.cliente_id, conversacionId: ctx.conversacionId };

  switch (dec.accion) {
    case "cancelar":
      r.cancelados++;
      return d.actualizarEnvio(e.id, { estado: "cancelado", ultimo_error: dec.motivo });
    case "reprogramar":
      r.reprogramados++;
      return d.actualizarEnvio(e.id, {
        estado: "pendiente",
        enviar_desde: dec.enviar_desde.toISOString(),
        ultimo_error: dec.motivo,
      });
    case "fallar":
      r.fallidos++;
      await d.actualizarEnvio(e.id, { estado: "fallido", intentos: (e.intentos ?? 0) + 1, ultimo_error: dec.motivo });
      await d.avisar(
        `Envío fallido ${d.escapar(nombrePlantilla(e.plantilla))} · pedido ${pedidoTxt}: ${d.escapar(dec.motivo)}`,
      );
      return;
    case "retener":
    case "cancelar_pedido": {
      const id = e.shopify_order_id as number;
      const res = dec.accion === "retener" ? await d.retenerPedido(id) : await d.cancelarPedidoSinRespuesta(id);
      if (!res.ok) return aplicarError(e, res.error ?? "error_shopify", d, r, pedidoTxt);
      r.acciones++;
      await d.actualizarEnvio(e.id, { estado: "enviado", intentos: (e.intentos ?? 0) + 1, ultimo_error: null });
      if (dec.accion === "retener") {
        await d.avisar(
          `Pedido ${pedidoTxt} retenido: 48 h sin confirmar. Se cancela solo a las 72 h si no responde.`,
          [[{ texto: "Le escribo yo", callback: `escribo:${id}` }, {
            texto: "Cancelar ya",
            callback: `cancelar:${id}`,
          }]],
        );
      } else {
        await d.avisar(`Pedido ${pedidoTxt} cancelado: 72 h sin confirmar.`);
      }
      return;
    }
    default: {
      if (
        dec.accion === "plantilla" && dec.nombre === "voltra_seguimiento_entrega" && d.cfg.facturaActiva &&
        d.seguimientoConFactura && e.shopify_order_id != null
      ) {
        // Si falla la consulta de la factura, sale el seguimiento normal (no se pierde el mensaje).
        const conFactura = await d.seguimientoConFactura(e.shopify_order_id, {
          nombre: dec.valores?.[0] ?? null,
          productos: dec.valores?.[1] ?? null,
        }).catch((err) => {
          console.error("seguimiento con factura:", err);
          return null;
        });
        if (conFactura) {
          Object.assign(dec, { nombre: conFactura.plantilla, idioma: conFactura.idioma, componentes: conFactura.componentes });
        }
      }
      const res = dec.accion === "plantilla"
        ? await d.enviarPlantilla(dec.to, dec.nombre, dec.idioma, dec.componentes, op)
        : dec.accion === "botones"
        ? await d.enviarBotones(dec.to, dec.texto, dec.botones, op)
        : await d.enviarTexto(dec.to, dec.texto, op);
      if (!res.ok) return aplicarError(e, res.error ?? "error_desconocido", d, r, pedidoTxt);
      r.enviados++;
      return d.actualizarEnvio(e.id, { estado: "enviado", intentos: (e.intentos ?? 0) + 1, ultimo_error: null });
    }
  }
}

async function aplicarError(e: Envio, error: string, d: Deps, r: Resumen, pedidoTxt: string): Promise<void> {
  if (codigoError(error) === CODIGO_BAJA_META) {
    // El cliente apagó "Ofertas y anuncios": no se reintenta y se registra la baja de marketing.
    r.cancelados++;
    await d.actualizarEnvio(e.id, {
      estado: "cancelado",
      intentos: (e.intentos ?? 0) + 1,
      ultimo_error: `meta_131050: ${String(error).slice(0, 400)}`,
    });
    if (e.cliente_id && d.registrarBaja) {
      const b = await d.registrarBaja(e.cliente_id).catch((x) => ({ ok: false, error: String(x) }));
      if (!b.ok) console.error(`registrarBaja (131050) cliente ${e.cliente_id}:`, b.error);
    }
    return;
  }
  const cambio = cambioPorError(e, error, d.ahora(), d.cfg);
  await d.actualizarEnvio(e.id, cambio);
  if (cambio.estado === "fallido") {
    r.fallidos++;
    await d.avisar(
      `Envío fallido tras ${cambio.intentos} intentos: ${
        d.escapar(nombrePlantilla(e.plantilla))
      } · pedido ${pedidoTxt}\n${d.escapar(error)}`,
    );
  } else r.reintentos++;
}

/** Arma la config desde las filas de config_wa (lo que falte queda en el valor por defecto). */
export function configDesdeFilas(filas: { clave: string; valor: unknown }[]): Config {
  const m = new Map(filas.map((f) => [f.clave, f.valor]));
  const cfg: Config = { ...CONFIG_DEFECTO, textosLibres: {} };
  const h = obj(m.get("horario_marketing"));
  if (typeof h.desde === "number" && typeof h.hasta === "number") cfg.horario = { desde: h.desde, hasta: h.hasta };
  const ha = obj(m.get("horario_avisos_envio"));
  if (typeof ha.desde === "number" && typeof ha.hasta === "number") {
    cfg.horarioAvisosEnvio = { desde: ha.desde, hasta: ha.hasta };
  }
  const flag = m.get("usar_texto_libre_en_ventana");
  cfg.usarTextoLibreEnVentana = flag === true || obj(flag).activo === true;
  const t = obj(m.get("textos_libres"));
  for (const [k, v] of Object.entries(t)) if (typeof v === "string") cfg.textosLibres[nombrePlantilla(k)] = v;
  const pe = obj(m.get("procesar_envios"));
  const num = (x: unknown, def: number) => (typeof x === "number" && x > 0 ? x : def);
  cfg.lote = num(pe.lote, cfg.lote);
  cfg.leaseMin = num(pe.lease_min, cfg.leaseMin);
  cfg.maxIntentos = num(pe.max_intentos, cfg.maxIntentos);
  cfg.reintento131049H = num(pe.reintento_131049_h, cfg.reintento131049H);
  cfg.facturaActiva = obj(m.get("ola4.factura")).activo === true;
  if (Array.isArray(pe.esperas_min) && pe.esperas_min.every((x) => typeof x === "number")) {
    cfg.esperasMin = pe.esperas_min as number[];
  }
  return cfg;
}
