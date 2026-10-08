import { assertEquals } from "jsr:@std/assert@1";
import { detectarLinkMapas, parsearUrlMapas, resolverLinkMapas, textoLinkMapas } from "./link_mapas.ts";

Deno.test("detecta links de Google Maps en el texto del cliente", () => {
  assertEquals(detectarLinkMapas("acá está https://maps.app.goo.gl/oh6Pu9sdMAdXiQCf7?g_st=ic"), "https://maps.app.goo.gl/oh6Pu9sdMAdXiQCf7?g_st=ic");
  assertEquals(detectarLinkMapas("https://www.google.com/maps/place/X/@-25.5,-54.6,17z"), "https://www.google.com/maps/place/X/@-25.5,-54.6,17z");
  assertEquals(detectarLinkMapas("mi casa es en area 1"), null);
});

Deno.test("saca coordenadas y lugar de la URL larga", () => {
  const a = parsearUrlMapas("https://www.google.com/maps/place/Supermercado+Area+1,+Ciudad+del+Este/@-25.51,-54.62,17z/data=!3d-25.5130787!4d-54.6292991");
  assertEquals([a.latitud, a.longitud, a.lugar], [-25.5130787, -54.6292991, "Supermercado Area 1, Ciudad del Este"]);
  const b = parsearUrlMapas("https://maps.google.com/?q=-25.529404,-54.609257");
  assertEquals([b.latitud, b.longitud, b.lugar], [-25.529404, -54.609257, null]);
});

Deno.test("sigue la redirección del link corto (fetch simulado) y arma el texto para el vendedor", async () => {
  const f = ((u: string) => Promise.resolve(
    u.includes("goo.gl")
      ? new Response(null, { status: 302, headers: { location: "https://www.google.com/maps/place/Casa/@-25.5130787,-54.6292991,17z" } })
      : new Response("ok"),
  )) as unknown as typeof fetch;
  const l = await resolverLinkMapas("https://maps.app.goo.gl/abc", f);
  assertEquals([l.latitud, l.longitud, l.lugar], [-25.5130787, -54.6292991, "Casa"]);
  assertEquals(textoLinkMapas(l).startsWith("[ubicación por link] -25.5130787,-54.6292991 · Casa"), true);
  const roto = await resolverLinkMapas("https://maps.app.goo.gl/x", (() => Promise.reject(new Error("red"))) as unknown as typeof fetch);
  assertEquals(textoLinkMapas(roto).includes("no pude leer el link"), true);
});
