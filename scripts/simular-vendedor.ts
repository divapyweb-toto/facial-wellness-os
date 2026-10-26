// scripts/simular-vendedor.ts · Simulador local de conversaciones del vendedor de WhatsApp (Voltra).
//
// Corre procesarTurno (orquestador real) con el modelo REAL, la config REAL (config_wa + versión activa del prompt) y
// el catálogo REAL de Shopify (solo lectura). Todo lo demás es en memoria: NO escribe en la base, NO manda WhatsApp ni
// Telegram, NO crea ni cambia pedidos en Shopify. Lo que SE HABRÍA escrito queda en el transcript ("escrituras").
//
// Uso (desde supabase/functions, para que tome deno.json):
//   cd supabase/functions && deno run -A --env-file=../../.env.produccion ../../scripts/simular-vendedor.ts
//     [--escenario nombre[,nombre2]]   solo esos escenarios (por defecto todos)
//     [--version-prompt 34]            prompt de vendedor_versiones número 34 (lectura) en vez del activo
//     [--prompt-archivo ../vendedor/prompt_sistema.md]   prompt desde un archivo local (relativo al cwd o absoluto)
//     [--modelo claude-haiku-4-5-20251001]               pisa config_wa.vendedor.modelo
//     [--tope-usd 2]                   corta si el gasto de la corrida pasa este monto (default 2)
//     [--sin-archivo]                  no escribe logs/simulaciones/
//     [--listar]                       lista los escenarios y sale
// Salida: transcript por escenario en stdout y en logs/simulaciones/<fecha>-<escenario>.md (logs/ está en .gitignore),
// más una tabla resumen (PASS/FAIL por chequeo, burbujas, largo promedio, costo USD).
// Escenarios: scripts/escenarios-vendedor.ts.

import { depsOrquestadorReales, depsHerramientasReales } from "../supabase/functions/_shared/vendedor/io.ts";
import {
  type DepsOrquestador,
  type FilaHistorial,
  type FilaTurno,
  procesarTurno,
  type ResultadoTurno,
  TEXTO_SEGUIMIENTO_CONTEXTO,
} from "../supabase/functions/_shared/vendedor/orquestador.ts";
import { depsPrueba } from "../supabase/functions/_shared/vendedor/prueba_utiles.ts";
import type { ConfigTurno, DepsHerramientas, PedidoChat, PedidoCliente, ProductoShopify } from "../supabase/functions/_shared/vendedor/tipos.ts";
import type {
  CandidatoPedido,
  DepsPedidosWeb,
  ModificacionPedido,
  PedidoWeb,
} from "../supabase/functions/_shared/vendedor/pedidos_web.ts";
import { plantillaDeVersion, type FilaVersion } from "../supabase/functions/_shared/vendedor/version_activa.ts";
import { LLAVES_PROMPT } from "../supabase/functions/_shared/vendedor/prompt.ts";
import { extraerMontos, montosDeResultado } from "../supabase/functions/_shared/vendedor/filtro_salida.ts";
import { _limpiarCacheCatalogo, itemsCatalogo } from "../supabase/functions/_shared/vendedor/herramientas.ts";
import { textosVisibles } from "../supabase/functions/_shared/wa_interactivos.ts";
import { marcaAnuncio, marcaTextoAnuncio, nombreDeHandle, productoDeMarca, textoDelAnuncio } from "../supabase/functions/_shared/anuncios.ts";
import { conPedidoAbierto, textoDeMensaje, textoParaVendedor } from "../supabase/functions/wa-webhook/procesar.ts";
import { db } from "../supabase/functions/_shared/db.ts";
import { decidirSeguimiento, hayDatosPedidoParciales, leerCfgSeguimiento } from "../supabase/functions/seguimiento-chat/logica.ts";
import { type Check, type Escenario, ESCENARIOS, type Paso, type PedidoEscenario } from "./escenarios-vendedor.ts";

// ---------- entorno ----------

if (!Deno.env.get("SUPABASE_URL")) {
  const ref = Deno.env.get("SUPABASE_PROJECT_REF");
  if (!ref) throw new Error("Falta SUPABASE_URL o SUPABASE_PROJECT_REF (cargá ../../.env.produccion con --env-file)");
  Deno.env.set("SUPABASE_URL", `https://${ref}.supabase.co`);
}
// Nunca modo simulado: queremos ver el modelo real.
if (Deno.env.get("MODO_SIMULADO") === "1") throw new Error("MODO_SIMULADO=1: el simulador necesita el modelo real");
if (!Deno.env.get("ANTHROPIC_API_KEY")) throw new Error("Falta ANTHROPIC_API_KEY");

const RAIZ = new URL("../", import.meta.url).pathname;

function arg(nombre: string): string | null {
  const i = Deno.args.indexOf(`--${nombre}`);
  if (i < 0) return null;
  const v = Deno.args[i + 1];
  return v && !v.startsWith("--") ? v : "";
}
const flag = (n: string) => Deno.args.includes(`--${n}`);

// ---------- utilidades ----------

const gs = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const corto = (s: unknown, n = 220) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return (t ?? "").length > n ? `${t.slice(0, n - 1)}…` : (t ?? "");
};
const CONV = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENTE = "bbbbbbbb-0000-4000-8000-000000000001";

type Escritura = { destino: "shopify" | "db" | "telegram" | "wa"; op: string; detalle: unknown };
type Salida =
  | { tipo: "texto"; texto: string }
  | { tipo: "interactivo"; cuerpo: string; botones: Array<{ id: string; titulo: string }>; raw: Record<string, unknown> }
  | { tipo: "media"; media: string; link: string; caption: string | null };

type ResultadoPaso = {
  entrada: string;
  alVendedor: string;
  origen: "cliente" | "seguimiento";
  salidas: Salida[];
  textos: string[];
  botones: Array<{ id: string; titulo: string }>;
  turnos: FilaTurno[];
  escrituras: Escritura[];
  resultado: ResultadoTurno | { accion: "error"; motivo: string };
  costo: number;
  derivado: boolean;
};

// ---------- base (config, catálogo, prompt) ----------

let catalogoReal: ProductoShopify[] | null = null;
async function catalogo(estado: string): Promise<ProductoShopify[]> {
  if (!catalogoReal) catalogoReal = await depsHerramientasReales.catalogoShopify(estado);
  return catalogoReal;
}

async function plantillaElegida(): Promise<{ plantilla: string | null; etiqueta: string }> {
  const archivo = arg("prompt-archivo");
  const version = arg("version-prompt");
  if (archivo) {
    // Relativo al cwd (supabase/functions) o a la raíz del repo ("supabase/vendedor/prompt_sistema.md").
    const candidatas = archivo.startsWith("/") ? [archivo] : [`${Deno.cwd()}/${archivo}`, `${RAIZ}${archivo}`];
    const ruta = candidatas.find((c) => { try { return Deno.statSync(c).isFile; } catch { return false; } });
    if (!ruta) throw new Error(`no encuentro ${archivo} (probé ${candidatas.join(", ")})`);
    const t = await Deno.readTextFile(ruta);
    const faltan = LLAVES_PROMPT.filter((k) => !t.includes(`{${k}}`));
    if (faltan.length) throw new Error(`${archivo} no tiene las llaves ${faltan.join(", ")}`);
    return { plantilla: t, etiqueta: `archivo ${archivo}` };
  }
  if (version) {
    const { data, error } = await db().from("vendedor_versiones").select("numero,prompt,ejemplos,faq,objeciones,estado")
      .eq("numero", Number(version)).maybeSingle();
    if (error) throw new Error(`vendedor_versiones: ${error.message}`);
    if (!data) throw new Error(`no existe vendedor_versiones numero=${version}`);
    const { plantilla, motivo } = plantillaDeVersion(data as FilaVersion);
    if (!plantilla) throw new Error(`versión ${version} no sirve: ${motivo}`);
    return { plantilla, etiqueta: `versión ${version} (${(data as { estado?: string }).estado ?? "?"})` };
  }
  const { data } = await db().from("vendedor_versiones").select("numero").eq("estado", "activa").maybeSingle();
  return { plantilla: null, etiqueta: data?.numero ? `versión activa ${data.numero}` : "config_wa / archivo (sin versión activa)" };
}

function aplicarOverrides(base: ConfigTurno, over: Record<string, unknown> | undefined, modelo: string | null): ConfigTurno {
  const cfg = structuredClone(base) as ConfigTurno & Record<string, unknown>;
  for (const [k, v] of Object.entries(over ?? {})) {
    const actual = cfg[k];
    cfg[k] = v && typeof v === "object" && !Array.isArray(v) && actual && typeof actual === "object" && !Array.isArray(actual)
      ? { ...(actual as Record<string, unknown>), ...(v as Record<string, unknown>) }
      : v;
  }
  if (modelo) cfg.vendedor = { ...cfg.vendedor, modelo };
  return cfg;
}

// ---------- pedidos del escenario ----------

function pedidoWeb(p: PedidoEscenario, esc: Escenario, prods: ProductoShopify[], ahora: Date): PedidoWeb {
  const tel = p.telefono ?? (p.cliente === "cliente" ? esc.cliente?.telefono ?? null : null);
  const lineas = p.lineas.map((l, i) => {
    const prod = prods.find((x) => x.handle === l.handle);
    return {
      line_item_id: `gid://shopify/LineItem/${p.numero}${i}`,
      variante_id: prod?.variantes[0]?.id ?? null,
      handle: l.handle,
      titulo: prod?.title ?? l.handle,
      cantidad: l.cantidad,
      total: l.total,
    };
  });
  const id = 9_000_000_000 + p.numero;
  return {
    shopify_order_id: id,
    gid: `gid://shopify/Order/${id}`,
    nombre: `#${p.numero}`,
    creado_en: new Date(ahora.getTime() - p.hace_min * 60_000).toISOString(),
    telefono: tel,
    email: null,
    cliente_id: p.cliente === "cliente" ? CLIENTE : null,
    customer_gid: null,
    nombre_cliente: p.nombre_cliente,
    total: lineas.reduce((s, l) => s + l.total, 0) + p.envio,
    envio: p.envio,
    cancelado: !!p.cancelado,
    despachado: !!p.despachado,
    estado_confirmacion: p.estado_confirmacion,
    app: p.app,
    merchant_editable: p.app !== "Releasit COD Form",
    tags: p.app === "Releasit COD Form" ? ["releasit_cod_form"] : ["VOLTRA_OS"],
    atributos: p.atributos ?? [],
    nota: null,
    direccion: {
      firstName: p.nombre_cliente.split(" ")[0], lastName: p.nombre_cliente.split(" ").slice(1).join(" "),
      address1: p.direccion ?? "Calle Inventada 1", address2: null, city: p.ciudad ?? "Ciudad del Este", countryCode: "PY", phone: tel,
    },
    lineas,
  };
}

const ult9 = (t: string | null | undefined) => {
  const d = String(t ?? "").replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-9) : null;
};

// ---------- un escenario ----------

async function correrEscenario(esc: Escenario, baseCfg: ConfigTurno, modelo: string | null): Promise<{ pasos: ResultadoPaso[]; ctx: Record<string, unknown> }> {
  _limpiarCacheCatalogo();
  const cfg = aplicarOverrides(baseCfg, esc.config, modelo);
  const prods = await catalogo(cfg.vendedor.catalogo_estado || "ACTIVE");
  let reloj = esc.ahora ? Date.parse(esc.ahora) : Date.now();
  const ahora = () => new Date(reloj);
  const telCliente = esc.cliente?.telefono ?? "+595981000100";
  const nombreCliente = esc.cliente?.nombre ?? "Cliente Prueba";

  const pedidos = new Map<number, PedidoWeb>();
  for (const p of esc.pedidos ?? []) {
    const w = pedidoWeb(p, esc, prods, ahora());
    pedidos.set(w.shopify_order_id, w);
  }
  const porNumero = (n: number) => [...pedidos.values()].find((p) => p.nombre === `#${n}`);

  const historial: Array<FilaHistorial & { creado_en: string }> = [];
  const turnosTodos: FilaTurno[] = [];
  let estadoConv = "ia";
  let perfil: unknown = null;
  let n = 0;
  let escrituras: Escritura[] = [];
  let salidas: Salida[] = [];
  const modificaciones: ModificacionPedido[] = [];
  const vinculos: Array<{ id: number; fuente: string }> = [];
  let siguienteNuevo = 1100;

  const anotar = (destino: Escritura["destino"], op: string, detalle: unknown) => escrituras.push({ destino, op, detalle });
  const fila = (f: Omit<FilaHistorial, "estado"> & { estado?: string | null }) => {
    historial.push({ estado: null, ...f, creado_en: ahora().toISOString() });
    reloj += 1000;
  };

  // --- pedidosWeb en memoria (mismo contrato que pedidos_web_io.ts) ---
  const candidato = (p: PedidoWeb): CandidatoPedido => ({
    shopify_order_id: p.shopify_order_id, nombre: p.nombre, telefono: p.telefono, cliente_id: p.cliente_id, nombre_cliente: p.nombre_cliente,
    creado_en: p.creado_en, estado_confirmacion: p.estado_confirmacion, total: p.total, cancelado: p.cancelado,
    conversacion_id: p.atributos.find((a) => a.key === "conversacion_id")?.value ?? null,
  });
  const pw: DepsPedidosWeb = {
    candidatos: (f) => {
      let l = [...pedidos.values()].sort((a, b) => b.creado_en.localeCompare(a.creado_en)).map(candidato);
      if (f.numero) l = l.filter((c) => c.nombre === `#${f.numero}`);
      if (f.telefono) l = l.filter((c) => ult9(c.telefono) === ult9(f.telefono));
      if (f.desdeISO) l = l.filter((c) => c.creado_en >= f.desdeISO!);
      return Promise.resolve(l.slice(0, f.limite ?? 50));
    },
    pedidoCompleto: (id) => Promise.resolve(structuredClone(pedidos.get(id) ?? null)),
    vinculados: () => Promise.resolve(vinculos.map((v) => v.id).reverse()),
    pedidosConChat: (ids) => Promise.resolve(ids.filter((i) => pedidos.get(i)?.atributos.some((a) => a.key === "conversacion_id"))),
    vincular: (_c, id, fuente) => {
      vinculos.push({ id, fuente });
      anotar(fuente === "busqueda" ? "db" : "shopify", "vincular", { pedido: pedidos.get(id)?.nombre ?? id, fuente });
      return Promise.resolve();
    },
    guardarModificacion: (f) => {
      const ex = f.id ? modificaciones.find((m) => m.id === f.id) : undefined;
      if (ex) {
        Object.assign(ex, f, { actualizado_en: ahora().toISOString() });
        anotar("db", "guardarModificacion", { id: ex.id, estado: ex.estado, total: ex.datos.total, nuevo: ex.nuevo_nombre });
        return Promise.resolve(ex);
      }
      const nueva = { ...f, id: `mod-${modificaciones.length + 1}`, creado_en: ahora().toISOString() } as ModificacionPedido;
      modificaciones.push(nueva);
      anotar("db", "guardarModificacion", { id: nueva.id, estado: nueva.estado, camino: nueva.datos.camino, total: nueva.datos.total });
      return Promise.resolve(nueva);
    },
    modificacion: (id) => Promise.resolve(modificaciones.find((m) => m.id === id) ?? null),
    ultimaModificacion: () => Promise.resolve(modificaciones.at(-1) ?? null),
    tomarModificacion: (id) => {
      const m = modificaciones.find((x) => x.id === id);
      if (!m || m.estado !== "resumen") return Promise.resolve(false);
      m.estado = "ejecutando";
      return Promise.resolve(true);
    },
    editarOrden: (gid, plan, total) => {
      anotar("shopify", "editarOrden", { gid, plan, totalEsperado: total });
      return Promise.resolve({ ok: true, total });
    },
    crearDesdeBorrador: (input) => {
      const numero = ++siguienteNuevo;
      anotar("shopify", "crearDesdeBorrador", { nuevo: `#${numero}`, input });
      return Promise.resolve({ ok: true, shopify_order_id: 9_000_000_000 + numero, nombre: `#${numero}`, total: null });
    },
    reemplazoExistente: (nombre) => {
      const r = [...pedidos.values()].find((p) => p.tags.includes(`REEMPLAZA_A_${nombre}`) && !p.cancelado);
      return Promise.resolve(r ? { shopify_order_id: r.shopify_order_id, nombre: r.nombre } : null);
    },
    etiquetar: (gid, tags) => {
      anotar("shopify", "etiquetar", { gid, tags });
      const p = [...pedidos.values()].find((x) => x.gid === gid);
      if (p) p.tags.push(...tags);
      return Promise.resolve({ ok: true });
    },
    cancelarOrden: (gid, nota) => {
      anotar("shopify", "cancelarOrden", { gid, nota });
      const p = [...pedidos.values()].find((x) => x.gid === gid);
      if (p) p.cancelado = true;
      return Promise.resolve({ ok: true });
    },
    actualizarAtributos: (gid, nuevos) => {
      anotar("shopify", "actualizarAtributos", { gid, nuevos });
      return Promise.resolve({ ok: true });
    },
    transferirCandadosMeta: (a, b) => {
      anotar("db", "transferirCandadosMeta", { de: a, a: b });
      return Promise.resolve([]);
    },
  };

  // --- herramientas: dobles de prueba + catálogo real ---
  const { deps: base, reg } = depsPrueba();
  const pedidoChatInicial: PedidoChat[] = [];
  if (esc.pedido_chat_creado) {
    const p = porNumero(esc.pedido_chat_creado);
    if (!p) throw new Error(`${esc.nombre}: pedido_chat_creado #${esc.pedido_chat_creado} no está en pedidos`);
    pedidoChatInicial.push({
      id: "pc-inicial", conversacion_id: CONV, cliente_id: CLIENTE, estado: "creado", total: p.total, shopify_order_id: p.shopify_order_id,
      creado_en: p.creado_en,
      datos: {
        nombre: p.nombre_cliente ?? "", ciudad: p.direccion?.city ?? "", direccion: p.direccion?.address1 ?? "", referencia: null, ubicacion: null,
        telefono: p.telefono ?? telCliente, envio: p.envio, total: p.total,
        lineas: p.lineas.map((l) => ({ handle: l.handle ?? "", titulo: l.titulo, variante_id: l.variante_id ?? "", cantidad: l.cantidad, total: l.total })),
      },
    });
  }
  reg.pedidosChat.push(...pedidoChatInicial);
  const sacarId = (to: string) => `wamid.OUT${++n}`;
  const herramientas: DepsHerramientas = {
    ...base,
    pedidosWeb: pw,
    // 26-10: courier de la ciudad desde la rpc sugerir_courier real (solo lectura), igual que producción.
    consultarCourier: depsHerramientasReales.consultarCourier,
    catalogoShopify: (estado) => catalogo(estado),
    ahoraMs: () => Date.now(),
    pedidosDeCliente: () => Promise.resolve([...pedidos.values()]
      .filter((p) => p.cliente_id === CLIENTE || ult9(p.telefono) === ult9(telCliente))
      .map((p): PedidoCliente => ({
        shopify_order_id: p.shopify_order_id, nombre: p.nombre, estado_confirmacion: p.cancelado ? "cancelado" : p.estado_confirmacion ?? "pendiente",
        estado_envio: p.despachado ? "EN_CAMINO" : null, courier: null, total: p.total, creado_en: p.creado_en, ultimo_estado: null,
      }))),
    guardarPedidoChat: async (f) => {
      const nuevo = !f.id;
      const r = await base.guardarPedidoChat(f);
      // 20-10: el doble de prueba fecha el resumen en 2026-10-06 (reloj fijo): con el reloj del simulador el
      // "Confirmo" daba resumen_vencido. Se fecha con la hora simulada.
      if (nuevo) r.creado_en = new Date(reloj).toISOString();
      anotar("db", "guardarPedidoChat", { id: r.id, estado: r.estado, total: r.total });
      return r;
    },
    crearOrdenShopify: async (input) => {
      const o = (input as { order?: { tags?: string[] } }).order;
      anotar("shopify", "orderCreate", { tags: o?.tags ?? [] });
      return await base.crearOrdenShopify(input);
    },
    entradasDesde: (_c, desde) => Promise.resolve(historial.filter((f) => f.direccion === "in" && f.creado_en >= desde).map((f) => {
      const c = (f.contenido ?? {}) as Record<string, unknown>;
      return String(typeof c.texto_vendedor === "string" ? c.texto_vendedor : f.texto ?? "");
    }).filter(Boolean)),
    pedidoTiendaAbierto: () => {
      const lim = reloj - 72 * 3600_000;
      const p = [...pedidos.values()].filter((x) => x.cliente_id === CLIENTE && !x.cancelado && !x.despachado && Date.parse(x.creado_en) >= lim)
        .sort((a, b) => b.creado_en.localeCompare(a.creado_en))[0];
      return Promise.resolve(p ? { shopify_order_id: p.shopify_order_id, creado_en: p.creado_en } : null);
    },
    pedidoParaCourier: (id) => {
      const p = pedidos.get(id);
      return Promise.resolve(p ? { nombre: p.nombre, telefono: p.telefono, raw: null, courier: null, despachado: p.despachado } : null);
    },
    actualizarDireccionOrden: (id, d) => (anotar("shopify", "actualizarDireccionOrden", { pedido: pedidos.get(id)?.nombre ?? id, ...d }), Promise.resolve({ ok: true })),
    programarEntregaOrden: (id, fecha, franja) => (anotar("shopify", "programarEntregaOrden", { pedido: pedidos.get(id)?.nombre ?? id, fecha, franja }), Promise.resolve({ ok: true })),
    crearOrdenShopify: (input) => {
      const numero = ++siguienteNuevo;
      anotar("shopify", "crearOrdenShopify (orderCreate)", input);
      // 26-10: el pedido creado queda legible (pedidoCompleto), como en Shopify: lo necesita la oferta extra post-compra.
      const o = (input as { order?: Record<string, unknown> }).order ?? {};
      const items = (o.lineItems ?? []) as Array<{ variantId: string; quantity: number; priceSet: { shopMoney: { amount: string } } }>;
      const envio = Number(((o.shippingLines ?? []) as Array<{ priceSet: { shopMoney: { amount: string } } }>)[0]?.priceSet.shopMoney.amount ?? 0);
      const dir = (o.shippingAddress ?? null) as Record<string, string | null> | null;
      const id = 9_000_000_000 + numero;
      const lineasNuevas = items.map((l, i) => {
        const prod = prods.find((x) => x.variantes.some((v) => v.id === l.variantId));
        return {
          line_item_id: `gid://shopify/LineItem/${numero}${i}`, variante_id: l.variantId, handle: prod?.handle ?? "",
          titulo: prod?.title ?? "", cantidad: l.quantity, total: Number(l.priceSet.shopMoney.amount) * l.quantity,
        };
      });
      pedidos.set(id, {
        shopify_order_id: id, gid: `gid://shopify/Order/${id}`, nombre: `#${numero}`, creado_en: ahora().toISOString(),
        telefono: (o.phone as string) ?? telCliente, email: null, cliente_id: CLIENTE, customer_gid: null,
        nombre_cliente: dir ? `${dir.firstName ?? ""} ${dir.lastName ?? ""}`.trim() : null,
        total: lineasNuevas.reduce((x, l) => x + l.total, 0) + envio, envio, cancelado: false, despachado: false,
        estado_confirmacion: "confirmado", app: "Voltra OS", merchant_editable: true, tags: (o.tags as string[]) ?? [],
        atributos: (o.customAttributes as Array<{ key: string; value: string }>) ?? [], nota: (o.note as string) ?? null,
        direccion: dir ? { firstName: dir.firstName ?? null, lastName: dir.lastName ?? null, address1: dir.address1 ?? null, address2: dir.address2 ?? null, city: dir.city ?? null, countryCode: dir.countryCode ?? "PY", phone: dir.phone ?? null } : null,
        lineas: lineasNuevas,
      } as never);
      return Promise.resolve({ ok: true, shopify_order_id: id, gid: `gid://shopify/Order/${id}`, nombre: `#${numero}`, total: null, nodo: { id: `gid://shopify/Order/${id}`, name: `#${numero}` } });
    },
    registrarComoReleasit: (nodo) => (anotar("db", "registrarComoReleasit (shopify_pedidos + confirmación)", { pedido: nodo.name ?? nodo.id }), Promise.resolve()),
    pasarAHumano: (id) => {
      estadoConv = "humano";
      anotar("db", "pasarAHumano", { conversacion: id });
      return Promise.resolve();
    },
    avisar: (texto, botones) => (anotar("telegram", "avisar", { texto: texto.replace(/<[^>]+>/g, ""), botones: botones ? "sí" : undefined }), Promise.resolve({ ok: true })),
    enviarTexto: (to, texto) => {
      const id = sacarId(to);
      salidas.push({ tipo: "texto", texto });
      fila({ direccion: "out", texto, tipo: "text", contenido: { messaging_product: "whatsapp", to, type: "text", text: { body: texto } }, wa_message_id: id, estado: "enviado" });
      return Promise.resolve({ ok: true, wa_message_id: id });
    },
    enviarInteractivo: (to, interactive) => {
      const id = sacarId(to);
      const i = interactive as Record<string, unknown> & { type?: string };
      const visibles = textosVisibles(i as never);
      // deno-lint-ignore no-explicit-any
      const a = (i.action ?? {}) as any;
      const botones: Array<{ id: string; titulo: string }> = [];
      for (const b of a.buttons ?? []) {
        const r = b?.reply ?? b?.quick_reply;
        if (r?.id) botones.push({ id: r.id, titulo: r.title ?? "" });
      }
      for (const s of a.sections ?? []) for (const r of s?.rows ?? []) if (r?.id) botones.push({ id: r.id, titulo: r.title ?? "" });
      for (const c of a.cards ?? []) for (const b of c?.action?.buttons ?? []) if (b?.quick_reply?.id) botones.push({ id: b.quick_reply.id, titulo: b.quick_reply.title ?? "" });
      if (a.parameters?.display_text) botones.push({ id: `url:${a.parameters.url ?? ""}`, titulo: a.parameters.display_text });
      if (a.name === "send_location") botones.push({ id: "pedir_ubicacion", titulo: "Enviar ubicación" });
      if (a.parameters?.flow_cta) botones.push({ id: `flow:${a.parameters.flow_id ?? ""}`, titulo: a.parameters.flow_cta });
      const cuerpo = String(((i.body ?? {}) as Record<string, unknown>).text ?? visibles[0] ?? "");
      salidas.push({ tipo: "interactivo", cuerpo, botones, raw: i });
      fila({
        direccion: "out", texto: `[${i.type ?? "interactive"}] ${visibles.join(" | ")}`.trim(), tipo: "interactive",
        contenido: { messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive", interactive: i }, wa_message_id: id, estado: "enviado",
      });
      return Promise.resolve({ ok: true, wa_message_id: id });
    },
    enviarMedia: (to, tipo, link, caption) => {
      const id = sacarId(to);
      salidas.push({ tipo: "media", media: tipo, link, caption });
      fila({ direccion: "out", texto: caption ?? `[${tipo}]`, tipo, contenido: { type: tipo, [tipo]: { link, caption } }, wa_message_id: id, estado: "enviado" });
      return Promise.resolve({ ok: true, wa_message_id: id });
    },
    consentimiento: () => Promise.resolve(esc.consentimiento === undefined ? "preguntado" : esc.consentimiento),
    estadoOfertaPrioridad: () => Promise.resolve(null),
    direccionDePin: () => Promise.resolve(esc.mapa ?? { calle: "Calle Inventada", ciudad: "Ciudad del Este" }),
  };

  const ultimoEntrante = () => [...historial].reverse().find((f) => f.direccion === "in")?.wa_message_id ?? null;
  const deps: DepsOrquestador = {
    config: () => Promise.resolve(cfg),
    conversacion: (id) => Promise.resolve({
      id, estado: estadoConv, cliente_id: CLIENTE,
      turnos_ia: turnosTodos.filter((t) => t.accion === "respondido").length, perfil_vendedor: perfil,
    }),
    cliente: () => Promise.resolve({ id: CLIENTE, telefono: telCliente, wa_user_id: null, nombre: nombreCliente }),
    historial: (_c, limite) => Promise.resolve(historial.slice(-limite).map(({ creado_en: _x, ...f }) => f)),
    ultimoEntranteId: () => Promise.resolve(ultimoEntrante()),
    gastoMesUsd: () => Promise.resolve(esc.gasto_mes_usd ?? 0),
    preciosPrevios: () => {
      const m: number[] = [];
      for (const t of turnosTodos) for (const h of t.herramientas) if (!h.error) m.push(...montosDeResultado(h.resultado));
      return Promise.resolve([...new Set(m)]);
    },
    registrarTurno: (f) => (turnosTodos.push(f), Promise.resolve()),
    sumarTurno: () => Promise.resolve(),
    guardarPerfil: (_c, p) => ((perfil = p), Promise.resolve()),
    aleatorio: () => 0,
    marcarLeidoYEscribiendo: () => Promise.resolve(),
    llamarModelo: (p) => depsOrquestadorReales.llamarModelo(p),
    // 26-10: plazos con la tabla de tarifas real (solo lectura), igual que producción.
    cargarTarifasCourier: depsOrquestadorReales.cargarTarifasCourier,
    dormir: (ms) => ((reloj += ms), Promise.resolve()),
    ahora,
    herramientas,
  };

  // Deps mínimas del webhook para conPedidoAbierto (mismo texto que producción).
  const depsWebhook = {
    ahora,
    pedidosPorEstado: (clienteId: string, telefono: string | null, estado: string, desde: string) => Promise.resolve(
      [...pedidos.values()].filter((p) => p.estado_confirmacion === estado && p.creado_en >= desde &&
        ((p.cliente_id && p.cliente_id === clienteId) || (telefono && ult9(p.telefono) === ult9(telefono))))
        .map((p) => ({
          shopify_order_id: p.shopify_order_id, nombre: p.nombre, estado_confirmacion: p.estado_confirmacion, estado_envio: null, creado_en: p.creado_en,
          raw: {
            cancelled_at: p.cancelado ? p.creado_en : null, fulfillment_status: p.despachado ? "fulfilled" : null, total_price: String(p.total),
            line_items: p.lineas.map((l) => ({ quantity: l.cantidad, title: l.titulo })),
            shipping_address: { address1: p.direccion?.address1, address2: p.direccion?.address2, city: p.direccion?.city },
          },
        })),
    ),
  };

  /** 21-10: recontactos que salieron en la simulación (seguimiento-chat los marca en el perfil). */
  let segSim = { seguimientos: 0, ultimo_seguimiento_en: null as string | null };
  let ultimaDecision: { contexto: boolean } = { contexto: false };
  /** 21-10: la decisión real de seguimiento-chat (config por defecto) con el chat simulado; null = el seguimiento sale. */
  const motivoSinSeguimiento = (filas: Array<FilaHistorial & { creado_en: string }>, perfilActual: unknown, en: Date): string | null => {
    const ultimoIn = [...filas].reverse().find((f) => f.direccion === "in");
    const ultimo = filas.filter((f) => f.estado !== "fallido").at(-1);
    const resumen = reg.pedidosChat.at(-1)?.estado === "resumen";
    const d = decidirSeguimiento({
      conversacion_id: CONV, cliente_id: CLIENTE, estado: "ia", ultima_entrada_en: ultimoIn?.creado_en ?? null,
      perfil: { ...((perfilActual ?? {}) as Record<string, unknown>), ...(segSim.ultimo_seguimiento_en ? segSim : {}) },
      ultimo_mensaje: ultimo ? { direccion: ultimo.direccion as "in" | "out", creado_en: ultimo.creado_en } : null,
      ultima_respuesta_derivada: false, pedido_reciente: reg.pedidosChat.some((p) => p.estado === "creado"), baja_marketing: false,
      datos_pedido_parciales: hayDatosPedidoParciales(filas.map((f) => ({ direccion: f.direccion as "in" | "out", tipo: f.tipo ?? null, texto: f.texto ?? null, estado: f.estado })), resumen),
    }, leerCfgSeguimiento(undefined), en);
    if (d.tipo === "nada") return d.motivo;
    ultimaDecision = { contexto: !!d.contexto };
    segSim = { seguimientos: d.numero, ultimo_seguimiento_en: en.toISOString() };
    return null;
  };
  const pasos: ResultadoPaso[] = [];
  let numSeg = 0;
  for (const [i, paso0] of esc.pasos.entries()) {
    const paso: { texto: string; origen: "cliente" | "seguimiento"; espera_min?: number; agrupar?: boolean; decidir?: boolean } = typeof paso0 === "string"
      ? { texto: paso0, origen: "cliente" }
      : { texto: paso0.texto, origen: paso0.origen ?? "cliente", espera_min: paso0.espera_min, agrupar: paso0.agrupar, decidir: paso0.decidir };
    escrituras = [];
    salidas = [];
    const turnosAntes = turnosTodos.length;
    reloj += (paso.espera_min ?? 0.5) * 60_000; // 30 s entre mensajes salvo que el paso diga otra cosa
    let alVendedor: string;
    let waId: string;
    if (paso.origen === "seguimiento") {
      numSeg++;
      alVendedor = paso.texto;
      waId = `seguimiento:${numSeg}:${CONV}:${ahora().toISOString()}`;
    } else {
      // Mensaje de Meta tal como lo recibe wa-webhook.
      let marcaManual = "";
      let txt = paso.texto;
      if (txt.startsWith("marca:")) {
        const [m, ...resto] = txt.slice(6).split("|");
        marcaManual = m.trim();
        txt = resto.join("|").trim();
      }
      // deno-lint-ignore no-explicit-any
      let m: any;
      if (txt.startsWith("boton:")) {
        const titulo = txt.slice(6).trim().toLowerCase();
        const sal = [...historial].reverse().find((f) => f.direccion === "out" && f.tipo === "interactive" && botonesDe(f).some((b) => b.titulo.toLowerCase() === titulo));
        const b = sal ? botonesDe(sal).find((x) => x.titulo.toLowerCase() === titulo)! : null;
        if (!b) throw new Error(`${esc.nombre} paso ${i}: no hay un botón "${txt.slice(6)}" en lo que mandó el bot`);
        m = { type: "interactive", interactive: { type: "button_reply", button_reply: { id: b.id, title: b.titulo } } };
      } else if (txt.startsWith("ubicacion:")) {
        const [lat, lng] = txt.slice(10).split(",").map((x) => Number(x.trim()));
        m = { type: "location", location: { latitude: lat, longitude: lng } };
      } else m = { type: "text", text: { body: txt } };
      waId = `wamid.IN${++n}`;
      m.id = waId;
      let texto = textoParaVendedor(m) ?? "";
      if (marcaManual) texto = `${marcaManual}\n${texto}`;
      // conMarcaDeAnuncio: en el mensaje con referral (el primero) o mientras el perfil no tenga producto.
      const contenido: Record<string, unknown> = { ...m };
      const perfilProducto = (perfil as { producto?: string } | null)?.producto;
      if (esc.anuncio && (i === 0 || !perfilProducto)) {
        const base = marcaAnuncio({ handle: esc.anuncio, nombre: nombreDeHandle(esc.anuncio) });
        // 21-10: como wa-webhook, el texto del anuncio (referral.body) va en una segunda marca, solo en el primer mensaje.
        const tAnuncio = i === 0 ? textoDelAnuncio({ body: esc.anuncio_texto ?? "" }) : null;
        const marca = tAnuncio ? `${base}\n${marcaTextoAnuncio(tAnuncio)}` : base;
        if (!texto.includes(base)) {
          texto = `${marca}\n${texto}`;
          contenido.marca_anuncio = marca;
        }
      }
      // deno-lint-ignore no-explicit-any
      texto = await conPedidoAbierto(depsWebhook as any, CLIENTE, telCliente, texto);
      if (m.type !== "text") contenido.texto_vendedor = texto;
      fila({ direccion: "in", texto: textoDeMensaje(m), tipo: m.type, contenido, wa_message_id: waId, estado: "recibido" });
      alVendedor = texto;
    }
    let resultado: ResultadoPaso["resultado"];
    if (paso.agrupar && paso.origen === "cliente") {
      pasos.push({ entrada: paso.texto, alVendedor, origen: paso.origen, salidas: [], textos: [], botones: [], turnos: [], escrituras: [], resultado: { accion: "agrupado", motivo: "llega_junto_con_el_siguiente" }, costo: 0, derivado: false });
      continue;
    }
    const noSale = paso.origen === "seguimiento" && paso.decidir ? motivoSinSeguimiento(historial, perfil, ahora()) : null;
    if (noSale) {
      pasos.push({ entrada: paso.texto, alVendedor, origen: paso.origen, salidas: [], textos: [], botones: [], turnos: [], escrituras: [], resultado: { accion: "omitido", motivo: `seguimiento-chat:${noSale}` }, costo: 0, derivado: false });
      continue;
    }
    // 21-10: con el pedido a medio armar, seguimiento-chat manda "[seguimiento con datos]" en lugar de "[seguimiento N]".
    if (paso.origen === "seguimiento" && paso.decidir && ultimaDecision.contexto) {
      alVendedor = TEXTO_SEGUIMIENTO_CONTEXTO;
      waId = `seguimiento:${numSeg}:${CONV}:${ahora().toISOString()}`;
    }
    try {
      resultado = await procesarTurno({ conversacion_id: CONV, wa_message_id: waId, texto: alVendedor, origen: paso.origen }, deps);
    } catch (e) {
      resultado = { accion: "error", motivo: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) };
    }
    const turnos = turnosTodos.slice(turnosAntes);
    const textos = salidas.flatMap((s) => s.tipo === "texto" ? [s.texto] : s.tipo === "interactivo" ? [s.cuerpo] : s.caption ? [s.caption] : []);
    const botones = salidas.flatMap((s) => s.tipo === "interactivo" ? s.botones : []);
    pasos.push({
      entrada: paso.texto, alVendedor, origen: paso.origen, salidas: [...salidas], textos, botones, turnos, escrituras: [...escrituras], resultado,
      costo: turnos.reduce((s, t) => s + (t.costo_usd ?? 0), 0), derivado: turnos.some((t) => t.derivado),
    });
    gastoCorrida += pasos.at(-1)!.costo;
    if (gastoCorrida > topeUsd) throw new Error(`tope de la corrida superado (USD ${gastoCorrida.toFixed(4)} > ${topeUsd})`);
  }
  return { pasos, ctx: { modificaciones, prods, cfg, vinculos } };
}

function botonesDe(f: FilaHistorial): Array<{ id: string; titulo: string }> {
  // deno-lint-ignore no-explicit-any
  const a = ((f.contenido as any)?.interactive?.action ?? {}) as any;
  const out: Array<{ id: string; titulo: string }> = [];
  for (const b of a.buttons ?? []) {
    const r = b?.reply ?? b?.quick_reply;
    if (r?.id) out.push({ id: r.id, titulo: r.title ?? "" });
  }
  for (const s of a.sections ?? []) for (const r of s?.rows ?? []) if (r?.id) out.push({ id: r.id, titulo: r.title ?? "" });
  for (const c of a.cards ?? []) for (const b of c?.action?.buttons ?? []) if (b?.quick_reply?.id) out.push({ id: b.quick_reply.id, titulo: b.quick_reply.title ?? "" });
  return out;
}

// ---------- chequeos ----------

type ResultadoCheck = { desc: string; ok: boolean; detalle: string; suave: boolean };

function descCheck(c: Check): string {
  if (c.desc) return c.desc;
  const neg = c.negar ? "NO " : "";
  switch (c.tipo) {
    case "responde": return "responde (no silencio)";
    case "herramienta": return `${neg}${c.con_errores ? "intenta" : "usa"} ${c.nombre}`;
    case "texto": return `${neg}texto ~ ${c.regex}`;
    case "boton": return `${neg}botón ~ ${c.regex}`;
    case "escritura": return `${neg}escritura ~ ${c.regex}`;
    case "derivado": return `${neg}deriva a Enrique`;
    case "montos_catalogo": return "montos solo del catálogo";
    default: return "chequeo";
  }
}

function evaluar(esc: Escenario, pasos: ResultadoPaso[], ctx: Record<string, unknown>): ResultadoCheck[] {
  const cfg = ctx.cfg as ConfigTurno;
  const prods = ctx.prods as ProductoShopify[];
  const ctxFalso = { cfg } as never;
  const items = itemsCatalogo(prods, ctxFalso);
  const precio = (handle: string, cantidad: number) => {
    const it = items.find((x) => x.handle === handle);
    if (!it) return NaN;
    if (cantidad === 1) return it.precio;
    return it.ofertas.find((o) => o.cantidad === cantidad)?.precio ?? it.precio * cantidad;
  };
  const r = {
    pasos, modificaciones: ctx.modificaciones, envio: cfg.envio.costo_gs, precio, items,
    textoPaso: (i: number) => (pasos.at(i)?.textos ?? []).join("\n"),
  };
  const permitidos = new Set<number>([cfg.envio.costo_gs]);
  for (const it of items) {
    permitidos.add(it.precio).add(it.total);
    for (const o of it.ofertas) permitidos.add(o.precio).add(o.total).add(o.ahorro);
  }
  for (const p of pasos) for (const t of p.turnos) for (const h of t.herramientas) if (!h.error) for (const x of montosDeResultado(h.resultado)) permitidos.add(x);
  for (const p of pasos) for (const m of p.alVendedor.matchAll(/total Gs (\d{4,9})/g)) permitidos.add(Number(m[1]));

  return esc.checks.map((c): ResultadoCheck => {
    const sel = c.paso === undefined ? pasos : [pasos.at(c.paso)].filter((x): x is ResultadoPaso => !!x);
    const base = { desc: (c.paso !== undefined ? `[p${c.paso}] ` : "") + descCheck(c), suave: !!c.suave };
    if (!sel.length) return { ...base, ok: false, detalle: `no existe el paso ${c.paso}` };
    let ok = false;
    let detalle = "";
    switch (c.tipo) {
      case "responde":
        ok = sel.every((p) => p.salidas.length > 0);
        detalle = ok ? "" : `silencio (${sel.map((p) => `${p.resultado.accion}${p.resultado.motivo ? `:${String(p.resultado.motivo).slice(0, 80)}` : ""}`).join(", ")})`;
        break;
      case "herramienta": {
        // Por defecto cuentan solo las llamadas que funcionaron; con_errores = también las rechazadas por la herramienta.
        const todas = sel.flatMap((p) => p.turnos.flatMap((t) => t.herramientas));
        const usadas = todas.filter((h) => c.con_errores || !h.error).map((h) => h.nombre);
        ok = usadas.some((u) => u === c.nombre || u.startsWith(`${c.nombre}(`));
        detalle = `usadas: ${todas.map((h) => h.nombre + (h.error ? "(error)" : "")).join(", ") || "ninguna"}`;
        break;
      }
      case "texto": {
        const t = sel.flatMap((p) => p.textos).join("\n");
        ok = !!c.regex?.test(t);
        detalle = ok && c.negar ? `coincide: "${corto(t.match(c.regex!)?.[0], 80)}"` : "";
        break;
      }
      case "boton": {
        const b = sel.flatMap((p) => p.botones.map((x) => `${x.titulo} (${x.id})`));
        ok = b.some((x) => c.regex!.test(x));
        detalle = `botones: ${b.join(" · ") || "ninguno"}`;
        break;
      }
      case "escritura": {
        const e = sel.flatMap((p) => p.escrituras.map((x) => `${x.op} ${JSON.stringify(x.detalle)}`));
        ok = e.some((x) => c.regex!.test(x));
        detalle = `escrituras: ${e.map((x) => x.split(" ")[0]).join(", ") || "ninguna"}`;
        break;
      }
      case "derivado":
        ok = sel.some((p) => p.derivado);
        break;
      case "montos_catalogo": {
        const malos = sel.flatMap((p) => p.textos.flatMap((t) => extraerMontos(t))).filter((x) => !permitidos.has(x));
        ok = malos.length === 0;
        detalle = ok ? "" : `montos fuera del catálogo: ${[...new Set(malos)].map(gs).join(", ")}`;
        return { ...base, ok, detalle };
      }
      case "fn": {
        try {
          const x = c.fn!(r);
          ok = x === true;
          detalle = x === true ? "" : String(x);
        } catch (e) {
          ok = false;
          detalle = `error: ${e instanceof Error ? e.message : e}`;
        }
        return { ...base, ok, detalle };
      }
    }
    if (c.negar) ok = !ok;
    return { ...base, ok, detalle };
  });
}

// ---------- transcript ----------

function transcript(esc: Escenario, pasos: ResultadoPaso[], checks: ResultadoCheck[], etiquetaPrompt: string, modelo: string): string {
  const L: string[] = [];
  L.push(`# Simulación: ${esc.nombre}`, "", `${esc.descripcion}`, "", `Prompt: ${etiquetaPrompt} · modelo: ${modelo} · ${new Date().toISOString()}`, "");
  for (const [i, p] of pasos.entries()) {
    L.push(`## Paso ${i} · ${p.origen === "seguimiento" ? "SEGUIMIENTO" : "CLIENTE"}: ${p.entrada}`);
    if (p.alVendedor !== p.entrada) L.push("", "Al vendedor (con marcas del webhook):", "```", p.alVendedor, "```");
    L.push("");
    for (const t of p.turnos) {
      for (const h of t.herramientas) {
        const res = h.resultado as Record<string, unknown> | null;
        const resumen = res && typeof res === "object"
          ? Object.fromEntries(Object.entries(res).filter(([k]) => !["frases", "productos_detalle", "nota"].includes(k)).slice(0, 8))
          : res;
        L.push(`- herramienta \`${h.nombre}\`${h.error ? " (ERROR)" : ""} input=${corto(h.input, 260)} → ${corto(resumen, 320)}`);
      }
      if (t.filtro.intentos.some((x) => !x.ok)) L.push(`- filtro: ${t.filtro.intentos.map((x) => (x.ok ? "ok" : `bloqueado(${x.motivos.join(", ")})`)).join(" → ")}`);
    }
    for (const s of p.salidas) {
      if (s.tipo === "texto") L.push(`> BOT: ${s.texto}`);
      else if (s.tipo === "interactivo") {
        L.push(`> BOT [${String(s.raw.type)}]: ${s.cuerpo.replace(/\n/g, "\n>   ")}`);
        if (s.botones.length) L.push(`>   botones: ${s.botones.map((b) => `[${b.titulo}] (${b.id})`).join("  ")}`);
      } else L.push(`> BOT [${s.media}]: ${s.link}${s.caption ? ` · ${s.caption}` : ""}`);
    }
    if (!p.salidas.length) L.push("> (sin respuesta)");
    const shop = p.escrituras.filter((e) => e.destino === "shopify");
    const otras = p.escrituras.filter((e) => e.destino !== "shopify");
    for (const e of shop) L.push(`- SHOPIFY (se habría hecho): ${e.op} ${corto(e.detalle, 600)}`);
    for (const e of otras) L.push(`- ${e.destino.toUpperCase()} (se habría hecho): ${e.op} ${corto(e.detalle, 300)}`);
    const modelos = [...new Set(p.turnos.map((t) => t.modelo))].join(", ");
    L.push(`- resultado: ${p.resultado.accion}${p.resultado.motivo ? `:${corto(p.resultado.motivo, 300)}` : ""} · modelo ${modelos || "-"} · USD ${p.costo.toFixed(4)}`, "");
  }
  L.push("## Chequeos", "");
  for (const c of checks) L.push(`- ${c.ok ? "PASS" : c.suave ? "INFO" : "FAIL"} ${c.desc}${!c.ok && c.detalle ? ` — ${c.detalle}` : ""}`);
  L.push("");
  return L.join("\n");
}

// ---------- main ----------

let gastoCorrida = 0;
const topeUsd = Number(arg("tope-usd") || 2);

if (flag("listar")) {
  for (const e of ESCENARIOS) console.log(`${e.nombre.padEnd(26)} ${e.descripcion}`);
  Deno.exit(0);
}

const filtro = arg("escenario");
const elegidos = filtro ? ESCENARIOS.filter((e) => filtro.split(",").includes(e.nombre)) : ESCENARIOS;
if (!elegidos.length) throw new Error(`no hay escenarios con ese nombre: ${filtro} (usá --listar)`);

const { plantilla, etiqueta } = await plantillaElegida();
const baseCfg = structuredClone(await depsOrquestadorReales.config());
if (plantilla) baseCfg.plantillaPrompt = plantilla;
const modeloArg = arg("modelo") || null;
const modelo = modeloArg ?? baseCfg.vendedor.modelo;
console.log(`Prompt: ${etiqueta} · modelo: ${modelo} · escenarios: ${elegidos.map((e) => e.nombre).join(", ")}\n`);

const fecha = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const dirLogs = `${RAIZ}logs/simulaciones`;
if (!flag("sin-archivo")) await Deno.mkdir(dirLogs, { recursive: true });

type Fila = { nombre: string; checks: ResultadoCheck[]; burbujas: number; largo: number; costo: number; error?: string };
const resumen: Fila[] = [];
for (const esc of elegidos) {
  let out: Awaited<ReturnType<typeof correrEscenario>>;
  try {
    out = await correrEscenario(esc, baseCfg, modeloArg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\n### ${esc.nombre}: ERROR del simulador: ${msg}\n`);
    resumen.push({ nombre: esc.nombre, checks: [], burbujas: 0, largo: 0, costo: 0, error: msg });
    if (msg.startsWith("tope de la corrida")) break;
    continue;
  }
  const checks = evaluar(esc, out.pasos, out.ctx);
  const md = transcript(esc, out.pasos, checks, etiqueta, modelo);
  console.log(md);
  if (!flag("sin-archivo")) await Deno.writeTextFile(`${dirLogs}/${fecha}-${esc.nombre}.md`, md);
  const textos = out.pasos.flatMap((p) => p.textos);
  resumen.push({
    nombre: esc.nombre, checks, burbujas: textos.length,
    largo: textos.length ? Math.round(textos.reduce((s, t) => s + t.length, 0) / textos.length) : 0,
    costo: out.pasos.reduce((s, p) => s + p.costo, 0),
  });
}

// Tabla resumen
const filasTabla = resumen.map((f) => {
  const pass = f.checks.filter((c) => c.ok).length;
  const fail = f.checks.filter((c) => !c.ok && !c.suave);
  const estado = f.error ? "ERROR" : fail.length ? "FAIL" : "PASS";
  return { ...f, pass, fail, estado };
});
const lineas: string[] = [];
lineas.push(`## Resumen (${etiqueta} · ${modelo})`, "");
lineas.push("| escenario | estado | chequeos PASS/total | burbujas | largo prom. (car.) | USD |");
lineas.push("|---|---|---|---|---|---|");
for (const f of filasTabla) {
  lineas.push(`| ${f.nombre} | ${f.estado} | ${f.pass}/${f.checks.length} | ${f.burbujas} | ${f.largo} | ${f.costo.toFixed(4)} |`);
}
const total = filasTabla.reduce((s, f) => s + f.costo, 0);
lineas.push(`| **total** | | | ${filasTabla.reduce((s, f) => s + f.burbujas, 0)} | | ${total.toFixed(4)} |`, "");
for (const f of filasTabla) {
  if (f.error) lineas.push(`- ${f.nombre}: ERROR ${f.error.split("\n")[0]}`);
  for (const c of f.checks) if (!c.ok) lineas.push(`- ${f.nombre}: ${c.suave ? "INFO" : "FAIL"} ${c.desc}${c.detalle ? ` — ${c.detalle}` : ""}`);
}
const tabla = lineas.join("\n");
console.log(tabla);
if (!flag("sin-archivo")) {
  await Deno.writeTextFile(`${dirLogs}/${fecha}-resumen.md`, tabla + "\n");
  console.log(`\nTranscripts en logs/simulaciones/${fecha}-*.md`);
}
