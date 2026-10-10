// _shared/sifen/desde_pedido.ts · Dueño: E (orquestación SIFEN). Lógica pura, sin red ni base.
//
// Pedido de shopify_pedidos (columna raw = JSON del webhook de Shopify) → DocumentoDE del contrato (tipos.ts).
//
// Reglas de negocio (Voltra, COD):
//   - Se factura lo COBRADO de verdad: el precio de cada line_item menos sus descuentos (las ofertas ×2/×3/pack
//     ya vienen en el precio; el upsell es otro line_item; el downsell es un descuento o un precio menor).
//   - El envío va como ítem aparte ("Envío", Gs 33.000 por defecto, IVA 10 % configurable). [VERIFICAR contadora]
//   - Contado. Medio de pago (MT v150 campo E606 iTiPago, verificado 10-10 en el PDF del MT pág. 82):
//       etiqueta PAGO_VERIFICADO (pago anticipado por transferencia, verificado en ueno) → 5 Transferencia;
//       etiqueta PAGADO_QR → pago_tipo_qr (el MT no tiene código "QR": 7 billetera / 21 pago electrónico [VERIFICAR contadora]);
//       nada → 1 Efectivo (cobro contra entrega).
//   - La suma de los ítems tiene que dar EXACTO el total cobrado. Si no cuadra → NO se emite (estado 'revisar').
//   - Receptor: RUC con dígito verificador válido + razón social → 'ruc'; cédula → 'documento';
//     nada (o RUC inválido) → 'innominado' + aviso. Desde `monto_identificar_consumidor` (Gs 7.000.000, NT-024)
//     un consumidor final sin identificar va a 'revisar'. [VERIFICAR con la contadora si conviene un tope menor]
//   - pedido_datos_fiscales (tabla de P2, 10-10): si el pedido tiene fila, MANDA sobre los atributos: receptor 'ruc'
//     con DV validado + razón social (RUC inválido o sin razón social → 'revisar', nunca consumidor final silencioso) y
//     condición: 'credito' → iCondOpe 2 con plazo_dias (E643 dPlazoCre "N días"). Sin fila: atributos del pedido
//     ("condicion"/"plazo_dias" de los pedidos mayoristas creados en Shopify), y si no, contado.
// Fuente de las formas: Manual Técnico SIFEN v150, grupos gDatRec (receptor), gCamItem (ítems), gCamCond (condición).

import type { DocumentoDE, ItemDE, ReceptorDE, TipoEmision } from "./tipos.ts";
import { atributosPedido, digitoVerificadorRuc } from "../facturacion.ts";
import { partesAsuncion } from "../horario.ts";

export interface PedidoSifen {
  shopify_order_id: number;
  nombre: string | null; // '#1001'
  total: number | null; // columna shopify_pedidos.total (lo que cobra el courier)
  estado_envio: string | null;
  tags: string[];
  raw: unknown;
  telefono?: string | null;
  entregado_en?: string | null;
  es_borrador?: boolean | null;
  estado_confirmacion?: string | null;
  /** true si el pedido pasó alguna vez por RENDIDO (pedido_estados). Lo llena la cola. */
  rendido?: boolean;
  /** Fila de pedido_datos_fiscales (P2) si existe. Tiene prioridad sobre los atributos del pedido. */
  datos_fiscales?: DatosFiscalesPedido | null;
}

/** public.pedido_datos_fiscales (contrato P1-P2 10-10, sección "P2 REDEFINIDO"). */
export interface DatosFiscalesPedido {
  ruc: string | null;
  dv: string | null;
  razon_social: string | null;
  email?: string | null;
  condicion?: string | null; // 'contado' | 'credito'
  plazo_dias?: number | null;
  origen?: string | null; // 'mayorista' | 'web_con_ruc'
}

/** DocumentoDE con el plazo del crédito (E643). emisor.ts lo pasa a armarXmlDEConOpciones({ plazoCredito }). */
export type CondicionConPlazo = NonNullable<DocumentoDE["condicion"]> & { plazoCredito?: string };

export type ModoEnvio = "linea_shopify" | "separar_del_total" | "ninguno";

export interface ConfigDesdePedido {
  establecimiento: string;
  punto: string;
  /** IVA de los productos (Voltra: todo gravado 10 %). Se puede pisar por SKU. [VERIFICAR contadora] */
  iva_productos: 0 | 5 | 10;
  iva_por_sku: Record<string, 0 | 5 | 10>;
  /**
   * linea_shopify: el envío viene en shipping_lines del pedido y se factura como ítem aparte.
   * separar_del_total: los precios son "todo incluido" → se separa `envio_gs` del producto más caro.
   * ninguno: no se discrimina el envío.
   */
  envio_modo: ModoEnvio;
  envio_gs: number; // 33.000
  envio_iva: 0 | 5 | 10; // [VERIFICAR contadora] servicio de flete: 10 %
  envio_descripcion: string;
  envio_codigo: string;
  /**
   * Monto (Gs) desde el que el consumidor final tiene que estar identificado. SIFEN rechaza innominado con
   * total ≥ Gs 7.000.000 (NT-024, validación D208c, código 1321). Si la contadora pide uno menor, se baja acá.
   */
  monto_identificar_consumidor: number | null;
  claves_datos_fiscales: string[];
  claves_documento: string[];
  /** Releasit trae RUC y razón social en atributos separados (revisión G 08-10). */
  claves_ruc: string[];
  claves_razon_social: string[];
  /** Atributos de los pedidos mayoristas creados en Shopify (P2): "condicion" (contado|credito) y "plazo_dias". */
  claves_condicion: string[];
  claves_plazo: string[];
  /** Plazo máximo aceptado (días). Más que esto → 'revisar'. */
  plazo_maximo_dias: number;
  /** Código por producto cuando el sku viene vacío (8/8 pedidos al 08-10): título normalizado o product_id → código. */
  codigos_producto: Record<string, string>;
  tag_prueba: string;
  /** cUniMed 77 = unidad (MT v150, tabla de unidades de medida). [VERIFICAR] */
  unidad_medida: number;
  /** iTiPago (MT v150 E606): 1 Efectivo, 5 Transferencia, 7 Billetera electrónica, 21 Pago electrónico. */
  pago_tipo_efectivo: number;
  pago_tipo_qr: number;
  tag_pagado_qr: string;
  /** Pago anticipado por transferencia verificado a mano (telegram-webhook pone la etiqueta PAGO_VERIFICADO). */
  pago_tipo_transferencia: number;
  tag_pago_verificado: string;
  tolerancia_gs: number;
}

export const CONFIG_DESDE_PEDIDO_DEFECTO: ConfigDesdePedido = {
  establecimiento: "001",
  punto: "001",
  iva_productos: 10,
  iva_por_sku: {},
  envio_modo: "linea_shopify",
  envio_gs: 33000,
  envio_iva: 10,
  envio_descripcion: "Envío a domicilio",
  envio_codigo: "ENVIO",
  monto_identificar_consumidor: 7_000_000,
  claves_datos_fiscales: ["factura", "datos de factura", "ruc y razon social"],
  claves_ruc: ["ruc"],
  claves_razon_social: ["razon social", "razón social", "razon_social"],
  claves_condicion: ["condicion", "condición"],
  claves_plazo: ["plazo_dias", "plazo dias", "plazo"],
  plazo_maximo_dias: 365,
  codigos_producto: {},
  tag_prueba: "PRUEBA_E2E",
  claves_documento: ["cedula", "cédula", "ci", "documento", "nro de cedula", "número de cédula", "numero de cedula"],
  unidad_medida: 77,
  pago_tipo_efectivo: 1,
  pago_tipo_qr: 7,
  tag_pagado_qr: "PAGADO_QR",
  pago_tipo_transferencia: 5, // MT v150 E606: 5 = Transferencia
  tag_pago_verificado: "PAGO_VERIFICADO",
  tolerancia_gs: 0,
};

/** Estados de shopify_pedidos.estado_envio que habilitan la factura (RENDIDO = entregado y plata rendida). */
export function esFacturable(estadoEnvio: string | null | undefined): boolean {
  return estadoEnvio === "ENTREGADO" || estadoEnvio === "RENDIDO";
}
/** Pedido que volvió o se anuló: nunca se factura; si ya tenía factura → cancelación o nota de crédito. */
export function esDevuelto(estadoEnvio: string | null | undefined): boolean {
  return estadoEnvio === "NO_ENTREGADO" || estadoEnvio === "CANCELADO";
}

/**
 * Motivo por el que un pedido NUNCA se factura (null = se puede): cancelado en Shopify o por el cliente,
 * borrador, pedido de prueba (raw.test o etiqueta PRUEBA_E2E). Hallazgo de la revisión G (08-10).
 */
export function motivoNoFacturable(ped: PedidoSifen, cfg: Pick<ConfigDesdePedido, "tag_prueba"> = CONFIG_DESDE_PEDIDO_DEFECTO): string | null {
  const r = obj(ped.raw);
  if (ped.es_borrador) return "borrador";
  if (str(r.cancelled_at)) return "cancelado en Shopify";
  if ((ped.estado_confirmacion ?? "").startsWith("cancelado")) return `cancelado (${ped.estado_confirmacion})`;
  if (r.test === true) return "pedido de prueba (raw.test)";
  if ((ped.tags ?? []).includes(cfg.tag_prueba)) return `pedido de prueba (${cfg.tag_prueba})`;
  return null;
}

/** Fecha/hora local de Asunción "AAAA-MM-DDThh:mm:ss" (dFecEmi, MT v150 campo D002). */
export function fechaSifen(d: Date): string {
  const p = partesAsuncion(d);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.anio}-${z(p.mes)}-${z(p.dia)}T${z(p.hora)}:${z(p.minuto)}:${z(p.segundo)}`;
}

/** dCodSeg: 9 dígitos (MT v150, campo B004). No puede ser 000000000. */
export function codigoSeguridadAleatorio(aleatorio: () => number = Math.random): string {
  let s = "";
  while (!/^\d{9}$/.test(s) || /^0+$/.test(s)) s = String(Math.floor(aleatorio() * 1e9)).padStart(9, "0");
  return s;
}

export function numeroCompletoSifen(est: string, pun: string, numero: number): string {
  return `${est.padStart(3, "0")}-${pun.padStart(3, "0")}-${String(numero).padStart(7, "0")}`;
}

/** Total del ítem cobrado (IVA incluido). */
export function totalItem(i: ItemDE): number {
  return i.cantidad * (i.precioUnitario - (i.descuentoUnitario ?? 0));
}
export function sumaItems(items: ItemDE[]): number {
  return items.reduce((s, i) => s + totalItem(i), 0);
}

// ─── helpers de lectura del raw ──────────────────────────────
type Obj = Record<string, unknown>;
const normalizarTexto = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
const gs = (x: number) => Math.round(x); // guaraníes: sin decimales

function lineasDe(raw: unknown): unknown[] {
  const r = obj(raw);
  if (Array.isArray(r.line_items)) return r.line_items;
  if (Array.isArray(obj(r.lineItems).nodes)) return obj(r.lineItems).nodes as unknown[];
  return [];
}

/** Descuento total de la línea: discount_allocations (línea + pedido) o total_discount. */
function descuentoLinea(o: Obj): number {
  const asig = Array.isArray(o.discount_allocations) ? o.discount_allocations : null;
  if (asig?.length) return asig.reduce((s: number, a) => s + (num(obj(a).amount) ?? 0), 0);
  return num(o.total_discount) ?? 0;
}

/**
 * Ítems de producto. Si el descuento por unidad no da entero en Gs, la línea se parte en dos
 * (n-1 unidades con el descuento entero y 1 con el resto) para que la suma cierre exacto.
 */
export function itemsProducto(raw: unknown, cfg: ConfigDesdePedido): ItemDE[] {
  const out: ItemDE[] = [];
  lineasDe(raw).forEach((l, idx) => {
    const o = obj(l);
    const descripcion = str(o.title) ?? str(o.name);
    const cantidad = num(o.current_quantity) ?? num(o.quantity) ?? 1;
    const precio = num(o.price) ?? num(obj(obj(o.originalUnitPriceSet).shopMoney).amount);
    if (!descripcion || precio === null || cantidad <= 0) return;
    const sku = str(o.sku);
    const codigo = sku ?? cfg.codigos_producto[normalizarTexto(descripcion)] ??
      (o.product_id != null ? cfg.codigos_producto[String(o.product_id)] : undefined) ??
      (o.product_id != null ? `P${o.product_id}` : `V-${idx + 1}`);
    const ivaTasa = (sku && cfg.iva_por_sku[sku] !== undefined) ? cfg.iva_por_sku[sku] : cfg.iva_productos;
    const base: Omit<ItemDE, "cantidad" | "descuentoUnitario"> = {
      codigo,
      descripcion: str(o.variant_title) && o.variant_title !== "Default Title" ? `${descripcion} (${o.variant_title})` : descripcion,
      precioUnitario: gs(precio),
      ivaTasa,
      ivaAfectacion: ivaTasa === 0 ? 3 : 1, // iAfecIVA: 1 gravado, 3 exento (MT v150 E731)
      unidadMedida: cfg.unidad_medida,
    };
    const desc = gs(descuentoLinea(o));
    if (desc <= 0) return void out.push({ ...base, cantidad });
    const porUnidad = Math.floor(desc / cantidad);
    const resto = desc - porUnidad * cantidad;
    if (resto === 0) return void out.push({ ...base, cantidad, descuentoUnitario: porUnidad });
    if (cantidad > 1) out.push({ ...base, cantidad: cantidad - 1, descuentoUnitario: porUnidad });
    out.push({ ...base, cantidad: 1, descuentoUnitario: porUnidad + resto });
  });
  return out;
}

/** Envío cobrado según shipping_lines (precio con descuento si lo hay). */
export function envioCobrado(raw: unknown): number {
  const r = obj(raw);
  const lineas: unknown[] = Array.isArray(r.shipping_lines) ? r.shipping_lines : [];
  return gs(lineas.reduce((s: number, x) => {
    const o = obj(x);
    return s + (num(o.discounted_price) ?? num(o.price) ?? 0);
  }, 0));
}

/** Total que se cobró (lo que se factura). Prioridad: current_total_price → total_price → columna total. */
export function totalCobrado(ped: PedidoSifen): number | null {
  const r = obj(ped.raw);
  const t = num(r.current_total_price) ?? num(r.total_price) ?? num(ped.total);
  return t === null ? null : gs(t);
}

function nombreCliente(raw: unknown): string | null {
  const r = obj(raw);
  const dir = obj(r.shipping_address);
  const cli = obj(r.customer);
  return str(dir.name) ??
    ([str(cli.first_name), str(cli.last_name)].filter(Boolean).join(" ") || null) ??
    str(obj(r.billing_address).name);
}

/** Cédula que dejó el cliente en el formulario (5 a 9 dígitos, puntos opcionales). */
export function cedulaDesdePedido(raw: unknown, claves: string[]): string | null {
  const set = new Set(claves.map((c) => c.toLowerCase()));
  for (const a of atributosPedido(raw)) {
    if (!set.has(a.k.toLowerCase())) continue;
    const limpio = a.v.replace(/[.\s]/g, "");
    if (/^\d{5,9}$/.test(limpio)) return limpio;
  }
  return null;
}

export interface ResumenReceptor {
  receptor: ReceptorDE;
  avisos: string[];
}

/** "no", "ninguna", "-", vacío… = el cliente NO quiere factura con RUC (no es un error). */
const NO_QUIERE = /^(no|n|ninguna?|ninguno|-+|\.|sin factura|no gracias|x|0)$/i;

/**
 * RUC "base-DV" con DV válido (módulo 11) desde texto libre: "1.234.567-9", "1234567 9" o pegado "12345679".
 * Devuelve null si no hay un RUC con DV correcto.
 */
export function rucDesdeTexto(t: string | null | undefined): { ruc: string; dv: string } | null {
  const x = (t ?? "").trim();
  const m = /([\d.]{3,12})\s*[-\s]\s*(\d)(?!\d)/.exec(x);
  const probar = (base: string, dv: string) =>
    /^\d{3,9}$/.test(base) && String(digitoVerificadorRuc(base)) === dv ? { ruc: base, dv } : null;
  // Con guion/espacio explícito, el DV es ESE: si no cierra, es inválido (no se reinterpreta pegado).
  if (m) return probar(m[1].replace(/\./g, ""), m[2]);
  const pegado = /(?:^|\D)(\d[\d.]{3,12}\d)(?!\d)/.exec(x)?.[1]?.replace(/\./g, "");
  if (pegado && pegado.length >= 4) return probar(pegado.slice(0, -1), pegado.slice(-1));
  return null;
}

export interface FiscalPedido {
  pidio: boolean; // escribió algo que no es "no"/vacío
  ruc: { ruc: string; dv: string } | null;
  razonSocial: string | null;
  textoCrudo: string | null;
}

/**
 * Datos fiscales del pedido (revisión G 08-10):
 *   - Releasit: atributos separados `Ruc` y `Razon social`.
 *   - Vendedor IA: atributo `factura` "RUC-DV Nombre" y/o la nota `Factura: …` (pedidos viejos solo en la nota).
 *   "no"/vacío = no quiere factura con RUC.
 */
export function fiscalDesdePedido(raw: unknown, cfg: ConfigDesdePedido): FiscalPedido {
  const attrs = atributosPedido(raw);
  const valor = (claves: string[]) => {
    const set = new Set(claves.map((c) => normalizarTexto(c)));
    const v = attrs.filter((a) => set.has(normalizarTexto(a.k))).map((a) => a.v.trim()).filter((v) => v && !NO_QUIERE.test(v));
    return v.length ? v.join(" ") : null;
  };
  const rucAttr = valor(cfg.claves_ruc);
  const razonAttr = valor(cfg.claves_razon_social);
  if (rucAttr) {
    return { pidio: true, ruc: rucDesdeTexto(rucAttr), razonSocial: razonAttr, textoCrudo: [rucAttr, razonAttr].filter(Boolean).join(" ") };
  }
  const nota = /factura\s*:\s*([^\n]+)/i.exec(String(obj(raw).note ?? ""))?.[1]?.trim() ?? null;
  const combinado = valor(cfg.claves_datos_fiscales) ?? (nota && !NO_QUIERE.test(nota) ? nota : null);
  if (!combinado) return { pidio: false, ruc: null, razonSocial: razonAttr, textoCrudo: null };
  const ruc = rucDesdeTexto(combinado);
  let razon: string | null = razonAttr;
  if (!razon) {
    const m = /[\d.]{3,12}\s*[-\s]?\s*\d(?!\d)/.exec(combinado);
    const resto = m ? combinado.replace(m[0], "") : "";
    razon = resto.replace(/^[\s,;:-]+|[\s,;:-]+$/g, "") || null;
  }
  return { pidio: true, ruc, razonSocial: razon, textoCrudo: combinado };
}

/** Receptor (gDatRec). RUC válido + razón social → 'ruc'; cédula → 'documento'; nada o RUC inválido → 'innominado' + aviso. */
export function receptorDesdePedido(raw: unknown, cfg: ConfigDesdePedido): ResumenReceptor {
  const avisos: string[] = [];
  const f = fiscalDesdePedido(raw, cfg);
  const email = str(obj(raw).email) ?? str(obj(obj(raw).customer).email) ?? undefined;
  if (f.ruc && f.razonSocial) {
    // MT v150: dRucRec sin DV + dDVRec (DV verificado con módulo 11).
    return { receptor: { tipo: "ruc", ruc: f.ruc.ruc, dv: f.ruc.dv, razonSocial: f.razonSocial, pais: "PRY", email }, avisos };
  }
  if (f.pidio) {
    avisos.push(`RUC inválido o sin razón social ("${f.textoCrudo ?? ""}"): se factura como consumidor final.`);
  }
  const ci = cedulaDesdePedido(raw, cfg.claves_documento);
  const nombre = nombreCliente(raw);
  if (ci && nombre) {
    // iTipIDRec 1 = cédula paraguaya (MT v150 D208). [VERIFICAR]
    return { receptor: { tipo: "documento", documentoTipo: 1, documentoNumero: ci, nombre, pais: "PRY", email }, avisos };
  }
  return { receptor: { tipo: "innominado", pais: "PRY", email }, avisos };
}

/**
 * Receptor desde pedido_datos_fiscales: RUC (sin DV o "base-DV") + DV válido (módulo 11) + razón social.
 * Cualquier falla → error (la factura va a 'revisar').
 */
export function receptorDesdeDatosFiscales(df: DatosFiscalesPedido, emailPedido?: string): { ok: true; receptor: ReceptorDE } | { ok: false; motivo: string } {
  const rucTxt = (df.ruc ?? "").trim();
  const dvTxt = (df.dv ?? "").trim();
  const r = rucDesdeTexto(dvTxt ? `${rucTxt.replace(/-\s*\d$/, "")}-${dvTxt}` : rucTxt);
  const razon = (df.razon_social ?? "").trim();
  if (!r) return { ok: false, motivo: `RUC inválido en pedido_datos_fiscales ("${[rucTxt, dvTxt].filter(Boolean).join("-")}")` };
  if (!razon) return { ok: false, motivo: "pedido_datos_fiscales sin razón social" };
  const email = (df.email ?? "").trim() || emailPedido;
  return { ok: true, receptor: { tipo: "ruc", ruc: r.ruc, dv: r.dv, razonSocial: razon, pais: "PRY", email } };
}

export type CondicionPedido = { ok: true; tipo: 1 | 2; plazoDias: number | null } | { ok: false; motivo: string };

/** Condición de la operación: pedido_datos_fiscales; si no hay fila, atributos "condicion"/"plazo_dias"; si no, contado. */
export function condicionDesdePedido(ped: Pick<PedidoSifen, "raw" | "datos_fiscales">, cfg: ConfigDesdePedido): CondicionPedido {
  let cond: string | null = null;
  let plazo: unknown = null;
  if (ped.datos_fiscales) {
    cond = ped.datos_fiscales.condicion ?? "contado";
    plazo = ped.datos_fiscales.plazo_dias ?? null;
  } else {
    const attrs = atributosPedido(ped.raw);
    const valor = (claves: string[]) => {
      const set = new Set(claves.map((c) => normalizarTexto(c)));
      return attrs.find((a) => set.has(normalizarTexto(a.k)) && a.v.trim())?.v.trim() ?? null;
    };
    cond = valor(cfg.claves_condicion);
    plazo = valor(cfg.claves_plazo);
  }
  const c = normalizarTexto(cond ?? "contado");
  if (c === "contado" || c === "") return { ok: true, tipo: 1, plazoDias: null };
  if (c !== "credito") return { ok: false, motivo: `condición desconocida ("${cond}"): contado o credito` };
  const n = num(plazo);
  if (n === null || !Number.isInteger(n) || n < 1 || n > cfg.plazo_maximo_dias) {
    return { ok: false, motivo: `crédito sin plazo válido (plazo_dias "${plazo ?? ""}", 1 a ${cfg.plazo_maximo_dias})` };
  }
  return { ok: true, tipo: 2, plazoDias: n };
}

export interface BaseDocumento {
  numero: number;
  fechaEmision: string; // fechaSifen(...)
  codigoSeguridad: string;
  tipoEmision?: TipoEmision;
}

export type ResultadoDesdePedido =
  | { ok: true; doc: DocumentoDE; avisos: string[]; total: number }
  | { ok: false; motivo: string; avisos: string[] };

/** Arma la factura electrónica (tipo 1) de un pedido. No inventa nada: si algo no cierra, ok:false. */
export function documentoDesdePedido(ped: PedidoSifen, cfg: ConfigDesdePedido, base: BaseDocumento): ResultadoDesdePedido {
  const avisos: string[] = [];
  const total = totalCobrado(ped);
  if (total === null || total <= 0) return { ok: false, motivo: "el pedido no tiene total cobrado", avisos };
  const r0 = obj(ped.raw);
  // Shopify sumó IVA encima del precio (taxes_included=false y total_tax>0, pasó en #1008): no se emite.
  if (r0.taxes_included === false && (num(r0.total_tax) ?? 0) > 0) {
    return { ok: false, motivo: `Shopify sumó impuestos encima del precio (total_tax ${num(r0.total_tax)}, taxes_included=false)`, avisos };
  }
  const items = itemsProducto(ped.raw, cfg);
  if (!items.length) return { ok: false, motivo: "el pedido no tiene ítems con precio", avisos };

  // Envío como ítem aparte.
  if (cfg.envio_modo === "linea_shopify") {
    const envio = envioCobrado(ped.raw);
    if (envio > 0) items.push(itemEnvio(envio, cfg));
  } else if (cfg.envio_modo === "separar_del_total" && envioCobrado(ped.raw) === 0) {
    // Precio todo-incluido: se separa el envío como descuento del ítem de mayor total.
    const i = items.reduce((m, x, k) => (totalItem(x) > totalItem(items[m]) ? k : m), 0);
    const it = items[i];
    if (totalItem(it) <= cfg.envio_gs || cfg.envio_gs % it.cantidad !== 0) {
      return { ok: false, motivo: `no se pudo separar el envío (${cfg.envio_gs}) de "${it.descripcion}"`, avisos };
    }
    items[i] = { ...it, descuentoUnitario: (it.descuentoUnitario ?? 0) + cfg.envio_gs / it.cantidad };
    items.push(itemEnvio(cfg.envio_gs, cfg));
  } else if (cfg.envio_modo === "separar_del_total") {
    items.push(itemEnvio(envioCobrado(ped.raw), cfg));
  }

  for (const i of items) {
    if (!Number.isInteger(i.precioUnitario) || !Number.isInteger(i.descuentoUnitario ?? 0)) {
      return { ok: false, motivo: `montos con decimales en "${i.descripcion}"`, avisos };
    }
    if (totalItem(i) < 0) return { ok: false, motivo: `ítem con total negativo: "${i.descripcion}"`, avisos };
  }
  const suma = sumaItems(items);
  if (Math.abs(suma - total) > cfg.tolerancia_gs) {
    return { ok: false, motivo: `la suma de ítems (${suma}) no coincide con el total cobrado (${total})`, avisos };
  }

  let rec: ResumenReceptor;
  if (ped.datos_fiscales) {
    // Fila en pedido_datos_fiscales: manda sobre los atributos; si no cierra, a 'revisar' (nunca consumidor final).
    const emailPedido = str(r0.email) ?? str(obj(r0.customer).email) ?? undefined;
    const rf = receptorDesdeDatosFiscales(ped.datos_fiscales, emailPedido);
    if (!rf.ok) return { ok: false, motivo: rf.motivo, avisos };
    rec = { receptor: rf.receptor, avisos: [] };
  } else {
    rec = receptorDesdePedido(ped.raw, cfg);
  }
  avisos.push(...rec.avisos);
  const cond = condicionDesdePedido(ped, cfg);
  if (!cond.ok) return { ok: false, motivo: cond.motivo, avisos };
  if (cond.tipo === 2 && rec.receptor.tipo === "innominado") {
    return { ok: false, motivo: "venta a crédito a consumidor final sin identificar: cargar RUC en datos fiscales", avisos };
  }
  if (rec.receptor.tipo === "innominado" && cfg.monto_identificar_consumidor !== null && total >= cfg.monto_identificar_consumidor) {
    return {
      ok: false,
      motivo: `consumidor final sin identificar por Gs ${total} (tope configurado Gs ${cfg.monto_identificar_consumidor})`,
      avisos,
    };
  }

  const tipoPago = tipoPagoPedido(ped.tags ?? [], cfg);
  // gCamCond: contado → gPaConEIni con la forma de pago (E605-E606); crédito → gPagCred plazo (E640-E643), sin entrega inicial.
  const condicion: CondicionConPlazo = cond.tipo === 1
    ? { tipo: 1, pagos: [{ tipo: tipoPago, monto: total }] }
    : { tipo: 2, pagos: [], plazoCredito: `${cond.plazoDias} días` };
  const doc: DocumentoDE = {
    tipo: 1,
    establecimiento: cfg.establecimiento,
    punto: cfg.punto,
    numero: base.numero,
    fechaEmision: base.fechaEmision,
    tipoEmision: base.tipoEmision ?? 1,
    codigoSeguridad: base.codigoSeguridad,
    receptor: rec.receptor,
    items,
    moneda: "PYG",
    condicion,
    shopifyOrderId: ped.shopify_order_id,
    observacion: `Pedido ${ped.nombre ?? ped.shopify_order_id}`,
  };
  return { ok: true, doc, avisos, total };
}

/**
 * iTiPago del pedido según sus etiquetas. PAGADO_QR (lo pone pago-qr-webhook) gana sobre PAGO_VERIFICADO (lo pone
 * telegram-webhook cuando Enrique verifica la transferencia en ueno). Sin etiqueta: efectivo (cobro contra entrega).
 */
export function tipoPagoPedido(tags: string[], cfg: Pick<ConfigDesdePedido, "tag_pagado_qr" | "pago_tipo_qr" | "tag_pago_verificado" | "pago_tipo_transferencia" | "pago_tipo_efectivo">): number {
  if (tags.includes(cfg.tag_pagado_qr)) return cfg.pago_tipo_qr;
  if (tags.includes(cfg.tag_pago_verificado)) return cfg.pago_tipo_transferencia;
  return cfg.pago_tipo_efectivo;
}

function itemEnvio(monto: number, cfg: ConfigDesdePedido): ItemDE {
  return {
    codigo: cfg.envio_codigo,
    descripcion: cfg.envio_descripcion,
    cantidad: 1,
    precioUnitario: monto,
    ivaTasa: cfg.envio_iva,
    ivaAfectacion: cfg.envio_iva === 0 ? 3 : 1,
    unidadMedida: cfg.unidad_medida,
  };
}

/**
 * Nota de crédito (tipo 5) por el TOTAL de una factura, asociada por CDC.
 * MT v150: gCamNCDE.iMotEmi 2 = "Devolución" [VERIFICAR tabla]; gCamDEAsoc.iTipDocAso 1 = electrónico + dCdCDERef.
 * La NC no lleva gCamCond (condición de la operación).
 */
export function notaCreditoDesdeFactura(fe: DocumentoDE, cdcOriginal: string, base: BaseDocumento, motivoNota = 2): DocumentoDE {
  return {
    tipo: 5,
    establecimiento: fe.establecimiento,
    punto: fe.punto,
    numero: base.numero,
    fechaEmision: base.fechaEmision,
    tipoEmision: base.tipoEmision ?? 1,
    codigoSeguridad: base.codigoSeguridad,
    receptor: fe.receptor,
    items: fe.items,
    moneda: "PYG",
    asociado: { tipo: 1, cdc: cdcOriginal },
    motivoNota,
    shopifyOrderId: fe.shopifyOrderId,
    observacion: `Devolución ${fe.observacion ?? ""}`.trim(),
  };
}
