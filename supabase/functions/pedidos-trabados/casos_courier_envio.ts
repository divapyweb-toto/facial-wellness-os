// pedidos-trabados · casos para el courier (Enrique 04-11-2026). Lógica pura + orquestación con dependencias inyectadas
// (las reales están en casos_courier_envio_io.ts). Contrato en _shared/casos_courier.ts.
//   · Horario: lun–sáb, franja "am" desde las 08:30 y "pm" desde las 14:00 (Paraguay). El cron corre cada 10 min: si ya
//     pasó la hora y el candado auto_casos_courier:<día>:<franja>:<courier> está libre, sale UN Telegram por courier con
//     los pendientes creados hasta la hora de la franja (más viejo primero). Lo que entra después espera a la próxima.
//   · Urgente: sale en la próxima corrida, solo (lote "urgente:<id>"), entre las 07:00 y las 20:00 (también domingo).
//   · Casos del sistema (origen 'sistema'): PaP con plazo vencido (plazo_pap.ts), Lucero en curso hace ≥ 4 días y guías
//     que Lucero no encuentra (lucero_web_error = 'no_encontrado'). Uno por pedido y tipo; uno ya enviado vuelve a salir
//     solo si pasan 2 días hábiles sin novedad (sigue sin entregar y el estado del courier no cambió).
//   · Si Telegram falla 3 veces se suelta el candado y la próxima corrida reintenta; los casos se marcan 'enviado' solo
//     cuando el Telegram salió.
import {
  type CasoCourier, type CourierCaso, guiaDe, type LineaCaso, NOMBRE_COURIER, type RendicionPendiente, textoParaCourier, textoTelegramCasos, type TipoCaso,
} from "../_shared/casos_courier.ts";
import { escaparHtml, LIMITE_TEXTO_TELEGRAM } from "../_shared/telegram_formato.ts";
import type { OpcionesAviso } from "../_shared/telegram_politica.ts";
import { type DepsActuar, diaPy, diasDesde, horaPy, normEstado, pedidoDeRef } from "./entregas_actuar.ts";
import { diasHabilesDesde, estadoPlazoPap, type FilaPlazoPap, umbralPlazoPap } from "./plazo_pap.ts";

export type Franja = "am" | "pm";
/** Hora (Paraguay) desde la que sale cada franja. */
export const HORARIOS_CASOS: Record<Franja, { h: number; m: number }> = { am: { h: 8, m: 30 }, pm: { h: 14, m: 0 } };
/** Lucero en curso (ni entregado, ni devuelto, ni cancelado) con fecha de ingreso de hace esto o más → caso 'plazo'. */
export const DIAS_PLAZO_LUCERO = 4;
// 04-11 (coordinador): Lucero tiene corredores del interior de 3 a 9 días (CDE→Salto del Guairá): el umbral es el mayor
// entre DIAS_PLAZO_LUCERO y dias_max + 1 de la tarifa de Lucero de la ciudad (rpc sugerir_courier). Sin dato, 4.
/** Urgentes: solo salen en este horario de Paraguay (también domingo); fuera de él esperan a las 07:00. */
export const HORA_URGENTES = { desde: 7, hasta: 20 };
/** Un caso del sistema ya enviado vuelve a salir si pasan estos días hábiles (lun–vie) sin novedad. */
export const DIAS_HABILES_REENVIO = 2;
/** 04-11 (Enrique): ya los mandó a mano hoy. Se siembran como 'enviado' (sembrarYaAvisados) y no salen en el primer Telegram. */
export const YA_AVISADOS_04_11 = ["VT-1027", "VT-1090", "VT-1102", "VT-1107", "VT-1109", "VT-1110", "VT-1112", "VT-1115", "VT-1118", "VT-1172", "VT-1190"];
export const DIA_YA_AVISADOS = "2026-11-04";
/** Margen para el encabezado y el escapado HTML: arriba de esto el mensaje se parte en varios. */
export const LIMITE_TEXTO_CASOS = LIMITE_TEXTO_TELEGRAM - 300;

const COURIERS: CourierCaso[] = ["lucero", "pap"];
const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const ddmm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
const porFecha = (a: CasoCourier, b: CasoCourier) => a.creado_en.localeCompare(b.creado_en);

// ── horario ──
/** Franja vigente: la última cuya hora ya pasó hoy (lun–sáb). null = domingo o antes de las 08:30. `corte` en ISO UTC. */
export function franjaActual(ahora: Date): { franja: Franja; dia: string; corte: string } | null {
  const dia = diaPy(ahora);
  if (new Date(`${dia}T12:00:00Z`).getUTCDay() === 0) return null;
  const min = horaPy(ahora) * 60 + ahora.getUTCMinutes(); // UTC−3 fijo: los minutos son los mismos
  const franja = (["pm", "am"] as const).find((f) => min >= HORARIOS_CASOS[f].h * 60 + HORARIOS_CASOS[f].m);
  if (!franja) return null;
  const { h, m } = HORARIOS_CASOS[franja];
  return { franja, dia, corte: new Date(Date.parse(`${dia}T00:00:00Z`) + ((h + 3) * 60 + m) * 60_000).toISOString() };
}

export const loteCasos = (dia: string, franja: Franja, courier: CourierCaso) => `${dia}:${franja}:${courier}`;
export const claveCandadoCasos = (dia: string, franja: Franja, courier: CourierCaso) => `auto_casos_courier:${loteCasos(dia, franja, courier)}`;
export const claveCandadoUrgente = (id: string) => `auto_casos_courier:urgente:${id}`;

/** Tipo y destino del Telegram (telegram_tipos.ts). */
export const OPCIONES_CASOS: OpcionesAviso = { tipo: "casos_courier", destino: "enrique" };
export const opcionesUrgente = (ref: string): OpcionesAviso => ({ tipo: "casos_courier_urgente", destino: "enrique", pedido: pedidoDeRef(ref) });

// ── datos del pedido ──
/** Lo que la I/O cruza de entregas + shopify_pedidos para cada ref. */
export interface DatosPedidoCaso {
  nombre: string | null;
  ciudad: string | null;
  /** Lucero no encontrada: created_at de la entrega; el resto: entregas.fecha_ingreso. AAAA-MM-DD. */
  fechaIngreso: string | null;
  guiaPap: string | null;
  estadoCourier: string | null;
  categoria: string | null;
  /** Lucero: su página dice "No se encontró el envío solicitado" (entregas.lucero_web_error = 'no_encontrado'). */
  noEncontrada: boolean;
}

/** Una línea por caso, en el mismo orden (el contrato agrupa sistema / cliente en el texto). */
export function lineasDe(casos: CasoCourier[], datos: Map<string, DatosPedidoCaso>): LineaCaso[] {
  return casos.map((c) => {
    const d = datos.get(c.ref);
    return {
      guia: guiaDe(c.courier, c.ref, d?.guiaPap), ref: c.ref, nombre: d?.nombre?.trim() || "sin nombre",
      ciudad: d?.ciudad?.trim() || "ciudad sin cargar", fechaIngreso: d?.fechaIngreso ?? null, pide: c.pide,
      horario: c.horario, referencia: c.referencia, recibe: c.recibe, esperaDesde: diaPy(new Date(c.creado_en)),
      urgente: c.urgente, tipo: c.tipo, origen: c.origen,
    };
  });
}

// ── qué sale ahora ──
export interface EnvioCasos { clave: string; lote: string; courier: CourierCaso; urgente: boolean; casos: CasoCourier[]; conRendiciones: boolean }

/**
 * Urgentes: uno por caso, ya (07:00–20:00; fuera de ese horario esperan). Franja: un envío por courier con los pendientes no urgentes creados hasta la hora de la
 * franja, más viejo primero. PaP lleva las rendiciones pendientes; si no tiene casos, sale solo con ellas en la franja am.
 */
export function planificarEnvios(pendientes: CasoCourier[], ahora: Date, hayRendicionesPap = false): EnvioCasos[] {
  const p = pendientes.filter((c) => c.estado === "pendiente").sort(porFecha);
  const h = horaPy(ahora), horaUrgente = h >= HORA_URGENTES.desde && h < HORA_URGENTES.hasta;
  const envios: EnvioCasos[] = p.filter((c) => c.urgente && horaUrgente).map((c) => ({
    clave: claveCandadoUrgente(c.id), lote: `urgente:${c.id}`, courier: c.courier, urgente: true, casos: [c], conRendiciones: false,
  }));
  const f = franjaActual(ahora);
  if (!f) return envios;
  for (const courier of COURIERS) {
    const casos = p.filter((c) => !c.urgente && c.courier === courier && c.creado_en <= f.corte);
    const conRendiciones = courier === "pap" && hayRendicionesPap;
    if (!casos.length && !(conRendiciones && f.franja === "am")) continue;
    envios.push({ clave: claveCandadoCasos(f.dia, f.franja, courier), lote: loteCasos(f.dia, f.franja, courier), courier, urgente: false, casos, conRendiciones });
  }
  return envios;
}

/** 04-11: Telegram de PaP sin casos, solo con las rendiciones pendientes. */
export const textoSoloRendiciones = (courier: CourierCaso, rendiciones: RendicionPendiente[]) =>
  `💰 <b>Para ${NOMBRE_COURIER[courier]}</b> · rendiciones pendientes. Copiá y pegá en su WhatsApp:\n\n` +
  `<pre>${escaparHtml(textoParaCourier(courier, [], rendiciones))}</pre>`;

/** Telegram(s) de un envío: si no entra en uno, se parte por casos (las rendiciones van en el primero). */
export function partesEnvio(e: EnvioCasos, lineas: LineaCaso[], rendiciones: RendicionPendiente[]): Array<{ texto: string; casos: CasoCourier[] }> {
  const rend = (i: number) => (e.conRendiciones && i === 0 ? rendiciones : []);
  if (!lineas.length) return [{ texto: textoSoloRendiciones(e.courier, rend(0)), casos: [] }];
  const partes: Array<{ texto: string; casos: CasoCourier[] }> = [];
  let desde = 0;
  while (desde < lineas.length) {
    let hasta = desde + 1;
    while (hasta < lineas.length && textoTelegramCasos(e.courier, lineas.slice(desde, hasta + 1), e.urgente, rend(partes.length)).length <= LIMITE_TEXTO_CASOS) hasta++;
    partes.push({ texto: textoTelegramCasos(e.courier, lineas.slice(desde, hasta), e.urgente, rend(partes.length)), casos: e.casos.slice(desde, hasta) });
    desde = hasta;
  }
  return partes;
}

// ── estado del courier guardado en el lote ("<lote>|estado:<x>", y "|novedad:<día>:<x>" cuando cambia) ──
/** Estado con el que se compara la novedad: Lucero no encontrada = "no_encontrado" (estado_pap está viejo en esas). */
export const estadoBase = (tipo: TipoCaso, d: DatosPedidoCaso | undefined) =>
  tipo === "no_encontrada" ? "no_encontrado" : normEstado(d?.estadoCourier ?? "");
export const loteConEstado = (lote: string, estado: string) => `${lote}|estado:${estado}`;

/** Desde cuándo y con qué estado se cuentan los 2 días hábiles: la última novedad, o el envío. */
export function baseDeCaso(c: CasoCourier): { dia: string | null; estado: string | null } {
  const lote = c.lote ?? "";
  const nov = [...lote.matchAll(/\|novedad:(\d{4}-\d{2}-\d{2}):([a-z0-9_]+)/g)].at(-1);
  if (nov) return { dia: nov[1], estado: nov[2] };
  return { dia: c.enviado_en ? diaPy(new Date(c.enviado_en)) : null, estado: /\|estado:([a-z0-9_]+)/.exec(lote)?.[1] ?? null };
}

const TERMINAL = /entregad|devuelt|cancelad/;
const terminado = (d: DatosPedidoCaso) =>
  ["entregado", "devuelto"].includes(String(d.categoria ?? "")) || TERMINAL.test(sinTildes(String(d.estadoCourier ?? "")).toLowerCase());

export type Seguimiento = { accion: "nada" } | { accion: "cerrar"; motivo: string } | { accion: "novedad"; lote: string } | { accion: "reenviar" };

/** Qué hacer con el último caso del sistema de un pedido (pendiente o enviado). */
export function decidirSeguimiento(c: CasoCourier, d: DatosPedidoCaso | undefined, ahora: Date): Seguimiento {
  if (c.estado === "cerrado" || !d) return { accion: "nada" };
  if (terminado(d)) return { accion: "cerrar", motivo: "entregado o devuelto" };
  // 04-11 (FUNCIONES): si Lucero vuelve a mostrar la guía, lucero_web_error se limpia solo → el caso se cierra y no sale.
  if (c.tipo === "no_encontrada" && !d.noEncontrada) return { accion: "cerrar", motivo: "Lucero volvió a mostrar la guía" };
  if (c.estado === "pendiente") return { accion: "nada" };
  const base = baseDeCaso(c), actual = estadoBase(c.tipo, d), hoy = diaPy(ahora);
  if (!base.dia || base.estado !== actual) return { accion: "novedad", lote: `${c.lote ?? ""}|novedad:${hoy}:${actual}` };
  return (diasHabilesDesde(base.dia, ahora) ?? 0) >= DIAS_HABILES_REENVIO ? { accion: "reenviar" } : { accion: "nada" };
}

// ── casos nuevos del sistema ──
export interface CasoSistemaNuevo { ref: string; courier: CourierCaso; tipo: TipoCaso; pide: string }
export interface FilaLuceroCurso { ref: string; estado: string; categoria: string | null; fechaIngreso: string | null; noEncontrada: boolean; ciudad?: string | null }

/** Clave de ciudad para el mapa de días de Lucero (sin mayúsculas, tildes ni espacios de más). */
export const claveCiudad = (c: string | null | undefined) => sinTildes(String(c ?? "")).toLowerCase().replace(/\s+/g, " ").trim();
/** Umbral de Lucero para la ciudad: max(DIAS_PLAZO_LUCERO, dias_max + 1). `diasMax`: claveCiudad → dias_max de su tarifa. */
export function umbralLucero(ciudad: string | null | undefined, diasMax: Map<string, number>): number {
  const d = diasMax.get(claveCiudad(ciudad));
  return d != null && Number.isFinite(d) ? Math.max(DIAS_PLAZO_LUCERO, d + 1) : DIAS_PLAZO_LUCERO;
}

/** PaP con el plazo vencido (misma regla que procesarPlazoPap: estado que cuenta + días hábiles > umbral). */
export function nuevosPlazoPap(filas: FilaPlazoPap[], ahora: Date): CasoSistemaNuevo[] {
  const r: CasoSistemaNuevo[] = [];
  for (const f of filas) {
    if (!estadoPlazoPap(f.estado)) continue;
    const dias = diasHabilesDesde(f.fechaVenta, ahora);
    if (dias == null || dias <= umbralPlazoPap(f.estado)) continue;
    r.push({ ref: f.ref, courier: "pap", tipo: "plazo", pide: `Figura "${f.estado.trim()}" hace ${dias} días hábiles` });
  }
  return r;
}

/** Lucero "solo devuelto/cancelado son fallidos": en curso hace ≥ umbralLucero días. Fallido/no contesta/reprogramar tiene su aviso. */
export function nuevosPlazoLucero(filas: FilaLuceroCurso[], ahora: Date, diasMax: Map<string, number> = new Map()): CasoSistemaNuevo[] {
  const r: CasoSistemaNuevo[] = [];
  for (const f of filas) {
    const e = sinTildes(f.estado).toLowerCase();
    if (f.noEncontrada || ["entregado", "devuelto"].includes(String(f.categoria ?? "")) || TERMINAL.test(e) || /fallid|no contest|reprogram/.test(e)) continue;
    const dias = diasDesde(f.fechaIngreso, ahora);
    if (dias == null || dias < umbralLucero(f.ciudad, diasMax)) continue;
    r.push({ ref: f.ref, courier: "lucero", tipo: "plazo", pide: `Figura "${f.estado.trim() || "sin estado"}" hace ${dias} días` });
  }
  return r;
}

/** Guías que Lucero no encuentra (lucero_web_error = 'no_encontrado'). La pregunta la pone el contrato en el punto agrupado. */
export const casosNoEncontrada = (refs: string[]): CasoSistemaNuevo[] =>
  [...new Set(refs)].map((ref) => ({ ref, courier: "lucero" as const, tipo: "no_encontrada" as const, pide: "" }));

/** Texto del reenvío: "Ya lo consulté el 04/11 y sigue "Aceptado"" / "... y sigue sin aparecer". */
export function pideReenvio(c: CasoCourier, d: DatosPedidoCaso | undefined): string {
  const cuando = c.enviado_en ? `Ya lo consulté el ${ddmm(diaPy(new Date(c.enviado_en)))}` : "Ya lo consulté";
  return c.tipo === "no_encontrada" ? `${cuando} y sigue sin aparecer` : `${cuando} y sigue "${d?.estadoCourier?.trim() || "sin novedad"}"`;
}

export interface DepsSistema {
  /** Inserta un caso pendiente del sistema. "ya_pendiente" = el índice único (pedido + origen) lo frenó. */
  insertarCaso(c: CasoSistemaNuevo): Promise<"insertado" | "ya_pendiente" | "sin_pedido">;
  actualizarCaso(id: string, cambios: { estado?: "cerrado"; lote?: string }): Promise<void>;
}
export interface HechoSistema { ref: string; tipo: TipoCaso; resultado: string }

/**
 * `existentes`: TODOS los casos del sistema (cualquier estado). Primero el seguimiento del último de cada pedido (cerrar,
 * anotar novedad o reenviar); después los nuevos: uno por pedido y tipo, en la vida.
 */
export async function procesarCasosSistema(
  nuevos: CasoSistemaNuevo[], existentes: CasoCourier[], datos: Map<string, DatosPedidoCaso>, ahora: Date, d: DepsSistema, simular = false,
): Promise<HechoSistema[]> {
  const hechos: HechoSistema[] = [];
  const ultimo = new Map<string, CasoCourier>();
  for (const c of [...existentes].sort(porFecha)) ultimo.set(c.ref, c);
  const tocados = new Set<string>();
  const hacer = async (ref: string, tipo: TipoCaso, que: string, f: () => Promise<string | void>) => {
    if (simular) return hechos.push({ ref, tipo, resultado: `simulado: ${que}` });
    const r = await f().then((x) => (x && x !== "insertado" ? `${que}: ${x}` : que)).catch((e) => `error: ${e instanceof Error ? e.message : String(e)}`);
    hechos.push({ ref, tipo, resultado: r });
  };
  for (const c of ultimo.values()) {
    const s = decidirSeguimiento(c, datos.get(c.ref), ahora);
    if (s.accion === "nada") continue;
    tocados.add(c.ref);
    if (s.accion === "cerrar") await hacer(c.ref, c.tipo, `cerrado (${s.motivo})`, () => d.actualizarCaso(c.id, { estado: "cerrado" }));
    else if (s.accion === "novedad") await hacer(c.ref, c.tipo, "novedad (cambió el estado)", () => d.actualizarCaso(c.id, { lote: s.lote }));
    else await hacer(c.ref, c.tipo, "reenviado", () => d.insertarCaso({ ref: c.ref, courier: c.courier, tipo: c.tipo, pide: pideReenvio(c, datos.get(c.ref)) }));
  }
  const yaAvisadosVigentes = (diasHabilesDesde(DIA_YA_AVISADOS, ahora) ?? 0) < DIAS_HABILES_REENVIO;
  for (const n of nuevos) {
    if (tocados.has(n.ref)) continue;
    if (existentes.some((c) => c.ref === n.ref && c.tipo === n.tipo)) continue; // ya tuvo su caso: lo sigue el reenvío
    if (ultimo.get(n.ref)?.estado === "pendiente") continue; // ya hay uno pendiente del sistema para ese pedido
    // Por si la siembra no se corrió: los que Enrique mandó a mano el 04-11 no salen antes de los 2 días hábiles.
    if (yaAvisadosVigentes && YA_AVISADOS_04_11.includes(n.ref)) continue;
    tocados.add(n.ref);
    await hacer(n.ref, n.tipo, "nuevo", () => d.insertarCaso(n));
  }
  return hechos;
}

// ── envío ──
export interface DepsCasos extends Pick<DepsActuar, "tomarCandado" | "soltarCandado" | "existeCandado" | "avisar" | "esperar"> {
  /** estado 'enviado', enviado_en = ahora, lote (con el estado del courier en ese momento, para el reenvío). */
  marcarEnviados(casos: CasoCourier[], lote: (c: CasoCourier) => string, ahora: Date): Promise<void>;
}
export interface HechoEnvio { lote: string; courier: CourierCaso; casos: string[]; resultado: string; textos?: string[] }

async function mandar(d: DepsCasos, texto: string, opts: OpcionesAviso): Promise<string | null> {
  let ultimo = "";
  for (let i = 0; i < 3; i++) {
    const r = await d.avisar(texto, undefined, opts);
    if (r.ok) return null;
    ultimo = r.error ?? "Telegram falló";
    if (i < 2) await d.esperar(1500);
  }
  return ultimo;
}

/** Manda cada envío una vez (candado). Si una parte falla, suelta el candado: lo ya marcado no se repite. */
export async function enviarCasos(
  envios: EnvioCasos[], datos: Map<string, DatosPedidoCaso>, rendiciones: RendicionPendiente[], ahora: Date, d: DepsCasos, simular = false,
): Promise<HechoEnvio[]> {
  const hechos: HechoEnvio[] = [];
  for (const e of envios) {
    const partes = partesEnvio(e, lineasDe(e.casos, datos), rendiciones);
    const h: HechoEnvio = { lote: e.lote, courier: e.courier, casos: e.casos.map((c) => c.ref), resultado: "" };
    hechos.push(h);
    if (simular) {
      h.resultado = (await d.existeCandado(e.clave)) ? "ya_enviado" : "simulado";
      h.textos = partes.map((p) => p.texto);
      continue;
    }
    if (!(await d.tomarCandado(e.clave, { lote: e.lote, casos: h.casos }))) { h.resultado = "ya_enviado"; continue; }
    const opts = e.urgente ? opcionesUrgente(e.casos[0].ref) : OPCIONES_CASOS;
    h.resultado = "enviado";
    for (const p of partes) {
      const error = await mandar(d, p.texto, opts);
      if (error) {
        await d.soltarCandado(e.clave);
        h.resultado = `error: Telegram: ${error}`;
        break;
      }
      if (!p.casos.length) continue;
      await d.marcarEnviados(p.casos, (c) => loteConEstado(e.lote, estadoBase(c.tipo, datos.get(c.ref))), ahora)
        .catch((x) => { h.resultado = `enviado; error al marcar: ${x instanceof Error ? x.message : String(x)}`; });
    }
  }
  return hechos;
}
