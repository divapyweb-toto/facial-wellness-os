// Tests de wa-enviar-manual. Datos inventados (repo público).
import { assertEquals } from "jsr:@std/assert@1";
import { type ConversacionManual, type Deps, enviarManual, tokenDeHeader, validarCuerpo, ventanaAbierta } from "./logica.ts";

const CONV = "11111111-2222-4333-8444-555555555555";
const AHORA = new Date("2026-10-06T15:00:00Z");

function mock(conv: Partial<ConversacionManual> | null = {}, envio = { ok: true, wa_message_id: "wamid.OUT1" }) {
  const st = { tomadas: [] as string[], enviados: [] as { to: string; texto: string }[] };
  const deps: Deps = {
    ahora: () => AHORA,
    usuario: (t) => Promise.resolve(t === "jwt-valido" ? { id: "u1" } : null),
    buscarConversacion: (id) =>
      Promise.resolve(
        conv === null || id !== CONV ? null : {
          id: CONV,
          cliente_id: "cli-1",
          estado: "ia",
          ultima_entrada_en: "2026-10-06T10:00:00Z",
          telefono: "+595981000000",
          wa_user_id: null,
          ...conv,
        },
      ),
    tomarConversacion: (id) => (st.tomadas.push(id), Promise.resolve()),
    enviarTexto: (to, texto) => (st.enviados.push({ to, texto }), Promise.resolve(envio)),
  };
  return { deps, st };
}

Deno.test("tokenDeHeader y ventanaAbierta", () => {
  assertEquals(tokenDeHeader("Bearer abc"), "abc");
  assertEquals(tokenDeHeader(null), "");
  assertEquals(ventanaAbierta("2026-10-05T15:00:01Z", AHORA), true);
  assertEquals(ventanaAbierta("2026-10-05T15:00:00Z", AHORA), false);
  assertEquals(ventanaAbierta(null, AHORA), false);
});

Deno.test("validarCuerpo", () => {
  assertEquals(validarCuerpo({ conversacion_id: CONV, texto: "  hola  " }), { ok: true, conversacionId: CONV, texto: "hola" });
  assertEquals(validarCuerpo({ conversacion_id: "x", texto: "hola" }).ok, false);
  assertEquals(validarCuerpo({ conversacion_id: CONV, texto: "   " }).ok, false);
  assertEquals(validarCuerpo({ conversacion_id: CONV, texto: "a".repeat(4097) }).ok, false);
});

Deno.test("sin token o token inválido → 401 y no manda", async () => {
  const { deps, st } = mock();
  assertEquals((await enviarManual("", { conversacion_id: CONV, texto: "hola" }, deps)).status, 401);
  assertEquals((await enviarManual("otro", { conversacion_id: CONV, texto: "hola" }, deps)).status, 401);
  assertEquals(st.enviados.length, 0);
});

Deno.test("ventana abierta: toma el chat (humano/enrique) y manda", async () => {
  const { deps, st } = mock();
  const r = await enviarManual("jwt-valido", { conversacion_id: CONV, texto: "Hola, ya lo vemos" }, deps);
  assertEquals(r, { status: 200, body: { ok: true, wa_message_id: "wamid.OUT1" } });
  assertEquals(st.tomadas, [CONV]);
  assertEquals(st.enviados, [{ to: "+595981000000", texto: "Hola, ya lo vemos" }]);
});

Deno.test("ventana cerrada: no manda ni toma", async () => {
  const { deps, st } = mock({ ultima_entrada_en: "2026-10-04T10:00:00Z" });
  const r = await enviarManual("jwt-valido", { conversacion_id: CONV, texto: "hola" }, deps);
  assertEquals(r.body.ok, false);
  assertEquals(st.enviados.length + st.tomadas.length, 0);
});

Deno.test("cliente solo con BSUID: manda por user_id", async () => {
  const { deps, st } = mock({ telefono: null, wa_user_id: "PY.1234567890123" });
  await enviarManual("jwt-valido", { conversacion_id: CONV, texto: "hola" }, deps);
  assertEquals(st.enviados[0].to, "PY.1234567890123");
});

Deno.test("conversación inexistente → 404; error de WhatsApp (p. ej. palabra prohibida) se devuelve", async () => {
  const a = mock(null);
  assertEquals((await enviarManual("jwt-valido", { conversacion_id: CONV, texto: "hola" }, a.deps)).status, 404);
  const b = mock({}, { ok: false, error: "palabra_prohibida:garantía" } as never);
  const r = await enviarManual("jwt-valido", { conversacion_id: CONV, texto: "x" }, b.deps);
  assertEquals(r.body, { ok: false, error: "palabra_prohibida:garantía" });
});
