import { assert, assertEquals } from "jsr:@std/assert@1";
import { cfgDeSemilla } from "./semilla_prueba.ts";
import {
  calcularPlan,
  configDesdeValor,
  diaLocalMas,
  esPedidoDeBaja,
  evaluarTope,
  instanteLocal,
  type MensajeMk,
  type PedidoEntregado,
  planLanzamiento,
  recompro,
} from "./calendario.ts";

const cfg = cfgDeSemilla();

// 12:00 de Asunción del 1-oct-2026 (UTC−3)
const ENTREGA = new Date("2026-10-01T15:00:00Z");
const ped = (lineas: [string, number][], nombre: string | null = "Ana María"): PedidoEntregado => ({
  shopify_order_id: 1001,
  cliente_id: "c1",
  nombre_cliente: nombre,
  entregado_en: ENTREGA,
  lineas: lineas.map(([titulo, cantidad]) => ({ titulo, cantidad })),
});
const resumen = (p: PedidoEntregado) =>
  calcularPlan(p, cfg).map((i) => `${i.tipo}:${i.dia}:${i.dia_objetivo}:${i.variables.join("|")}`);

Deno.test("tiras ×1: M1 día 23 (otra bolsa 79.000) y M2 día 34 (pack de 2 a 125.000)", () => {
  assertEquals(resumen(ped([["Tiras Nasales Voltra (30 unidades)", 1]])), [
    "M1:23:2026-10-24:Ana|tiras nasales|otra bolsa|79000",
    "M2:34:2026-11-04:Ana|tiras nasales|el pack de 2 bolsas|125000",
  ]);
  const [m1, m2] = calcularPlan(ped([["Tiras Nasales", 1]]), cfg);
  assertEquals([m1.plantilla, m2.plantilla], ["voltra_mk_reposicion", "voltra_mk_pack"]);
  assertEquals([m1.clave_unica, m2.clave_unica], ["rc:1001:M1", "rc:1001:M2"]);
});

Deno.test("parches ×2: M1 51 y M2 72; ×3: M1 76 y M2 109 (tabla del documento)", () => {
  assertEquals(calcularPlan(ped([["Parches bucales", 2]]), cfg).map((i) => [i.dia, i.variables[3]]), [[51, 125000], [
    72,
    155000,
  ]]);
  assertEquals(calcularPlan(ped([["Parches bucales", 3]]), cfg).map((i) => [i.dia, i.variables[3]]), [[76, 155000], [
    109,
    155000,
  ]]);
  // 2 líneas de 1 bolsa suman 2 bolsas
  assertEquals(calcularPlan(ped([["Parche", 1], ["Parche", 1]]), cfg).map((i) => i.dia), [51, 72]);
});

Deno.test("×4 bolsas usa la oferta de ×3 y el calendario de 120 días", () => {
  assertEquals(calcularPlan(ped([["Tiras", 4]]), cfg).map((i) => [i.dia, i.variables[2]]), [
    [102, "el pack de 3 bolsas"],
    [147, "el pack de 3 bolsas"],
  ]);
});

Deno.test("pack tiras + parches: 23 / 34 a 120.000, sin venta cruzada", () => {
  assertEquals(resumen(ped([["Pack Tiras Nasales + Parches Bucales", 1]])), [
    "M1:23:2026-10-24:Ana|tiras y parches|otro pack de tiras y parches|120000",
    "M2:34:2026-11-04:Ana|tiras y parches|el pack de tiras y parches|120000",
  ]);
});

Deno.test("compra única: venta cruzada día 14 con el afín; sin M1 ni M2", () => {
  assertEquals(resumen(ped([["Raspador de lengua", 1]])), [
    "CRUZADA:14:2026-10-15:Ana|raspador de lengua|parches bucales|79000",
  ]);
  assertEquals(resumen(ped([["Botella flexible", 1]])).length, 1);
  assertEquals(calcularPlan(ped([["Ejercitador JawFlex", 1]]), cfg)[0].variables[2], "botella");
  // si el afín vino en el mismo pedido no se ofrece: solo el calendario del consumible
  assertEquals(calcularPlan(ped([["Raspador", 1], ["Parches", 1]]), cfg).map((i) => i.tipo), ["M1", "M2"]);
  // producto que no está en la config: nada
  assertEquals(calcularPlan(ped([["Gorra", 1]]), cfg), []);
});

Deno.test("dos consumibles: manda el que se termina antes; sin nombre usa nombre_si_falta", () => {
  const p = calcularPlan(ped([["Tiras", 1], ["Parches", 2]], null), cfg);
  assertEquals(p.map((i) => [i.producto_clave, i.dia, i.variables[0]]), [["tiras", 23, "de nuevo"], [
    "tiras",
    34,
    "de nuevo",
  ]]);
});

Deno.test("sin semilla (config vacía) no planifica nada", () => {
  assertEquals(calcularPlan(ped([["Tiras", 1]]), configDesdeValor(null)), []);
});

Deno.test("el día 0 es el día local de Asunción, no el de UTC", () => {
  // 02:00 UTC del 2-oct = 23:00 del 1-oct en Asunción
  assertEquals(diaLocalMas(new Date("2026-10-02T02:00:00Z"), 0), "2026-10-01");
  assertEquals(instanteLocal("2026-10-06", 9).toISOString(), "2026-10-06T12:00:00.000Z");
});

Deno.test("recompró: pedido posterior no cancelado del mismo producto", () => {
  const o = { shopify_order_id: 1, entregado_en: ENTREGA };
  const otro = (id: number, iso: string, cancelado: boolean, tiene: string[]) => ({
    shopify_order_id: id,
    creado_en: new Date(iso),
    cancelado,
    tiene: new Set(tiene),
  });
  assert(recompro(o, "tiras", [otro(2, "2026-10-20T10:00:00Z", false, ["tiras"])]));
  assert(!recompro(o, "tiras", [otro(2, "2026-10-20T10:00:00Z", true, ["tiras"])]));
  assert(!recompro(o, "tiras", [otro(2, "2026-09-20T10:00:00Z", false, ["tiras"])]));
  assert(!recompro(o, "tiras", [otro(2, "2026-10-20T10:00:00Z", false, ["raspador"])]));
});

Deno.test("lanzamiento: solo al segmento afín y no a quien ya lo tiene", () => {
  const items = planLanzamiento(
    {
      clave: "nuevo",
      nombre: "el producto nuevo",
      precio_cliente: 99000,
      fecha_hasta: "31 de octubre",
      dia_objetivo: "2026-10-10",
      segmento: ["tiras"],
    },
    [
      { cliente_id: "a", shopify_order_id: 1, tiene: new Set(["tiras"]) },
      { cliente_id: "b", shopify_order_id: 2, tiene: new Set(["raspador"]) },
      { cliente_id: "c", shopify_order_id: 3, tiene: new Set(["tiras", "nuevo"]) },
    ],
    cfg,
  );
  assertEquals(items.map((i) => [i.cliente_id, i.clave_unica, i.variables.join("|")]), [
    ["a", "lz:nuevo:a", "el producto nuevo|99000|31 de octubre"],
  ]);
});

// ─── Topes ───
const AHORA = new Date("2026-10-20T12:00:00Z");
const HOY = "2026-10-20";
const msj = (iso: string, leido: boolean): MensajeMk => ({ enviado_en: new Date(iso), leido });

Deno.test("tope: sin consentimiento 'si' queda fuera", () => {
  for (const c of [null, "no", "baja"] as const) {
    const d = evaluarTope(c, [], [], HOY, AHORA, cfg);
    assert(!d.ok && d.fuera, String(c));
  }
  assert(evaluarTope("si", [], [], HOY, AHORA, cfg).ok);
});

Deno.test("tope semana: uno enviado hace 3 días → se corre al día 7", () => {
  const d = evaluarTope("si", [msj("2026-10-17T12:00:00Z", true)], [], HOY, AHORA, cfg);
  assertEquals(d, { ok: false, fuera: false, motivo: "tope_semana", desde: "2026-10-24" });
  // lo que está en cola también cuenta
  const d2 = evaluarTope("si", [], [new Date("2026-10-20T12:00:00Z")], HOY, AHORA, cfg);
  assert(!d2.ok && !d2.fuera && d2.motivo === "tope_semana");
  // hace 7 días ya se puede
  assert(evaluarTope("si", [msj("2026-10-13T12:00:00Z", true)], [], HOY, AHORA, cfg).ok);
});

Deno.test("tope mes: 3 en el mes → al 1 del mes siguiente", () => {
  const ms = [msj("2026-10-01T12:00:00Z", true), msj("2026-10-06T12:00:00Z", true), msj("2026-10-12T12:00:00Z", true)];
  assertEquals(evaluarTope("si", ms, [], HOY, AHORA, cfg), {
    ok: false,
    fuera: false,
    motivo: "tope_mes",
    desde: "2026-11-01",
  });
  assertEquals(evaluarTope("si", ms.slice(0, 2), [], HOY, AHORA, cfg), {
    ok: true,
    sin_leer_seguidos: 0,
    enviados_mes: 2,
  });
});

Deno.test("tope: 2 sin leer seguidos baja a 1 por mes; uno leído en el medio lo resetea", () => {
  const ms = [msj("2026-10-02T12:00:00Z", false), msj("2026-09-20T12:00:00Z", false)];
  assertEquals(evaluarTope("si", ms, [], HOY, AHORA, cfg), {
    ok: false,
    fuera: false,
    motivo: "tope_mes_reducido_sin_leer",
    desde: "2026-11-01",
  });
  const ms2 = [msj("2026-10-02T12:00:00Z", false), msj("2026-09-20T12:00:00Z", true)];
  assertEquals(evaluarTope("si", ms2, [], HOY, AHORA, cfg), { ok: true, sin_leer_seguidos: 1, enviados_mes: 1 });
});

Deno.test("tope: 60 días sin leer → sale de la lista", () => {
  const ms = [
    msj("2026-09-15T12:00:00Z", false),
    msj("2026-08-15T12:00:00Z", false),
    msj("2026-06-01T12:00:00Z", true),
  ];
  const d = evaluarTope("si", ms, [], HOY, AHORA, cfg);
  assertEquals(d, { ok: false, fuera: true, motivo: "sin_leer_60_dias" });
  // 59 días: todavía no
  const d2 = evaluarTope("si", [msj("2026-08-22T13:00:00Z", false)], [], HOY, AHORA, cfg);
  assert(d2.ok);
});

Deno.test("baja por texto: BAJA y 'No quiero ofertas' (sin importar tildes ni signos)", () => {
  for (const t of ["BAJA", " baja ", "No quiero ofertas", "no quiero ofertas!", "No quiero más ofertas"]) {
    assert(esPedidoDeBaja(t, cfg.palabras_baja), t);
  }
  for (const t of ["bajá el precio", "quiero ofertas", "la baja del dólar"]) {
    assert(!esPedidoDeBaja(t, cfg.palabras_baja), t);
  }
});
