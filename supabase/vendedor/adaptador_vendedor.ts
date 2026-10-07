// supabase/vendedor/adaptador_vendedor.ts · Dueño: G3 · ADAPTADOR AISLADO hacia el vendedor de G1.
//
// Es el ÚNICO archivo de la batería que conoce la forma del orquestador de G1
// (supabase/functions/_shared/vendedor/orquestador.ts → procesarTurno(entrada, DepsOrquestador)).
// Si G1 cambia su firma, se toca solo esto.
//
// Corre el vendedor DE VERDAD (prompt, bucle de herramientas, filtro de salida, regeneración, derivación)
// con dependencias falsas: Shopify, base de datos, WhatsApp y Telegram se reemplazan por los datos del
// caso (catálogo y pedidos de prueba). Lo único real en modo --real es la llamada a Claude.
// La configuración sale de supabase/seed_vendedor.sql (la misma que se carga en config_wa), con el
// catálogo/ofertas del caso, sin demoras y con un número de prueba para el botón de Enrique.
//
// Lo lanza scripts/probar-vendedor.mjs como proceso Deno aparte:
//   stdin  → {casos, comun, modelo, simulado}
//   stdout → {resultados: {[id]: {turnos: [{entrada, respuestas[], herramientas[], derivado, uso, costo_usd, latencia_ms}]}}}
// Los logs van a stderr (stdout es solo el JSON).

import { _configurarClaude, llamarClaude, type TablaPrecios } from "../functions/_shared/claude.ts";
import { normalizarTelefonoPY } from "../functions/_shared/telefono.ts";
import { textosVisibles } from "../functions/_shared/wa_interactivos.ts";
import { armarConfigTurno } from "../functions/_shared/vendedor/config.ts";
import { montosDeResultado } from "../functions/_shared/vendedor/filtro_salida.ts";
import { _limpiarCacheCatalogo } from "../functions/_shared/vendedor/herramientas.ts";
import {
  type DepsOrquestador,
  type FilaHistorial,
  type FilaTurno,
  procesarTurno,
} from "../functions/_shared/vendedor/orquestador.ts";
import type { DepsHerramientas, PedidoChat, PedidoCliente, ProductoShopify } from "../functions/_shared/vendedor/tipos.ts";

type Item = { sku?: string; handle?: string; nombre?: string; precio: number; cantidad?: number };
type PedidoCaso = {
  nombre?: string;
  producto?: string;
  total?: number;
  estado_confirmacion?: string;
  estado_envio?: string | null;
  courier?: string | null;
  creado_en?: string;
};
/** Un mensaje del caso, o una ráfaga (varios mensajes seguidos del cliente que se responden juntos). */
export type MensajeCaso = string | string[];
export type Caso = {
  id: string;
  cliente: { nombre: string; telefono: string | null; wa_username: string | null };
  contexto: { catalogo: Item[] | string; pedidos?: PedidoCaso[]; envio?: number; ahora?: string };
  mensajes: MensajeCaso[];
};
export type Comun = { envio?: number; catalogos?: Record<string, Item[]>; afirmaciones_permitidas?: string[] };

const NUMERO_ENRIQUE_PRUEBA = "595981000000"; // número de prueba (repo público)
const AHORA_POR_DEFECTO = "2026-10-06T17:00:00Z"; // martes 14:00 en Asunción
const URL_PRUEBA = "https://ejemplo.test";

// ------------------------------------------------------------------ configuración

/** Lee las filas de config_wa de supabase/seed_vendedor.sql (formato ('clave', '<json>'::jsonb)). */
export function filasDeSemilla(sql: string): Record<string, unknown> {
  const filas: Record<string, unknown> = {};
  const re = /\(\s*'([a-z_]+)',\s*'((?:[^']|'')*)'::jsonb\s*\)/g;
  for (const m of sql.matchAll(re)) {
    try {
      filas[m[1]] = JSON.parse(m[2].replace(/''/g, "'"));
    } catch (e) {
      console.error(`adaptador: no pude leer ${m[1]} de la semilla: ${e instanceof Error ? e.message : e}`);
    }
  }
  return filas;
}

function leerSemilla(): Record<string, unknown> {
  try {
    return filasDeSemilla(Deno.readTextFileSync(new URL("../seed_vendedor.sql", import.meta.url)));
  } catch {
    console.error("adaptador: no está supabase/seed_vendedor.sql; uso los valores por defecto del código");
    return {};
  }
}

/** Catálogo del caso → productos de Shopify (precio ×1) + ofertas por cantidad (config_wa.vendedor_ofertas). */
export function catalogoComoShopify(items: Item[]): { productos: ProductoShopify[]; ofertas: Record<string, Record<string, number>> } {
  const porHandle = new Map<string, Item[]>();
  for (const it of items) {
    const h = it.handle ?? (it.sku ?? it.nombre ?? "producto").toLowerCase().replace(/-x\d+$/, "");
    if (!porHandle.has(h)) porHandle.set(h, []);
    porHandle.get(h)!.push(it);
  }
  const productos: ProductoShopify[] = [];
  const ofertas: Record<string, Record<string, number>> = {};
  let n = 0;
  for (const [handle, lista] of porHandle) {
    const base = lista.find((x) => (x.cantidad ?? 1) === 1) ?? lista[0];
    n++;
    productos.push({
      id: `gid://shopify/Product/${9000 + n}`,
      handle,
      title: (base.nombre ?? handle).replace(/\s*x1\b.*$/i, "").trim(),
      status: "ACTIVE",
      imagen: `${URL_PRUEBA}/${handle}.jpg`,
      variantes: [{ id: `gid://shopify/ProductVariant/${8000 + n}`, title: "Default", price: base.precio, disponible: true }],
    });
    for (const o of lista.filter((x) => (x.cantidad ?? 1) > 1)) {
      (ofertas[handle] ??= {})[String(o.cantidad)] = o.precio;
    }
  }
  return { productos, ofertas };
}

/**
 * Fichas de la semilla (por handle REAL de Shopify) → handles del catálogo de prueba, por la primera palabra
 * ("tiras-nasales" usa la ficha de "tiras-nasales-gudair-30-unidades"). Así el prompt de la batería lleva fichas.
 */
export function fichasParaCatalogo(fichas: Record<string, unknown>, productos: ProductoShopify[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fichas };
  for (const p of productos) {
    if (out[p.handle]) continue;
    const clave = p.handle.split("-")[0];
    const real = Object.keys(fichas).find((h) => h.split("-")[0] === clave);
    if (real) out[p.handle] = fichas[real];
  }
  return out;
}

// ------------------------------------------------------------------ una conversación

type Salida = { texto: string };

function textoDeInteractivo(i: Record<string, unknown>): string {
  const body = (i?.body ?? {}) as { text?: string };
  if (typeof body.text === "string" && body.text.trim()) return body.text;
  return textosVisibles(i)[0] ?? "";
}

export async function correrCaso(caso: Caso, comun: Comun, modelo: string, semilla: Record<string, unknown>) {
  const items = Array.isArray(caso.contexto.catalogo) ? caso.contexto.catalogo : comun.catalogos?.[caso.contexto.catalogo] ?? [];
  const envio = typeof caso.contexto.envio === "number" ? caso.contexto.envio : comun.envio ?? 33000;
  const { productos, ofertas } = catalogoComoShopify(items);
  const media = Object.fromEntries(productos.map((p) => [p.handle, { foto: `${URL_PRUEBA}/${p.handle}.jpg`, video: `${URL_PRUEBA}/${p.handle}.mp4`, uso: `${URL_PRUEBA}/${p.handle}-uso.mp4` }]));
  const vendedorSemilla = (semilla.vendedor ?? {}) as Record<string, unknown>;
  const { cfg } = armarConfigTurno({
    ...semilla,
    vendedor: {
      ...vendedorSemilla,
      modelo,
      espera_agrupar_s: 0,
      tope_mensual_usd: 1e9,
      whatsapp_enrique: NUMERO_ENRIQUE_PRUEBA,
    },
    vendedor_envio: { ...((semilla.vendedor_envio ?? {}) as Record<string, unknown>), costo_gs: envio },
    vendedor_afirmaciones: semilla.vendedor_afirmaciones ?? comun.afirmaciones_permitidas ?? [],
    vendedor_ofertas: ofertas,
    vendedor_media: media,
    vendedor_fichas: fichasParaCatalogo((semilla.vendedor_fichas ?? {}) as Record<string, unknown>, productos),
  });
  // Ráfagas: se espera el silencio de verdad (dormir es instantáneo) para probar la agrupación del orquestador.
  const cfgRafaga = { ...cfg, vendedor: { ...cfg.vendedor, espera_agrupar_s: 8 } };
  let cfgActual = cfg;
  _limpiarCacheCatalogo();

  const convId = `prueba-${caso.id}`;
  const cliId = `cli-${caso.id}`;
  const estado: { conv: string; turnos: number; perfil: unknown } = { conv: "ia", turnos: 0, perfil: {} };
  const historial: FilaHistorial[] = [];
  const pedidosChat: PedidoChat[] = [];
  const preciosPrevios: number[] = [];
  let salidas: Salida[] = [];
  let filaTurno: FilaTurno | null = null;
  let nOrden = 0;
  let nMsg = 0;

  const enviado = (texto: string) => {
    if (texto.trim()) {
      salidas.push({ texto });
      historial.push({ direccion: "out", texto, tipo: "text", contenido: null, estado: "enviado", wa_message_id: `out-${++nMsg}` });
    }
    return Promise.resolve({ ok: true, wa_message_id: `out-${nMsg}` });
  };

  const pedidos: PedidoCliente[] = (caso.contexto.pedidos ?? []).map((p, i) => ({
    shopify_order_id: 5000 + i,
    nombre: p.nombre ?? null,
    estado_confirmacion: p.estado_confirmacion ?? "confirmado",
    estado_envio: p.estado_envio ?? null,
    courier: p.courier ?? null,
    total: p.total ?? null,
    creado_en: p.creado_en ?? null,
  }));

  const herramientas: DepsHerramientas = {
    catalogoShopify: () => Promise.resolve(productos),
    pedidosDeCliente: () => Promise.resolve(pedidos),
    guardarPedidoChat: (fila) => {
      const completa: PedidoChat = { ...fila, id: fila.id ?? `pc-${pedidosChat.length + 1}`, creado_en: new Date(ahoraMs()).toISOString() } as PedidoChat;
      const i = pedidosChat.findIndex((x) => x.id === completa.id);
      if (i >= 0) pedidosChat[i] = { ...pedidosChat[i], ...completa, creado_en: pedidosChat[i].creado_en };
      else pedidosChat.push(completa);
      return Promise.resolve(i >= 0 ? pedidosChat[i] : completa);
    },
    ultimoPedidoChat: () => Promise.resolve(pedidosChat[pedidosChat.length - 1] ?? null),
    crearOrdenShopify: () => {
      nOrden++;
      const total = pedidosChat[pedidosChat.length - 1]?.total ?? null;
      return Promise.resolve({ ok: true, shopify_order_id: 7000 + nOrden, gid: `gid://shopify/Order/${7000 + nOrden}`, nombre: `#PRUEBA-${nOrden}`, total });
    },
    registrarComoReleasit: () => Promise.resolve(),
    pasarAHumano: () => {
      estado.conv = "humano";
      return Promise.resolve();
    },
    avisar: () => Promise.resolve({ ok: true }),
    enviarTexto: (_to, texto) => enviado(texto),
    enviarInteractivo: (_to, interactivo) => enviado(textoDeInteractivo(interactivo)),
    enviarMedia: (_to, _tipo, _link, caption) => enviado(caption ?? ""),
    normalizarTelefono: (x) => normalizarTelefonoPY(x),
  };

  let reloj = new Date(caso.contexto.ahora ?? AHORA_POR_DEFECTO).getTime();
  const ahoraMs = () => reloj;

  const deps: DepsOrquestador = {
    config: () => Promise.resolve(cfgActual),
    conversacion: () => Promise.resolve({ id: convId, estado: estado.conv, cliente_id: cliId, turnos_ia: estado.turnos, perfil_vendedor: estado.perfil }),
    cliente: () =>
      Promise.resolve({
        id: cliId,
        telefono: caso.cliente.telefono,
        wa_user_id: caso.cliente.telefono ? null : `PY.prueba.${caso.id}`,
        nombre: caso.cliente.nombre,
      }),
    historial: (_c, limite) => Promise.resolve(historial.slice(-limite)),
    ultimoEntranteId: () => Promise.resolve([...historial].reverse().find((f) => f.direccion === "in")?.wa_message_id ?? null),
    gastoMesUsd: () => Promise.resolve(0),
    preciosPrevios: () => Promise.resolve([...preciosPrevios]),
    registrarTurno: (fila) => {
      filaTurno = fila;
      for (const h of fila.herramientas) preciosPrevios.push(...montosDeResultado(h.resultado));
      return Promise.resolve();
    },
    sumarTurno: () => {
      estado.turnos++;
      return Promise.resolve();
    },
    guardarPerfil: (_c, perfil) => {
      estado.perfil = perfil;
      return Promise.resolve();
    },
    aleatorio: () => 0.5,
    marcarLeidoYEscribiendo: () => Promise.resolve({ ok: true }),
    llamarModelo: (p) => llamarClaude(p),
    dormir: () => Promise.resolve(),
    ahora: () => new Date(ahoraMs()),
    herramientas,
  };

  const turnos: Record<string, unknown>[] = [];
  for (const m of caso.mensajes) {
    const rafaga = Array.isArray(m) ? m : [m];
    const mensaje = rafaga.join("\n");
    reloj += 60_000; // un minuto entre turnos
    const ids = rafaga.map((texto) => {
      const waId = `in-${++nMsg}`;
      historial.push({ direccion: "in", texto, tipo: "text", contenido: null, estado: "recibido", wa_message_id: waId });
      return waId;
    });
    cfgActual = rafaga.length > 1 ? cfgRafaga : cfg;
    salidas = [];
    filaTurno = null;
    const t0 = performance.now();
    try {
      // Cada mensaje de la ráfaga dispara su turno (como en producción); solo el último responde.
      let r: Awaited<ReturnType<typeof procesarTurno>> = { accion: "omitido" };
      const acciones: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        r = await procesarTurno({ conversacion_id: convId, wa_message_id: ids[i], texto: rafaga[i] }, deps);
        acciones.push(r.accion);
      }
      const fila = filaTurno as FilaTurno | null;
      const usadas = (fila?.herramientas ?? []).map((h) => ({ nombre: h.nombre.replace(/\(sistema\)$/, ""), input: h.input, error: h.error }));
      turnos.push({
        entrada: mensaje,
        respuestas: salidas.map((s) => s.texto),
        herramientas: usadas,
        derivado: r.accion === "derivado" || !!fila?.derivado,
        accion: r.accion + (r.motivo ? `:${r.motivo}` : ""),
        ...(ids.length > 1 ? { acciones } : {}),
        regenerado: fila?.regenerado ?? false,
        uso: fila?.uso ?? null,
        costo_usd: r.costo_usd ?? fila?.costo_usd ?? 0,
        simulado: fila?.simulado ?? null,
        latencia_ms: performance.now() - t0,
      });
    } catch (e) {
      turnos.push({
        entrada: mensaje,
        respuestas: salidas.map((s) => s.texto),
        herramientas: [],
        error: e instanceof Error ? e.message : String(e),
        latencia_ms: performance.now() - t0,
      });
    }
  }
  return { turnos };
}

// ------------------------------------------------------------------ proceso

if (import.meta.main) {
  const entrada = JSON.parse(await new Response(Deno.stdin.readable).text()) as {
    casos: Caso[];
    comun: Comun;
    modelo: string;
    simulado: boolean;
  };
  // Los console.log del vendedor no pueden ensuciar stdout (es el canal del JSON).
  console.log = (...a: unknown[]) => console.error(...a);
  const semilla = leerSemilla();
  const precios = (semilla.precios_claude ?? null) as TablaPrecios | null;
  _configurarClaude({
    modoSimulado: () => entrada.simulado || !Deno.env.get("ANTHROPIC_API_KEY"),
    precios: () => Promise.resolve(precios), // sin base: los precios vienen de la semilla
  });
  const resultados: Record<string, unknown> = {};
  for (const caso of entrada.casos) {
    console.error(`  · ${caso.id}`);
    resultados[caso.id] = await correrCaso(caso, entrada.comun, entrada.modelo, semilla);
  }
  // write() puede escribir menos bytes de los pedidos: se repite hasta mandar todo.
  const bytes = new TextEncoder().encode(JSON.stringify({ resultados }));
  for (let i = 0; i < bytes.length;) i += await Deno.stdout.write(bytes.subarray(i));
}
