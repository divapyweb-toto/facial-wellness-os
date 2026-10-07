// auditoria-diaria/auditoria.ts · Dueño: G3
// Flujo de la auditoría con dependencias inyectadas (los tests pasan falsas; index.ts las reales).
//
// Cada llamada (cron 7:30 y reintentos hasta las 10:50, hora de Asunción):
//  1. Si el día anterior ya se informó → no hace nada.
//  2. Lee los mensajes del día anterior y aplica las reglas deterministas.
//  3. Haiku por Batch API: si hay un lote pendiente de ese día lo consulta; si no, lo crea y espera
//     un rato. Si no terminó, guarda el lote y sale (el próximo cron lo levanta). Pasadas
//     `espera_lote_h` horas, o si el lote falla, sigue solo con las reglas.
//  4. Manda a Telegram SOLO si hay conversaciones con algo raro. Marca el día como informado.
import {
  armarAviso,
  type CfgAuditoria,
  combinar,
  type ConvInfo,
  customId,
  evaluarConversacion,
  interpretarVeredicto,
  leerCfgAuditoria,
  type MensajeAud,
  type PedidoCliente,
  type PedidoLoteAud,
  pedidosParaLote,
  rangoDeFecha,
  rangoDiaAnterior,
  type TurnoVend,
  type VeredictoHaiku,
} from "./logica.ts";

export interface EstadoLoteAud {
  id: string;
  estado: "in_progress" | "canceling" | "ended";
  resultados?: { custom_id: string; tipo: string; texto: string; costo_usd: number }[];
  simulado: boolean;
}

export interface EstadoAuditoria {
  fecha: string;
  estado: "pendiente" | "enviado";
  lote_id?: string | null;
  iniciado_en?: string;
  revisadas?: number;
  raras?: number;
  costo_usd?: number;
}

export interface DepsAuditoria {
  ahora: () => Date;
  config: (clave: string) => Promise<unknown>;
  guardarConfig: (clave: string, valor: unknown) => Promise<void>;
  mensajesEntre: (desdeISO: string, hastaISO: string) => Promise<MensajeAud[]>;
  conversaciones: (ids: string[]) => Promise<ConvInfo[]>;
  /** vendedor_turnos de esas conversaciones; [] si la tabla todavía no existe. */
  turnosVendedor: (ids: string[]) => Promise<TurnoVend[]>;
  /** Pedidos de esos clientes creados en [desde, hasta) (se piden los últimos 60 días: sus totales son montos válidos). */
  pedidosDeClientes: (clienteIds: string[], desdeISO: string, hastaISO: string) => Promise<PedidoCliente[]>;
  crearLote: (pedidos: PedidoLoteAud[]) => Promise<EstadoLoteAud>;
  consultarLote: (id: string) => Promise<EstadoLoteAud>;
  avisar: (textoHtml: string) => Promise<{ ok: boolean; error?: string }>;
  log?: (...a: unknown[]) => void;
}

export interface OpcionesAuditoria {
  /** 'YYYY-MM-DD': reprocesar ese día (en lugar del anterior). */
  fecha?: string;
  /** Volver a mandar aunque ya se haya informado. */
  reenviar?: boolean;
}

export interface ResultadoAuditoria {
  fecha: string;
  accion: "ya_informado" | "sin_conversaciones" | "esperando_lote" | "sin_novedades" | "avisado";
  revisadas: number;
  raras: number;
  lote?: string | null;
  notas: string[];
  costo_usd: number;
}

const CLAVE_ESTADO = "auditoria_estado";
const HORA = 3_600_000;

export async function ejecutarAuditoria(deps: DepsAuditoria, op: OpcionesAuditoria = {}): Promise<ResultadoAuditoria> {
  const log = deps.log ?? console.log;
  const ahora = deps.ahora();
  const rango = op.fecha ? rangoDeFecha(op.fecha) : rangoDiaAnterior(ahora);
  const estadoPrevio = (await deps.config(CLAVE_ESTADO)) as EstadoAuditoria | null;
  const mismoDia = estadoPrevio?.fecha === rango.fecha;
  const base = { fecha: rango.fecha, revisadas: 0, raras: 0, notas: [] as string[], costo_usd: 0 };

  if (mismoDia && estadoPrevio?.estado === "enviado" && !op.reenviar) {
    return { ...base, accion: "ya_informado", revisadas: estadoPrevio.revisadas ?? 0, raras: estadoPrevio.raras ?? 0 };
  }

  const [cfgV, prohibidasV] = await Promise.all([deps.config("auditoria"), deps.config("palabras_prohibidas")]);
  const { cfg, faltantes } = leerCfgAuditoria(cfgV, prohibidasV);
  if (faltantes.length) log(`auditoria-diaria: config_wa sin ${faltantes.join(", ")}; uso valores por defecto`);

  // ---- datos del día
  const mensajes = await deps.mensajesEntre(rango.desde.toISOString(), rango.hasta.toISOString());
  const porConv = new Map<string, MensajeAud[]>();
  for (const m of mensajes) {
    if (!porConv.has(m.conversacion_id)) porConv.set(m.conversacion_id, []);
    porConv.get(m.conversacion_id)!.push(m);
  }
  const ids = [...porConv.keys()];
  if (!ids.length) {
    await deps.guardarConfig(CLAVE_ESTADO, { fecha: rango.fecha, estado: "enviado", revisadas: 0, raras: 0 } satisfies EstadoAuditoria);
    return { ...base, accion: "sin_conversaciones" };
  }
  const convs = await deps.conversaciones(ids);
  const convPorId = new Map(convs.map((c) => [c.id, c]));
  const turnos = await deps.turnosVendedor(ids);
  const clienteIds = [...new Set(convs.map((c) => c.cliente_id).filter((x): x is string => !!x))];
  const pedidos = clienteIds.length
    ? await deps.pedidosDeClientes(clienteIds, new Date(rango.desde.getTime() - 60 * 24 * HORA).toISOString(), rango.hasta.toISOString())
    : [];

  const evs = ids.map((id) => {
    const conv = convPorId.get(id) ?? { id, estado: null, cliente_id: porConv.get(id)![0]?.cliente_id ?? null, nombre: null, telefono: null, wa_username: null };
    return evaluarConversacion(
      conv,
      porConv.get(id)!,
      turnos.filter((t) => t.conversacion_id === id),
      pedidos.filter((p) => p.cliente_id && p.cliente_id === conv.cliente_id),
      cfg,
    );
  });

  // ---- Haiku por lote
  const notas: string[] = [];
  let veredictos: Map<string, VeredictoHaiku | null> | null = null;
  let costo = 0;
  let loteId: string | null = null;
  const pedidosLote = pedidosParaLote(evs, cfg.modelo);
  if (pedidosLote.length) {
    try {
      let lote: EstadoLoteAud;
      if (mismoDia && estadoPrevio?.estado === "pendiente" && estadoPrevio.lote_id) {
        lote = await deps.consultarLote(estadoPrevio.lote_id);
      } else {
        lote = await deps.crearLote(pedidosLote);
      }
      loteId = lote.id;
      if (lote.estado === "ended") {
        veredictos = new Map();
        for (const r of lote.resultados ?? []) {
          veredictos.set(r.custom_id, r.tipo === "succeeded" ? interpretarVeredicto(r.texto) : null);
          costo += r.costo_usd ?? 0;
        }
        if (lote.simulado) notas.push("Revisión con Haiku en modo simulado (sin ANTHROPIC_API_KEY o MODO_SIMULADO=1).");
      } else {
        const iniciado = mismoDia && estadoPrevio?.iniciado_en ? estadoPrevio.iniciado_en : ahora.toISOString();
        if (ahora.getTime() - new Date(iniciado).getTime() < cfg.espera_lote_h * HORA) {
          await deps.guardarConfig(CLAVE_ESTADO, {
            fecha: rango.fecha,
            estado: "pendiente",
            lote_id: lote.id,
            iniciado_en: iniciado,
          } satisfies EstadoAuditoria);
          return { ...base, accion: "esperando_lote", revisadas: evs.length, lote: lote.id };
        }
        notas.push(`La revisión con Haiku no terminó en ${cfg.espera_lote_h} h: este aviso usa solo las reglas.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("auditoria-diaria: lote falló:", msg);
      notas.push(`La revisión con Haiku falló (${msg.slice(0, 120)}): este aviso usa solo las reglas.`);
    }
  }

  // ---- combinar y avisar
  const finales = evs.map((ev) => combinar(ev, veredictos?.get(customId(ev.conv.id)) ?? null));
  const raras = finales.filter((f) => f.senales.length > 0);
  const resultado: ResultadoAuditoria = {
    ...base,
    accion: raras.length ? "avisado" : "sin_novedades",
    revisadas: finales.length,
    raras: raras.length,
    lote: loteId,
    notas,
    costo_usd: costo,
  };
  if (raras.length) {
    const r = await deps.avisar(armarAviso(rango.fecha, finales.length, raras, cfg as CfgAuditoria, notas));
    // Sin aviso no se marca como informado: el próximo cron lo reintenta.
    if (!r.ok) throw new Error(`Telegram: ${r.error ?? "falló"}`);
  }
  await deps.guardarConfig(CLAVE_ESTADO, {
    fecha: rango.fecha,
    estado: "enviado",
    lote_id: loteId,
    revisadas: finales.length,
    raras: raras.length,
    costo_usd: costo,
  } satisfies EstadoAuditoria);
  return resultado;
}
