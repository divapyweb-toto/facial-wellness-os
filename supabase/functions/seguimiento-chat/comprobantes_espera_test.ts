// 29-10: comprobantes en espera del cruce automático con ueno (datos inventados).
import { assertEquals } from "jsr:@std/assert@1";
import { type DepsEspera, type Pendiente, procesarComprobantesEspera } from "./comprobantes_espera.ts";

const ahora = new Date("2026-10-29T15:00:00Z");
const fila = (pedido: string, vence: string): Pendiente => ({
  id: `m-${pedido}`, contenido: { storage_path: `comprobantes/c/${pedido}.jpg` }, aviso: { pedido, etiqueta: `#${pedido}`, total: "112.000", vence },
});

function deps(pedidos: Record<string, { tags: string[]; cancelado?: boolean } | null>, auto: string[] = [], telegramOk = true) {
  const avisados: string[] = [], marcados: Array<[string, string]> = [];
  const d: DepsEspera = {
    ahora,
    pedido: (id) => Promise.resolve(pedidos[id] ? { tags: pedidos[id]!.tags, raw: {}, cancelado: !!pedidos[id]!.cancelado } : null),
    verificadoAuto: (id) => Promise.resolve(auto.includes(id)),
    avisar: (p) => (avisados.push(p.aviso.pedido), Promise.resolve(telegramOk ? { ok: true } : { ok: false, error: "x" })),
    marcar: (p, r) => (marcados.push([p.aviso.pedido, String(r.estado)]), Promise.resolve()),
  };
  return { d, avisados, marcados };
}

Deno.test("comprobante vencido y sin pagar → UN aviso y queda marcado; todavía no vence → espera", async () => {
  const { d, avisados, marcados } = deps({ "1": { tags: ["OFERTA_PAGO_ANTICIPADO"] }, "2": { tags: [] } });
  const r = await procesarComprobantesEspera([fila("1", "2026-10-29T14:59:00Z"), fila("2", "2026-10-29T15:20:00Z")], d);
  assertEquals([r.avisados, r.esperando], [1, 1]);
  assertEquals(avisados, ["1"]);
  assertEquals(marcados, [["1", "avisado"]]);
});

Deno.test("ya pagado (tag PAGO_VERIFICADO o lo cruzó la tarea de ueno) → sin aviso; cancelado → se cierra", async () => {
  const { d, avisados, marcados } = deps({ "1": { tags: ["PAGO_VERIFICADO"] }, "2": { tags: [] }, "3": { tags: [], cancelado: true } }, ["2"]);
  const r = await procesarComprobantesEspera([fila("1", "2026-10-29T14:00:00Z"), fila("2", "2026-10-29T14:00:00Z"), fila("3", "2026-10-29T14:00:00Z")], d);
  assertEquals([r.pagados, r.cancelados, r.avisados], [2, 1, 0]);
  assertEquals(avisados, []);
  assertEquals(marcados, [["1", "pagado"], ["2", "pagado"], ["3", "pedido_cancelado_o_sin_pedido"]]);
});

Deno.test("Telegram falla → no se marca (se reintenta en la próxima corrida)", async () => {
  const { d, marcados } = deps({ "1": { tags: [] } }, [], false);
  const r = await procesarComprobantesEspera([fila("1", "2026-10-29T14:00:00Z")], d);
  assertEquals([r.avisados, r.fallas.length, marcados.length], [0, 1, 0]);
});
