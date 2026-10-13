// 12-10: confirmación v4 (día de entrega) y aviso de la víspera (voltra_entrega_manana). Datos inventados.
import { assertEquals } from "jsr:@std/assert@1";
import { CONFIG_DEFECTO, type Contexto, decidir, type Envio, type Horario, visperaVencida } from "./procesar.ts";

// Asunción = UTC−3. Próxima apertura: 8:00 del día siguiente (o de hoy si todavía no son las 8).
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

const ctx = (x: Partial<Contexto["pedido"]> = {}, estado = "confirmado"): Contexto => ({
  cliente: { telefono: "+595981000000", wa_user_id: null, nombre: "Ana" },
  pedido: { shopify_order_id: 1001, nombre: "#1001", estado_confirmacion: estado, tags: ["CONFIRMADO"], total: 129000, raw: {}, ...x },
  consentimientoMarketing: null,
  ultimaEntrada: null,
  conversacionId: "conv1",
});

const manana = (x: Partial<Envio> = {}): Envio => ({
  id: "e1",
  cliente_id: "c1",
  shopify_order_id: 1001,
  plantilla: "voltra_entrega_manana",
  // Forma exacta de shopify-webhook (armarRecordatorioEntrega con la plantilla activa).
  variables: { nombre: "Ana", dia_entrega: "mañana martes 13/10", total: "129.000", fecha_entrega: "2026-10-13" },
  categoria: "utilidad",
  enviar_desde: "2026-10-12T21:00:00.000Z",
  estado: "pendiente",
  clave_unica: "courier:1001:ENTREGA_HOY",
  intentos: 0,
  ultimo_error: null,
  ...x,
});

const botones = (comps: unknown[]) =>
  comps.filter((c) => (c as { type: string }).type === "button")
    .map((c) => (c as { parameters: { payload: string }[] }).parameters[0].payload);

Deno.test("confirmación v4: 7 parámetros con el día de entrega y botones conf_si / corregir / conf_cancelar", () => {
  const e: Envio = {
    ...manana(),
    plantilla: "voltra_confirmacion_pedido_v4",
    variables: {
      nombre: "Ana Prueba", productos: "1 Tiras nasales", total: 129000, total_texto: "129.000", direccion: "Calle Falsa 123",
      ciudad: "Asunción", pedido: "#1001", dia_entrega: "mañana martes 13/10 o el miércoles 14/10",
    },
    clave_unica: "conf:1001",
  };
  const d = decidir(e, ctx({}, "pendiente"), CONFIG_DEFECTO, new Date("2026-10-12T15:00:00Z"), horario);
  if (d.accion !== "plantilla") throw new Error(JSON.stringify(d));
  assertEquals(d.nombre, "voltra_confirmacion_pedido_v4");
  assertEquals(d.valores, ["#1001", "Ana", "1 Tiras nasales", "129.000", "Calle Falsa 123", "Asunción", "mañana martes 13/10 o el miércoles 14/10"]);
  assertEquals(botones(d.componentes), ["conf_si:1001", "corregir:1001", "conf_cancelar:1001"]);
  // Ya confirmado: no sale (solo mientras espera confirmación). Sin el día: falla sin mandar.
  assertEquals(decidir(e, ctx({}, "confirmado"), CONFIG_DEFECTO, new Date("2026-10-12T15:00:00Z"), horario).accion, "cancelar");
  const sinDia = { ...e, variables: { ...(e.variables as object), dia_entrega: undefined } };
  assertEquals(decidir(sinDia, ctx({}, "pendiente"), CONFIG_DEFECTO, new Date("2026-10-12T15:00:00Z"), horario),
    { accion: "fallar", motivo: "falta_variable:dia_entrega" });
});

Deno.test("víspera: 18:00 sale con nombre, día y total; botones ent_ok / reprogramar con el id del pedido", () => {
  const d = decidir(manana(), ctx(), CONFIG_DEFECTO, new Date("2026-10-12T21:00:00Z"), horario);
  if (d.accion !== "plantilla") throw new Error(JSON.stringify(d));
  assertEquals(d.valores, ["Ana", "mañana martes 13/10", "129.000"]);
  assertEquals(botones(d.componentes), ["ent_ok:1001", "reprogramar:1001"]);
});

Deno.test("víspera: nunca sale el día de la entrega (atrasada o de noche → se cancela); el viernes de noche se corre al sábado", () => {
  // Reintento que cae el martes (día de la entrega): sería un "mañana" falso.
  assertEquals(decidir(manana(), ctx(), CONFIG_DEFECTO, new Date("2026-10-13T12:00:00Z"), horario), { accion: "cancelar", motivo: "vispera_vencida" });
  // Lunes 21:00 (fuera de 8 a 20): la próxima apertura es el martes 8:00, el mismo día de la entrega.
  assertEquals(decidir(manana(), ctx(), CONFIG_DEFECTO, new Date("2026-10-13T00:00:00Z"), horario), { accion: "cancelar", motivo: "vispera_fuera_de_horario" });
  // Viernes 21:00 diciendo "el lunes": se corre al sábado 8:00 (sigue siendo cierto).
  const vie = manana({ variables: { nombre: "Ana", dia_entrega: "el lunes 19/10", total: "129.000", fecha_entrega: "2026-10-19" } });
  const d = decidir(vie, ctx(), CONFIG_DEFECTO, new Date("2026-10-17T00:00:00Z"), horario);
  assertEquals(d.accion === "reprogramar" ? d.enviar_desde.toISOString() : d, "2026-10-17T11:00:00.000Z");
  // Ya entregado por el courier: no se avisa.
  assertEquals(decidir(manana(), ctx({ estado_envio: "ENTREGADO" }), CONFIG_DEFECTO, new Date("2026-10-12T21:00:00Z"), horario).accion, "cancelar");
});

Deno.test("visperaVencida solo mira voltra_entrega_manana con fecha_entrega", () => {
  const t = new Date("2026-10-13T12:00:00Z");
  assertEquals(visperaVencida(manana(), t), true);
  assertEquals(visperaVencida(manana(), new Date("2026-10-12T23:30:00Z")), false); // lunes 20:30 en Asunción
  assertEquals(visperaVencida({ plantilla: "voltra_entrega_hoy", variables: { fecha_entrega: "2026-10-13" } }, t), false);
  assertEquals(visperaVencida({ plantilla: "voltra_entrega_manana", variables: { nombre: "Ana" } }, t), false);
});
