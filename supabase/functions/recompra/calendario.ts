// recompra · lógica pura del calendario y de los topes (sin red ni base de datos).
// Fuente: docs/Voltra_WhatsApp_venta_postventa_recompra.md, "Recompra con bolsas de 30 unidades".
//
//   D  = unidades_por_bolsa × bolsas ÷ unidades_por_noche          (duración de lo que compró)
//   M1 = min(pct_m1 · D, D − margen_dias_m1)   días desde entregado_en (redondeo hacia abajo)
//   M2 = D ÷ factor_uso_real − 3                solo si no recompró   (redondeo hacia abajo)
//   Compra única (raspador, botella, ejercitador): venta cruzada el día 14 con el producto afín.
//
// Productos, tipo (consumible / pack / única), unidades por bolsa, afinidades, ofertas y precios
// salen de config_wa.recompra (supabase/seed_recompra.sql), nunca de este archivo.

import { partesAsuncion } from "../_shared/horario.ts";

export type TipoPlan = "M1" | "M2" | "CRUZADA" | "LANZAMIENTO";
export type TipoProducto = "consumible" | "pack" | "unico";

export interface ProductoCfg {
  clave: string;
  /** Cómo se nombra en el mensaje ("tiras nasales"). */
  nombre: string;
  /** Subcadenas (sin tildes, minúsculas) que identifican la línea del pedido. */
  patrones: string[];
  tipo: TipoProducto;
  unidades_por_bolsa?: number;
  /** Clave del producto que se ofrece en venta cruzada / lanzamientos. */
  afin?: string;
  /** Pack: claves que contiene (si compró el pack, ya "tiene" esos productos). */
  contiene?: string[];
}

export interface Oferta {
  plantilla: string;
  oferta: string;
  precio: number;
}

export interface TopesCfg {
  por_mes: number;
  por_semana_dias: number;
  sin_leer_para_bajar: number;
  por_mes_reducido: number;
  dias_sin_leer_fuera: number;
}

export interface RecompraCfg {
  unidades_por_noche: number;
  factor_uso_real: number;
  pct_m1: number;
  margen_dias_m1: number;
  resta_m2: number;
  dia_cruzada: number;
  hora_envio: number;
  /** No se crean avisos cuyo día ya pasó hace más de esto (arranque con entregas viejas). */
  dias_gracia: number;
  /** Solo se miran entregas de los últimos N días. */
  ventana_dias: number;
  nombre_si_falta: string;
  productos: ProductoCfg[];
  /** ofertas[clave de producto o tipo]["1"|"2"|"3"][M1|M2]. "3" vale para 3 o más bolsas. */
  ofertas: Record<string, Record<string, Partial<Record<"M1" | "M2", Oferta>>>>;
  cruzada: { plantilla: string; precio: number };
  lanzamiento: { plantilla: string };
  topes: TopesCfg;
  palabras_baja: string[];
}

// Valores de reserva si falta config_wa.recompra: solo la mecánica, SIN productos ni precios
// (sin la semilla no se planifica nada; así nunca sale un precio que no está en la base).
export const CFG_DEFECTO: RecompraCfg = {
  unidades_por_noche: 1,
  factor_uso_real: 0.8,
  pct_m1: 0.85,
  margen_dias_m1: 7,
  resta_m2: 3,
  dia_cruzada: 14,
  hora_envio: 9,
  dias_gracia: 3,
  ventana_dias: 200,
  nombre_si_falta: "de nuevo",
  productos: [],
  ofertas: {},
  cruzada: { plantilla: "voltra_mk_cruzada", precio: 0 },
  lanzamiento: { plantilla: "voltra_mk_lanzamiento" },
  topes: { por_mes: 3, por_semana_dias: 7, sin_leer_para_bajar: 2, por_mes_reducido: 1, dias_sin_leer_fuera: 60 },
  palabras_baja: ["baja", "no quiero ofertas"],
};

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {});
const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);

/** Arma la config desde config_wa.recompra (lo que falte queda en el valor de reserva). */
export function configDesdeValor(valor: unknown): RecompraCfg {
  const v = obj(valor);
  const t = obj(v.topes);
  const c = { ...CFG_DEFECTO };
  for (
    const k of [
      "unidades_por_noche",
      "factor_uso_real",
      "pct_m1",
      "margen_dias_m1",
      "resta_m2",
      "dia_cruzada",
      "hora_envio",
      "dias_gracia",
      "ventana_dias",
    ] as const
  ) {
    c[k] = num(v[k], CFG_DEFECTO[k]);
  }
  if (typeof v.nombre_si_falta === "string") c.nombre_si_falta = v.nombre_si_falta;
  if (Array.isArray(v.productos)) c.productos = v.productos as ProductoCfg[];
  if (v.ofertas && typeof v.ofertas === "object") c.ofertas = v.ofertas as RecompraCfg["ofertas"];
  const cr = obj(v.cruzada);
  c.cruzada = { plantilla: String(cr.plantilla ?? CFG_DEFECTO.cruzada.plantilla), precio: num(cr.precio, 0) };
  const lz = obj(v.lanzamiento);
  c.lanzamiento = { plantilla: String(lz.plantilla ?? CFG_DEFECTO.lanzamiento.plantilla) };
  const d = CFG_DEFECTO.topes;
  c.topes = {
    por_mes: num(t.por_mes, d.por_mes),
    por_semana_dias: num(t.por_semana_dias, d.por_semana_dias),
    sin_leer_para_bajar: num(t.sin_leer_para_bajar, d.sin_leer_para_bajar),
    por_mes_reducido: num(t.por_mes_reducido, d.por_mes_reducido),
    dias_sin_leer_fuera: num(t.dias_sin_leer_fuera, d.dias_sin_leer_fuera),
  };
  if (Array.isArray(v.palabras_baja)) c.palabras_baja = (v.palabras_baja as unknown[]).map(String);
  return c;
}

// ─── Fechas (día local de Asunción) ───

/** 'YYYY-MM-DD' de Asunción del instante + n días. */
export function diaLocalMas(d: Date, n: number): string {
  const p = partesAsuncion(d);
  const x = new Date(Date.UTC(p.anio, p.mes - 1, p.dia + n));
  return x.toISOString().slice(0, 10);
}

/** Instante real de las `hora`:00 locales de Asunción del día 'YYYY-MM-DD'. */
export function instanteLocal(diaISO: string, hora: number): Date {
  const [a, m, d] = diaISO.split("-").map(Number);
  const guess = Date.UTC(a, m - 1, d, hora);
  const p = partesAsuncion(new Date(guess));
  const comoUTC = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return new Date(guess - (comoUTC - guess));
}

export function diasEntre(desdeISO: string, hastaISO: string): number {
  return Math.round((Date.parse(hastaISO) - Date.parse(desdeISO)) / 86_400_000);
}

// ─── Productos ───

export const normalizar = (s: string) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Producto de una línea del pedido por sus patrones (gana el primero de la lista de config). */
export function clasificar(titulo: string, productos: ProductoCfg[]): ProductoCfg | null {
  const t = normalizar(titulo);
  if (!t) return null;
  return productos.find((p) => p.patrones.some((x) => t.includes(normalizar(x)))) ?? null;
}

export interface LineaPedido {
  titulo: string;
  cantidad: number;
}

/** Líneas desde shopify_pedidos.raw (REST line_items o GraphQL lineItems.nodes / edges). */
export function lineasDesdeRaw(raw: unknown): LineaPedido[] {
  const r = obj(raw);
  const li = obj(r.lineItems);
  const items: unknown[] = Array.isArray(r.line_items)
    ? r.line_items
    : Array.isArray(li.nodes)
    ? li.nodes as unknown[]
    : Array.isArray(li.edges)
    ? (li.edges as unknown[]).map((e) => obj(e).node)
    : [];
  return items.map((i) => {
    const it = obj(i);
    return { titulo: String(it.title ?? it.name ?? ""), cantidad: Math.max(1, Number(it.quantity ?? 1) || 1) };
  }).filter((l) => l.titulo);
}

/** Bolsas por producto clasificado en un pedido. */
export function bolsasPorProducto(lineas: LineaPedido[], productos: ProductoCfg[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lineas) {
    const p = clasificar(l.titulo, productos);
    if (p) m.set(p.clave, (m.get(p.clave) ?? 0) + l.cantidad);
  }
  return m;
}

/** Claves que el cliente "tiene" con ese pedido (un pack cuenta también sus contenidos). */
export function clavesQueTiene(lineas: LineaPedido[], productos: ProductoCfg[]): Set<string> {
  const s = new Set<string>();
  for (const clave of bolsasPorProducto(lineas, productos).keys()) {
    s.add(clave);
    for (const c of productos.find((p) => p.clave === clave)?.contiene ?? []) s.add(c);
  }
  return s;
}

// ─── Calendario ───

export function duracionDias(bolsas: number, p: ProductoCfg, cfg: RecompraCfg): number {
  return ((p.unidades_por_bolsa ?? 30) * bolsas) / cfg.unidades_por_noche;
}
export function diaM1(D: number, cfg: RecompraCfg): number {
  return Math.floor(Math.min(cfg.pct_m1 * D, D - cfg.margen_dias_m1));
}
export function diaM2(D: number, cfg: RecompraCfg): number {
  return Math.floor(D / cfg.factor_uso_real - cfg.resta_m2);
}

export function ofertaPara(p: ProductoCfg, bolsas: number, tipo: "M1" | "M2", cfg: RecompraCfg): Oferta | null {
  const tabla = cfg.ofertas[p.clave] ?? cfg.ofertas[p.tipo];
  if (!tabla) return null;
  const claves = Object.keys(tabla).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  if (!claves.length) return null;
  const k = claves.filter((n) => n <= bolsas).pop() ?? claves[0];
  return tabla[String(k)]?.[tipo] ?? null;
}

export interface PedidoEntregado {
  shopify_order_id: number;
  cliente_id: string;
  nombre_cliente: string | null;
  entregado_en: Date;
  lineas: LineaPedido[];
}

export interface ItemPlan {
  cliente_id: string;
  shopify_order_id: number;
  tipo: TipoPlan;
  producto_clave: string;
  dia: number;
  dia_objetivo: string;
  plantilla: string;
  /** Posicionales, en el orden {{1}}, {{2}}, ... de la plantilla. */
  variables: (string | number)[];
  clave_unica: string;
}

export function primerNombre(n: string | null, cfg: RecompraCfg): string {
  const x = (n ?? "").trim().split(/\s+/)[0];
  return x || cfg.nombre_si_falta;
}

/**
 * Plan de un pedido entregado. Si trae varios consumibles, manda el que se termina antes
 * (un aviso por pedido; los topes no dejarían salir dos en la misma semana de todos modos).
 * La venta cruzada sale solo para compra única y si el producto afín no vino en el mismo pedido.
 */
export function calcularPlan(p: PedidoEntregado, cfg: RecompraCfg): ItemPlan[] {
  const bolsas = bolsasPorProducto(p.lineas, cfg.productos);
  const tiene = clavesQueTiene(p.lineas, cfg.productos);
  const nombre = primerNombre(p.nombre_cliente, cfg);
  const base = { cliente_id: p.cliente_id, shopify_order_id: p.shopify_order_id };
  const out: ItemPlan[] = [];

  let principal: { prod: ProductoCfg; b: number; D: number } | null = null;
  for (const [clave, b] of bolsas) {
    const prod = cfg.productos.find((x) => x.clave === clave)!;
    if (prod.tipo === "unico") continue;
    const D = duracionDias(b, prod, cfg);
    if (!principal || D < principal.D) principal = { prod, b, D };
  }
  if (principal) {
    const { prod, b, D } = principal;
    for (const tipo of ["M1", "M2"] as const) {
      const of = ofertaPara(prod, b, tipo, cfg);
      if (!of) continue;
      const dia = tipo === "M1" ? diaM1(D, cfg) : diaM2(D, cfg);
      out.push({
        ...base,
        tipo,
        producto_clave: prod.clave,
        dia,
        dia_objetivo: diaLocalMas(p.entregado_en, dia),
        plantilla: of.plantilla,
        variables: [nombre, prod.nombre, of.oferta, of.precio],
        clave_unica: `rc:${p.shopify_order_id}:${tipo}`,
      });
    }
  }

  for (const clave of bolsas.keys()) {
    const prod = cfg.productos.find((x) => x.clave === clave)!;
    if (prod.tipo !== "unico" || !prod.afin || tiene.has(prod.afin)) continue;
    const afin = cfg.productos.find((x) => x.clave === prod.afin);
    if (!afin || !(cfg.cruzada.precio > 0)) continue;
    out.push({
      ...base,
      tipo: "CRUZADA",
      producto_clave: afin.clave,
      dia: cfg.dia_cruzada,
      dia_objetivo: diaLocalMas(p.entregado_en, cfg.dia_cruzada),
      plantilla: cfg.cruzada.plantilla,
      variables: [nombre, prod.nombre, afin.nombre, cfg.cruzada.precio],
      clave_unica: `rc:${p.shopify_order_id}:CRUZADA`,
    });
    break; // una sola venta cruzada por pedido
  }
  return out;
}

/** Lanzamiento: un aviso por cliente del segmento afín (cuenta dentro de los topes). */
export function planLanzamiento(
  l: {
    clave: string;
    nombre: string;
    precio_cliente: number;
    fecha_hasta: string;
    dia_objetivo: string;
    segmento: string[];
  },
  clientes: { cliente_id: string; shopify_order_id: number; tiene: Set<string> }[],
  cfg: RecompraCfg,
): ItemPlan[] {
  return clientes
    .filter((c) => !c.tiene.has(l.clave) && l.segmento.some((s) => c.tiene.has(s)))
    .map((c) => ({
      cliente_id: c.cliente_id,
      shopify_order_id: c.shopify_order_id,
      tipo: "LANZAMIENTO" as const,
      producto_clave: l.clave,
      dia: 0,
      dia_objetivo: l.dia_objetivo,
      plantilla: cfg.lanzamiento.plantilla,
      variables: [l.nombre, l.precio_cliente, l.fecha_hasta],
      clave_unica: `lz:${l.clave}:${c.cliente_id}`,
    }));
}

/** ¿Hizo otro pedido (no cancelado) del mismo producto después de la entrega de origen? */
export function recompro(
  origen: { shopify_order_id: number; entregado_en: Date },
  producto: string,
  pedidosCliente: { shopify_order_id: number; creado_en: Date; cancelado: boolean; tiene: Set<string> }[],
): boolean {
  return pedidosCliente.some((x) =>
    x.shopify_order_id !== origen.shopify_order_id && !x.cancelado &&
    x.creado_en.getTime() > origen.entregado_en.getTime() && x.tiene.has(producto)
  );
}

// ─── Topes por cliente ───

export interface MensajeMk {
  enviado_en: Date;
  leido: boolean;
}

export type DecisionTope =
  | { ok: true; sin_leer_seguidos: number; enviados_mes: number }
  | { ok: false; motivo: string; fuera: true }
  | { ok: false; motivo: string; fuera: false; desde: string };

/** Lo que bloquea es lo ya enviado o en cola (pendiente) de marketing, de cualquier tipo. */
export function evaluarTope(
  consentimiento: "si" | "no" | "baja" | null,
  mensajes: MensajeMk[],
  enCola: Date[],
  hoyISO: string,
  ahora: Date,
  cfg: RecompraCfg,
): DecisionTope {
  if (consentimiento !== "si") {
    return { ok: false, fuera: true, motivo: `sin_consentimiento:${consentimiento ?? "ninguno"}` };
  }
  const t = cfg.topes;
  const orden = [...mensajes].sort((a, b) => b.enviado_en.getTime() - a.enviado_en.getTime());
  let sinLeer = 0;
  for (const m of orden) {
    if (m.leido) break;
    sinLeer++;
  }
  if (sinLeer > 0) {
    const ultimaLectura = orden.find((m) => m.leido)?.enviado_en ?? null;
    const primeroSinLeer = orden[sinLeer - 1].enviado_en;
    const dias = (ahora.getTime() - primeroSinLeer.getTime()) / 86_400_000;
    const diasLect = ultimaLectura ? (ahora.getTime() - ultimaLectura.getTime()) / 86_400_000 : Infinity;
    if (dias >= t.dias_sin_leer_fuera && diasLect >= t.dias_sin_leer_fuera) {
      return { ok: false, fuera: true, motivo: `sin_leer_${t.dias_sin_leer_fuera}_dias` };
    }
  }
  const todos = [...orden.map((m) => m.enviado_en), ...enCola];
  // semana: nada en los últimos N días (incluye lo que está en cola)
  const ultimo = todos.reduce<Date | null>((a, b) => (!a || b > a ? b : a), null);
  if (ultimo) {
    const libre = diaLocalMas(ultimo, t.por_semana_dias);
    if (libre > hoyISO) return { ok: false, fuera: false, motivo: "tope_semana", desde: libre };
  }
  // mes calendario de Asunción
  const mes = hoyISO.slice(0, 7);
  const enviadosMes = todos.filter((d) => diaLocalMas(d, 0).slice(0, 7) === mes).length;
  const limite = sinLeer >= t.sin_leer_para_bajar ? t.por_mes_reducido : t.por_mes;
  if (enviadosMes >= limite) {
    const [a, m] = mes.split("-").map(Number);
    const proximo = new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 10);
    return {
      ok: false,
      fuera: false,
      motivo: limite === t.por_mes ? "tope_mes" : "tope_mes_reducido_sin_leer",
      desde: proximo,
    };
  }
  return { ok: true, sin_leer_seguidos: sinLeer, enviados_mes: enviadosMes };
}

/** ¿El texto entrante pide la baja? ("BAJA", "No quiero ofertas"; lista en config_wa.recompra). */
export function esPedidoDeBaja(texto: string, palabras = CFG_DEFECTO.palabras_baja): boolean {
  const t = normalizar(texto).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  return palabras.some((p) => t === normalizar(p).trim());
}

/** Definición de las plantillas de marketing para sumar a PLANTILLAS de procesar-envios (integración). */
export const PLANTILLAS_RECOMPRA: Record<string, { vars: string[]; botones: { prefijo: string; titulo: string }[] }> = {
  voltra_mk_reposicion: {
    vars: ["nombre", "producto", "oferta", "precio"],
    botones: [
      { prefijo: "mk_si", titulo: "Sí, mandame" },
      { prefijo: "mk_luego", titulo: "Más adelante" },
      { prefijo: "mk_baja", titulo: "No quiero ofertas" },
    ],
  },
  voltra_mk_pack: {
    vars: ["nombre", "producto", "oferta", "precio"],
    botones: [
      { prefijo: "mk_pack", titulo: "Quiero el pack" },
      { prefijo: "mk_una", titulo: "Solo 1 bolsa" },
      { prefijo: "mk_baja", titulo: "No quiero ofertas" },
    ],
  },
  voltra_mk_cruzada: {
    vars: ["nombre", "producto_comprado", "producto_afin", "precio"],
    botones: [{ prefijo: "mk_quiero", titulo: "Lo quiero" }, { prefijo: "mk_baja", titulo: "No quiero ofertas" }],
  },
  voltra_mk_lanzamiento: {
    vars: ["producto_nuevo", "precio_cliente", "fecha"],
    botones: [{ prefijo: "mk_quiero", titulo: "Lo quiero" }, { prefijo: "mk_baja", titulo: "No quiero ofertas" }],
  },
};
