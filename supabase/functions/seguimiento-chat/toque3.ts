// seguimiento-chat · toque 3 (12-10-2026, plan de ventas por WhatsApp, fase 2). Lógica pura: el I/O entra por
// DepsToque3 (io.ts en producción).
// Plantilla de MARKETING (config toque3.plantilla = voltra_mk_seguimiento_oferta, supabase/plantillas/) a quien vino de
// un anuncio, no compró y dejó de responder. Sale entre desde_h (48 h) y hasta_h (70 h) después de la PRIMERA
// respuesta del bot (dentro de las 72 h gratis que abre el anuncio click-to-WhatsApp de Meta) y en horario
// [horario_desde, horario_hasta) = [12, 21) de Asunción; si en ese rango no hay ningún momento en horario, no sale.
// Una sola vez por conversación: perfil_vendedor.toque3_en y, por las dudas, las plantillas ya enviadas en wa_mensajes.
// Solo si: vino de un anuncio (origen_anuncio_id), está en 'ia', sin pedido en dias_pedido días, sin rechazo, sin
// baja ni "no" de marketing, sin fecha pedida (recontactar_el: eso lo maneja el recontacto por cobro), la última
// respuesta no fue una derivación ni un mensaje de Enrique, el bot habló último y el cliente no escribe hace
// ≥ sin_escribir_h (24 h): la ventana de 24 h ya cerró, así que los recontactos 1 y 2 ya salieron o se saltearon.
// 21-10: tampoco si el cliente escribió hace < min_desde_cliente_min o hay datos del pedido a medio armar (pin, resumen
// sin confirmar o datos tras pedírselos; con frenar_medio_armado), igual que los recontactos 1 y 2 (logica.ts).
// Opt-in: con toque3.requiere_consentimiento (default true) solo con consentimiento de marketing 'si'. Topes por
// cliente: los mismos de recompra (evaluarTope con config_wa.recompra.topes; cuentan voltra_mk_* y esta plantilla).
// Arranca APAGADO (toque3.activo: false): se prende cuando Meta aprueba la plantilla y se confirma la regla de opt-in.
// Si el envío falla: esa conversación no se reintenta en reintento_h (24 h; marca toque3_fallo_en). Si la falla es de
// la plantilla (no aprobada, pausada, parámetros: 132xxx) se corta la corrida y el toque 3 queda en pausa reintento_h
// (lo lee de los envíos fallidos en wa_mensajes). Un solo aviso a Telegram por corrida.
// Variables: {{1}} primer nombre (o nombre_si_falta: "Hola de nuevo, …"), {{2}} producto corto con artículo, {{3}}
// total de 2 unidades con envío (oferta ×2 de config_wa.vendedor_ofertas + config_wa.vendedor_envio, precio de
// Shopify). Solo sale si con 2 el envío queda gratis, como dice el texto.
// Botones (payload al mandar): "Quiero pedirlo" → vend_p1:pedir:<handle> (le llega al vendedor como [botón]);
// "No me escribas más" → mk_baja:0 (wa-webhook registra la baja igual que en las plantillas de recompra).
import { nombreDeHandle, productoPorPalabras } from "../_shared/anuncios.ts";
import { partesAsuncion } from "../_shared/horario.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { gs, precioPorCantidad } from "../_shared/vendedor/herramientas.ts";
import { normalizarPerfil } from "../_shared/vendedor/perfil.ts";
import { configDesdeValor, evaluarTope, type MensajeMk, type RecompraCfg } from "../recompra/calendario.ts";
import { type Candidato, type CfgSeguimiento, clienteEscribioHacePoco, type DepsSeguimiento } from "./logica.ts";

export type CfgToque3 = {
  /** Arranca apagado: se prende con la plantilla aprobada por Meta y la regla de opt-in confirmada. */
  activo: boolean;
  /** true: solo a clientes con consentimiento de marketing 'si' (wa_consentimientos). */
  requiere_consentimiento: boolean;
  /** Nombre de la plantilla en Meta. */
  plantilla: string;
  idioma: string;
  /** Rango desde la primera respuesta del bot [desde_h, hasta_h) (las 72 h gratis del anuncio). */
  desde_h: number;
  hasta_h: number;
  /** Horas sin mensaje del cliente. */
  sin_escribir_h: number;
  /** Horas sin reintentar tras una falla (por conversación) o sin mandar ninguno tras una falla de la plantilla. */
  reintento_h: number;
  /** Máximo de envíos por corrida del cron. */
  lote_max: number;
  /** {{1}} cuando no hay un nombre usable: "Hola de nuevo, …". */
  nombre_si_falta: string;
};

export const CFG_TOQUE3_DEFAULT: CfgToque3 = {
  activo: false,
  requiere_consentimiento: true,
  plantilla: "voltra_mk_seguimiento_oferta",
  idioma: "es",
  desde_h: 48,
  hasta_h: 70,
  sin_escribir_h: 24,
  reintento_h: 24,
  lote_max: 20,
  nombre_si_falta: "de nuevo",
};

const H = 3_600_000;
const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** config_wa.vendedor_seguimiento.toque3 → config válida (lo que falte o venga raro toma el default). */
export function leerCfgToque3(v: unknown): CfgToque3 {
  const c: CfgToque3 = { ...CFG_TOQUE3_DEFAULT };
  const t = esObj(v) && esObj(v.toque3) ? v.toque3 : null;
  if (!t) return c;
  if (typeof t.activo === "boolean") c.activo = t.activo;
  if (typeof t.requiere_consentimiento === "boolean") c.requiere_consentimiento = t.requiere_consentimiento;
  if (typeof t.plantilla === "string" && /^[a-z0-9_]{1,512}$/.test(t.plantilla)) c.plantilla = t.plantilla;
  if (typeof t.idioma === "string" && /^[a-z]{2}(?:_[A-Z]{2})?$/.test(t.idioma)) c.idioma = t.idioma;
  if (typeof t.nombre_si_falta === "string" && t.nombre_si_falta.trim() && t.nombre_si_falta.length <= 30) {
    c.nombre_si_falta = t.nombre_si_falta.trim();
  }
  for (const k of ["desde_h", "hasta_h", "sin_escribir_h", "reintento_h", "lote_max"] as const) {
    const x = t[k];
    if (typeof x === "number" && Number.isFinite(x) && x >= 0) c[k] = x;
  }
  // Las 72 h gratis del anuncio: nunca más allá (con margen para la demora del envío).
  c.hasta_h = Math.min(c.hasta_h, 71.5);
  c.desde_h = Math.min(c.desde_h, c.hasta_h);
  c.lote_max = Math.floor(c.lote_max);
  return c;
}

/** Mismo criterio que dentroHorario de logica.ts (hora entera de Asunción, [desde, hasta)). */
function enHorario(d: Date, cfg: Pick<CfgSeguimiento, "horario_desde" | "horario_hasta">): boolean {
  const { hora } = partesAsuncion(d);
  return hora >= cfg.horario_desde && hora < cfg.horario_hasta;
}

/** toque3_fallo_en crudo del perfil (marca de esta rutina; normalizarPerfil la descarta: dura hasta el próximo turno). */
export function toque3FalloEn(perfil: unknown): string | null {
  const v = esObj(perfil) ? perfil.toque3_fallo_en : null;
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

export type DecisionToque3 = { tipo: "toque3" } | { tipo: "nada"; motivo: string };

export function decidirToque3(c: Candidato, cfg: CfgSeguimiento, t3: CfgToque3, ahora: Date): DecisionToque3 {
  const nada = (motivo: string): DecisionToque3 => ({ tipo: "nada", motivo });
  if (c.estado !== "ia") return nada("no_esta_en_ia");
  if (!c.origen_anuncio_id) return nada("no_vino_de_anuncio");
  const perfil = normalizarPerfil(c.perfil);
  if (perfil.toque3_en || (c.plantillas_enviadas ?? []).includes(t3.plantilla)) return nada("ya_enviado");
  const fallo = toque3FalloEn(c.perfil);
  if (fallo && ahora.getTime() - Date.parse(fallo) < t3.reintento_h * H) return nada("fallo_reciente");
  if (perfil.rechazo) return nada("rechazo");
  if (c.baja_marketing || c.consentimiento_marketing === "baja") return nada("baja_marketing");
  if (c.consentimiento_marketing === "no") return nada("consentimiento_no");
  if (t3.requiere_consentimiento && c.consentimiento_marketing !== "si") return nada("sin_consentimiento");
  if (c.pedido_reciente) return nada("pedido_reciente");
  if (perfil.recontactar_el) return nada("espera_fecha_pedida");
  if (c.ultima_respuesta_derivada) return nada("derivado");
  if (!c.ultimo_mensaje || c.ultimo_mensaje.direccion !== "out") return nada("cliente_hablo_ultimo");
  if (c.ultimo_mensaje.manual) return nada("enrique_escribio");
  const entrada = c.ultima_entrada_en ? Date.parse(c.ultima_entrada_en) : NaN;
  if (!Number.isFinite(entrada)) return nada("sin_entrada_del_cliente");
  // 21-10 (regla de Enrique, la misma de los recontactos 1 y 2): nada si escribió hace poco o el pedido está a medio
  // armar. La de los minutos casi nunca corta acá (sin_escribir_h ya pide 24 h), queda por si se baja la config.
  if (clienteEscribioHacePoco(entrada, cfg, ahora)) return nada("cliente_escribio_hace_poco");
  // 21-10 (segunda vuelta): con el pedido a medio armar, el toque 3 sí sale y "al día siguiente": alcanza con que la
  // ventana de 24 h esté cerrada (abajo), sin esperar desde_h.
  const medioArmado = cfg.frenar_medio_armado && !!c.datos_pedido_parciales;
  // Nunca con la ventana de 24 h abierta: ahí todavía pueden salir los recontactos 1 y 2 (gratis, con la IA).
  if ((ahora.getTime() - entrada) / H < Math.max(t3.sin_escribir_h, cfg.ventana_max_h)) return nada("escribio_hace_poco");
  const primera = c.primera_respuesta_en ? Date.parse(c.primera_respuesta_en) : NaN;
  if (!Number.isFinite(primera)) return nada("sin_respuesta_del_bot");
  const h = (ahora.getTime() - primera) / H;
  if (h < t3.desde_h && !medioArmado) return nada("esperando");
  if (h >= t3.hasta_h) return nada("fuera_de_las_72h");
  if (!enHorario(ahora, cfg)) return nada("fuera_de_horario");
  return { tipo: "toque3" };
}

// ---------- variables de la plantilla ----------

/** Precios para {{3}}: Shopify (unidad) + config_wa.vendedor_ofertas + config_wa.vendedor_envio. */
export type PreciosToque3 = {
  /** Precio de 1 unidad por handle (variante disponible o la primera) y si se puede vender. */
  unidad: Record<string, { precio: number; disponible: boolean }>;
  /** { handle: { "2": total de 2 sin envío, "3": … } }. */
  ofertas: Record<string, Record<string, number>>;
  /** Costo del envío en Gs. */
  envio: number;
};

/** Cantidad que ofrece la plantilla ("Llevando 2 el envío te sale gratis"): está en el texto aprobado por Meta. */
export const CANTIDAD_OFERTA = 2;

/** Total de 2 unidades con envío, o el motivo por el que no se ofrece (el texto promete envío gratis). */
export function ofertaToque3(handle: string, p: PreciosToque3): { total: number } | { motivo: string } {
  const u = p.unidad[handle];
  if (!u || !(u.precio > 0)) return { motivo: "sin_precio" };
  if (!u.disponible) return { motivo: "sin_stock" };
  if (!(p.envio >= 0)) return { motivo: "sin_envio" };
  const total = precioPorCantidad(u.precio, CANTIDAD_OFERTA, p.ofertas[handle]) + p.envio;
  // "El envío te sale gratis": el total de 2 con envío no puede pasar de 2 unidades sueltas sin envío.
  if (total > CANTIDAD_OFERTA * u.precio) return { motivo: "sin_oferta_x2" };
  return { total };
}

/** Producto del chat (perfil.producto) y, si no, el del anuncio. null = no se sabe. */
export function handleToque3(c: Candidato): string | null {
  const perfil = normalizarPerfil(c.perfil);
  return (perfil.producto ? productoPorPalabras(perfil.producto) : null) ?? c.handle_anuncio ?? null;
}

const ARTICULO: Record<string, string> = { tiras: "las", parches: "los", raspador: "el", botella: "la", ejercitador: "el", pack: "el" };

/** "tiras-nasales-gudair-30-unidades" → "las tiras nasales" ("¿seguís con ganas de probar las tiras nasales?"). */
export function productoConArticulo(handle: string): string {
  const nombre = nombreDeHandle(handle);
  const art = ARTICULO[nombre.split(" ")[0]];
  return art ? `${art} ${nombre}` : nombre;
}

/** Primer nombre usable del perfil de WhatsApp ("~Ana 💕" → "Ana"); si no hay, `siFalta`. */
export function primerNombre(nombre: string | null | undefined, siFalta: string): string {
  const palabra = String(nombre ?? "").normalize("NFC").split(/\s+/)
    .map((w) => w.replace(/[^\p{L}'-]/gu, "").replace(/^['-]+|['-]+$/g, ""))
    .find((w) => (w.match(/\p{L}/gu) ?? []).length >= 2);
  if (!palabra || palabra.length > 20) return siFalta;
  return palabra[0].toUpperCase() + palabra.slice(1).toLowerCase();
}

/** Payload del botón "Quiero pedirlo" (mismo formato que los botones del primer turno y cierre_botones). */
export const payloadPedir = (handle: string) => `vend_p1:pedir:${handle}`;
/** Payload del botón "No me escribas más": el de la baja de recompra (wa-webhook → registrarBaja). 0 = sin pedido. */
export const PAYLOAD_BAJA = "mk_baja:0";

/** Componentes para la API de mensajes: {{1}} {{2}} {{3}} y el payload de cada botón. */
export function componentesToque3(v: { nombre: string; producto: string; total: number; handle: string }): unknown[] {
  return [
    { type: "body", parameters: [v.nombre, v.producto, gs(v.total)].map((text) => ({ type: "text", text })) },
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: payloadPedir(v.handle) }] },
    { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: PAYLOAD_BAJA }] },
  ];
}

// ---------- errores ----------

/** Código de Meta al principio del error de _shared/wa.ts ("132001: …"). */
export function codigoErrorMeta(error: string): number | null {
  const m = /^\s*(\d{3,})\b/.exec(error ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Falla de la PLANTILLA (no de ese cliente): no existe/no aprobada, pausada, deshabilitada o parámetros (132xxx,
 * 131008, 131009), o falta la config de WhatsApp. Con esto no tiene sentido seguir mandando: se pausa el toque 3.
 */
export function esFallaDePlantilla(error: string): boolean {
  const c = codigoErrorMeta(error);
  if (c != null) return (c >= 132000 && c < 133000) || c === 131008 || c === 131009;
  return /^(?:config_palabras_prohibidas_no_disponible|faltan_WA_TOKEN)/.test(error ?? "");
}

/** Meta: el cliente apagó "Ofertas y anuncios" (se registra la baja, como en procesar-envios). */
const CODIGO_BAJA_META = 131050;

// ---------- topes de marketing (los de recompra) ----------

export type HistorialMk = {
  /** Plantillas salientes no fallidas de los clientes (cualquier nombre; acá se filtran las de marketing). */
  mensajes: Array<{ cliente_id: string; creado_en: string; estado: string | null; plantilla: string | null }>;
  /** envios_programados de marketing pendientes. */
  enCola: Array<{ cliente_id: string; enviar_desde: string }>;
};

export const esPlantillaDeMarketing = (nombre: string | null, t3: CfgToque3) =>
  !!nombre && (nombre.startsWith("voltra_mk_") || nombre === t3.plantilla);

/**
 * Topes por cliente de recompra (evaluarTope: 1 por semana, 3 por mes, menos si no lee). Sin consentimiento
 * obligatorio, el cliente sin respuesta cuenta como 'si' solo para los topes ('no' y 'baja' ya quedaron afuera).
 */
export function topeToque3(c: Candidato, h: HistorialMk, t3: CfgToque3, ahora: Date, recompra: RecompraCfg): { ok: true } | { ok: false; motivo: string } {
  const entrada = c.ultima_entrada_en ? Date.parse(c.ultima_entrada_en) : NaN;
  const mensajes: MensajeMk[] = h.mensajes
    .filter((m) => m.cliente_id === c.cliente_id && esPlantillaDeMarketing(m.plantilla, t3))
    .map((m) => {
      const enviado_en = new Date(m.creado_en);
      return { enviado_en, leido: m.estado === "leido" || (Number.isFinite(entrada) && entrada > enviado_en.getTime()) };
    });
  const enCola = h.enCola.filter((x) => x.cliente_id === c.cliente_id).map((x) => new Date(x.enviar_desde));
  const cons = c.consentimiento_marketing === "si" || !t3.requiere_consentimiento ? "si" : c.consentimiento_marketing ?? null;
  const d = evaluarTope(cons, mensajes, enCola, partesAsuncion(ahora).diaISO, ahora, recompra);
  return d.ok ? { ok: true } : { ok: false, motivo: d.motivo };
}

// ---------- corrida ----------

export type ResultadoEnvioWa = { ok: boolean; wa_message_id?: string; error?: string };

export type DepsToque3 = {
  /** Conversaciones en 'ia' con origen_anuncio_id, creadas desde creadasDesdeISO y con la última entrada <= entradaHastaISO. */
  candidatosToque3(creadasDesdeISO: string, entradaHastaISO: string, cfg: CfgSeguimiento): Promise<Candidato[]>;
  /** Guarda (ISO) o borra (null) perfil_vendedor.toque3_en / toque3_fallo_en sin pisar el resto del perfil. */
  marcarToque3(conversacionId: string, marcas: { toque3_en: string | null; toque3_fallo_en: string | null }): Promise<void>;
  /** _shared/wa.ts enviarPlantilla: filtra, manda y registra en wa_mensajes (el costo lo completa wa-webhook). */
  enviarPlantilla(to: string, nombre: string, idioma: string, componentes: unknown[], op: { clienteId: string; conversacionId: string }): Promise<ResultadoEnvioWa>;
  preciosToque3(): Promise<PreciosToque3>;
  /** Historial de plantillas y cola de marketing de los clientes desde desdeISO (para los topes). */
  historialMarketing(clienteIds: string[], desdeISO: string): Promise<HistorialMk>;
  /** config_wa.recompra (crudo; null si no existe): de ahí salen los topes. Opcional: sin esto, los topes por defecto. */
  configRecompra?(): Promise<unknown>;
  /** Errores de los envíos fallidos de la plantilla desde desdeISO. Opcional: sin esto no hay pausa global. */
  fallasRecientesToque3?(plantilla: string, desdeISO: string): Promise<string[]>;
  /** Baja de marketing por el error 131050 (recompra/baja.ts, origen 'meta_131050'). Opcional. */
  registrarBaja?(clienteId: string): Promise<{ ok: boolean; error?: string }>;
};

export type ResumenToque3 = {
  accion: "inactivo" | "fuera_de_horario" | "pausado" | "corrido" | "error";
  candidatos?: number;
  elegibles?: number;
  enviados?: number;
  fallas?: number;
  motivos?: Record<string, number>;
  resultados?: Array<{ conversacion_id: string; ok: boolean; error?: string }>;
};

/** Días de historial de marketing que se miran para los topes. */
const DIAS_HISTORIAL = 90;

export async function correrToque3(deps: DepsSeguimiento, crudo: unknown, cfg: CfgSeguimiento): Promise<ResumenToque3> {
  const t3 = leerCfgToque3(crudo);
  const buscar = deps.candidatosToque3, marcar = deps.marcarToque3, enviar = deps.enviarPlantilla;
  const precios = deps.preciosToque3, historial = deps.historialMarketing;
  if (!cfg.activo || !t3.activo || t3.lote_max <= 0 || !buscar || !marcar || !enviar || !precios || !historial) {
    return { accion: "inactivo" };
  }
  const ahora = deps.ahora();
  if (!enHorario(ahora, cfg)) return { accion: "fuera_de_horario" };
  if (deps.fallasRecientesToque3) {
    const errores = await deps.fallasRecientesToque3(t3.plantilla, new Date(ahora.getTime() - t3.reintento_h * H).toISOString());
    if (errores.some(esFallaDePlantilla)) return { accion: "pausado" };
  }

  // La primera respuesta del bot sale, como mucho, 24 h después de la entrada por el anuncio (si no, no hay 72 h gratis).
  const creadasDesde = new Date(ahora.getTime() - (t3.hasta_h + 24) * H).toISOString();
  const entradaHasta = new Date(ahora.getTime() - t3.sin_escribir_h * H).toISOString();
  const candidatos = await buscar(creadasDesde, entradaHasta, cfg);

  const motivos: Record<string, number> = {};
  const sumar = (m: string) => void (motivos[m] = (motivos[m] ?? 0) + 1);
  const elegidos = candidatos.filter((c) => {
    const d = decidirToque3(c, cfg, t3, ahora);
    if (d.tipo === "nada") sumar(d.motivo);
    return d.tipo === "toque3";
  });
  const base = { candidatos: candidatos.length, elegibles: elegidos.length };
  if (!elegidos.length) return { accion: "corrido", ...base, enviados: 0, fallas: 0, motivos };

  const [p, h, recompra] = await Promise.all([
    precios(),
    historial([...new Set(elegidos.map((c) => c.cliente_id))], new Date(ahora.getTime() - DIAS_HISTORIAL * 24 * H).toISOString()),
    deps.configRecompra ? deps.configRecompra() : Promise.resolve(null),
  ]);
  const topes = configDesdeValor(recompra);
  const listos: Array<{ c: Candidato; to: string; componentes: unknown[] }> = [];
  for (const c of elegidos) {
    const handle = handleToque3(c);
    if (!handle) {
      sumar("sin_producto");
      continue;
    }
    const o = ofertaToque3(handle, p);
    if ("motivo" in o) {
      sumar(o.motivo);
      continue;
    }
    const tope = topeToque3(c, h, t3, ahora, topes);
    if (!tope.ok) {
      sumar(tope.motivo);
      continue;
    }
    const to = c.telefono ?? c.wa_user_id ?? null;
    if (!to) {
      sumar("sin_telefono");
      continue;
    }
    const nombre = primerNombre(c.nombre, t3.nombre_si_falta);
    listos.push({ c, to, componentes: componentesToque3({ nombre, producto: productoConArticulo(handle), total: o.total, handle }) });
  }
  const lote = listos.slice(0, t3.lote_max);
  if (listos.length > lote.length) motivos.lote_lleno = listos.length - lote.length;

  const fallas: string[] = [];
  const resultados: NonNullable<ResumenToque3["resultados"]> = [];
  let enviados = 0, pausa = false;
  for (const { c, to, componentes } of lote) {
    const id = c.conversacion_id;
    const enISO = deps.ahora().toISOString();
    try {
      // Se marca ANTES de mandar: si dos corridas se pisan, la segunda ya lo ve enviado (nunca sale dos veces).
      await marcar(id, { toque3_en: enISO, toque3_fallo_en: null });
    } catch (e) {
      fallas.push(`${id}: no se pudo marcar (${msg(e)})`);
      continue;
    }
    let r: ResultadoEnvioWa;
    try {
      r = await enviar(to, t3.plantilla, t3.idioma, componentes, { clienteId: c.cliente_id, conversacionId: id });
    } catch (e) {
      r = { ok: false, error: `excepcion: ${msg(e)}` };
    }
    const error = r.ok ? null : r.error ?? "error_desconocido";
    resultados.push({ conversacion_id: id, ok: r.ok, ...(error ? { error: error.slice(0, 200) } : {}) });
    if (!error) {
      enviados++;
      continue;
    }
    fallas.push(`${id}: ${error}`);
    // No se reintenta en reintento_h: se cambia la marca de envío por la de falla.
    await marcar(id, { toque3_en: null, toque3_fallo_en: enISO })
      .catch((e) => fallas.push(`${id}: no se pudo marcar la falla (${msg(e)})`));
    if (codigoErrorMeta(error) === CODIGO_BAJA_META && deps.registrarBaja) {
      const b = await deps.registrarBaja(c.cliente_id).catch((e) => ({ ok: false, error: msg(e) }));
      if (!b.ok) fallas.push(`${id}: no se pudo registrar la baja (131050): ${b.error ?? "?"}`);
    }
    // La plantilla no sale (no aprobada, pausada, parámetros): no se sigue con el resto.
    if (esFallaDePlantilla(error)) {
      pausa = true;
      motivos.pausado_por_plantilla = lote.length - resultados.length;
      break;
    }
  }

  if (fallas.length) {
    const lista = fallas.slice(0, 10).map((f) => `• ${escaparHtml(f)}`).join("\n");
    const extra = pausa ? `\nFalla de la plantilla ${escaparHtml(t3.plantilla)}: el toque 3 queda en pausa ${t3.reintento_h} h. Revisá en WhatsApp Manager que esté aprobada.` : "";
    await deps.avisar(
      `<b>Toque 3 (plantilla de oferta): ${fallas.length} con problemas</b>\n${lista}${fallas.length > 10 ? `\n… y ${fallas.length - 10} más` : ""}${extra}`,
    ).catch((e) => console.error("seguimiento-chat: no se pudo avisar (toque 3):", e));
  }

  return { accion: "corrido", ...base, enviados, fallas: fallas.length, motivos, resultados };
}
