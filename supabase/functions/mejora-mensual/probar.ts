// mejora-mensual/probar.ts · Dueño: M2 (ciclo mensual de mejora del vendedor)
//
// Corre la batería de 50 conversaciones (supabase/vendedor/pruebas/) con la versión PROPUESTA del vendedor:
// el prompt + ejemplos + FAQ + orden de objeciones de la versión se inyectan como config_wa.vendedor_prompt
// en el vendedor real de G1 (vía supabase/vendedor/adaptador_vendedor.ts, que corre en Deno con
// dependencias falsas) y cada caso se evalúa con supabase/vendedor/evaluador.mjs (reglas de
// auditoria-diaria/reglas.ts + expectativas del caso).
//
// Descarte: una sola palabra prohibida, un solo precio fuera del catálogo del caso o una sola promesa de
// salud ⇒ aprobada = false. Antes de gastar en la batería se revisa el contenido nuevo de la versión
// (si trae una prohibida o un monto, se descarta sin correr nada).
// Modo simulado (por defecto sin ANTHROPIC_API_KEY o con MODO_SIMULADO=1): el vendedor usa el simulador
// determinista de _shared/claude.ts; no hay red.
//
// En una Edge Function: los .json de la batería no viajan solos (solo se despliega lo que se importa). Por
// eso la batería por defecto es bateria_embebida.ts (generada desde supabase/vendedor/pruebas/ con
// scripts/generar-bateria-embebida.mjs; un test verifica que esté al día). La semilla la pasa index.ts
// con las filas reales de config_wa. El adaptador y el evaluador se importan estáticos: el despliegue con
// `supabase functions deploy --use-api` sube también los archivos importados fuera de functions/.

import { _configurarClaude, calcularCostoUsd, esModoSimulado, precioDe, type TablaPrecios } from "../_shared/claude.ts";
import { evaluarCaso, fragmentosDelPrompt } from "../../vendedor/evaluador.mjs";
import { PROHIBIDAS_POR_DEFECTO } from "../auditoria-diaria/reglas.ts";
import { armarPromptVersion, contenidoNuevo, type RevisionContenido, revisarTextos, type VersionVendedor } from "./proponer.ts";
import { correrCaso, filasDeSemilla } from "../../vendedor/adaptador_vendedor.ts";
import { CASOS_BATERIA, COMUN_BATERIA } from "./bateria_embebida.ts";

// ------------------------------------------------------------------ tipos

/** Forma de un caso y de _comun.json (la misma que usa supabase/vendedor/adaptador_vendedor.ts). */
export type Caso = { id: string; cliente: { nombre: string; telefono: string | null; wa_username: string | null }; contexto: Record<string, unknown> & { catalogo: unknown }; mensajes: (string | string[])[] };
export type Comun = { envio?: number; catalogos?: Record<string, unknown[]>; afirmaciones_permitidas?: string[] };

export type CasoBateria = Caso & { expectativas?: Record<string, unknown>; titulo?: string; cobertura?: string[] };
export type TurnoResultado = { entrada: string; respuestas: string[]; herramientas: { nombre: string }[]; costo_usd?: number; error?: string; derivado?: boolean };
export type ResultadoCaso = { turnos: TurnoResultado[]; error?: string };

export type Ejecutor = (caso: CasoBateria, comun: Comun, ctx: { plantilla: string; modelo: string; semilla: Record<string, unknown> }) => Promise<ResultadoCaso>;
export type Juez = (caso: CasoBateria, resultado: ResultadoCaso) => Promise<{ puntaje: number | null; costo_usd: number }>;

export type DepsPrueba = {
  casos?: CasoBateria[];
  comun?: Comun;
  /** Filas de config_wa (o de seed_vendedor.sql). */
  semilla?: Record<string, unknown>;
  modelo?: string;
  simulado?: boolean;
  ejecutor?: Ejecutor;
  juez?: Juez;
  /** Versión activa: el chequeo previo revisa solo el contenido nuevo respecto de ella. */
  base?: VersionVendedor | null;
  prohibidas?: string[];
  /** Si se pasa, la versión tiene que aprobar al menos estos casos (por ejemplo, los de la versión activa). */
  minAprobados?: number;
  /** Tope en USD: si la estimación lo supera, no se corre y la versión queda sin aprobar. */
  topeUsd?: number;
  precios?: TablaPrecios | null;
};

export type ResultadoPrueba = {
  aprobada: boolean;
  casos: number;
  prohibidas: number;
  precios_fuera: number;
  tono_prom: number | null;
  detalle: {
    motivo_descarte: string | null;
    aprobados: number;
    promesas_salud: number;
    revela_instrucciones: number;
    errores: number;
    estatico: RevisionContenido | null;
    fallas: { id: string; fallas: { codigo: string; detalle?: string; turno?: number }[] }[];
    costo_usd: number;
    costo_estimado_usd: number | null;
    simulado: boolean;
    modelo: string;
  };
};

// ------------------------------------------------------------------ batería en disco

const DIR_PRUEBAS = new URL("../../vendedor/pruebas/", import.meta.url);
const SEMILLA = new URL("../../seed_vendedor.sql", import.meta.url);

export async function cargarBateria(dir: URL = DIR_PRUEBAS): Promise<{ casos: CasoBateria[]; comun: Comun }> {
  const nombres: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && /^\d+.*\.json$/.test(e.name)) nombres.push(e.name);
  nombres.sort();
  const casos = await Promise.all(nombres.map(async (n) => JSON.parse(await Deno.readTextFile(new URL(n, dir))) as CasoBateria));
  const comun = JSON.parse(await Deno.readTextFile(new URL("_comun.json", dir))) as Comun;
  return { casos, comun };
}

export async function cargarSemillaLocal(): Promise<Record<string, unknown>> {
  try {
    return filasDeSemilla(await Deno.readTextFile(SEMILLA));
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ costo estimado (puro)

/**
 * Estimación previa de la batería. Supuestos (ajustables): ~6.000 tokens de prefijo (prompt + herramientas)
 * cacheado 1 h, ~1,7 llamadas por turno (bucle de herramientas), ~1.200 tokens de cola sin caché y
 * ~350 de salida por llamada. Sin precio del modelo en config_wa.precios_claude devuelve null.
 */
export function estimarCostoPrueba(
  casos: { mensajes: unknown[] }[],
  modelo: string,
  precios: TablaPrecios | null | undefined,
  s: { prefijo?: number; llamadasPorTurno?: number; cola?: number; salida?: number } = {},
): number | null {
  const precio = precioDe(modelo, precios);
  if (!precio) return null;
  const turnos = casos.reduce((n, c) => n + c.mensajes.length, 0);
  const llamadas = Math.ceil(turnos * (s.llamadasPorTurno ?? 1.7));
  const prefijo = s.prefijo ?? 6000;
  const uso = {
    entrada: llamadas * (s.cola ?? 1200),
    salida: llamadas * (s.salida ?? 350),
    cache_lectura: Math.max(llamadas - 1, 0) * prefijo,
    cache_escritura: prefijo,
    cache_escritura_1h: prefijo,
    cache_escritura_5m: 0,
  };
  return calcularCostoUsd(uso, precio);
}

// ------------------------------------------------------------------ ejecutor por defecto

/** Corre el vendedor de G1 con la plantilla de la versión inyectada como config_wa.vendedor_prompt. */
export const ejecutorVendedor: Ejecutor = async (caso, comun, ctx) => {
  const semilla = { ...ctx.semilla, vendedor_prompt: ctx.plantilla };
  type Args = Parameters<typeof correrCaso>;
  return await correrCaso(caso as unknown as Args[0], comun as unknown as Args[1], ctx.modelo, semilla) as unknown as ResultadoCaso;
};

// ------------------------------------------------------------------ probar

export async function probarVersion(version: VersionVendedor, deps: DepsPrueba = {}): Promise<ResultadoPrueba> {
  const prohibidas = deps.prohibidas ?? PROHIBIDAS_POR_DEFECTO;
  const semilla = deps.semilla ?? await cargarSemillaLocal();
  const vendedorCfg = (semilla.vendedor ?? {}) as { modelo?: string };
  const modelo = deps.modelo ?? vendedorCfg.modelo ?? "claude-haiku-4-5";
  const simulado = deps.simulado ?? esModoSimulado();
  const bateria = deps.casos && deps.comun ? { casos: deps.casos, comun: deps.comun } : { casos: CASOS_BATERIA, comun: COMUN_BATERIA };
  const { casos, comun } = bateria;
  const precios = deps.precios ?? (semilla.precios_claude as TablaPrecios | undefined) ?? null;
  const estimado = simulado ? 0 : estimarCostoPrueba(casos, modelo, precios);

  const vacio = (motivo: string, estatico: RevisionContenido | null): ResultadoPrueba => ({
    aprobada: false,
    casos: 0,
    prohibidas: estatico?.prohibidas.length ?? 0,
    precios_fuera: estatico?.precios.length ?? 0,
    tono_prom: null,
    detalle: {
      motivo_descarte: motivo, aprobados: 0, promesas_salud: estatico?.salud.length ?? 0, revela_instrucciones: 0, errores: 0,
      estatico, fallas: [], costo_usd: 0, costo_estimado_usd: estimado, simulado, modelo,
    },
  });

  // 1) Chequeo previo, gratis: el contenido nuevo de la versión.
  const estatico = revisarTextos(contenidoNuevo(version, deps.base ?? null), prohibidas);
  if (estatico.prohibidas.length) return vacio(`palabra prohibida en la versión: ${estatico.prohibidas.join(", ")}`, estatico);
  if (estatico.precios.length) return vacio(`monto escrito en la versión (los precios salen de Shopify): ${estatico.precios.join(", ")}`, estatico);
  if (estatico.salud.length) return vacio(`promesa de salud en la versión: ${estatico.salud.join(", ")}`, estatico);

  // 2) Tope de costo.
  if (!simulado && typeof deps.topeUsd === "number") {
    if (estimado === null) return vacio(`sin precio de ${modelo} en config_wa.precios_claude: no se puede respetar el tope`, estatico);
    if (estimado > deps.topeUsd) return vacio(`costo estimado USD ${estimado.toFixed(2)} supera el tope USD ${deps.topeUsd.toFixed(2)}`, estatico);
  }

  // 3) Batería.
  const plantilla = armarPromptVersion(version);
  const fragmentos = fragmentosDelPrompt(version.prompt);
  const ejecutor = deps.ejecutor ?? ejecutorVendedor;
  const usarSimulador = simulado && !deps.ejecutor;
  const logOriginal = console.log;
  if (usarSimulador) {
    _configurarClaude({ modoSimulado: () => true, apiKey: () => undefined, precios: () => Promise.resolve(null) });
    console.log = () => {};
  }
  let prohib = 0, precios_fuera = 0, salud = 0, revela = 0, errores = 0, aprobados = 0, costo = 0;
  const fallas: ResultadoPrueba["detalle"]["fallas"] = [];
  const tonos: number[] = [];
  try {
    for (const caso of casos) {
      let r: ResultadoCaso;
      try {
        r = await ejecutor(caso, comun, { plantilla, modelo, semilla });
      } catch (e) {
        r = { turnos: [], error: e instanceof Error ? e.message : String(e) };
      }
      for (const t of r.turnos ?? []) costo += t.costo_usd ?? 0;
      const ev = evaluarCaso(caso, r, comun, { prohibidas, fragmentosPrompt: fragmentos });
      prohib += ev.conteos.palabras_prohibidas;
      precios_fuera += ev.conteos.precios_inventados;
      salud += ev.conteos.promesas_salud;
      revela += ev.conteos.revela_instrucciones;
      errores += ev.fallas.filter((f: { codigo: string }) => f.codigo === "error").length;
      if (ev.aprobado) aprobados++;
      else fallas.push({ id: caso.id, fallas: ev.fallas });
      if (deps.juez) {
        const j = await deps.juez(caso, r);
        costo += j.costo_usd ?? 0;
        if (typeof j.puntaje === "number") tonos.push(j.puntaje);
      }
    }
  } finally {
    if (usarSimulador) {
      _configurarClaude();
      console.log = logOriginal;
    }
  }

  const motivos: string[] = [];
  if (prohib) motivos.push(`${prohib} palabra(s) prohibida(s)`);
  if (precios_fuera) motivos.push(`${precios_fuera} precio(s) fuera de catálogo`);
  if (salud) motivos.push(`${salud} promesa(s) de salud`);
  if (errores) motivos.push(`${errores} error(es) del vendedor`);
  if (typeof deps.minAprobados === "number" && aprobados < deps.minAprobados) {
    motivos.push(`aprobó ${aprobados} casos, menos que los ${deps.minAprobados} de la versión activa`);
  }
  return {
    aprobada: motivos.length === 0,
    casos: casos.length,
    prohibidas: prohib,
    precios_fuera,
    tono_prom: tonos.length ? Math.round((tonos.reduce((s, x) => s + x, 0) / tonos.length) * 100) / 100 : null,
    detalle: {
      motivo_descarte: motivos.length ? motivos.join("; ") : null,
      aprobados,
      promesas_salud: salud,
      revela_instrucciones: revela,
      errores,
      estatico,
      fallas,
      costo_usd: Math.round(costo * 1e6) / 1e6,
      costo_estimado_usd: estimado,
      simulado,
      modelo,
    },
  };
}
