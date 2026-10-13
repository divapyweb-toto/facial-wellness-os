import { assert, assertEquals } from "jsr:@std/assert@1";
import { validarEntrada } from "./validar.ts";

Deno.test("vendedor: valida el cuerpo que manda wa-webhook", () => {
  const ok = validarEntrada({ conversacion_id: "11111111-1111-4111-8111-111111111111", wa_message_id: " wamid.X ", texto: " hola " });
  assertEquals(ok, { ok: true, entrada: { conversacion_id: "11111111-1111-4111-8111-111111111111", wa_message_id: "wamid.X", texto: "hola" } });
  assert(!validarEntrada({ conversacion_id: "no-uuid", wa_message_id: "w", texto: "t" }).ok);
  assert(!validarEntrada({ conversacion_id: "11111111-1111-4111-8111-111111111111", wa_message_id: "w", texto: "  " }).ok);
  assert(!validarEntrada(null).ok);
});

Deno.test("vendedor: imagen opcional (ruta de wa-media y formato visible); si viene rara se ignora", () => {
  const base = { conversacion_id: "11111111-1111-4111-8111-111111111111", wa_message_id: "wamid.X", texto: "[imagen]" };
  const ok = validarEntrada({ ...base, imagen: { ruta: "media/22222222-2222-4222-8222-222222222222/wamid.HBgM=.jpg", mime: "image/JPEG" } });
  assert(ok.ok);
  assertEquals(ok.ok && ok.entrada.imagen, { ruta: "media/22222222-2222-4222-8222-222222222222/wamid.HBgM=.jpg", mime: "image/jpeg" });
  for (const imagen of [
    { ruta: "../secreto.jpg", mime: "image/jpeg" },
    { ruta: "comprobantes/c/x.jpg", mime: "image/jpeg" },
    { ruta: "media/c/x.pdf", mime: "application/pdf" },
    { ruta: 5, mime: "image/jpeg" },
    "media/c/x.jpg",
  ]) {
    const r = validarEntrada({ ...base, imagen });
    assert(r.ok && r.entrada.imagen === undefined, JSON.stringify(imagen));
  }
});
