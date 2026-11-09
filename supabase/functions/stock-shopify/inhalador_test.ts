// 09-11-2026 · Inhalador de menta GTRC: familia propia, evaluada antes que Tiras ("inhalador nasal" caía en Tiras).
// Datos inventados. La copia de familiaProducto (ruteo) se prueba en tests/inhalador.test.mjs. Cubre stock-shopify, resumen-diario, lista-despacho, anuncios, vendedor y sync-meta-ads.
import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { familia, stockReal, type Producto } from "./logica.ts";
import { familia as familiaResumen } from "../resumen-diario/logica.ts";
import { esKit } from "../lista-despacho/logica.ts";
import { productoPorPalabras } from "../_shared/anuncios.ts";
import { lineaProducto } from "../_shared/vendedor/herramientas.ts";
import { esIntencionEscrita } from "../_shared/vendedor/intencion.ts";
import { mapearProducto } from "../sync-meta-ads/logica.ts";

const TITULO = "Inhalador de Menta: frescura en 1 respiro"; // título en Shopify (09-11)
const TIRAS = "Tiras Nasales: más aire por la nariz";
const BOTELLA = "Botella Deportiva Flexible: se enrolla y no pesa";
const KIT = "Kit Deporte: Botella Deportiva + Tiras Nasales";

Deno.test("familia: inhalador (con o sin 'nasal') es Inhalador; Tiras, Kit y Botella no cambian", () => {
  for (const t of [TITULO, "Inhalador nasal de menta", "inhalador WAKEFUL", "GTRC x3"]) {
    assertEquals(familia(t), "Inhalador");
    assertEquals(familiaResumen(t), "Inhalador");
  }
  assertEquals(familia(TIRAS), "Tiras");
  assertEquals(familia(KIT), "Kit Deporte");
  assertEquals(familia(BOTELLA), "Botella");
  assertEquals(familiaResumen(TIRAS), "Tiras");
});

const prods: Producto[] = [
  { id: "i", nombre: "Inhalador de menta", stock: 500, esCombo: false, componentes: [] },
  { id: "t", nombre: "Tiras nasales", stock: 0, esCombo: false, componentes: [] },
  { id: "b", nombre: "Botella Flexible", stock: 42, esCombo: false, componentes: [] },
];

Deno.test("stock real: 3 inhaladores sin descontar bajan el inhalador, no las tiras", () => {
  const r = stockReal(prods, [{ lineas: [{ titulo: TITULO, cantidad: 3 }] }]);
  assertEquals(r.get("Inhalador")?.real, 497);
  assertEquals(r.get("Tiras")?.real, 0);
  assertEquals(r.get("Tiras")?.sinDescontar, 0);
});

Deno.test("stock real: pedido mixto Botella + Inhalador baja cada uno lo suyo", () => {
  const r = stockReal(prods, [{ lineas: [{ titulo: BOTELLA, cantidad: 1 }, { titulo: TITULO, cantidad: 1 }] }]);
  assertEquals(r.get("Botella")?.real, 41);
  assertEquals(r.get("Inhalador")?.real, 499);
  assertEquals(r.get("Tiras")?.sinDescontar, 0);
});

Deno.test("stock real: un pedido de Tiras sigue bajando Tiras (sin cambios)", () => {
  const r = stockReal([...prods.slice(0, 1), { id: "t", nombre: "Tiras nasales", stock: 20, esCombo: false, componentes: [] }], [{ lineas: [{ titulo: TIRAS, cantidad: 2 }] }]);
  assertEquals(r.get("Tiras")?.real, 18);
  assertEquals(r.get("Inhalador")?.real, 500);
});

Deno.test("lista de despacho: Botella + Inhalador nasal no es el Kit Deporte; el kit sigue siéndolo", () => {
  assertEquals(esKit("Botella + Inhalador nasal"), false);
  assertEquals(esKit(TITULO), false);
  assertEquals(esKit(KIT), true);
});

Deno.test("bot: el inhalador no cae en tiras ni en la línea sueño; 'quiero 3 inhaladores' es intención de compra", () => {
  // WHATSAPP API lo pasa al handle del inhalador (rama inhalador-bot): acá solo se exige que no caiga en tiras.
  assertNotEquals(productoPorPalabras("vi el inhalador nasal"), "tiras-nasales-gudair-30-unidades");
  assertEquals(productoPorPalabras("quiero las tiras nasales"), "tiras-nasales-gudair-30-unidades");
  assertEquals(lineaProducto("Inhalador nasal de menta"), "otros");
  assertEquals(lineaProducto(TIRAS), "sueño");
  assertEquals(esIntencionEscrita("quiero 3 inhaladores")?.cantidad, 3);
});

Deno.test("sync-meta-ads: un conjunto 'INHALADOR' se asigna al inhalador, no a tiras", () => {
  const p = [
    { id: "i", nombre: "Inhalador de menta" }, { id: "t", nombre: "Tiras nasales" }, { id: "b", nombre: "Botella Flexible" },
  ];
  assertEquals(mapearProducto("WA INHALADOR 13-11", "WHATSAPP 07-10", p), "i");
  assertEquals(mapearProducto("WA INHALADOR NASAL", "WHATSAPP 07-10", p), "i");
  assertEquals(mapearProducto("WEB TIRAS NASALES", "WEB LINEAS", p), "t");
});
