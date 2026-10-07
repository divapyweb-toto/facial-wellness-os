#!/usr/bin/env node
// scripts/probar-vendedor.mjs · Dueño: G3 (batería de 50 conversaciones del vendedor de Voltra)
//
// Uso:
//   node scripts/probar-vendedor.mjs                      # simulado, sin red (para cada cambio)
//   node scripts/probar-vendedor.mjs --casos 15,26        # solo algunos casos
//   node scripts/probar-vendedor.mjs --vendedor referencia   # fuerza las respuestas de referencia
//   ANTHROPIC_API_KEY=... node scripts/probar-vendedor.mjs --real --modelos haiku,sonnet
//
// Simulado: si existe el vendedor de G1 (supabase/functions/_shared/vendedor/orquestador.ts) y
// Deno está instalado, corre el vendedor de verdad con MODO_SIMULADO=1 (sin red) a través del
// adaptador supabase/vendedor/adaptador_vendedor.ts. Si no, usa las respuestas de referencia
// escritas en cada caso: así se prueba la batería y el evaluador aunque el vendedor no exista.
//
// Real: corre los 50 casos con cada modelo (Claude de verdad, cuesta plata), pide al juez de tono
// un puntaje 1-5 por conversación y escribe un informe lado a lado con la recomendación según la
// regla de Enrique: si Haiku tiene 0 palabras prohibidas, 0 precios inventados y tono igual de
// natural que Sonnet (diferencia ≤ --tolerancia-tono, por defecto 0,3), va Haiku; si no, Sonnet
// con tope de USD 45 por mes.
//
// El informe va a logs/probar-vendedor/<fecha-hora>/ (logs/ está en .gitignore) o a --salida.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { costoUsd, evaluarCaso, fragmentosDelPrompt, juzgarTono } from "../supabase/vendedor/evaluador.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(AQUI, "..");
export const DIR_CASOS = path.join(RAIZ, "supabase/vendedor/pruebas");
export const ORQUESTADOR_G1 = path.join(RAIZ, "supabase/functions/_shared/vendedor/orquestador.ts");
export const ADAPTADOR = path.join(RAIZ, "supabase/vendedor/adaptador_vendedor.ts");
export const PROMPT_G1 = path.join(RAIZ, "supabase/vendedor/prompt_sistema.md");

export const ALIAS_MODELOS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-5-5" };
export const TOPE_SONNET_USD = 45;

// ------------------------------------------------------------------ casos

export function cargarCasos(dir = DIR_CASOS, filtro = null) {
  const comun = JSON.parse(fs.readFileSync(path.join(dir, "_comun.json"), "utf8"));
  let casos = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  if (filtro?.length) casos = casos.filter((c) => filtro.some((x) => c.id.startsWith(x)));
  return { comun, casos };
}

/** Problemas de forma de un caso (para que nadie agregue uno roto sin enterarse). */
export function validarCaso(caso) {
  const p = [];
  if (!caso.id) p.push("sin id");
  if (!Array.isArray(caso.mensajes) || !caso.mensajes.length) p.push("sin mensajes");
  else if (caso.mensajes.some((m) => (Array.isArray(m) ? !m.length || m.some((x) => typeof x !== "string") : typeof m !== "string"))) {
    p.push("mensaje mal armado (texto o lista de textos)");
  }
  if (!caso.cliente?.nombre) p.push("cliente sin nombre");
  if (!caso.expectativas) p.push("sin expectativas");
  if (!Array.isArray(caso.referencia) || caso.referencia.length !== caso.mensajes?.length) {
    p.push("referencia no tiene una respuesta por mensaje");
  }
  return p;
}

// ------------------------------------------------------------------ vendedores

/** Vendedor de referencia: devuelve las respuestas escritas en el caso (sin red, determinista). */
export function ejecutarReferencia(caso) {
  return {
    turnos: caso.mensajes.map((m, i) => {
      const r = caso.referencia?.[i] ?? { texto: "" };
      return {
        entrada: Array.isArray(m) ? m.join("\n") : m, // ráfaga: varios mensajes seguidos, una respuesta
        respuestas: Array.isArray(r.texto) ? r.texto : r.texto ? [r.texto] : [], // 2 burbujas = lista
        herramientas: r.herramientas ?? [],
        derivado: !!r.derivar,
        uso: { entrada: 0, salida: 0, cache_lectura: 0, cache_escritura: 0 },
        costo_usd: 0,
        latencia_ms: 0,
      };
    }),
  };
}

export function existeVendedorG1() {
  return fs.existsSync(ORQUESTADOR_G1);
}

function hayDeno() {
  return new Promise((ok) => {
    const p = spawn("deno", ["--version"], { stdio: "ignore" });
    p.on("error", () => ok(false));
    p.on("exit", (code) => ok(code === 0));
  });
}

/**
 * Corre el vendedor de G1 sobre los casos a través del adaptador (proceso Deno aparte).
 * Devuelve { [id]: ResultadoConversacion }.
 */
export function ejecutarG1(casos, comun, { modelo, real }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MODO_SIMULADO: real ? "0" : "1" };
    if (!real) delete env.ANTHROPIC_API_KEY; // simulado = jamás red
    const permisos = ["--allow-env", "--allow-read", ...(real ? ["--allow-net"] : [])];
    const p = spawn("deno", ["run", ...permisos, ADAPTADOR], { env, stdio: ["pipe", "pipe", "inherit"] });
    let salida = "";
    p.stdout.on("data", (d) => (salida += d));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`el adaptador del vendedor terminó con código ${code}`));
      try {
        resolve(JSON.parse(salida).resultados);
      } catch (e) {
        reject(new Error(`salida del adaptador ilegible: ${e.message}`));
      }
    });
    p.stdin.end(JSON.stringify({ casos, comun, modelo, simulado: !real }));
  });
}

// ------------------------------------------------------------------ batería

/**
 * Corre y evalúa todos los casos con un ejecutor `(caso) => ResultadoConversacion`
 * o con un mapa ya calculado `resultadosPrevios`.
 * @param {{casos: any[], comun: any, ejecutor?: (caso: any) => any, resultadosPrevios?: Record<string, any>,
 *          fragmentosPrompt?: string[], juez?: ((caso: any, resultado: any) => Promise<any>) | null}} p
 */
export async function correrBateria({ casos, comun, ejecutor, resultadosPrevios, fragmentosPrompt = [], juez = null }) {
  const filas = [];
  for (const caso of casos) {
    let resultado;
    try {
      resultado = resultadosPrevios ? resultadosPrevios[caso.id] ?? { turnos: [], error: "sin resultado" } : await ejecutor(caso);
    } catch (e) {
      resultado = { turnos: [], error: e instanceof Error ? e.message : String(e) };
    }
    const evaluacion = evaluarCaso(caso, resultado, comun, { fragmentosPrompt });
    const tono = juez ? await juez(caso, resultado) : null;
    filas.push({ caso, resultado, evaluacion, tono });
  }
  return { filas, resumen: resumir(filas) };
}

/** @param {any[]} filas */
export function resumir(filas) {
  const turnos = filas.flatMap((f) => f.resultado.turnos ?? []);
  const costo = turnos.reduce((s, t) => s + (t.costo_usd ?? 0), 0);
  const latencias = turnos.map((t) => t.latencia_ms).filter((n) => typeof n === "number" && n > 0);
  const tonos = filas.map((f) => f.tono?.puntaje).filter((n) => typeof n === "number");
  const suma = (k) => filas.reduce((s, f) => s + f.evaluacion.conteos[k], 0);
  const n = filas.length || 1;
  return {
    casos: filas.length,
    aprobados: filas.filter((f) => f.evaluacion.aprobado).length,
    palabras_prohibidas: suma("palabras_prohibidas"),
    precios_inventados: suma("precios_inventados"),
    promesas_salud: suma("promesas_salud"),
    revela_instrucciones: suma("revela_instrucciones"),
    no_deriva: suma("no_deriva"),
    muletillas_bot: suma("muletillas_bot"),
    markdown: suma("markdown"),
    tono_promedio: tonos.length ? tonos.reduce((a, b) => a + b, 0) / tonos.length : null,
    tono_evaluados: tonos.length,
    costo_total_usd: costo,
    costo_por_conversacion_usd: costo / n,
    costo_juez_usd: filas.reduce((s, f) => s + (f.tono?.costo_usd ?? 0), 0),
    latencia_promedio_ms: latencias.length ? latencias.reduce((a, b) => a + b, 0) / latencias.length : null,
    latencia_max_ms: latencias.length ? Math.max(...latencias) : null,
  };
}

/**
 * Regla de Enrique (6-oct-2026). `porModelo`: { haiku: resumen, sonnet: resumen }.
 * @param {Record<string, any>} porModelo
 * @param {number} [tolerancia]
 */
export function recomendar(porModelo, tolerancia = 0.3) {
  const h = porModelo.haiku;
  const s = porModelo.sonnet;
  if (!h || !s) return { modelo: null, texto: "Falta correr Haiku y Sonnet juntos (--modelos haiku,sonnet)." };
  const motivos = [];
  if (h.palabras_prohibidas > 0) motivos.push(`${h.palabras_prohibidas} palabra(s) prohibida(s)`);
  if (h.precios_inventados > 0) motivos.push(`${h.precios_inventados} precio(s) inventado(s)`);
  if (h.tono_promedio == null || s.tono_promedio == null) {
    return {
      modelo: null,
      texto: "Sin puntaje de tono (corré sin --sin-juez): no se puede aplicar la regla completa.",
      motivos,
    };
  }
  if (h.tono_promedio < s.tono_promedio - tolerancia) {
    motivos.push(`tono ${h.tono_promedio.toFixed(2)} contra ${s.tono_promedio.toFixed(2)} de Sonnet (tolerancia ${tolerancia})`);
  }
  if (!motivos.length) {
    return { modelo: ALIAS_MODELOS.haiku, texto: "Va Haiku: 0 palabras prohibidas, 0 precios inventados y tono igual de natural.", motivos };
  }
  const conv = s.costo_por_conversacion_usd > 0 ? Math.floor(TOPE_SONNET_USD / s.costo_por_conversacion_usd) : null;
  return {
    modelo: ALIAS_MODELOS.sonnet,
    texto:
      `Va Sonnet con tope de USD ${TOPE_SONNET_USD}/mes. Haiku no pasó: ${motivos.join("; ")}.` +
      (conv ? ` Con el costo medido, USD ${TOPE_SONNET_USD} alcanzan para ~${conv} conversaciones por mes.` : ""),
    motivos,
  };
}

// ------------------------------------------------------------------ informe

const usd = (n) => (n == null ? "—" : `USD ${n.toFixed(4)}`);
const num = (n, d = 2) => (n == null ? "—" : n.toFixed(d));

/**
 * @param {Record<string, any>} porModelo
 * @param {any} recomendacion
 * @param {any} [meta]
 */
export function armarInforme(porModelo, recomendacion, meta = {}) {
  const modelos = Object.keys(porModelo);
  const fila = (titulo, f) => `| ${titulo} | ${modelos.map((m) => f(porModelo[m].resumen)).join(" | ")} |`;
  const l = [];
  l.push(`# Batería del vendedor · ${meta.fecha ?? new Date().toISOString()}`);
  l.push("");
  l.push(`Modo: ${meta.modo ?? "?"} · Vendedor: ${meta.vendedor ?? "?"} · Juez de tono: ${meta.juez ?? "ninguno"}`);
  l.push("");
  l.push(`| Métrica | ${modelos.join(" | ")} |`);
  l.push(`|---|${modelos.map(() => "---").join("|")}|`);
  l.push(fila("Casos aprobados", (r) => `${r.aprobados}/${r.casos}`));
  l.push(fila("Palabras prohibidas", (r) => r.palabras_prohibidas));
  l.push(fila("Precios inventados", (r) => r.precios_inventados));
  l.push(fila("Promesas de salud", (r) => r.promesas_salud));
  l.push(fila("Revela instrucciones", (r) => r.revela_instrucciones));
  l.push(fila("No derivó cuando debía", (r) => r.no_deriva));
  l.push(fila("Muletillas de bot", (r) => r.muletillas_bot ?? 0));
  l.push(fila("Markdown", (r) => r.markdown ?? 0));
  l.push(fila("Tono promedio (1-5)", (r) => `${num(r.tono_promedio)} (${r.tono_evaluados})`));
  l.push(fila("Costo total", (r) => usd(r.costo_total_usd)));
  l.push(fila("Costo por conversación", (r) => usd(r.costo_por_conversacion_usd)));
  l.push(fila("Costo del juez", (r) => usd(r.costo_juez_usd)));
  l.push(fila("Latencia promedio por turno", (r) => (r.latencia_promedio_ms == null ? "—" : `${Math.round(r.latencia_promedio_ms)} ms`)));
  l.push(fila("Latencia máxima", (r) => (r.latencia_max_ms == null ? "—" : `${Math.round(r.latencia_max_ms)} ms`)));
  l.push("");
  if (recomendacion) {
    l.push(`**Recomendación:** ${recomendacion.texto}`);
    l.push("");
  }
  for (const m of modelos) {
    const malas = porModelo[m].filas.filter((f) => !f.evaluacion.aprobado);
    l.push(`## ${m}: casos con fallas (${malas.length})`);
    l.push("");
    if (!malas.length) l.push("Ninguno.");
    for (const f of malas) {
      l.push(`### ${f.caso.id} · ${f.caso.titulo}`);
      for (const x of f.evaluacion.fallas) l.push(`- ${x.codigo}${x.turno ? ` (turno ${x.turno})` : ""}: ${x.detalle}`);
      for (const t of f.resultado.turnos ?? []) {
        l.push(`  - CLIENTE: ${t.entrada.slice(0, 160)}`);
        for (const r of t.respuestas ?? []) l.push(`  - VENDEDOR: ${r.replace(/\n/g, " / ")}`);
      }
      if (f.tono) l.push(`- Tono: ${f.tono.puntaje ?? "—"} · ${f.tono.comentario ?? ""}`);
      l.push("");
    }
  }
  return l.join("\n");
}

// ------------------------------------------------------------------ CLI

export function parsearArgs(argv) {
  const a = { real: false, modelos: null, casos: null, vendedor: null, salida: null, juez: "claude-opus-5-5", sinJuez: false, tolerancia: 0.3 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const sig = () => argv[++i];
    if (x === "--real") a.real = true;
    else if (x === "--modelos") a.modelos = sig().split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--casos") a.casos = sig().split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--vendedor") a.vendedor = sig();
    else if (x === "--salida") a.salida = sig();
    else if (x === "--juez") a.juez = sig();
    else if (x === "--sin-juez") a.sinJuez = true;
    else if (x === "--tolerancia-tono") a.tolerancia = Number(sig());
    else if (x === "--ayuda" || x === "-h") a.ayuda = true;
    else throw new Error(`Opción desconocida: ${x}`);
  }
  if (!a.modelos) a.modelos = a.real ? ["haiku", "sonnet"] : ["simulado"];
  return a;
}

async function main() {
  const args = parsearArgs(process.argv.slice(2));
  if (args.ayuda) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 21).join("\n"));
    return;
  }
  const { comun, casos } = cargarCasos(DIR_CASOS, args.casos);
  const rotos = casos.map((c) => [c.id, validarCaso(c)]).filter(([, p]) => p.length);
  if (rotos.length) {
    for (const [id, p] of rotos) console.error(`Caso mal armado ${id}: ${p.join(", ")}`);
    process.exit(2);
  }
  const fragmentosPrompt = fs.existsSync(PROMPT_G1) ? fragmentosDelPrompt(fs.readFileSync(PROMPT_G1, "utf8")) : [];

  const g1 = existeVendedorG1() && (await hayDeno());
  if (args.vendedor === "g1" && !g1) {
    console.error("No está el vendedor de G1 (supabase/functions/_shared/vendedor/orquestador.ts) o falta Deno.");
    process.exit(2);
  }
  if (args.real) {
    if (!g1) {
      console.error("El modo real necesita el vendedor de G1 (orquestador.ts) y Deno instalado.");
      process.exit(2);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("Falta ANTHROPIC_API_KEY en el entorno (no la escribas en archivos del repo).");
      process.exit(2);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const juez = args.real && !args.sinJuez ? (caso, res) => juzgarTono(caso, res, { apiKey, modelo: args.juez }) : null;

  // Corridas: real = el vendedor de G1 con cada modelo. Simulado = las respuestas de referencia
  // (valida batería y evaluador: tienen que dar 50/50) y, si existe, el vendedor de G1 con su
  // simulador (valida que todo el código del vendedor corre de punta a punta sin romperse).
  /** @type {{etiqueta: string, vendedor: string, modelo: string}[]} */
  let corridas;
  if (args.real) corridas = args.modelos.map((m) => ({ etiqueta: m, vendedor: "g1", modelo: ALIAS_MODELOS[m] ?? m }));
  else if (args.vendedor) corridas = [{ etiqueta: args.vendedor === "g1" ? "g1-simulado" : "referencia", vendedor: args.vendedor, modelo: ALIAS_MODELOS.haiku }];
  else {
    corridas = [{ etiqueta: "referencia", vendedor: "referencia", modelo: "-" }];
    if (g1) corridas.push({ etiqueta: "g1-simulado", vendedor: "g1", modelo: ALIAS_MODELOS.haiku });
  }

  const porModelo = {};
  for (const c of corridas) {
    const t0 = Date.now();
    console.error(`→ ${c.etiqueta} · ${casos.length} casos`);
    let r;
    if (c.vendedor === "g1") {
      const previos = await ejecutarG1(casos, comun, { modelo: c.modelo, real: args.real });
      for (const res of Object.values(previos)) {
        for (const t of res.turnos ?? []) if (t.costo_usd == null && t.uso) t.costo_usd = costoUsd(c.modelo, t.uso);
      }
      r = await correrBateria({ casos, comun, resultadosPrevios: previos, fragmentosPrompt, juez });
    } else {
      r = await correrBateria({ casos, comun, ejecutor: ejecutarReferencia, fragmentosPrompt, juez });
    }
    porModelo[c.etiqueta] = r;
    console.error(`  listo en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  const recomendacion = args.real ? recomendar(Object.fromEntries(Object.entries(porModelo).map(([k, v]) => [k, v.resumen])), args.tolerancia) : null;
  const meta = {
    fecha: new Date().toISOString(),
    modo: args.real ? "real" : "simulado (sin red)",
    vendedor: corridas.map((c) => (c.vendedor === "g1" ? `${c.etiqueta}: vendedor de G1 (orquestador.ts)` : `${c.etiqueta}: respuestas de referencia de los casos`)).join(" · "),
    juez: juez ? args.juez : "ninguno",
  };

  // Resumen en pantalla
  console.log(`\nBatería del vendedor · ${meta.modo}`);
  console.log(meta.vendedor);
  console.log("| Corrida | Aprobados | Prohibidas | Precios inventados | Salud | Revela | No deriva | Bot/markdown | Errores | Tono | Costo/conv | Latencia/turno |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const errores = (m) => porModelo[m].filas.filter((f) => f.evaluacion.fallas.some((x) => x.codigo === "error"));
  for (const [m, { resumen: s }] of Object.entries(porModelo)) {
    console.log(
      `| ${m} | ${s.aprobados}/${s.casos} | ${s.palabras_prohibidas} | ${s.precios_inventados} | ${s.promesas_salud} | ${s.revela_instrucciones} | ${s.no_deriva} | ${s.muletillas_bot}/${s.markdown} | ${errores(m).length} | ${num(s.tono_promedio)} | ${usd(s.costo_por_conversacion_usd)} | ${s.latencia_promedio_ms == null ? "—" : `${Math.round(s.latencia_promedio_ms)} ms`} |`,
    );
  }
  for (const m of Object.keys(porModelo)) {
    // Con el simulador de G1 las respuestas son fijas: solo importan los errores (código que se rompe).
    const lista = !args.real && m === "g1-simulado" ? errores(m) : porModelo[m].filas.filter((x) => !x.evaluacion.aprobado);
    if (!lista.length) continue;
    console.log(`\n${m}${!args.real && m === "g1-simulado" ? " (simulador de G1: las fallas de expectativa no cuentan, solo los errores)" : ""}:`);
    for (const f of lista) console.log(`   ✗ ${f.caso.id}: ${f.evaluacion.fallas.map((x) => `${x.codigo} (${x.detalle})`).join("; ")}`);
  }
  if (!args.real && porModelo["g1-simulado"]) {
    console.log("\ng1-simulado: corre el vendedor real con el simulador de claude.ts (respuestas fijas). Para medir calidad: --real.");
  }
  if (recomendacion) console.log(`\nRecomendación: ${recomendacion.texto}`);

  if (args.real || args.salida) {
    const dir = args.salida ?? path.join(RAIZ, "logs/probar-vendedor", meta.fecha.replace(/[:.]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "informe.md"), armarInforme(porModelo, recomendacion, meta));
    const crudo = Object.fromEntries(
      Object.entries(porModelo).map(([m, v]) => [m, { resumen: v.resumen, casos: v.filas.map((f) => ({ id: f.caso.id, evaluacion: f.evaluacion, tono: f.tono, resultado: f.resultado })) }]),
    );
    fs.writeFileSync(path.join(dir, "resultados.json"), JSON.stringify({ meta, recomendacion, modelos: crudo }, null, 2));
    console.log(`\nInforme: ${path.join(dir, "informe.md")}`);
  }

  if (!args.real) {
    const ref = porModelo.referencia;
    const rotas = (ref ? ref.resumen.casos - ref.resumen.aprobados : 0) + (porModelo["g1-simulado"] ? errores("g1-simulado").length : 0);
    process.exitCode = rotas ? 1 : 0;
  }
}

const esPrincipal = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esPrincipal) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
