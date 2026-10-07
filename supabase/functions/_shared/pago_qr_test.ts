import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  _configurarQR,
  crearCobroQR,
  hmacSha256Hex,
  md5Hex,
  proveedorEfectivo,
  verificarWebhookQR,
} from "./pago_qr.ts";

const AHORA = new Date("2026-10-06T15:00:00Z");
function entorno(env: Record<string, string>, fetchFalso?: typeof fetch) {
  _configurarQR({ env: (n) => env[n], ahora: () => AHORA, ...(fetchFalso ? { fetch: fetchFalso } : {}) });
}
const pedido = { shopify_order_id: 9001, nombre: "#1001", total: 129000 };
const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status }));

Deno.test("md5 de referencia", () => {
  assertEquals(md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e");
  assertEquals(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
});

Deno.test("sin credenciales o MODO_SIMULADO=1: simulador y sin fetch", async () => {
  let llamadas = 0;
  entorno({}, () => { llamadas++; return json({}); });
  let r = await crearCobroQR(pedido);
  assert(r.ok && r.simulado);
  assertEquals(r.id_externo, "voltra-9001");
  entorno({ QR_PROVEEDOR: "adamspay", QR_API_KEY: "k", MODO_SIMULADO: "1" }, () => { llamadas++; return json({}); });
  r = await crearCobroQR(pedido);
  assert(r.simulado);
  entorno({ QR_PROVEEDOR: "upay", QR_API_KEY: "k" });
  assertEquals(proveedorEfectivo().simulado, true);
  assertEquals(llamadas, 0);
  _configurarQR();
});

Deno.test("AdamsPay éxito: manda apikey y devuelve payUrl", async () => {
  let visto: { url: string; headers: Record<string, string>; body: string } | null = null;
  entorno({ QR_PROVEEDOR: "adamspay", QR_API_KEY: "clave-test" }, (u, i) => {
    visto = { url: String(u), headers: i!.headers as Record<string, string>, body: String(i!.body) };
    return json({ debt: { payUrl: "https://pago.test/abc", docId: "voltra-9001" } });
  });
  const r = await crearCobroQR(pedido);
  assert(r.ok && !r.simulado);
  assertEquals(r.url, "https://pago.test/abc");
  assert(visto!.url.startsWith("https://staging.adamspay.com/api/v1/debts"));
  assertEquals(visto!.headers.apikey, "clave-test");
  assertEquals(JSON.parse(visto!.body).debt.amount.value, "129000");
  _configurarQR();
});

Deno.test("AdamsPay error HTTP y error de red", async () => {
  entorno({ QR_PROVEEDOR: "adamspay", QR_API_KEY: "k" }, () => json({ meta: { description: "malo" } }, 400));
  let r = await crearCobroQR(pedido);
  assert(!r.ok && r.error!.includes("400"));
  entorno({ QR_PROVEEDOR: "adamspay", QR_API_KEY: "k" }, () => Promise.reject(new Error("caído")));
  r = await crearCobroQR(pedido);
  assert(!r.ok && r.error!.includes("caído"));
  _configurarQR();
});

Deno.test("arnipay éxito firma la petición", async () => {
  let h: Record<string, string> = {};
  entorno({ QR_PROVEEDOR: "arnipay", QR_API_KEY: "priv", QR_CLIENT_ID: "cid" }, (_u, i) => {
    h = i!.headers as Record<string, string>;
    return json({ status: "success", data: { id: "lnk1", url: "https://arni.test/p" } });
  });
  const r = await crearCobroQR(pedido);
  assert(r.ok);
  assertEquals(r.id_externo, "lnk1");
  assertEquals(h["X-Client-ID"], "cid");
  assertEquals(h["X-Signature"].length, 64);
  _configurarQR();
});

Deno.test("monto inválido: no llama a nadie", async () => {
  entorno({});
  const r = await crearCobroQR({ ...pedido, total: 0 });
  assert(!r.ok);
  _configurarQR();
});

Deno.test("webhook AdamsPay: firma válida, inválida y sin secreto", async () => {
  const raw = JSON.stringify({ notify: { type: "debtStatus", id: "n1" }, debt: { docId: "voltra-9001", payStatus: { status: "paid" }, amount: { value: "129000" } } });
  entorno({ QR_WEBHOOK_SECRET: "sec" });
  const ok = await verificarWebhookQR(raw, new Headers({ "x-adams-notify-hash": md5Hex("adams" + raw + "sec") }));
  assert(ok.ok && ok.evento!.pagado);
  assertEquals(ok.evento!.monto, 129000);
  const mal = await verificarWebhookQR(raw, new Headers({ "x-adams-notify-hash": "00" }));
  assertEquals(mal.error, "firma_invalida");
  entorno({});
  assertEquals((await verificarWebhookQR(raw, new Headers({ "x-adams-notify-hash": "00" }))).error, "falta QR_WEBHOOK_SECRET");
  _configurarQR();
});

Deno.test("webhook sin firma reconocida y simulador solo con MODO_SIMULADO=1", async () => {
  const raw = JSON.stringify({ referencia: "voltra-9001", estado: "pagado", monto: 129000, id: "e1" });
  entorno({ QR_WEBHOOK_SECRET: "sec" });
  assertEquals((await verificarWebhookQR(raw, new Headers())).error, "sin_firma_reconocida");
  const f = await hmacSha256Hex(raw, "sec");
  assertEquals((await verificarWebhookQR(raw, new Headers({ "x-simulado-firma": f }))).error, "simulador_desactivado");
  entorno({ QR_WEBHOOK_SECRET: "sec", MODO_SIMULADO: "1" });
  const r = await verificarWebhookQR(raw, new Headers({ "x-simulado-firma": f }));
  assert(r.ok && r.evento!.pagado);
  assertEquals((await verificarWebhookQR(raw, new Headers({ "x-simulado-firma": "ab" }))).error, "firma_invalida");
  _configurarQR();
});
