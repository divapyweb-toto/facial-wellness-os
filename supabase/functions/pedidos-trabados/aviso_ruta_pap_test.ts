import { assertEquals } from "@std/assert";
import { claveRuta, decidirRuta, type CandidatoRuta } from "./aviso_ruta_pap.ts";

const AHORA = new Date("2026-10-19T15:00:00Z");
const c = (o: Partial<CandidatoRuta> = {}): CandidatoRuta => ({
  shopifyOrderId: 1, clienteId: "c", nombre: "Ana", total: 112000, estadoConfirmacion: "confirmado", estadoEnvio: "DESPACHADO",
  tags: [], cancelado: false, envios: [], ...o,
});
Deno.test("aviso de ruta PaP: una sola vez, solo confirmados vigentes", () => {
  assertEquals(decidirRuta(c(), AHORA), { accion: "enviar", cancelarProxima: false });
  assertEquals(decidirRuta(c({ envios: [{ clave: claveRuta(1), plantilla: "x", estado: "enviado", creadoEn: "" }] }), AHORA).accion, "omitir");
  assertEquals(decidirRuta(c({ estadoConfirmacion: "pendiente" }), AHORA), { accion: "omitir", motivo: "sin_confirmar" });
  assertEquals(decidirRuta(c({ estadoEnvio: "ENTREGADO" }), AHORA), { accion: "omitir", motivo: "terminal" });
  assertEquals(decidirRuta(c({ cancelado: true }), AHORA), { accion: "omitir", motivo: "cancelado" });
  assertEquals(decidirRuta(c({ tags: ["RETIRO_EN_CASA"] }), AHORA), { accion: "omitir", motivo: "retiro" });
});
Deno.test("reemplaza el 'ya está por llegar' del 2.º día si sigue pendiente; no repite si salió hace < 24 h", () => {
  const prox = (estado: string, creadoEn: string) => [{ clave: "courier:1:ENTREGA_HOY", plantilla: "voltra_entrega_proxima", estado, creadoEn }];
  assertEquals(decidirRuta(c({ envios: prox("pendiente", "2026-10-19T10:00:00Z") }), AHORA), { accion: "enviar", cancelarProxima: true });
  assertEquals(decidirRuta(c({ envios: prox("enviado", "2026-10-19T11:00:00Z") }), AHORA).accion, "registrar_sin_enviar");
  assertEquals(decidirRuta(c({ envios: prox("enviado", "2026-10-17T11:00:00Z") }), AHORA), { accion: "enviar", cancelarProxima: false });
});
