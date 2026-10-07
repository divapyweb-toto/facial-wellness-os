// recompra · baja de marketing ("No quiero ofertas" o BAJA).
// wa-webhook NO se toca desde H1: la integración tiene que llamar a `registrarBaja(clienteId, origen)`
// cuando llega el botón `mk_baja:<order_id>` (o el texto del botón "No quiero ofertas") o un texto
// que cumpla `esPedidoDeBaja` (calendario.ts), y además cuando Meta devuelve el error 131050
// (el cliente apagó "Ofertas y anuncios" en WhatsApp).
//
// Qué hace: registra 'baja' en wa_consentimientos (tipo marketing; el estado vigente es la fila más
// reciente), cancela los envíos de marketing pendientes del cliente y todos sus planes abiertos.

import { db } from "../_shared/db.ts";

// Interfaz mínima del cliente de Supabase que usa esta función (así el test pasa una base falsa).
interface Resp {
  error: { message: string } | null;
}
interface Filtro extends PromiseLike<Resp> {
  eq(col: string, v: unknown): Filtro;
  in(col: string, v: unknown[]): Filtro;
}
export interface SbMin {
  from(tabla: string): {
    insert(fila: Record<string, unknown>): PromiseLike<Resp>;
    update(cambio: Record<string, unknown>): Filtro;
  };
}

// 'meta_131050': Meta rechazó un envío porque el cliente apagó las ofertas (migración 0010 lo admite).
export type OrigenBaja = "boton" | "chat" | "meta_131050";

export async function registrarBaja(
  clienteId: string,
  origen: OrigenBaja = "boton",
  sb: SbMin = db() as unknown as SbMin,
): Promise<{ ok: boolean; error?: string }> {
  if (!clienteId) return { ok: false, error: "falta_cliente_id" };
  const r1 = await sb.from("wa_consentimientos").insert({
    cliente_id: clienteId,
    tipo: "marketing",
    estado: "baja",
    origen,
  });
  if (r1.error) return { ok: false, error: `consentimiento: ${r1.error.message}` };
  const r2 = await sb.from("envios_programados")
    .update({ estado: "cancelado", ultimo_error: "baja_marketing" })
    .eq("cliente_id", clienteId).eq("categoria", "marketing").eq("estado", "pendiente");
  if (r2.error) return { ok: false, error: `envios: ${r2.error.message}` };
  const r3 = await sb.from("recompra_plan")
    .update({ estado: "cancelado", motivo: "baja" })
    .eq("cliente_id", clienteId).in("estado", ["planificado", "programado"]);
  if (r3.error) return { ok: false, error: `planes: ${r3.error.message}` };
  return { ok: true };
}
