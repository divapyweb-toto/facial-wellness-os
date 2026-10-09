// Tests con respuestas de Meta inventadas (sin red ni base).
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  filasAnuncio,
  urlInsightsAnuncios,
  type Deps,
  type FilaGasto,
  type FilaInsight,
  gastoEntero,
  mapearProducto,
  normalizar,
  type Producto,
  rango,
  sincronizar,
  urlInsights,
} from "./logica.ts";
import { errorMeta } from "./io.ts";

const P: Producto[] = [
  { id: "jaw", nombre: "Ejercitador de mandibula JawFlex Pro" },
  { id: "tir", nombre: "Tiras nasales" },
  { id: "bot", nombre: "Botella Flexible" },
  { id: "oid", nombre: "Limpiador de oido Bebird Pro" },
  { id: "ras", nombre: "Raspador de Lengua" },
  { id: "gud", nombre: "tiras nasales + parches bucales Pack Gudair", es_combo: true, componente_1_id: "tir", componente_2_id: "par" },
  { id: "par", nombre: "Parches bucales" },
];

Deno.test("normalizar: tildes, mayúsculas y plural", () => {
  assertEquals(normalizar("TIRAS NASALES"), "tira nasal");
  assertEquals(normalizar("Mandíbula"), "mandibula");
  assertEquals(normalizar("Parches bucales"), "parche bucal");
});

Deno.test("mapeo: producto en la campaña con conjunto genérico", () => {
  assertEquals(mapearProducto("Abierta PY - 25/55", "SUB - CONV- LIMPIADOR DE LENGUA", P), "ras");
});

Deno.test("mapeo: producto en el conjunto con campaña genérica", () => {
  assertEquals(mapearProducto("Abierta - RASPADOR DE LENGUA", "ABO - CONV - CATALOGO AGOSTO", P), "ras");
  assertEquals(mapearProducto("Abierta - PARCHE BUCAL", "ABO - CONV - CATALOGO AGOSTO", P), "par");
  assertEquals(mapearProducto("TIRA NASAL", "x", P), "tir");
  assertEquals(mapearProducto("JAWFLEX 25-45", "CONV", P), "jaw");
});

Deno.test("mapeo: combo absorbe a sus componentes", () => {
  assertEquals(mapearProducto("PACK GUDAIR tiras + parches", "CONV", P), "gud");
  assertEquals(mapearProducto("GUDAIR - TIRA NASAL + PARCHE BUCAL", "CONV", P), "gud");
});

Deno.test("mapeo: ambiguo o sin coincidencia → null", () => {
  assertEquals(mapearProducto("Abierta - TIRA NASAL", "CONV - BOTELLA", P), null); // conjunto y campaña distintos
  assertEquals(mapearProducto("TIRA NASAL Y BOTELLA", "CONV", P), null); // dos productos en el conjunto
  assertEquals(mapearProducto("ADSET1", "ABO - CONV - CATALOGO", P), null);
  assertEquals(mapearProducto("Abierta - BOTELLA", "CONV - BOTELLA FLEXIBLE", P), "bot"); // mismo producto
});

Deno.test("gasto string → entero", () => {
  assertEquals(gastoEntero("12345"), 12345);
  assertEquals(gastoEntero("12345.6"), 12346);
  assertEquals(gastoEntero(0), 0);
  assertThrows(() => gastoEntero("abc"));
  assertThrows(() => gastoEntero(""));
  assertThrows(() => gastoEntero(undefined));
});

Deno.test("rango: últimos 7 días cerrados en hora de Asunción", () => {
  // 09-10 02:00 UTC = 08-10 23:00 en Asunción → hoy PY = 08-10
  assertEquals(rango(new Date("2026-10-09T02:00:00Z")), { since: "2026-10-01", until: "2026-10-07" });
  assertEquals(rango(new Date("2026-10-09T13:00:00Z")), { since: "2026-10-02", until: "2026-10-08" });
});

Deno.test("urlInsights: parámetros pedidos", () => {
  const u = new URL(urlInsights("1829928881223795", { since: "2026-10-02", until: "2026-10-08" }));
  assertEquals(u.pathname, "/v25.0/act_1829928881223795/insights");
  assertEquals(u.searchParams.get("level"), "adset");
  assertEquals(u.searchParams.get("time_increment"), "1");
  assertEquals(JSON.parse(u.searchParams.get("time_range")!), { since: "2026-10-02", until: "2026-10-08" });
  assertEquals(u.searchParams.get("limit"), "500");
});

function depsFalsas(paginas: Record<string, { data: FilaInsight[]; paging?: { next?: string } }>, productos = P) {
  const escritas: FilaGasto[][] = [];
  const pedidas: string[] = [];
  const deps: Deps = {
    traerPagina(url) {
      pedidas.push(url);
      const clave = url.startsWith("https://graph.facebook.com/v25.0/act_") ? "inicio" : url;
      return Promise.resolve(paginas[clave]);
    },
    leerProductos: () => Promise.resolve(productos),
    leerExistentes: () => Promise.resolve([{ fecha: "2026-10-05", adset_id: "9", producto_id: "bot" }]),
    upsert(f) {
      escritas.push(f);
      return Promise.resolve(f.length);
    },
  };
  return { deps, escritas, pedidas };
}

const AHORA = new Date("2026-10-09T13:00:00Z");

Deno.test("sincronizar: pagina, mapea, convierte y marca tienda", async () => {
  const { deps, escritas, pedidas } = depsFalsas({
    inicio: {
      data: [
        { adset_id: "1", adset_name: "Abierta PY", campaign_name: "SUB - CONV- LIMPIADOR DE LENGUA", spend: "15000", date_start: "2026-10-07" },
        { adset_id: "2", adset_name: "Abierta - TIRA NASAL", campaign_name: "ABO", spend: "0", date_start: "2026-10-07" },
      ],
      paging: { next: "https://graph.facebook.com/v25.0/pag2" },
    },
    "https://graph.facebook.com/v25.0/pag2": {
      data: [
        { adset_id: "3", adset_name: "ADSET1", campaign_name: "CATALOGO", spend: "2500.4", date_start: "2026-10-08" },
        { adset_id: "9", adset_name: "p.2", campaign_name: "OTRA", spend: "100", date_start: "2026-10-05" },
      ],
    },
  });
  const r = await sincronizar(deps, { ahora: AHORA });
  assertEquals(pedidas.length, 2);
  assertEquals(escritas.length, 1);
  const f = escritas[0];
  assertEquals(f.length, 3); // el de gasto 0 no se escribe
  assertEquals(f[0], { fecha: "2026-10-07", adset_id: "1", adset_nombre: "Abierta PY", producto_id: "ras", gasto: 15000, plataforma: "meta", tienda: "voltra" });
  assertEquals(f[1].producto_id, null);
  assertEquals(f[1].gasto, 2500);
  assertEquals(f[2].producto_id, "bot"); // mapeo manual previo se conserva
  assertEquals(r.cuentas[0].gasto_total, 17600);
  assertEquals(r.cuentas[0].sin_mapear.length, 1);
  assertEquals(r.cuentas[0].desde, "2026-10-02");
});

Deno.test("sincronizar: 0 productos → frena sin escribir", async () => {
  const { deps, escritas, pedidas } = depsFalsas({ inicio: { data: [] } }, []);
  await assertRejects(() => sincronizar(deps, { ahora: AHORA }), Error, "0 filas");
  assertEquals(escritas.length, 0);
  assertEquals(pedidas.length, 0);
});

Deno.test("sincronizar: gasto inválido → no escribe nada", async () => {
  const { deps, escritas } = depsFalsas({
    inicio: { data: [{ adset_id: "1", adset_name: "x", campaign_name: "y", spend: "N/A", date_start: "2026-10-07" }] },
  });
  await assertRejects(() => sincronizar(deps, { ahora: AHORA }), Error, "gasto inválido");
  assertEquals(escritas.length, 0);
});

Deno.test("errorMeta: pista de permiso", () => {
  const m = errorMeta(400, { error: { code: 100, error_subcode: 33, message: "Unsupported get request." } });
  assertEquals(m.includes("ads_read"), true);
});

Deno.test("gasto por anuncio: filas válidas, sin gasto 0 y una por fecha+anuncio", () => {
  const f = filasAnuncio([
    { ad_id: "1", ad_name: "VID PRUEBA 1", adset_id: "9", campaign_name: "CAMP", spend: "1500.00", date_start: "2026-10-08" },
    { ad_id: "1", ad_name: "VID PRUEBA 1", adset_id: "9", campaign_name: "CAMP", spend: "1600", date_start: "2026-10-08" },
    { ad_id: "2", ad_name: "IMG PRUEBA", spend: "0", date_start: "2026-10-08" },
    { ad_name: "SIN ID", spend: "10", date_start: "2026-10-08" },
  ], "voltra");
  assertEquals(f.length, 1);
  assertEquals(f[0].gasto, 1600);
  assertEquals(f[0].ad_nombre, "VID PRUEBA 1");
  assert(urlInsightsAnuncios("123", { since: "2026-10-01", until: "2026-10-07" }).includes("level=ad"));
});

Deno.test("cuenta que no está en PYG: se frena sin escribir y con error claro; las demás siguen", async () => {
  const { deps, escritas } = depsFalsas({ inicio: { data: [{ adset_id: "1", adset_name: "Tira nasal", campaign_name: "C", spend: "5000", date_start: "2026-10-05" }] } });
  deps.monedaCuenta = (id) => Promise.resolve(id === "111" ? "USD" : "PYG");
  const r = await sincronizar(deps, {
    cuentas: [{ id: "111", tienda: "fw" }, { id: "222", tienda: "voltra" }],
    ahora: new Date("2026-10-09T15:00:00Z"),
  });
  assertEquals(r.cuentas[0].filas, 0);
  assertEquals(r.cuentas[0].error?.includes("USD"), true);
  assertEquals(r.cuentas[1].error, undefined);
  assertEquals(escritas.length, 1);
  assertEquals(escritas[0].every((f) => f.tienda === "voltra"), true);
});
