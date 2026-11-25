// _shared/proveedores/io.ts · 21-11 · Lecturas y escrituras del agente de proveedores (lo usan WhatsApp y Gmail).
// Tablas pi_* (migraciones 20261119000001/2 y 20261124000001). Cliente de base y aviso inyectables para las pruebas.
// Entrantes: estado 'RECEIVED', direccion 'in', autor 'proveedor', politica_id null (la base lo permite solo para 'in').
// Salientes: politica_id del permiso general + candidato_id (el freno de la base lo exige para AUTHORIZED en adelante).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { llamarClaude } from "../claude.ts";
import { db } from "../db.ts";
import { avisar } from "../telegram.ts";
import { type Canal, type ConfigProveedores, configProveedoresDesde, type Cotizacion, type DepsAgente, type EntradaAgente, type EnvioAvisado, type Idioma, type PagoPedido, type TipoCambio } from "./agente.ts";
export { textoAvisoPago, type TipoCambio } from "./agente.ts";

type ClienteDb = Pick<SupabaseClient, "from">;
type Avisar = (texto: string, botones?: undefined, opts?: Record<string, unknown>) => Promise<unknown>;

const porDefecto = { cliente: (): ClienteDb => db(), avisar: avisar as unknown as Avisar, fetch: (u: string, i?: RequestInit) => fetch(u, i) };
let entorno = { ...porDefecto };

/** Solo para pruebas: reemplaza la base y/o el aviso. Sin argumentos vuelve a lo real. */
export function _configurarIo(parcial?: { cliente?: () => ClienteDb; avisar?: Avisar; fetch?: (u: string, i?: RequestInit) => Promise<Response> }): void {
  entorno = parcial ? { ...porDefecto, ...parcial } : { ...porDefecto };
}

const base = () => entorno.cliente();

// ---------- config y gasto ----------

/** config.proveedores. Si no se puede leer → apagado. */
export async function configProveedores(): Promise<ConfigProveedores> {
  const { data, error } = await base().from("config").select("valor").eq("clave", "proveedores").maybeSingle();
  if (error) {
    console.error("config.proveedores:", error.message);
    return configProveedoresDesde(null);
  }
  return configProveedoresDesde((data as { valor?: unknown } | null)?.valor ?? null);
}

/** Inicio del mes de Paraguay (UTC−3 fijo) para un instante, en ISO UTC. */
export function inicioMesPY(d: Date): string {
  const py = new Date(d.getTime() - 3 * 3600_000);
  return new Date(Date.UTC(py.getUTCFullYear(), py.getUTCMonth(), 1, 3, 0, 0)).toISOString();
}

/** Suma de pi_mensajes.costo_usd del mes (Paraguay), las dos vías. Si la base falla, tira error (el agente no gasta). */
export async function gastoMesUsd(ahora: Date = new Date()): Promise<number> {
  const desde = inicioMesPY(ahora);
  let total = 0;
  for (let pagina = 0; pagina < 20; pagina++) {
    const { data, error } = await base().from("pi_mensajes").select("costo_usd").not("costo_usd", "is", null)
      .gte("creado_en", desde).order("creado_en", { ascending: true }).range(pagina * 1000, pagina * 1000 + 999);
    if (error) throw new Error(`gastoMesUsd: ${error.message}`);
    const filas = (data ?? []) as Array<{ costo_usd: unknown }>;
    for (const f of filas) {
      const n = Number(f.costo_usd);
      if (f.costo_usd !== null && Number.isFinite(n)) total += n;
    }
    if (filas.length < 1000) break;
  }
  return Math.round(total * 1e6) / 1e6;
}

// ---------- proveedores ----------

export interface ProveedorContacto {
  id: string;
  nombre: string | null;
  idioma: Idioma | null;
  plataforma: string | null;
  email: string | null;
  whatsapp: string | null;
  canal_preferido: string | null;
  no_contactar: boolean;
}

const COLS_PROVEEDOR = "id, razon_social_declarada, idioma, plataforma, email, whatsapp, canal_preferido, no_contactar";

function aProveedor(f: Record<string, unknown>): ProveedorContacto {
  const idioma = f.idioma === "zh" || f.idioma === "en" || f.idioma === "es" ? f.idioma : null;
  return {
    id: String(f.id),
    nombre: (f.razon_social_declarada as string | null) ?? null,
    idioma,
    plataforma: (f.plataforma as string | null) ?? null,
    email: (f.email as string | null) ?? null,
    whatsapp: (f.whatsapp as string | null) ?? null,
    canal_preferido: (f.canal_preferido as string | null) ?? null,
    no_contactar: f.no_contactar === true,
  };
}

async function proveedorPor(columna: "email" | "whatsapp", valor: string, incluirNoContactar: boolean): Promise<ProveedorContacto | null> {
  let q = base().from("pi_proveedores").select(COLS_PROVEEDOR).eq(columna, valor);
  if (!incluirNoContactar) q = q.eq("no_contactar", false);
  const { data, error } = await q.order("creado_en", { ascending: true }).limit(1);
  if (error) throw new Error(`proveedorPor ${columna}: ${error.message}`);
  const f = (data ?? [])[0] as Record<string, unknown> | undefined;
  return f ? aProveedor(f) : null;
}

/** Proveedor por correo (minúscula). Por defecto ignora los marcados "no contactar" (devuelve null). */
export async function proveedorPorEmail(email: string, opciones: { incluirNoContactar?: boolean } = {}): Promise<ProveedorContacto | null> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
  return await proveedorPor("email", e, opciones.incluirNoContactar === true);
}

/** Proveedor por WhatsApp (E.164 sin '+', solo dígitos). Por defecto ignora los "no contactar". */
export async function proveedorPorWhatsapp(digitos: string, opciones: { incluirNoContactar?: boolean } = {}): Promise<ProveedorContacto | null> {
  const d = String(digitos ?? "").replace(/\D/g, "");
  if (!/^\d{8,15}$/.test(d)) return null;
  return await proveedorPor("whatsapp", d, opciones.incluirNoContactar === true);
}

// ---------- mensajes ----------

/**
 * Lo que vio el proveedor (recibidos y enviados confirmados), viejo → nuevo, los últimos `limite`.
 * `excluirId`: el entrante que se está respondiendo (ya va como `texto` al agente).
 */
export async function historialDe(proveedorId: string, limite = 20, opciones: { excluirId?: string | null } = {}): Promise<EntradaAgente["historial"]> {
  const { data, error } = await base().from("pi_mensajes").select("id, direccion, original, traduccion, creado_en, estado")
    .eq("proveedor_id", proveedorId).in("estado", ["RECEIVED", "SENT_CONFIRMED"])
    .order("creado_en", { ascending: false }).limit(limite + 1);
  if (error) throw new Error(`historialDe: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((f) => f.id !== opciones.excluirId && (f.direccion === "in" || f.direccion === "out") && (f.original || f.traduccion))
    .slice(0, limite)
    .reverse()
    .map((f) => ({
      direccion: f.direccion as "in" | "out",
      texto: String(f.original ?? f.traduccion),
      traduccion: (f.traduccion as string | null) ?? null,
      creado_en: String(f.creado_en),
    }));
}

export interface FilaMensaje {
  canal: Canal | "1688";
  direccion: "in" | "out";
  estado: string; // 'RECEIVED' (entrante) | 'DRAFT' | 'AUTHORIZED' | …
  autor: "agente" | "admin" | "enrique" | "proveedor";
  idempotencia: string; // entrante '<canal>:in:<id_externo>'; saliente '<canal>:out:<hilo o proveedor>:<id entrante o "primer">:<n>'
  politica_id: string | null; // null solo en entrantes
  proveedor_id: string | null;
  candidato_id?: string | null;
  id_externo?: string | null;
  hilo?: string | null;
  asunto?: string | null;
  original?: string | null;
  traduccion?: string | null;
  idioma?: string | null;
  costo_usd?: number | null;
}

/** Inserta en pi_mensajes y devuelve el id; si la idempotencia (o canal + id externo) ya existe → null (ya procesado). */
export async function guardarMensaje(fila: FilaMensaje): Promise<string | null> {
  const { data, error } = await base().from("pi_mensajes").insert(fila).select("id").single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw new Error(`guardarMensaje: ${error.message}`);
  }
  return String((data as { id: unknown }).id);
}

export async function actualizarMensaje(id: string, cambios: Partial<FilaMensaje>): Promise<void> {
  const { error } = await base().from("pi_mensajes").update(cambios).eq("id", id);
  if (error) throw new Error(`actualizarMensaje: ${error.message}`);
}

/** Id del permiso general para negociar (pi_politicas con candidato_id null). Si no permite enviar, la base frena el envío. */
export async function permisoGeneralId(): Promise<string | null> {
  const { data, error } = await base().from("pi_politicas").select("id").is("candidato_id", null).limit(1);
  if (error) throw new Error(`permisoGeneralId: ${error.message}`);
  const f = (data ?? [])[0] as { id?: unknown } | undefined;
  return f?.id ? String(f.id) : null;
}

type Candidato = NonNullable<EntradaAgente["candidato"]>;

async function candidatoPor(columna: "hilo" | "proveedor_id", valor: string): Promise<Candidato | null> {
  const { data, error } = await base().from("pi_mensajes").select("candidato_id").eq(columna, valor)
    .not("candidato_id", "is", null).order("creado_en", { ascending: false }).limit(1);
  if (error) throw new Error(`candidato por ${columna}: ${error.message}`);
  const id = ((data ?? [])[0] as { candidato_id?: string } | undefined)?.candidato_id;
  if (!id) return null;
  const c = await base().from("pi_candidatos").select("id, nombre").eq("id", id).maybeSingle();
  if (c.error) throw new Error(`pi_candidatos: ${c.error.message}`);
  if (!c.data) return null;
  const f = await base().from("pi_fichas").select("spec").eq("candidato_id", id).order("version", { ascending: false }).limit(1);
  const spec = f.error ? undefined : ((f.data ?? [])[0] as { spec?: unknown } | undefined)?.spec;
  const fila = c.data as { id: unknown; nombre: unknown };
  return { id: String(fila.id), nombre: String(fila.nombre), ...(spec ? { ficha: spec } : {}) };
}

/** Producto del último mensaje del hilo que lo dice (con su ficha más nueva, si hay). */
export function candidatoDeHilo(hilo: string): Promise<Candidato | null> {
  return candidatoPor("hilo", hilo);
}

/** Producto del último mensaje con ese proveedor que lo dice. */
export function ultimoCandidatoDe(proveedorId: string): Promise<Candidato | null> {
  return candidatoPor("proveedor_id", proveedorId);
}

// ---------- cotizaciones ----------

const MONEDAS = new Set(["PYG", "USD", "CNY"]);

/**
 * Carga lo que el proveedor confirmó por escrito: tipo 'firme' si está completa, 'escaparate' si no.
 * El mensaje de origen queda en una evidencia (pi_evidencias, supplier_claim) enlazada con evidencia_id.
 * Sin producto no se carga (pi_cotizaciones.candidato_id es obligatorio) → null.
 */
export async function cargarCotizacion(
  c: Cotizacion,
  ctx: { candidatoId: string | null; proveedorId: string | null; mensajeId: string | null; canal: Canal },
): Promise<string | null> {
  if (!ctx.candidatoId) return null;
  const moneda = MONEDAS.has(c.moneda) ? c.moneda : null;
  let evidenciaId: string | null = null;
  if (ctx.mensajeId) {
    const ev = await base().from("pi_evidencias").insert({
      candidato_id: ctx.candidatoId,
      tipo: "supplier_claim",
      campo: "cotizacion_proveedor",
      valor: JSON.stringify(c),
      moneda,
      fuente_entidad: `proveedor ${ctx.proveedorId ?? "?"} por ${ctx.canal}`,
      captura_ref: `pi_mensajes:${ctx.mensajeId}`,
      cargado_por: "agente",
    }).select("id").single();
    if (ev.error) console.error("pi_evidencias (cotización):", ev.error.message);
    else evidenciaId = String((ev.data as { id: unknown }).id);
  }
  const { data, error } = await base().from("pi_cotizaciones").insert({
    candidato_id: ctx.candidatoId,
    proveedor_id: ctx.proveedorId,
    moneda,
    escalones: c.escalones,
    moq: c.moq ?? null,
    incoterm: c.incoterm ?? null,
    plazo_dias: c.plazo_dias ?? null,
    costo_muestra_minor: c.costo_muestra_minor ?? null,
    peso_bruto_g: c.peso_bruto_g ?? null,
    unidades_por_caja: c.unidades_por_caja ?? null,
    medidas_caja_cm: c.medidas_caja_cm ?? null,
    tipo: c.completa ? "firme" : "escaparate",
    evidencia_id: evidenciaId,
  }).select("id").single();
  if (error) throw new Error(`cargarCotizacion: ${error.message}`);
  return String((data as { id: unknown }).id);
}

// ---------- 25-11: orden de compra por link de pago, seguimiento y tipo de cambio ----------
// Proceso de Enrique (25-11): negociar → dirección del depósito → link de Alipay → paga Enrique. La base (trigger
// pi_ordenes_compra_solo_enrique) deja que el sistema cree y cambie órdenes en BORRADOR; confirmar, marcar pagada o
// cambiar montos de una orden confirmada es solo de Enrique. Acá nunca se abre el link ni se paga.

export interface OrdenProveedor {
  id: string; estado: string; candidato_id: string; proveedor_id: string | null; moneda: string; total_minor: number | null;
  cantidad: number; tracking: string | null; forwarder: string | null; deposito_destino: string | null; notas: string | null; actualizado_en: string;
}
const COLS_ORDEN = "id, estado, candidato_id, proveedor_id, moneda, total_minor, cantidad, tracking, forwarder, deposito_destino, notas, actualizado_en";
const PLATAFORMAS_ORDEN = new Set(["alibaba", "1688", "local", "otro"]);
const horaPY = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(5, 16).replace("T", " ").replace(/^(\d\d)-(\d\d)/, "$2-$1");
const sumarNota = (viejas: string | null, linea: string) => [viejas?.trim(), linea].filter(Boolean).join("\n").slice(-4000);

async function ordenAbierta(proveedorId: string, candidatoId: string | null, estados: string[]): Promise<OrdenProveedor | null> {
  let q = base().from("pi_ordenes_compra").select(COLS_ORDEN).eq("proveedor_id", proveedorId).in("estado", estados);
  if (candidatoId) q = q.eq("candidato_id", candidatoId);
  const { data, error } = await q.order("actualizado_en", { ascending: false }).limit(1);
  if (error) throw new Error(`pi_ordenes_compra: ${error.message}`);
  return ((data ?? []) as OrdenProveedor[])[0] ?? null;
}

/**
 * Link o pedido de pago del proveedor → orden en BORRADOR (nueva o la abierta de ese producto y proveedor) con monto,
 * moneda, cantidad y el link en las notas. Una orden ya confirmada por Enrique solo suma la nota (los montos no se tocan).
 */
export async function registrarPagoPedido(r: {
  proveedorId: string; candidatoId: string; pago: PagoPedido; canal: Canal; mensajeId: string | null; plataforma: string | null; ahora?: Date;
}): Promise<{ id: string; estado: string; nueva: boolean }> {
  const ahora = r.ahora ?? new Date();
  const p = r.pago;
  const monto = p.monto_minor != null && p.moneda ? `${(p.monto_minor / 100).toFixed(2)} ${p.moneda}` : "monto sin leer";
  const nota = `[${horaPY(ahora)}] Pedido de pago por ${r.canal === "email" ? "correo" : "WhatsApp"}: ${monto}${p.link ? ` · link ${p.link} (${p.dominio_ok ? `dominio ${p.dominio}` : `⚠️ dominio ${p.dominio ?? "?"}: no es Alibaba/1688/Alipay`})` : " · sin link"}${r.mensajeId ? ` · mensaje ${r.mensajeId}` : ""}. Lo paga Enrique; el sistema no abre el link.`;
  const abierta = await ordenAbierta(r.proveedorId, r.candidatoId, ["BORRADOR", "CONFIRMADA_POR_ENRIQUE", "PEDIDA", "PAGADA_POR_ENRIQUE"]);
  if (abierta) {
    const cambios: Record<string, unknown> = { notas: sumarNota(abierta.notas, nota) };
    if (abierta.estado === "BORRADOR") {
      if (p.monto_minor != null && p.moneda) Object.assign(cambios, { total_minor: p.monto_minor, moneda: p.moneda });
      if (p.cantidad) cambios.cantidad = p.cantidad;
    }
    const { error } = await base().from("pi_ordenes_compra").update(cambios).eq("id", abierta.id);
    if (error) throw new Error(`registrarPagoPedido (actualizar): ${error.message}`);
    return { id: abierta.id, estado: abierta.estado, nueva: false };
  }
  const { data, error } = await base().from("pi_ordenes_compra").insert({
    candidato_id: r.candidatoId,
    proveedor_id: r.proveedorId,
    plataforma: r.plataforma && PLATAFORMAS_ORDEN.has(r.plataforma) ? r.plataforma : null,
    cantidad: p.cantidad ?? 1,
    total_minor: p.monto_minor,
    moneda: p.moneda ?? "CNY",
    estado: "BORRADOR",
    notas: p.cantidad ? nota : `${nota} Cantidad a confirmar (no vino en el mensaje).`,
  }).select("id").single();
  if (error) throw new Error(`registrarPagoPedido (crear): ${error.message}`);
  return { id: String((data as { id: unknown }).id), estado: "BORRADOR", nueva: true };
}

/** Número de seguimiento → la orden abierta del proveedor (la pagada primero). Pagada pasa a EN_TRANSITO. null = sin orden. */
export async function cargarTracking(r: { proveedorId: string; candidatoId: string | null; envio: EnvioAvisado; canal: Canal; ahora?: Date }): Promise<{ id: string; estado: string } | null> {
  const ahora = r.ahora ?? new Date();
  const orden = (await ordenAbierta(r.proveedorId, r.candidatoId, ["PAGADA_POR_ENRIQUE"]))
    ?? (await ordenAbierta(r.proveedorId, r.candidatoId, ["PEDIDA", "CONFIRMADA_POR_ENRIQUE"]))
    ?? (r.candidatoId ? await ordenAbierta(r.proveedorId, null, ["PAGADA_POR_ENRIQUE"]) : null);
  if (!orden) return null;
  if (orden.tracking === r.envio.tracking) return { id: orden.id, estado: orden.estado };
  const estado = orden.estado === "PAGADA_POR_ENRIQUE" ? "EN_TRANSITO" : orden.estado;
  const nota = `[${horaPY(ahora)}] Seguimiento por ${r.canal === "email" ? "correo" : "WhatsApp"}: ${r.envio.tracking}${r.envio.empresa ? ` (${r.envio.empresa})` : ""}.`;
  const { error } = await base().from("pi_ordenes_compra").update({ tracking: r.envio.tracking, estado, notas: sumarNota(orden.notas, nota) }).eq("id", orden.id);
  if (error) throw new Error(`cargarTracking: ${error.message}`);
  return { id: orden.id, estado };
}

/** Vía que marcó administración para la compra de ese producto con ese proveedor: la orden abierta (cualquier estado
 *  salvo cancelada/recibida) con "aéreo" en forwarder o destino. Sin orden o sin marca = marítimo. */
export async function viaParaCompra(proveedorId: string, candidatoId: string | null): Promise<"maritimo" | "aereo"> {
  if (!candidatoId) return "maritimo";
  const o = await ordenAbierta(proveedorId, candidatoId, ["BORRADOR", "CONFIRMADA_POR_ENRIQUE", "PEDIDA", "PAGADA_POR_ENRIQUE", "EN_TRANSITO"]);
  if (o && viaDeOrden(o) === "aereo") return "aereo";
  // 25-11: administración también puede marcarlo en el producto: "VIA: AEREO" en las notas del candidato.
  const c = await base().from("pi_candidatos").select("notas").eq("id", candidatoId).maybeSingle();
  if (c.error) throw new Error(`viaParaCompra (candidato): ${c.error.message}`);
  return viaMarcadaEnNotas((c.data as { notas?: string | null } | null)?.notas ?? null) ?? "maritimo";
}

/** "VIA: AEREO" / "vía aérea" / "envío aéreo" en las notas → aéreo; "VIA: MARITIMO" → marítimo; nada → null. */
export function viaMarcadaEnNotas(notas: string | null): "maritimo" | "aereo" | null {
  const t = String(notas ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(via|envio)\s*:?\s*aere[ao]\b/.test(t)) return "aereo";
  if (/\b(via|envio)\s*:?\s*maritim[ao]\b/.test(t)) return "maritimo";
  return null;
}

export type TipoAvisoOrden = "postpago";
export interface OrdenParaAvisar { orden: OrdenProveedor; tipo: TipoAvisoOrden; via: "maritimo" | "aereo"; hilo: string | null }
/** Vía de la orden: aérea solo si el forwarder o el destino lo dicen; si no, marítima (config: aéreo solo si se indica). */
export const viaDeOrden = (o: Pick<OrdenProveedor, "forwarder" | "deposito_destino">): "maritimo" | "aereo" =>
  /a[eé]re|\bair\b|avi[oó]n/i.test(`${o.forwarder ?? ""} ${o.deposito_destino ?? ""}`) ? "aereo" : "maritimo";

/**
 * Órdenes de los últimos 30 días que piden un mensaje fijo al proveedor por `canal` (el del último mensaje con ese
 * proveedor): pagada por Enrique sin seguimiento → "pago hecho, pasá el seguimiento". (La dirección ya no sale acá:
 * la manda el agente al cerrar el precio, antes de que exista la orden.) Una sola vez por orden (idempotencia del canal).
 */
export async function ordenesParaAvisar(canal: Canal, ahora: Date = new Date()): Promise<OrdenParaAvisar[]> {
  const desde = new Date(ahora.getTime() - 30 * 86_400_000).toISOString();
  const { data, error } = await base().from("pi_ordenes_compra").select(COLS_ORDEN)
    .eq("estado", "PAGADA_POR_ENRIQUE").is("tracking", null).gte("actualizado_en", desde).order("actualizado_en", { ascending: true }).limit(50);
  if (error) throw new Error(`ordenesParaAvisar: ${error.message}`);
  const out: OrdenParaAvisar[] = [];
  for (const o of (data ?? []) as OrdenProveedor[]) {
    if (!o.proveedor_id) continue;
    const m = await base().from("pi_mensajes").select("canal, hilo").eq("proveedor_id", o.proveedor_id).order("creado_en", { ascending: false }).limit(1);
    if (m.error) throw new Error(`ordenesParaAvisar (mensajes): ${m.error.message}`);
    const ultimo = ((m.data ?? []) as Array<{ canal: string; hilo: string | null }>)[0];
    if (!ultimo || ultimo.canal !== canal) continue;
    if (o.estado === "PAGADA_POR_ENRIQUE" && !o.tracking) out.push({ orden: o, tipo: "postpago", via: viaDeOrden(o), hilo: ultimo.hilo });
  }
  return out;
}

/** USD→₲ de tipo_cambio (última fila) y USD→CNY de la fuente pública currency-api (la misma que usa la web). */
export async function tipoCambioHoy(): Promise<TipoCambio> {
  let usd_pyg: number | null = null, cny_por_usd: number | null = null;
  try {
    const { data } = await base().from("tipo_cambio").select("usd_pyg").order("fecha", { ascending: false }).limit(1);
    const n = Number(((data ?? []) as Array<{ usd_pyg: unknown }>)[0]?.usd_pyg);
    usd_pyg = Number.isFinite(n) && n > 0 ? n : null;
  } catch (e) { console.error("tipo_cambio:", e instanceof Error ? e.message : e); }
  for (const u of ["https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", "https://latest.currency-api.pages.dev/v1/currencies/usd.json"]) {
    try {
      const r = await entorno.fetch(u, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const j = await r.json() as { usd?: Record<string, unknown> };
      const cny = Number(j.usd?.cny);
      const pyg = Number(j.usd?.pyg);
      if (Number.isFinite(cny) && cny > 0) cny_por_usd = cny;
      if (usd_pyg == null && Number.isFinite(pyg) && pyg > 0) usd_pyg = pyg;
      if (cny_por_usd) break;
    } catch { /* la otra fuente */ }
  }
  return { usd_pyg, cny_por_usd };
}

// ---------- avisos ----------

// Destino de cada tipo (registrados en _shared/telegram_tipos.ts). frena y tope: decide Enrique (plata o compra) →
// Telegram; cotización completa: resumen para administración (cola avisos_admin).
const AVISOS_PROVEEDORES = {
  proveedor_frena: { tipo: "proveedor_frena", destino: "enrique" },
  proveedor_cotizacion: { tipo: "proveedor_cotizacion", destino: "admin" },
  proveedor_tope_ia: { tipo: "proveedor_tope_ia", destino: "enrique" },
} as const;
export type TipoAvisoProveedor = keyof typeof AVISOS_PROVEEDORES;

/** Aviso (texto HTML ya escapado) una sola vez por día por `clave` (ej. 'email:<hilo>' o el mes para el tope). */
export async function avisarAdministracion(texto: string, opts: { tipo: TipoAvisoProveedor; clave: string }): Promise<void> {
  const a = AVISOS_PROVEEDORES[opts.tipo];
  try {
    await entorno.avisar(texto, undefined, { tipo: a.tipo, destino: a.destino, clave: opts.clave, unaVezPorDia: true });
  } catch (e) {
    console.error(`avisarAdministracion (${opts.tipo}):`, e instanceof Error ? e.message : e);
  }
}

// ---------- dependencias reales del agente ----------

export const depsAgenteReales: DepsAgente = {
  llamar: llamarClaude,
  gastoMesUsd: () => gastoMesUsd(),
  config: configProveedores,
};
