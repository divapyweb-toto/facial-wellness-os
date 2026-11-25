// 25-11 · Pruebas del pago por link, el seguimiento y la dirección fija. Datos DEMO (dominios y direcciones inventados).
import { assert, assertEquals } from "@std/assert";
import type { RespuestaClaude } from "../claude.ts";
import {
  type ConfigProveedores, type DepsAgente, type DepositoChina, type EntradaAgente,
  detectarPago, detectarTracking, esOkCorto, montoPedido, pideDireccion, responderProveedor, textoCompromete, textoDireccion, textoPedidoLink, textoPostPago,
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
  assertEquals(p, { link: "https://qr.alipay.com/demo123abc", dominio: "qr.alipay.com", dominio_ok: true, monto_minor: 325050, moneda: "CNY", cantidad: 500 });
});

Deno.test("detectarPago: chino con 支付宝 y 元; dominio falso que imita alipay NO es alipay", () => {
  const p = detectarPago("您好，定金1500元，支付宝链接：https://render.alipay.com/p/demo");
  assertEquals([p?.dominio_ok, p?.monto_minor, p?.moneda], [true, 150000, "CNY"]);
  const falso = detectarPago("Pay the deposit USD 420 here https://alipay.com.demo-cobros.xyz/pay");
  assertEquals([falso?.dominio_ok, falso?.dominio, falso?.monto_minor, falso?.moneda], [false, "alipay.com.demo-cobros.xyz", 42000, "USD"]);
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
  assertEquals([s.pago?.dominio_ok, s.pago?.monto_minor, s.pago?.cantidad], [true, 98000, 200]);
});

Deno.test("responderProveedor: con el tope de IA igual detecta el pago (sin llamar al modelo)", async () => {
  const { d, e } = deps({ gasto: 99 });
  const s = await responderProveedor(ent("pay here https://qr.alipay.com/demo9"), d);
  assertEquals([s.frena, s.motivo, e.llamadas, s.pago?.dominio_ok], [true, "tope_ia", 0, true]);
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

// ─── 25-11 (2): link de pago de Alibaba y el agente que guía la compra ───
const conPaso = (paso: string | null, respuesta = "Thank you.\n\nVoltra (Paraguay)", responder = true) => JSON.stringify({
  traduccion_entrante_es: "x", pide_compromiso: null, paso_compra: paso, responder, respuesta, respuesta_es: "Gracias.", cotizacion: null,
});
const histDir = [{ direccion: "out" as const, texto: textoDireccion(DEP, "en"), creado_en: "2026-11-25T10:00:00Z" }];

Deno.test("detectarPago: link de Alibaba (Trade Assurance) y de 1688 = válidos; ficha de producto NO es pago; otro dominio sí con aviso", () => {
  const a = detectarPago("Here is the Alibaba payment link: https://biz.alibaba.com/ta/detail.htm?orderId=123 total USD 860");
  assertEquals([a?.dominio, a?.dominio_ok, a?.monto_minor, a?.moneda], ["biz.alibaba.com", true, 86000, "USD"]);
  const b = detectarPago("付款链接 https://trade.1688.com/order/unify/pay.htm?id=9 合计¥2,400");
  assertEquals([b?.dominio, b?.dominio_ok, b?.monto_minor], ["trade.1688.com", true, 240000]);
  assertEquals(detectarPago("Check our product https://www.alibaba.com/product-detail/demo_123.html"), null);
  const c = detectarPago("payment link: https://pagos-rapidos.example/abc USD 500");
  assertEquals([c?.dominio, c?.dominio_ok], ["pagos-rapidos.example", false]);
});

Deno.test("textoAvisoPago: dominio raro lleva el aviso exacto de administración", async () => {
  const { textoAvisoPago } = await import("./agente.ts");
  const t = textoAvisoPago({ proveedor: "Demo", producto: null, canal: "email", tc: { usd_pyg: 6400, cny_por_usd: 7.2 }, orden: null,
    pago: { link: "https://x.example/pay", dominio: "x.example", dominio_ok: false, monto_minor: 1000, moneda: "USD", cantidad: null } });
  assert(t.includes("⚠️ link que no es de Alipay: no pagar sin revisar"));
  const ok = textoAvisoPago({ proveedor: "Demo", producto: null, canal: "email", tc: { usd_pyg: 6400, cny_por_usd: 7.2 }, orden: null,
    pago: { link: "https://biz.alibaba.com/ta/x", dominio: "biz.alibaba.com", dominio_ok: true, monto_minor: 1000, moneda: "USD", cantidad: null } });
  assert(!ok.includes("no pagar sin revisar") && ok.includes("✅"));
});

Deno.test("textos fijos del pedido de link: no frenan el doble freno; esOkCorto", () => {
  for (const i of ["en", "zh", "es"] as const) assertEquals(textoCompromete(textoPedidoLink(i)), null);
  assert(textoPedidoLink("en").includes("Alibaba payment link (Trade Assurance)"));
  assert(textoPedidoLink("zh").includes("阿里巴巴支付链接"));
  for (const t of ["ok", "OK!", "好的", "可以", "No problem", "Sure, we can ship there"]) assert(esOkCorto(t), t);
  for (const t of ["", "The price is USD 1.2 for 500 units, ok?".repeat(2)]) assert(!esOkCorto(t), t);
});

Deno.test("guía: precio cerrado → manda SOLO la dirección (marítima) sin que la pidan; aérea si la orden lo marca", async () => {
  const s = await responderProveedor(ent("OK, final price USD 1.10 for 1000 pcs."), deps({ texto: conPaso("precio_cerrado") }).d);
  assertEquals([s.responder, s.frena, s.paso_compra], [true, false, "direccion"]);
  assert(s.texto!.includes("DEMO-MAR-1") && !s.texto!.includes("DEMO-AIR-1") && s.texto!.trimEnd().endsWith("Voltra (Paraguay)"));
  const a = await responderProveedor(ent("OK, final price USD 1.10 for 1000 pcs.", { via: "aereo" }), deps({ texto: conPaso("precio_cerrado") }).d);
  assert(a.texto!.includes("DEMO-AIR-1"));
  // ya mandada: no se repite
  const r = await responderProveedor(ent("Final price confirmed.", { historial: histDir }), deps({ texto: conPaso("precio_cerrado") }).d);
  assertEquals(r.paso_compra, null);
});

Deno.test("guía: después de la dirección, OK del proveedor → pide el link de pago de Alibaba (aunque el modelo no conteste)", async () => {
  const s = await responderProveedor(ent("ok", { historial: histDir }), deps({ texto: conPaso(null, "", false) }).d);
  assertEquals([s.responder, s.paso_compra], [true, "pidio_link"]);
  assert(s.texto!.includes("Alibaba payment link (Trade Assurance)") && s.texto!.endsWith("Voltra (Paraguay)"));
  const zh = await responderProveedor(ent("好的，没问题", { proveedor: { id: "p", nombre: "D", idioma: "zh", plataforma: "1688" }, historial: histDir, canal: "whatsapp" }), deps({ texto: conPaso("acepta", "", false) }).d);
  assert(zh.texto === textoPedidoLink("zh"));
  // ya pedido: no se repite
  const otra = await responderProveedor(ent("ok", { historial: [...histDir, { direccion: "out", texto: textoPedidoLink("en"), creado_en: "x" }] }), deps({ texto: conPaso(null, "", false) }).d);
  assertEquals([otra.responder, otra.paso_compra], [false, null]);
  // sin dirección mandada, un "ok" no pide link
  const sin = await responderProveedor(ent("ok"), deps({ texto: conPaso(null, "", false) }).d);
  assertEquals(sin.paso_compra, null);
});

Deno.test("guía: sin producto, con freno o sin depósito cargado → no agrega nada", async () => {
  const sinProd = await responderProveedor(ent("Final price ok", { candidato: null }), deps({ texto: conPaso("precio_cerrado") }).d);
  assertEquals(sinProd.paso_compra, null);
  const sinDep = await responderProveedor(ent("Final price ok"), deps({ texto: conPaso("precio_cerrado"), cfg: { deposito: null } }).d);
  assertEquals(sinDep.paso_compra, null);
  const freno = await responderProveedor(ent("Final price ok, please confirm the order"), deps({ texto: conPaso("precio_cerrado") }).d);
  assertEquals([freno.frena, freno.paso_compra], [true, null]);
});
