// pago-verificado · Edge Function (solo service role). 27-10-2026.
// La llama la tarea de administración que lee los avisos de ueno ("Transferencia recibida") en voltraparaguay@gmail.com.
// Body: { pedido: "#1135", monto: 158000, nro_transaccion: "…", origen?: "gmail_ueno", titular?: "…", prueba?: true }.
// Hace EXACTAMENTE lo del botón "Recibido" del Telegram (mismo procesarCallback y mismo candado), solo si el monto es
// exacto y hay comprobante en el chat o el titular coincide con el cliente. Interruptor: config.pago_auto_gmail
// {"activo": false} (lo prende Enrique). Con prueba:true responde qué haría sin tocar nada.
// Vuelta atrás: pago_auto_gmail {"activo": false}. Un pago mal marcado se revierte como uno de "Recibido".
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { dependencias } from "../telegram-webhook/dependencias.ts";
import { procesarCallback } from "../telegram-webhook/procesar.ts";
import { facturarAlCobrar } from "../factura/io.ts";
import type { PedidoPago } from "./logica.ts";
import { type DepsPago, type Entrada, procesarPago } from "./procesar.ts";

const nombreDeNota = (nota: string) => /^\s*Nombre\s*:\s*(.+)$/im.exec(nota)?.[1]?.trim() ?? "";

const deps: DepsPago = {
  async activo() {
    const { data } = await db().from("config").select("valor").eq("clave", "pago_auto_gmail").maybeSingle();
    try { return JSON.parse(String(data?.valor ?? "{}"))?.activo === true; } catch { return false; }
  },
  async leerPedido(nombre) {
    const { data: p, error } = await db().from("shopify_pedidos")
      .select("shopify_order_id, nombre, estado_envio, tags, total, raw, cliente_id, es_borrador").eq("nombre", nombre).maybeSingle();
    if (error) throw new Error(`shopify_pedidos: ${error.message}`);
    if (!p || p.es_borrador) return null;
    const raw = (p.raw ?? {}) as Record<string, unknown>;
    const dir = (raw.shipping_address ?? {}) as Record<string, unknown>;
    const fac = (raw.billing_address ?? {}) as Record<string, unknown>;
    const cli = (raw.customer ?? {}) as Record<string, unknown>;
    const nombres = [String(dir.name ?? ""), String(fac.name ?? ""), `${cli.first_name ?? ""} ${cli.last_name ?? ""}`, nombreDeNota(String(raw.note ?? ""))];
    if (p.cliente_id) {
      const { data: c } = await db().from("wa_clientes").select("nombre").eq("id", p.cliente_id).maybeSingle();
      if (c?.nombre) nombres.push(String(c.nombre));
    }
    const tags = (p.tags as string[] | null) ?? String(raw.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const pedido: PedidoPago = {
      shopify_order_id: Number(p.shopify_order_id), nombre: p.nombre, estado_envio: p.estado_envio, tags,
      total: p.total != null ? Number(p.total) : (raw.total_price != null ? Math.round(Number(raw.total_price)) : null),
      cancelado: !!raw.cancelled_at, nombresCliente: nombres.filter((n) => n.trim()),
    };
    return pedido;
  },
  async reservarTransaccion(fila) {
    const { error } = await db().from("pagos_verificados").insert(fila);
    if (!error) return true;
    if (error.code === "23505") return false;
    throw new Error(`pagos_verificados: ${error.message}`);
  },
  async liberarTransaccion(nro) {
    await db().from("pagos_verificados").delete().eq("nro_transaccion", nro);
  },
  async guardarResultado(nro, resultado) {
    await db().from("pagos_verificados").update({ resultado }).eq("nro_transaccion", nro);
  },
  async marcarRecibido(id, nro) {
    const chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
    // Mismo "Recibido": callback sintético pagado:<id>, sin mensaje de Telegram que editar ni callback que contestar.
    const r = await procesarCallback(
      { update_id: -Date.now(), callback_query: { id: `pago-${nro}`, from: { id: 0 }, data: `pagado:${id}` } },
      { ...dependencias(chatId), responderCallback: async () => {}, marcarEventoProcesado: async () => {} },
    );
    return { tipo: r.tipo, notas: "notas" in r ? r.notas : undefined, error: "error" in r ? r.error : undefined };
  },
  async registrarAdmin(texto, pedido) {
    await avisar(texto.replace(/[<>&]/g, " "), undefined, { tipo: "pago_verificado_auto", destino: "admin", pedido });
  },
  // 29-10: factura al cobrar (sifen-cola motivo "pagado"); no tira excepción.
  facturarAlCobrar: (id) => facturarAlCobrar(id),
};

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as Entrada;
    const r = await procesarPago(b, deps);
    console.log("pago-verificado", JSON.stringify({ pedido: b.pedido, ok: r.ok, error: r.ok ? undefined : r.error, prueba: b.prueba === true }));
    return Response.json(r, { status: r.ok ? 200 : 422 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("pago-verificado:", msg);
    return Response.json({ ok: false, error: "excepcion", detalle: msg }, { status: 500 });
  }
}));
