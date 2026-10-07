import { assertEquals } from "@std/assert";
import { aprendizajesDe, convsClasificadas, convsDelLote, idsDelLote, recoleccionParaCiclo, sintesisParaCiclo } from "./enlaces.ts";
import { agregar, type HallazgosSintesis } from "./sintetizar.ts";
import type { ConversacionParaAnalizar, Etiquetas } from "./tipos.ts";

const ETIQ: Etiquetas = {
  etapa: "cierre",
  objecion_principal: "precio alto",
  respuesta_que_movio: "pack de 2",
  errores_bot: [],
  reclamo: { hubo: false, tipo: null, paso_resuelto: null, derivado: false },
  emocion: "satisfecho",
  debio_derivar: false,
};

function conv(id: string): ConversacionParaAnalizar {
  return {
    conversacion_id: id, resultado: "entregado", derivado: false, tuvo_reclamo: false, paso_escalera: null,
    costo_ia_usd: 0, costo_mensajes_usd: 0, n_mensajes: 2, mensajes: [], transcripcion: "C: hola\nV: hola", recortada: false,
  };
}

Deno.test("enlaces: recolectarMes de M1 → {conversaciones, total} de M3 (total es el del mes, no la muestra)", () => {
  const r = recoleccionParaCiclo({ mes: "2026-10-01", total: 340, conversaciones: [conv("a")], recortadas_por_tope: 339, notas: [] });
  assertEquals(r.total, 340);
  assertEquals(r.conversaciones.length, 1);
});

Deno.test("enlaces: sintetizar de M2 → {hallazgos, costo_usd}", () => {
  const h = { costo_usd: 0.12, resumen: "x", conclusiones: ["a", "b", "c", "d"] } as unknown as HallazgosSintesis;
  assertEquals(sintesisParaCiclo(h).costo_usd, 0.12);
  assertEquals(sintesisParaCiclo({ ...h, costo_usd: NaN }).costo_usd, 0);
  assertEquals(aprendizajesDe(h), ["a", "b", "c"]);
  assertEquals(aprendizajesDe({ conclusiones: [], resumen: "solo resumen" }), ["solo resumen"]);
  assertEquals(aprendizajesDe(null), []);
});

Deno.test("enlaces: ids y conversaciones del lote (misma corrida vs corrida siguiente)", () => {
  assertEquals(idsDelLote({ resumen: { muestra_ids: ["a", "", "b"] } }), ["a", "b"]);
  assertEquals(idsDelLote({ resumen: null }), []);
  const muestra = { mes: "2026-09-01", convs: [conv("a")] };
  assertEquals(convsDelLote(muestra, { mes: "2026-09-01" }).length, 1);
  assertEquals(convsDelLote(muestra, { mes: "2026-08-01" }), []);
  assertEquals(convsDelLote(null, { mes: "2026-09-01" }), []);
});

Deno.test("enlaces: clasificaciones + conversacion_resultado → agregar() de M2", () => {
  const filas = Array.from({ length: 12 }, (_, i) => ({ conversacion_id: `id${i}`, etiquetas: ETIQ }));
  const resultados = filas.slice(0, 10).map((f) => ({ conversacion_id: f.conversacion_id, resultado: "entregado" as const, derivado: null }));
  const cs = convsClasificadas(filas, resultados);
  assertEquals(cs[0].resultado, "entregado");
  assertEquals(cs[11].resultado, "sin_compra"); // sin fila en la vista
  assertEquals(cs[0].derivado, false);
  const a = agregar(cs, { mes: "2026-09-01" });
  assertEquals(a.mes, "2026-09-01");
  assertEquals(a.n_conversaciones, 12);
  assertEquals(a.por_objecion["precio alto"].n, 12);
});
