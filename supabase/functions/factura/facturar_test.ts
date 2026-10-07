import { assert, assertEquals } from "jsr:@std/assert@1";
import { digitoVerificadorRuc, type ResultadoFactura } from "../_shared/facturacion.ts";
import {
  CONFIG_OLA4_FACTURA_DEFECTO,
  configFactura,
  type DepsFactura,
  facturarPedido,
  type FilaFactura,
  type PedidoGuardado,
} from "./facturar.ts";

function pedido(over: Partial<PedidoGuardado> = {}): PedidoGuardado {
  return {
    shopify_order_id: 9001, nombre: "#1001", total: 129000, estado_envio: "ENTREGADO", tags: [],
    raw: { line_items: [{ title: "Tiras nasales", quantity: 1, price: "129000" }] }, ...over,
  };
}
function deps(p: PedidoGuardado | null, o: { activo?: boolean; emitir?: ResultadoFactura } = {}) {
  const filas = new Map<number, FilaFactura>();
  const log = { emitidas: 0, avisos: [] as string[] };
  const d: DepsFactura = {
    ahora: () => new Date("2026-10-06T15:00:00Z"),
    config: () => Promise.resolve(configFactura({ activo: o.activo ?? true })),
    leerPedido: () => Promise.resolve(p),
    leerFactura: (id) => Promise.resolve(filas.get(id) ?? null),
    tomar: (id) => {
      const f = filas.get(id);
      if (f?.estado === "emitida") return Promise.resolve({ numero: f.numero!, tomada: false, estado: "emitida", intentos: 1 });
      const n = f?.numero ?? 1;
      filas.set(id, { ...(f ?? { shopify_order_id: id }), estado: "emitiendo", numero: n, intentos: (f?.intentos ?? 0) + 1 });
      return Promise.resolve({ numero: n, tomada: true, estado: "emitiendo", intentos: filas.get(id)!.intentos! });
    },
    guardar: (f) => { filas.set(f.shopify_order_id, { ...(filas.get(f.shopify_order_id) ?? {}), ...f }); return Promise.resolve(); },
    emitir: () => {
      log.emitidas++;
      return Promise.resolve(o.emitir ?? { ok: true, simulado: true, cdc: "99" + "1".repeat(42), numero_completo: "001-001-0000001", pdf_url: "https://x.test/f.pdf" });
    },
    avisar: (t) => { log.avisos.push(t); return Promise.resolve(); },
    escapar: (s) => String(s),
  };
  return { d, log, filas };
}

Deno.test("bandera apagada por defecto: no hace nada", async () => {
  assertEquals(CONFIG_OLA4_FACTURA_DEFECTO.activo, false);
  const { d, log } = deps(pedido(), { activo: false });
  assertEquals((await facturarPedido(9001, d)).accion, "bandera_apagada");
  assertEquals(log.emitidas, 0);
});

Deno.test("pedido no entregado o inexistente: no emite", async () => {
  assertEquals((await facturarPedido(9001, deps(pedido({ estado_envio: "DESPACHADO" })).d)).accion, "no_entregado");
  assertEquals((await facturarPedido(9001, deps(null).d)).accion, "sin_pedido");
});

Deno.test("entregado: emite y es idempotente (segunda llamada no emite)", async () => {
  const { d, log } = deps(pedido());
  assertEquals((await facturarPedido(9001, d)).accion, "emitida");
  assertEquals((await facturarPedido(9001, d)).accion, "ya_emitida");
  assertEquals(log.emitidas, 1);
});

Deno.test("RUC inválido o suma que no cierra: revisar, avisa una vez y no emite", async () => {
  const dv = digitoVerificadorRuc("1234567");
  const raw = { note_attributes: [{ name: "ruc", value: `1234567-${(dv + 1) % 10} Ana` }], line_items: [{ title: "T", quantity: 1, price: "129000" }] };
  const a = deps(pedido({ raw }));
  assertEquals((await facturarPedido(9001, a.d)).accion, "revisar");
  await facturarPedido(9001, a.d);
  assertEquals(a.log.emitidas, 0);
  assertEquals(a.log.avisos.length, 1);
  const b = deps(pedido({ total: 100000 }));
  assertEquals((await facturarPedido(9001, b.d)).accion, "revisar");
});

Deno.test("error del proveedor: queda en error y se reintenta con el mismo número; tope de intentos", async () => {
  const { d, log, filas } = deps(pedido(), { emitir: { ok: false, simulado: false, error: "x" } });
  assertEquals((await facturarPedido(9001, d)).accion, "error");
  assertEquals(filas.get(9001)!.estado, "error");
  await facturarPedido(9001, d);
  await facturarPedido(9001, d);
  assertEquals(log.emitidas, 3);
  assertEquals((await facturarPedido(9001, d)).accion, "max_intentos");
  assertEquals(log.emitidas, 3);
  assertEquals(log.avisos.length, 1);
});

Deno.test("pagado por QR: pasa la marca al emisor", async () => {
  let visto: boolean | undefined;
  const { d } = deps(pedido({ tags: ["PAGADO_QR"] }));
  const emitir = d.emitir;
  d.emitir = (p, x, c) => { visto = p.pagadoPorQR; return emitir(p, x, c); };
  await facturarPedido(9001, d);
  assert(visto === true);
});
