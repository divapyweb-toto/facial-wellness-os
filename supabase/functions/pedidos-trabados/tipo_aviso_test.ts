// 26-11 · Tipo de aviso a la transportadora: a Lucero solo lo esencial (datos inventados).
import { assert, assertEquals } from "@std/assert";
import type { CasoCourier } from "../_shared/casos_courier.ts";
import { agruparPorTipo, type DatosPedidoCaso, type DepsCasos, enviarCasos, type EnvioCasos, tipoAvisoCaso } from "./casos_courier_envio.ts";
import type { CanalCourier } from "../_shared/aviso_courier_wa.ts";

const py = (f: string) => new Date(`${f}:00-03:00`);
const AHORA = py("2026-11-26T14:05"); // jueves
let n = 0;
const C = (o: Partial<CasoCourier> = {}): CasoCourier => ({
  id: `t${++n}`, creado_en: py("2026-11-26T09:00").toISOString(), shopify_order_id: 7000 + n, ref: `VT-70${String(n).padStart(2, "0")}`,
  courier: "lucero", origen: "bot", tipo: "coordinar", pide: "Pide que el repartidor lo llame antes", horario: null, referencia: null, recibe: null,
  urgente: false, estado: "pendiente", enviado_en: null, lote: null, cliente_id: null, conversacion_id: null, ...o,
});
const D = (o: Partial<DatosPedidoCaso> = {}): DatosPedidoCaso => ({
  nombre: "Ana Prueba", ciudad: "Luque", fechaIngreso: "2026-11-20", guiaPap: null, estadoCourier: "Aceptado", categoria: "en_proceso", noEncontrada: false, ...o,
});

Deno.test("tipoAvisoCaso: cancelación, pagado, dirección, reclamo vencido y otro", () => {
  assertEquals(tipoAvisoCaso(C({ pide: "Ya no lo quiere, cancelar el envío" }), D(), AHORA), "cancelacion");
  assertEquals(tipoAvisoCaso(C({ pide: "Ya pagó por transferencia: no cobrar" }), D(), AHORA), "pagado_sin_cobro");
  assertEquals(tipoAvisoCaso(C({ pide: "Cambió la dirección: ahora es otra calle en Luque" }), D(), AHORA), "direccion");
  assertEquals(tipoAvisoCaso(C({ pide: "Pasa otro número de teléfono para coordinar" }), D(), AHORA), "direccion");
  // reclamo con ingreso el 20-11 (vie): 23, 24, 25, 26 = 4 días hábiles > 3 → vencido
  assertEquals(tipoAvisoCaso(C({ tipo: "reclamo", pide: "No le llegó y lo necesita" }), D(), AHORA), "reclamo_vencido");
  // con 3 días hábiles o menos, no
  assertEquals(tipoAvisoCaso(C({ tipo: "reclamo", pide: "No le llegó" }), D({ fechaIngreso: "2026-11-23" }), AHORA), "otro");
  // ya entregado, sin fecha o ya reclamado → otro
  assertEquals(tipoAvisoCaso(C({ tipo: "reclamo", pide: "No le llegó" }), D({ categoria: "entregado" }), AHORA), "otro");
  assertEquals(tipoAvisoCaso(C({ tipo: "reclamo", pide: "No le llegó" }), D({ fechaIngreso: null }), AHORA), "otro");
  const c = C({ tipo: "reclamo", pide: "No le llegó" });
  assertEquals(tipoAvisoCaso(c, D(), AHORA, new Set([c.ref])), "otro");
  // el caso real de VT-1261 (que el repartidor llame / escriba) NO es esencial
  assertEquals(tipoAvisoCaso(C({ pide: "Va a estar en reunión hoy; pide que el repartidor le escriba por mensaje" }), D(), AHORA), "otro");
  assertEquals(tipoAvisoCaso(C({ pide: "No está en el lugar; pide que el repartidor lo llame para coordinar la entrega" }), D(), AHORA), "otro");
});

Deno.test("agruparPorTipo: orden fijo y un pedido no lleva dos reclamos vencidos en el mismo lote", () => {
  const r1 = C({ ref: "VT-7999", tipo: "reclamo", pide: "No le llegó" });
  const r2 = C({ ref: "VT-7999", tipo: "reclamo", pide: "Sigue sin llegar" });
  const otro = C(), dir = C({ pide: "Corrige la dirección" });
  const g = agruparPorTipo([otro, r1, dir, r2], new Map([["VT-7999", D()]]), AHORA);
  assertEquals(g.map((x) => [x.tipo, x.casos.map((c) => c.id)]), [["direccion", [dir.id]], ["reclamo_vencido", [r1.id]], ["otro", [otro.id, r2.id]]]);
});

function depsCon(esencial: (tipo?: string) => boolean) {
  const enviadosWa: Array<{ tipo?: string; clave: string; texto: string }> = [], telegram: string[] = [], marcados: string[] = [];
  const canal: CanalCourier = {
    activo: true,
    enviar: (a) => {
      if (!esencial(a.tipo)) return Promise.resolve({ ok: false, error: "no_esencial" });
      enviadosWa.push({ tipo: a.tipo, clave: a.clave, texto: a.texto });
      return Promise.resolve({ ok: true });
    },
  };
  const candados = new Set<string>();
  const d: DepsCasos = {
    tomarCandado: (id) => Promise.resolve(candados.has(id) ? false : (candados.add(id), true)),
    soltarCandado: (id) => Promise.resolve(void candados.delete(id)),
    existeCandado: (id) => Promise.resolve(candados.has(id)),
    avisar: (texto) => { telegram.push(texto); return Promise.resolve({ ok: true }); },
    esperar: () => Promise.resolve(),
    marcarEnviados: (cs) => Promise.resolve(void cs.forEach((c) => marcados.push(c.id))),
    canalCourier: canal,
  };
  return { d, enviadosWa, telegram, marcados };
}
const ESENCIALES = new Set(["cancelacion", "direccion", "pagado_sin_cobro", "reclamo_vencido"]);

Deno.test("lote de Lucero: los esenciales van por WhatsApp con su tipo; lo demás sale por Telegram; todos quedan enviados", async () => {
  const dir = C({ pide: "Corrige la dirección: casa verde" }), otro = C(), rec = C({ tipo: "reclamo", pide: "No le llegó" });
  const datos = new Map([dir, otro, rec].map((c) => [c.ref, D()]));
  const e: EnvioCasos = { clave: "auto_casos_courier:2026-11-26:pm:lucero", lote: "2026-11-26:pm:lucero", courier: "lucero", urgente: false, casos: [dir, otro, rec], conRendiciones: false };
  const x = depsCon((t) => ESENCIALES.has(String(t)));
  const h = await enviarCasos([e], datos, [], AHORA, x.d);
  assertEquals(h[0].resultado, "enviado");
  assertEquals(x.enviadosWa.map((w) => [w.tipo, w.clave]), [["direccion", "casos:2026-11-26:pm:lucero:direccion:1"], ["reclamo_vencido", "casos:2026-11-26:pm:lucero:reclamo_vencido:1"]]);
  assert(x.enviadosWa[0].texto.includes(dir.ref) && !x.enviadosWa[0].texto.includes(otro.ref));
  assertEquals(x.telegram.length, 1); // solo el "otro"
  assert(x.telegram[0].includes(otro.ref) && !x.telegram[0].includes(dir.ref));
  assertEquals(x.marcados.sort(), [dir.id, otro.id, rec.id].sort());
});

Deno.test("reclamo ya mandado antes (yaReclamados) → no va por WhatsApp; PaP sigue en un solo aviso sin tipo", async () => {
  const rec = C({ tipo: "reclamo", pide: "No le llegó" });
  const x = depsCon((t) => ESENCIALES.has(String(t)));
  x.d.yaReclamados = new Set([rec.ref]);
  await enviarCasos([{ clave: "k1", lote: "L1", courier: "lucero", urgente: false, casos: [rec], conRendiciones: false }], new Map([[rec.ref, D()]]), [], AHORA, x.d);
  assertEquals([x.enviadosWa.length, x.telegram.length], [0, 1]);
  const p1 = C({ courier: "pap" }), p2 = C({ courier: "pap", pide: "Corrige la dirección" });
  const y = depsCon(() => true);
  await enviarCasos([{ clave: "k2", lote: "L2", courier: "pap", urgente: false, casos: [p1, p2], conRendiciones: false }], new Map([p1, p2].map((c) => [c.ref, D()])), [], AHORA, y.d);
  assertEquals(y.enviadosWa.map((w) => [w.tipo, w.clave]), [[undefined, "casos:L2:1"]]);
});
