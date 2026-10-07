// mejora-mensual · Dueño: M3 (ciclo mensual de mejora del vendedor)
// La llama pg_cron (migración 20261006000013_cron_mejora_mensual.sql) con la service role: el día 1
// a las 09:00 de Asunción y cada 30 min hasta el día 3. Cada corrida sigue el ciclo desde donde quedó
// (la máquina de estados está en aprobacion.ts). POST opcional {mes:'YYYY-MM-01'} para correr un mes
// a mano. Sin ANTHROPIC_API_KEY (o con MODO_SIMULADO=1) Claude corre simulado y el mensaje lo dice.
import { db } from "../_shared/db.ts";
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { avisar } from "../_shared/telegram.ts";
import { esModoSimulado, llamarClaudeLote, type PrecioModelo, precioDe, type TablaPrecios } from "../_shared/claude.ts";
import {
  type CambioMin,
  type Ciclo,
  type Clasificacion,
  type DepsCiclo,
  ejecutarCiclo,
  type EstadoLoteMin,
  leerConfig,
  type VersionMin,
} from "./aprobacion.ts";
import { type CfgMejora, type ConversacionParaAnalizar, leerCfgMejora } from "./tipos.ts";
import { recolectarMes } from "./datos.ts";
import {
  armarLoteClasificacion,
  armarLoteReintento,
  type EnvioLote,
  enviarLoteClasificacion,
  estimarLote,
  leerResultadosLote,
  procesarResultados,
} from "./clasificar.ts";
import { agregar, type HallazgosSintesis, sintetizar } from "./sintetizar.ts";
import { aprendizajesDe, convsClasificadas, convsDelLote, idsDelLote, recoleccionParaCiclo, sintesisParaCiclo } from "./enlaces.ts";
import { proponer, type VersionVendedor } from "./proponer.ts";
import { probarVersion } from "./probar.ts";

const CAMPOS_CICLO =
  "id, mes, estado, n_conversaciones, lote_id, costo_usd, resumen, hallazgos, propuesta_version_id, prueba, telegram_message_id, error, actualizado_en";
const CAMPOS_VERSION = "id, numero, estado, prompt, ejemplos, faq, objeciones, origen, ciclo_id, notas";

function trozos<T>(xs: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function aCiclo(r: Record<string, unknown> | null): Ciclo | null {
  if (!r) return null;
  return { ...(r as unknown as Ciclo), costo_usd: r.costo_usd == null ? 0 : Number(r.costo_usd) };
}

async function config(clave: string): Promise<unknown> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", clave).maybeSingle();
  if (error) throw new Error(`config_wa.${clave}: ${error.message}`);
  return data?.valor ?? null;
}

/** Todas las filas de config_wa como {clave: valor} (semilla del vendedor para la batería). */
async function semillaConfig(): Promise<Record<string, unknown>> {
  const { data, error } = await db().from("config_wa").select("clave, valor");
  if (error) throw new Error(`config_wa: ${error.message}`);
  return Object.fromEntries((data ?? []).map((f) => [f.clave, f.valor]));
}

type V = VersionVendedor & VersionMin & Record<string, unknown>;

const REINTENTO_ESPERA_MS = 90_000;

// Contexto de M1 por corrida: cfg de mejora_mensual (formato de tipos.ts) y precio de Haiku.
let ctxM1: { cfg: CfgMejora; precio: PrecioModelo | null; prohibidas: string[] | undefined } | null = null;
async function contextoM1() {
  if (ctxM1) return ctxM1;
  const { cfg } = leerCfgMejora(await config("mejora_mensual"));
  const tabla = (await config("precios_claude")) as TablaPrecios | null;
  const pp = await config("palabras_prohibidas");
  ctxM1 = {
    cfg,
    precio: precioDe(cfg.modelo_clasificacion, tabla),
    prohibidas: Array.isArray(pp) ? pp.filter((x): x is string => typeof x === "string") : undefined,
  };
  return ctxM1;
}

// Conversaciones recolectadas en esta corrida (texto para el reintento de las inválidas) y la muestra que
// entró al lote (para el simulador y para detectar faltantes). En corridas siguientes del cron no están:
// se usan los ids guardados en resumen.muestra_ids.
let convsCorrida: { mes: string; convs: ConversacionParaAnalizar[] } | null = null;
let muestraCorrida: { mes: string; convs: ConversacionParaAnalizar[] } | null = null;

async function version(col: string, valor: string): Promise<V | null> {
  const { data, error } = await db().from("vendedor_versiones").select(CAMPOS_VERSION).eq(col, valor).maybeSingle();
  if (error) throw new Error(`vendedor_versiones: ${error.message}`);
  return (data as V | null) ?? null;
}

const deps: DepsCiclo<ConversacionParaAnalizar, V> = {
  ahora: () => new Date(),
  config: async () => leerConfig(await config("mejora_mensual")),

  async obtenerCiclo(mes) {
    const { data, error } = await db().from("mejora_ciclos").select(CAMPOS_CICLO).eq("mes", mes).maybeSingle();
    if (error) throw new Error(`mejora_ciclos: ${error.message}`);
    return aCiclo(data);
  },
  async crearCiclo(mes) {
    const ins = await db().from("mejora_ciclos").upsert(
      { mes, estado: "recolectando", costo_usd: 0 },
      { onConflict: "mes", ignoreDuplicates: true },
    );
    if (ins.error) throw new Error(`mejora_ciclos: ${ins.error.message}`);
    const c = await deps.obtenerCiclo(mes);
    if (!c) throw new Error("no se pudo crear el ciclo");
    return c;
  },
  async actualizarCiclo(id, cambios, visto) {
    const { data, error } = await db()
      .from("mejora_ciclos")
      .update({ ...cambios, actualizado_en: new Date().toISOString() })
      .eq("id", id)
      .eq("actualizado_en", visto)
      .select(CAMPOS_CICLO)
      .maybeSingle();
    if (error) throw new Error(`mejora_ciclos: ${error.message}`);
    return aCiclo(data);
  },

  async recolectar(mes, { topeUsd }) {
    const { cfg, precio } = await contextoM1();
    const r = await recolectarMes(mes, { cfg, precio, topeUsd });
    convsCorrida = { mes, convs: r.conversaciones };
    if (r.notas.length) console.log("mejora-mensual recolección:", r.notas.join(" · "));
    return recoleccionParaCiclo(r);
  },
  estimarCostoClasificacion(convs) {
    // contextoM1() ya está cargado: recolectar corre antes.
    if (!ctxM1?.precio) return convs.length * 0.002;
    return estimarLote(convs, ctxM1.cfg, ctxM1.precio).usd;
  },
  async crearLote(convs) {
    const { cfg, precio } = await contextoM1();
    // La muestra ya viene recortada al tope (aprobacion.ts + datos.ts): acá no se vuelve a recortar.
    const lote = armarLoteClasificacion(convs, { cfg, precio, presupuestoUsd: Number.MAX_SAFE_INTEGER });
    const envio = await enviarLoteClasificacion(lote, convs);
    const ids = new Set(lote.incluidas);
    const mes = convsCorrida?.mes ?? "";
    muestraCorrida = { mes, convs: convs.filter((c) => ids.has(c.conversacion_id)) };
    return { id: envio.lote_id, estado: envio.estado, simulado: envio.simulado, envio, ids: lote.incluidas } as EstadoLoteMin;
  },
  async consultarLote(id, ciclo) {
    const { cfg } = await contextoM1();
    const r = await leerResultadosLote(id, convsDelLote(muestraCorrida, ciclo), cfg, { esperados: idsDelLote(ciclo) });
    return { id, estado: r.estado, simulado: r.simulado, lectura: r } as EstadoLoteMin;
  },
  async leerResultados(lote, ciclo) {
    const { cfg, precio } = await contextoM1();
    const envio = lote.envio as EnvioLote | undefined;
    const lectura = (lote.lectura as Awaited<ReturnType<typeof leerResultadosLote>> | undefined) ??
      await leerResultadosLote(envio ?? lote.id, convsDelLote(muestraCorrida, ciclo), cfg, { esperados: idsDelLote(ciclo) });
    const validas = [...lectura.validas];
    let costo = lectura.costo_usd;
    let invalidas = lectura.invalidas.length + lectura.descartadas.length;
    // Reintento único de las inválidas (intento 2). Si no termina a tiempo, quedan afuera.
    if (lectura.invalidas.length) {
      try {
        const convs = convsCorrida?.mes === ciclo.mes ? convsCorrida.convs : (await recolectarMes(ciclo.mes, { cfg, precio })).conversaciones;
        const re = armarLoteReintento(lectura.invalidas, convs, cfg, precio);
        if (re.pedidos.length) {
          const ids = new Set(re.incluidas);
          const resultados = esModoSimulado()
            ? (await enviarLoteClasificacion(re, convs)).resultados ?? []
            : await llamarClaudeLote(re.pedidos, { esperar: true, maxEsperaMs: REINTENTO_ESPERA_MS, cadaMs: 10_000 })
              .then((e) => (e.estado === "ended" ? e.resultados ?? [] : []));
          const p = procesarResultados(resultados, ids, 2);
          validas.push(...p.validas);
          costo += p.costo_usd;
          invalidas = invalidas - p.validas.length;
        }
      } catch (e) {
        console.warn("mejora-mensual: falló el reintento de inválidas:", e instanceof Error ? e.message : e);
      }
    }
    return {
      clasificaciones: validas.map((c) => ({ conversacion_id: c.conversacion_id, etiquetas: c.etiquetas })),
      costo_usd: costo,
      invalidas,
    };
  },
  async guardarClasificaciones(cicloId, filas: Clasificacion[]) {
    for (const t of trozos(filas, 500)) {
      const { error } = await db().from("mejora_clasificaciones").upsert(
        t.map((f) => ({ ciclo_id: cicloId, conversacion_id: f.conversacion_id, etiquetas: f.etiquetas })),
        { onConflict: "ciclo_id,conversacion_id" },
      );
      if (error) throw new Error(`mejora_clasificaciones: ${error.message}`);
    }
  },
  async agregados(cicloId) {
    const filas: Clasificacion[] = [];
    for (let desde = 0; desde < 50_000; desde += 1000) {
      const { data, error } = await db()
        .from("mejora_clasificaciones")
        .select("conversacion_id, etiquetas")
        .eq("ciclo_id", cicloId)
        .range(desde, desde + 999);
      if (error) throw new Error(`mejora_clasificaciones: ${error.message}`);
      filas.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const resultados: Parameters<typeof convsClasificadas>[1] = [];
    for (const t of trozos(filas.map((f) => f.conversacion_id))) {
      const { data, error } = await db().from("conversacion_resultado").select("conversacion_id, resultado, derivado").in("conversacion_id", t);
      if (error) throw new Error(`conversacion_resultado: ${error.message}`);
      resultados.push(...(data ?? []));
    }
    const c = await db().from("mejora_ciclos").select("mes").eq("id", cicloId).maybeSingle();
    return agregar(convsClasificadas(filas, resultados), { mes: c.data?.mes ?? undefined });
  },
  async sintetizar(ag) {
    const { cfg } = await contextoM1();
    return sintesisParaCiclo(await sintetizar(ag as Parameters<typeof sintetizar>[0], { modelo: cfg.modelo_sintesis }));
  },
  aprendizajes: aprendizajesDe,
  versionActiva: async () => await version("estado", "activa"),
  async proponer(h, activa) {
    if (!activa) throw new Error("no hay versión activa del vendedor (falta cargar la semilla en vendedor_versiones)");
    const { prohibidas } = await contextoM1();
    const p = proponer(h as HallazgosSintesis, activa, { prohibidas });
    return { version: p.version as V | null, cambios: p.cambios as CambioMin[] };
  },
  async guardarPropuesta(cicloId, v, cambios) {
    const ya = await db().from("vendedor_versiones").select("id, numero, estado").eq("ciclo_id", cicloId).eq("estado", "propuesta").maybeSingle();
    if (ya.error) throw new Error(`vendedor_versiones: ${ya.error.message}`);
    if (ya.data) return ya.data as VersionMin;
    const max = await db().from("vendedor_versiones").select("numero").order("numero", { ascending: false }).limit(1).maybeSingle();
    if (max.error) throw new Error(`vendedor_versiones: ${max.error.message}`);
    const numero = (Number(max.data?.numero) || 0) + 1;
    const { data, error } = await db().from("vendedor_versiones").insert({
      numero,
      estado: "propuesta",
      prompt: v.prompt,
      ejemplos: v.ejemplos ?? [],
      faq: v.faq ?? [],
      objeciones: v.objeciones ?? [],
      origen: "mejora_mensual",
      ciclo_id: cicloId,
      notas: v.notas ?? null,
    }).select("id, numero, estado").single();
    if (error) throw new Error(`vendedor_versiones: ${error.message}`);
    await guardarCambios(cicloId, data.id, cambios);
    return data as VersionMin;
  },
  guardarPropuestaSoloCambios: (cicloId, cambios) => guardarCambios(cicloId, null, cambios),
  obtenerVersion: (id) => version("id", id),
  async probar(v, { restanteUsd }) {
    const base = await version("estado", "activa");
    const { prohibidas } = await contextoM1();
    const r = await probarVersion(v, { semilla: await semillaConfig(), base, prohibidas, topeUsd: restanteUsd });
    return { ...r, costo_usd: Number(r.detalle?.costo_usd) || 0 };
  },
  async marcarVersion(id, estado) {
    const { error } = await db().from("vendedor_versiones").update({ estado }).eq("id", id).neq("estado", "activa");
    if (error) throw new Error(`vendedor_versiones: ${error.message}`);
  },
  avisar: (html, botones) => avisar(html, botones),
};

async function guardarCambios(cicloId: string, versionId: string | null, cambios: CambioMin[]) {
  const ya = await db().from("mejora_cambios").select("id", { count: "exact", head: true }).eq("ciclo_id", cicloId);
  if (ya.error) throw new Error(`mejora_cambios: ${ya.error.message}`);
  if ((ya.count ?? 0) > 0 || !cambios.length) return; // ya guardados en una corrida anterior
  const { error } = await db().from("mejora_cambios").insert(cambios.map((c) => ({
    ciclo_id: cicloId,
    version_id: versionId,
    tipo: c.tipo,
    riesgo: c.riesgo,
    antes: c.antes ?? null,
    despues: c.despues ?? null,
    motivo: c.motivo ?? null,
    aplicado: false,
  })));
  if (error) throw new Error(`mejora_cambios: ${error.message}`);
}

Deno.serve(conServiceRole(async (req) => {
  const cuerpo = await req.json().catch(() => ({}));
  const mes = typeof cuerpo?.mes === "string" && /^\d{4}-\d{2}-01$/.test(cuerpo.mes) ? cuerpo.mes : undefined;
  ctxM1 = null; // config fresca en cada corrida
  convsCorrida = null;
  muestraCorrida = null;
  try {
    const r = await ejecutarCiclo(deps, { mes });
    console.log("mejora-mensual:", JSON.stringify(r));
    return Response.json({ ok: r.tipo !== "fallo", ...r });
  } catch (e) {
    // Fallas antes de tener ciclo (config, base): ejecutarCiclo no llegó a avisar.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("mejora-mensual:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
