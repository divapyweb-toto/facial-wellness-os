// 29-10: clasificador de comprobantes y espera del cruce con ueno.
import { assertEquals } from "jsr:@std/assert@1";
import { clasificarComprobante, decidirEspera, fechaComprobante, interpretarClasificacion, venceEspera } from "./comprobante.ts";
import type { PedidoClaude, RespuestaClaude } from "./claude.ts";

Deno.test("interpretarClasificacion: JSON con texto alrededor, monto con puntos; basura → null", () => {
  assertEquals(interpretarClasificacion('Listo: {"es_comprobante": true, "monto": "112.000", "motivo": "transferencia ueno"}').es, true);
  assertEquals(interpretarClasificacion('{"es_comprobante": true, "monto": "112.000"}').monto, 112000);
  assertEquals(interpretarClasificacion('{"es_comprobante": false, "monto": null, "motivo": "captura de anuncio"}'), { es: false, monto: null, motivo: "captura de anuncio" });
  assertEquals(interpretarClasificacion("no sé").es, null);
  assertEquals(interpretarClasificacion('{"es_comprobante": "quizás"}').es, null);
});

Deno.test("clasificarComprobante: si Claude falla, es=null (se sigue como antes)", async () => {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } };
  const ok = (t: string) => (_: PedidoClaude) => Promise.resolve({ contenido: [{ type: "text", text: t }], stop_reason: "end_turn", uso: {} as never, costo_usd: 0.002, simulado: false, modelo: "h" } as RespuestaClaude);
  assertEquals((await clasificarComprobante(img, ok('{"es_comprobante": false, "motivo": "chat"}'))).es, false);
  assertEquals((await clasificarComprobante(img, () => Promise.reject(new Error("529")))).es, null);
});

Deno.test("venceEspera: 40 min de día; de noche se corre a las 7:40 de Asunción", () => {
  // 12:17 PY = 15:17 UTC → 12:57 PY.
  assertEquals(venceEspera(new Date("2026-10-29T15:17:00Z")).toISOString(), "2026-10-29T15:57:00.000Z");
  // 20:40 PY → 21:20 PY (fuera) → 7:40 PY del día siguiente = 10:40 UTC.
  assertEquals(venceEspera(new Date("2026-10-29T23:40:00Z")).toISOString(), "2026-10-30T10:40:00.000Z");
  // 02:00 PY (05:00 UTC) → 02:40 fuera → 7:40 del mismo día.
  assertEquals(venceEspera(new Date("2026-10-30T05:00:00Z")).toISOString(), "2026-10-30T10:40:00.000Z");
});

Deno.test("decidirEspera", () => {
  const vence = new Date("2026-10-29T15:57:00Z");
  assertEquals(decidirEspera({ pagado: true, vence, ahora: new Date("2026-10-29T15:00:00Z") }), "pagado");
  assertEquals(decidirEspera({ pagado: false, vence, ahora: new Date("2026-10-29T15:00:00Z") }), "esperar");
  assertEquals(decidirEspera({ pagado: false, vence, ahora: new Date("2026-10-29T16:00:00Z") }), "avisar");
});

Deno.test("29-10 extracción con un modelo falso: nro., referencias, titular, banco y hora de Asunción → ISO", async () => {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } };
  const pedidos: PedidoClaude[] = [];
  const falso = (p: PedidoClaude) => (pedidos.push(p), Promise.resolve({
    contenido: [{ type: "text", text: '```json\n{"es_comprobante": true, "monto": "Gs. 112.000", "motivo": "transferencia", "nro_transaccion": " 000123456789 ", "referencias": ["SIPAP 998877", null, ""], "titular": "PERSONA PRUEBA", "banco": "Banco Prueba", "fecha_hora": "2026-10-29 15:30"}\n```' }],
    stop_reason: "end_turn", uso: {} as never, costo_usd: 0.003, simulado: false, modelo: "h",
  } as RespuestaClaude));
  const r = await clasificarComprobante(img, falso);
  assertEquals([r.es, r.monto], [true, 112000]);
  assertEquals(r.datos, { nro_transaccion: "000123456789", referencias: ["SIPAP 998877"], titular: "PERSONA PRUEBA", banco: "Banco Prueba", fecha: "2026-10-29T18:30:00.000Z" });
  // Un solo pedido al modelo, con la imagen y el prompt que pide JSON.
  assertEquals(pedidos.length, 1);
  const contenido = pedidos[0].mensajes[0].content as { type: string; text?: string }[];
  assertEquals(contenido[0].type, "image");
  assertEquals(/nro_transaccion/.test(contenido[1].text ?? ""), true);
  // Sin datos (solo clasificación): no aparece la clave datos.
  assertEquals("datos" in interpretarClasificacion('{"es_comprobante": true, "monto": 5000, "nro_transaccion": null, "referencias": []}'), false);
  assertEquals(fechaComprobante("29/10/2026 9:05"), "2026-10-29T12:05:00.000Z");
  assertEquals(fechaComprobante("ayer"), null);
});
