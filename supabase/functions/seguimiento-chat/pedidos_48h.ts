// seguimiento-chat · pedidos_48h · 05-11 (Enrique: "un secretario super inteligente que solucione todo y delegue a mí lo
// menos posible cuando son dudas y/o datos faltantes o cobertura"). Red de seguridad: un pedido CONFIRMADO que a las
// 48 h de confirmado sigue sin ir al courier no queda trabado en silencio. Puro, sin red (la carga está en _io.ts).
// El motivo es el MISMO que muestran la lista de despacho y Despacho (lista-despacho/logica.ts → _shared/sale_hoy.js):
//   · faltan datos que da el cliente (dirección no utilizable, ciudad vacía o no reconocida) → se le pide UNA vez
//     (candado auto_reconfirmar_48h:<id>): ventana de 24 h abierta → texto libre; cerrada → plantilla
//     voltra_completar_direccion. Se manda aunque otro flujo ya le haya pedido el dato y no contestó.
//   · sin cobertura / pago anticipado / comprobante → nada (lo llevan otros flujos).
//   · despachable → nada (ya está en la lista de las 12:30).
//   · cualquier otro motivo (o un cliente sin WhatsApp) → UN Telegram a Enrique (candado auto_pedido_48h_aviso:<id>).
// Al cliente solo de 08:00 a 20:00 de Paraguay (UTC−3). Interruptor config_wa.pedidos_48h {activo, simular}.
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { listaTags } from "../_shared/sale_hoy.js";
import type { ListaDespacho } from "../lista-despacho/logica.ts";
import type { FilaPedido } from "../lista-despacho/carga.ts";

export const HORAS_LIMITE = 48;
/** Al cliente solo de 08:00 a 20:00 de Paraguay (UTC−3). */
export const HORARIO_CLIENTE = { desde: 8, hasta: 20 };

export const idCandadoCliente = (orderId: string) => `auto_reconfirmar_48h:${orderId}`;
export const idCandadoAviso = (orderId: string) => `auto_pedido_48h_aviso:${orderId}`;
/** Candados de los flujos que ya le pidieron el dato (pedidos-trabados) y clave de la plantilla de datos_faltantes. */
export const idsPedidosPrevios = (orderId: string) => [
  `auto_completar_direccion:${orderId}`, `auto_pedir_ciudad:${orderId}`, `auto_agregar_faltan_datos:${orderId}`,
];

export interface Candidato {
  orderId: string;
  /** '#1234' */
  pedido: string;
  clienteId: string | null;
  primerNombre: string | null;
  /** confirmado_en (lo pone la base al confirmar) o, si falta, creado_en. */
  desde: string;
  horas: number;
  /** Clave de sale_hoy.js (faltan_datos, ciudad, sin_cobertura, comprobante, no_recibe…). */
  clave: string;
  /** Motivo tal cual lo muestra la lista de despacho. */
  motivo: string;
  faltaCiudad: boolean;
  faltaDireccion: boolean;
  tags: string[];
}

export type Accion =
  | { tipo: "nada"; razon: "menos_de_48h" | "otro_flujo" | "ya_hecho" }
  | { tipo: "esperar_horario" }
  | { tipo: "texto_libre"; texto: string }
  | { tipo: "plantilla"; variables: { nombre: string; pedido: string } }
  | { tipo: "telegram"; texto: string };

/** Hora de Paraguay (UTC−3 fijo, igual que lista-despacho). */
export const horaPY = (d: Date) => (d.getUTCHours() + 21) % 24;
export const enHorarioCliente = (d: Date) => horaPY(d) >= HORARIO_CLIENTE.desde && horaPY(d) < HORARIO_CLIENTE.hasta;

/** "ana maría" → "Ana". */
export function primerNombre(raw: Record<string, unknown> | null): string | null {
  const dir = ((raw?.shipping_address ?? raw?.billing_address ?? {}) as Record<string, unknown>);
  const crudo = String(dir.first_name ?? "").trim() || String(dir.name ?? "").trim();
  const p = crudo.split(/\s+/)[0] ?? "";
  return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : null;
}

/** Motivos que llevan otros flujos (sin cobertura, pago anticipado, comprobante) o que no son "trabado". */
const OTRO_FLUJO = new Set(["sin_cobertura", "comprobante", "sin_confirmar", "retiro", "pago_requerido"]); // 05-11: pago_requerido = motivo de FUNCIONES
const DEL_CLIENTE = new Set(["faltan_datos", "ciudad"]);

/**
 * Pedidos de la sección "No despachar" de la lista con su antigüedad desde la confirmación. Los despachables, los
 * retiros y los sin confirmar no entran (ya tienen dueño).
 */
export function candidatos(lista: ListaDespacho, filas: FilaPedido[], ahora: Date): Candidato[] {
  const porNombre = new Map(filas.map((f) => [String((f.raw as Record<string, unknown> | null)?.name ?? f.nombre ?? ""), f]));
  const out: Candidato[] = [];
  for (const nd of lista.noDespachar) {
    const f = porNombre.get(nd.p.nombre);
    if (!f) continue;
    const desde = f.confirmado_en ?? f.creado_en;
    const horas = Math.floor((ahora.getTime() - Date.parse(desde)) / 3_600_000);
    const tags = listaTags((f.raw as Record<string, unknown> | null)?.tags) as string[];
    out.push({
      orderId: String(f.shopify_order_id), pedido: nd.p.nombre, clienteId: f.cliente_id ?? null,
      primerNombre: primerNombre(f.raw), desde, horas, clave: nd.clave, motivo: nd.motivo, tags,
      faltaCiudad: nd.clave === "ciudad",
      faltaDireccion: nd.clave === "faltan_datos" || nd.p.direccionOk === false,
    });
  }
  return out;
}

/** "la ciudad" / "la dirección (…) o tu ubicación 📍" / las dos. */
export function queFalta(c: Pick<Candidato, "faltaCiudad" | "faltaDireccion">): { falta: string; pedir: string } {
  const dir = "la dirección (calle o barrio y una referencia) o tu ubicación 📍";
  if (c.faltaCiudad && c.faltaDireccion) return { falta: `la ciudad y ${dir}`, pedir: "esos datos" };
  if (c.faltaCiudad) return { falta: "la ciudad", pedir: "el nombre de tu ciudad o tu ubicación 📍" };
  return { falta: dir, pedir: "esos datos" };
}

export function textoReconfirmar(c: Pick<Candidato, "primerNombre" | "pedido" | "faltaCiudad" | "faltaDireccion">): string {
  const { falta, pedir } = queFalta(c);
  return `${c.primerNombre ?? "Hola"}, tu pedido ${c.pedido} sigue esperando para salir: nos falta ${falta}. ` +
    `¿Nos pasás ${pedir} por acá? Apenas lo tengamos, sale 🙌`;
}

export function textoTelegram(c: Pick<Candidato, "pedido" | "horas">, motivo: string): string {
  return `⏳ <b>${escaparHtml(c.pedido)}</b>: confirmado hace ${c.horas} h y no sale: ${escaparHtml(motivo)}.`;
}

export interface Estado {
  /** Candados ya tomados (id_externo de eventos_crudos). */
  tomados: ReadonlySet<string>;
  /** cliente_id → ¿ventana de 24 h abierta (último mensaje entrante hace < 23 h)? */
  ventanas: ReadonlyMap<string, boolean>;
}

/** Qué hacer con un pedido (puro). */
export function decidir(c: Candidato, e: Estado, ahora: Date): Accion {
  if (c.horas < HORAS_LIMITE) return { tipo: "nada", razon: "menos_de_48h" };
  const pagoAnticipado = c.tags.includes("pago_anticipado_requerido") || c.tags.includes("sin_cobertura");
  if (OTRO_FLUJO.has(c.clave) || (pagoAnticipado && !DEL_CLIENTE.has(c.clave))) return { tipo: "nada", razon: "otro_flujo" };
  // 05-11 (FUNCIONES): CIUDAD_POR_PIN = la ciudad ya se corrigió con el pin; no se le pregunta la ciudad al cliente.
  const ciudadCorregida = c.tags.includes("ciudad_por_pin") && c.clave === "ciudad" && !c.faltaDireccion;
  if (DEL_CLIENTE.has(c.clave) && !ciudadCorregida && c.clienteId) {
    if (e.tomados.has(idCandadoCliente(c.orderId))) return { tipo: "nada", razon: "ya_hecho" };
    if (!enHorarioCliente(ahora)) return { tipo: "esperar_horario" };
    if (e.ventanas.get(c.clienteId)) return { tipo: "texto_libre", texto: textoReconfirmar(c) };
    return { tipo: "plantilla", variables: { nombre: c.primerNombre ?? "Hola", pedido: c.pedido } };
  }
  if (e.tomados.has(idCandadoAviso(c.orderId))) return { tipo: "nada", razon: "ya_hecho" };
  const motivo = ciudadCorregida ? `${c.motivo} (tiene CIUDAD_POR_PIN: la ciudad ya se corrigió con el pin, revisá)`
    : DEL_CLIENTE.has(c.clave) ? `falta ${queFalta(c).falta.replace(/ o tu ubicación 📍/, "")} y no tiene WhatsApp para pedírselo`
    : c.motivo;
  return { tipo: "telegram", texto: textoTelegram(c, motivo) };
}

/** Fila de envios_programados para lo que se le manda al cliente. */
export function filaEnvio(c: Candidato, a: Extract<Accion, { tipo: "texto_libre" | "plantilla" }>, ahora: Date) {
  const base = { cliente_id: c.clienteId, shopify_order_id: Number(c.orderId), categoria: "utilidad", enviar_desde: ahora.toISOString() };
  return a.tipo === "texto_libre"
    ? { ...base, plantilla: "texto_libre", variables: { texto: a.texto }, clave_unica: `texto_libre:reconfirmar_48h:${c.orderId}` }
    : { ...base, plantilla: "voltra_completar_direccion", variables: a.variables, clave_unica: `reconfirmar_48h:${c.orderId}` };
}

export interface Deps48h {
  /** config_wa.pedidos_48h (null si no está). */
  config(): Promise<unknown>;
  cargar(ahora: Date): Promise<{ lista: ListaDespacho; filas: FilaPedido[] }>;
  /** De estos id_externo, cuáles existen en eventos_crudos (fuente shopify). */
  candados(ids: string[]): Promise<Set<string>>;
  ventanas(clienteIds: string[], ahora: Date): Promise<Map<string, boolean>>;
  /** Toma un candado (false si ya existía). */
  tomar(id: string, payload: Record<string, unknown>): Promise<boolean>;
  soltar(id: string): Promise<void>;
  /** Encola en envios_programados (null = ok). */
  encolar(fila: ReturnType<typeof filaEnvio>): Promise<string | null>;
  avisar(texto: string, c: Candidato): Promise<{ ok: boolean; error?: string }>;
}

export function leerConfig(v: unknown): { activo: boolean; simular: boolean } {
  let o = v;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { o = null; } }
  const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  return { activo: r.activo === true, simular: r.simular === true };
}

export type Hecho = { pedido: string; horas: number; clave: string; accion: Accion["tipo"]; previo?: boolean; ok?: boolean; error?: string };

/**
 * Una corrida. `simular` (o config_wa.pedidos_48h.simular): informa qué haría, sin tomar candados ni escribir.
 * Apagado (default) → no hace nada.
 */
export async function correrPedidos48h(d: Deps48h, ahora = new Date(), simular = false) {
  const cfg = leerConfig(await d.config());
  if (!cfg.activo && !simular) return { activo: false, hechos: [] as Hecho[] };
  const sim = simular || cfg.simular;
  const { lista, filas } = await d.cargar(ahora);
  const cands = candidatos(lista, filas, ahora).filter((c) => c.horas >= HORAS_LIMITE);
  const ids = cands.flatMap((c) => [idCandadoCliente(c.orderId), idCandadoAviso(c.orderId), ...idsPedidosPrevios(c.orderId)]);
  const tomados = ids.length ? await d.candados(ids) : new Set<string>();
  const clientes = [...new Set(cands.map((c) => c.clienteId).filter((x): x is string => !!x))];
  const ventanas = clientes.length ? await d.ventanas(clientes, ahora) : new Map<string, boolean>();
  const hechos: Hecho[] = [];
  for (const c of cands) {
    const a = decidir(c, { tomados, ventanas }, ahora);
    if (a.tipo === "nada") continue;
    const h: Hecho = { pedido: c.pedido, horas: c.horas, clave: c.clave, accion: a.tipo };
    if (a.tipo === "texto_libre" || a.tipo === "plantilla") h.previo = idsPedidosPrevios(c.orderId).some((i) => tomados.has(i));
    hechos.push(h);
    if (sim || a.tipo === "esperar_horario") continue;
    try {
      if (a.tipo === "telegram") {
        const id = idCandadoAviso(c.orderId);
        if (!(await d.tomar(id, { pedido: c.pedido, clave: c.clave, en: ahora.toISOString() }))) { h.accion = "nada"; continue; }
        const r = await d.avisar(a.texto, c);
        h.ok = r.ok;
        if (!r.ok) { h.error = r.error ?? "Telegram falló"; await d.soltar(id); } // se reintenta en la próxima corrida
        continue;
      }
      const id = idCandadoCliente(c.orderId);
      if (!(await d.tomar(id, { pedido: c.pedido, clave: c.clave, via: a.tipo, en: ahora.toISOString() }))) { h.accion = "nada"; continue; }
      const err = await d.encolar(filaEnvio(c, a, ahora));
      h.ok = !err;
      if (err) { h.error = err; await d.soltar(id); }
    } catch (e) {
      h.ok = false;
      h.error = e instanceof Error ? e.message : String(e);
    }
  }
  return { activo: cfg.activo, simular: sim, candidatos: cands.length, hechos: hechos.filter((h) => h.accion !== "nada") };
}
