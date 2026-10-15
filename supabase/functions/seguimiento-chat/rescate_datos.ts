// seguimiento-chat · rescate de datos (13-10-2026, plan de conversión por WhatsApp). Lógica pura: el I/O entra por
// DepsRescateDatos (io.ts en producción).
// Dato real: 2 de 2 clientes que tocaron "Quiero pedirlo" no terminaron de mandar los datos de entrega. Desde el 13-10
// el primer turno trae "2 con envío gratis" / "Quiero 1" / "Tengo una duda" (y el pack "Quiero el pack"); el toque
// le llega al vendedor y queda en wa_mensajes como entrante (interactive: contenido.interactive.button_reply.id;
// plantilla del toque 3: contenido.button.payload).
// Si el cliente tocó un "Quiero …" (vend_p1:q1|q2|pack|pedir:<handle>) y después se calló ≥ rescate_datos_min (10) min
// sin que haya un wa_pedidos_chat en 'resumen' o 'creado' posterior al toque, el vendedor le escribe UN mensaje corto
// pidiendo solo lo que falta (turno "[rescate datos]" con origen "seguimiento"; la regla está en el prompt).
// El cron corre cada 10 min: el rescate sale entre 10 y 20 min después del último mensaje del cliente.
// Uno por toque (marca perfil_vendedor.rescate_datos_en; si vuelve a tocar "Quiero" después, puede salir otro) y
// máximo rescate_datos_max (2) por conversación cada dias_reinicio (7) días (cuenta los turnos que salieron en
// vendedor_turnos, mensaje_entrada_id "rescate_datos:…").
// Sin franja 12-21 (el cliente tocó hace minutos), pero siempre dentro de la ventana de 24 h de WhatsApp: el toque
// tiene que ser de hace < VENTANA_TOQUE_H (23 h). No cuenta para el tope de recontactos (no toca `seguimientos`) y
// gasta IA como los demás turnos: con el tope de gasto del mes superado no corre.
// Nunca si: no está en 'ia', rechazo, fecha pedida a futuro (recontactar_el), baja de marketing, pedido en
// dias_pedido días, la última respuesta fue una derivación o un mensaje de Enrique, el cliente habló último (su
// mensaje no tuvo respuesta: ahí está el aviso de intención) o ya salió un recontacto después del toque.
// El aviso de intención a Enrique (logica.ts, 15 min) sigue igual: convive con este.
// Se apaga con rescate_datos_activo: false (o con `activo: false` de los recontactos).
import { escaparHtml } from "../_shared/telegram_formato.ts";
import type { ResultadoTurno } from "../_shared/vendedor/orquestador.ts";
import { normalizarPerfil } from "../_shared/vendedor/perfil.ts";
import { partesAsuncion } from "../_shared/horario.ts";
import { type Candidato, type CfgSeguimiento, type DepsSeguimiento, enLotes, esFalla, leerCfgSeguimiento } from "./logica.ts";

export type CfgRescateDatos = {
  /** Se apaga con false (también con `activo: false` de los recontactos). */
  rescate_datos_activo: boolean;
  /** Minutos sin mensaje del cliente para rescatar. */
  rescate_datos_min: number;
  /** Rescates por conversación cada dias_reinicio días. */
  rescate_datos_max: number;
};

export const CFG_RESCATE_DATOS_DEFAULT: CfgRescateDatos = {
  rescate_datos_activo: true,
  rescate_datos_min: 10,
  rescate_datos_max: 2,
};

/** El toque tiene que ser de hace menos de esto (la ventana de 24 h de WhatsApp, con margen). */
export const VENTANA_TOQUE_H = 23;

/** Texto exacto de la entrada del turno (contrato con el prompt del vendedor). */
export const TEXTO_RESCATE_DATOS = "[rescate datos]";

/** Prefijo del mensaje_entrada_id del turno (vendedor_turnos): de ahí sale el conteo por conversación. */
export const PREFIJO_RESCATE = "rescate_datos:";

const H = 3_600_000;
const MIN = 60_000;
const esObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Claves rescate_datos_* del mismo config_wa.vendedor_seguimiento (lo que falte o venga raro toma el default). */
export function leerCfgRescateDatos(v: unknown): CfgRescateDatos {
  const c: CfgRescateDatos = { ...CFG_RESCATE_DATOS_DEFAULT };
  if (!esObj(v)) return c;
  if (typeof v.rescate_datos_activo === "boolean") c.rescate_datos_activo = v.rescate_datos_activo;
  for (const k of ["rescate_datos_min", "rescate_datos_max"] as const) {
    const x = v[k];
    if (typeof x === "number" && Number.isFinite(x) && x >= 0) c[k] = x;
  }
  c.rescate_datos_max = Math.floor(c.rescate_datos_max);
  return c;
}

/** Botones "Quiero …": primer turno 13-10 (q1, q2, pack) y el viejo "Quiero pedirlo" (pedir, también del toque 3). */
const RE_QUIERO = /^vend_p1:(?:q1|q2|pack|pedir):/;

/** true si el id (button_reply.id o payload de plantilla) es de un botón "Quiero …". "duda" no cuenta. */
export function esBotonQuiero(id: string | null | undefined): boolean {
  return RE_QUIERO.test(String(id ?? "").trim());
}

/** accion de vendedor_turnos de un turno de rescate que le llegó al cliente (respondido, terminal o derivado). */
export function rescateSalio(accion: string | null | undefined): boolean {
  return /^seguimiento(?:$|:|_terminal|_derivado)/.test(String(accion ?? ""));
}

/** rescate_datos_en del perfil (marca de esta rutina), o null. */
export function rescateDatosEn(perfil: unknown): string | null {
  return normalizarPerfil(perfil).rescate_datos_en ?? null;
}

/** YYYY-MM-DD en Asunción. */
function fechaAsuncion(d: Date): string {
  const p = partesAsuncion(d);
  return `${p.anio}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

export type DecisionRescate = { tipo: "rescate" } | { tipo: "nada"; motivo: string };

export function decidirRescateDatos(c: Candidato, rd: CfgRescateDatos, cfg: CfgSeguimiento, ahora: Date): DecisionRescate {
  const nada = (motivo: string): DecisionRescate => ({ tipo: "nada", motivo });
  if (c.estado !== "ia") return nada("no_esta_en_ia");
  const toque = c.ultimo_quiero_en ? Date.parse(c.ultimo_quiero_en) : NaN;
  if (!Number.isFinite(toque)) return nada("sin_quiero");
  const ventana = Math.min(VENTANA_TOQUE_H, cfg.ventana_max_h);
  if ((ahora.getTime() - toque) / H >= ventana) return nada("ventana_cerrada");
  const entrada = c.ultima_entrada_en ? Date.parse(c.ultima_entrada_en) : NaN;
  if (!Number.isFinite(entrada)) return nada("sin_entrada_del_cliente");
  if ((ahora.getTime() - entrada) / H >= cfg.ventana_max_h) return nada("ventana_cerrada");
  if ((ahora.getTime() - entrada) / MIN < rd.rescate_datos_min) return nada("esperando");
  const perfil = normalizarPerfil(c.perfil);
  if (perfil.rechazo) return nada("rechazo");
  if (perfil.recontactar_el && perfil.recontactar_el > fechaAsuncion(ahora)) return nada("espera_fecha_pedida");
  if (c.baja_marketing) return nada("baja_marketing");
  if (c.pedido_reciente) return nada("pedido_reciente");
  // Ya mandó los datos: el vendedor armó el resumen (o el pedido) después del toque.
  const resumen = c.ultimo_resumen_en ? Date.parse(c.ultimo_resumen_en) : NaN;
  if (Number.isFinite(resumen) && resumen >= toque) return nada("ya_hay_resumen");
  const previo = perfil.rescate_datos_en ? Date.parse(perfil.rescate_datos_en) : NaN;
  if (Number.isFinite(previo) && previo >= toque) return nada("ya_rescatado");
  // Un recontacto (1, 2 o el del cobro) que ya salió después del toque ya hizo este trabajo.
  const seg = perfil.ultimo_seguimiento_en ? Date.parse(perfil.ultimo_seguimiento_en) : NaN;
  const cobro = perfil.recontacto_cobro_en ? Date.parse(perfil.recontacto_cobro_en) : NaN;
  if ((Number.isFinite(seg) && seg >= toque) || (Number.isFinite(cobro) && cobro >= toque)) return nada("recontacto_ya_salio");
  if (!c.ultimo_mensaje || c.ultimo_mensaje.direccion !== "out") return nada("cliente_hablo_ultimo");
  if (c.ultima_respuesta_derivada) return nada("derivado");
  if (c.ultimo_mensaje.manual) return nada("enrique_escribio");
  if ((c.rescates_datos ?? 0) >= rd.rescate_datos_max) return nada("tope_rescates");
  return { tipo: "rescate" };
}

// ---------- corrida ----------

export type DepsRescateDatos = {
  /**
   * Conversaciones en 'ia' con un toque "Quiero …" desde toqueDesdeISO y la última entrada <= entradaHastaISO,
   * con ultimo_quiero_en, ultimo_resumen_en y rescates_datos (en los últimos cfg.dias_reinicio días).
   */
  candidatosRescateDatos(toqueDesdeISO: string, entradaHastaISO: string, cfg: CfgSeguimiento): Promise<Candidato[]>;
  /** Guarda (ISO) o borra (null) perfil_vendedor.rescate_datos_en sin pisar el resto del perfil. */
  marcarRescateDatos(conversacionId: string, enISO: string | null): Promise<void>;
};

export type ResumenRescateDatos = {
  accion: "inactivo" | "tope_gasto" | "corrido" | "error";
  candidatos?: number;
  elegibles?: number;
  enviados?: number;
  omitidos?: number;
  fallas?: number;
  motivos?: Record<string, number>;
  resultados?: Array<{ conversacion_id: string; accion: string; motivo?: string }>;
};

export async function correrRescateDatos(deps: DepsSeguimiento, crudo: unknown): Promise<ResumenRescateDatos> {
  const buscar = deps.candidatosRescateDatos, marcar = deps.marcarRescateDatos;
  const cfg = leerCfgSeguimiento(crudo);
  const rd = leerCfgRescateDatos(crudo);
  if (!buscar || !marcar || !cfg.activo || !rd.rescate_datos_activo || rd.rescate_datos_max <= 0 || cfg.lote_max <= 0) {
    return { accion: "inactivo" };
  }
  const ahora = deps.ahora();
  const desde = new Date(ahora.getTime() - Math.min(VENTANA_TOQUE_H, cfg.ventana_max_h) * H).toISOString();
  const hasta = new Date(ahora.getTime() - rd.rescate_datos_min * MIN).toISOString();
  const candidatos = await buscar(desde, hasta, cfg);

  const motivos: Record<string, number> = {};
  const elegidos: Candidato[] = [];
  for (const c of candidatos) {
    const d = decidirRescateDatos(c, rd, cfg, ahora);
    if (d.tipo === "nada") motivos[d.motivo] = (motivos[d.motivo] ?? 0) + 1;
    else elegidos.push(c);
  }
  const base = { candidatos: candidatos.length, elegibles: elegidos.length };
  if (!elegidos.length) return { accion: "corrido", ...base, enviados: 0, omitidos: 0, fallas: 0, motivos };
  // Gasta IA como cualquier turno: con el tope del mes superado no corre (el orquestador igual lo vuelve a mirar).
  if (await deps.topeGastoSuperado(ahora)) return { accion: "tope_gasto", ...base, motivos };
  const lote = elegidos.slice(0, cfg.lote_max);
  if (elegidos.length > lote.length) motivos.lote_lleno = elegidos.length - lote.length;

  const resultados: NonNullable<ResumenRescateDatos["resultados"]> = [];
  const fallas: string[] = [];
  let enviados = 0, omitidos = 0;
  await enLotes(lote, deps.paralelo ?? 4, async (c) => {
    const id = c.conversacion_id;
    const enISO = deps.ahora().toISOString();
    const previo = rescateDatosEn(c.perfil);
    try {
      // Se marca ANTES del turno: si dos corridas se pisan, la segunda ya lo ve rescatado.
      await marcar(id, enISO);
    } catch (e) {
      fallas.push(`${id}: no se pudo marcar (${msg(e)})`);
      return;
    }
    let r: ResultadoTurno;
    try {
      r = await deps.turno({ conversacion_id: id, wa_message_id: `${PREFIJO_RESCATE}${id}:${enISO}`, texto: TEXTO_RESCATE_DATOS, origen: "seguimiento" });
    } catch (e) {
      r = { accion: "error_envio", motivo: msg(e) };
    }
    resultados.push({ conversacion_id: id, accion: r.accion, ...(r.motivo ? { motivo: r.motivo } : {}) });
    if (r.accion === "respondido" || r.accion === "terminal" || r.accion === "derivado") enviados++;
    else omitidos++;
    if (esFalla(r)) fallas.push(`${id}: rescate de datos → ${r.accion}${r.motivo ? ` (${r.motivo})` : ""}`);
    // No salió nada y no se gastó (cliente escribió antes de llamar al modelo, topes): se devuelve la marca anterior.
    if (r.accion === "omitido" && !esFalla(r) && !(Number(r.costo_usd) > 0)) {
      await marcar(id, previo).catch((e) => fallas.push(`${id}: no se pudo desmarcar (${msg(e)})`));
    }
  });

  if (fallas.length) {
    const lista = fallas.slice(0, 10).map((f) => `• ${escaparHtml(f)}`).join("\n");
    await deps.avisar(
      `<b>Rescate de datos: ${fallas.length} con problemas</b>\n${lista}${fallas.length > 10 ? `\n… y ${fallas.length - 10} más` : ""}`,
    ).catch((e) => console.error("seguimiento-chat: no se pudo avisar (rescate de datos):", e));
  }

  return { accion: "corrido", ...base, enviados, omitidos, fallas: fallas.length, motivos, resultados };
}
