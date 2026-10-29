// pago-verificado/procesar.ts · 27-10. Núcleo con dependencias inyectadas (index.ts las conecta; las pruebas usan dobles).
// Orden: interruptor → datos → pedido → decidir (monto exacto + coincidencia) → reservar el n.º de transacción (único)
// → el MISMO "Recibido" del Telegram (procesarCallback pagado:<id>, con su candado accion:pagado:<id>).
// Si "Recibido" falla, se libera el n.º de transacción para poder reintentar. Nunca se marca dos veces.
// 29-10 (factura al cobrar): marcado el pago → facturarAlCobrar (factura ya si el pago quedó COMPLETO; con saldo
// pendiente la cola responde no_facturable y se factura al entregar). Idempotente y sin excepción: si falla, la cola
// de 10 min lo toma por pagado_en. Telegram "Recibido" (agente C) también lo llama: dos llamadas = una sola factura.
import { decidir, type Decision, nombrePedido, type PedidoPago } from "./logica.ts";

export interface Entrada {
  pedido: string;
  monto: number;
  nro_transaccion: string;
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
}

export type Salida =
  | { ok: true; prueba: true; pedido: string; motivo: string; pendiente: number; coincidencia: string; haria: string }
  | { ok: true; prueba?: false; pedido: string; motivo: string; monto: number; coincidencia: string; resultado: string; notas: string[] }
  | { ok: false; error: string; detalle?: string; pendiente?: number; pedido?: string };

export async function procesarPago(e: Entrada, d: DepsPago): Promise<Salida> {
  const prueba = e.prueba === true;
  if (!prueba && !(await d.activo())) return { ok: false, error: "apagado", detalle: "config pago_auto_gmail.activo = false (lo prende Enrique)" };
  const nombre = nombrePedido(e.pedido);
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
  return { ok: true, pedido: nombre, motivo: dec.motivo, monto, coincidencia: dec.coincidencia, resultado: r.tipo, notas };
}
