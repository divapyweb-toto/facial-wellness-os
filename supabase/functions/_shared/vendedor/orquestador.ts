// _shared/vendedor/orquestador.ts · Dueño: G1 (ola 2)
// Un turno del vendedor con IA: arma el historial, llama al modelo con herramientas en bucle (con límite de
// vueltas), aplica el filtro de salida, regenera una vez con el motivo y, si vuelve a fallar, si la API falla
// o si se pasa el tope de gasto o de turnos, deriva a Enrique. El texto que el modelo escribe junto con
// derivar_a_enrique pasa por el filtro y va arriba del botón (en salud, antecedido por la frase del médico). Respeta el ritmo humano: marca leído, muestra
// "escribiendo…" y responde a los 2 a 6 s según el largo. Registra vendedor_turnos y el costo en la conversación.
// Sin I/O propio: todo entra por `DepsOrquestador` (io.ts en producción).
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
import { armarPrompt } from "./prompt.ts";
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
  conversacion(id: string): Promise<{ id: string; estado: string; cliente_id: string; turnos_ia: number } | null>;
  cliente(id: string): Promise<{ id: string; telefono: string | null; wa_user_id: string | null; nombre: string | null } | null>;
  /** Últimos `limite` mensajes de la conversación en orden cronológico. */
  historial(conversacionId: string, limite: number): Promise<FilaHistorial[]>;
  ultimoEntranteId(conversacionId: string): Promise<string | null>;
  gastoMesUsd(desdeISO: string): Promise<number>;
  /** Montos que devolvieron las herramientas en turnos anteriores de esta conversación. */
  preciosPrevios(conversacionId: string): Promise<number[]>;
  registrarTurno(fila: FilaTurno): Promise<void>;
  sumarTurno(conversacionId: string, costoUsd: number): Promise<void>;
  marcarLeidoYEscribiendo(waMessageId: string): Promise<unknown>;
  llamarModelo(p: PedidoClaude): Promise<RespuestaClaude>;
  dormir(ms: number): Promise<void>;
  ahora(): Date;
  herramientas: DepsHerramientas;
};

export type EntradaTurno = { conversacion_id: string; wa_message_id: string; texto: string };

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

/** Segundos de demora según el largo: de `min` (texto corto) a `max` (≥ 300 caracteres). */
export function demoraSegundos(texto: string, min: number, max: number): number {
  const f = Math.min(1, (texto?.length ?? 0) / 300);
  return Math.round((min + (max - min) * f) * 10) / 10;
}

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** Bloque variable del system (después del breakpoint de caché): fecha, hora y datos del cliente. */
export function contextoDinamico(ahora: Date, cli: { nombre: string | null; telefono: string | null }): string {
  const p = partesAsuncion(ahora);
  const dia = DIAS[new Date(Date.UTC(p.anio, p.mes - 1, p.dia)).getUTCDay()];
  const hh = String(p.hora).padStart(2, "0"), mm = String(p.minuto).padStart(2, "0");
  return [
    `AHORA: ${dia} ${p.dia}/${p.mes}/${p.anio}, ${hh}:${mm} (hora de Asunción).`,
    `CLIENTE: ${cli.nombre ? `se llama ${cli.nombre} en WhatsApp` : "sin nombre en WhatsApp"}; ${cli.telefono ? "el chat tiene su teléfono" : "el chat NO tiene su teléfono (pedilo con pedir_telefono antes de cerrar)"}.`,
  ].join("\n");
}

function inicioMesAsuncionISO(ahora: Date): string {
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

export async function procesarTurno(entrada: EntradaTurno, deps: DepsOrquestador): Promise<ResultadoTurno> {
  const conv0 = await deps.conversacion(entrada.conversacion_id);
  if (!conv0 || conv0.estado !== "ia") return { accion: "omitido", motivo: "conversacion_no_esta_en_ia" };
  const cfg = await deps.config();
  const v = cfg.vendedor;

  await deps.marcarLeidoYEscribiendo(entrada.wa_message_id).catch(() => {});

  // Mensajes seguidos del cliente: responde solo el turno del último (que ve todo el historial).
  if (v.espera_agrupar_s > 0) {
    await deps.dormir(v.espera_agrupar_s * 1000);
    const ultimo = await deps.ultimoEntranteId(entrada.conversacion_id);
    if (ultimo && ultimo !== entrada.wa_message_id) return { accion: "agrupado" };
  }
  const conv = await deps.conversacion(entrada.conversacion_id);
  if (!conv || conv.estado !== "ia") return { accion: "omitido", motivo: "conversacion_paso_a_humano" };
  const cli = await deps.cliente(conv.cliente_id);
  if (!cli) return { accion: "omitido", motivo: "cliente_inexistente" };

  const inicio = deps.ahora().getTime();
  const permitidos: number[] = [cfg.envio.costo_gs, ...(await deps.preciosPrevios(conv.id).catch(() => [] as number[]))];
  const opcionesFiltro = () => ({
    catalogo: permitidos,
    prohibidas: cfg.prohibidas,
    afirmaciones: cfg.afirmaciones,
    promesasSalud: cfg.promesasSalud,
    maxCaracteres: v.max_caracteres,
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

  const cerrar = async (r: ResultadoTurno): Promise<ResultadoTurno> => {
    fila.accion = r.accion + (r.motivo ? `:${r.motivo}` : "");
    fila.costo_usd = Math.round(fila.costo_usd * 1e8) / 1e8;
    try {
      await deps.registrarTurno(fila);
      await deps.sumarTurno(conv.id, fila.costo_usd);
    } catch (e) {
      console.error("vendedor: no se pudo registrar el turno:", e);
    }
    return { ...r, costo_usd: fila.costo_usd };
  };

  const derivar = async (motivo: MotivoDerivacion, resumen: string): Promise<ResultadoTurno> => {
    fila.derivado = true;
    const r = await derivarAEnrique({ motivo, resumen }, ctx, deps.herramientas);
    fila.herramientas.push({ nombre: "derivar_a_enrique(sistema)", input: { motivo, resumen }, resultado: r.resultado, error: !!r.esError });
    return await cerrar({ accion: "derivado", motivo });
  };

  // Topes (antes de gastar).
  if (conv.turnos_ia >= v.max_turnos_conversacion) {
    return await derivar("tope_turnos", `La conversación llegó a ${conv.turnos_ia} turnos de IA sin cerrarse. Último mensaje: "${entrada.texto.slice(0, 200)}"`);
  }
  const gasto = await deps.gastoMesUsd(inicioMesAsuncionISO(ctx.ahora));
  if (gasto >= v.tope_mensual_usd) {
    return await derivar("tope_gasto", `Se alcanzó el tope mensual de IA (USD ${gasto.toFixed(2)} de ${v.tope_mensual_usd}). Último mensaje: "${entrada.texto.slice(0, 200)}"`);
  }

  // Prompt: bloque estable (cacheado 1 h) + bloque variable.
  let productos: Awaited<ReturnType<typeof catalogo>> = [];
  try {
    productos = await catalogo(deps.herramientas, ctx);
  } catch (e) {
    console.warn("vendedor: catálogo no disponible para las fichas:", e instanceof Error ? e.message : e);
  }
  const promptBase = armarPrompt({
    glosario: cfg.glosario,
    fichas: productos.map((p) => ({ handle: p.handle, titulo: p.title, ficha: cfg.fichas[p.handle]?.ficha, consejo_uso: cfg.fichas[p.handle]?.consejo_uso })),
    envio: cfg.envio,
    afirmaciones: cfg.afirmaciones,
    aceptaciones: cfg.aceptaciones,
  }, cfg.plantillaPrompt ?? undefined);
  const system: BloqueTexto[] = [
    { type: "text", text: promptBase },
    { type: "text", text: contextoDinamico(ctx.ahora, cli) },
  ];
  const mensajes: Mensaje[] = armarHistorial(await deps.historial(conv.id, v.historial_mensajes), entrada);

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

  // Bucle de herramientas.
  let textoFinal: string | null = null;
  try {
    for (let vuelta = 0; vuelta < v.max_iteraciones; vuelta++) {
      const r = await llamar(mensajes);
      if (r.stop_reason === "refusal") {
        return await derivar("falla_ia", `El modelo se negó a responder. Mensaje del cliente: "${entrada.texto.slice(0, 200)}"`);
      }
      const usos = usosDeHerramientas(r.contenido);
      if (!usos.length) {
        textoFinal = textoDe(r.contenido);
        mensajes.push({ role: "assistant", content: r.contenido });
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
          `Escribí otra que cumpla las reglas (1 a 3 líneas, una pregunta, máximo 1 emoji, solo precios de consultar_catalogo, sin palabras prohibidas ni promesas de salud). Respondé solo con el texto para el cliente.`,
      },
    ];
    try {
      const r2 = await llamar(intento);
      textoFinal = usosDeHerramientas(r2.contenido).length ? "" : textoDe(r2.contenido);
    } catch (e) {
      return await derivar("falla_ia", `La IA falló al regenerar (${e instanceof Error ? e.message.slice(0, 120) : e}).`);
    }
    rev = revisarRespuesta(textoFinal, opcionesFiltro());
    fila.filtro.intentos.push(rev);
    if (!rev.ok) {
      return await derivar("filtro", `La respuesta de la IA no pasó el filtro dos veces (${rev.motivos.join(", ")}). Mensaje del cliente: "${entrada.texto.slice(0, 200)}"`);
    }
  }

  // Ritmo humano: demora proporcional al largo, descontando lo que ya tardó el modelo.
  const objetivoMs = demoraSegundos(textoFinal, v.demora_min_s, v.demora_max_s) * 1000;
  const yaPaso = deps.ahora().getTime() - inicio;
  if (objetivoMs > yaPaso) {
    await deps.marcarLeidoYEscribiendo(entrada.wa_message_id).catch(() => {});
    await deps.dormir(objetivoMs - yaPaso);
  }
  fila.respuesta = textoFinal;
  const envio = await deps.herramientas.enviarTexto(ctx.destino, textoFinal, { clienteId: cli.id, conversacionId: conv.id });
  if (!envio.ok) {
    await deps.herramientas.avisar(`<b>El vendedor IA no pudo responder</b>\nError: ${envio.error ?? "desconocido"}\nConversación: ${conv.id}`);
    return await cerrar({ accion: "error_envio", motivo: envio.error, respuesta: textoFinal });
  }
  return await cerrar({ accion: "respondido", respuesta: textoFinal });
}

