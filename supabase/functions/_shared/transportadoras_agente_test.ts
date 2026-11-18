import { assert, assertEquals } from "jsr:@std/assert@1";
import { esTemaPlata, extraerRefs, interpretarClasificacion, necesitaIA, respuestaPedido, textoPlata, unaLinea } from "./transportadoras_agente.ts";

Deno.test("agente: referencias de pedido y guías; celulares y montos no", () => {
  assertEquals(extraerRefs("el VT-1240 y el #1241, también L-VT-1242"), { pedidos: ["1240", "1241", "1242"], guias: [] });
  assertEquals(extraerRefs("guía 26546876 y la 23740").guias, ["26546876", "23740"]);
  assertEquals(extraerRefs("llamé al 0981000111 y no atiende, cobré 199.000"), { pedidos: [], guias: [] });
  assertEquals(extraerRefs("pedido 1250 por favor").pedidos, ["1250"]);
});

Deno.test("agente: plata entre Voltra y el courier sí; pregunta de cobro del cliente no", () => {
  for (const t of ["cuándo hacen la rendición?", "nos deben el depósito de la semana", "desde diciembre hay aumento de tarifa", "costo extra por zona"]) assert(esTemaPlata(t), t);
  for (const t of ["el cliente ya pagó?", "cuánto le cobro?", "a qué hora entrego?"]) assert(!esTemaPlata(t), t);
  assertEquals(textoPlata("0981 000 111"), "Eso lo ve Enrique directamente: escribile al 0981 000 111. Gracias.");
});

const D = { ref: "VT-9001", nombre: "Ana", ciudad: "Luque", total: 199000, senal: null, comprobanteEnEspera: false, cancelado: false, entregado: false, pide: null, horario: null, referencia: null, recibe: null } as const;

Deno.test("agente: respuesta del pedido solo con certeza", () => {
  assertEquals(respuestaPedido({ ...D, senal: "pagado" }), "VT-9001 · Ana · Luque: el cliente YA PAGÓ por transferencia → entregar SIN COBRAR (₲0).");
  assertEquals(respuestaPedido({ ...D, horario: "viernes después de las 14 h" }), "VT-9001 · Ana · Luque: cobrar ₲199.000 al entregar.\nHorario: viernes después de las 14 h");
  assertEquals(respuestaPedido({ ...D, comprobanteEnEspera: true }), null);
  assertEquals(respuestaPedido({ ...D, senal: "pagado", entregado: true }), null);
  assertEquals(respuestaPedido({ ...D, senal: "parcial" }), null);
  assertEquals(respuestaPedido({ ...D, senal: "credito" }), null);
  assertEquals(respuestaPedido({ ...D, cancelado: true }), null);
  assertEquals(respuestaPedido({ ...D, total: null }), null);
});

Deno.test("agente: JSON de Haiku; basura = otro", () => {
  assertEquals(interpretarClasificacion('{"tema":"pedido","ref":"1240","ciudad":null}'), { tema: "pedido", ref: "1240", ciudad: null });
  assertEquals(interpretarClasificacion("no sé").tema, "otro");
  assertEquals(interpretarClasificacion('{"tema":"chiste"}').tema, "otro");
});

Deno.test("agente: mensajes cortos no gastan IA; una línea para la plantilla", () => {
  for (const t of ["ok", "Dale!", "gracias 🙏", "👍"]) assert(!necesitaIA(t), t);
  assert(necesitaIA("mañana no salimos a Luque"));
  assertEquals(unaLinea("Hola\n\nentregar   sin cobrar.\t"), "Hola · entregar sin cobrar");
  assertEquals(unaLinea("x".repeat(800)).length, 700);
});
