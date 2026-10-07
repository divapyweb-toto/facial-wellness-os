// mejora-mensual/datos.ts · Dueño: M1
// Recolecta las conversaciones de un mes (hora de Asunción), las anonimiza mensaje por mensaje,
// les pega el resultado real (vista conversacion_resultado) y muestrea si no entran en el tope.
// Lo que devuelve es lo ÚNICO que después puede salir hacia Claude: texto anonimizado + resultado.
// I/O inyectable (los tests pasan dependencias falsas; por defecto, Supabase con service role).
import type { PrecioModelo } from "../_shared/claude.ts";
import { partesAsuncion } from "../_shared/horario.ts";
import { anonimizar, buscarDatosCrudos, type ContextoAnon, mapaVacio } from "./anonimizar.ts";
import { recortarAlPresupuesto } from "./clasificar.ts";
import {
  CFG_MEJORA_DEFAULT,
  type CfgMejora,
  type ConversacionParaAnalizar,
  type ConversacionResultado,
  type MensajeAnon,
  presupuesto,
  RESULTADOS,
  type RecoleccionMes,
} from "./tipos.ts";

// ---------- tipos de entrada ----------

/** Fila de wa_mensajes con solo los campos de texto que hacen falta (nunca el payload completo). */
export type MensajeCrudo = {
  conversacion_id: string;
  direccion: "in" | "out";
  tipo: string | null;
  texto: string | null;
  creado_en: string;
  transcripcion?: string | null;
  texto_vendedor?: string | null;
  boton?: string | null;
  boton2?: string | null;
  lista?: string | null;
  caption_img?: string | null;
};

export type ContextoConversacion = {
  conversacion_id: string;
  nombres: string[];
  telefonos: string[];
  direcciones: string[];
  pedidos: string[];
  documentos: string[];
};

export interface DepsDatos {
  mensajesEntre: (desdeISO: string, hastaISO: string) => Promise<MensajeCrudo[]>;
  resultados: (ids: string[]) => Promise<ConversacionResultado[]>;
  contextos: (ids: string[]) => Promise<ContextoConversacion[]>;
  log?: (...a: unknown[]) => void;
}

// ---------- fechas (puro) ----------

function offsetAsuncionMs(d: Date): number {
  const p = partesAsuncion(d);
  return Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - Math.floor(d.getTime() / 1000) * 1000;
}

/** Medianoche local de Asunción del día dado, como instante UTC. */
function medianocheAsuncion(anio: number, mes: number, dia: number): Date {
  const local = Date.UTC(anio, mes - 1, dia);
  let t = new Date(local - offsetAsuncionMs(new Date(local)));
  const corregido = new Date(local - offsetAsuncionMs(t));
  if (corregido.getTime() !== t.getTime()) t = corregido;
  return t;
}

/** 'YYYY-MM' o 'YYYY-MM-DD' → mes completo en hora de Asunción: [desde, hasta). */
export function rangoMesAsuncion(mes: string): { mes: string; desde: Date; hasta: Date } {
  const m = /^(\d{4})-(\d{2})/.exec(mes);
  if (!m) throw new Error(`mes inválido: ${mes}`);
  const anio = Number(m[1]);
  const nmes = Number(m[2]);
  if (nmes < 1 || nmes > 12) throw new Error(`mes inválido: ${mes}`);
  const sig = nmes === 12 ? { a: anio + 1, m: 1 } : { a: anio, m: nmes + 1 };
  return {
    mes: `${m[1]}-${m[2]}-01`,
    desde: medianocheAsuncion(anio, nmes, 1),
    hasta: medianocheAsuncion(sig.a, sig.m, 1),
  };
}

/** Mes anterior al instante dado (hora de Asunción), como 'YYYY-MM-01'. */
export function mesAnterior(ahora: Date): string {
  const p = partesAsuncion(ahora);
  const a = p.mes === 1 ? p.anio - 1 : p.anio;
  const m = p.mes === 1 ? 12 : p.mes - 1;
  return `${a}-${String(m).padStart(2, "0")}-01`;
}

// ---------- armado (puro) ----------

/** Texto visible de un mensaje; lo que no es texto queda como marca ([imagen], [ubicación]…). */
export function textoVisible(m: MensajeCrudo): string {
  const t = (m.texto ?? "").trim();
  const tipo = (m.tipo ?? "text").toLowerCase();
  if (tipo === "audio") {
    const tr = (m.transcripcion ?? m.texto_vendedor ?? "").trim();
    return tr ? `[audio] ${tr}` : "[audio sin transcripción]";
  }
  if (tipo === "location") return "[ubicación]";
  if (tipo === "contacts") return "[contacto]";
  if (tipo === "sticker") return "[sticker]";
  if (tipo === "image" || tipo === "video" || tipo === "document") {
    const cap = (m.caption_img ?? t).trim();
    return cap ? `[${tipo}] ${cap}` : `[${tipo}]`;
  }
  if (t) return t;
  const boton = m.boton ?? m.boton2 ?? m.lista;
  if (boton) return `[botón] ${boton}`;
  return tipo === "template" ? "[plantilla]" : `[${tipo}]`;
}

const MAX_CHARS_MENSAJE = 500;

/**
 * Recorta una conversación larga: primeros ~40 % y últimos ~60 % de `max_mensajes_conversacion`,
 * cada mensaje a 500 caracteres y el total a `max_chars_conversacion` (saca del medio).
 */
export function recortarMensajes(mensajes: MensajeAnon[], cfg: CfgMejora): { mensajes: MensajeAnon[]; recortada: boolean } {
  let recortada = false;
  let lista = mensajes.map((m) => {
    if (m.texto.length <= MAX_CHARS_MENSAJE) return m;
    recortada = true;
    return { ...m, texto: m.texto.slice(0, MAX_CHARS_MENSAJE) + "…" };
  });
  const omitir = (cab: number, cola: number): MensajeAnon[] => {
    const omitidos = lista.length - cab - cola;
    return [...lista.slice(0, cab), { de: "V", texto: `[… ${omitidos} mensajes omitidos …]` }, ...lista.slice(lista.length - cola)];
  };
  const max = cfg.max_mensajes_conversacion;
  let cab = lista.length;
  let cola = 0;
  if (lista.length > max) {
    recortada = true;
    cab = Math.ceil(max * 0.4);
    cola = max - cab;
  }
  const largo = (xs: MensajeAnon[]) => xs.reduce((s, m) => s + m.texto.length + 4, 0);
  let res = cola ? omitir(cab, cola) : lista;
  while (largo(res) > cfg.max_chars_conversacion && cab + cola > 2) {
    recortada = true;
    if (!cola) {
      cab = Math.ceil(lista.length * 0.4);
      cola = lista.length - cab;
    }
    if (cab > cola) cab--;
    else cola--;
    res = omitir(Math.max(1, cab), Math.max(1, cola));
  }
  if (largo(res) > cfg.max_chars_conversacion) {
    // 2 mensajes enormes: se cortan parejo.
    const porMsj = Math.floor(cfg.max_chars_conversacion / Math.max(1, res.length)) - 4;
    res = res.map((m) => (m.texto.length > porMsj ? { ...m, texto: m.texto.slice(0, Math.max(20, porMsj)) + "…" } : m));
    recortada = true;
  }
  lista = res;
  return { mensajes: lista, recortada };
}

export function transcripcionDe(mensajes: MensajeAnon[]): string {
  return mensajes.map((m) => `${m.de}: ${m.texto.replace(/\s+/g, " ").trim()}`).join("\n");
}

const RESULTADO_VACIO = (id: string): ConversacionResultado => ({
  conversacion_id: id,
  cliente_id: null,
  shopify_order_id: null,
  resultado: "sin_compra",
  costo_ia_usd: 0,
  costo_mensajes_usd: 0,
  tuvo_reclamo: false,
  paso_escalera: null,
  derivado: false,
});

/**
 * Una conversación lista para analizar, o el motivo por el que se descarta.
 * Orden: anonimizar cada mensaje (mismo mapa para toda la conversación) → recortar → control final.
 */
export function armarConversacion(
  id: string,
  mensajes: MensajeCrudo[],
  resultado: ConversacionResultado | undefined,
  ctx: ContextoConversacion | undefined,
  cfg: CfgMejora,
): { conv: ConversacionParaAnalizar } | { descartada: "pocos_mensajes" | "sin_entrantes" | "control_anonimizacion" } {
  const ordenados = [...mensajes].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
  if (!ordenados.some((m) => m.direccion === "in")) return { descartada: "sin_entrantes" };
  if (ordenados.length < cfg.min_mensajes_conversacion) return { descartada: "pocos_mensajes" };
  const ctxAnon: ContextoAnon = {
    nombres: ctx?.nombres ?? [],
    telefonos: ctx?.telefonos ?? [],
    direcciones: ctx?.direcciones ?? [],
    pedidos: ctx?.pedidos ?? [],
    documentos: ctx?.documentos ?? [],
    mapa: mapaVacio(),
  };
  const anon: MensajeAnon[] = ordenados.map((m) => ({
    de: m.direccion === "in" ? "C" : "V",
    texto: anonimizar(textoVisible(m), ctxAnon).texto,
  }));
  const r = recortarMensajes(anon, cfg);
  const transcripcion = transcripcionDe(r.mensajes);
  if (buscarDatosCrudos(transcripcion, ctxAnon).length) return { descartada: "control_anonimizacion" };
  const res = resultado ?? RESULTADO_VACIO(id);
  return {
    conv: {
      conversacion_id: id,
      resultado: (RESULTADOS as readonly string[]).includes(res.resultado) ? res.resultado : "sin_compra",
      derivado: !!res.derivado,
      tuvo_reclamo: !!res.tuvo_reclamo,
      paso_escalera: res.paso_escalera ?? null,
      costo_ia_usd: Number(res.costo_ia_usd) || 0,
      costo_mensajes_usd: Number(res.costo_mensajes_usd) || 0,
      n_mensajes: ordenados.length,
      mensajes: r.mensajes,
      transcripcion,
      recortada: r.recortada,
    },
  };
}

// ---------- contexto para anonimizar (puro) ----------

type Obj = Record<string, unknown> | null | undefined;

function txt(o: Obj, ...claves: string[]): string[] {
  if (!o || typeof o !== "object") return [];
  return claves.map((k) => o[k]).filter((v): v is string | number => (typeof v === "string" && v.trim() !== "") || typeof v === "number").map(String);
}

/** Junta todo lo que se sabe del cliente de una conversación (para tacharlo en el texto). */
export function contextoDesdeFilas(p: {
  conversacion_id: string;
  cliente?: { nombre?: string | null; wa_username?: string | null; telefono?: string | null } | null;
  pedidos?: { shopify_order_id?: number | string | null; nombre?: string | null; telefono?: string | null; envio?: Obj; cliente_shopify?: Obj; factura?: Obj }[];
  pedidosChat?: { datos?: Obj; shopify_order_id?: number | string | null }[];
}): ContextoConversacion {
  const c: ContextoConversacion = { conversacion_id: p.conversacion_id, nombres: [], telefonos: [], direcciones: [], pedidos: [], documentos: [] };
  if (p.cliente) {
    c.nombres.push(...txt(p.cliente as Obj, "nombre", "wa_username"));
    c.telefonos.push(...txt(p.cliente as Obj, "telefono"));
  }
  for (const pe of p.pedidos ?? []) {
    c.pedidos.push(...txt(pe as Obj, "shopify_order_id", "nombre"));
    c.telefonos.push(...txt(pe as Obj, "telefono"));
    for (const a of [pe.envio, pe.factura]) {
      const nom = txt(a, "first_name", "last_name").join(" ");
      if (nom) c.nombres.push(nom);
      c.nombres.push(...txt(a, "name", "company"));
      c.direcciones.push(...txt(a, "address1", "address2"));
      c.telefonos.push(...txt(a, "phone"));
    }
    const cs = pe.cliente_shopify;
    const nom = txt(cs, "first_name", "last_name").join(" ");
    if (nom) c.nombres.push(nom);
    c.telefonos.push(...txt(cs, "phone"));
  }
  for (const pc of p.pedidosChat ?? []) {
    c.pedidos.push(...txt(pc as Obj, "shopify_order_id"));
    const d = pc.datos;
    c.nombres.push(...txt(d, "nombre", "razon_social"));
    c.direcciones.push(...txt(d, "direccion", "referencia"));
    c.telefonos.push(...txt(d, "telefono"));
    c.documentos.push(...txt(d, "ruc", "ci", "documento"));
  }
  const unicos = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return {
    conversacion_id: c.conversacion_id,
    nombres: unicos(c.nombres),
    telefonos: unicos(c.telefonos),
    direcciones: unicos(c.direcciones),
    pedidos: unicos(c.pedidos),
    documentos: unicos(c.documentos),
  };
}

// ---------- recolección ----------

export type OpcionesRecoleccion = {
  deps?: DepsDatos;
  cfg?: CfgMejora;
  /** Precio del modelo de clasificación (config_wa.precios_claude); sin precio no se muestrea por costo. */
  precio?: PrecioModelo | null;
  /** Por defecto: tope_usd × reparto_clasificacion. */
  presupuestoUsd?: number;
  /** Tope total del ciclo (config_wa.mejora_mensual.tope_usd); se usa su parte de clasificación. */
  topeUsd?: number;
  semilla?: string;
};

/**
 * Conversaciones del mes `mes` ('YYYY-MM' o 'YYYY-MM-01', hora de Asunción) con al menos un mensaje
 * del cliente y `min_mensajes_conversacion` mensajes en el mes. Devuelve el total (va contra
 * min_conversaciones) y la muestra que entra en el presupuesto de clasificación.
 */
export async function recolectarMes(mes: string, opciones: OpcionesRecoleccion = {}): Promise<RecoleccionMes> {
  const cfg = { ...(opciones.cfg ?? CFG_MEJORA_DEFAULT), ...(opciones.topeUsd ? { tope_usd: opciones.topeUsd } : {}) };
  const deps = opciones.deps ?? (await depsReales());
  const log = deps.log ?? console.log;
  const rango = rangoMesAsuncion(mes);
  const notas: string[] = [];

  const mensajes = await deps.mensajesEntre(rango.desde.toISOString(), rango.hasta.toISOString());
  const porConv = new Map<string, MensajeCrudo[]>();
  for (const m of mensajes) {
    if (!m.conversacion_id) continue;
    if (!porConv.has(m.conversacion_id)) porConv.set(m.conversacion_id, []);
    porConv.get(m.conversacion_id)!.push(m);
  }
  const ids = [...porConv.keys()];
  if (!ids.length) return { mes: rango.mes, total: 0, conversaciones: [], recortadas_por_tope: 0, notas: ["sin conversaciones en el mes"] };

  const [resultados, contextos] = await Promise.all([deps.resultados(ids), deps.contextos(ids)]);
  const resPorId = new Map(resultados.map((r) => [r.conversacion_id, r]));
  const ctxPorId = new Map(contextos.map((c) => [c.conversacion_id, c]));

  const convs: ConversacionParaAnalizar[] = [];
  const descartes: Record<string, number> = {};
  for (const id of ids.sort()) {
    const r = armarConversacion(id, porConv.get(id)!, resPorId.get(id), ctxPorId.get(id), cfg);
    if ("conv" in r) convs.push(r.conv);
    else descartes[r.descartada] = (descartes[r.descartada] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(descartes)) notas.push(`descartadas ${k}: ${n}`);
  if (descartes.control_anonimizacion) log(`mejora-mensual: ${descartes.control_anonimizacion} conversaciones descartadas por el control de anonimización`);

  const presu = opciones.presupuestoUsd ?? presupuesto(cfg).clasificacion_usd;
  const rec = recortarAlPresupuesto(convs, presu, cfg, opciones.precio ?? null, opciones.semilla ?? rango.mes);
  notas.push(...rec.notas);
  return { mes: rango.mes, total: convs.length, conversaciones: rec.incluidas, recortadas_por_tope: rec.excluidas, notas };
}

// ---------- I/O real (Supabase) ----------

const PAGINA = 1000;
const TROZO_IN = 150;

function trozos<T>(xs: T[], n = TROZO_IN): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function falla(ctx: string, error: { message: string } | null): void {
  if (error) throw new Error(`${ctx}: ${error.message}`);
}

export async function depsReales(): Promise<DepsDatos> {
  const { db } = await import("../_shared/db.ts");
  return {
    async mensajesEntre(desde, hasta) {
      const out: MensajeCrudo[] = [];
      for (let desdeFila = 0;; desdeFila += PAGINA) {
        const { data, error } = await db().from("wa_mensajes")
          .select(
            "conversacion_id,direccion,tipo,texto,creado_en," +
              "transcripcion:contenido->>transcripcion,texto_vendedor:contenido->>texto_vendedor," +
              "boton:contenido->interactive->button_reply->>title,boton2:contenido->button->>text," +
              "lista:contenido->interactive->list_reply->>title,caption_img:contenido->image->>caption",
          )
          .gte("creado_en", desde).lt("creado_en", hasta).not("conversacion_id", "is", null)
          .order("creado_en", { ascending: true }).order("id", { ascending: true })
          .range(desdeFila, desdeFila + PAGINA - 1);
        falla("wa_mensajes", error);
        out.push(...((data ?? []) as unknown as MensajeCrudo[]));
        if (!data || data.length < PAGINA) break;
      }
      return out;
    },
    async resultados(ids) {
      const out: ConversacionResultado[] = [];
      for (const t of trozos(ids)) {
        const { data, error } = await db().from("conversacion_resultado").select("*").in("conversacion_id", t);
        falla("conversacion_resultado", error);
        out.push(...((data ?? []) as ConversacionResultado[]));
      }
      return out;
    },
    async contextos(ids) {
      const convs: { id: string; cliente_id: string | null }[] = [];
      for (const t of trozos(ids)) {
        const { data, error } = await db().from("wa_conversaciones").select("id,cliente_id").in("id", t);
        falla("wa_conversaciones", error);
        convs.push(...(data ?? []));
      }
      const clienteIds = [...new Set(convs.map((c) => c.cliente_id).filter((x): x is string => !!x))];
      const clientes = new Map<string, { id: string; nombre: string | null; wa_username: string | null; telefono: string | null }>();
      for (const t of trozos(clienteIds)) {
        const { data, error } = await db().from("wa_clientes").select("id,nombre,wa_username,telefono").in("id", t);
        falla("wa_clientes", error);
        for (const c of data ?? []) clientes.set(c.id, c);
      }
      const selPedido = "shopify_order_id,nombre,telefono,cliente_id," +
        "envio:raw->shipping_address,factura:raw->billing_address,cliente_shopify:raw->customer";
      type FilaPedido = { shopify_order_id: number; nombre: string | null; telefono: string | null; cliente_id: string | null; envio: Obj; factura: Obj; cliente_shopify: Obj };
      const pedidosPorCliente = new Map<string, FilaPedido[]>();
      const pedidosPorTel = new Map<string, FilaPedido[]>();
      for (const t of trozos(clienteIds)) {
        const { data, error } = await db().from("shopify_pedidos").select(selPedido).in("cliente_id", t);
        falla("shopify_pedidos", error);
        for (const p of (data ?? []) as unknown as FilaPedido[]) {
          if (!pedidosPorCliente.has(p.cliente_id!)) pedidosPorCliente.set(p.cliente_id!, []);
          pedidosPorCliente.get(p.cliente_id!)!.push(p);
        }
      }
      const tels = [...new Set([...clientes.values()].map((c) => c.telefono).filter((x): x is string => !!x))];
      for (const t of trozos(tels)) {
        const { data, error } = await db().from("shopify_pedidos").select(selPedido).in("telefono", t);
        falla("shopify_pedidos (tel)", error);
        for (const p of (data ?? []) as unknown as FilaPedido[]) {
          if (!pedidosPorTel.has(p.telefono!)) pedidosPorTel.set(p.telefono!, []);
          pedidosPorTel.get(p.telefono!)!.push(p);
        }
      }
      const chatPorConv = new Map<string, { datos: Obj; shopify_order_id: number | null }[]>();
      for (const t of trozos(ids)) {
        const { data, error } = await db().from("wa_pedidos_chat").select("conversacion_id,datos,shopify_order_id").in("conversacion_id", t);
        falla("wa_pedidos_chat", error);
        for (const p of data ?? []) {
          if (!chatPorConv.has(p.conversacion_id)) chatPorConv.set(p.conversacion_id, []);
          chatPorConv.get(p.conversacion_id)!.push(p);
        }
      }
      return convs.map((c) => {
        const cliente = c.cliente_id ? clientes.get(c.cliente_id) ?? null : null;
        const pedidos = [
          ...(c.cliente_id ? pedidosPorCliente.get(c.cliente_id) ?? [] : []),
          ...(cliente?.telefono ? pedidosPorTel.get(cliente.telefono) ?? [] : []),
        ];
        return contextoDesdeFilas({ conversacion_id: c.id, cliente, pedidos, pedidosChat: chatPorConv.get(c.id) ?? [] });
      });
    },
  };
}
