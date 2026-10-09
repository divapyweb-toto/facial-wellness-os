// Pruebas de alerta-despachos (datos inventados).
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  atrasados,
  type DepsAlerta,
  ejecutarAlerta,
  fechaDespacho,
  type PedidoDespacho,
  referenciaVT,
  textoAviso,
} from "./logica.ts";

// Asunción = UTC-3.
const AHORA = new Date("2026-10-20T08:00:00-03:00");
const haceDias = (d: number, h = 0) => new Date(AHORA.getTime() - (d * 24 + h) * 3_600_000).toISOString();

function ped(id: number, extra: Partial<PedidoDespacho> = {}): PedidoDespacho {
  return { shopify_order_id: 900000 + id, nombre: `#${id}`, fulfilled_en: null, estados: [], ...extra };
}

function deps(pedidos: PedidoDespacho[], o: { ultimo?: string | null; ok?: boolean } = {}) {
  const enviados: string[] = [];
  const guardados: string[] = [];
  const d: DepsAlerta = {
    ahora: () => AHORA,
    pedidos: () => Promise.resolve(pedidos),
    ultimoAviso: () => Promise.resolve(o.ultimo ?? null),
    guardarAviso: (dia) => {
      guardados.push(dia);
      return Promise.resolve();
    },
    avisar: (t) => {
      enviados.push(t);
      return Promise.resolve(o.ok === false ? { ok: false, error: "caído" } : { ok: true });
    },
  };
  return { d, enviados, guardados };
}

Deno.test("referenciaVT: #1003 → VT-1003, ceros y prefijo", () => {
  assertEquals(referenciaVT("#1003"), "VT-1003");
  assertEquals(referenciaVT("VT-01003"), "VT-1003");
  assertEquals(referenciaVT(null), null);
  assertEquals(referenciaVT("sin numero"), null);
});

Deno.test("fecha de despacho: la más temprana entre fulfillment y estados", () => {
  const p = ped(1, {
    fulfilled_en: haceDias(3),
    estados: [{ estado: "EN_PREPARACION", creado_en: haceDias(6) }, { estado: "DESPACHADO", creado_en: haceDias(4) }],
  });
  assertEquals(fechaDespacho(p), new Date(haceDias(6)).getTime());
  assertEquals(fechaDespacho(ped(2)), null);
});

Deno.test("atrasados: >5 días sin estado final; finales y recientes no entran", () => {
  const lista = atrasados([
    ped(1001, { fulfilled_en: haceDias(7) }), // atrasado 7 d
    ped(1002, { fulfilled_en: haceDias(4) }), // reciente
    ped(1003, { estados: [{ estado: "DESPACHADO", creado_en: haceDias(6) }] }), // atrasado 6 d
    ped(1004, { fulfilled_en: haceDias(9), estados: [{ estado: "ENTREGADO", creado_en: haceDias(1) }] }),
    ped(1005, { fulfilled_en: haceDias(9), estados: [{ estado: "NO_ENTREGADO", creado_en: haceDias(1) }] }),
    ped(1006, { fulfilled_en: haceDias(9), estados: [{ estado: "RENDIDO", creado_en: haceDias(1) }] }),
    ped(1007, { fulfilled_en: haceDias(9), estados: [{ estado: "CANCELADO", creado_en: haceDias(1) }] }),
    ped(1008), // nunca despachado
    ped(1009, { estados: [{ estado: "INTENTO_FALLIDO", creado_en: haceDias(2) }, { estado: "EN_PREPARACION", creado_en: haceDias(8) }] }),
  ], AHORA);
  assertEquals(lista.map((a) => a.referencia), ["VT-1009", "VT-1001", "VT-1003"]);
  assertEquals(lista.map((a) => a.dias), [8, 7, 6]);
});

Deno.test("borde: exactamente 5 días no avisa; 5 días y 1 h sí", () => {
  assertEquals(atrasados([ped(1, { fulfilled_en: haceDias(5) })], AHORA).length, 0);
  assertEquals(atrasados([ped(1, { fulfilled_en: haceDias(5, 1) })], AHORA).length, 1);
});

Deno.test("texto: cantidad, referencias y recorte a 30", () => {
  const una = textoAviso([{ shopify_order_id: 1, referencia: "VT-1001", despachado_en: "", dias: 7 }]);
  assertStringIncludes(una, "1 pedido despachado hace más de 5 días");
  assertStringIncludes(una, "VT-1001 (7 d)");
  const muchas = textoAviso(
    Array.from({ length: 35 }, (_, i) => ({ shopify_order_id: i, referencia: `VT-${2000 + i}`, despachado_en: "", dias: 6 })),
  );
  assertStringIncludes(muchas, "35 pedidos");
  assertStringIncludes(muchas, "y 5 más");
  assert(!muchas.includes("VT-2034"));
});

Deno.test("ejecutar: avisa una vez y guarda el día local", async () => {
  const { d, enviados, guardados } = deps([ped(1001, { fulfilled_en: haceDias(7) })]);
  const r = await ejecutarAlerta(d);
  assertEquals(r.accion, "avisado");
  assertEquals(r.referencias, ["VT-1001"]);
  assertEquals(enviados.length, 1);
  assertEquals(guardados, ["2026-10-20"]);
});

Deno.test("ejecutar: ya avisado hoy → no manda", async () => {
  const { d, enviados } = deps([ped(1001, { fulfilled_en: haceDias(7) })], { ultimo: "2026-10-20" });
  assertEquals((await ejecutarAlerta(d)).accion, "ya_avisado_hoy");
  assertEquals(enviados.length, 0);
});

Deno.test("ejecutar: sin atrasados → no manda ni guarda", async () => {
  const { d, enviados, guardados } = deps([ped(1001, { fulfilled_en: haceDias(2) })], { ultimo: "2026-10-19" });
  assertEquals((await ejecutarAlerta(d)).accion, "sin_atrasados");
  assertEquals(enviados.length + guardados.length, 0);
});

Deno.test("ejecutar: Telegram falla → error y no guarda (reintenta)", async () => {
  const { d, guardados } = deps([ped(1001, { fulfilled_en: haceDias(7) })], { ok: false });
  await assertRejects(() => ejecutarAlerta(d), Error, "Telegram");
  assertEquals(guardados.length, 0);
});
