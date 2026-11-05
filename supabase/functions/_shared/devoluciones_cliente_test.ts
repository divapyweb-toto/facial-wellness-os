// 05-11: devoluciones previas del cliente (Voltra + FW) para el pago anticipado obligatorio. Datos inventados.
import { assertEquals } from "jsr:@std/assert@1";
import {
  claveRef,
  devolucionesPrevias,
  entregaPerdida,
  type FilaEntrega,
  type FilaPedido,
  type FilaVenta,
  type FuentesDevoluciones,
  telefonosDeRaw,
  ultimos9,
} from "./devoluciones_cliente.ts";

Deno.test("ultimos9: ignora +595, 595, 00595, 0 inicial, espacios y marcas; corto o vacío → null", () => {
  for (const t of ["+595981000111", "595981000111", "00595981000111", "0981000111", "0981 000 111", "+595 981 000111", "‪+595 981 000111‬", "5950981000111", "981000111"]) {
    assertEquals(ultimos9(t), "981000111", t);
  }
  assertEquals(ultimos9("021 555 66"), null);
  assertEquals(ultimos9(""), null);
  assertEquals(ultimos9(null), null);
});

Deno.test("claveRef: VT-9001 y #9001 son el mismo pedido de Voltra; FW con o sin #; sin dígitos → null", () => {
  assertEquals(claveRef("voltra", "VT-9001"), "voltra:9001");
  assertEquals(claveRef("voltra", "#9001"), "voltra:9001");
  assertEquals(claveRef("fw", "#7001"), claveRef("fw", "7001"));
  assertEquals(claveRef("fw", "WA-7001"), "fw:WA-7001");
  assertEquals(claveRef("fw", "no tiene"), null);
});

Deno.test("entregaPerdida: PaP custodio / no gestionado / inubicable / fuera de cobertura = perdido; Lucero solo devuelto o cancelado", () => {
  const pap = (estado_pap: string, categoria = "en_proceso") => ({ transportadora: "pap", categoria, estado_pap });
  const luc = (estado_pap: string, categoria = "en_proceso") => ({ transportadora: "lucero", categoria, estado_pap });
  for (const e of ["Custodio", "No Gestionado", "Inubicable", "Fuera de cobertura", "Devolucion en proceso", "Devuelto Definitivo"]) {
    assertEquals(entregaPerdida(pap(e)), true, e);
  }
  for (const e of ["Asignado a ruta", "En Oficina", "Entregado", ""]) assertEquals(entregaPerdida(pap(e)), false, e);
  assertEquals(entregaPerdida(luc("Devuelto")), true);
  assertEquals(entregaPerdida(luc("Cancelado")), true);
  for (const e of ["Fallido", "Aceptado", "En_camino", "reagendado"]) assertEquals(entregaPerdida(luc(e)), false, e);
  assertEquals(entregaPerdida(luc("lo-que-sea", "devuelto")), true); // la categoría del importador manda
});

Deno.test("telefonosDeRaw: principal, envío, facturación y cliente", () => {
  assertEquals(telefonosDeRaw({ phone: "0981000111", shipping_address: { phone: "+595981000222" }, customer: { phone: null } }), ["0981000111", "+595981000222"]);
  assertEquals(telefonosDeRaw(null), []);
});

const TEL = "0981000111";
function fuentes(x: { ventas?: FilaVenta[]; entregas?: FilaEntrega[]; porId?: FilaVenta[]; pedidos?: FilaPedido[] } = {}) {
  const llamadas = { porId: [] as string[][], pedidos: [] as string[] };
  const f: FuentesDevoluciones = {
    ventasDevueltas: () => Promise.resolve(x.ventas ?? []),
    entregasCandidatas: () => Promise.resolve(x.entregas ?? []),
    ventasPorId: (ids) => (llamadas.porId.push(ids), Promise.resolve((x.porId ?? []).filter((v) => ids.includes(v.id)))),
    pedidosNoEntregados: (c) => (llamadas.pedidos.push(c), Promise.resolve(x.pedidos ?? [])),
  };
  return { f, llamadas };
}
const venta = (id: string, tienda: string, ref: string, tel: string | null, estado = "devuelto"): FilaVenta => ({ id, tienda, n_referencia: ref, cliente_telefono: tel, estado });
const entrega = (x: Partial<FilaEntrega>): FilaEntrega => ({
  tienda: "fw", n_referencia: null, transportadora: "pap", categoria: "devuelto", estado_pap: "Devuelto Definitivo", telefono_courier: null, venta_id: null, ...x,
});

Deno.test("devolucionesPrevias: suma FW y Voltra por teléfono (cualquier formato), sin repetir el mismo pedido y sin el actual", async () => {
  const { f } = fuentes({
    ventas: [
      venta("v1", "fw", "#7001", "+595 981 000111"),
      venta("v2", "voltra", "VT-9001", "595981000111"),
      venta("v3", "voltra", "VT-9005", TEL), // es el pedido actual: no cuenta
      venta("v4", "fw", "7002", "0982999888"), // otro cliente
    ],
    entregas: [
      entrega({ venta_id: "v1", n_referencia: "7001" }), // misma devolución que v1: no suma dos veces
      entrega({ n_referencia: "7003", telefono_courier: TEL }), // devolución sin venta vinculada: suma
    ],
    pedidos: [{ shopify_order_id: 55, nombre: "#9001" }, { shopify_order_id: 56, nombre: "#9002" }, { shopify_order_id: 57, nombre: "#9005" }],
  });
  const r = await devolucionesPrevias(f, { clienteId: "c1", telefonos: [TEL], pedidoActual: { nombre: "#9005", shopifyOrderId: 57 } });
  assertEquals(r.claves, ["fw:7001", "fw:7003", "voltra:9001", "voltra:9002"]);
  assertEquals(r.total, 4);
});

Deno.test("devolucionesPrevias: entrega vinculada a una venta 'entregado' no cuenta; vinculada a una pendiente con PaP custodio, sí", async () => {
  const { f, llamadas } = fuentes({
    entregas: [
      entrega({ venta_id: "v8", categoria: "devuelto" }),
      entrega({ venta_id: "v9", categoria: "en_proceso", estado_pap: "Custodio" }),
      entrega({ transportadora: "lucero", categoria: "en_proceso", estado_pap: "Fallido", telefono_courier: TEL, n_referencia: "7010" }),
    ],
    porId: [venta("v8", "fw", "7008", TEL, "entregado"), venta("v9", "fw", "7009", TEL, "pendiente")],
  });
  const r = await devolucionesPrevias(f, { telefonos: ["+595981000111"], pedidoActual: { nombre: "#9100" } });
  assertEquals(r.claves, ["fw:7009"]);
  assertEquals(llamadas.porId, [["v8", "v9"]]);
  assertEquals(llamadas.pedidos, []); // sin cliente_id no se consulta shopify_pedidos
});

Deno.test("devolucionesPrevias: cliente sin devoluciones o sin teléfono → 0", async () => {
  const { f } = fuentes({ ventas: [venta("v1", "fw", "7001", "0982999888")], entregas: [entrega({ telefono_courier: "0982999888", n_referencia: "7001" })] });
  assertEquals((await devolucionesPrevias(f, { clienteId: "c1", telefonos: [TEL], pedidoActual: { nombre: "#9100" } })).total, 0);
  assertEquals((await devolucionesPrevias(f, { telefonos: [null, "", "PY.1234"], pedidoActual: {} })).total, 0);
});
