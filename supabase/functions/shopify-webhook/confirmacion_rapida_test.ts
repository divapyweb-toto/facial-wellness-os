// 10-10 confirmación rápida: tiempos nuevos y compatibilidad con la config vieja. Datos inventados.
import { assertEquals } from "jsr:@std/assert@1";
import { armarEnvios, configConfirmacionValida, type PedidoNormalizado } from "./procesar.ts";

const AHORA = new Date("2026-10-10T12:00:00Z");
const ped = { shopifyOrderId: 1001, gid: "gid://shopify/Order/1001", nombre: "#1001", nombreCliente: "ana", productos: "1 Tiras nasales", total: 129000, direccion: "Calle 1", ciudad: "CDE" } as PedidoNormalizado;
const plan = (cfg: Parameters<typeof armarEnvios>[3]) =>
  armarEnvios(ped, "c1", "+595981000000", cfg, AHORA).map((f) => [f.clave_unica, f.plantilla, (new Date(f.enviar_desde).getTime() - AHORA.getTime()) / 60_000]);

Deno.test("config nueva: conf 0, rec 60 min, avi 3 h, ult 24 h, canc 48 h; sin retención", () => {
  assertEquals(plan({ confirmar_min: 0, recordatorio_min: 60, aviso_enrique_h: 3, ultimo_aviso_h: 24, cancelar_h: 48 }), [
    ["conf:1001", "voltra_confirmacion_pedido_v3", 0],
    ["rec:1001", "voltra_recordatorio_confirmacion", 60],
    ["avi:1001", "accion:aviso_enrique", 180],
    ["ult:1001", "voltra_ultimo_aviso_confirmacion", 1440],
    ["canc:1001", "accion:cancelar", 2880],
  ]);
  // Si la pantalla deja retener_h colgado, igual no hay retención; la cancelación nunca antes de 24 h.
  const r = plan({ recordatorio_min: 30, aviso_enrique_h: 3, ultimo_aviso_h: 20, cancelar_h: 10, retener_h: 48 });
  assertEquals(r.map((x) => x[0]), ["conf:1001", "rec:1001", "avi:1001", "ult:1001", "canc:1001"]);
  assertEquals(r[4][2], 1440);
});

Deno.test("config vieja compatible: rec en horas, ret y canc como antes, sin avi/ult", () => {
  assertEquals(plan({ recordatorio_h: 1, retener_h: 48, cancelar_h: 72 }), [
    ["conf:1001", "voltra_confirmacion_pedido_v3", 0],
    ["rec:1001", "voltra_recordatorio_confirmacion", 60],
    ["ret:1001", "accion:retener", 2880],
    ["canc:1001", "accion:cancelar", 4320],
  ]);
  assertEquals(configConfirmacionValida({ recordatorio_h: 1, retener_h: 48, cancelar_h: 72 }), true);
  assertEquals(configConfirmacionValida({ confirmar_min: 0, recordatorio_min: 60, aviso_enrique_h: 3, ultimo_aviso_h: 24, cancelar_h: 48 }), true);
  assertEquals(configConfirmacionValida({ cancelar_h: 48 }), false);
  assertEquals(configConfirmacionValida(null), false);
});
