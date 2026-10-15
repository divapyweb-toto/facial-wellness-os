// recuperar-borradores · lógica pura. Todo el I/O entra por `DepsRecuperar`.
//
// Un borrador de Releasit (tag abandoned_checkout_releasit_cod_form, es_borrador=true en shopify_pedidos) es un
// formulario que el cliente NO envió. 14-10 (Enrique): se le manda UN mensaje (plantilla voltra_mk_recuperar_pedido, con
// el producto, el precio y el botón "Quiero terminar mi pedido"), una sola vez, y solo si:
//   - la bandera config_wa['ola4.recuperacion'].activo está en true y estamos dentro del horario;
//   - pasaron entre min_minutos y max_minutos (15 a 60) desde que lo ABANDONÓ (Releasit crea el borrador
//     `demora_releasit_min` minutos después del abandono);
//   - hay teléfono y ese teléfono NO tiene un pedido real (desde `dias_pedido` días antes del borrador) ni un chat
//     abierto (humano, o con mensajes del cliente en las últimas 24 h), ni pidió la baja;
//   - no se le mandó otra recuperación en los últimos `dias_entre_envios` días;
//   - se reconoce el producto y tiene precio y stock (si no, el mensaje diría algo falso);
//   - no se llegó al tope diario (`limite` envíos por día, hora de Paraguay);
//   - la calidad del número en Meta es GREEN, leída ANTES DE CADA ENVÍO. Si no es GREEN no sale nada y se avisa a
//     Enrique por Telegram (como mucho una vez cada `alerta_cada_h` horas).
// El consentimiento previo solo se exige si `requiere_consentimiento` es true (14-10: Enrique decidió mandar sin
// casilla; Meta trata esto como marketing y un formulario no es opt-in: el freno de calidad y el tope son la defensa).
// Cuando el cliente toca el botón, le llega al vendedor como "[botón] Quiero terminar mi pedido (vend_p1:pedir:<handle>)",
// igual que el "Quiero pedirlo" del toque 3: el vendedor (v33) no cambia.

import { gs } from "../_shared/vendedor/herramientas.ts";

export const TAG_BORRADOR_RELEASIT = "abandoned_checkout_releasit_cod_form";
export const BOTON_RECUPERAR = "Quiero terminar mi pedido";

export interface ConfigRecuperacion {
  activo: boolean;
  plantilla: string;
  /** Categoría con la que Meta APROBÓ la plantilla. Define qué consentimiento previo vale (si se exige). */
  categoria: "MARKETING" | "UTILITY";
  requiere_consentimiento: boolean;
  /** Minutos que tarda Releasit en crear el borrador después del abandono. */
  demora_releasit_min: number;
  min_minutos: number;
  max_minutos: number;
  /** Tope de envíos por día (hora de Paraguay), contando los fallidos. */
  limite: number;
  /** Pedido real del mismo teléfono desde estos días antes del borrador → no se manda. */
  dias_pedido: number;
  /** Otra recuperación al mismo teléfono en estos días → no se manda. */
  dias_entre_envios: number;
  alerta_cada_h: number;
  /** Nombres de los note_attributes del borrador que prueban la aceptación de WhatsApp. */
  claves_consentimiento: string[];
  horario: { desde: number; hasta: number };
}

export const CONFIG_RECUPERACION_DEFECTO: ConfigRecuperacion = {
  activo: false,
  plantilla: "voltra_mk_recuperar_pedido",
  categoria: "MARKETING",
  requiere_consentimiento: true, // lo estricto si falta la config; la base lo pone en false (decisión de Enrique)
  demora_releasit_min: 15,
  min_minutos: 15,
  max_minutos: 60,
  limite: 30,
  dias_pedido: 7,
  dias_entre_envios: 7,
  alerta_cada_h: 6,
  claves_consentimiento: [],
  horario: { desde: 8, hasta: 21 },
};

const num = (x: unknown, def: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : def);

export function configRecuperacion(valor: unknown): ConfigRecuperacion {
  const v = valor && typeof valor === "object" ? valor as Partial<ConfigRecuperacion> : {};
  const d = CONFIG_RECUPERACION_DEFECTO;
  return {
    ...d,
    ...v,
    activo: v.activo === true, // solo `true` explícito enciende
    categoria: v.categoria === "UTILITY" ? "UTILITY" : "MARKETING",
    requiere_consentimiento: v.requiere_consentimiento !== false, // solo `false` explícito lo saca
    demora_releasit_min: num(v.demora_releasit_min, d.demora_releasit_min),
    min_minutos: num(v.min_minutos, d.min_minutos),
    max_minutos: num(v.max_minutos, d.max_minutos),
    limite: num(v.limite, d.limite),
    dias_pedido: num(v.dias_pedido, d.dias_pedido),
    dias_entre_envios: num(v.dias_entre_envios, d.dias_entre_envios),
    alerta_cada_h: num(v.alerta_cada_h, d.alerta_cada_h),
    claves_consentimiento: Array.isArray(v.claves_consentimiento) ? v.claves_consentimiento.map(String) : [],
    horario: { ...d.horario, ...(v.horario ?? {}) },
  };
}

export interface Borrador {
  shopify_order_id: number;
  nombre: string | null;
  cliente_id: string | null;
  telefono: string | null;
  tags: string[];
  raw: unknown;
  creado_en: string;
}

export type EstadoConsentimiento = "si" | "no" | "baja" | null;
export interface ConsentimientoCliente {
  utilidad: EstadoConsentimiento;
  marketing: EstadoConsentimiento;
}

/** Precios que ve el vendedor: unidad por handle, ofertas por cantidad (sin envío) y envío. */
export interface PreciosRecuperar {
  unidad: Record<string, { precio: number; disponible: boolean }>;
  ofertas: Record<string, Record<string, number>>;
  envio: number;
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {});
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Atributos del borrador (REST: note_attributes [{name,value}] · GraphQL: customAttributes [{key,value}]). */
export function atributos(raw: unknown): Array<{ k: string; v: string }> {
  const r = obj(raw);
  const a = Array.isArray(r.note_attributes) ? r.note_attributes : Array.isArray(r.customAttributes) ? r.customAttributes : [];
  return a.map((x) => ({ k: String(obj(x).name ?? obj(x).key ?? ""), v: String(obj(x).value ?? "") }));
}

/**
 * Evidencia en el propio borrador: un atributo cuyo nombre está en `claves` y cuyo valor es afirmativo
 * (no vacío ni "no/false/0"). Devuelve el nombre del atributo o null. Sin claves configuradas → null.
 */
export function evidenciaConsentimiento(raw: unknown, claves: string[]): string | null {
  const set = new Set(claves.map(normalizar).filter(Boolean));
  if (!set.size) return null;
  for (const a of atributos(raw)) {
    if (!set.has(normalizar(a.k))) continue;
    const v = normalizar(a.v);
    if (v && !/^(no|false|0|off|n)$/.test(v)) return a.k;
  }
  return null;
}

export type MotivoOmision =
  | "sin_telefono"
  | "completado"
  | "muy_reciente"
  | "muy_viejo"
  | "pedido_previo"
  | "chat_abierto"
  | "baja"
  | "sin_consentimiento"
  | "contactado_reciente"
  | "sin_producto"
  | "sin_precio";

/** Fecha de creación del borrador: la de Shopify si viene en el raw; si no, la de la fila. */
export function fechaBorrador(b: Borrador): Date {
  const c = obj(b.raw).created_at ?? obj(b.raw).createdAt;
  const d = new Date(typeof c === "string" ? c : b.creado_en);
  return Number.isNaN(d.getTime()) ? new Date(b.creado_en) : d;
}

/** Minutos desde el ABANDONO (creación del borrador + la demora de Releasit). */
export function minutosAbandonado(b: Borrador, ahora: Date, cfg: ConfigRecuperacion): number {
  return (ahora.getTime() - fechaBorrador(b).getTime()) / 60_000 + cfg.demora_releasit_min;
}

// ─── Producto y texto ────────────────────────────────────────

/** Mismas palabras clave que los anuncios (_shared/anuncios.ts → productoPorPalabras). */
export type ProductoPorPalabras = (texto: string) => string | null;

export function lineasDe(raw: unknown): Array<{ titulo: string; cantidad: number }> {
  const r = obj(raw);
  const lineas = Array.isArray(r.line_items) ? r.line_items : Array.isArray(obj(r.lineItems).nodes) ? obj(r.lineItems).nodes as unknown[] : [];
  return lineas.map((l) => {
    const o = obj(l);
    const titulo = [str(o.title) ?? str(o.name), str(o.variant_title)].filter(Boolean).join(" ");
    return { titulo, cantidad: Number(o.quantity ?? 1) || 1 };
  }).filter((l) => l.titulo);
}

/** Handle del primer producto reconocible del borrador (null = no se reconoce ninguno). */
export function handleDeBorrador(raw: unknown, porPalabras: ProductoPorPalabras): string | null {
  for (const l of lineasDe(raw)) {
    const h = porPalabras(l.titulo);
    if (h) return h;
  }
  return null;
}

/**
 * "79.000 + envío / 2 por 158.000 con envío gratis" (texto de Enrique, 14-10). El ×2 solo si de verdad sale con
 * envío gratis (total de 2 con envío ≤ 2 unidades sueltas); si no, solo "<precio> + envío".
 */
export function frasePrecioRecuperar(handle: string, p: PreciosRecuperar): string | null {
  const u = p.unidad[handle];
  if (!u || !(u.precio > 0) || !u.disponible) return null;
  const base = `${gs(u.precio)} + envío`;
  const o2 = p.ofertas[handle]?.["2"];
  if (typeof o2 !== "number" || !(o2 > 0) || !(p.envio >= 0)) return base;
  const total2 = o2 + p.envio;
  return total2 <= 2 * u.precio ? `${base} / 2 por ${gs(total2)} con envío gratis` : base;
}

function nombreDe(raw: unknown): string | null {
  const r = obj(raw);
  const ship = obj(r.shipping_address ?? r.shippingAddress);
  const bill = obj(r.billing_address ?? r.billingAddress);
  const cust = obj(r.customer);
  const unir = (a: unknown, b: unknown) => [str(a), str(b)].filter(Boolean).join(" ").trim();
  return str(ship.name) ?? (unir(ship.first_name ?? ship.firstName, ship.last_name ?? ship.lastName) ||
    str(bill.name) || unir(cust.first_name ?? cust.firstName, cust.last_name ?? cust.lastName) || null);
}

/** Primer nombre usable ("ana maría" → "Ana"); si no hay, `siFalta`. */
export function primerNombre(nombre: string | null | undefined, siFalta: string): string {
  const palabra = String(nombre ?? "").normalize("NFC").split(/\s+/)
    .map((w) => w.replace(/[^\p{L}'-]/gu, "").replace(/^['-]+|['-]+$/g, ""))
    .find((w) => (w.match(/\p{L}/gu) ?? []).length >= 2);
  if (!palabra || palabra.length > 20) return siFalta;
  return palabra[0].toUpperCase() + palabra.slice(1).toLowerCase();
}

export interface Mensaje {
  componentes: unknown[];
  /** Texto legible que se guarda en wa_mensajes: es lo que el vendedor ve en el historial. */
  texto: string;
}

/** Cuerpo aprobado de voltra_mk_recuperar_pedido (supabase/plantillas/voltra_mk_recuperar_pedido.json). */
export const cuerpoPlantilla = (nombre: string, producto: string, precio: string) =>
  `Hola ${nombre} 👋 Quedó sin terminar tu pedido de ${producto}.\nSale ${precio}, y pagás recién al recibir.\n` +
  "Si todavía lo querés, tocá el botón y lo terminamos acá en un minuto.";

/** {{1}} primer nombre · {{2}} producto sin artículo · {{3}} precio; botón → vend_p1:pedir:<handle>. */
export function armarMensaje(b: Borrador, handle: string, producto: string, precio: string, plantilla: string): Mensaje {
  const nombre = primerNombre(nombreDe(b.raw), "qué tal");
  return {
    componentes: [
      { type: "body", parameters: [nombre, producto, precio].map((text) => ({ type: "text", text })) },
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `vend_p1:pedir:${handle}` }] },
    ],
    texto: `[plantilla ${plantilla}] ${cuerpoPlantilla(nombre, producto, precio)}\n[${BOTON_RECUPERAR}]`,
  };
}

// ─── Decisión por borrador ───────────────────────────────────

export interface ContextoDecision {
  ahora: Date;
  cfg: ConfigRecuperacion;
  consentimiento: ConsentimientoCliente;
  pedidoPrevio: boolean;
  chatAbierto: boolean;
  contactadoReciente: boolean;
}

export function decidir(b: Borrador, c: ContextoDecision): { enviar: true; evidencia: string } | { enviar: false; motivo: MotivoOmision } {
  if (!b.telefono) return { enviar: false, motivo: "sin_telefono" };
  const r = obj(b.raw);
  if (str(r.completed_at) || String(r.status ?? "").toLowerCase() === "completed") return { enviar: false, motivo: "completado" };
  const min = minutosAbandonado(b, c.ahora, c.cfg);
  if (min < c.cfg.min_minutos) return { enviar: false, motivo: "muy_reciente" };
  if (min > c.cfg.max_minutos) return { enviar: false, motivo: "muy_viejo" };
  if (c.pedidoPrevio) return { enviar: false, motivo: "pedido_previo" };
  if (c.consentimiento.marketing === "baja" || c.consentimiento.utilidad === "baja") return { enviar: false, motivo: "baja" };
  let evidencia = "sin_requisito";
  if (c.cfg.requiere_consentimiento) {
    const delBorrador = evidenciaConsentimiento(b.raw, c.cfg.claves_consentimiento);
    const previo = c.cfg.categoria === "MARKETING"
      ? c.consentimiento.marketing === "si"
      : c.consentimiento.utilidad === "si" || c.consentimiento.marketing === "si";
    if (!delBorrador && !previo) return { enviar: false, motivo: "sin_consentimiento" };
    evidencia = delBorrador ? `borrador:${delBorrador}` : "consentimiento_previo";
  }
  if (c.chatAbierto) return { enviar: false, motivo: "chat_abierto" };
  if (c.contactadoReciente) return { enviar: false, motivo: "contactado_reciente" };
  return { enviar: true, evidencia };
}

// ─── Orquestación ────────────────────────────────────────────

export interface ResultadoEnvio {
  ok: boolean;
  wa_message_id?: string;
  error?: string;
}

export interface DepsRecuperar {
  ahora(): Date;
  config(): Promise<ConfigRecuperacion>;
  /** Borradores de Releasit sin fila en recuperacion_borradores, de las últimas horas, más viejos primero. */
  borradores(limite: number): Promise<Borrador[]>;
  /** Recuperaciones intentadas (cualquier estado) desde `desde`: para el tope diario. */
  intentadosDesde(desde: Date): Promise<number>;
  consentimiento(clienteId: string | null): Promise<ConsentimientoCliente>;
  /** ¿Pedido real (no borrador) de ese teléfono creado desde `desde`? */
  pedidoDesde(telefono: string, desde: Date): Promise<boolean>;
  /** ¿Conversación en 'humano', o abierta con mensajes del cliente desde `desde`? */
  chatAbierto(clienteId: string | null, desde: Date): Promise<boolean>;
  /** ¿Otra recuperación a este teléfono/cliente desde `desde`? */
  contactadoReciente(clienteId: string | null, telefono: string, desde: Date): Promise<boolean>;
  precios(): Promise<PreciosRecuperar>;
  productoPorPalabras: ProductoPorPalabras;
  /** "raspador de lengua" (sin artículo: el texto dice "tu pedido de {{2}}"). */
  nombreProducto(handle: string): string;
  /** quality_rating del número en Meta ("GREEN", "YELLOW", "RED", "UNKNOWN"); null si no se pudo leer. */
  calidadNumero(): Promise<string | null>;
  /** Telegram a Enrique (se encarga de no repetir más de una vez cada `cada_h`). */
  alertarCalidad(calidad: string | null, cada_h: number): Promise<void>;
  /** insert ... on conflict do nothing → true solo para quien crea la fila (idempotencia). */
  reclamar(b: Borrador): Promise<boolean>;
  /** Cliente + conversación abierta donde queda la plantilla (para que el vendedor la vea cuando el cliente responda). */
  prepararConversacion(b: Borrador): Promise<{ clienteId: string | null; conversacionId: string | null }>;
  enviar(telefono: string, plantilla: string, m: Mensaje, destino: { clienteId: string | null; conversacionId: string | null }): Promise<ResultadoEnvio>;
  cerrar(b: Borrador, estado: "enviado" | "fallido", extra: { wa_message_id?: string; error?: string; conversacion_id?: string | null }): Promise<void>;
}

export interface ResultadoRecuperar {
  accion: "bandera_apagada" | "fuera_de_horario" | "tope_diario" | "calidad_no_verde" | "ok";
  revisados: number;
  enviados: number;
  fallidos: number;
  calidad?: string | null;
  omitidos: Partial<Record<MotivoOmision | "ya_reclamado", number>>;
}

/** Medianoche de hoy en Paraguay (UTC−3, sin horario de verano desde 2024). */
export function inicioDiaPY(ahora: Date): Date {
  const py = new Date(ahora.getTime() - 3 * 3_600_000);
  return new Date(Date.UTC(py.getUTCFullYear(), py.getUTCMonth(), py.getUTCDate()) + 3 * 3_600_000);
}

export async function recuperarBorradores(deps: DepsRecuperar): Promise<ResultadoRecuperar> {
  const res: ResultadoRecuperar = { accion: "ok", revisados: 0, enviados: 0, fallidos: 0, omitidos: {} };
  const cfg = await deps.config();
  if (!cfg.activo) return { ...res, accion: "bandera_apagada" };
  const ahora = deps.ahora();
  const hora = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Asuncion", hour: "2-digit", hourCycle: "h23" }).format(ahora));
  if (hora < cfg.horario.desde || hora >= cfg.horario.hasta) return { ...res, accion: "fuera_de_horario" };

  let intentadosHoy = await deps.intentadosDesde(inicioDiaPY(ahora));
  if (intentadosHoy >= cfg.limite) return { ...res, accion: "tope_diario" };

  const omitir = (m: keyof ResultadoRecuperar["omitidos"]) => { res.omitidos[m] = (res.omitidos[m] ?? 0) + 1; };
  const borradores = await deps.borradores(Math.max(cfg.limite * 4, 50));
  let precios: PreciosRecuperar | null = null;
  for (const b of borradores) {
    if (intentadosHoy >= cfg.limite) { res.accion = "tope_diario"; break; }
    res.revisados++;
    // Descartes baratos antes de consultar nada más. Los muy recientes vuelven en la próxima corrida.
    const min = minutosAbandonado(b, ahora, cfg);
    if (!b.telefono || min < cfg.min_minutos || min > cfg.max_minutos) {
      omitir(!b.telefono ? "sin_telefono" : min < cfg.min_minutos ? "muy_reciente" : "muy_viejo");
      continue;
    }
    const d = decidir(b, {
      ahora,
      cfg,
      consentimiento: await deps.consentimiento(b.cliente_id),
      pedidoPrevio: await deps.pedidoDesde(b.telefono, new Date(fechaBorrador(b).getTime() - cfg.dias_pedido * 86_400_000)),
      chatAbierto: await deps.chatAbierto(b.cliente_id, new Date(ahora.getTime() - 24 * 3_600_000)),
      contactadoReciente: await deps.contactadoReciente(b.cliente_id, b.telefono, new Date(ahora.getTime() - cfg.dias_entre_envios * 86_400_000)),
    });
    if (!d.enviar) { omitir(d.motivo); continue; }

    const handle = handleDeBorrador(b.raw, deps.productoPorPalabras);
    if (!handle) { omitir("sin_producto"); continue; }
    precios ??= await deps.precios();
    const precio = frasePrecioRecuperar(handle, precios);
    if (!precio) { omitir("sin_precio"); continue; }

    // Freno: la calidad se lee antes de CADA envío. Si no es GREEN, no sale nada más en esta corrida.
    const calidad = await deps.calidadNumero();
    if (calidad !== "GREEN") {
      await deps.alertarCalidad(calidad, cfg.alerta_cada_h);
      return { ...res, accion: "calidad_no_verde", calidad };
    }
    if (!(await deps.reclamar(b))) { omitir("ya_reclamado"); continue; }
    intentadosHoy++;
    const destino = await deps.prepararConversacion(b);
    const m = armarMensaje(b, handle, deps.nombreProducto(handle), precio, cfg.plantilla);
    const r = await deps.enviar(b.telefono, cfg.plantilla, m, destino);
    if (r.ok) {
      res.enviados++;
      await deps.cerrar(b, "enviado", { wa_message_id: r.wa_message_id, conversacion_id: destino.conversacionId });
    } else {
      res.fallidos++;
      await deps.cerrar(b, "fallido", { error: r.error, conversacion_id: destino.conversacionId }); // un solo intento por borrador
    }
  }
  return res;
}
