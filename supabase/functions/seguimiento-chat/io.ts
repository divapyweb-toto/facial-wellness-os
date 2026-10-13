// seguimiento-chat · I/O real (Supabase, vendedor, Telegram, WhatsApp). La lógica está en logica.ts y toque3.ts.
import { deducirProductoAnuncio } from "../_shared/anuncios.ts";
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { enviarPlantilla } from "../_shared/wa.ts";
import { inicioMesAsuncionISO, procesarTurno } from "../_shared/vendedor/orquestador.ts";
import { depsHerramientasReales, depsOrquestadorReales } from "../_shared/vendedor/io.ts";
import { registrarBaja } from "../recompra/baja.ts";
import type { Candidato, CfgSeguimiento, DepsSeguimiento } from "./logica.ts";
import type { HistorialMk, PreciosToque3 } from "./toque3.ts";

function falla(contexto: string, error: { message: string } | null): void {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

const DIA = 24 * 3_600_000;
/** Acciones de vendedor_turnos que no son una respuesta al cliente (no cuentan para "¿la última fue una derivación?"). */
const NO_RESPUESTA = /^(?:seguimiento_)?(?:agrupado|omitido)/;

type FilaConv = {
  id: string;
  estado: string;
  cliente_id: string;
  ultima_entrada_en: string | null;
  perfil_vendedor: unknown;
  origen_anuncio_id?: string | null;
};

const COLUMNAS_CONV = "id,estado,cliente_id,ultima_entrada_en,perfil_vendedor,origen_anuncio_id";

async function candidatos(desdeISO: string, hastaISO: string, cfg: CfgSeguimiento): Promise<Candidato[]> {
  const { data, error } = await db().from("wa_conversaciones").select(COLUMNAS_CONV)
    .eq("estado", "ia").gte("ultima_entrada_en", desdeISO).lte("ultima_entrada_en", hastaISO)
    .order("ultima_entrada_en", { ascending: true }).limit(150); // 150: los .in() de abajo viajan en la URL
  falla("conversaciones", error);
  return await enriquecer((data ?? []) as FilaConv[], desdeISO, cfg);
}

/** Recontacto el día que cobra: recontactar_el <= hoy (Asunción) y todavía sin recontacto_cobro_en. */
async function candidatosCobro(hoyYMD: string, cfg: CfgSeguimiento): Promise<Candidato[]> {
  const { data, error } = await db().from("wa_conversaciones").select(COLUMNAS_CONV)
    .eq("estado", "ia").lte("perfil_vendedor->>recontactar_el", hoyYMD).is("perfil_vendedor->>recontacto_cobro_en", null)
    .order("ultima_entrada_en", { ascending: true }).limit(50);
  falla("conversaciones para recontacto por cobro", error);
  const convs = (data ?? []) as FilaConv[];
  // La última entrada puede ser de hace días: los mensajes y turnos se leen desde la más vieja (máx. 30 días atrás).
  const piso = Date.now() - 30 * DIA;
  const masVieja = Math.min(...convs.map((c) => (c.ultima_entrada_en ? Date.parse(c.ultima_entrada_en) : piso)).filter(Number.isFinite));
  return await enriquecer(convs, new Date(Math.max(piso, Number.isFinite(masVieja) ? masVieja : piso)).toISOString(), cfg);
}

/**
 * 12-10 · toque 3: conversaciones de anuncio en 'ia' creadas desde creadasDesdeISO (las 72 h gratis) que no escriben
 * desde entradaHastaISO. Lee todos sus mensajes (primera respuesta del bot, plantillas ya enviadas) y el producto
 * del anuncio (config_wa.anuncios_producto).
 */
async function candidatosToque3(creadasDesdeISO: string, entradaHastaISO: string, cfg: CfgSeguimiento): Promise<Candidato[]> {
  const sb = db();
  const [convs, mapeo] = await Promise.all([
    sb.from("wa_conversaciones").select(COLUMNAS_CONV).eq("estado", "ia").not("origen_anuncio_id", "is", null)
      .gte("creado_en", creadasDesdeISO).lte("ultima_entrada_en", entradaHastaISO)
      .order("creado_en", { ascending: true }).limit(150), // 150: los .in() de enriquecer viajan en la URL
    sb.from("config_wa").select("valor").eq("clave", "anuncios_producto").maybeSingle(),
  ]);
  falla("conversaciones para el toque 3", convs.error);
  falla("config_wa anuncios_producto", mapeo.error);
  const cands = await enriquecer((convs.data ?? []) as FilaConv[], creadasDesdeISO, cfg);
  return cands.map((c) => ({
    ...c,
    handle_anuncio: deducirProductoAnuncio({ adId: c.origen_anuncio_id ?? null, mapeo: mapeo.data?.valor })?.handle ?? null,
  }));
}

/** Guarda (ISO) o borra (null) claves sueltas de perfil_vendedor sin pisar el resto (lee el perfil fresco). */
async function marcarClavesPerfil(conversacionId: string, marcas: Record<string, string | null>, contexto: string): Promise<void> {
  const sb = db();
  const { data, error } = await sb.from("wa_conversaciones").select("perfil_vendedor").eq("id", conversacionId).maybeSingle();
  falla(`leer perfil para ${contexto}`, error);
  const actual = data?.perfil_vendedor && typeof data.perfil_vendedor === "object" && !Array.isArray(data.perfil_vendedor)
    ? { ...(data.perfil_vendedor as Record<string, unknown>) }
    : {};
  for (const [k, v] of Object.entries(marcas)) {
    if (v) actual[k] = v;
    else delete actual[k];
  }
  const r = await sb.from("wa_conversaciones").update({ perfil_vendedor: actual }).eq("id", conversacionId);
  falla(`marcar ${contexto}`, r.error);
}

/** Texto de un error guardado en wa_mensajes.error: {motivo} de _shared/wa.ts o [{code, title}] del webhook. */
function textoError(e: unknown): string {
  if (Array.isArray(e) && e.length && e[0] && typeof e[0] === "object") {
    const x = e[0] as { code?: unknown; title?: unknown; message?: unknown };
    return `${x.code ?? "?"}: ${x.title ?? x.message ?? ""}`;
  }
  if (e && typeof e === "object" && typeof (e as { motivo?: unknown }).motivo === "string") return (e as { motivo: string }).motivo;
  return typeof e === "string" ? e : JSON.stringify(e ?? null);
}

/**
 * Conversaciones → Candidato: último mensaje, ¿última respuesta derivada?, pedido reciente, baja de marketing,
 * nombre y teléfono. `desdeISO`: desde cuándo leer mensajes y turnos (≤ la última entrada de cada conversación).
 * 12-10 (toque 3): también primera respuesta y plantillas enviadas desde `desdeISO`, consentimiento vigente,
 * wa_user_id y si el último saliente lo mandó Enrique a mano.
 */
async function enriquecer(convs: FilaConv[], desdeISO: string, cfg: CfgSeguimiento): Promise<Candidato[]> {
  if (!convs.length) return [];
  const sb = db();
  const ids = convs.map((c) => c.id);
  const clientes = [...new Set(convs.map((c) => c.cliente_id))];
  const desdePedido = new Date(Date.now() - cfg.dias_pedido * DIA).toISOString();

  const [msgs, turnos, telefonos, pedidosChat, consent] = await Promise.all([
    // El último mensaje siempre es posterior a ultima_entrada_en (≥ desdeISO).
    sb.from("wa_mensajes").select("conversacion_id,direccion,estado,texto,creado_en,tipo,plantilla:contenido->template->>name,origen:contenido->>origen").in("conversacion_id", ids)
      .gte("creado_en", desdeISO).order("creado_en", { ascending: false }).limit(10000),
    sb.from("vendedor_turnos").select("conversacion_id,derivado,accion,creado_en").in("conversacion_id", ids)
      .gte("creado_en", desdeISO).order("creado_en", { ascending: false }).limit(5000),
    sb.from("wa_clientes").select("id,telefono,nombre,wa_user_id").in("id", clientes),
    sb.from("wa_pedidos_chat").select("conversacion_id,creado_en").in("conversacion_id", ids).eq("estado", "creado").gte("creado_en", desdePedido),
    sb.from("wa_consentimientos").select("cliente_id,estado,creado_en").in("cliente_id", clientes).eq("tipo", "marketing")
      .order("creado_en", { ascending: false }),
  ]);
  falla("mensajes", msgs.error);
  falla("turnos", turnos.error);
  falla("clientes", telefonos.error);
  falla("pedidos del chat", pedidosChat.error);
  falla("consentimientos", consent.error);

  // Pedidos de Shopify del cliente (por cliente_id o por teléfono), no borradores, en los últimos días.
  const telDe = new Map((telefonos.data ?? []).map((c) => [c.id as string, (c.telefono as string | null) ?? null]));
  const nombreDe = new Map((telefonos.data ?? []).map((c) => [c.id as string, (c.nombre as string | null) ?? null]));
  const waUserDe = new Map((telefonos.data ?? []).map((c) => [c.id as string, (c.wa_user_id as string | null) ?? null]));
  const tels = [...new Set([...telDe.values()].filter((t): t is string => !!t))];
  const [porCliente, porTel] = await Promise.all([
    sb.from("shopify_pedidos").select("cliente_id,creado_en").in("cliente_id", clientes).eq("es_borrador", false).gte("creado_en", desdePedido),
    tels.length
      ? sb.from("shopify_pedidos").select("telefono,creado_en").in("telefono", tels).eq("es_borrador", false).gte("creado_en", desdePedido)
      : Promise.resolve({ data: [] as { telefono: string; creado_en: string }[], error: null }),
  ]);
  falla("pedidos por cliente", porCliente.error);
  falla("pedidos por teléfono", porTel.error);
  const clientesConPedido = new Set((porCliente.data ?? []).map((p) => p.cliente_id as string));
  const telsConPedido = new Set((porTel.data ?? []).map((p) => p.telefono as string));
  const convsConPedidoChat = new Set((pedidosChat.data ?? []).map((p) => p.conversacion_id as string));
  // Fecha del último pedido por clave (para el aviso de intención: ¿hubo pedido después de la señal de compra?).
  const ultimoPedido = new Map<string, string>();
  const anotar = (k: string | null | undefined, en: unknown) => {
    if (!k || typeof en !== "string") return;
    const prev = ultimoPedido.get(k);
    if (!prev || Date.parse(en) > Date.parse(prev)) ultimoPedido.set(k, en);
  };
  for (const p of porCliente.data ?? []) anotar(`c:${p.cliente_id}`, p.creado_en);
  for (const p of porTel.data ?? []) anotar(`t:${p.telefono}`, p.creado_en);
  for (const p of pedidosChat.data ?? []) anotar(`v:${p.conversacion_id}`, p.creado_en);
  const masNuevo = (...xs: Array<string | undefined>) =>
    xs.filter((x): x is string => !!x).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

  const ultimoMsg = new Map<string, { direccion: "in" | "out"; creado_en: string; manual?: boolean }>();
  const entradas = new Map<string, Array<{ texto: string; creado_en: string }>>();
  const primeraRespuesta = new Map<string, string>();
  const plantillas = new Map<string, Set<string>>();
  for (const m of msgs.data ?? []) {
    if (m.direccion === "in" && typeof m.texto === "string" && m.texto.trim()) {
      const l = entradas.get(m.conversacion_id) ?? [];
      if (l.length < 30) l.push({ texto: m.texto.slice(0, 500), creado_en: m.creado_en });
      entradas.set(m.conversacion_id, l);
    }
    if (m.direccion === "out" && m.estado === "fallido") continue;
    if (m.direccion === "out") {
      primeraRespuesta.set(m.conversacion_id, m.creado_en); // vienen de la más nueva a la más vieja: queda la primera
      if (m.tipo === "template" && typeof m.plantilla === "string" && m.plantilla) {
        plantillas.set(m.conversacion_id, (plantillas.get(m.conversacion_id) ?? new Set<string>()).add(m.plantilla));
      }
    }
    if (!ultimoMsg.has(m.conversacion_id)) {
      ultimoMsg.set(m.conversacion_id, { direccion: m.direccion, creado_en: m.creado_en, ...(m.origen === "manual" ? { manual: true } : {}) });
    }
  }
  const derivada = new Map<string, boolean>();
  for (const t of turnos.data ?? []) {
    if (derivada.has(t.conversacion_id) || NO_RESPUESTA.test(String(t.accion ?? ""))) continue;
    derivada.set(t.conversacion_id, t.derivado === true);
  }
  const consentVigente = new Map<string, string>();
  for (const c of consent.data ?? []) if (!consentVigente.has(c.cliente_id)) consentVigente.set(c.cliente_id, c.estado);

  return convs.map((c): Candidato => {
    const tel = telDe.get(c.cliente_id) ?? null;
    return {
      conversacion_id: c.id,
      cliente_id: c.cliente_id,
      estado: c.estado,
      ultima_entrada_en: c.ultima_entrada_en,
      perfil: c.perfil_vendedor,
      ultimo_mensaje: ultimoMsg.get(c.id) ?? null,
      ultima_respuesta_derivada: derivada.get(c.id) ?? false,
      pedido_reciente: clientesConPedido.has(c.cliente_id) || (!!tel && telsConPedido.has(tel)) || convsConPedidoChat.has(c.id),
      baja_marketing: consentVigente.get(c.cliente_id) === "baja",
      nombre: nombreDe.get(c.cliente_id) ?? null,
      telefono: tel,
      entradas_recientes: entradas.get(c.id) ?? [],
      ultimo_pedido_en: masNuevo(ultimoPedido.get(`c:${c.cliente_id}`), tel ? ultimoPedido.get(`t:${tel}`) : undefined, ultimoPedido.get(`v:${c.id}`)),
      origen_anuncio_id: c.origen_anuncio_id ?? null,
      primera_respuesta_en: primeraRespuesta.get(c.id) ?? null,
      plantillas_enviadas: [...(plantillas.get(c.id) ?? [])],
      consentimiento_marketing: (consentVigente.get(c.cliente_id) as Candidato["consentimiento_marketing"]) ?? null,
      wa_user_id: waUserDe.get(c.cliente_id) ?? null,
    };
  });
}

export const depsReales: DepsSeguimiento = {
  async config() {
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", "vendedor_seguimiento").maybeSingle();
    falla("config_wa vendedor_seguimiento", error);
    if (!data) console.warn("seguimiento-chat: falta config_wa.vendedor_seguimiento: uso los valores por defecto del código");
    return data?.valor ?? null;
  },

  async topeGastoSuperado(ahora) {
    const cfg = await depsOrquestadorReales.config();
    const gasto = await depsOrquestadorReales.gastoMesUsd(inicioMesAsuncionISO(ahora));
    return gasto >= cfg.vendedor.tope_mensual_usd;
  },

  candidatos,
  candidatosCobro,

  async marcar(conversacionId, seguimientos, enISO) {
    const { error } = await db().rpc("vendedor_marcar_seguimiento", {
      p_conversacion: conversacionId,
      p_seguimientos: seguimientos,
      p_en: enISO,
    });
    falla("marcar seguimiento", error);
  },

  async marcarAvisoIntencion(conversacionId, enISO) {
    // Sin RPC propia (no hay migración para esto): lee el perfil fresco y escribe solo la clave aviso_intencion_en.
    // Corre después de los turnos de recontacto de la misma corrida y con el cliente callado ≥ 30 min, así que no
    // hay un turno del vendedor escribiendo el perfil a la par. El orquestador normaliza el perfil al guardarlo y
    // descarta esta clave: si el cliente vuelve a escribir y se vuelve a callar, puede salir un aviso nuevo.
    const sb = db();
    const { data, error } = await sb.from("wa_conversaciones").select("perfil_vendedor").eq("id", conversacionId).maybeSingle();
    falla("leer perfil para aviso de intención", error);
    const actual = data?.perfil_vendedor && typeof data.perfil_vendedor === "object" && !Array.isArray(data.perfil_vendedor)
      ? { ...(data.perfil_vendedor as Record<string, unknown>) }
      : {};
    if (enISO) actual.aviso_intencion_en = enISO;
    else delete actual.aviso_intencion_en;
    const r = await sb.from("wa_conversaciones").update({ perfil_vendedor: actual }).eq("id", conversacionId);
    falla("marcar aviso de intención", r.error);
  },

  async marcarCobro(conversacionId, enISO) {
    // Mismo enfoque que marcarAvisoIntencion: lee el perfil fresco y escribe solo recontacto_cobro_en. Se marca antes
    // del turno y se desmarca después (nunca a la par del guardado de perfil del orquestador en el mismo turno).
    // normalizarPerfil("base") conserva la marca; fusionarPerfil la borra si el cliente da una fecha nueva.
    const sb = db();
    const { data, error } = await sb.from("wa_conversaciones").select("perfil_vendedor").eq("id", conversacionId).maybeSingle();
    falla("leer perfil para recontacto por cobro", error);
    const actual = data?.perfil_vendedor && typeof data.perfil_vendedor === "object" && !Array.isArray(data.perfil_vendedor)
      ? { ...(data.perfil_vendedor as Record<string, unknown>) }
      : {};
    if (enISO) actual.recontacto_cobro_en = enISO;
    else delete actual.recontacto_cobro_en;
    const r = await sb.from("wa_conversaciones").update({ perfil_vendedor: actual }).eq("id", conversacionId);
    falla("marcar recontacto por cobro", r.error);
  },

  turno: (entrada) => procesarTurno(entrada, depsOrquestadorReales),
  avisar: (texto, botones) => avisar(texto, botones),
  ahora: () => new Date(),
  paralelo: 4,

  // ---- 12-10: toque 3 (toque3.ts) ----
  candidatosToque3,

  marcarToque3(conversacionId, marcas) {
    // Mismo enfoque que marcarCobro (sin RPC propia). toque3_en la conserva normalizarPerfil("base"); toque3_fallo_en
    // no (dura hasta el próximo turno del vendedor, y para entonces el cliente ya escribió).
    return marcarClavesPerfil(conversacionId, marcas, "toque 3");
  },

  enviarPlantilla: (to, nombre, idioma, componentes, op) => enviarPlantilla(to, nombre, idioma, componentes, op),

  async preciosToque3(): Promise<PreciosToque3> {
    // Los mismos precios que ve el vendedor: config_wa (ofertas, envío) + catálogo de Shopify.
    const cfg = await depsOrquestadorReales.config();
    const productos = await depsHerramientasReales.catalogoShopify(cfg.vendedor.catalogo_estado || "ACTIVE");
    const unidad: PreciosToque3["unidad"] = {};
    for (const p of productos) {
      const v = p.variantes.find((x) => x.disponible) ?? p.variantes[0];
      if (v) unidad[p.handle] = { precio: v.price, disponible: v.disponible };
    }
    return { unidad, ofertas: cfg.ofertas as PreciosToque3["ofertas"], envio: cfg.envio.costo_gs };
  },

  async historialMarketing(clienteIds, desdeISO): Promise<HistorialMk> {
    if (!clienteIds.length) return { mensajes: [], enCola: [] };
    const sb = db();
    const [m, cola] = await Promise.all([
      sb.from("wa_mensajes").select("cliente_id,creado_en,estado,plantilla:contenido->template->>name").in("cliente_id", clienteIds)
        .eq("direccion", "out").eq("tipo", "template").neq("estado", "fallido").gte("creado_en", desdeISO)
        .order("creado_en", { ascending: false }).limit(5000),
      sb.from("envios_programados").select("cliente_id,enviar_desde").in("cliente_id", clienteIds)
        .eq("categoria", "marketing").eq("estado", "pendiente"),
    ]);
    falla("historial de marketing", m.error);
    falla("cola de marketing", cola.error);
    return {
      mensajes: (m.data ?? []).map((x) => ({
        cliente_id: x.cliente_id as string,
        creado_en: x.creado_en as string,
        estado: (x.estado as string | null) ?? null,
        plantilla: typeof x.plantilla === "string" ? x.plantilla : null,
      })),
      enCola: (cola.data ?? []).map((x) => ({ cliente_id: x.cliente_id as string, enviar_desde: x.enviar_desde as string })),
    };
  },

  async configRecompra() {
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", "recompra").maybeSingle();
    falla("config_wa recompra", error);
    return data?.valor ?? null;
  },

  async fallasRecientesToque3(plantilla, desdeISO) {
    const { data, error } = await db().from("wa_mensajes").select("error").eq("direccion", "out").eq("tipo", "template")
      .eq("estado", "fallido").eq("contenido->template->>name", plantilla).gte("creado_en", desdeISO).limit(50);
    falla("envíos fallidos del toque 3", error);
    return (data ?? []).map((x) => textoError(x.error));
  },

  registrarBaja: (clienteId) => registrarBaja(clienteId, "meta_131050"),
};
