// seguimiento-chat · derivaciones con plazo (19-10-2026, paquete 1 del vendedor v35, ítem 5). Lógica pura: el I/O
// entra por DepsDerivaciones (io.ts en producción).
// Dato real (informe 02 §3c): de 7 derivaciones a Enrique desde el 13-10, 2 quedaron sin respuesta 35 y 46 h y una de
// salud se respondió a las 20,8 h. Hoy sale un solo Telegram al derivar y nadie se lo recuerda.
//
// A quién mira: conversaciones en 'humano' cuyo último turno del vendedor (sin contar agrupados ni omitidos) fue una
// derivación (vendedor_turnos.derivado = true, herramienta derivar_a_enrique o derivar_a_enrique(sistema)) de hace
// menos de max_dias. Una toma manual desde la Bandeja no tiene turno de derivación: no entra.
// "Atendido" = Enrique escribió desde la Bandeja (wa_mensajes saliente con contenido.origen 'manual') o tocó "Le
// escribo yo" (eventos_crudos accion:escribo) después de la derivación, o hay marca atendido_en (hook de Telegram).
// Si contesta desde su WhatsApp personal no queda registrado: el recordatorio le dice cómo frenarlo (Devolver a IA).
//
// Qué hace, una vez cada cosa (marca perfil_vendedor.derivacion_plazo, ligada al id del turno de la derivación: una
// derivación nueva arranca de cero):
//   1. Recordatorio por Telegram a las recordatorio_1_h (2) y recordatorio_2_h (8) h si sigue sin atender, con el
//      resumen en 3 líneas (quiere / datos / falta, del resumen que guardó la derivación) y el link wa.me. Solo de
//      aviso_desde a aviso_hasta (7 a 23); si se juntan los dos (derivó de noche), sale uno solo.
//   2. A las plazo_habil_h (4) horas hábiles (habil_desde-habil_hasta, 8 a 21 de Asunción, todos los días) sin
//      atender:
//        · motivos de venta (otro, sin_avance, falla_herramienta, direccion_dudosa, tope_*, …): el chat vuelve a
//          'ia' y el vendedor retoma con un turno "[retomar] …" (origen seguimiento: nunca deriva). Si el turno no
//          sale (tope de gasto, IA caída), vuelve a 'humano' y va el mensaje fijo.
//        · salud, reclamo, devolución, enojo: mensaje fijo al cliente ("Enrique te escribe hoy antes de las X") y
//          alerta a Enrique.
//        · si la ventana de 24 h ya cerró: solo alerta a Enrique (fuera de la ventana la API no deja texto libre).
//   3. Nunca 24 h sin un mensaje al cliente: si después de su último mensaje no le salió nada (fuera del botón de la
//      derivación), a las ventana_fija_h (22) h le sale el mensaje fijo. Si las 22 h caen fuera del horario hábil, se
//      adelanta al último momento hábil que deja margen_h (0,5 h), nunca antes de ventana_fija_min_h (8) h. Siempre
//      < ventana_max_h (23,5 h) desde su último mensaje.
// Se apaga con config_wa.vendedor_seguimiento.derivaciones.activo = false (retomar_activo = false apaga solo el 2
// de venta: va el mensaje fijo en su lugar).
import { partesAsuncion } from "../_shared/horario.ts";
import { type BotonTelegram, enlaceWaMe, escaparAtributo, escaparHtml, recortar } from "../_shared/telegram_formato.ts";
import type { EntradaTurno, ResultadoTurno } from "../_shared/vendedor/orquestador.ts";
import { normalizarPerfil } from "../_shared/vendedor/perfil.ts";
import { instanteLocal } from "../recompra/calendario.ts";
import { type CfgSeguimiento, CFG_SEGUIMIENTO_DEFAULT, franjasHorario, momentoRecontacto2 } from "./logica.ts";

const H = 3_600_000;
const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- config ----------

export type CfgDerivaciones = {
  activo: boolean;
  /** false: los motivos de venta no los retoma el bot; les va el mensaje fijo. */
  retomar_activo: boolean;
  recordatorio_1_h: number;
  recordatorio_2_h: number;
  /** Horas hábiles sin atender para el plazo (retomar o mensaje fijo). */
  plazo_habil_h: number;
  /** Horario hábil de Asunción [desde, hasta). */
  habil_desde: number;
  habil_hasta: number;
  /** Los recordatorios por Telegram salen solo en [aviso_desde, aviso_hasta) de Asunción. */
  aviso_desde: number;
  aviso_hasta: number;
  /** Mensaje fijo a las N h del último mensaje del cliente si no le salió nada. */
  ventana_fija_h: number;
  /** Nunca antes de esto (horas desde el último mensaje del cliente) al adelantarlo. */
  ventana_fija_min_h: number;
  /** Nada de texto libre a partir de esto (la ventana de WhatsApp es de 24 h). */
  ventana_max_h: number;
  /** Margen antes de que cierre la franja o la ventana (el cron corre cada 10 min). */
  margen_h: number;
  /** "Enrique te escribe antes de las X": X = ahora + promesa_h (redondeado a la hora), dentro del horario hábil. */
  promesa_h: number;
  /** Derivaciones más viejas que esto no se miran. */
  max_dias: number;
  /** Máximo de conversaciones con acción por corrida. */
  lote_max: number;
  /** Textos al cliente. {nombre} (", Ana" o vacío) y {cuando} ("hoy antes de las 15:00"). */
  texto_plazo: string;
  texto_ventana: string;
};

export const CFG_DERIVACIONES_DEFAULT: CfgDerivaciones = {
  activo: true,
  retomar_activo: true,
  recordatorio_1_h: 2,
  recordatorio_2_h: 8,
  plazo_habil_h: 4,
  habil_desde: 8,
  habil_hasta: 21,
  aviso_desde: 7,
  aviso_hasta: 23,
  ventana_fija_h: 22,
  ventana_fija_min_h: 8,
  ventana_max_h: 23.5,
  margen_h: 0.5,
  promesa_h: 3,
  max_dias: 3,
  lote_max: 20,
  texto_plazo: "Hola{nombre}, perdón la demora. Enrique ya tiene tu consulta y te escribe {cuando}.",
  texto_ventana: "Hola{nombre}, seguimos con tu consulta: Enrique te escribe {cuando}. Cualquier cosa, escribime por acá.",
};

/** config_wa.vendedor_seguimiento.derivaciones → config válida (lo que falte o venga raro toma el default). */
export function leerCfgDerivaciones(v: unknown): CfgDerivaciones {
  const c: CfgDerivaciones = { ...CFG_DERIVACIONES_DEFAULT };
  const d = esObj(v) && esObj(v.derivaciones) ? v.derivaciones : null;
  if (!d) return c;
  for (const k of Object.keys(CFG_DERIVACIONES_DEFAULT) as (keyof CfgDerivaciones)[]) {
    const x = d[k];
    const def = CFG_DERIVACIONES_DEFAULT[k];
    if (typeof def === "boolean" && typeof x === "boolean") (c[k] as boolean) = x;
    else if (typeof def === "number" && typeof x === "number" && Number.isFinite(x) && x >= 0) (c[k] as number) = x;
    else if (typeof def === "string" && typeof x === "string" && x.trim()) (c[k] as string) = x;
  }
  // La ventana de WhatsApp es de 24 h: nunca más allá (con margen para la demora del envío).
  c.ventana_max_h = Math.min(c.ventana_max_h, 23.75);
  c.ventana_fija_h = Math.min(c.ventana_fija_h, c.ventana_max_h);
  c.lote_max = Math.floor(c.lote_max);
  return c;
}

// ---------- candidato y marca ----------

/** Lo que guarda la derivación (vendedor_turnos, último turno de la conversación). */
export type DatosDerivacion = {
  /** vendedor_turnos.id del turno que derivó: la marca de idempotencia va ligada a este id. */
  turno_id: string;
  /** vendedor_turnos.creado_en. */
  en: string;
  motivo: string;
  /** input.resumen de derivar_a_enrique. */
  resumen: string | null;
  /** Opcionales (hook en derivar_a_enrique): resumen en 3 partes. Si no vienen, se arman con resumen + perfil. */
  quiere?: string | null;
  datos?: string | null;
  falta?: string | null;
};

export type CandidatoDerivacion = {
  conversacion_id: string;
  cliente_id: string;
  estado: string;
  nombre: string | null;
  telefono: string | null;
  wa_user_id: string | null;
  perfil: unknown;
  /** Último mensaje del cliente (wa_conversaciones.ultima_entrada_en). */
  ultima_entrada_en: string | null;
  derivacion: DatosDerivacion;
  /** Enrique escribió desde la Bandeja (origen 'manual') después de la derivación. */
  manual_despues: boolean;
  /** Enrique tocó "Le escribo yo" en Telegram por un pedido de este cliente después de la derivación. */
  escribo_despues: boolean;
  /** Último saliente no fallido POSTERIOR a la derivación (cualquier origen), o null. */
  ultima_salida_tras_derivacion: string | null;
};

/** perfil_vendedor.derivacion_plazo. */
export type MarcaDerivacion = {
  turno_id: string;
  aviso_1_en?: string;
  aviso_2_en?: string;
  /** Cuándo se cumplió el plazo de 4 h hábiles (se haya retomado, mandado el fijo o avisado). */
  plazo_en?: string;
  plazo_accion?: string;
  /** ultima_entrada_en del cliente para la que ya salió el mensaje fijo de las 22 h. */
  ventana_entrada?: string;
  /** Hook de Telegram ("Ya lo atendí"): con esto no se recuerda ni se retoma más. */
  atendido_en?: string;
};

/** La marca vigente para esta derivación (si es de otra derivación, arranca de cero). */
export function leerMarca(perfil: unknown, turnoId: string): MarcaDerivacion {
  const m = esObj(perfil) && esObj(perfil.derivacion_plazo) ? perfil.derivacion_plazo : null;
  if (!m || m.turno_id !== turnoId) return { turno_id: turnoId };
  const out: MarcaDerivacion = { turno_id: turnoId };
  for (const k of ["aviso_1_en", "aviso_2_en", "plazo_en", "plazo_accion", "ventana_entrada", "atendido_en"] as const) {
    if (typeof m[k] === "string" && m[k]) out[k] = m[k] as string;
  }
  return out;
}

/** Motivos que el bot NO retoma: mensaje fijo y alerta. */
export const MOTIVOS_FIJO: ReadonlySet<string> = new Set(["salud", "reclamo", "devolucion", "enojo"]);

const MOTIVO_LEGIBLE: Record<string, string> = {
  salud: "consulta de salud",
  reclamo: "reclamo",
  devolucion: "pide devolución",
  enojo: "cliente enojado",
  pide_persona: "pide hablar con una persona",
  mayorista: "compra mayorista",
  direccion_dudosa: "dirección dudosa",
  audio_confuso: "audio que no se entiende",
  sin_avance: "sin avance",
  falla_herramienta: "falló una herramienta",
  otro: "otro",
  falla_ia: "la IA no respondió",
  tope_gasto: "tope de gasto de IA",
  tope_turnos: "tope de turnos de IA",
  filtro: "filtro de la respuesta",
};
export const motivoLegible = (m: string) => MOTIVO_LEGIBLE[m] ?? m;

// ---------- horario ----------

const franjaCfg = (cfg: CfgDerivaciones): Pick<CfgSeguimiento, "horario_desde" | "horario_hasta"> => ({
  horario_desde: cfg.habil_desde,
  horario_hasta: cfg.habil_hasta,
});

/** Horas hábiles (Asunción, [habil_desde, habil_hasta) todos los días) entre t0 y t1 (ms). */
export function horasHabiles(t0: number, t1: number, cfg: CfgDerivaciones): number {
  return franjasHorario(t0, t1, franjaCfg(cfg)).reduce((s, [a, b]) => s + (b - a), 0) / H;
}

export function enHorarioHabil(ahora: Date, cfg: CfgDerivaciones): boolean {
  const { hora } = partesAsuncion(ahora);
  return hora >= cfg.habil_desde && hora < cfg.habil_hasta;
}

function enHorarioAviso(ahora: Date, cfg: CfgDerivaciones): boolean {
  const { hora } = partesAsuncion(ahora);
  return hora >= cfg.aviso_desde && hora < cfg.aviso_hasta;
}

/**
 * Instante (ms) del mensaje fijo de las 22 h: el mismo criterio que el recontacto 2 (momentoRecontacto2) con la franja
 * hábil. Si no hay ningún momento hábil válido, a las ventana_fija_h justas (la ventana manda sobre el horario).
 */
export function momentoVentana(entradaMs: number, cfg: CfgDerivaciones): number {
  const c: CfgSeguimiento = {
    ...CFG_SEGUIMIENTO_DEFAULT,
    horas_2: cfg.ventana_fija_h,
    horas_2_min: Math.min(cfg.ventana_fija_min_h, cfg.ventana_fija_h),
    ventana_max_h: cfg.ventana_max_h,
    margen_2_h: cfg.margen_h,
    horario_desde: cfg.habil_desde,
    horario_hasta: cfg.habil_hasta,
    separacion_min_h: 0,
  };
  return momentoRecontacto2(entradaMs, null, c) ?? entradaMs + cfg.ventana_fija_h * H;
}

/**
 * "hoy antes de las 15:00" / "mañana antes de las 11:00": ahora + promesa_h redondeado a la hora siguiente, dentro
 * del horario hábil. Si hoy queda menos de 1 h hábil (o ya pasó), mañana a las habil_desde + promesa_h.
 */
export function cuandoEscribe(ahora: Date, cfg: CfgDerivaciones): string {
  const p = partesAsuncion(ahora);
  const fin = instanteLocal(p.diaISO, cfg.habil_hasta).getTime();
  const inicio = instanteLocal(p.diaISO, cfg.habil_desde).getTime();
  const t = Math.max(ahora.getTime(), inicio);
  const hora2 = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:00`;
  if (fin - t >= H) {
    // Asunción es UTC−3 (horas enteras): redondear en UTC a la hora siguiente da la hora en punto local.
    const objetivo = Math.min(Math.ceil((t + cfg.promesa_h * H) / H) * H, fin);
    return `hoy antes de las ${hora2(partesAsuncion(new Date(objetivo)).hora)}`;
  }
  return `mañana antes de las ${hora2(Math.min(cfg.habil_desde + cfg.promesa_h, cfg.habil_hasta))}`;
}

export function textoCliente(plantilla: string, nombre: string | null, cuando: string): string {
  const n = (nombre ?? "").trim().split(/\s+/)[0] ?? "";
  return plantilla.replaceAll("{nombre}", n ? ` ${n}` : "").replaceAll("{cuando}", cuando).replace(/\s+([,.])/g, "$1").trim();
}

// ---------- decisión ----------

export type AccionDerivacion =
  | { tipo: "recordatorio"; nivel: 1 | 2 }
  | { tipo: "retomar" }
  | { tipo: "fijo_plazo" }
  | { tipo: "plazo_ventana_cerrada" }
  | { tipo: "fijo_ventana" };

export type DecisionDerivacion = { acciones: AccionDerivacion[]; motivo?: string };

export function decidirDerivacion(c: CandidatoDerivacion, cfg: CfgDerivaciones, ahora: Date): DecisionDerivacion {
  const nada = (motivo: string): DecisionDerivacion => ({ acciones: [], motivo });
  if (c.estado !== "humano") return nada("no_esta_en_humano");
  const deriv = Date.parse(c.derivacion.en);
  if (!Number.isFinite(deriv)) return nada("sin_fecha_derivacion");
  const t = ahora.getTime();
  const hDeriv = (t - deriv) / H;
  if (hDeriv > cfg.max_dias * 24) return nada("derivacion_vieja");
  const marca = leerMarca(c.perfil, c.derivacion.turno_id);
  const atendido = c.manual_despues || c.escribo_despues || !!marca.atendido_en;
  const entrada = c.ultima_entrada_en ? Date.parse(c.ultima_entrada_en) : NaN;
  const ventanaAbierta = Number.isFinite(entrada) && (t - entrada) / H < cfg.ventana_max_h;
  const acciones: AccionDerivacion[] = [];

  if (!atendido) {
    // 1. Recordatorios (uno por corrida; si se juntan los dos, el de 8 h marca ambos).
    if (enHorarioAviso(ahora, cfg)) {
      if (hDeriv >= cfg.recordatorio_2_h && !marca.aviso_2_en) acciones.push({ tipo: "recordatorio", nivel: 2 });
      else if (hDeriv >= cfg.recordatorio_1_h && hDeriv < cfg.recordatorio_2_h && !marca.aviso_1_en) acciones.push({ tipo: "recordatorio", nivel: 1 });
    }
    // 2. Plazo de horas hábiles (solo en horario hábil: ahí se cumple y se puede prometer "hoy").
    if (!marca.plazo_en && enHorarioHabil(ahora, cfg) && horasHabiles(deriv, t, cfg) >= cfg.plazo_habil_h) {
      if (!ventanaAbierta) acciones.push({ tipo: "plazo_ventana_cerrada" });
      else if (MOTIVOS_FIJO.has(c.derivacion.motivo) || !cfg.retomar_activo) acciones.push({ tipo: "fijo_plazo" });
      else acciones.push({ tipo: "retomar" });
    }
  }

  // 3. Nunca 24 h sin mensaje: nada salió después de su último mensaje (sin contar el botón de la derivación).
  const mandaAlCliente = acciones.some((a) => a.tipo === "retomar" || a.tipo === "fijo_plazo");
  if (!mandaAlCliente && ventanaAbierta && c.ultima_entrada_en && marca.ventana_entrada !== c.ultima_entrada_en) {
    const salida = c.ultima_salida_tras_derivacion ? Date.parse(c.ultima_salida_tras_derivacion) : NaN;
    const sinRespuesta = !Number.isFinite(salida) || salida < entrada;
    if (sinRespuesta && t >= momentoVentana(entrada, cfg)) acciones.push({ tipo: "fijo_ventana" });
  }
  return acciones.length ? { acciones } : nada(atendido ? "atendido" : "esperando");
}

// ---------- textos de Telegram ----------

/** Las 3 líneas: qué quiere, qué datos dio, qué falta (de la derivación; si no vinieron, resumen + perfil). */
export function resumen3(c: CandidatoDerivacion): string[] {
  const d = c.derivacion;
  const p = normalizarPerfil(c.perfil);
  const corto = (s: string | null | undefined, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const quiere = corto(d.quiere) || corto(d.resumen) || motivoLegible(d.motivo);
  const datosPerfil = [p.producto, p.cantidad ? `x${p.cantidad}` : null, p.nota].filter(Boolean).join(" · ");
  const datos = corto(d.datos) || corto(datosPerfil) || "ninguno registrado";
  const falta = corto(d.falta) || "tu respuesta";
  return [`Quiere: ${escaparHtml(quiere)}`, `Datos: ${escaparHtml(datos)}`, `Falta: ${escaparHtml(falta)}`];
}

function quien(c: CandidatoDerivacion): string {
  return c.nombre?.trim() || c.telefono || "Un cliente";
}

function lineaContacto(c: CandidatoDerivacion): string {
  const enlace = enlaceWaMe(c.telefono);
  return enlace
    ? `Teléfono: ${escaparHtml(c.telefono)} · <a href="${escaparAtributo(enlace)}">escribirle</a>`
    : "Sin teléfono: respondele desde la bandeja de Voltra OS.";
}

export function botonesContacto(c: CandidatoDerivacion): BotonTelegram[][] | undefined {
  const url = enlaceWaMe(c.telefono);
  return url ? [[{ texto: `Escribirle a ${quien(c).slice(0, 30)}`, url }]] : undefined;
}

const horasTexto = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.floor(h)} h`);

export function textoRecordatorio(c: CandidatoDerivacion, cfg: CfgDerivaciones, ahora: Date): string {
  const h = (ahora.getTime() - Date.parse(c.derivacion.en)) / H;
  const venta = !MOTIVOS_FIJO.has(c.derivacion.motivo) && cfg.retomar_activo;
  const sigue = venta
    ? `Si en ${cfg.plazo_habil_h} h hábiles nadie le responde, el bot retoma el chat.`
    : `Si en ${cfg.plazo_habil_h} h hábiles nadie le responde, le aviso que le escribís hoy.`;
  return [
    `⏰ <b>${escaparHtml(quien(c))}</b> espera tu respuesta hace ${horasTexto(h)} (derivado: ${escaparHtml(motivoLegible(c.derivacion.motivo))}).`,
    ...resumen3(c),
    lineaContacto(c),
    sigue,
    "Si ya lo atendiste por tu WhatsApp, tocá «Devolver a IA» en la Bandeja y no te aviso más.",
  ].join("\n");
}

// ---------- corrida ----------

export type DepsDerivaciones = {
  /** Conversaciones en 'humano' con una derivación (último turno del vendedor) desde desdeISO. */
  candidatosDerivacion(desdeISO: string): Promise<CandidatoDerivacion[]>;
  /** Escribe perfil_vendedor.derivacion_plazo (reemplaza esa clave, no pisa el resto del perfil). */
  marcarDerivacion(conversacionId: string, marca: MarcaDerivacion): Promise<void>;
  /** 'ia' (asignado_a null) o 'humano' (asignado_a 'enrique'). */
  cambiarEstado(conversacionId: string, estado: "ia" | "humano"): Promise<void>;
  /** Texto libre al cliente (registra en wa_mensajes; sin origen manual). */
  enviarTextoCliente(to: string, texto: string, op: { clienteId: string; conversacionId: string }): Promise<{ ok: boolean; error?: string }>;
};

type DepsCorrida = DepsDerivaciones & {
  turno(entrada: EntradaTurno): Promise<ResultadoTurno>;
  avisar(textoHtml: string, botones?: BotonTelegram[][]): Promise<unknown>;
  ahora(): Date;
};

/** Texto exacto de la entrada del turno de retomar (contrato con el prompt del vendedor). */
export const TEXTO_RETOMAR =
  "[retomar] Enrique no pudo responder todavía: retomá vos con honestidad, sin prometer lo que no podés hacer";

export type ResumenDerivaciones = {
  accion: "inactivo" | "corrido" | "error";
  candidatos?: number;
  recordatorios?: number;
  retomados?: number;
  fijos?: number;
  ventana_cerrada?: number;
  fallas?: number;
  motivos?: Record<string, number>;
};

const salio = (r: ResultadoTurno) => r.accion === "respondido" || r.accion === "terminal";

export async function correrDerivaciones(deps: DepsCorrida, crudo: unknown): Promise<ResumenDerivaciones> {
  const cfg = leerCfgDerivaciones(crudo);
  if (!cfg.activo || cfg.lote_max <= 0) return { accion: "inactivo" };
  const ahora = deps.ahora();
  const desde = new Date(ahora.getTime() - cfg.max_dias * 24 * H).toISOString();
  const candidatos = await deps.candidatosDerivacion(desde);

  const motivos: Record<string, number> = {};
  const elegidos: Array<{ c: CandidatoDerivacion; d: DecisionDerivacion }> = [];
  for (const c of candidatos) {
    const d = decidirDerivacion(c, cfg, ahora);
    if (!d.acciones.length) motivos[d.motivo ?? "nada"] = (motivos[d.motivo ?? "nada"] ?? 0) + 1;
    else elegidos.push({ c, d });
  }
  const lote = elegidos.slice(0, cfg.lote_max);
  if (elegidos.length > lote.length) motivos.lote_lleno = elegidos.length - lote.length;

  const fallas: string[] = [];
  const r: ResumenDerivaciones = { accion: "corrido", candidatos: candidatos.length, recordatorios: 0, retomados: 0, fijos: 0, ventana_cerrada: 0 };
  const avisar = async (texto: string, botones?: BotonTelegram[][]): Promise<boolean> => {
    try {
      const x = await deps.avisar(recortar(texto), botones) as { ok?: boolean } | undefined;
      return x?.ok !== false;
    } catch (e) {
      console.error("seguimiento-chat: Telegram falló en derivaciones:", msg(e));
      return false;
    }
  };

  // En serie: son pocas y cada una puede cambiar el estado de la conversación.
  for (const { c, d } of lote) {
    const id = c.conversacion_id;
    let marca = leerMarca(c.perfil, c.derivacion.turno_id);
    const guardar = async (m: MarcaDerivacion): Promise<boolean> => {
      try {
        await deps.marcarDerivacion(id, m);
        marca = m;
        return true;
      } catch (e) {
        fallas.push(`${id}: no se pudo marcar (${msg(e)})`);
        return false;
      }
    };
    const to = c.telefono ?? c.wa_user_id ?? null;
    const enISO = ahora.toISOString();
    const nombreHtml = `<b>${escaparHtml(quien(c))}</b>`;
    const mandarFijo = async (plantilla: string): Promise<{ ok: boolean; cuando: string; error?: string }> => {
      const cuando = cuandoEscribe(ahora, cfg);
      if (!to) return { ok: false, cuando, error: "sin_destino" };
      try {
        const x = await deps.enviarTextoCliente(to, textoCliente(plantilla, c.nombre, cuando), { clienteId: c.cliente_id, conversacionId: id });
        return { ok: x.ok, cuando, ...(x.ok ? {} : { error: x.error ?? "error" }) };
      } catch (e) {
        return { ok: false, cuando, error: msg(e) };
      }
    };

    for (const a of d.acciones) {
      if (a.tipo === "recordatorio") {
        // Se marca ANTES de mandar (si dos corridas se pisan, la segunda ya lo ve); si Telegram falla, se desmarca.
        const previa = { ...marca };
        const nueva: MarcaDerivacion = { ...marca, aviso_1_en: marca.aviso_1_en ?? enISO, ...(a.nivel === 2 ? { aviso_2_en: enISO } : {}) };
        if (!await guardar(nueva)) continue;
        if (await avisar(textoRecordatorio(c, cfg, ahora), botonesContacto(c))) r.recordatorios!++;
        else {
          fallas.push(`${id}: Telegram falló en el recordatorio (sale en la próxima corrida)`);
          await guardar(previa);
        }
        continue;
      }

      if (a.tipo === "plazo_ventana_cerrada") {
        if (!await guardar({ ...marca, plazo_en: enISO, plazo_accion: "ventana_cerrada" })) continue;
        r.ventana_cerrada!++;
        await avisar(
          `⚠️ ${nombreHtml} lleva ${cfg.plazo_habil_h} h hábiles sin respuesta y ya pasaron 24 h desde su último mensaje: el bot no le puede escribir (solo plantilla). Escribile vos.\n${resumen3(c).join("\n")}\n${lineaContacto(c)}`,
          botonesContacto(c),
        );
        continue;
      }

      if (a.tipo === "fijo_plazo" || a.tipo === "fijo_ventana") {
        const esPlazo = a.tipo === "fijo_plazo";
        // Marca ANTES (nunca dos veces): si el envío falla, queda marcado igual y se avisa (no se reintenta cada 10 min).
        const m: MarcaDerivacion = esPlazo
          ? { ...marca, plazo_en: enISO, plazo_accion: "fijo" }
          : { ...marca, ventana_entrada: c.ultima_entrada_en ?? undefined };
        if (!await guardar(m)) continue;
        const env = await mandarFijo(esPlazo ? cfg.texto_plazo : cfg.texto_ventana);
        if (env.ok) r.fijos!++;
        else {
          fallas.push(`${id}: no salió el mensaje fijo (${env.error})`);
          if (esPlazo) await guardar({ ...marca, plazo_accion: "fijo_fallo" });
        }
        const por = esPlazo ? `${cfg.plazo_habil_h} h hábiles sin respuesta` : `casi 24 h sin que le escribamos`;
        await avisar(
          (env.ok
            ? `🔔 ${nombreHtml}: ${por}. Le escribí que le escribís <b>${escaparHtml(env.cuando)}</b>. Cumplilo.`
            : `🔔 ${nombreHtml}: ${por}. No pude mandarle el aviso (${escaparHtml(env.error ?? "")}): escribile vos ya.`) +
            `\n${resumen3(c).join("\n")}\n${lineaContacto(c)}`,
          botonesContacto(c),
        );
        continue;
      }

      // retomar: el chat vuelve a 'ia' y el vendedor escribe (turno de seguimiento: nunca deriva).
      if (!await guardar({ ...marca, plazo_en: enISO, plazo_accion: "retomar" })) continue;
      try {
        await deps.cambiarEstado(id, "ia");
      } catch (e) {
        fallas.push(`${id}: no se pudo pasar a ia (${msg(e)})`);
        await guardar({ ...marca, plazo_accion: "retomar_fallo" });
        continue;
      }
      let t: ResultadoTurno;
      try {
        t = await deps.turno({ conversacion_id: id, wa_message_id: `retomar:${id}:${enISO}`, texto: TEXTO_RETOMAR, origen: "seguimiento" });
      } catch (e) {
        t = { accion: "error_envio", motivo: msg(e) };
      }
      if (salio(t)) {
        r.retomados!++;
        await avisar(
          `🤖 ${nombreHtml} llevaba ${cfg.plazo_habil_h} h hábiles sin respuesta (derivado: ${escaparHtml(motivoLegible(c.derivacion.motivo))}): el bot retomó el chat.\n${resumen3(c).join("\n")}\n${lineaContacto(c)}`,
          botonesContacto(c),
        );
        continue;
      }
      if (t.accion === "omitido" && t.motivo === "cliente_escribio") {
        // El cliente escribió justo: ya está en 'ia' y su mensaje lo atiende el vendedor.
        r.retomados!++;
        continue;
      }
      if (t.accion === "derivado") {
        // No debería pasar (el turno de seguimiento no tiene derivar): queda en 'humano' por la derivación nueva.
        fallas.push(`${id}: el turno de retomar derivó (no debería)`);
        continue;
      }
      // No salió (tope de gasto, IA o filtro, error de envío): vuelve a 'humano' y va el mensaje fijo.
      await deps.cambiarEstado(id, "humano").catch((e) => fallas.push(`${id}: no se pudo volver a humano (${msg(e)})`));
      await guardar({ ...marca, plazo_accion: `retomar_no_salio:${t.accion}${t.motivo ? `:${t.motivo}` : ""}`.slice(0, 120) });
      const env = await mandarFijo(cfg.texto_plazo);
      if (env.ok) r.fijos!++;
      else fallas.push(`${id}: no salió el mensaje fijo (${env.error})`);
      await avisar(
        `🔔 ${nombreHtml}: ${cfg.plazo_habil_h} h hábiles sin respuesta y el bot no pudo retomar (${escaparHtml(t.accion)}${t.motivo ? `: ${escaparHtml(t.motivo)}` : ""}). ` +
          (env.ok ? `Le escribí que le escribís <b>${escaparHtml(env.cuando)}</b>. Cumplilo.` : "Escribile vos ya.") +
          `\n${resumen3(c).join("\n")}\n${lineaContacto(c)}`,
        botonesContacto(c),
      );
    }
  }

  if (fallas.length) {
    const lista = fallas.slice(0, 10).map((f) => `• ${escaparHtml(f)}`).join("\n");
    await deps.avisar(`<b>Derivaciones con plazo: ${fallas.length} con problemas</b>\n${lista}${fallas.length > 10 ? `\n… y ${fallas.length - 10} más` : ""}`)
      .catch((e) => console.error("seguimiento-chat: no se pudo avisar:", e));
  }
  return { ...r, fallas: fallas.length, motivos };
}
