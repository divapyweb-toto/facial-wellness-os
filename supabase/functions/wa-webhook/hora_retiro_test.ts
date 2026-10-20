// Datos inventados (repo público).
import { assertEquals } from "jsr:@std/assert@1";
import { avisarHoraRetiro, type Deps } from "./procesar.ts";

function deps(saliente: string | null, tags: string[]) {
  const avisos: string[] = [];
  const d = {
    ahora: () => new Date("2026-10-21T12:00:00Z"),
    ultimoSalienteCliente: () => Promise.resolve(saliente === null ? null : { tipo: "text", texto: saliente }),
    pedidosPorEstado: () => Promise.resolve([{ shopify_order_id: 1, nombre: "#1089", estado_confirmacion: "confirmado", tags, raw: {} }]),
    avisar: (t: string) => (avisos.push(t), Promise.resolve()),
  } as unknown as Deps;
  return { d, avisos };
}

const PREGUNTA = "¡Buen día! Tu pack (#1089) ya está listo para retirar. ¿A qué hora más o menos pasás hoy?";

Deno.test("20-10 hora del retiro: respuesta a la pregunta + retiro abierto → Telegram con el pedido y lo que dijo", async () => {
  const { d, avisos } = deps(PREGUNTA, ["CONFIRMADO", "RETIRO_EN_CASA"]);
  assertEquals(await avisarHoraRetiro(d, "c1", "+595981000000", "a las 10 paso"), true);
  assertEquals(avisos.length, 1);
  assertEquals(avisos[0].includes("#1089") && avisos[0].includes("a las 10 paso"), true);
});

Deno.test("20-10 hora del retiro: sin la pregunta o sin retiro, no avisa", async () => {
  assertEquals(await avisarHoraRetiro(deps("Te resumo: …", ["RETIRO_EN_CASA"]).d, "c1", null, "a las 10"), false);
  assertEquals(await avisarHoraRetiro(deps(PREGUNTA, ["CONFIRMADO"]).d, "c1", null, "a las 10"), false);
  assertEquals(await avisarHoraRetiro(deps(null, ["RETIRO_EN_CASA"]).d, "c1", null, "a las 10"), false);
});
