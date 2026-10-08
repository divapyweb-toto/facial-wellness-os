// _shared/vendedor/orquestador.ts · Dueño: G1 (ola 2)
// Un turno del vendedor con IA: arma el historial (los últimos N mensajes + el perfil del cliente resumido),
// llama al modelo con herramientas en bucle (con límite de vueltas), aplica el filtro de salida (reglas duras y
// "que no suene a bot"), regenera una vez con el motivo y, si vuelve a fallar, si la API falla o si se pasa el
// tope de gasto o de turnos, deriva a Enrique. El texto que el modelo escribe junto con derivar_a_enrique pasa
// por el filtro y va arriba del botón (en salud, antecedido por la frase del médico).
// Ahorro: un sticker suelto al empezar, un "gracias" suelto o un "ok" después del pedido se responden con un
// texto fijo de config (sin modelo); registrar_perfil no gasta otra vuelta si viene junto con el texto.
// Ritmo humano (ritmo.ts): espera ~8 s de silencio para juntar mensajes seguidos, marca leído, muestra
// "escribiendo…" el tiempo de leer + escribir (con variación, más lento de noche) y manda cada línea de la
// respuesta como una burbuja aparte (máximo 3; una sola línea larga se parte en 2), con su pausa y "escribiendo…".
// Los interactivos (botones, listas, derivación) no se parten. Registra vendedor_turnos, el costo y el perfil en la conversación.
// Sin I/O propio: todo entra por `DepsOrquestador` (io.ts en producción).
// Turno de seguimiento (07-10, seguimiento-chat): `origen: "seguimiento"` y texto "[seguimiento N]". No marca
// leído ni muestra "escribiendo…" (no hay mensaje real del cliente), no espera para agrupar, no usa respuestas
// fijas y, si el cliente escribió mientras tanto, no manda nada (ese mensaje ya tiene su propio turno). Nunca
// deriva a Enrique por su cuenta: con tope de gasto o de turnos no hace nada; si la IA o el filtro fallan, no
// manda nada y queda registrado. Se registra en vendedor_turnos con accion "seguimiento" (o "seguimiento_<…>").
import {
  type Bloque,
  type BloqueTexto,
  type BloqueToolResult,
  ErrorClaude,
  type Mensaje,
  type PedidoClaude,
  type RespuestaClaude,
  sumarUso,
  textoDe,
  type Uso,
  USO_CERO,
  usosDeHerramientas,
} from "../claude.ts";
import { partesAsuncion } from "../horario.ts";
import { montosDeResultado, revisarRespuesta } from "./filtro_salida.ts";
import { catalogo, derivarAEnrique, ejecutarHerramienta, HERRAMIENTAS, type MotivoDerivacion } from "./herramientas.ts";
import {
  fusionarPerfil,
  marcasDeRespuesta,
  mismoPerfil,
  normalizarPerfil,
  type PerfilCliente,
  esRechazo,
  preguntaSiEsBot,
  textoPerfil,
} from "./perfil.ts";
import { armarPrompt } from "./prompt.ts";
import { elegirVariante, tipoRespuestaFija } from "./respuestas_fijas.ts";
import { calcularDemoraMs, partirEnBurbujas, pausaBurbujaMs } from "./ritmo.ts";
import type { ConfigTurno, CtxTurno, DepsHerramientas } from "./tipos.ts";

export type FilaHistorial = {
  direccion: "in" | "out";
  texto: string | null;
  tipo: string | null;
  contenido: unknown;
  estado: string | null;
  wa_message_id: string | null;
};

export type FilaTurno = {
  conversacion_id: string;
  mensaje_entrada_id: string;
  modelo: string;
  uso: Uso;
  costo_usd: number;
  herramientas: Array<{ nombre: string; input: unknown; resultado: unknown; error: boolean }>;
  respuesta: string | null;
  /** `texto_derivacion`: revisión del texto que el modelo escribió junto con derivar_a_enrique (si hubo). */
  filtro: { intentos: Array<{ ok: boolean; motivos: string[] }>; texto_derivacion?: { ok: boolean; motivos: string[] } };
  regenerado: boolean;
  derivado: boolean;
  simulado: boolean;
  accion: string;
};

export type DepsOrquestador = {
  config(): Promise<ConfigTurno>;
  /** `perfil_vendedor`: jsonb de wa_conversaciones (migración 0011); null/ausente = sin perfil todavía. */
  conversacion(id: string): Promise<{ id: string; estado: string; cliente_id: string; turnos_ia: number; perfil_vendedor?: unknown } | null>;
  cliente(id: string): Promise<{ id: string; telefono: string | null; wa_user_id: string | null; nombre: string | null } | null>;
  /** Últimos `limite` mensajes de la conversación en orden cronológico. */
  historial(conversacionId: string, limite: number): Promise<FilaHistorial[]>;
  ultimoEntranteId(conversacionId: string): Promise<string | null>;
  gastoMesUsd(desdeISO: string): Promise<number>;
  /** Montos que devolvieron las herramientas en turnos anteriores de esta conversación. */
  preciosPrevios(conversacionId: string): Promise<number[]>;
  registrarTurno(fila: FilaTurno): Promise<void>;
  sumarTurno(conversacionId: string, costoUsd: number): Promise<void>;
  /** Guarda el perfil detectado (wa_conversaciones.perfil_vendedor). */
  guardarPerfil(conversacionId: string, perfil: PerfilCliente): Promise<void>;
  /** Azar en [0,1) para la variación del ritmo y las variantes fijas (tests: determinista). */
  aleatorio?: () => number;
  marcarLeidoYEscribiendo(waMessageId: string): Promise<unknown>;
  llamarModelo(p: PedidoClaude): Promise<RespuestaClaude>;
  dormir(ms: number): Promise<void>;
  ahora(): Date;
  herramientas: DepsHerramientas;
};

export type EntradaTurno = {
  conversacion_id: string;
  /** En un seguimiento es un id propio ("seguimiento:…"), no un wamid: no se marca leído. */
  wa_message_id: string;
  texto: string;
  /** "seguimiento": recontacto automático (seguimiento-chat). Ausente = mensaje del cliente. */
  origen?: "cliente" | "seguimiento";
};

/** Texto exacto de la entrada de un turno de seguimiento (contrato con el prompt). */
export function textoSeguimiento(numero: number): string {
  return `[seguimiento ${numero}]`;
}

export type ResultadoTurno = {
  accion: "respondido" | "derivado" | "terminal" | "agrupado" | "omitido" | "error_envio";
  motivo?: string;
  respuesta?: string | null;
  costo_usd?: number;
};

// ---------- piezas puras ----------

/** Historial de wa_mensajes → mensajes de la Messages API (empieza con user, termina con el mensaje actual). */
export function armarHistorial(filas: FilaHistorial[], entrada: EntradaTurno): Mensaje[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  let actualVisto = false;
  for (const f of filas) {
    if (f.direccion === "out" && f.estado === "fallido") continue;
    let t: string | null;
    if (f.direccion === "in") {
      if (f.wa_message_id && f.wa_message_id === entrada.wa_message_id) {
        t = entrada.texto;
        actualVisto = true;
      } else {
        const c = (f.contenido ?? {}) as Record<string, unknown>;
        t = f.texto ?? (typeof c.texto_vendedor === "string" ? c.texto_vendedor : null) ?? `[${f.tipo ?? "mensaje"}]`;
      }
    } else t = f.texto;
    if (!t?.trim()) continue;
    const role = f.direccion === "in" ? "user" : "assistant";
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.role === role) ultimo.content += `\n${t.trim()}`;
    else out.push({ role, content: t.trim() });
  }
  if (!actualVisto) {
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.role === "user") ultimo.content += `\n${entrada.texto}`;
    else out.push({ role: "user", content: entrada.texto });
  }
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: "(La conversación la empezó Voltra con un mensaje automático.)" });
  return out;
}

/**
 * Mensajes seguidos del cliente que todavía no tienen respuesta (desde nuestro último mensaje), en orden.
 * El mensaje actual se reemplaza por `entrada.texto` (puede venir transcripto) y se agrega si no está.
 */
export function bloquePendiente(filas: FilaHistorial[], entrada: EntradaTurno): string[] {
  const out: string[] = [];
  let actualVisto = false;
  for (let i = filas.length - 1; i >= 0; i--) {
    const f = filas[i];
    if (f.direccion === "out") {
      if (f.estado === "fallido") continue;
      break;
    }
    const c = (f.contenido ?? {}) as Record<string, unknown>;
    let t: string | null;
    if (f.wa_message_id && f.wa_message_id === entrada.wa_message_id) {
      actualVisto = true;
      t = entrada.texto;
    } else t = f.texto ?? (typeof c.texto_vendedor === "string" ? c.texto_vendedor : null) ?? `[${f.tipo ?? "mensaje"}]`;
    if (t?.trim()) out.unshift(t.trim());
  }
  if (!actualVisto) out.push(entrada.texto);
  return out;
}

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** Bloque variable del system (después del breakpoint de caché): fecha, hora y datos del cliente. */
export function contextoDinamico(ahora: Date, cli: { nombre: string | null; telefono: string | null }, perfil?: PerfilCliente): string {
  const p = partesAsuncion(ahora);
  const dia = DIAS[new Date(Date.UTC(p.anio, p.mes - 1, p.dia)).getUTCDay()];
  const hh = String(p.hora).padStart(2, "0"), mm = String(p.minuto).padStart(2, "0");
  return [
    `AHORA: ${dia} ${p.dia}/${p.mes}/${p.anio}, ${hh}:${mm} (hora de Asunción).`,
    `CLIENTE: ${cli.nombre ? `se llama ${cli.nombre} en WhatsApp` : "sin nombre en WhatsApp"}; ${cli.telefono ? "el chat tiene su teléfono" : "el chat NO tiene su teléfono (pedilo con pedir_telefono antes de cerrar)"}.`,
    ...(perfil ? [textoPerfil(perfil)] : []),
  ].join("\n");
}

export function inicioMesAsuncionISO(ahora: Date): string {
  const p = partesAsuncion(ahora);
  // Asunción es UTC−3 todo el año desde 2024; se usa el desfase real del instante por si cambia.
  const desfaseMs = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - Math.floor(ahora.getTime() / 1000) * 1000;
  return new Date(Date.UTC(p.anio, p.mes - 1, 1) - desfaseMs).toISOString();
}

function resumirResultado(r: unknown): unknown {
  const s = JSON.stringify(r);
  return s.length > 12000 ? { recortado: s.slice(0, 12000) } : r;
}

// ---------- turno ----------

/** Herramientas que no necesitan otra vuelta del modelo si vienen junto con el texto para el cliente. */
const HERRAMIENTAS_SILENCIOSAS = new Set(["registrar_perfil"]);

export async function procesarTurno(entrada: EntradaTurno, deps: DepsOrquestador): Promise<ResultadoTurno> {
  const inicio = deps.ahora().getTime();
  const conv0 = await deps.conversacion(entrada.conversacion_id);
  if (!conv0 || conv0.estado !== "ia") return { accion: "omitido", motivo: "conversacion_no_esta_en_ia" };
  const cfg = await deps.config();
  const v = cfg.vendedor;
  const azar = () => deps.aleatorio?.() ?? Math.random();
  const esSeguimiento = entrada.origen === "seguimiento";

  if (!esSeguimiento) await deps.marcarLeidoYEscribiendo(entrada.wa_message_id).catch(() => {});

  // Seguimiento: se anota el último mensaje del cliente para no mandar nada si escribe mientras tanto.
  let ultimoAlEmpezar: string | null = null;
  if (esSeguimiento) ultimoAlEmpezar = await deps.ultimoEntranteId(entrada.conversacion_id).catch(() => null);
  // Mensajes seguidos del cliente: se espera `espera_agrupar_s` de silencio; si llegó otro, responde el turno
  // del último (que ve todo junto).
  else if (v.espera_agrupar_s > 0) {
    await deps.dormir(v.espera_agrupar_s * 1000);
    const ultimo = await deps.ultimoEntranteId(entrada.conversacion_id);
    if (ultimo && ultimo !== entrada.wa_message_id) return { accion: "agrupado" };
  }
  const conv = await deps.conversacion(entrada.conversacion_id);
  if (!conv || conv.estado !== "ia") return { accion: "omitido", motivo: "conversacion_paso_a_humano" };
  const cli = await deps.cliente(conv.cliente_id);
  if (!cli) return { accion: "omitido", motivo: "cliente_inexistente" };

  const filasHistorial = await deps.historial(conv.id, v.historial_mensajes);
  const bloque = bloquePendiente(filasHistorial, entrada);
  const textoCliente = bloque.join("\n");
  const perfil0 = normalizarPerfil(conv.perfil_vendedor ?? conv0.perfil_vendedor);
  let perfil: PerfilCliente = { ...perfil0 };
  // "No me interesa", "no gracias"…: queda marcado y seguimiento-chat no le vuelve a escribir por su cuenta.
  if (!esSeguimiento && !perfil.rechazo && esRechazo(textoCliente)) perfil = { ...perfil, rechazo: true };
  const preguntaBot = !esSeguimiento && preguntaSiEsBot(textoCliente);

  const permitidos: number[] = [cfg.envio.costo_gs, ...(await deps.preciosPrevios(conv.id).catch(() => [] as number[]))];
  const opcionesFiltro = () => ({
    catalogo: permitidos,
    prohibidas: cfg.prohibidas,
    afirmaciones: cfg.afirmaciones,
    promesasSalud: cfg.promesasSalud,
    maxCaracteres: v.max_caracteres,
    muletillas: cfg.estilo.muletillas,
    urgencia: cfg.estilo.urgencia,
    niegaIA: cfg.estilo.niega_ia,
    preguntaBot,
    yaPreguntoFreno: !!perfil0.pregunto_freno,
  });
  const ctx: CtxTurno = {
    conversacionId: conv.id,
    clienteId: cli.id,
    destino: cli.telefono ?? cli.wa_user_id ?? "",
    telefono: cli.telefono,
    waUserId: cli.wa_user_id,
    nombreCliente: cli.nombre,
    textoEntrada: entrada.texto,
    mensajeEntradaId: entrada.wa_message_id,
    ahora: deps.ahora(),
    cfg,
    revisar: (t) => revisarRespuesta(t, opcionesFiltro()),
  };

  const fila: FilaTurno = {
    conversacion_id: conv.id,
    mensaje_entrada_id: entrada.wa_message_id,
    modelo: v.modelo,
    uso: { ...USO_CERO },
    costo_usd: 0,
    herramientas: [],
    respuesta: null,
    filtro: { intentos: [] },
    regenerado: false,
    derivado: false,
    simulado: false,
    accion: "",
  };

  const cerrar = async (r: ResultadoTurno, op: { contarTurno?: boolean } = {}): Promise<ResultadoTurno> => {
    fila.accion = (esSeguimiento ? (r.accion === "respondido" ? "seguimiento" : `seguimiento_${r.accion}`) : r.accion) +
      (r.motivo ? `:${r.motivo}` : "");
    fila.costo_usd = Math.round(fila.costo_usd * 1e8) / 1e8;
    const usadas = fila.herramientas.map((h) => h.nombre);
    const perfilFinal = fusionarPerfil(perfil, marcasDeRespuesta(fila.respuesta ?? "", usadas));
    try {
      await deps.registrarTurno(fila);
      if (op.contarTurno !== false) await deps.sumarTurno(conv.id, fila.costo_usd);
    } catch (e) {
      console.error("vendedor: no se pudo registrar el turno:", e);
    }
    if (!mismoPerfil(perfil0, perfilFinal)) {
      await deps.guardarPerfil(conv.id, perfilFinal).catch((e) => console.error("vendedor: no se pudo guardar el perfil:", e));
    }
    return { ...r, costo_usd: fila.costo_usd };
  };

  const derivar = async (motivo: MotivoDerivacion, resumen: string): Promise<ResultadoTurno> => {
    // Un recontacto automático nunca deriva: si algo falla, no se le manda nada al cliente (queda registrado).
    if (esSeguimiento) {
      console.warn(`vendedor: seguimiento sin enviar (${motivo}): ${resumen.slice(0, 200)}`);
      return await cerrar({ accion: "omitido", motivo: `sin_derivar:${motivo}` }, { contarTurno: fila.costo_usd > 0 });
    }
    fila.derivado = true;
    const r = await derivarAEnrique({ motivo, resumen }, ctx, deps.herramientas);
    fila.herramientas.push({ nombre: "derivar_a_enrique(sistema)", input: { motivo, resumen }, resultado: r.resultado, error: !!r.esError });
    return await cerrar({ accion: "derivado", motivo });
  };

  /** Espera con "escribiendo…" visible (WhatsApp lo apaga a los ~25 s: se renueva). */
  const esperarEscribiendo = async (ms: number) => {
    const paso = Math.max(1000, cfg.ritmo.renovar_escribiendo_s * 1000);
    let resta = ms;
    while (resta > 0) {
      if (!esSeguimiento) await deps.marcarLeidoYEscribiendo(entrada.wa_message_id).catch(() => {});
      const d = Math.min(resta, paso);
      await deps.dormir(d);
      resta -= d;
    }
  };

  /** Demora de leer + escribir (descontando lo que ya pasó), burbujas y envío. */
  const responder = async (texto: string, accionOk: ResultadoTurno["accion"], motivoOk?: string, op: { contarTurno?: boolean } = {}) => {
    const burbujas = partirEnBurbujas(texto, cfg.ritmo.partir_desde_caracteres);
    const objetivo = calcularDemoraMs({ textoCliente, textoRespuesta: burbujas[0] ?? texto, ahora: deps.ahora(), ritmo: cfg.ritmo, azar: azar() });
    const resta = objetivo - (deps.ahora().getTime() - inicio);
    // En un seguimiento no hay nadie esperando la respuesta: sale sin la demora de "leer + escribir".
    if (resta > 0 && !esSeguimiento) await esperarEscribiendo(resta);
    if (esSeguimiento) {
      // Si el cliente escribió mientras tanto, su mensaje tiene su propio turno: el seguimiento no sale.
      const ultimo = await deps.ultimoEntranteId(conv.id).catch(() => ultimoAlEmpezar);
      if (ultimo !== ultimoAlEmpezar) return await cerrar({ accion: "omitido", motivo: "cliente_escribio" }, op);
    } // Si mientras "escribía" el cliente mandó otro mensaje, responde ese turno con todo junto.
    else if (v.espera_agrupar_s > 0) {
      const ultimo = await deps.ultimoEntranteId(conv.id).catch(() => null);
      if (ultimo && ultimo !== entrada.wa_message_id) return await cerrar({ accion: "agrupado", motivo: "llego_otro_mensaje" }, op);
    }
    fila.respuesta = texto;
    for (let i = 0; i < burbujas.length; i++) {
      if (i > 0) await esperarEscribiendo(pausaBurbujaMs(burbujas[i], cfg.ritmo, azar()));
      const envio = await deps.herramientas.enviarTexto(ctx.destino, burbujas[i], { clienteId: cli.id, conversacionId: conv.id });
      if (!envio.ok) {
        // En un seguimiento avisa seguimiento-chat una sola vez por corrida (no por cada envío).
        if (!esSeguimiento) await deps.herramientas.avisar(`<b>El vendedor IA no pudo responder</b>\nError: ${envio.error ?? "desconocido"}\nConversación: ${conv.id}`);
        return await cerrar({ accion: "error_envio", motivo: envio.error, respuesta: texto }, op);
      }
    }
    return await cerrar({ accion: accionOk, motivo: motivoOk, respuesta: texto }, op);
  };

  // Respuestas fijas (sin modelo): sticker al empezar, "gracias" suelto, "ok" después del pedido.
  if (bloque.length === 1 && !esSeguimiento) {
    const pedidoChat = await deps.herramientas.ultimoPedidoChat(conv.id).catch(() => null);
    const nuestros = filasHistorial.filter((f) => f.direccion === "out" && f.estado !== "fallido" && (f.texto ?? "").trim());
    const tipo = tipoRespuestaFija(entrada.texto, { hayMensajesNuestros: nuestros.length > 0, estadoPedidoChat: pedidoChat?.estado ?? null });
    if (tipo) {
      fila.modelo = "fija";
      const texto = elegirVariante(tipo, cfg.respuestasFijas, nuestros.at(-1)?.texto ?? null, azar());
      if (texto === null) return await cerrar({ accion: "omitido", motivo: `fija_repetida:${tipo}` }, { contarTurno: false });
      const rev = revisarRespuesta(texto, opcionesFiltro());
      fila.filtro.intentos.push(rev);
      if (rev.ok) return await responder(texto, "respondido", `fija:${tipo}`, { contarTurno: false });
      console.warn(`vendedor: la respuesta fija ${tipo} no pasa el filtro (${rev.motivos.join(", ")}): uso el modelo`);
      fila.modelo = v.modelo;
      fila.filtro.intentos = [];
    }
  }

  // Topes (antes de gastar). Un seguimiento con un tope superado no hace nada (ni deriva ni registra).
  if (esSeguimiento && conv.turnos_ia >= v.max_turnos_conversacion) return { accion: "omitido", motivo: "tope_turnos", costo_usd: 0 };
  if (conv.turnos_ia >= v.max_turnos_conversacion) {
    return await derivar("tope_turnos", `La conversación llegó a ${conv.turnos_ia} turnos de IA sin cerrarse. Último mensaje: "${entrada.texto.slice(0, 200)}"`);
  }
  const gasto = await deps.gastoMesUsd(inicioMesAsuncionISO(ctx.ahora));
  if (gasto >= v.tope_mensual_usd) {
    if (esSeguimiento) return { accion: "omitido", motivo: "tope_gasto", costo_usd: 0 };
    return await derivar("tope_gasto", `Se alcanzó el tope mensual de IA (USD ${gasto.toFixed(2)} de ${v.tope_mensual_usd}). Último mensaje: "${entrada.texto.slice(0, 200)}"`);
  }

  // Prompt: bloque estable (cacheado 1 h) + bloque variable (fecha, cliente y perfil).
  let productos: Awaited<ReturnType<typeof catalogo>> = [];
  try {
    productos = await catalogo(deps.herramientas, ctx);
  } catch (e) {
    console.warn("vendedor: catálogo no disponible para las fichas:", e instanceof Error ? e.message : e);
  }
  const promptBase = armarPrompt({
    glosario: cfg.glosario,
    fichas: productos.map((p) => ({ handle: p.handle, titulo: p.title, ...(cfg.fichas[p.handle] ?? {}) })),
    envio: cfg.envio,
    afirmaciones: cfg.afirmaciones,
    aceptaciones: cfg.aceptaciones,
  }, cfg.plantillaPrompt ?? undefined);
  const system: BloqueTexto[] = [
    { type: "text", text: promptBase },
    { type: "text", text: contextoDinamico(ctx.ahora, cli, perfil0) },
  ];
  const mensajes: Mensaje[] = armarHistorial(filasHistorial, entrada);

  const pedido = (msgs: Mensaje[]): PedidoClaude => ({
    modelo: v.modelo,
    system,
    mensajes: msgs,
    herramientas: HERRAMIENTAS,
    maxTokens: v.max_tokens,
    cache: true,
    ttlCache: v.cache_ttl,
    esfuerzo: v.esfuerzo ?? undefined,
    fallbackServidor: v.fallback_servidor,
  });
  const llamar = async (msgs: Mensaje[]): Promise<RespuestaClaude> => {
    const r = await deps.llamarModelo(pedido(msgs));
    fila.uso = sumarUso(fila.uso, r.uso);
    fila.costo_usd += r.costo_usd;
    fila.simulado = fila.simulado || r.simulado;
    fila.modelo = r.modelo || fila.modelo;
    return r;
  };
  /** registrar_perfil: se fusiona en el perfil del turno y queda en el registro (sin otra vuelta del modelo). */
  const anotarSilenciosas = (contenido: Bloque[]) => {
    for (const u of usosDeHerramientas(contenido).filter((x) => HERRAMIENTAS_SILENCIOSAS.has(x.name))) {
      const nuevo = normalizarPerfil(u.input, "modelo");
      perfil = fusionarPerfil(perfil, nuevo);
      fila.herramientas.push({ nombre: u.name, input: u.input, resultado: { ok: true, perfil: nuevo }, error: false });
    }
  };
  /** Solo herramientas silenciosas + texto: el texto es la respuesta final. */
  const soloSilenciosasConTexto = (contenido: Bloque[]) => {
    const usos = usosDeHerramientas(contenido);
    return usos.length > 0 && usos.every((u) => HERRAMIENTAS_SILENCIOSAS.has(u.name)) && !!textoDe(contenido).trim();
  };
  const sinHerramientas = (contenido: Bloque[]): Bloque[] => contenido.filter((b) => b.type !== "tool_use");

  // Bucle de herramientas.
  let textoFinal: string | null = null;
  try {
    for (let vuelta = 0; vuelta < v.max_iteraciones; vuelta++) {
      const r = await llamar(mensajes);
      if (r.stop_reason === "refusal") {
        return await derivar("falla_ia", `El modelo se negó a responder. Mensaje del cliente: "${entrada.texto.slice(0, 200)}"`);
      }
      const usos = usosDeHerramientas(r.contenido);
      if (!usos.length || soloSilenciosasConTexto(r.contenido)) {
        anotarSilenciosas(r.contenido);
        textoFinal = textoDe(r.contenido);
        mensajes.push({ role: "assistant", content: sinHerramientas(r.contenido) });
        break;
      }
      // Se devuelve el contenido completo (incluye bloques thinking en Sonnet 5.5), sin tocarlo.
      mensajes.push({ role: "assistant", content: r.contenido });
      // Texto que acompaña a las herramientas: solo se usa en la derivación (va arriba del botón para hablar
      // con Enrique, p. ej. "Eso te conviene consultarlo con tu médico."). Pasa por el mismo filtro que
      // cualquier respuesta; si no pasa, no se manda (sin regenerar: la derivación sale igual).
      const textoAcompana = textoDe(r.contenido).trim();
      const resultados: BloqueToolResult[] = [];
      let terminal = false;
      let derivadoPorHerramienta = false;
      for (const u of usos) {
        if (terminal) {
          resultados.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ ok: false, error: "omitida: ya se le respondió al cliente" }), is_error: true });
          continue;
        }
        if (HERRAMIENTAS_SILENCIOSAS.has(u.name)) {
          anotarSilenciosas([u]);
          resultados.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ ok: true }) });
          continue;
        }
        let textoModelo: string | null = null;
        if (u.name === "derivar_a_enrique" && textoAcompana) {
          const revDer = revisarRespuesta(textoAcompana, opcionesFiltro());
          fila.filtro.texto_derivacion = revDer;
          if (revDer.ok) textoModelo = textoAcompana;
        }
        const res = await ejecutarHerramienta(u.name, u.input ?? {}, ctx, deps.herramientas, { textoModelo });
        if (u.name === "derivar_a_enrique" && typeof res.resultado.texto_cliente === "string") fila.respuesta = res.resultado.texto_cliente;
        permitidos.push(...montosDeResultado(res.resultado));
        fila.herramientas.push({ nombre: u.name, input: u.input, resultado: resumirResultado(res.resultado), error: !!res.esError });
        resultados.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(res.resultado), ...(res.esError ? { is_error: true } : {}) });
        if (res.terminal) terminal = true;
        if (res.derivado) derivadoPorHerramienta = true;
      }
      if (terminal) {
        fila.derivado = derivadoPorHerramienta;
        return await cerrar({ accion: derivadoPorHerramienta ? "derivado" : "terminal", motivo: derivadoPorHerramienta ? "herramienta" : undefined });
      }
      mensajes.push({ role: "user", content: resultados as Bloque[] });
    }
  } catch (e) {
    const msg = e instanceof ErrorClaude || e instanceof Error ? e.message : String(e);
    console.error("vendedor: falla del modelo:", msg);
    return await derivar("falla_ia", `La IA no pudo responder (${msg.slice(0, 120)}). Último mensaje del cliente: "${entrada.texto.slice(0, 200)}"`);
  }
  if (textoFinal === null) {
    return await derivar("falla_ia", `La IA usó ${v.max_iteraciones} vueltas de herramientas sin responder. Último mensaje: "${entrada.texto.slice(0, 200)}"`);
  }

  // Filtro de salida + una regeneración.
  let rev = revisarRespuesta(textoFinal, opcionesFiltro());
  fila.filtro.intentos.push(rev);
  if (!rev.ok) {
    fila.regenerado = true;
    const intento: Mensaje[] = [
      ...mensajes,
      {
        role: "user",
        content:
          `[CONTROL INTERNO, no lo ve el cliente] Tu respuesta anterior se bloqueó por: ${rev.motivos.join(", ")}. ` +
          `Escribí otra que cumpla las reglas: 1 a 3 líneas, la primera con la respuesta o un beneficio (no un saludo solo), una sola pregunta al final, ` +
          `máximo 1 emoji, sin frases de bot ("¡Claro!", "No dudes en", "¿En qué puedo ayudarte?"), sin markdown ni viñetas, sin urgencia inventada, ` +
          `solo precios de consultar_catalogo, sin palabras prohibidas ni promesas de salud` +
          (preguntaBot ? `, y decí que sos el asistente virtual de Voltra (sin decir que sos una persona)` : "") +
          `. Respondé solo con el texto para el cliente.`,
      },
    ];
    try {
      const r2 = await llamar(intento);
      const usos2 = usosDeHerramientas(r2.contenido);
      if (!usos2.length || soloSilenciosasConTexto(r2.contenido)) {
        anotarSilenciosas(r2.contenido);
        textoFinal = textoDe(r2.contenido);
      } else textoFinal = "";
    } catch (e) {
      return await derivar("falla_ia", `La IA falló al regenerar (${e instanceof Error ? e.message.slice(0, 120) : e}).`);
    }
    rev = revisarRespuesta(textoFinal, opcionesFiltro());
    fila.filtro.intentos.push(rev);
    if (!rev.ok) {
      return await derivar("filtro", `La respuesta de la IA no pasó el filtro dos veces (${rev.motivos.join(", ")}). Mensaje del cliente: "${entrada.texto.slice(0, 200)}"`);
    }
  }

  return await responder(textoFinal, "respondido");
}
