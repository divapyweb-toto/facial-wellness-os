import { assert, assertEquals } from "jsr:@std/assert@1";
import { validarEntrada } from "./validar.ts";

Deno.test("vendedor: valida el cuerpo que manda wa-webhook", () => {
  const ok = validarEntrada({ conversacion_id: "11111111-1111-4111-8111-111111111111", wa_message_id: " wamid.X ", texto: " hola " });
  assertEquals(ok, { ok: true, entrada: { conversacion_id: "11111111-1111-4111-8111-111111111111", wa_message_id: "wamid.X", texto: "hola" } });
  assert(!validarEntrada({ conversacion_id: "no-uuid", wa_message_id: "w", texto: "t" }).ok);
  assert(!validarEntrada({ conversacion_id: "11111111-1111-4111-8111-111111111111", wa_message_id: "w", texto: "  " }).ok);
  assert(!validarEntrada(null).ok);
});
