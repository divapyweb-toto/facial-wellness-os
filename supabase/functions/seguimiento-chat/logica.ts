// seguimiento-chat · lógica pura (07-10-2026, decisión de Enrique).
// Hasta 2 recontactos automáticos a clientes que dejaron en visto, SIEMPRE dentro de la ventana de 24 h de
// WhatsApp (gratis: texto libre o interactivos, nunca plantillas). El mensaje lo escribe el vendedor con IA con
// un turno de seguimiento (orquestador.ts, entrada "[seguimiento N]" con origen "seguimiento").
//
// Cuándo toca (config_wa.vendedor_seguimiento, hora de Asunción):
//   · Recontacto 1: el bot habló último, hace ≥ horas_1 (2 h) que no responde y su última entrada fue hace
//     < ventana_1_h (23 h).
//   · Recontacto 2: ya se hizo el 1, el bot sigue hablando último, pasaron ≥ horas_2 (20 h) desde la última
//     entrada del cliente y < ventana_max_h (23,5 h), y ≥ separacion_min_h (2 h) desde el recontacto 1.
//   · Fuera de [horario_desde, horario_hasta) no se manda: se espera. Si la ventana se cierra antes, se pierde.
// Nunca si: la conversación no está en 'ia'; hay un pedido del cliente en los últimos 7 días (Shopify o chat);
// el cliente dijo que no (perfil_vendedor.rechazo); pidió la baja de ofertas; ya se hicieron `max` en el ciclo;
// la última respuesta del bot fue una derivación. El contador NO se reinicia cuando el cliente escribe: vuelve a
// cero solo si el último recontacto fue hace más de `dias_reinicio` (7) días.
// Sin I/O: todo entra por DepsSeguimiento (io.ts en producción).
import { partesAsuncion } from "../_shared/horario.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { type EntradaTurno, type ResultadoTurno, textoSeguimiento } from "../_shared/vendedor/orquestador.ts";
import { normalizarPerfil } from "../_shared/vendedor/perfil.ts";

export type CfgSeguimiento = {
  activo: boolean;
  /** Horas sin respuesta (desde el último mensaje del bot) para el recontacto 1. */
  horas_1: number;
  /** Horas desde la última entrada del cliente para el recontacto 2. */
  horas_2: number;
  /** Recontactos por ciclo. */
  max: number;
  /** Recontacto 1 solo si la última entrada fue hace menos de esto. */
  ventana_1_h: number;
  /** Ningún recontacto si la última entrada fue hace esto o más (la ventana de WhatsApp es de 24 h). */
  ventana_max_h: number;
  /** Hora de Asunción desde la que se manda (inclusive). */
  horario_desde: number;
  /** Hora de Asunción hasta la que se manda (exclusive). */
  horario_hasta: number;
  /** Máximo de recontactos por corrida del cron. */
  lote_max: number;
  /** Horas mínimas entre un recontacto y el siguiente. */
  separacion_min_h: number;
  /** Días tras el último recontacto en que el contador vuelve a cero. */
  dias_reinicio: number;
  /** Días hacia atrás en que un pedido del cliente bloquea el recontacto. */
  dias_pedido: number;
};

export const CFG_SEGUIMIENTO_DEFAULT: CfgSeguimiento = {
  activo: true,
  horas_1: 2,
  horas_2: 20,
  max: 2,
  ventana_1_h: 23,
  ventana_max_h: 23.5,
  horario_desde: 8,
  horario_hasta: 21,
  lote_max: 20,
  separacion_min_h: 2,
  dias_reinicio: 7,
  dias_pedido: 7,
};

const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** config_wa.vendedor_seguimiento → config válida (lo que falte o venga raro toma el default). */
export function leerCfgSeguimiento(v: unknown): CfgSeguimiento {
  const c: CfgSeguimiento = { ...CFG_SEGUIMIENTO_DEFAULT };
  if (!esObj(v)) return c;
  if (typeof v.activo === "boolean") c.activo = v.activo;
  for (const k of Object.keys(CFG_SEGUIMIENTO_DEFAULT) as (keyof CfgSeguimiento)[]) {
    if (k === "activo") continue;
    const x = v[k];
    if (typeof x === "number" && Number.isFinite(x) && x >= 0) (c[k] as number) = x;
  }
  // La ventana de WhatsApp es de 24 h: nunca más allá (con margen para la demora del envío).
  c.ventana_max_h = Math.min(c.ventana_max_h, 23.75);
  c.ventana_1_h = Math.min(c.ventana_1_h, c.ventana_max_h);
  c.max = Math.floor(c.max);
  c.lote_max = Math.floor(c.lote_max);
  return c;
}

export function dentroHorario(ahora: Date, cfg: CfgSeguimiento): boolean {
  const { hora } = partesAsuncion(ahora);
  return hora >= cfg.horario_desde && hora < cfg.horario_hasta;
}

/** Lo que hace falta saber de una conversación para decidir (lo arma io.ts). */
export type Candidato = {
  conversacion_id: string;
  cliente_id: string;
  estado: string;
  ultima_entrada_en: string | null;
  /** wa_conversaciones.perfil_vendedor (rechazo, seguimientos, ultimo_seguimiento_en). */
  perfil: unknown;
  /** Último mensaje no fallido de la conversación (entrante o saliente). */
  ultimo_mensaje: { direccion: "in" | "out"; creado_en: string } | null;
  /** La última respuesta del vendedor fue una derivación a Enrique. */
  ultima_respuesta_derivada: boolean;
  /** Hay un pedido del cliente en los últimos `dias_pedido` días (shopify_pedidos o wa_pedidos_chat creado). */
  pedido_reciente: boolean;
  /** El consentimiento de marketing vigente es 'baja'. */
  baja_marketing: boolean;
};

export type Decision =
  | { tipo: "seguimiento"; numero: number; previo: { seguimientos: number; ultimo_seguimiento_en: string | null } }
  | { tipo: "nada"; motivo: string };

const H = 3_600_000;

/** Recontactos ya hechos en el ciclo vigente (0 si el último fue hace más de `dias_reinicio` días). */
export function seguimientosVigentes(perfil: unknown, ahora: Date, cfg: CfgSeguimiento): number {
  const p = normalizarPerfil(perfil);
  const n = p.seguimientos ?? 0;
  if (!n) return 0;
  const en = p.ultimo_seguimiento_en ? Date.parse(p.ultimo_seguimiento_en) : NaN;
  if (Number.isFinite(en) && ahora.getTime() - en > cfg.dias_reinicio * 24 * H) return 0;
  return n;
}

export function decidirSeguimiento(c: Candidato, cfg: CfgSeguimiento, ahora: Date): Decision {
  const nada = (motivo: string): Decision => ({ tipo: "nada", motivo });
  if (c.estado !== "ia") return nada("no_esta_en_ia");
  const entrada = c.ultima_entrada_en ? Date.parse(c.ultima_entrada_en) : NaN;
  if (!Number.isFinite(entrada)) return nada("sin_entrada_del_cliente");
  const hEntrada = (ahora.getTime() - entrada) / H;
  if (hEntrada >= cfg.ventana_max_h) return nada("ventana_cerrada");
  const perfil = normalizarPerfil(c.perfil);
  if (perfil.rechazo) return nada("rechazo");
  if (c.baja_marketing) return nada("baja_marketing");
  if (c.pedido_reciente) return nada("pedido_reciente");
  if (!c.ultimo_mensaje || c.ultimo_mensaje.direccion !== "out") return nada("cliente_hablo_ultimo");
  if (c.ultima_respuesta_derivada) return nada("derivado");
  const n = seguimientosVigentes(c.perfil, ahora, cfg);
  if (n >= cfg.max) return nada("tope_seguimientos");
  if (!dentroHorario(ahora, cfg)) return nada("fuera_de_horario");
  const hBot = (ahora.getTime() - Date.parse(c.ultimo_mensaje.creado_en)) / H;
  if (!(hBot >= cfg.horas_1)) return nada("esperando");
  const previo = { seguimientos: perfil.seguimientos ?? 0, ultimo_seguimiento_en: perfil.ultimo_seguimiento_en ?? null };
  if (n === 0) {
    if (hEntrada >= cfg.ventana_1_h) return nada("ventana_1_cerrada");
    return { tipo: "seguimiento", numero: 1, previo };
  }
  if (hEntrada < cfg.horas_2) return nada("esperando");
  const ultimoSeg = perfil.ultimo_seguimiento_en ? Date.parse(perfil.ultimo_seguimiento_en) : NaN;
  if (Number.isFinite(ultimoSeg) && (ahora.getTime() - ultimoSeg) / H < cfg.separacion_min_h) return nada("separacion");
  return { tipo: "seguimiento", numero: n + 1, previo };
}

// ---------- corrida ----------

export type DepsSeguimiento = {
  /** config_wa.vendedor_seguimiento (crudo; null si no existe). */
  config(): Promise<unknown>;
  /** true si el gasto de IA del mes ya llegó a config_wa.vendedor.tope_mensual_usd. */
  topeGastoSuperado(ahora: Date): Promise<boolean>;
  /** Conversaciones en 'ia' con la última entrada en [desdeISO, hastaISO], las más viejas primero. */
  candidatos(desdeISO: string, hastaISO: string, cfg: CfgSeguimiento): Promise<Candidato[]>;
  /** Guarda el contador y la fecha en perfil_vendedor (merge atómico, no pisa el resto del perfil). */
  marcar(conversacionId: string, seguimientos: number, enISO: string | null): Promise<void>;
  /** Turno de seguimiento del vendedor (procesarTurno con origen "seguimiento"). */
  turno(entrada: EntradaTurno): Promise<ResultadoTurno>;
  avisar(textoHtml: string): Promise<unknown>;
  ahora(): Date;
  /** Turnos en paralelo (default 4). */
  paralelo?: number;
};

export type ResumenSeguimiento = {
  accion: "inactivo" | "fuera_de_horario" | "tope_gasto" | "corrido";
  candidatos?: number;
  elegibles?: number;
  enviados?: number;
  omitidos?: number;
  fallas?: number;
  motivos?: Record<string, number>;
  resultados?: Array<{ conversacion_id: string; numero: number; accion: string; motivo?: string }>;
};

/** Resultado del turno que cuenta como falla (se avisa a Enrique, una vez por corrida). */
export function esFalla(r: ResultadoTurno): boolean {
  return r.accion === "error_envio" || (r.accion === "omitido" && (r.motivo ?? "").startsWith("sin_derivar:"));
}

async function enLotes<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  const cola = [...items];
  const trabajadores = Array.from({ length: Math.max(1, Math.min(n, cola.length)) }, async () => {
    while (cola.length) await f(cola.shift()!);
  });
  await Promise.all(trabajadores);
}

export async function correrSeguimientos(deps: DepsSeguimiento): Promise<ResumenSeguimiento> {
  const ahora = deps.ahora();
  const cfg = leerCfgSeguimiento(await deps.config());
  if (!cfg.activo || cfg.max <= 0 || cfg.lote_max <= 0) return { accion: "inactivo" };
  if (!dentroHorario(ahora, cfg)) return { accion: "fuera_de_horario" };
  if (await deps.topeGastoSuperado(ahora)) return { accion: "tope_gasto" };

  const desde = new Date(ahora.getTime() - cfg.ventana_max_h * H).toISOString();
  const hasta = new Date(ahora.getTime() - Math.min(cfg.horas_1, cfg.horas_2) * H).toISOString();
  const candidatos = await deps.candidatos(desde, hasta, cfg);

  const motivos: Record<string, number> = {};
  const elegidos: Array<{ c: Candidato; d: Extract<Decision, { tipo: "seguimiento" }> }> = [];
  for (const c of candidatos) {
    const d = decidirSeguimiento(c, cfg, ahora);
    if (d.tipo === "nada") motivos[d.motivo] = (motivos[d.motivo] ?? 0) + 1;
    else elegidos.push({ c, d });
  }
  const lote = elegidos.slice(0, cfg.lote_max);
  if (elegidos.length > lote.length) motivos.lote_lleno = elegidos.length - lote.length;

  const resultados: NonNullable<ResumenSeguimiento["resultados"]> = [];
  const fallas: string[] = [];
  let enviados = 0, omitidos = 0;
  await enLotes(lote, deps.paralelo ?? 4, async ({ c, d }) => {
    const id = c.conversacion_id;
    const enISO = deps.ahora().toISOString();
    try {
      // Se marca ANTES del turno: si dos corridas se pisan, la segunda ya ve el recontacto hecho.
      await deps.marcar(id, d.numero, enISO);
    } catch (e) {
      fallas.push(`${id}: no se pudo marcar (${e instanceof Error ? e.message : e})`);
      return;
    }
    let r: ResultadoTurno;
    try {
      r = await deps.turno({
        conversacion_id: id,
        wa_message_id: `seguimiento:${d.numero}:${id}:${enISO}`,
        texto: textoSeguimiento(d.numero),
        origen: "seguimiento",
      });
    } catch (e) {
      r = { accion: "error_envio", motivo: e instanceof Error ? e.message : String(e) };
    }
    resultados.push({ conversacion_id: id, numero: d.numero, accion: r.accion, ...(r.motivo ? { motivo: r.motivo } : {}) });
    if (r.accion === "respondido" || r.accion === "terminal" || r.accion === "derivado") enviados++;
    else omitidos++;
    if (esFalla(r)) fallas.push(`${id}: seguimiento ${d.numero} → ${r.accion}${r.motivo ? ` (${r.motivo})` : ""}`);
    // No salió nada y no se gastó: se devuelve el contador a como estaba (se puede intentar en la próxima corrida).
    if (r.accion === "omitido" && !esFalla(r) && !(Number(r.costo_usd) > 0)) {
      await deps.marcar(id, d.previo.seguimientos, d.previo.ultimo_seguimiento_en)
        .catch((e) => fallas.push(`${id}: no se pudo devolver el contador (${e instanceof Error ? e.message : e})`));
    }
  });

  if (fallas.length) {
    const lista = fallas.slice(0, 10).map((f) => `• ${escaparHtml(f)}`).join("\n");
    await deps.avisar(
      `<b>Recontactos automáticos: ${fallas.length} con problemas</b>\n${lista}${fallas.length > 10 ? `\n… y ${fallas.length - 10} más` : ""}`,
    ).catch((e) => console.error("seguimiento-chat: no se pudo avisar:", e));
  }

  return {
    accion: "corrido",
    candidatos: candidatos.length,
    elegibles: elegidos.length,
    enviados,
    omitidos,
    fallas: fallas.length,
    motivos,
    resultados,
  };
}
