// seguimiento-chat · I/O real (Supabase, vendedor, Telegram). La lógica está en logica.ts.
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { inicioMesAsuncionISO, procesarTurno } from "../_shared/vendedor/orquestador.ts";
import { depsOrquestadorReales } from "../_shared/vendedor/io.ts";
import type { Candidato, CfgSeguimiento, DepsSeguimiento } from "./logica.ts";

function falla(contexto: string, error: { message: string } | null): void {
  if (error) throw new Error(`${contexto}: ${error.message}`);
}

const DIA = 24 * 3_600_000;
/** Acciones de vendedor_turnos que no son una respuesta al cliente (no cuentan para "¿la última fue una derivación?"). */
const NO_RESPUESTA = /^(?:seguimiento_)?(?:agrupado|omitido)/;

type FilaConv = { id: string; estado: string; cliente_id: string; ultima_entrada_en: string | null; perfil_vendedor: unknown };

async function candidatos(desdeISO: string, hastaISO: string, cfg: CfgSeguimiento): Promise<Candidato[]> {
  const sb = db();
  const { data, error } = await sb.from("wa_conversaciones").select("id,estado,cliente_id,ultima_entrada_en,perfil_vendedor")
    .eq("estado", "ia").gte("ultima_entrada_en", desdeISO).lte("ultima_entrada_en", hastaISO)
    .order("ultima_entrada_en", { ascending: true }).limit(150); // 150: los .in() de abajo viajan en la URL
  falla("conversaciones", error);
  const convs = (data ?? []) as FilaConv[];
  if (!convs.length) return [];
  const ids = convs.map((c) => c.id);
  const clientes = [...new Set(convs.map((c) => c.cliente_id))];
  const desdePedido = new Date(Date.now() - cfg.dias_pedido * DIA).toISOString();

  const [msgs, turnos, telefonos, pedidosChat, consent] = await Promise.all([
    // El último mensaje siempre es posterior a ultima_entrada_en (≥ desdeISO).
    sb.from("wa_mensajes").select("conversacion_id,direccion,estado,creado_en").in("conversacion_id", ids)
      .gte("creado_en", desdeISO).order("creado_en", { ascending: false }).limit(10000),
    sb.from("vendedor_turnos").select("conversacion_id,derivado,accion,creado_en").in("conversacion_id", ids)
      .gte("creado_en", desdeISO).order("creado_en", { ascending: false }).limit(5000),
    sb.from("wa_clientes").select("id,telefono").in("id", clientes),
    sb.from("wa_pedidos_chat").select("conversacion_id").in("conversacion_id", ids).eq("estado", "creado").gte("creado_en", desdePedido),
    sb.from("wa_consentimientos").select("cliente_id,estado,creado_en").in("cliente_id", clientes).eq("tipo", "marketing")
      .order("creado_en", { ascending: false }),
  ]);
  falla("mensajes", msgs.error);
  falla("turnos", turnos.error);
  falla("clientes", telefonos.error);
  falla("pedidos del chat", pedidosChat.error);
  falla("consentimientos", consent.error);

  // Pedidos de Shopify del cliente (por cliente_id o por teléfono), no borradores, en los últimos días.
  const telDe = new Map((telefonos.data ?? []).map((c) => [c.id as string, (c.telefono as string | null) ?? null]));
  const tels = [...new Set([...telDe.values()].filter((t): t is string => !!t))];
  const [porCliente, porTel] = await Promise.all([
    sb.from("shopify_pedidos").select("cliente_id").in("cliente_id", clientes).eq("es_borrador", false).gte("creado_en", desdePedido),
    tels.length
      ? sb.from("shopify_pedidos").select("telefono").in("telefono", tels).eq("es_borrador", false).gte("creado_en", desdePedido)
      : Promise.resolve({ data: [] as { telefono: string }[], error: null }),
  ]);
  falla("pedidos por cliente", porCliente.error);
  falla("pedidos por teléfono", porTel.error);
  const clientesConPedido = new Set((porCliente.data ?? []).map((p) => p.cliente_id as string));
  const telsConPedido = new Set((porTel.data ?? []).map((p) => p.telefono as string));
  const convsConPedidoChat = new Set((pedidosChat.data ?? []).map((p) => p.conversacion_id as string));

  const ultimoMsg = new Map<string, { direccion: "in" | "out"; creado_en: string }>();
  for (const m of msgs.data ?? []) {
    if (m.direccion === "out" && m.estado === "fallido") continue;
    if (!ultimoMsg.has(m.conversacion_id)) ultimoMsg.set(m.conversacion_id, { direccion: m.direccion, creado_en: m.creado_en });
  }
  const derivada = new Map<string, boolean>();
  for (const t of turnos.data ?? []) {
    if (derivada.has(t.conversacion_id) || NO_RESPUESTA.test(String(t.accion ?? ""))) continue;
    derivada.set(t.conversacion_id, t.derivado === true);
  }
  const consentVigente = new Map<string, string>();
  for (const c of consent.data ?? []) if (!consentVigente.has(c.cliente_id)) consentVigente.set(c.cliente_id, c.estado);

  return convs.map((c): Candidato => {
    const tel = telDe.get(c.cliente_id) ?? null;
    return {
      conversacion_id: c.id,
      cliente_id: c.cliente_id,
      estado: c.estado,
      ultima_entrada_en: c.ultima_entrada_en,
      perfil: c.perfil_vendedor,
      ultimo_mensaje: ultimoMsg.get(c.id) ?? null,
      ultima_respuesta_derivada: derivada.get(c.id) ?? false,
      pedido_reciente: clientesConPedido.has(c.cliente_id) || (!!tel && telsConPedido.has(tel)) || convsConPedidoChat.has(c.id),
      baja_marketing: consentVigente.get(c.cliente_id) === "baja",
    };
  });
}

export const depsReales: DepsSeguimiento = {
  async config() {
    const { data, error } = await db().from("config_wa").select("valor").eq("clave", "vendedor_seguimiento").maybeSingle();
    falla("config_wa vendedor_seguimiento", error);
    if (!data) console.warn("seguimiento-chat: falta config_wa.vendedor_seguimiento: uso los valores por defecto del código");
    return data?.valor ?? null;
  },

  async topeGastoSuperado(ahora) {
    const cfg = await depsOrquestadorReales.config();
    const gasto = await depsOrquestadorReales.gastoMesUsd(inicioMesAsuncionISO(ahora));
    return gasto >= cfg.vendedor.tope_mensual_usd;
  },

  candidatos,

  async marcar(conversacionId, seguimientos, enISO) {
    const { error } = await db().rpc("vendedor_marcar_seguimiento", {
      p_conversacion: conversacionId,
      p_seguimientos: seguimientos,
      p_en: enISO,
    });
    falla("marcar seguimiento", error);
  },

  turno: (entrada) => procesarTurno(entrada, depsOrquestadorReales),
  avisar: (texto) => avisar(texto),
  ahora: () => new Date(),
  paralelo: 4,
};
