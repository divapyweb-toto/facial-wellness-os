// 13-10: guardia de entrega programada. Antes de mandar un aviso de entrega se mira la fecha programada del pedido
// (atributo entrega_programada en el raw de Shopify): nunca "hoy / mañana te llega" en otro día. Datos inventados.
import { assertEquals } from "jsr:@std/assert@1";
import { CONFIG_DEFECTO, type Contexto, type Decision, decidir, type Envio, guardiaEntregaProgramada, type Horario } from "./procesar.ts";

const horario: Horario = {
  dentro: (d, c) => {
    const h = (d.getUTCHours() + 21) % 24;
    return h >= c.desde && h < c.hasta;
  },
  proxima: (d, c) => {
    const local = new Date(d.getTime() - 3 * 3_600_000);
    const dia = local.getUTCHours() < c.desde ? local.getUTCDate() : local.getUTCDate() + 1;
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), dia, c.desde + 3));
  },
};

const RAW_PROG = { note_attributes: [{ name: "entrega_programada", value: "2026-10-16" }, { name: "entrega_franja", value: "antes de las 12" }] };

const ctx = (raw: unknown = RAW_PROG): Contexto => ({
  cliente: { telefono: "+595981000000", wa_user_id: null, nombre: "Ana" },
  pedido: { shopify_order_id: 1001, nombre: "#1001", estado_confirmacion: "confirmado", tags: ["CONFIRMADO", "ENTREGA_PROGRAMADA"], total: 129000, raw },
  consentimientoMarketing: null,
  ultimaEntrada: null,
  conversacionId: "conv1",
});

const envio = (plantilla: string, variables: Record<string, unknown>): Envio => ({
  id: "e1",
  cliente_id: "c1",
  shopify_order_id: 1001,
  plantilla,
  variables,
  categoria: "utilidad",
  enviar_desde: "2026-10-14T11:00:00.000Z",
  estado: "pendiente",
  clave_unica: "courier:1001:ENTREGA_HOY",
  intentos: 0,
  ultimo_error: null,
});

const hoy = (v: Record<string, unknown> = {}) => envio("voltra_entrega_hoy", { nombre: "Ana", total: "129.000", ...v });
const proxima = () => envio("voltra_entrega_proxima", { nombre: "Ana", total: "129.000" });
const manana = (fecha: string, dia: string) => envio("voltra_entrega_manana", { nombre: "Ana", dia_entrega: dia, total: "129.000", fecha_entrega: fecha });

const MIERCOLES = new Date("2026-10-14T12:00:00Z"); // 9:00 en Asunción
const VIERNES = new Date("2026-10-16T12:00:00Z");
const SABADO = new Date("2026-10-17T12:00:00Z");
const correrA8: Decision = { accion: "reprogramar", enviar_desde: new Date("2026-10-16T11:00:00.000Z"), motivo: "entrega_programada:2026-10-16" };

Deno.test("'hoy te llega' / 'ya está por llegar' antes del día programado → se corren a las 8:00 de ese día", () => {
  assertEquals(decidir(hoy(), ctx(), CONFIG_DEFECTO, MIERCOLES, horario), correrA8);
  assertEquals(decidir(proxima(), ctx(), CONFIG_DEFECTO, MIERCOLES, horario), correrA8);
});

Deno.test("el día programado sale; después de la fecha se cancela", () => {
  const d = decidir(hoy({ fecha_entrega: "2026-10-16" }), ctx(), CONFIG_DEFECTO, VIERNES, horario);
  if (d.accion !== "plantilla") throw new Error(JSON.stringify(d));
  assertEquals([d.nombre, d.valores], ["voltra_entrega_hoy", ["Ana", "129.000"]]);
  assertEquals(decidir(hoy(), ctx(), CONFIG_DEFECTO, SABADO, horario), { accion: "cancelar", motivo: "entrega_programada_pasada" });
  assertEquals(decidir(manana("2026-10-16", "mañana viernes 16/10"), ctx(), CONFIG_DEFECTO, SABADO, horario).accion, "cancelar");
});

Deno.test("'mañana te llega' con la misma fecha → la víspera de siempre; de otra fecha → se corre al día y sale como 'hoy te llega'", () => {
  const ok = decidir(manana("2026-10-16", "mañana viernes 16/10"), ctx(), CONFIG_DEFECTO, new Date("2026-10-15T21:00:00Z"), horario);
  if (ok.accion !== "plantilla") throw new Error(JSON.stringify(ok));
  assertEquals([ok.nombre, ok.valores], ["voltra_entrega_manana", ["Ana", "mañana viernes 16/10", "129.000"]]);
  // Programado (o cambiado) después: el "mañana miércoles 14/10" ya no es verdad.
  const viejo = manana("2026-10-14", "mañana miércoles 14/10");
  assertEquals(decidir(viejo, ctx(), CONFIG_DEFECTO, new Date("2026-10-13T21:00:00Z"), horario), correrA8);
  const elDia = decidir(viejo, ctx(), CONFIG_DEFECTO, VIERNES, horario);
  if (elDia.accion !== "plantilla") throw new Error(JSON.stringify(elDia));
  assertEquals([elDia.nombre, elDia.valores], ["voltra_entrega_hoy", ["Ana", "129.000"]]);
});

Deno.test("'ya salió' de un pedido programado dice el día pedido aunque se haya armado con el plazo genérico", () => {
  const e = envio("voltra_pedido_despachado", { nombre: "Ana", productos: "1 Tiras nasales", courier: "Lucero del Este", plazo: "el día o al siguiente", total: "129.000" });
  const d = decidir(e, ctx(), CONFIG_DEFECTO, new Date("2026-10-13T15:00:00Z"), horario);
  if (d.accion !== "plantilla") throw new Error(JSON.stringify(d));
  assertEquals(d.valores?.[3], "la fecha que pediste: el viernes 16/10, antes de las 12");
  // Ya con la fecha: no se toca.
  assertEquals(guardiaEntregaProgramada("voltra_pedido_despachado", { plazo: "la fecha que pediste: el viernes 16/10" }, { raw: RAW_PROG }, new Date("2026-10-13T15:00:00Z")), null);
});

Deno.test("sin entrega programada (o con fecha inválida) → nada cambia", () => {
  for (const raw of [{}, { note_attributes: [{ name: "entrega_programada", value: "viernes" }] }]) {
    assertEquals(guardiaEntregaProgramada("voltra_entrega_hoy", {}, { raw }, MIERCOLES), null);
    const d = decidir(hoy(), ctx(raw), CONFIG_DEFECTO, MIERCOLES, horario);
    assertEquals(d.accion, "plantilla");
  }
  // Plantillas que no son avisos de entrega no se miran.
  assertEquals(guardiaEntregaProgramada("voltra_seguimiento_entrega", {}, { raw: RAW_PROG }, SABADO), null);
});

Deno.test("'ya salió' de importar-courier (variables posicionales) también dice el día pedido", () => {
  const e = envio("voltra_pedido_despachado", {});
  e.variables = ["Ana", "1 Tiras nasales", "Lucero del Este", "1 a 3 días hábiles", "129.000"];
  const d = decidir(e, ctx(), CONFIG_DEFECTO, new Date("2026-10-13T15:00:00Z"), horario);
  if (d.accion !== "plantilla") throw new Error(JSON.stringify(d));
  assertEquals(d.valores, ["Ana", "1 Tiras nasales", "Lucero del Este", "la fecha que pediste: el viernes 16/10, antes de las 12", "129.000"]);
});
