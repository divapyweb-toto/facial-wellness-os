import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { fusionarPerfil, marcasDeRespuesta, mismoPerfil, normalizarPerfil, preguntaQueTeFrena, preguntaSiEsBot, textoPerfil } from "./perfil.ts";

Deno.test("perfil: normaliza lo que viene de la base o del modelo y descarta lo raro", () => {
  assertEquals(normalizarPerfil(null), {});
  assertEquals(normalizarPerfil("x"), {});
  assertEquals(normalizarPerfil({ necesidad: "ronca", perfil: "precio", nota: "  es  para el marido ", otro: 1 }), {
    necesidad: "ronca", perfil: "precio", nota: "es para el marido",
  });
  assertEquals(normalizarPerfil({ necesidad: "cancer", perfil: "vip", ofrecido_x2: "si" }), {});
  assertEquals(normalizarPerfil({ nota: "x".repeat(300) }).nota?.length, 120);
});

Deno.test("perfil: fusionar pisa campo por campo, 'indefinido' no borra un perfil y las marcas no se pierden", () => {
  const p = fusionarPerfil({ perfil: "desconfiado", ofrecido_x2: true }, { necesidad: "aliento", perfil: "indefinido" });
  assertEquals(p, { perfil: "desconfiado", ofrecido_x2: true, necesidad: "aliento" });
  assertEquals(fusionarPerfil({}, { pregunto_freno: true }).pregunto_freno, true);
  assert(mismoPerfil({ perfil: "precio" }, { perfil: "precio" }));
  assertFalse(mismoPerfil({ perfil: "precio" }, { perfil: "precio", ofrecido_x2: true }));
});

Deno.test("perfil: marcas deterministas de lo que se le mandó al cliente", () => {
  assertEquals(marcasDeRespuesta("¿Te armo 1 o aprovechás el de 2?"), { ofrecido_x2: true });
  assertEquals(marcasDeRespuesta("Con 2 bolsas te ahorrás un envío."), { ofrecido_x2: true });
  assertEquals(marcasDeRespuesta("Te mando el carrusel", ["enviar_opciones"]), { ofrecido_x2: true });
  assertEquals(marcasDeRespuesta("Dale, sin apuro. ¿Qué te frena?"), { pregunto_freno: true });
  assertEquals(marcasDeRespuesta("Te llega en 2 a 5 días hábiles."), {});
  assert(preguntaQueTeFrena("¿Qué te frena?"));
});

Deno.test("perfil: el contexto dice cómo encararlo y que no re-pregunte; sin perfil pide diagnosticar", () => {
  const t = textoPerfil({ necesidad: "pareja_se_queja", perfil: "precio", ofrecido_x2: true, pregunto_freno: true });
  assert(t.includes("PERFIL YA DETECTADO (no lo vuelvas a preguntar)"));
  assert(t.includes("la pareja se queja"));
  assert(t.includes("total en una línea y el valor del ×2"));
  assert(t.includes("YA OFRECISTE EL ×2"));
  assert(t.includes("YA PREGUNTASTE QUÉ LO FRENA"));
  assert(textoPerfil({}).includes("hacé UNA pregunta corta de diagnóstico"));
});

Deno.test("honestidad: detecta la pregunta directa '¿sos un bot / una persona?' y no el pedido de una persona", () => {
  for (const t of ["sos un bot?", "¿Sos una persona?", "sos real?", "es un bot esto?", "estoy hablando con una máquina?", "me atiende un robot?", "eres una IA?", "bot?", "es respuesta automática?"]) {
    assert(preguntaSiEsBot(t), t);
  }
  for (const t of ["quiero hablar con una persona de verdad", "mi marido es una persona que ronca", "cuánto sale?", "es para mi esposo"]) {
    assertFalse(preguntaSiEsBot(t), t);
  }
});
