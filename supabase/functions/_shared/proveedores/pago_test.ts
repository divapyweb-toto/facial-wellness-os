// 25-11 · Pruebas del pago por link, el seguimiento y la dirección fija. Datos DEMO (dominios y direcciones inventados).
import { assert, assertEquals } from "@std/assert";
import type { RespuestaClaude } from "../claude.ts";
import {
  type ConfigProveedores, type DepsAgente, type DepositoChina, type EntradaAgente,
  detectarPago, detectarTracking, montoPedido, pideDireccion, responderProveedor, textoCompromete, textoDireccion, textoPostPago,
} from "./agente.ts";

const DEP: DepositoChina = { en: "Demo Warehouse, 1 Demo Road, Shenzhen, China", zh: "深圳市演示路1号演示仓库", marca_maritimo: "DEMO-MAR-1", marca_aereo: "DEMO-AIR-1" };
const CFG: ConfigProveedores = { activo: true, tope_ia_usd_mes: 10, tope_plantillas_mes: 30, modelo: "claude-haiku-4-5", direccion_deposito: null, firma: "Voltra (Paraguay)", deposito: DEP };

const RESP_OK = JSON.stringify({
  traduccion_entrante_es: "x", pide_compromiso: null, responder: true,
  respuesta: "Thank you for the information.\n\nVoltra (Paraguay)", respuesta_es: "Gracias por la información.", cotizacion: null,
});
function deps(opts: { texto?: string; gasto?: number; cfg?: Partial<ConfigProveedores> } = {}) {
  const e = { llamadas: 0 };
  const d: DepsAgente = {
    llamar: () => { e.llamadas++; return Promise.resolve({ contenido: [{ type: "text", text: opts.texto ?? RESP_OK }], stop_reason: "end_turn", uso: { entrada: 1, salida: 1, cache_lectura: 0, cache_escritura: 0 }, costo_usd: 0.001, simulado: false, modelo: "claude-haiku-4-5" } as RespuestaClaude); },
    gastoMesUsd: () => Promise.resolve(opts.gasto ?? 0),
    config: () => Promise.resolve({ ...CFG, ...opts.cfg }),
  };
  return { d, e };
}
const ent = (texto: string, extra: Partial<EntradaAgente> = {}): EntradaAgente => ({
  canal: "email", proveedor: { id: "p", nombre: "Demo", idioma: "en", plataforma: "alibaba" }, candidato: { id: "c", nombre: "Producto demo" },
  texto, historial: [], ahora: new Date("2026-11-25T15:00:00Z"), ...extra,
});

Deno.test("detectarPago: link de Alipay con monto en yuanes y cantidad", () => {
  const p = detectarPago("Hi, total for 500 pcs is ¥3,250.50, please pay here: https://qr.alipay.com/demo123abc. Thanks");
  assertEquals(p, { link: "https://qr.alipay.com/demo123abc", dominio: "qr.alipay.com", alipay: true, monto_minor: 325050, moneda: "CNY", cantidad: 500 });
});

Deno.test("detectarPago: chino con 支付宝 y 元; dominio falso que imita alipay NO es alipay", () => {
  const p = detectarPago("您好，定金1500元，支付宝链接：https://render.alipay.com/p/demo");
  assertEquals([p?.alipay, p?.monto_minor, p?.moneda], [true, 150000, "CNY"]);
  const falso = detectarPago("Pay the deposit USD 420 here https://alipay.com.demo-cobros.xyz/pay");
  assertEquals([falso?.alipay, falso?.dominio, falso?.monto_minor, falso?.moneda], [false, "alipay.com.demo-cobros.xyz", 42000, "USD"]);
});

Deno.test("detectarPago: mencionar Alipay como forma de pago en una cotización NO es pedido de pago", () => {
  assertEquals(detectarPago("Price USD 1.20/pc, MOQ 500. Payment terms: 30% T/T or Alipay."), null);
  assertEquals(detectarPago("Here is the catalog https://demo-fabrica.example/catalog.pdf"), null);
  assertEquals(detectarPago(""), null);
});

Deno.test("detectarPago: pedido de pago sin link igual cuenta (monto cerca de 'deposit')", () => {
  const p = detectarPago("Unit price $1.10. Kindly pay the deposit of USD 300 so we can start.");
  assertEquals([p?.link, p?.monto_minor, p?.moneda], [null, 30000, "USD"]);
});

Deno.test("montoPedido: prefiere el monto junto a total/定金 sobre otros precios", () => {
  assertEquals(montoPedido("unit ¥6.5, total ¥3250"), { monto_minor: 325000, moneda: "CNY" });
  assertEquals(montoPedido("sin montos"), null);
});

Deno.test("detectarTracking: inglés, chino y empresa", () => {
  assertEquals(detectarTracking("Goods shipped by SF, tracking number: SF1234567890123"), { tracking: "SF1234567890123", empresa: "SF Express" });
  assertEquals(detectarTracking("已发货，中通快递单号 78123456789012"), { tracking: "78123456789012", empresa: "ZTO" });
  assertEquals(detectarTracking("We will send the tracking number later"), null);
  assertEquals(detectarTracking("Price 1234567890 units"), null);
});

Deno.test("pideDireccion", () => {
  assert(pideDireccion("Please send me your shipping address"));
  assert(pideDireccion("请发一下收货地址"));
  assert(pideDireccion("Where should we ship the goods?"));
  assert(!pideDireccion("Our factory address is in Yiwu"));
});

Deno.test("textos fijos: dirección marítima por defecto, aérea si se pide; ninguno frena el doble freno", () => {
  const en = textoDireccion(DEP, "en");
  assert(en.includes("DEMO-MAR-1") && !en.includes("DEMO-AIR-1") && en.includes(DEP.en));
  assert(textoDireccion(DEP, "zh", "aereo").includes("DEMO-AIR-1"));
  assert(textoDireccion({ ...DEP, marca_aereo: null }, "en", "aereo").includes("DEMO-MAR-1"));
  for (const i of ["en", "zh", "es"] as const) assertEquals(textoCompromete(textoDireccion(DEP, i)), null);
  // El post-pago SÍ dice "pagamos": por eso lo manda el sistema (orden PAGADA_POR_ENRIQUE), nunca la IA.
  for (const i of ["en", "zh", "es"] as const) assert(textoCompromete(textoPostPago(i, "email", "Voltra")) !== null);
  assertEquals(textoCompromete("The payment is completed."), "pago"); // 25-11: hueco del doble freno cerrado
  assert(textoPostPago("zh", "whatsapp", "Voltra").includes("物流单号"));
});

Deno.test("responderProveedor: link de Alipay frena aunque el modelo no lo vea, contesta el neutro y trae el pago", async () => {
  const { d } = deps();
  const s = await responderProveedor(ent("Ok, total ¥980 for 200 pcs: https://qr.alipay.com/demo9"), d);
  assertEquals([s.frena, s.motivo, s.responder], [true, "pago", true]);
  assert(s.texto?.includes("confirmed by the owner"));
  assertEquals([s.pago?.alipay, s.pago?.monto_minor, s.pago?.cantidad], [true, 98000, 200]);
});

Deno.test("responderProveedor: con el tope de IA igual detecta el pago (sin llamar al modelo)", async () => {
  const { d, e } = deps({ gasto: 99 });
  const s = await responderProveedor(ent("pay here https://qr.alipay.com/demo9"), d);
  assertEquals([s.frena, s.motivo, e.llamadas, s.pago?.alipay], [true, "tope_ia", 0, true]);
});

Deno.test("responderProveedor: pide la dirección → texto fijo antes de la firma; sin depósito cargado, nada", async () => {
  const { d } = deps();
  const s = await responderProveedor(ent("Please send your shipping address"), d);
  assertEquals([s.responder, s.frena, s.pide_direccion], [true, false, true]);
  assert(s.texto!.includes("DEMO-MAR-1") && s.texto!.trimEnd().endsWith("Voltra (Paraguay)"));
  assert(s.texto!.indexOf("DEMO-MAR-1") < s.texto!.lastIndexOf("Voltra (Paraguay)"));
  const sin = await responderProveedor(ent("Please send your shipping address"), deps({ cfg: { deposito: null } }).d);
  assert(!sin.texto!.includes("DEMO-MAR-1"));
});

Deno.test("responderProveedor: número de seguimiento → envio, sin frenar", async () => {
  const { d } = deps();
  const s = await responderProveedor(ent("Shipped today, tracking no. YT9876543210123 by YTO"), d);
  assertEquals([s.frena, s.envio], [false, { tracking: "YT9876543210123", empresa: "YTO" }]);
});

Deno.test("responderProveedor: interruptor apagado → no frena por pago (no se hace nada)", async () => {
  const s = await responderProveedor(ent("pay https://qr.alipay.com/demo9"), deps({ cfg: { activo: false } }).d);
  assertEquals([s.motivo, s.frena, s.responder], ["apagado", false, false]);
});
