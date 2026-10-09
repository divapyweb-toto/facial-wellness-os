// LEGADO (ola 4, FacturaSend directo). Desde 08-10-2026 NO se usa en producción: factura/io.ts delega en la
// cola SIFEN (_shared/sifen/cola.ts vía sifen-cola/io.ts), que trabaja con el esquema nuevo de `facturas`
// (migración 20261008000010). Se conserva con sus tests como referencia; se puede borrar cuando SIFEN esté en prod.
// factura · lógica pura (sin red ni base). Todo el I/O entra por `DepsFactura`.
//
// Cuándo factura: pedido de Voltra con estado_envio ENTREGADO, bandera config_wa['ola4.factura'].activo = true.
// Idempotente: una sola factura por pedido (facturas.shopify_order_id unique + tomar_factura en SQL).
// Casos a revisar (no se emite, avisa a Telegram): RUC con dígito verificador incorrecto o sin razón social,
// o suma de ítems distinta del total cobrado.

import {
  type ConfigFactura,
  CONFIG_FACTURA_DEFECTO,
  type DatosFiscales,
  datosFiscalesDesdePedido,
  type ItemFactura,
  itemsDesdePedido,
  type PedidoFactura,
  type ResultadoFactura,
  totalItems,
} from "../_shared/facturacion.ts";

export interface ConfigOla4Factura extends ConfigFactura {
  activo: boolean;
  numero_inicial: number;
  claves_datos_fiscales: string[];
  maximo_intentos: number;
  tolerancia_gs: number;
  tag_pagado_qr: string;
  plantilla_seguimiento: string;
}

export const CONFIG_OLA4_FACTURA_DEFECTO: ConfigOla4Factura = {
  ...CONFIG_FACTURA_DEFECTO,
  activo: false,
  numero_inicial: 1,
  claves_datos_fiscales: ["factura", "ruc", "datos de factura", "ruc y razon social", "razon social", "razón social"],
  maximo_intentos: 3,
  tolerancia_gs: 1,
  tag_pagado_qr: "PAGADO_QR",
  plantilla_seguimiento: "voltra_seguimiento_factura",
};

export function configFactura(valor: unknown): ConfigOla4Factura {
  const v = valor && typeof valor === "object" ? valor as Partial<ConfigOla4Factura> : {};
  return { ...CONFIG_OLA4_FACTURA_DEFECTO, ...v, activo: v.activo === true };
}

export interface PedidoGuardado {
  shopify_order_id: number;
  nombre: string | null;
  total: number | null;
  estado_envio: string | null;
  tags: string[];
  raw: unknown;
  entregado_en?: string | null;
}

export interface FilaFactura {
  shopify_order_id: number;
  estado: "revisar" | "emitiendo" | "emitida" | "error";
  numero?: number | null;
  numero_completo?: string | null;
  tipo?: "consumidor_final" | "ruc" | null;
  ruc?: string | null;
  razon_social?: string | null;
  cdc?: string | null;
  pdf_url?: string | null;
  pdf_path?: string | null;
  simulado?: boolean;
  error?: string | null;
  intentos?: number;
}

export interface Toma {
  numero: number;
  tomada: boolean;
  estado: string;
  intentos: number;
}

export interface DepsFactura {
  ahora(): Date;
  config(): Promise<ConfigOla4Factura>;
  leerPedido(id: number): Promise<PedidoGuardado | null>;
  leerFactura(id: number): Promise<FilaFactura | null>;
  /** SQL tomar_factura: reserva número correlativo y bloquea la fila (lease). */
  tomar(id: number, numeroInicial: number): Promise<Toma>;
  guardar(f: FilaFactura): Promise<void>;
  emitir(p: PedidoFactura, d: DatosFiscales, cfg: ConfigFactura): Promise<ResultadoFactura>;
  avisar(textoHtml: string): Promise<unknown>;
  escapar(s: unknown): string;
}

export type AccionFactura =
  | "bandera_apagada"
  | "sin_pedido"
  | "no_entregado"
  | "ya_emitida"
  | "en_curso"
  | "revisar"
  | "emitida"
  | "error"
  | "max_intentos";

export interface ResultadoFacturar {
  orderId: number;
  accion: AccionFactura;
  numero_completo?: string;
  cdc?: string;
  pdf_url?: string;
  simulado?: boolean;
  error?: string;
}

/** Valida y arma los datos de la factura sin I/O. */
export function prepararFactura(
  ped: PedidoGuardado,
  cfg: ConfigOla4Factura,
): { ok: true; items: ItemFactura[]; datos: DatosFiscales; tipo: "ruc" | "consumidor_final" } | { ok: false; motivo: string; datos?: DatosFiscales } {
  const fiscal = datosFiscalesDesdePedido(ped.raw, cfg.claves_datos_fiscales);
  if (fiscal.pidioRuc && !fiscal.rucValido) {
    return { ok: false, motivo: `RUC inválido o sin razón social: "${fiscal.textoCrudo ?? ""}"`, datos: fiscal.datos };
  }
  const items = itemsDesdePedido(ped.raw);
  if (!items.length) return { ok: false, motivo: "el pedido no tiene ítems con precio" };
  const total = Number(ped.total ?? NaN);
  const suma = totalItems(items);
  if (!Number.isFinite(total) || Math.abs(suma - total) > cfg.tolerancia_gs) {
    return { ok: false, motivo: `la suma de ítems (${suma}) no coincide con el total (${ped.total})` };
  }
  return { ok: true, items, datos: fiscal.datos, tipo: fiscal.rucValido ? "ruc" : "consumidor_final" };
}

export async function facturarPedido(orderId: number, deps: DepsFactura): Promise<ResultadoFacturar> {
  const cfg = await deps.config();
  if (!cfg.activo) return { orderId, accion: "bandera_apagada" };

  const previa = await deps.leerFactura(orderId);
  if (previa?.estado === "emitida") {
    return { orderId, accion: "ya_emitida", numero_completo: previa.numero_completo ?? undefined, cdc: previa.cdc ?? undefined, pdf_url: previa.pdf_url ?? undefined };
  }
  if (previa && (previa.intentos ?? 0) >= cfg.maximo_intentos) return { orderId, accion: "max_intentos", error: previa.error ?? undefined };

  const ped = await deps.leerPedido(orderId);
  if (!ped) return { orderId, accion: "sin_pedido" };
  if (ped.estado_envio !== "ENTREGADO") return { orderId, accion: "no_entregado" };

  const prep = prepararFactura(ped, cfg);
  const nombre = deps.escapar(ped.nombre ?? orderId);
  if (!prep.ok) {
    if (previa?.estado !== "revisar") {
      await deps.guardar({ shopify_order_id: orderId, estado: "revisar", ruc: prep.datos?.ruc ?? null, razon_social: prep.datos?.razonSocial ?? null, error: prep.motivo });
      await deps.avisar(`<b>Factura a revisar</b> · pedido ${nombre}\n${deps.escapar(prep.motivo)}\nNo se emitió nada.`);
    }
    return { orderId, accion: "revisar", error: prep.motivo };
  }

  const toma = await deps.tomar(orderId, cfg.numero_inicial);
  if (!toma.tomada) return { orderId, accion: toma.estado === "emitida" ? "ya_emitida" : "en_curso" };

  const pedidoFactura: PedidoFactura = {
    shopify_order_id: orderId,
    nombre: ped.nombre,
    numero: toma.numero,
    fecha: deps.ahora(),
    items: prep.items,
    total: Number(ped.total),
    pagadoPorQR: ped.tags.includes(cfg.tag_pagado_qr),
  };
  const r = await deps.emitir(pedidoFactura, prep.datos, cfg);
  const base = {
    shopify_order_id: orderId,
    numero: toma.numero,
    tipo: prep.tipo,
    ruc: prep.datos.ruc ?? null,
    razon_social: prep.datos.razonSocial ?? null,
    simulado: r.simulado,
  } as const;
  if (!r.ok) {
    await deps.guardar({ ...base, estado: "error", error: r.error ?? "error" });
    if (toma.intentos >= cfg.maximo_intentos) {
      await deps.avisar(`<b>Factura falló ${toma.intentos} veces</b> · pedido ${nombre}\n${deps.escapar(r.error ?? "")}`);
    }
    return { orderId, accion: "error", error: r.error };
  }
  await deps.guardar({
    ...base,
    estado: "emitida",
    numero_completo: r.numero_completo ?? null,
    cdc: r.cdc ?? null,
    pdf_url: r.pdf_url ?? null,
    pdf_path: r.pdf_path ?? null,
    error: r.error ?? null,
  });
  return { orderId, accion: "emitida", numero_completo: r.numero_completo, cdc: r.cdc, pdf_url: r.pdf_url, simulado: r.simulado, error: r.error };
}
