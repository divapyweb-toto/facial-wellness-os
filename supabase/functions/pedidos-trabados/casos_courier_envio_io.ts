// pedidos-trabados · I/O de casos_courier_envio.ts: tabla casos_courier (migración 20261104000001), entregas,
// shopify_pedidos, vistas entregas_plazo_pap y rendicion_atrasada, candados en eventos_crudos y Telegram reales.
import type { CasoCourier, RendicionPendiente } from "../_shared/casos_courier.ts";
import { db } from "../_shared/db.ts";
import { datosCourierDesdeRaw } from "../_shared/texto_courier.ts";
import { diaPy, pedidoDeRef } from "./entregas_actuar.ts";
import { depsReales as depsActuar, filasRendicion } from "./entregas_actuar_io.ts";
import { filasPlazoPap } from "./plazo_pap_io.ts";
import {
  casosNoEncontrada, type CasoSistemaNuevo, claveCiudad, DIA_YA_AVISADOS, type DatosPedidoCaso, type DepsCasos, type DepsSistema, enviarCasos,
  estadoBase, type FilaLuceroCurso, loteConEstado, nuevosPlazoLucero, nuevosPlazoPap, planificarEnvios, procesarCasosSistema, YA_AVISADOS_04_11,
} from "./casos_courier_envio.ts";

type Obj = Record<string, unknown>;
const str = (x: unknown) => (x == null || String(x).trim() === "" ? null : String(x).trim());
const trozos = <T>(xs: T[], n = 100) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function leerCasos(filtro: { estado?: string; origen?: string }): Promise<CasoCourier[]> {
  let q = db().from("casos_courier").select("*").order("creado_en", { ascending: true });
  if (filtro.estado) q = q.eq("estado", filtro.estado);
  if (filtro.origen) q = q.eq("origen", filtro.origen);
  const { data, error } = await q;
  if (error) throw new Error(`casos_courier: ${error.message}`);
  return (data ?? []).map((x: Obj) => ({ ...x, shopify_order_id: Number(x.shopify_order_id), urgente: x.urgente === true }) as CasoCourier);
}

/** Entregas de Voltra por ref (la más nueva si hubiera dos). */
async function entregasPorRef(refs: string[]): Promise<Map<string, Obj>> {
  const m = new Map<string, Obj>();
  for (const t of trozos([...new Set(refs)])) {
    const { data, error } = await db().from("entregas")
      .select("n_referencia,transportadora,estado_pap,categoria,fecha_ingreso,nro_guia_pap,ciudad,nombre_courier,lucero_web_error,created_at")
      .eq("tienda", "voltra").in("n_referencia", t).order("created_at", { ascending: true });
    if (error) throw new Error(`entregas: ${error.message}`);
    for (const x of data ?? []) m.set(String(x.n_referencia), x as Obj);
  }
  return m;
}

/** Nombre y ciudad del envío (shopify_pedidos.raw → shipping_address). */
async function envioPorRef(refs: string[]): Promise<Map<string, { nombre: string | null; ciudad: string | null; id: number }>> {
  const m = new Map<string, { nombre: string | null; ciudad: string | null; id: number }>();
  for (const t of trozos([...new Set(refs)])) {
    const { data, error } = await db().from("shopify_pedidos").select("shopify_order_id,nombre,raw->shipping_address")
      .eq("es_borrador", false).in("nombre", t.map(pedidoDeRef));
    if (error) throw new Error(`shopify_pedidos: ${error.message}`);
    for (const x of (data ?? []) as Obj[]) {
      const d = datosCourierDesdeRaw(String(x.nombre), { shipping_address: x.shipping_address }, null);
      m.set(`VT-${String(x.nombre).replace("#", "")}`, {
        nombre: d.nombre === "Cliente" ? null : d.nombre, ciudad: d.ciudad === "?" ? null : d.ciudad, id: Number(x.shopify_order_id),
      });
    }
  }
  return m;
}

/** Guía PaP, fecha de ingreso, estado y nombre del courier (entregas) + ciudad del envío (Shopify; si falta, la del courier). */
export async function datosPedidos(refs: string[], conEnvio: string[] = refs): Promise<Map<string, DatosPedidoCaso>> {
  const [ent, env] = await Promise.all([entregasPorRef(refs), conEnvio.length ? envioPorRef(conEnvio) : Promise.resolve(new Map())]);
  const m = new Map<string, DatosPedidoCaso>();
  for (const ref of new Set(refs)) {
    const e = ent.get(ref), s = env.get(ref);
    const noEncontrada = e?.transportadora === "lucero" && e?.lucero_web_error === "no_encontrado";
    // 04-11 (FUNCIONES): en las no encontradas fecha_ingreso/estado_pap están viejos; la carga es created_at.
    const ingreso = noEncontrada ? (e?.created_at ? diaPy(new Date(String(e.created_at))) : null) : str(e?.fecha_ingreso)?.slice(0, 10) ?? null;
    m.set(ref, {
      // 04-11 (coordinador): el nombre como figura en la guía del courier (lo que ellos buscan); si no hay, el de Shopify.
      nombre: str(e?.nombre_courier) ?? s?.nombre ?? null, ciudad: s?.ciudad ?? str(e?.ciudad), fechaIngreso: ingreso,
      guiaPap: str(e?.nro_guia_pap), estadoCourier: str(e?.estado_pap), categoria: str(e?.categoria), noEncontrada,
    });
  }
  return m;
}

/** Lucero en curso (ni entregado ni devuelto), sin pedidos de prueba. */
export async function filasLucero(): Promise<FilaLuceroCurso[]> {
  const { data, error } = await db().from("entregas").select("n_referencia,estado_pap,categoria,fecha_ingreso,lucero_web_error,ciudad")
    .eq("tienda", "voltra").eq("transportadora", "lucero").or("categoria.is.null,categoria.not.in.(entregado,devuelto)");
  if (error) throw new Error(`entregas lucero: ${error.message}`);
  return (data ?? []).filter((x: Obj) => !/prueba|test/i.test(String(x.n_referencia))).map((x: Obj) => ({
    ref: String(x.n_referencia), estado: String(x.estado_pap ?? ""), categoria: str(x.categoria),
    fechaIngreso: str(x.fecha_ingreso), noEncontrada: x.lucero_web_error === "no_encontrado", ciudad: str(x.ciudad),
  }));
}

/** dias_max de la tarifa de Lucero por ciudad (rpc sugerir_courier, una llamada por ciudad). Si una falla, rige el umbral fijo. */
export async function diasMaxLucero(ciudades: Array<string | null | undefined>): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const unicas = [...new Set(ciudades.map((c) => String(c ?? "").trim()).filter(Boolean))];
  await Promise.all(unicas.map(async (ciudad) => {
    const { data, error } = await db().rpc("sugerir_courier", { p_ciudad: ciudad, p_cod: true });
    if (error) return console.warn(`casos_courier: sugerir_courier('${ciudad}') falló:`, error.message);
    const ops = (Array.isArray((data as Obj | null)?.opciones) ? (data as Obj).opciones : []) as Obj[];
    const d = Number(ops.find((o) => o.courier === "lucero")?.dias_max);
    if (ops.some((o) => o.courier === "lucero") && Number.isFinite(d) && d > 0) m.set(claveCiudad(ciudad), d);
  }));
  return m;
}

/** Pedido de Shopify vivo (no cancelado, ni de prueba, ni reemplazado) para la ref; null si no corresponde. */
async function pedidoVivo(ref: string): Promise<number | null> {
  const { data, error } = await db().from("shopify_pedidos").select("shopify_order_id,tags,raw->>cancelled_at")
    .eq("nombre", pedidoDeRef(ref)).eq("es_borrador", false).maybeSingle();
  if (error) throw new Error(`shopify_pedidos: ${error.message}`);
  if (!data) return null;
  const p = data as Obj, tags = ((p.tags ?? []) as string[]).map((t) => String(t).toUpperCase());
  if (p.cancelled_at || tags.some((t) => t.includes("PRUEBA") || t.startsWith("REEMPLAZADO") || t === "CANCELADO_CLIENTE")) return null;
  return Number(p.shopify_order_id);
}

export const depsSistemaReales: DepsSistema = {
  async insertarCaso(c: CasoSistemaNuevo) {
    const id = await pedidoVivo(c.ref);
    if (!id) return "sin_pedido";
    const { error } = await db().from("casos_courier").insert({ shopify_order_id: id, ref: c.ref, courier: c.courier, origen: "sistema", tipo: c.tipo, pide: c.pide });
    if (!error) return "insertado";
    if (error.code === "23505") return "ya_pendiente";
    throw new Error(`casos_courier: ${error.message}`);
  },
  async actualizarCaso(id, cambios) {
    const { error } = await db().from("casos_courier").update(cambios).eq("id", id);
    if (error) throw new Error(`casos_courier: ${error.message}`);
  },
};

export const depsCasosReales: DepsCasos = {
  tomarCandado: depsActuar.tomarCandado, soltarCandado: depsActuar.soltarCandado, existeCandado: depsActuar.existeCandado,
  avisar: depsActuar.avisar, esperar: depsActuar.esperar,
  async marcarEnviados(casos, lote, ahora) {
    for (const c of casos) {
      // Solo si sigue pendiente (si alguien lo cerró a mano mientras tanto, se respeta).
      const { error } = await db().from("casos_courier").update({ estado: "enviado", enviado_en: ahora.toISOString(), lote: lote(c) })
        .eq("id", c.id).eq("estado", "pendiente");
      if (error) throw new Error(`casos_courier: ${error.message}`);
    }
  },
};

/** Rendiciones atrasadas de PaP (vista rendicion_atrasada), sin datos de cuenta. */
export async function rendicionesPap(): Promise<RendicionPendiente[]> {
  return (await filasRendicion()).filter((r) => r.courier === "pap").map((r) => ({ ref: r.ref, monto: r.montoNeto, fechaEntrega: r.fechaEntrega }));
}

/** Entrada del cron de 10 min: casos nuevos y seguimiento del sistema, después el Telegram por courier (o los urgentes). */
export async function casosParaCourier(ahora: Date, simular: boolean) {
  const atrapar = (nombre: string) => (e: unknown) => ({ error: `${nombre}: ${e instanceof Error ? e.message : String(e)}` });
  const sistema = await (async () => {
    const [pap, lucero, existentes] = await Promise.all([filasPlazoPap(), filasLucero(), leerCasos({ origen: "sistema" })]);
    const nuevos = [
      ...nuevosPlazoPap(pap, ahora),
      ...nuevosPlazoLucero(lucero, ahora, await diasMaxLucero(lucero.map((f) => f.ciudad))),
      ...casosNoEncontrada(lucero.filter((f) => f.noEncontrada).map((f) => f.ref)),
    ];
    const vivos = existentes.filter((c) => c.estado !== "cerrado").map((c) => c.ref);
    const datos = await datosPedidos([...vivos, ...nuevos.map((n) => n.ref)], []);
    return await procesarCasosSistema(nuevos, existentes, datos, ahora, depsSistemaReales, simular);
  })().catch(atrapar("casos_sistema"));
  const envios = await (async () => {
    const pendientes = await leerCasos({ estado: "pendiente" });
    const rend = await rendicionesPap().catch(() => [] as RendicionPendiente[]);
    const plan = planificarEnvios(pendientes, ahora, rend.length > 0);
    if (!plan.length) return [];
    const refs = plan.flatMap((e) => e.casos.map((c) => c.ref));
    return await enviarCasos(plan, await datosPedidos(refs), rend, ahora, depsCasosReales, simular);
  })().catch(atrapar("casos_envio"));
  return { sistema, envios };
}

/**
 * 04-11 (Enrique): los casos que mandó a mano hoy se cargan como 'enviado' (enviado_en 04-11, lote "manual:2026-11-04")
 * para que no salgan en el primer Telegram y entren en la regla de reenvío a los 2 días hábiles. Lucero no encontrada →
 * tipo 'no_encontrada'; el resto 'plazo'. Idempotente (si la ref ya tiene un caso del sistema, no hace nada).
 * La corre el coordinador al desplegar: body {sembrar_casos_avisados: true, modo: "aplicar"} (sin "aplicar" solo simula).
 */
export async function sembrarYaAvisados(simular: boolean, refs = YA_AVISADOS_04_11) {
  const [existentes, ent, ids] = await Promise.all([
    leerCasos({ origen: "sistema" }), datosPedidos(refs, []), Promise.all(refs.map(async (r) => [r, await pedidoVivo(r).catch(() => null)] as const)),
  ]);
  const crudas = await entregasPorRef(refs);
  const hechos: Array<{ ref: string; resultado: string }> = [];
  for (const [ref, id] of ids) {
    const e = crudas.get(ref), d = ent.get(ref);
    if (existentes.some((c) => c.ref === ref)) { hechos.push({ ref, resultado: "ya_sembrado" }); continue; }
    if (!e || !id || (e.transportadora !== "lucero" && e.transportadora !== "pap")) { hechos.push({ ref, resultado: "sin_pedido_o_entrega" }); continue; }
    const tipo = d?.noEncontrada ? "no_encontrada" as const : "plazo" as const;
    const fila = {
      shopify_order_id: id, ref, courier: e.transportadora, origen: "sistema", tipo, estado: "enviado",
      pide: "Enviado a mano por Enrique el 04/11", enviado_en: `${DIA_YA_AVISADOS}T12:00:00-03:00`,
      lote: loteConEstado(`manual:${DIA_YA_AVISADOS}`, estadoBase(tipo, d)),
    };
    if (simular) { hechos.push({ ref, resultado: `simulado: ${tipo} ${fila.lote}` }); continue; }
    const { error } = await db().from("casos_courier").insert(fila);
    hechos.push({ ref, resultado: error ? `error: ${error.message}` : `sembrado: ${tipo}` });
  }
  return { sembrar_casos_avisados: hechos };
}
