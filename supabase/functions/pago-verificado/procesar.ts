// pago-verificado/procesar.ts · 27-10. Núcleo con dependencias inyectadas (index.ts las conecta; las pruebas usan dobles).
// Orden: interruptor → datos → pedido → decidir (monto exacto + coincidencia) → reservar el n.º de transacción (único)
// → el MISMO "Recibido" del Telegram (procesarCallback pagado:<id>, con su candado accion:pagado:<id>).
// Si "Recibido" falla, se libera el n.º de transacción para poder reintentar. Nunca se marca dos veces.
// 29-10 (factura al cobrar): marcado el pago → facturarAlCobrar (factura ya si el pago quedó COMPLETO; con saldo
// pendiente la cola responde no_facturable y se factura al entregar). Idempotente y sin excepción: si falla, la cola
// de 10 min lo toma por pagado_en. Telegram "Recibido" (agente C) también lo llama: dos llamadas = una sola factura.
// 29-10 (agente F) · MODO SIN PEDIDO: {monto, fecha, nro_transaccion?, titular?, banco?, origen?, prueba?} sin `pedido`.
// La tarea programada pasa el aviso de ueno tal cual y acá se elige el pedido: rendición de courier → se ignora;
// transferencia ya asociada (pagos_verificados o botón "Es este") → nada; candidatos (vista pagos_candidatos + teléfono,
// nombres, ciudad y comprobantes de WhatsApp con lo leído) → rankearCandidatos. Un único pedido seguro → el mismo
// camino de siempre (decidir + reservar + "Recibido"). Ambiguo o sin pedido → aviso a Enrique (pago_ambiguo, una vez por
// día y transferencia) con los 3 más probables y "Es este". Sin nro. en el aviso, la reserva usa SN-<hora>-<monto>.
import { decidir, type Decision, nombrePedido, type PedidoPago } from "./logica.ts";
import {
  avisoCandidatos,
  avisoSinCandidatos,
  type BotonesAviso,
  type CandidatoPago,
  esRendicionCourier,
  rankearCandidatos,
  refTransferencia,
  type SenalPago,
  type TransferenciaRecibida,
} from "../_shared/pagos_ranking.ts";

export interface Entrada {
  /** Sin pedido → modo sin pedido (lo elige el ranking). */
  pedido?: string | null;
  monto: number;
  /** Obligatorio con pedido; opcional sin pedido (los avisos desde otros bancos no lo traen). */
  nro_transaccion?: string | null;
  /** Modo sin pedido: hora de la transferencia (ISO, con zona). */
  fecha?: string | null;
  banco?: string | null;
  origen?: string;
  /** Titular que debita (aviso de ueno): solo para comparar con el cliente. */
  titular?: string | null;
  /** true: dice qué haría, sin reservar ni marcar nada. */
  prueba?: boolean;
}

export interface ResultadoRecibido { tipo: string; notas?: string[]; error?: string }

export interface DepsPago {
  activo(): Promise<boolean>;
  leerPedido(nombre: string): Promise<PedidoPago | null>;
  /** Inserta en pagos_verificados; false si ese n.º de transacción ya estaba. */
  reservarTransaccion(fila: { nro_transaccion: string; shopify_order_id: number; pedido: string; monto: number; origen: string; motivo: string; coincidencia: string }): Promise<boolean>;
  liberarTransaccion(nro: string): Promise<void>;
  guardarResultado(nro: string, resultado: Record<string, unknown>): Promise<void>;
  /** procesarCallback("pagado:<id>") del telegram-webhook. */
  marcarRecibido(shopifyOrderId: number, nro: string): Promise<ResultadoRecibido>;
  registrarAdmin(texto: string, pedido: string): Promise<void>;
  /** factura/io.ts facturarAlCobrar (opcional en pruebas). No tira excepción. */
  facturarAlCobrar?(shopifyOrderId: number): Promise<{ accion: string; error?: string }>;
  // ---- modo sin pedido (29-10) ----
  /** Pedidos que esperan ese monto, con teléfono, nombres, ciudad y comprobantes de WhatsApp (solo para comparar). */
  candidatos?(monto: number, fechaISO: string): Promise<CandidatoPago[]>;
  /** ¿La transferencia ya se usó? (pagos_verificados con esa clave, o "Es este" con esa ref). */
  transferenciaYaAsociada?(clave: string, ref: string): Promise<boolean>;
  /** Aviso a Enrique (HTML ya escapado), una vez por día y `clave`. true si salió (o ya había salido hoy). */
  avisarEnrique?(texto: string, botones: BotonesAviso, clave: string): Promise<boolean>;
  /** Titulares extra a ignorar (config pago_auto_gmail.ignorar_titulares), además de los couriers. */
  titularesIgnorar?(): Promise<string[]>;
  ahora?(): Date;
}

export type Salida =
  | { ok: true; prueba: true; pedido: string; motivo: string; pendiente: number; coincidencia: string; haria: string; senales?: SenalPago[] }
  | { ok: true; prueba?: false; pedido: string; motivo: string; monto: number; coincidencia: string; resultado: string; notas: string[]; senales?: SenalPago[] }
  | {
    ok: false; error: string; detalle?: string; pendiente?: number; pedido?: string;
    /** Modo sin pedido: no hay que avisar ni reintentar (rendición de courier, ya asociada). */
    ignorar?: boolean;
    /** Modo sin pedido: true si ya se avisó a Enrique (o se habría avisado, en prueba). */
    avisado?: boolean;
    total?: number;
    candidatos?: string[];
    aviso?: string;
  };

export async function procesarPago(e: Entrada, d: DepsPago): Promise<Salida> {
  if (e.pedido == null || String(e.pedido).trim() === "") return procesarSinPedido(e, d);
  const prueba = e.prueba === true;
  if (!prueba && !(await d.activo())) return { ok: false, error: "apagado", detalle: "config pago_auto_gmail.activo = false (lo prende Enrique)" };
  const nombre = nombrePedido(String(e.pedido));
  const monto = Number(e.monto);
  const nro = String(e.nro_transaccion ?? "").trim();
  if (!nombre) return { ok: false, error: "datos_invalidos", detalle: `pedido "${e.pedido}" (usar #1135 o VT-1135)` };
  if (!Number.isFinite(monto) || monto <= 0 || Math.round(monto) !== monto) return { ok: false, error: "datos_invalidos", detalle: "monto en guaraníes, entero y mayor a 0" };
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(nro)) return { ok: false, error: "datos_invalidos", detalle: "nro_transaccion de 3 a 100 caracteres (letras, números, . _ -)" };

  const p = await d.leerPedido(nombre);
  if (!p) return { ok: false, error: "pedido_inexistente", pedido: nombre };
  const dec: Decision = decidir(p, monto, e.titular);
  if (!dec.ok) return { ok: false, error: dec.error, detalle: dec.detalle, pendiente: dec.pendiente, pedido: nombre };
  if (prueba) {
    return { ok: true, prueba: true, pedido: nombre, motivo: dec.motivo, pendiente: dec.pendiente, coincidencia: dec.coincidencia, haria: "marcar como \"Recibido\": PAGADO + PAGO_VERIFICADO + PRIORIDAD, texto al cliente y texto al courier si ya salió" };
  }

  return await marcar(d, { nombre, p, dec, nro, monto, origen: e.origen ?? "gmail_ueno" });
}

/** Reserva el n.º de transacción y hace el MISMO "Recibido" (+ factura al cobrar). Común a los dos modos. */
async function marcar(
  d: DepsPago,
  x: { nombre: string; p: PedidoPago; dec: Extract<Decision, { ok: true }>; nro: string; monto: number; origen: string; senales?: SenalPago[] },
): Promise<Salida> {
  const { nombre, p, dec, nro, monto } = x;
  const e = { origen: x.origen };
  const reservado = await d.reservarTransaccion({ nro_transaccion: nro, shopify_order_id: p.shopify_order_id, pedido: nombre, monto, origen: e.origen ?? "gmail_ueno", motivo: dec.motivo, coincidencia: dec.coincidencia });
  if (!reservado) return { ok: false, error: "transaccion_ya_usada", detalle: `la transacción ${nro} ya se usó para marcar un pago`, pedido: nombre };

  let r: ResultadoRecibido;
  try {
    r = await d.marcarRecibido(p.shopify_order_id, nro);
  } catch (ex) {
    r = { tipo: "error", error: ex instanceof Error ? ex.message : String(ex) };
  }
  if (r.tipo === "error") {
    await d.liberarTransaccion(nro);
    return { ok: false, error: "recibido_fallo", detalle: r.error, pedido: nombre };
  }
  const notas = r.notas ?? [];
  if (d.facturarAlCobrar) {
    const f = await d.facturarAlCobrar(p.shopify_order_id).catch((ex) => ({ accion: "error", error: ex instanceof Error ? ex.message : String(ex) }));
    if (f.accion === "aprobada") notas.push("Factura emitida al cobrar.");
    else if (f.accion === "error" || f.accion === "revisar") notas.push(`Factura: ${f.accion} (${f.error ?? "sin detalle"}); la reintenta la cola.`);
  }
  await d.guardarResultado(nro, { resultado: r.tipo, notas });
  await d.registrarAdmin(
    `Pago verificado solo (${e.origen ?? "gmail_ueno"}): ${nombre} · Gs ${monto.toLocaleString("es-PY")} · ${dec.motivo} · coincidencia por ${dec.coincidencia} · ${r.tipo === "ya_hecho" ? "ya estaba marcado (Recibido)" : "marcado"}${notas.length ? `\n${notas.join("\n")}` : ""}`,
    nombre,
  ).catch(() => {});
  return { ok: true, pedido: nombre, motivo: dec.motivo, monto, coincidencia: dec.coincidencia, resultado: r.tipo, notas, ...(x.senales ? { senales: x.senales } : {}) };
}

const NRO_VALIDO = /^[A-Za-z0-9._-]{3,100}$/;

/** Modo sin pedido: elige el pedido con rankearCandidatos y, si es uno solo seguro, sigue como siempre. */
export async function procesarSinPedido(e: Entrada, d: DepsPago): Promise<Salida> {
  const prueba = e.prueba === true;
  if (!prueba && !(await d.activo())) return { ok: false, error: "apagado", detalle: "config pago_auto_gmail.activo = false (lo prende Enrique)" };
  if (!d.candidatos) return { ok: false, error: "sin_candidatos_configurados", detalle: "falta deps.candidatos" };
  const monto = Number(e.monto);
  if (!Number.isFinite(monto) || monto <= 0 || Math.round(monto) !== monto) return { ok: false, error: "datos_invalidos", detalle: "monto en guaraníes, entero y mayor a 0" };
  const fecha = String(e.fecha ?? "").trim();
  if (!fecha || Number.isNaN(Date.parse(fecha))) return { ok: false, error: "datos_invalidos", detalle: "fecha de la transferencia en ISO con zona (p. ej. 2026-10-29T15:30:00-03:00)" };
  const nroDado = String(e.nro_transaccion ?? "").trim();
  if (nroDado && !NRO_VALIDO.test(nroDado)) return { ok: false, error: "datos_invalidos", detalle: "nro_transaccion de 3 a 100 caracteres (letras, números, . _ -)" };
  const titular = e.titular ? String(e.titular) : null;

  // Rendiciones de Punto a Punto y Lucero del Este: llegan a la misma cuenta, nunca son de un pedido. Sin aviso.
  const extra = d.titularesIgnorar ? await d.titularesIgnorar().catch(() => []) : [];
  if (esRendicionCourier(titular, extra)) return { ok: false, error: "rendicion_courier", ignorar: true, detalle: "rendición de courier: no se asocia a ningún pedido" };

  const t: TransferenciaRecibida = { monto, fecha: new Date(fecha).toISOString(), nro_transaccion: nroDado || null, titular, banco: e.banco ?? null };
  const ref = refTransferencia(t);
  const clave = nroDado || `SN-${ref}-${monto}`;
  if (d.transferenciaYaAsociada && await d.transferenciaYaAsociada(clave, ref)) {
    return { ok: false, error: "ya_asociada", ignorar: true, detalle: "esta transferencia ya se asoció a un pedido (automático o \"Es este\")" };
  }

  const r = rankearCandidatos(t, await d.candidatos(monto, t.fecha));
  const ahora = d.ahora ? d.ahora() : new Date();
  const avisar = async (texto: string, botones: BotonesAviso): Promise<boolean> => {
    if (prueba || !d.avisarEnrique) return prueba;
    return await d.avisarEnrique(texto, botones, `${ref}:${monto}`).catch(() => false);
  };
  if (r.tipo === "ninguno") {
    const texto = avisoSinCandidatos(t);
    return { ok: false, error: "sin_candidatos", detalle: "ningún pedido espera ese monto", avisado: await avisar(texto, []), total: 0, ...(prueba ? { aviso: texto } : {}) };
  }
  const lista = r; // "unico" o "ambiguo": los dos traen top y total
  type SalidaError = Extract<Salida, { ok: false }>;
  const ambiguo = async (error: string, detalle: string): Promise<SalidaError> => {
    const a = avisoCandidatos(t, lista, ahora);
    return {
      ok: false, error, detalle, avisado: await avisar(a.texto, a.botones), total: lista.total,
      candidatos: lista.top.map((x) => x.candidato.pedido), ...(prueba ? { aviso: a.texto } : {}),
    };
  };
  if (r.tipo === "ambiguo") return ambiguo("ambiguo", `${r.total} pedido(s) con ese monto y ninguno con una señal que alcance sola`);

  const nombre = r.candidato.pedido;
  const p = await d.leerPedido(nombre);
  if (!p) return ambiguo("pedido_inexistente", `el ranking eligió ${nombre} pero no se pudo leer`);
  const dec: Decision = decidir(p, monto, titular, r.senales);
  if (!dec.ok) return { ...(await ambiguo(dec.error, `${nombre}: ${dec.detalle}`)), pedido: nombre, pendiente: dec.pendiente };
  if (prueba) {
    return { ok: true, prueba: true, pedido: nombre, motivo: dec.motivo, pendiente: dec.pendiente, coincidencia: dec.coincidencia, senales: r.senales, haria: "marcar como \"Recibido\": PAGADO + PAGO_VERIFICADO + PRIORIDAD, texto al cliente y texto al courier si ya salió" };
  }
  return await marcar(d, { nombre, p, dec, nro: clave, monto, origen: e.origen ?? "gmail_ueno", senales: r.senales });
}
