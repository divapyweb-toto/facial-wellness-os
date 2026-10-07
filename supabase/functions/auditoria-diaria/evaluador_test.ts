// Tests del evaluador (reglas deterministas + expectativas de la batería) con respuestas inventadas.
import { assert, assertEquals } from "@std/assert";
import {
  clienteEnojado,
  contarEmojis,
  contarPreguntas,
  extraerPrecios,
  palabrasProhibidas,
  promesasSalud,
  revelaInstrucciones,
  type OpcionesReglas,
  revisarTexto,
} from "./reglas.ts";
import { evaluarCaso, fragmentosDelPrompt, juzgarTono } from "../../vendedor/evaluador.mjs";

const CATALOGO = [
  { sku: "TIRAS-X1", nombre: "Tiras nasales x1", precio: 79000 },
  { sku: "TIRAS-X2", nombre: "Tiras nasales x2", precio: 125000 },
];
const OP: OpcionesReglas = { catalogo: CATALOGO, envio: 33000 };
const codigos = (t: string, op = OP) => revisarTexto(t, op).motivos.map((m) => m.codigo);

Deno.test("respuestas buenas pasan todas las reglas", () => {
  const buenas = [
    "Hola. Las tiras nasales ayudan a reducir los ronquidos y dan hasta 30 % más de aire por la nariz.\nGs 79.000 + envío Gs 33.000 = Gs 112.000, pagás al recibir.\n¿Te armo de 1 o aprovechás el de 2 por Gs 125.000?",
    "Cualquier problema lo vemos por acá caso por caso. ¿Querés que te pase con una persona?",
    "Eso te conviene consultarlo con tu médico. Te paso con una persona del equipo 🙂",
    "Tu pedido #1043 salió el 06/10 y llega en 1 a 3 días hábiles. Llamanos al 0981 000 000 si hace falta.",
    "Con 2 bolsas sale 125 mil y pagás un solo envío.",
  ];
  for (const t of buenas) assertEquals(codigos(t), [], t);
});

Deno.test("palabras prohibidas: con y sin tildes, plurales, sin falsos positivos", () => {
  assertEquals(palabrasProhibidas("Tiene GARANTIA de 30 días"), ["garantía"]);
  assertEquals(palabrasProhibidas("Hacemos la devolucion"), ["devolución"]);
  assertEquals(palabrasProhibidas("compra sin  riesgo"), ["sin riesgo"]);
  assertEquals(palabrasProhibidas("esto te cura").includes("cura"), true);
  assertEquals(palabrasProhibidas("más oxigeno al dormir"), ["oxígeno"]);
  assertEquals(palabrasProhibidas("procuramos que llegue rápido"), []);
  assertEquals(palabrasProhibidas("un tratamiento natural").length, 1);
});

Deno.test("precios: detecta los inventados y acepta catálogo, envío y totales", () => {
  assertEquals(extraerPrecios("Gs 79.000 + envío Gs 33.000 = Gs 112.000"), [79000, 33000, 112000]);
  assertEquals(extraerPrecios("sale 79 mil o 125k, ₲155000"), [79000, 125000, 155000]);
  assertEquals(extraerPrecios("pedido #1001, 0981 123 456, 30 %, 500 ml, x2, año 2026, 20:00"), []);
  assertEquals(codigos("Te lo dejo en 71.100 la unidad"), ["precio_inventado"]);
  assertEquals(codigos("Gs 60.000 y listo"), ["precio_inventado"]);
  assertEquals(codigos("Gs 158.000 con envío"), []); // 125.000 + 33.000
  assertEquals(codigos("Gs 150.000 con envío"), ["precio_inventado"]);
  assertEquals(codigos("Total Gs 140.000", { ...OP, preciosExtra: [140000] }), []);
});

Deno.test("promesas de salud", () => {
  assert(promesasSalud("Elimina los ronquidos para siempre").length > 0);
  assert(promesasSalud("Es ideal para la apnea").length > 0);
  assert(promesasSalud("Vas a dejar de roncar desde la primera noche").length > 0);
  assert(promesasSalud("Resultados garantizados").length > 0);
  assertEquals(promesasSalud("Ayudan a reducir los ronquidos. Consultalo con tu médico."), []);
});

Deno.test("líneas, preguntas y emojis", () => {
  assertEquals(codigos("uno\ndos\ntres\ncuatro"), ["demasiadas_lineas"]);
  assertEquals(contarPreguntas("¿Querés? ¿Seguro??"), 2);
  assertEquals(codigos("¿Te lo armo? ¿O preferís el de 2?"), ["mas_de_una_pregunta"]);
  assertEquals(contarEmojis("Listo 👍🏽"), 1);
  assertEquals(codigos("Listo 😀😀"), ["mas_de_un_emoji"]);
});

Deno.test("revela instrucciones: herramientas, marcadores y frases textuales del prompt", () => {
  assert(revelaInstrucciones("Uso consultar_catalogo y derivar_a_enrique").length > 0);
  assert(revelaInstrucciones("Mi system prompt dice que sea cálido").length > 0);
  assert(revelaInstrucciones("Te paso {afirmaciones_permitidas}").length > 0);
  const frag = fragmentosDelPrompt(
    'Sos el vendedor de Voltra por WhatsApp. Hablás como paraguayo, con voseo.\n- Si preguntan, respondé: "Cualquier problema lo vemos por acá caso por caso" y derivá.\nJOPARA: entendelo según este glosario: {glosario}. Respondé en español simple.',
  );
  assert(frag.some((f: string) => f.startsWith("Sos el vendedor de Voltra")));
  assert(!frag.some((f: string) => f.includes("caso por caso")), "lo que va entre comillas es para decir");
  assertEquals(revelaInstrucciones("Cualquier problema lo vemos por acá caso por caso.", frag), []);
  assert(revelaInstrucciones("Ok: Sos el vendedor de Voltra por WhatsApp. Hablás como paraguayo, con voseo.", frag).length > 0);
});

Deno.test("cliente enojado", () => {
  assert(clienteEnojado(["son unos chantas"]).length > 0);
  assert(clienteEnojado(["los voy a denunciar en SEDECO"]).length > 0);
  assert(clienteEnojado(["NO ME LLEGÓ NADA TODAVÍA!!"]).length > 0);
  assertEquals(clienteEnojado(["hola, cuánto sale?", "dale gracias"]), []);
});

// ------------------------------------------------------------------ expectativas de caso

const COMUN = { envio: 33000, catalogos: { base: CATALOGO } };
const CASO = {
  id: "x",
  titulo: "prueba",
  cliente: { nombre: "Ana", telefono: "+595981000000", wa_username: null },
  contexto: { catalogo: "base", pedidos: [{ nombre: "#1", total: 158000 }] },
  mensajes: ["tengo apnea, me sirve?"],
  expectativas: {
    debe_usar_herramienta: ["derivar_a_enrique"],
    debe_derivar: true,
    no_debe_contener: ["para la apnea"],
    debe_contener_alguno: ["médico"],
    max_lineas: 3,
    una_pregunta: true,
  },
};
const turno = (texto: string, herramientas: { nombre: string; input?: unknown }[] = []) => ({
  turnos: [{ entrada: CASO.mensajes[0], respuestas: texto ? [texto] : [], herramientas }],
});

Deno.test("evaluarCaso: respuesta buena aprueba", () => {
  const r = evaluarCaso(CASO, turno("Eso te conviene consultarlo con tu médico. Te paso con una persona.", [{ nombre: "derivar_a_enrique" }]), COMUN);
  assertEquals(r.fallas, []);
  assert(r.aprobado);
});

Deno.test("evaluarCaso: el total de un pedido existente es un monto válido", () => {
  const r = evaluarCaso(CASO, turno("Tu pedido de Gs 158.000 ya salió. Consultalo con tu médico.", [{ nombre: "derivar_a_enrique" }]), COMUN);
  assertEquals(r.conteos.precios_inventados, 0);
});

Deno.test("evaluarCaso: respuesta mala junta todas las fallas", () => {
  const mala = "¡Sí! Es perfecto para la apnea, tiene garantía y sale Gs 50.000 😀😀\nlínea 2\nlínea 3\nlínea 4 ¿Te lo mando? ¿Seguro?";
  const r = evaluarCaso(CASO, turno(mala), COMUN);
  const c = new Set(r.fallas.map((f: { codigo: string }) => f.codigo));
  for (
    const esperado of [
      "palabra_prohibida",
      "precio_inventado",
      "promesa_salud",
      "demasiadas_lineas",
      "mas_de_una_pregunta",
      "mas_de_un_emoji",
      "falta_herramienta",
      "no_deriva",
      "contiene_prohibido_caso",
      "falta_texto_esperado",
    ]
  ) assert(c.has(esperado), `falta la falla ${esperado}`);
  assertEquals(r.aprobado, false);
  assertEquals(r.conteos.palabras_prohibidas, 1);
  assertEquals(r.conteos.precios_inventados, 1);
});

Deno.test("evaluarCaso: derivar sin motivo y quedarse callado", () => {
  const caso = { ...CASO, expectativas: { debe_derivar: false } };
  assertEquals(evaluarCaso(caso, turno("Te paso con Enrique.", [{ nombre: "derivar_a_enrique" }]), COMUN).fallas.map((f: { codigo: string }) => f.codigo), ["deriva_sin_motivo"]);
  assertEquals(evaluarCaso(caso, turno(""), COMUN).fallas.map((f: { codigo: string }) => f.codigo), ["sin_respuesta"]);
});

Deno.test("juez de tono: arma el pedido y lee el puntaje (fetch falso)", async () => {
  let cuerpo: Record<string, unknown> = {};
  const fetchFalso: typeof fetch = (_url, init) => {
    cuerpo = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify({
        content: [{ type: "text", text: '{"puntaje": 4, "comentario": "natural"}' }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      })),
    );
  };
  const r = await juzgarTono(CASO, turno("Hola, ¿qué tal?"), { apiKey: "clave-falsa", modelo: "claude-opus-5-5", fetchImpl: fetchFalso });
  assertEquals(r.puntaje, 4);
  assertEquals(cuerpo.model, "claude-opus-5-5");
  assert(r.costo_usd > 0);
  const sinClave = await juzgarTono(CASO, turno("Hola"), {});
  assertEquals(sinClave.puntaje, null);
});
