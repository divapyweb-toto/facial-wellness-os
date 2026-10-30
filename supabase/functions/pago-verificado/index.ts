// pago-verificado · Edge Function (solo service role). 27-10-2026.
// La llama la tarea de administración que lee los avisos de ueno ("Transferencia recibida") en voltraparaguay@gmail.com.
// Body: { pedido: "#1135", monto: 158000, nro_transaccion: "…", origen?: "gmail_ueno", titular?: "…", prueba?: true }.
// Hace EXACTAMENTE lo del botón "Recibido" del Telegram (mismo procesarCallback y mismo candado), solo si el monto es
// exacto y hay comprobante en el chat o el titular coincide con el cliente. Interruptor: config.pago_auto_gmail
// {"activo": false} (lo prende Enrique). Con prueba:true responde qué haría sin tocar nada.
// Vuelta atrás: pago_auto_gmail {"activo": false}. Un pago mal marcado se revierte como uno de "Recibido".
// 29-10 (agente F): MODO SIN PEDIDO. Body { monto, fecha, nro_transaccion?, titular?, banco?, origen?, prueba? } sin
// `pedido`: los candidatos salen de pagos_candidatos + shopify_pedidos (teléfono, nombres, ciudad) + comprobantes de
// WhatsApp (wa_mensajes.contenido.comprobante_pago_anticipado / comprobante_datos) y elige _shared/pagos_ranking.ts.
// Nombres y teléfonos solo se comparan acá adentro; la respuesta y los avisos llevan números de pedido.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { dependencias } from "../telegram-webhook/dependencias.ts";
import { procesarCallback } from "../telegram-webhook/procesar.ts";
import { facturarAlCobrar } from "../factura/io.ts";
import type { PedidoPago } from "./logica.ts";
import type { CandidatoPago, ComprobanteChat } from "../_shared/pagos_ranking.ts";
import { type DepsPago, type Entrada, procesarPago } from "./procesar.ts";

const nombreDeNota = (nota: string) => /^\s*Nombre\s*:\s*(.+)$/im.exec(nota)?.[1]?.trim() ?? "";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? v as Obj : {});
const txt = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
const ult9 = (t: string | null) => (t ?? "").replace(/\D/g, "").slice(-9);

function nombresDe(raw: Obj, clienteNombre: string | null): string[] {
  const dir = obj(raw.shipping_address), fac = obj(raw.billing_address), cli = obj(raw.customer);
  return [String(dir.name ?? ""), String(fac.name ?? ""), `${cli.first_name ?? ""} ${cli.last_name ?? ""}`, nombreDeNota(String(raw.note ?? "")), clienteNombre ?? ""]
    .filter((n) => n.trim());
}

function telefonoDe(telefono: unknown, raw: Obj, clienteTel: string | null): string | null {
  return txt(telefono) ?? txt(raw.phone) ?? txt(obj(raw.shipping_address).phone) ?? txt(obj(raw.customer).phone) ?? clienteTel;
}

/** Modo sin pedido: pedidos que esperan `monto` con lo necesario para el ranking (nada sale de esta función). */
async function candidatosDe(monto: number, fechaISO: string): Promise<CandidatoPago[]> {
  const { data: v, error } = await db().from("pagos_candidatos").select("shopify_order_id, pedido, monto_pendiente, creado_en").eq("monto_pendiente", monto);
  if (error) throw new Error(`pagos_candidatos: ${error.message}`);
  if (!v?.length) return [];
  const ids = v.map((x) => Number(x.shopify_order_id));
  const { data: ps, error: e2 } = await db().from("shopify_pedidos").select("shopify_order_id, telefono, cliente_id, total, tags, raw, creado_en").in("shopify_order_id", ids);
  if (e2) throw new Error(`shopify_pedidos: ${e2.message}`);
  // Comprobantes de WhatsApp (marcados por wa-webhook) desde el pedido más viejo (máx. 15 días antes) hasta 1 día después.
  const t = Date.parse(fechaISO);
  const masViejo = Math.min(t, ...v.map((x) => Date.parse(String(x.creado_en))).filter(Number.isFinite));
  const desde = new Date(Math.max(masViejo, t - 15 * 86_400_000)).toISOString();
  const hasta = new Date(t + 86_400_000).toISOString();
  const { data: ms, error: e3 } = await db().from("wa_mensajes").select("cliente_id, creado_en, contenido")
    .eq("direccion", "in").in("tipo", ["image", "document"]).gte("creado_en", desde).lte("creado_en", hasta)
    .not("contenido->>comprobante_pago_anticipado", "is", null);
  if (e3) throw new Error(`wa_mensajes: ${e3.message}`);
  const clienteIds = [...new Set([...(ps ?? []).map((p) => p.cliente_id), ...(ms ?? []).map((m) => m.cliente_id)].filter((x) => !!x).map(String))];
  const clientes = new Map<string, { telefono: string | null; nombre: string | null }>();
  if (clienteIds.length) {
    const { data: cs, error: e4 } = await db().from("wa_clientes").select("id, telefono, nombre").in("id", clienteIds);
    if (e4) throw new Error(`wa_clientes: ${e4.message}`);
    for (const c of cs ?? []) clientes.set(String(c.id), { telefono: txt(c.telefono), nombre: txt(c.nombre) });
  }
  const porId = new Map((ps ?? []).map((p) => [Number(p.shopify_order_id), p]));
  return v.flatMap((x): CandidatoPago[] => {
    const p = porId.get(Number(x.shopify_order_id));
    if (!p) return [];
    const raw = obj(p.raw);
    const cli = p.cliente_id ? clientes.get(String(p.cliente_id)) : undefined;
    const telefono = telefonoDe(p.telefono, raw, cli?.telefono ?? null);
    const creado = Date.parse(String(p.creado_en ?? x.creado_en));
    const comprobantes: ComprobanteChat[] = [];
    for (const m of ms ?? []) {
      const c = obj(m.contenido);
      // Descartado por el clasificador, o anterior al pedido: no es de este pago.
      if (obj(c.comprobante_clasificado).es === false || Date.parse(String(m.creado_en)) < creado) continue;
      const telM = m.cliente_id ? clientes.get(String(m.cliente_id))?.telefono ?? null : null;
      const delPedido = String(c.comprobante_pago_anticipado) === String(x.shopify_order_id) ||
        (!!m.cliente_id && m.cliente_id === p.cliente_id) || (ult9(telM).length === 9 && ult9(telM) === ult9(telefono));
      if (!delPedido) continue;
      const dat = obj(c.comprobante_datos);
      comprobantes.push({
        en: new Date(String(m.creado_en)).toISOString(), telefono: telM,
        monto: num(dat.monto) ?? num(obj(c.comprobante_clasificado).monto),
        nro_transaccion: txt(dat.nro_transaccion), referencias: Array.isArray(dat.referencias) ? dat.referencias.map(String) : [],
        titular: txt(dat.titular), banco: txt(dat.banco), fecha: txt(dat.fecha),
      });
    }
    const tags = (p.tags as string[] | null) ?? String(raw.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return [{
      shopify_order_id: Number(x.shopify_order_id), pedido: String(x.pedido), monto_pendiente: Number(x.monto_pendiente),
      total: p.total != null ? Number(p.total) : null, ciudad: txt(obj(raw.shipping_address).city),
      creado_en: new Date(String(p.creado_en ?? x.creado_en)).toISOString(), tags, telefono,
      nombresCliente: nombresDe(raw, cli?.nombre ?? null), comprobantes,
    }];
  });
}

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
  // ---- modo sin pedido (29-10) ----
  candidatos: candidatosDe,
  async transferenciaYaAsociada(clave, ref) {
    const { count, error } = await db().from("pagos_verificados").select("id", { count: "exact", head: true }).eq("nro_transaccion", clave);
    if (error) throw new Error(`pagos_verificados: ${error.message}`);
    if ((count ?? 0) > 0) return true;
    // Botón "Es este" (telegram-webhook guarda ref_pago en el candado accion:pagado:<id>).
    const { count: n2, error: e2 } = await db().from("eventos_crudos").select("id", { count: "exact", head: true })
      .eq("fuente", "telegram").like("id_externo", "accion:pagado:%").eq("payload->>ref_pago", ref);
    if (e2) throw new Error(`eventos_crudos: ${e2.message}`);
    return (n2 ?? 0) > 0;
  },
  async avisarEnrique(texto, botones, clave) {
    const r = await avisar(texto, botones, { tipo: "pago_ambiguo", destino: "enrique", unaVezPorDia: true, clave });
    return r.ok;
  },
  async titularesIgnorar() {
    const { data } = await db().from("config").select("valor").eq("clave", "pago_auto_gmail").maybeSingle();
    try {
      const l = JSON.parse(String(data?.valor ?? "{}"))?.ignorar_titulares;
      return Array.isArray(l) ? l.map(String) : [];
    } catch { return []; }
  },
  ahora: () => new Date(),
};

Deno.serve(conServiceRole(async (req: Request) => {
  try {
    const b = await req.json().catch(() => ({})) as Entrada;
    const r = await procesarPago(b, deps);
    console.log("pago-verificado", JSON.stringify({ pedido: b.pedido ?? r.pedido ?? null, sin_pedido: !b.pedido, ok: r.ok, error: r.ok ? undefined : r.error, prueba: b.prueba === true }));
    return Response.json(r, { status: r.ok ? 200 : 422 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("pago-verificado:", msg);
    return Response.json({ ok: false, error: "excepcion", detalle: msg }, { status: 500 });
  }
}));
