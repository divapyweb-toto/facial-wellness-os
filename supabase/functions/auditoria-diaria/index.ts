// auditoria-diaria · Dueño: G3 (ola 2)
// Cada mañana revisa las conversaciones del día anterior (reglas + Haiku por Batch API) y manda a
// Telegram SOLO las que tienen algo raro: palabra prohibida, precio dudoso, cliente enojado, venta
// perdida. La llama pg_cron (migración 20261006000008_cron_auditoria.sql) con la service role.
// POST opcional {fecha:'YYYY-MM-DD', reenviar:true} para reprocesar un día a mano.
// Sin ANTHROPIC_API_KEY (o con MODO_SIMULADO=1) el lote corre simulado y el aviso lo dice.
import { db } from "../_shared/db.ts";
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { avisar } from "../_shared/telegram.ts";
import { consultarLote, llamarClaudeLote } from "../_shared/claude.ts";
import { type DepsAuditoria, ejecutarAuditoria, type EstadoLoteAud } from "./auditoria.ts";
import type { ConvInfo, MensajeAud, PedidoCliente, TurnoVend } from "./logica.ts";

const LOTE_ESPERA_MS = 90_000; // la función tiene ~150 s; si el lote tarda más, lo levanta el próximo cron

function trozos<T>(xs: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function aLote(e: Awaited<ReturnType<typeof llamarClaudeLote>>): EstadoLoteAud {
  return {
    id: e.id,
    estado: e.estado,
    simulado: e.simulado,
    resultados: e.resultados?.map((r) => ({ custom_id: r.custom_id, tipo: r.tipo, texto: r.texto, costo_usd: r.costo_usd })),
  };
}

const deps: DepsAuditoria = {
  ahora: () => new Date(),
  async config(clave) {
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", clave).maybeSingle();
    if (error) throw new Error(`config_wa.${clave}: ${error.message}`);
    return data?.valor ?? null;
  },
  async guardarConfig(clave, valor) {
    const { error } = await db().from("config_wa").upsert({ clave, valor, actualizado_en: new Date().toISOString() });
    if (error) throw new Error(`guardar config_wa.${clave}: ${error.message}`);
  },
  async mensajesEntre(desde, hasta) {
    const out: MensajeAud[] = [];
    for (let desdeFila = 0; desdeFila < 20_000; desdeFila += 1000) {
      const { data, error } = await db()
        .from("wa_mensajes")
        .select("id, conversacion_id, cliente_id, direccion, tipo, texto, creado_en")
        .gte("creado_en", desde)
        .lt("creado_en", hasta)
        .order("creado_en", { ascending: true })
        .range(desdeFila, desdeFila + 999);
      if (error) throw new Error(`wa_mensajes: ${error.message}`);
      out.push(...((data ?? []) as MensajeAud[]));
      if (!data || data.length < 1000) break;
    }
    return out.filter((m) => m.conversacion_id);
  },
  async conversaciones(ids) {
    const out: ConvInfo[] = [];
    for (const t of trozos(ids)) {
      const { data, error } = await db()
        .from("wa_conversaciones")
        .select("id, estado, cliente_id, wa_clientes(nombre, telefono, wa_username)")
        .in("id", t);
      if (error) throw new Error(`wa_conversaciones: ${error.message}`);
      for (const c of data ?? []) {
        const cl = (Array.isArray(c.wa_clientes) ? c.wa_clientes[0] : c.wa_clientes) as
          | { nombre?: string; telefono?: string; wa_username?: string }
          | null;
        out.push({
          id: c.id,
          estado: c.estado,
          cliente_id: c.cliente_id,
          nombre: cl?.nombre ?? null,
          telefono: cl?.telefono ?? null,
          wa_username: cl?.wa_username ?? null,
        });
      }
    }
    return out;
  },
  async turnosVendedor(ids) {
    const out: TurnoVend[] = [];
    for (const t of trozos(ids)) {
      const { data, error } = await db().from("vendedor_turnos").select("conversacion_id, herramientas, derivado").in("conversacion_id", t);
      if (error) {
        // La tabla es de la migración 0004 (G1); si todavía no existe, se sigue sin ella.
        console.warn("auditoria-diaria: vendedor_turnos no disponible:", error.message);
        return [];
      }
      out.push(...((data ?? []) as TurnoVend[]));
    }
    return out;
  },
  async pedidosDeClientes(clienteIds, desde, hasta) {
    const out: PedidoCliente[] = [];
    for (const t of trozos(clienteIds)) {
      const { data, error } = await db()
        .from("shopify_pedidos")
        .select("cliente_id, total, creado_en")
        .in("cliente_id", t)
        .gte("creado_en", desde)
        .lt("creado_en", hasta);
      if (error) throw new Error(`shopify_pedidos: ${error.message}`);
      out.push(...((data ?? []).map((p) => ({ ...p, total: p.total == null ? null : Number(p.total) })) as PedidoCliente[]));
    }
    return out;
  },
  crearLote: async (pedidos) => aLote(await llamarClaudeLote(pedidos, { esperar: true, maxEsperaMs: LOTE_ESPERA_MS, cadaMs: 10_000 })),
  consultarLote: async (id) => aLote(await consultarLote(id)),
  avisar: (texto) => avisar(texto),
};

Deno.serve(conServiceRole(async (req) => {
  let op: { fecha?: string; reenviar?: boolean } = {};
  try {
    const cuerpo = await req.json().catch(() => ({}));
    if (typeof cuerpo?.fecha === "string") op.fecha = cuerpo.fecha;
    if (cuerpo?.reenviar === true) op.reenviar = true;
  } catch {
    op = {};
  }
  try {
    const r = await ejecutarAuditoria(deps, op);
    console.log("auditoria-diaria:", JSON.stringify(r));
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("auditoria-diaria:", msg);
    await avisar(`<b>Atención: la auditoría diaria del vendedor falló</b>\n${msg.replace(/[<>&]/g, " ")}`).catch(() => {});
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
