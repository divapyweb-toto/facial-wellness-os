// Pruebas de pagos_ranking.ts. Datos inventados (repo público).
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  avisoCandidatos,
  callbackEsEste,
  type CandidatoPago,
  haceCuanto,
  palabrasEnComun,
  rankearCandidatos,
  refTransferencia,
  type TransferenciaRecibida,
} from "./pagos_ranking.ts";

const TRANSF: TransferenciaRecibida = { monto: 112000, fecha: "2026-10-29T18:30:00Z", banco: "Banco Prueba" };

let n = 0;
function cand(o: Partial<CandidatoPago> = {}): CandidatoPago {
  n++;
  return {
    shopify_order_id: 90000000000000 + n,
    pedido: `#${2000 + n}`,
    monto_pendiente: 112000,
    total: 112000,
    ciudad: "Ciudad Prueba",
    creado_en: `2026-10-${String(10 + (n % 15)).padStart(2, "0")}T12:00:00Z`,
    tags: ["CONFIRMADO", "OFERTA_PAGO_ANTICIPADO"],
    telefono: `+59598100${String(1000 + n).slice(-4)}`,
    nombresCliente: [`Cliente${n} Apellido${n}`],
    comprobanteChatEn: null,
    ...o,
  };
}

/** 17 pedidos esperando Gs 112.000, como el 29-10. */
function diecisiete(extra: Partial<CandidatoPago>[] = []): CandidatoPago[] {
  const l = Array.from({ length: 17 - extra.length }, () => cand());
  return [...extra.map((e) => cand(e)), ...l];
}

Deno.test("ranking: caso #1164 (sin titular ni nro.) → el pedido cuyo chat mandó el comprobante ese minuto", () => {
  const lista = diecisiete([
    { pedido: "#1164", shopify_order_id: 91164, creado_en: "2026-10-29T18:24:04Z", comprobanteChatEn: "2026-10-29T18:30:14Z" },
    // Otro comprobante, pero de 3 h antes: fuera de la ventana.
    { pedido: "#1125", shopify_order_id: 91125, creado_en: "2026-10-25T17:12:00Z", comprobanteChatEn: "2026-10-29T15:25:59Z" },
  ]);
  const r = rankearCandidatos(TRANSF, lista);
  assertEquals(r.tipo, "unico");
  if (r.tipo !== "unico") return;
  assertEquals(r.candidato.pedido, "#1164");
  assertEquals(r.senales, ["comprobante"]);
  assertEquals(r.total, 17);
});

Deno.test("ranking: por teléfono del chat que mandó el comprobante (formatos distintos)", () => {
  const lista = diecisiete([{ pedido: "#3001", telefono: "0981 555 444" }]);
  const r = rankearCandidatos({ ...TRANSF, telefonoChat: "+595981555444" }, lista);
  assertEquals(r.tipo, "unico");
  if (r.tipo === "unico") {
    assertEquals(r.candidato.pedido, "#3001");
    assertEquals(r.senales, ["telefono"]);
  }
});

Deno.test("ranking: el teléfono gana aunque el titular apunte a otro", () => {
  const lista = diecisiete([
    { pedido: "#3001", telefono: "0981555444" },
    { pedido: "#3002", nombresCliente: ["María José Gómez"] },
  ]);
  const r = rankearCandidatos({ ...TRANSF, telefonoChat: "0981555444", titular: "GOMEZ MARIA JOSE" }, lista);
  assertEquals(r.tipo === "unico" && r.candidato.pedido, "#3001");
});

Deno.test("ranking: por titular (tildes, mayúsculas y orden distinto, 2+ palabras)", () => {
  const lista = diecisiete([{ pedido: "#3003", nombresCliente: ["José Luis Fernández", "Josesito"] }]);
  const r = rankearCandidatos({ ...TRANSF, titular: "FERNANDEZ JOSE" }, lista);
  assertEquals(r.tipo, "unico");
  if (r.tipo === "unico") assertEquals([r.candidato.pedido, r.senales], ["#3003", ["titular"]]);
  // Una sola palabra en común no alcanza.
  assertEquals(rankearCandidatos({ ...TRANSF, titular: "FERNANDEZ" }, lista).tipo, "ambiguo");
  assertEquals(palabrasEnComun("ÁVALOS, Ana-María", ["ana maria avalos"]), 3);
});

Deno.test("ranking: dos con comprobante → desempata el titular", () => {
  const lista = diecisiete([
    { pedido: "#3004", comprobanteChatEn: "2026-10-29T18:20:00Z", nombresCliente: ["Pedro Prueba Uno"] },
    { pedido: "#3005", comprobanteChatEn: "2026-10-29T18:35:00Z", nombresCliente: ["Rosa Prueba Dos"] },
  ]);
  const r = rankearCandidatos({ ...TRANSF, titular: "ROSA DOS" }, lista);
  assertEquals(r.tipo === "unico" && r.candidato.pedido, "#3005");
  assertEquals(r.tipo === "unico" && r.senales, ["comprobante", "titular"]);
});

Deno.test("ranking: ambiguo → 3 candidatos con botón Es este, el más reciente con oferta primero", () => {
  const lista = [
    cand({ pedido: "#4001", creado_en: "2026-10-20T10:00:00Z" }),
    cand({ pedido: "#4002", creado_en: "2026-10-29T10:00:00Z", ciudad: "Luque" }),
    cand({ pedido: "#4003", creado_en: "2026-10-28T10:00:00Z", tags: ["SIN_COBERTURA"] }),
    cand({ pedido: "#4004", creado_en: "2026-10-27T10:00:00Z" }),
    cand({ pedido: "#4005", creado_en: "2026-10-26T10:00:00Z", monto_pendiente: 153000 }), // otro monto: afuera
    cand({ pedido: "#4006", creado_en: "2026-10-29T11:00:00Z", tags: ["OFERTA_PAGO_ANTICIPADO", "PAGADO"] }), // ya pagado
  ];
  const r = rankearCandidatos(TRANSF, lista);
  assertEquals(r.tipo, "ambiguo");
  if (r.tipo !== "ambiguo") return;
  assertEquals(r.total, 4);
  // Con OFERTA_PAGO_ANTICIPADO antes que sin ella; entre iguales, el más reciente.
  assertEquals(r.top.map((e) => e.candidato.pedido), ["#4002", "#4004", "#4001"]);
  const a = avisoCandidatos(TRANSF, r, new Date("2026-10-29T18:40:00Z"));
  assertStringIncludes(a.texto, "Gs 112.000 (29-10 15:30, sin nro. de transacción, Banco Prueba)");
  assertStringIncludes(a.texto, "hay 4 pedidos esperando ese monto");
  assertStringIncludes(a.texto, "1. <b>#4002</b> · Gs 112.000 · Luque · hace 9 h");
  assertEquals(a.botones.length, 3);
  assertEquals(a.botones[0][0].texto, "Es este: #4002");
  assertMatch(a.botones[0][0].callback!, /^es_este:\d+:t2610291530$/);
  // Sin teléfonos ni nombres en el aviso.
  assert(!/\+595|Cliente\d|Apellido/.test(a.texto));
});

Deno.test("ranking: un solo pedido con ese monto pero sin señal → no se marca solo (ambiguo con 1)", () => {
  const r = rankearCandidatos(TRANSF, [cand({ pedido: "#4100" })]);
  assertEquals(r.tipo, "ambiguo");
  if (r.tipo !== "ambiguo") return;
  const a = avisoCandidatos(TRANSF, r, new Date("2026-10-29T18:40:00Z"));
  assertStringIncludes(a.texto, "hay 1 pedido esperando");
  assertEquals(a.botones.length, 1);
});

Deno.test("ranking: nadie espera ese monto → ninguno", () => {
  assertEquals(rankearCandidatos({ ...TRANSF, monto: 99000 }, diecisiete()).tipo, "ninguno");
});

Deno.test("callback es_este: entra en 64 bytes y la ref sale del nro. de transacción", () => {
  const ref = refTransferencia({ ...TRANSF, nro_transaccion: "TX-0000123456789012345678" });
  assertEquals(ref, "00123456789012345678");
  const cb = callbackEsEste(18997437268051, ref);
  assertEquals(cb, "es_este:18997437268051:00123456789012345678");
  assert(new TextEncoder().encode(cb).length <= 64);
  assertEquals(callbackEsEste(1, "<>"), "es_este:1:sinref");
  assertEquals(haceCuanto("2026-10-27T18:40:00Z", new Date("2026-10-29T18:40:00Z")), "hace 2 días");
});
