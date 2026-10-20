// Producto del anuncio (click-to-WhatsApp) y seed_anuncios.sql. Ids de anuncios reales (no son datos de clientes).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  armarSeedAnuncios,
  deducirProductoAnuncio,
  leerSeedAnuncios,
  mapearAnuncios,
  marcaAnuncio,
  nombreDeHandle,
  productoDeMarca,
  productoPorPalabras,
  PRODUCTOS_ANUNCIO,
  textoDelAnuncio,
} from "./anuncios.ts";

const TIRAS = "tiras-nasales-gudair-30-unidades";
const PARCHES = "parches-bucales-gudair-30-unidades";
const PACK = "pack-gudair-tiras-nasales-parches-bucales";
const RASPADOR = "raspador-de-lengua-de-acero-inoxidable";
const BOTELLA = "botella-flexible-gudair-500-ml";
const EJERCITADOR = "ejercitador-de-mandibula-3-niveles";

Deno.test("anuncios: palabras clave → handle (pack primero, acentos y mayúsculas da igual)", () => {
  assertEquals(productoPorPalabras("IMG WHATSAPP TIRAS NASALES 1 07-10-26"), TIRAS);
  assertEquals(productoPorPalabras("Respirá mejor con la tira nasal"), TIRAS);
  assertEquals(productoPorPalabras("VID WHATSAPP PARCHES BUCALES 2 07-10-26"), PARCHES);
  assertEquals(productoPorPalabras("Dormí con la boca cerrada: cinta bucal"), PARCHES);
  assertEquals(productoPorPalabras("IMG WHATSAPP PACK TIRAS + PARCHES 1 07-10-26"), PACK);
  assertEquals(productoPorPalabras("Tiras nasales y parches bucales juntos"), PACK);
  assertEquals(productoPorPalabras("Pack ahorro"), PACK);
  assertEquals(productoPorPalabras("RASPADOR DE LENGUA"), RASPADOR);
  assertEquals(productoPorPalabras("Limpiá tu lengua"), RASPADOR);
  assertEquals(productoPorPalabras("BOTELLA FLEXIBLE"), BOTELLA);
  assertEquals(productoPorPalabras("EJERCITADOR DE MANDÍBULA"), EJERCITADOR);
  assertEquals(productoPorPalabras("Marcá la mandibula"), EJERCITADOR);
  assertEquals(productoPorPalabras("JawFlex 3 niveles"), EJERCITADOR);
  assertEquals(productoPorPalabras("Oferta de la semana"), null);
  assertEquals(productoPorPalabras(""), null);
});

Deno.test("anuncios: nombre legible de cada handle", () => {
  assertEquals(Object.keys(PRODUCTOS_ANUNCIO).length, 6);
  assertEquals(nombreDeHandle(TIRAS), "tiras nasales");
  assertEquals(nombreDeHandle(EJERCITADOR), "ejercitador de mandíbula");
  assertEquals(nombreDeHandle("cepillo-nuevo-gudair"), "cepillo nuevo");
});

Deno.test("anuncios: deducir producto (mapeo por id gana; si no, palabras del referral; nada → null)", () => {
  const mapeo = { "120251028181900429": TIRAS, "999": "Handle Inválido!" };
  assertEquals(deducirProductoAnuncio({ adId: "120251028181900429", mapeo }), { handle: TIRAS, nombre: "tiras nasales", fuente: "mapeo" });
  // El id del referral gana sobre el de la conversación.
  assertEquals(deducirProductoAnuncio({ adId: "otro", referral: { source_id: "120251028181900429", headline: "Botella" }, mapeo })?.handle, TIRAS);
  // Id fuera del mapeo → palabras del headline/body/url.
  assertEquals(deducirProductoAnuncio({ referral: { source_id: "555", headline: "¿Roncás?", body: "Probá los parches bucales" }, mapeo }), {
    handle: PARCHES,
    nombre: "parches bucales",
    fuente: "palabras",
  });
  assertEquals(deducirProductoAnuncio({ referral: { source_id: "555", source_url: "https://voltra.com.py/products/botella-flexible" } })?.handle, BOTELLA);
  // Handle inválido en el mapeo no se usa.
  assertEquals(deducirProductoAnuncio({ adId: "999", mapeo }), null);
  assertEquals(deducirProductoAnuncio({ adId: "555", mapeo: null }), null);
  assertEquals(deducirProductoAnuncio({ adId: "555", mapeo: ["x"] }), null);
  assertEquals(deducirProductoAnuncio({ referral: { source_id: "555", headline: "Oferta" } }), null);
});

Deno.test("anuncios: marca exacta (contrato con el prompt) y lectura de vuelta", () => {
  const m = marcaAnuncio({ handle: TIRAS, nombre: "tiras nasales" });
  assertEquals(m, "[vino del anuncio de tiras nasales, handle tiras-nasales-gudair-30-unidades]");
  assertEquals(productoDeMarca(`${m}\n¡Hola! Quiero más información`), { nombre: "tiras nasales", handle: TIRAS });
  assertEquals(productoDeMarca(marcaAnuncio({ handle: PACK, nombre: nombreDeHandle(PACK) }))?.nombre, "pack tiras nasales + parches bucales");
  assertEquals(productoDeMarca("hola"), null);
});

Deno.test("anuncios: mapear anuncios de Meta por nombre, conservar lo previo y avisar lo que no se reconoce", () => {
  const r = mapearAnuncios([
    { id: "120251028999990429", name: "IMG WHATSAPP TIRAS NASALES 3 08-10-26" },
    { id: "120251028999991429", name: "VID WHATSAPP NOVEDAD 1 08-10-26" },
    { id: "no-numérico", name: "TIRAS" },
  ], { mapeo: { "120251028173280429": PARCHES }, nombres: { "120251028173280429": "PARCHES BUCALES" } });
  assertEquals(r.mapeo, { "120251028173280429": PARCHES, "120251028999990429": TIRAS });
  assertEquals(r.nombres["120251028999990429"], "IMG WHATSAPP TIRAS NASALES 3 08-10-26");
  assertEquals(r.sinProducto, [{ id: "120251028999991429", name: "VID WHATSAPP NOVEDAD 1 08-10-26" }]);
});

Deno.test("anuncios: seed generado ida y vuelta (ordenado, on conflict sin pisar lo existente)", () => {
  const sql = armarSeedAnuncios({ "2": TIRAS, "1": RASPADOR }, { "1": "RASPADOR DE LENGUA", "2": "TIRAS 'NASALES'" });
  assert(sql.indexOf('"1"') < sql.indexOf('"2"'));
  assert(sql.includes("on conflict (clave) do nothing;"));
  assert(/'::jsonb \|\| valor\s+where clave = 'anuncios_producto'/.test(sql), "lo existente tiene que quedar a la derecha del ||");
  assert(!sql.includes("'NASALES'"), "las comillas simples del nombre romperían el SQL");
  assertEquals(leerSeedAnuncios(sql), { mapeo: { "1": RASPADOR, "2": TIRAS }, nombres: { "1": "RASPADOR DE LENGUA", "2": "TIRAS NASALES" } });
  assertEquals(leerSeedAnuncios("basura"), { mapeo: {}, nombres: {} });
});

Deno.test("seed_anuncios.sql: los 15 anuncios del 07-10 con su producto y handles válidos", async () => {
  const sql = await Deno.readTextFile(new URL("../../seed_anuncios.sql", import.meta.url));
  const { mapeo } = leerSeedAnuncios(sql);
  const esperado: Record<string, string> = {
    "120251028173280429": PARCHES, "120251028535240429": BOTELLA, "120251028210620429": EJERCITADOR,
    "120251028175490429": RASPADOR, "120251028181900429": TIRAS, "120251028533010429": RASPADOR,
    "120251028172410429": TIRAS, "120251028538280429": PARCHES, "120251028212170429": PACK,
    "120251028537220429": TIRAS, "120251028237510429": BOTELLA, "120251028236970429": RASPADOR,
    "120251028237050429": BOTELLA, "120251028212040429": PARCHES, "120251028211490429": RASPADOR,
  };
  assertEquals(mapeo, esperado);
  for (const h of Object.values(mapeo)) assert(h in PRODUCTOS_ANUNCIO, h);
  assert(sql.includes("on conflict (clave) do nothing;"));
  assert(/'::jsonb \|\| valor\s+where clave = 'anuncios_producto'/.test(sql));
});

Deno.test("21-10 textoDelAnuncio: sin porcentajes ni asteriscos, sin 'Escribinos…', null sin texto útil", () => {
  assertEquals(textoDelAnuncio({ body: "Hasta 30 % más aire por la nariz*. Ayuda a reducir los ronquidos. Escribinos por WhatsApp y te lo mandamos: 30 tiras" }), "Ayuda a reducir los ronquidos.");
  assertEquals(textoDelAnuncio({ body: "Entrená tu mandíbula: lo masticás como un chicle, 15 minutos al día. 3 niveles. Escribinos por WhatsApp" }), "Entrená tu mandíbula: lo masticás como un chicle, 15 minutos al día. 3 niveles.");
  assertEquals(textoDelAnuncio({ body: "Prueba E2E" }), null);
  assertEquals(textoDelAnuncio(null), null);
});
