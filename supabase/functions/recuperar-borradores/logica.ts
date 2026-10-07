// recuperar-borradores · lógica pura. Todo el I/O entra por `DepsRecuperar`.
//
// Un borrador de Releasit (tag abandoned_checkout_releasit_cod_form, es_borrador=true en shopify_pedidos) es un
// formulario que el cliente NO envió. Se le manda UN mensaje, una sola vez, y solo si:
//   - la bandera config_wa['ola4.recuperacion'].activo está en true;
//   - el borrador tiene entre min_horas y max_horas (default 1 a 24 h) y no está completado;
//   - hay teléfono y NO existe un pedido real posterior del mismo teléfono;
//   - hay EVIDENCIA DE CONSENTIMIENTO (ver `evidenciaConsentimiento`): si no se puede saber, no se manda nada;
//   - estamos dentro del horario configurado (se reintenta en la próxima corrida del cron);
//   - el borrador no fue procesado antes (tabla recuperacion_borradores, el claim va ANTES del envío).

export const TAG_BORRADOR_RELEASIT = "abandoned_checkout_releasit_cod_form";

export interface ConfigRecuperacion {
  activo: boolean;
  plantilla: string;
  min_horas: number;
  max_horas: number;
  limite: number;
  /** Nombres de los note_attributes del borrador que prueban la aceptación de WhatsApp. Vacía = solo consentimiento previo. */
  claves_consentimiento: string[];
  horario: { desde: number; hasta: number };
}

export const CONFIG_RECUPERACION_DEFECTO: ConfigRecuperacion = {
  activo: false,
  plantilla: "voltra_recuperar_borrador",
  min_horas: 1,
  max_horas: 24,
  limite: 30,
  claves_consentimiento: [],
  horario: { desde: 8, hasta: 21 },
};

export function configRecuperacion(valor: unknown): ConfigRecuperacion {
  const v = valor && typeof valor === "object" ? valor as Partial<ConfigRecuperacion> : {};
  return {
    ...CONFIG_RECUPERACION_DEFECTO,
    ...v,
    activo: v.activo === true, // solo `true` explícito enciende
    claves_consentimiento: Array.isArray(v.claves_consentimiento) ? v.claves_consentimiento.map(String) : [],
    horario: { ...CONFIG_RECUPERACION_DEFECTO.horario, ...(v.horario ?? {}) },
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
  | "pedido_posterior"
  | "baja"
  | "sin_consentimiento"
  | "contactado_reciente";

/** Fecha de creación del borrador: la de Shopify si viene en el raw; si no, la de la fila. */
export function fechaBorrador(b: Borrador): Date {
  const c = obj(b.raw).created_at ?? obj(b.raw).createdAt;
  const d = new Date(typeof c === "string" ? c : b.creado_en);
  return Number.isNaN(d.getTime()) ? new Date(b.creado_en) : d;
}

export function edadHoras(b: Borrador, ahora: Date): number {
  return (ahora.getTime() - fechaBorrador(b).getTime()) / 3_600_000;
}

export interface ContextoDecision {
  ahora: Date;
  cfg: ConfigRecuperacion;
  consentimiento: ConsentimientoCliente;
  hayPedidoPosterior: boolean;
  contactadoReciente: boolean;
}

export function decidir(b: Borrador, c: ContextoDecision): { enviar: true; evidencia: string } | { enviar: false; motivo: MotivoOmision } {
  if (!b.telefono) return { enviar: false, motivo: "sin_telefono" };
  const r = obj(b.raw);
  if (str(r.completed_at) || String(r.status ?? "").toLowerCase() === "completed" || String(r.status ?? "").toUpperCase() === "COMPLETED") {
    return { enviar: false, motivo: "completado" };
  }
  const edad = edadHoras(b, c.ahora);
  if (edad < c.cfg.min_horas) return { enviar: false, motivo: "muy_reciente" };
  if (edad > c.cfg.max_horas) return { enviar: false, motivo: "muy_viejo" };
  if (c.hayPedidoPosterior) return { enviar: false, motivo: "pedido_posterior" };
  if (c.consentimiento.marketing === "baja" || c.consentimiento.utilidad === "baja") return { enviar: false, motivo: "baja" };
  const delBorrador = evidenciaConsentimiento(b.raw, c.cfg.claves_consentimiento);
  const previo = c.consentimiento.utilidad === "si" || c.consentimiento.marketing === "si";
  if (!delBorrador && !previo) return { enviar: false, motivo: "sin_consentimiento" };
  if (c.contactadoReciente) return { enviar: false, motivo: "contactado_reciente" };
  return { enviar: true, evidencia: delBorrador ? `borrador:${delBorrador}` : "consentimiento_previo" };
}

function nombreDe(raw: unknown): string | null {
  const r = obj(raw);
  const ship = obj(r.shipping_address ?? r.shippingAddress);
  const cust = obj(r.customer);
  const unir = (a: unknown, b: unknown) => [str(a), str(b)].filter(Boolean).join(" ").trim();
  return str(ship.name) ?? (unir(ship.first_name ?? ship.firstName, ship.last_name ?? ship.lastName) ||
    unir(cust.first_name ?? cust.firstName, cust.last_name ?? cust.lastName) || null);
}

function productosDe(raw: unknown): string | null {
  const r = obj(raw);
  const lineas = Array.isArray(r.line_items) ? r.line_items : Array.isArray(obj(r.lineItems).nodes) ? obj(r.lineItems).nodes as unknown[] : [];
  const t = lineas.map((l) => {
    const o = obj(l);
    const titulo = str(o.title) ?? str(o.name);
    const cant = Number(o.quantity ?? 1);
    return titulo ? (cant > 1 ? `${cant} ${titulo}` : titulo) : null;
  }).filter(Boolean) as string[];
  return t.length ? t.join(", ") : null;
}

const limpio = (v: string | null, def: string) => (v ?? "").replace(/[\n\r\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 120) || def;

/** Componentes de voltra_recuperar_borrador: {{1}} nombre, {{2}} producto. Sin botones. */
export function componentesMensaje(b: Borrador): unknown[] {
  const primerNombre = (nombreDe(b.raw) ?? "").split(/\s+/)[0] || null;
  return [{
    type: "body",
    parameters: [
      { type: "text", text: limpio(primerNombre, "qué tal") },
      { type: "text", text: limpio(productosDe(b.raw), "tu pedido") },
    ],
  }];
}

// ─── Orquestación ────────────────────────────────────────────

export interface DepsRecuperar {
  ahora(): Date;
  config(): Promise<ConfigRecuperacion>;
  /** Borradores de Releasit sin fila en recuperacion_borradores, candidatos por fecha. */
  borradores(limite: number): Promise<Borrador[]>;
  consentimiento(clienteId: string | null): Promise<ConsentimientoCliente>;
  hayPedidoPosterior(telefono: string, desde: Date): Promise<boolean>;
  /** ¿Ya se le recuperó otro borrador a este cliente en las últimas 24 h? */
  contactadoReciente(clienteId: string | null, telefono: string, desde: Date): Promise<boolean>;
  /** insert ... on conflict do nothing → true solo para quien crea la fila (idempotencia). */
  reclamar(b: Borrador): Promise<boolean>;
  enviar(telefono: string, plantilla: string, componentes: unknown[], b: Borrador): Promise<{ ok: boolean; wa_message_id?: string; error?: string }>;
  cerrar(b: Borrador, estado: "enviado" | "fallido", extra: { wa_message_id?: string; error?: string }): Promise<void>;
}

export interface ResultadoRecuperar {
  accion: "bandera_apagada" | "fuera_de_horario" | "ok";
  revisados: number;
  enviados: number;
  fallidos: number;
  omitidos: Partial<Record<MotivoOmision | "ya_reclamado", number>>;
}

export async function recuperarBorradores(deps: DepsRecuperar): Promise<ResultadoRecuperar> {
  const vacio = (accion: ResultadoRecuperar["accion"]): ResultadoRecuperar => ({ accion, revisados: 0, enviados: 0, fallidos: 0, omitidos: {} });
  const cfg = await deps.config();
  if (!cfg.activo) return vacio("bandera_apagada");
  const ahora = deps.ahora();
  const hora = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Asuncion", hour: "2-digit", hourCycle: "h23" }).format(ahora));
  if (hora < cfg.horario.desde || hora >= cfg.horario.hasta) return vacio("fuera_de_horario");

  const res = vacio("ok");
  const omitir = (m: keyof ResultadoRecuperar["omitidos"]) => { res.omitidos[m] = (res.omitidos[m] ?? 0) + 1; };
  const borradores = await deps.borradores(Math.max(cfg.limite * 4, 50));
  for (const b of borradores) {
    if (res.enviados + res.fallidos >= cfg.limite) break;
    res.revisados++;
    // Descartes baratos antes de consultar nada más.
    const edad = edadHoras(b, ahora);
    if (!b.telefono || edad < cfg.min_horas || edad > cfg.max_horas) {
      omitir(!b.telefono ? "sin_telefono" : edad < cfg.min_horas ? "muy_reciente" : "muy_viejo");
      continue;
    }
    const d = decidir(b, {
      ahora,
      cfg,
      consentimiento: await deps.consentimiento(b.cliente_id),
      hayPedidoPosterior: await deps.hayPedidoPosterior(b.telefono, fechaBorrador(b)),
      contactadoReciente: await deps.contactadoReciente(b.cliente_id, b.telefono, new Date(ahora.getTime() - 24 * 3_600_000)),
    });
    if (!d.enviar) { omitir(d.motivo); continue; }
    if (!(await deps.reclamar(b))) { omitir("ya_reclamado"); continue; }
    const r = await deps.enviar(b.telefono, cfg.plantilla, componentesMensaje(b), b);
    if (r.ok) {
      res.enviados++;
      await deps.cerrar(b, "enviado", { wa_message_id: r.wa_message_id });
    } else {
      res.fallidos++;
      await deps.cerrar(b, "fallido", { error: r.error }); // no se reintenta: un solo intento por borrador
    }
  }
  return res;
}
