// Tests de la cola SIFEN con un repo EN MEMORIA (con bloqueo para la numeración) y SIFEN simulado.
// Datos ficticios. Equivalente SQL para correr a mano: supabase/tests/sifen_numeracion.sql.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { DocumentoDE, TipoDE } from "./tipos.ts";
import type { OpcionesAviso } from "../telegram_politica.ts";
import { digitoVerificadorRuc } from "../facturacion.ts";
import { codigoSeguridadAleatorio, fechaCobro, fechaSifen, motivoAnulacion, type PedidoSifen } from "./desde_pedido.ts";
import { crearEmisorPropio, type OpcionesWsSimulado, wsSimulado } from "./emisor_propio.ts";
import { cdcSimuladoDoc, credencialesDesdeEnv, datosEmisorPrueba, type EmisorCola, totalesSimulados } from "./emisor.ts";
import {
  cancelarFactura,
  configSifen,
  type DepsCola,
  type DepsInutilizacion,
  type EventoSifen,
  facturarPedido,
  desdeFacturar,
  type FilaFactura,
  procesarCola,
  procesarDevolucion,
  type Retencion,
  procesarInutilizacion,
  rangosAInutilizar,
} from "./cola.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Mutex simple: emula el `select … for update` de sifen_siguiente_numero. */
class Bloqueo {
  private cola: Promise<void> = Promise.resolve();
  async con<T>(fn: () => Promise<T>): Promise<T> {
    let soltar!: () => void;
    const antes = this.cola;
    this.cola = new Promise((r) => (soltar = r));
    await antes;
    try {
      return await fn();
    } finally {
      soltar();
    }
  }
}

function pedido(id: number, over: Partial<PedidoSifen> = {}, raw: Record<string, unknown> = {}): PedidoSifen {
  return {
    shopify_order_id: id,
    nombre: `#${id}`,
    total: 162000,
    estado_envio: "ENTREGADO",
    tags: [],
    telefono: "595900000000",
    entregado_en: "2026-10-08T12:00:00Z",
    raw: { total_price: "162000", line_items: [{ title: "Producto A", quantity: 1, price: "129000" }], shipping_lines: [{ price: "33000" }], ...raw },
    ...over,
  };
}

function entorno(op: { ws?: OpcionesWsSimulado; cfg?: Record<string, unknown>; ahora?: Date } = {}) {
  const ws = wsSimulado(op.ws);
  const filas = new Map<string, FilaFactura>();
  const pedidos = new Map<number, PedidoSifen>();
  const numeracion = new Map<string, number>();
  const eventos: EventoSifen[] = [];
  const retenidas = new Map<number, Retencion & { nota: string }>();
  const avisos: string[] = [];
  const opciones: OpcionesAviso[] = [];
  const whatsapps: string[] = [];
  const kudes: string[] = [];
  const bloqueo = new Bloqueo();
  const reloj = { t: op.ahora ?? new Date("2026-10-08T13:00:00Z") };
  let seq = 0;
  const emisor: EmisorCola = crearEmisorPropio({
    emisor: datosEmisorPrueba(),
    cred: credencialesDesdeEnv(() => undefined).cred,
    simulado: true,
    armarXmlDE: (x: DocumentoDE, e) => {
      const cdc = cdcSimuladoDoc(x, e);
      return { xml: `<rDE><DE Id="${cdc}"><n>${x.numero}</n></DE></rDE>`, cdc, totales: totalesSimulados(x) };
    },
    firmarXml: (xml) => Promise.resolve({ xmlFirmado: xml, digestValue: "ZA==" }),
    armarQr: (a) => ({ urlQr: `https://qr.test/${a.cdc}`, xmlConQr: a.xmlFirmado.replace("</rDE>", `<dCarQR>https://qr.test/${a.cdc}</dCarQR></rDE>`) }),
    generarKude: () => Promise.resolve(new Uint8Array([37, 80, 68, 70])),
    ws,
    eventos: { cancelacion: (a) => ({ xml: `<e>${a.cdc}</e>`, id: "1" }), inutilizacion: (a) => ({ xml: `<e>${a.desde}</e>`, id: "2" }) },
    ahora: () => reloj.t,
    esperar: () => Promise.resolve(),
    fechaSifen,
  });
  const cfg = configSifen({ activo: true, facturar_desde: "2026-01-01T00:00:00Z", ...op.cfg });
  const d: DepsCola = {
    ahora: () => reloj.t,
    aleatorio: Math.random,
    cfg,
    ambiente: "test",
    simulado: true,
    timbrado: "12345678",
    emisor,
    fechaSifen,
    codigoSeguridad: () => codigoSeguridadAleatorio(),
    // Igual que sifen-cola/io.ts (29-10): dos caminos, pagado_en ≥ desde (sin devueltos) o ENTREGADO/RENDIDO con
    // entregado_en ≥ desde; sin FE y sin retención.
    pedidosSinFactura: (desde) =>
      Promise.resolve([...pedidos.values()].filter((p) =>
        ((!!p.pagado_en && p.pagado_en >= desde && !["NO_ENTREGADO", "CANCELADO"].includes(p.estado_envio ?? "")) ||
          (["ENTREGADO", "RENDIDO"].includes(p.estado_envio ?? "") && !!p.entregado_en && p.entregado_en >= desde)) &&
        !retenidas.has(p.shopify_order_id) &&
        ![...filas.values()].some((f) => f.tipo_documento === 1 && f.shopify_order_id === p.shopify_order_id))),
    liberadosSinFactura: () =>
      Promise.resolve([...retenidas.entries()].filter(([id, r]) => r.liberado_en && pedidos.has(id) &&
        ![...filas.values()].some((f) => f.tipo_documento === 1 && f.shopify_order_id === id)).map(([id]) => pedidos.get(id)!)),
    retencion: (id) => Promise.resolve(retenidas.has(id) ? { ...retenidas.get(id)! } : null),
    retener(id, motivo, nota) {
      if (!retenidas.has(id)) retenidas.set(id, { motivo, nota, liberado_en: null });
      return Promise.resolve();
    },
    facturasVencidas: (ahoraIso) =>
      Promise.resolve([...filas.values()].filter((f) => f.proximo_intento && f.proximo_intento <= ahoraIso && ["pendiente", "enviada", "error", "aprobada"].includes(f.estado)).map((f) => ({ ...f }))),
    // Igual que io (29-10): devueltos + cancelados sin entregar (motivoAnulacion).
    facturasDevueltas: () =>
      Promise.resolve([...filas.values()].filter((f) => f.tipo_documento === 1 && f.estado === "aprobada" && pedidos.has(f.shopify_order_id!) && !!motivoAnulacion(pedidos.get(f.shopify_order_id!)!))
        .map((f) => ({ factura: { ...f }, pedido: pedidos.get(f.shopify_order_id!)! }))),
    leerPedido: (id) => Promise.resolve(pedidos.get(id) ?? null),
    leerFactura: (id) => Promise.resolve(filas.has(id) ? { ...filas.get(id)! } : null),
    facturaDePedido: (id) => Promise.resolve([...filas.values()].find((f) => f.tipo_documento === 1 && f.shopify_order_id === id) ?? null),
    notasDeFactura: (id) => Promise.resolve([...filas.values()].filter((f) => f.factura_original_id === id)),
    async crearFactura(f) {
      await tick();
      // índices únicos parciales
      if (f.tipo_documento === 1 && [...filas.values()].some((x) => x.tipo_documento === 1 && x.shopify_order_id === f.shopify_order_id)) return null;
      if (f.tipo_documento === 5 && [...filas.values()].some((x) => x.tipo_documento === 5 && x.factura_original_id === f.factura_original_id)) return null;
      const fila = { id: `f${++seq}`, numero: null, numero_completo: null, cdc: null, codigo_seguridad: null, fecha_emision: null, intentos: 0, ...f } as FilaFactura;
      filas.set(fila.id, fila);
      return { ...fila };
    },
    async tomarLease(id, hasta, ahora) {
      const f = filas.get(id)!;
      if (f.lease_hasta && f.lease_hasta > ahora) return false;
      f.lease_hasta = hasta;
      return true;
    },
    asignarNumero: (id, a) =>
      bloqueo.con(async () => {
        const f = filas.get(id)!;
        if (!f.numero) {
          const k = `${f.timbrado}/${f.establecimiento}/${f.punto}/${f.tipo_documento}`;
          const ultimo = numeracion.get(k) ?? 0;
          await tick(); // ventana de carrera: sin el bloqueo, dos llamadas leerían el mismo `ultimo`
          numeracion.set(k, ultimo + 1);
          f.numero = ultimo + 1;
          f.numero_completo = `001-001-${String(f.numero).padStart(7, "0")}`;
        }
        f.codigo_seguridad ??= a.codigoSeguridad;
        f.fecha_emision ??= a.fechaEmision;
        return { numero: f.numero, numero_completo: f.numero_completo!, codigo_seguridad: f.codigo_seguridad!, fecha_emision: f.fecha_emision! };
      }),
    actualizar(id, c) {
      Object.assign(filas.get(id)!, c);
      return Promise.resolve();
    },
    registrarEvento: (e) => (eventos.push(e), Promise.resolve()),
    subirKude: (f) => (kudes.push(f.id), Promise.resolve(`sifen/test/${f.numero_completo}.pdf`)),
    enviarKude: (f) => (whatsapps.push(f.id), Promise.resolve({ ok: true })),
    avisar: (t, _b, o) => (avisos.push(t), o && opciones.push(o), Promise.resolve()),
    escapar: (s) => String(s),
  };
  const agregar = (...ps: PedidoSifen[]) => ps.forEach((p) => pedidos.set(p.shopify_order_id, p));
  return { d, ws, filas, pedidos, numeracion, eventos, avisos, opciones, whatsapps, kudes, reloj, agregar, retenidas };
}

const fe = (e: ReturnType<typeof entorno>, id: number) => [...e.filas.values()].find((f) => f.tipo_documento === 1 && f.shopify_order_id === id)!;
const horas = (e: ReturnType<typeof entorno>, h: number) => (e.reloj.t = new Date(e.reloj.t.getTime() + h * 3_600_000));

Deno.test("bandera apagada: no hace nada", async () => {
  const e = entorno({ cfg: { activo: false } });
  e.agregar(pedido(1));
  assertEquals((await procesarCola(e.d)).accion, "bandera_apagada");
  assertEquals(e.filas.size, 0);
});

Deno.test("consumidor final entregado: aprobada, KuDE subido y enviado por WhatsApp, número 1; RENDIDO también se factura", async () => {
  const e = entorno();
  e.agregar(pedido(1), pedido(2, { estado_envio: "RENDIDO" }));
  const r = await procesarCola(e.d);
  assertEquals(r.nuevos.map((x) => x.accion), ["aprobada", "aprobada"]);
  const f = fe(e, 1);
  assertEquals([f.estado, f.numero, f.receptor_tipo, f.total, f.iva10], ["aprobada", 1, "innominado", 162000, Math.round(162000 / 11)]);
  assert(f.kude_path && f.kude_enviado_en && f.xml_firmado && f.cdc);
  assertEquals(f.proximo_intento, null);
  assertEquals(e.whatsapps.length, 2);
  // Segunda corrida: nada nuevo (idempotente).
  const r2 = await procesarCola(e.d);
  assertEquals(r2.nuevos.length + r2.reintentos.length, 0);
  assertEquals(e.ws.recibidos.size, 2);
});

Deno.test("cliente con RUC válido → receptor ruc; RUC inválido → innominado + aviso", async () => {
  const e = entorno();
  const ruc = `80012345-${digitoVerificadorRuc("80012345")}`;
  e.agregar(
    pedido(1, {}, { note_attributes: [{ name: "Ruc", value: ruc }, { name: "Razon social", value: "Empresa Ficticia SA" }] }),
    pedido(2, {}, { note_attributes: [{ name: "Ruc", value: "80012345-1" }, { name: "Razon social", value: "Otra" }] }),
  );
  await procesarCola(e.d);
  assertEquals([fe(e, 1).receptor_tipo, fe(e, 1).ruc, fe(e, 1).razon_social], ["ruc", ruc, "Empresa Ficticia SA"]);
  assertEquals(fe(e, 2).receptor_tipo, "innominado");
  assertEquals(fe(e, 2).estado, "aprobada");
  assert(e.avisos.some((a) => a.includes("RUC inválido")));
});

Deno.test("pedido devuelto / cancelado / de prueba: nunca se factura", async () => {
  const e = entorno();
  e.agregar(pedido(1, { estado_envio: "NO_ENTREGADO" }), pedido(2, {}, { cancelled_at: "2026-10-01T00:00:00Z" }), pedido(3, { tags: ["PRUEBA_E2E"] }));
  assertEquals((await facturarPedido(1, e.d)).accion, "no_facturable");
  await procesarCola(e.d);
  assertEquals(e.filas.size, 0);
  assertEquals(e.ws.recibidos.size, 0);
});

Deno.test("suma que no cuadra → 'revisar' + aviso, sin consumir número ni enviar", async () => {
  const e = entorno();
  e.agregar(pedido(1, {}, { total_price: "999999" }));
  const r = await procesarCola(e.d);
  assertEquals(r.nuevos[0].accion, "revisar");
  assertEquals(fe(e, 1).estado, "revisar");
  assertEquals(fe(e, 1).numero, null);
  assertEquals(e.numeracion.size, 0);
  assertEquals(e.avisos.length, 1);
});

Deno.test("numeración concurrente: dos entregas a la vez → números 1 y 2 sin saltos ni duplicados; mismo pedido dos veces → una sola factura", async () => {
  const e = entorno();
  e.agregar(pedido(1), pedido(2), pedido(3));
  const r = await Promise.all([facturarPedido(1, e.d), facturarPedido(2, e.d), facturarPedido(3, e.d), facturarPedido(3, e.d)]);
  assertEquals(r.filter((x) => x.accion === "aprobada").length, 3);
  assertEquals([...e.filas.values()].map((f) => f.numero).sort(), [1, 2, 3]);
  assertEquals(e.filas.size, 3);
  assertEquals([...e.ws.recibidos.values()], [1, 1, 1]);
});

Deno.test("caída de red a mitad del envío sin respuesta: queda 'enviada'; el reintento CONSULTA el CDC y no duplica", async () => {
  const e = entorno({ ws: { fallasRedLlegando: 1 } });
  // La consulta también cae en el primer intento → resultado desconocido.
  const consultar = e.ws.consultarDE;
  let caida = true;
  e.ws.consultarDE = (cdc) => caida ? Promise.resolve({ ok: false, estado: "error_red" }) : consultar(cdc);
  e.agregar(pedido(1));
  await procesarCola(e.d);
  const f = fe(e, 1);
  assertEquals(f.estado, "enviada");
  assert(f.proximo_intento && f.cdc && f.xml_firmado);
  caida = false;
  horas(e, 1);
  const r = await procesarCola(e.d);
  assertEquals(r.reintentos[0].accion, "aprobada");
  assertEquals(fe(e, 1).estado, "aprobada");
  assertEquals(e.ws.recibidos.get(f.cdc!), 1); // un solo envío a SIFEN
});

Deno.test("pendiente que pasa 48 h sin respuesta → un solo aviso de plazo de transmisión", async () => {
  const e = entorno();
  e.ws.enviarDE = () => Promise.resolve({ ok: false, estado: "error_red" });
  e.ws.consultarDE = () => Promise.resolve({ ok: false, estado: "error_red" });
  e.agregar(pedido(1));
  await procesarCola(e.d);
  for (let i = 0; i < 6; i++) {
    horas(e, 10);
    fe(e, 1).proximo_intento = e.reloj.t.toISOString();
    await procesarCola(e.d);
  }
  assertEquals(e.avisos.filter((a) => a.includes("sin confirmar")).length, 1);
});

Deno.test("un error en un pedido no frena al resto", async () => {
  const e = entorno();
  e.agregar(pedido(1), pedido(2));
  const leer = e.d.facturaDePedido;
  e.d.facturaDePedido = (id) => id === 1 ? Promise.reject(new Error("base caída")) : leer(id);
  const r = await procesarCola(e.d);
  assertEquals(r.errores.length, 1);
  assertEquals(fe(e, 2).estado, "aprobada");
});

Deno.test("devuelto dentro de 48 h: evento de cancelación + aviso", async () => {
  const e = entorno();
  e.agregar(pedido(1));
  await procesarCola(e.d);
  horas(e, 20);
  e.pedidos.get(1)!.estado_envio = "NO_ENTREGADO";
  const r = await procesarCola(e.d);
  assertEquals(r.devoluciones[0].accion, "cancelada");
  assertEquals(fe(e, 1).estado, "cancelada");
  assertEquals(e.eventos.map((x) => [x.tipo, x.estado]), [["cancelacion", "aprobado"]]);
  assert(e.avisos.some((a) => a.includes("cancelada")));
});

Deno.test("devuelto fuera de 48 h con RUC → NC (tipo 5) por el total asociada por CDC + aviso", async () => {
  const e = entorno();
  e.agregar(pedido(1, {}, { note_attributes: [{ name: "Ruc", value: `80012345-${digitoVerificadorRuc("80012345")}` }, { name: "Razon social", value: "Empresa Ficticia SA" }] }));
  await procesarCola(e.d);
  horas(e, 72);
  e.pedidos.get(1)!.estado_envio = "NO_ENTREGADO";
  const r = await procesarCola(e.d);
  assertEquals(r.devoluciones[0].accion, "nota_credito");
  const nc = [...e.filas.values()].find((f) => f.tipo_documento === 5)!;
  assertEquals([nc.estado, nc.factura_original_id, nc.total, nc.numero], ["aprobada", fe(e, 1).id, 162000, 1]);
  assertEquals(fe(e, 1).estado, "aprobada");
  assert(e.avisos.some((a) => a.includes("Nota de crédito")));
  // No se repite.
  const r2 = await procesarCola(e.d);
  assertEquals(r2.devoluciones[0]?.detalle, "ya tiene NC");
});

Deno.test("devuelto fuera de 48 h e innominada → 'revisar' (NC innominada prohibida, NT-023)", async () => {
  const e = entorno();
  e.agregar(pedido(1));
  await procesarCola(e.d);
  horas(e, 72);
  e.pedidos.get(1)!.estado_envio = "NO_ENTREGADO";
  const r = await procesarCola(e.d);
  assertEquals(r.devoluciones[0].accion, "revisar");
  assertEquals(fe(e, 1).estado, "revisar");
  assert(e.avisos.some((a) => a.includes("NT-014")));
  assertEquals([...e.filas.values()].filter((f) => f.tipo_documento === 5).length, 0);
});

Deno.test("RENDIDO y después devuelto → 'revisar' + aviso, sin cancelación ni NC (decisión 08-10)", async () => {
  const e = entorno();
  e.agregar(pedido(1, { estado_envio: "RENDIDO" }));
  await procesarCola(e.d);
  Object.assign(e.pedidos.get(1)!, { estado_envio: "NO_ENTREGADO", rendido: true });
  const r = await procesarCola(e.d);
  assertEquals(r.devoluciones[0].accion, "revisar");
  assertEquals(e.eventos.length, 0);
  assertEquals(fe(e, 1).estado, "revisar");
});

Deno.test("cancelar una FE con NC aprobada: primero se cancela la NC (MT Tabla J)", async () => {
  const e = entorno();
  e.agregar(pedido(1, {}, { note_attributes: [{ name: "Ruc", value: `80012345-${digitoVerificadorRuc("80012345")}` }, { name: "Razon social", value: "Empresa Ficticia SA" }] }));
  await procesarCola(e.d);
  horas(e, 50);
  e.pedidos.get(1)!.estado_envio = "NO_ENTREGADO";
  await procesarCola(e.d); // NC
  const f = fe(e, 1);
  f.aprobada_en = e.reloj.t.toISOString(); // forzamos que la FE esté en plazo para probar el orden
  const c = await cancelarFactura({ ...f }, "Prueba de orden", e.d);
  assert(c.ok);
  assertEquals(e.eventos.map((x) => x.factura_id), [[...e.filas.values()].find((x) => x.tipo_documento === 5)!.id, f.id]);
});

const mes = (iso: string) => iso.slice(0, 7);

Deno.test("inutilización: huecos y rechazos definitivos agrupados por mes, sin lo ya cubierto, rangos ≤ 1000", () => {
  const ahora = new Date("2026-11-11T12:00:00Z");
  const r = rangosAInutilizar({
    ultimo: 8,
    filas: [
      { numero: 1, estado: "aprobada", fecha: "2026-10-01T10:00:00Z" },
      { numero: 3, estado: "rechazada", fecha: "2026-10-02T10:00:00Z" },
      { numero: 5, estado: "aprobada", fecha: "2026-10-20T10:00:00Z" },
      { numero: 6, estado: "error", fecha: "2026-11-10T23:00:00Z" }, // reciente: todavía no es definitivo
      { numero: 7, estado: "enviada", fecha: "2026-11-01T10:00:00Z" },
    ],
    cubiertos: [{ desde: 8, hasta: 8 }],
    ahora,
    diasGracia: 2,
    diaLimite: 15,
    mesDe: mes,
  });
  assertEquals(r, [{ desde: 2, hasta: 4, mes: "2026-10", limite: "2026-11-15" }]);
  const grande = rangosAInutilizar({ ultimo: 2500, filas: [], cubiertos: [], ahora, diasGracia: 2, diaLimite: 15, mesDe: mes, maxRango: 1000 });
  assertEquals(grande.map((x) => [x.desde, x.hasta]), [[1, 1000], [1001, 2000], [2001, 2500]]);
});

Deno.test("cron de inutilización: manda solo meses cerrados, marca y avisa desde el día 10 si algo falla", async () => {
  const eventos: EventoSifen[] = [];
  const avisos: string[] = [];
  const opcionesInu: OpcionesAviso[] = [];
  const marcadas: number[][] = [];
  let rechazar = false;
  const ws = wsSimulado();
  const emisor = crearEmisorPropio({
    emisor: datosEmisorPrueba(), cred: credencialesDesdeEnv(() => undefined).cred, simulado: true,
    armarXmlDE: () => ({ xml: "", cdc: "", totales: totalesSimulados({ items: [] } as unknown as DocumentoDE) }),
    firmarXml: (x) => Promise.resolve({ xmlFirmado: x, digestValue: "" }), armarQr: (a) => ({ urlQr: "", xmlConQr: a.xmlFirmado }),
    generarKude: () => Promise.resolve(new Uint8Array()), ws: { ...ws, enviarEvento: (x) => rechazar ? Promise.resolve({ ok: false, estado: "rechazado", codigo: "4000" }) : ws.enviarEvento(x) },
    eventos: { cancelacion: () => ({ xml: "", id: "" }), inutilizacion: (a) => ({ xml: `${a.desde}`, id: "x" }) },
    ahora: () => new Date(), fechaSifen,
  });
  const deps = (ahora: string): DepsInutilizacion => ({
    ahora: () => new Date(ahora),
    cfg: configSifen({ activo: true }),
    emisor,
    mesDe: mes,
    diaDelMes: (d) => Number(d.toISOString().slice(8, 10)),
    series: () => Promise.resolve([{ timbrado: "12345678", clave_timbrado: "12345678-test", establecimiento: "001", punto: "001", tipo_documento: 1 as TipoDE, ultimo: 4 }]),
    numerosDeSerie: () => Promise.resolve([{ numero: 1, estado: "aprobada", fecha: "2026-10-05T00:00:00Z" }, { numero: 4, estado: "aprobada", fecha: "2026-11-02T00:00:00Z" }]),
    eventosCubiertos: () => Promise.resolve(eventos.filter((x) => x.estado !== "rechazado").map((x) => ({ desde: x.rango!.desde, hasta: x.rango!.hasta }))),
    registrarEvento: (x) => (eventos.push(x), Promise.resolve()),
    marcarInutilizadas: (_s, a, b) => (marcadas.push([a, b]), Promise.resolve()),
    avisar: (t, _b, o) => (avisos.push(t), o && opcionesInu.push(o), Promise.resolve()),
    escapar: String,
  });
  // 2 y 3 son huecos; su fecha de referencia es la del 4 (noviembre) → esperan si estamos en noviembre.
  let r = await procesarInutilizacion(deps("2026-11-05T12:00:00Z"));
  assertEquals(r.rangos.map((x) => x.resultado), ["espera_fin_de_mes"]);
  // En diciembre ya se manda.
  r = await procesarInutilizacion(deps("2026-12-03T12:00:00Z"));
  assertEquals(r.rangos.map((x) => [x.desde, x.hasta, x.resultado]), [[2, 3, "inutilizado"]]);
  assertEquals(marcadas, [[2, 3]]);
  // Ya cubierto: no se repite.
  r = await procesarInutilizacion(deps("2026-12-04T12:00:00Z"));
  assertEquals(r.rangos.length, 0);
  // Rechazado + día ≥ 10 → aviso.
  eventos.length = 0;
  rechazar = true;
  await procesarInutilizacion(deps("2026-12-11T12:00:00Z"));
  assertEquals(avisos.length, 1);
  // 27-10: a administración, como máximo 1 por día.
  assertEquals(opcionesInu, [{ tipo: "sifen_inutilizacion_pendiente", destino: "admin", pedido: null, clave: null, unaVezPorDia: true }]);
});

// ─── 27-10: política de avisos (Telegram solo para lo que el sistema no puede hacer) ───

Deno.test("27-10: todo aviso de SIFEN lleva tipo y va a administración; los errores, 1 por día con clave estable", async () => {
  const e = entorno();
  e.agregar(pedido(1, {}, { total_price: "999999" }));
  await procesarCola(e.d);
  assertEquals(e.opciones.length, e.avisos.length);
  assertEquals(e.opciones[0], { tipo: "sifen_revisar_validacion", destino: "admin", pedido: e.pedidos.get(1)!.nombre ?? "1", clave: "1", unaVezPorDia: true });
  // Sin corte: el error de la corrida va con unaVezPorDia y sin el texto como clave.
  const s = entorno({ cfg: { facturar_desde: null } });
  await procesarCola(s.d);
  assertEquals(s.opciones, [{ tipo: "sifen_sin_corte", destino: "admin", pedido: null, clave: null, unaVezPorDia: true }]);
  // Ningún aviso de SIFEN va a Enrique.
  assert([...e.opciones, ...s.opciones].every((o) => o.destino === "admin" && /^sifen_[a-z0-9_]+$/.test(o.tipo)));
});

Deno.test("27-10: devuelto dentro de 48 h → aviso informativo a administración con el pedido", async () => {
  const e = entorno();
  e.agregar(pedido(1));
  await procesarCola(e.d);
  e.pedidos.get(1)!.estado_envio = "NO_ENTREGADO";
  horas(e, 2);
  await procesarCola(e.d);
  const o = e.opciones.find((x) => x.tipo === "sifen_factura_cancelada");
  assert(o, JSON.stringify(e.opciones));
  assertEquals([o.destino, o.clave, o.unaVezPorDia], ["admin", fe(e, 1).id, undefined]);
});

// ─── Blindaje 10-10: corte facturar_desde, retenciones y medio de pago ───

/** Guarda el iTiPago de cada DocumentoDE que llega al emisor. */
function espiarPagos(e: ReturnType<typeof entorno>): Map<number, number | undefined> {
  const pagos = new Map<number, number | undefined>();
  const emitir = e.d.emisor.emitir.bind(e.d.emisor);
  e.d.emisor = { ...e.d.emisor, emitir: (doc, op) => (pagos.set(doc.shopifyOrderId!, doc.condicion?.pagos[0]?.tipo), emitir(doc, op)) };
  return pagos;
}

Deno.test("corte obligatorio: activo sin facturar_desde → no factura nada nuevo, avisa (1 por hora) y la llamada directa tampoco", async () => {
  const e = entorno({ cfg: { facturar_desde: null } });
  e.agregar(pedido(1));
  const r = await procesarCola(e.d);
  assertEquals([r.sin_corte, r.nuevos.length, e.filas.size], [true, 0, 0]);
  assert(e.avisos.some((a) => a.includes("falta facturar_desde")));
  e.reloj.t = new Date("2026-10-08T13:20:00Z"); // minuto 20: no repite el aviso
  await procesarCola(e.d);
  assertEquals(e.avisos.filter((a) => a.includes("falta facturar_desde")).length, 1);
  assertEquals((await facturarPedido(1, e.d)).accion, "sin_corte");
  assertEquals(e.filas.size, 0);
});

Deno.test("ventana = max(facturar_desde, ahora − dias_atras); facturar_desde inválido = sin corte", () => {
  const ahora = new Date("2026-10-08T13:00:00Z");
  assertEquals(desdeFacturar(configSifen({ activo: true, facturar_desde: "2026-01-01T00:00:00Z" }), ahora), "2026-10-06T13:00:00.000Z");
  assertEquals(desdeFacturar(configSifen({ activo: true, facturar_desde: "2026-10-08T03:00:00Z" }), ahora), "2026-10-08T03:00:00.000Z");
  assertEquals(desdeFacturar(configSifen({ activo: true, facturar_desde: null }), ahora), null);
  assertEquals(desdeFacturar(configSifen({ activo: true, facturar_desde: "cualquier cosa" }), ahora), null);
});

Deno.test("entregado antes del corte (post-entrega / manual) → facturas_retenidas 'anterior_al_corte', nunca se factura hasta liberarlo", async () => {
  const e = entorno({ cfg: { facturar_desde: "2026-10-08T03:00:00Z" } });
  e.agregar(pedido(1, { entregado_en: "2026-10-07T15:00:00Z" }), pedido(2));
  const r1 = await facturarPedido(1, e.d);
  assertEquals([r1.accion, r1.detalle], ["retenido", "anterior_al_corte"]);
  assertEquals(e.retenidas.get(1)?.motivo, "anterior_al_corte");
  assertEquals(e.filas.size, 0);
  // Segunda vez (otra corrida de post-entrega o un reintento manual): sigue retenido, sin duplicar.
  assertEquals((await facturarPedido(1, e.d)).accion, "retenido");
  assertEquals(e.retenidas.size, 1);
  // La cola factura el 2 y NO el 1 (ni por la ventana ni por la lista de liberados).
  const r = await procesarCola(e.d);
  assertEquals(r.nuevos.map((x) => x.accion), ["aprobada"]);
  assertEquals(fe(e, 2).estado, "aprobada");
  assert(!fe(e, 1));
  // Liberado con el criterio de la contadora (RPC sifen_liberar): lo toma la cola aunque esté fuera de la ventana.
  e.retenidas.get(1)!.liberado_en = "2026-10-08T14:00:00Z";
  const r2 = await procesarCola(e.d);
  assertEquals(r2.nuevos.map((x) => x.accion), ["aprobada"]);
  assertEquals(fe(e, 1).estado, "aprobada");
});

Deno.test("retención de otro motivo sin liberar: tampoco se factura aunque esté dentro de la ventana", async () => {
  const e = entorno();
  e.agregar(pedido(1));
  e.retenidas.set(1, { motivo: "criterio_contadora", nota: "", liberado_en: null });
  assertEquals((await facturarPedido(1, e.d)).accion, "retenido");
  await procesarCola(e.d);
  assertEquals(e.filas.size, 0);
});

Deno.test("post-entrega: fecha de entrega aún sin guardar viaja como entregadoEn; sin fecha no se factura ni se retiene", async () => {
  const e = entorno({ cfg: { facturar_desde: "2026-10-08T03:00:00Z" } });
  e.agregar(pedido(1, { entregado_en: null }), pedido(2, { entregado_en: null }), pedido(3, { entregado_en: null }));
  assertEquals((await facturarPedido(1, e.d, { entregadoEn: "2026-10-08T12:00:00Z" })).accion, "aprobada");
  assertEquals((await facturarPedido(2, e.d, { entregadoEn: "2026-10-07T12:00:00Z" })).accion, "retenido");
  const r3 = await facturarPedido(3, e.d);
  assertEquals(r3.accion, "no_facturable");
  assert(!e.retenidas.has(3));
  // Sin entregado_en tampoco entra por la ventana de la cola (se quitó "entregado_en is null y actualizado_en ≥ desde").
  await procesarCola(e.d);
  assert(!fe(e, 3));
});

Deno.test("cobro anticipado por transferencia (PAGO_VERIFICADO, Gs 112.000): iTiPago 5; entregado antes del corte → retenido", async () => {
  const e = entorno({ cfg: { facturar_desde: "2026-10-08T03:00:00Z" } });
  const pagos = espiarPagos(e);
  const raw = { total_price: "112000", line_items: [{ title: "Producto inventado", quantity: 1, price: "79000" }], shipping_lines: [{ price: "33000" }] };
  e.agregar(
    pedido(10, { total: 112000, tags: ["PAGO_VERIFICADO"], entregado_en: "2026-10-07T18:00:00Z" }, raw),
    pedido(11, { total: 112000, tags: ["PAGO_VERIFICADO"] }, raw),
    pedido(12, { total: 112000 }, raw),
  );
  assertEquals((await facturarPedido(10, e.d)).detalle, "anterior_al_corte");
  await procesarCola(e.d);
  assertEquals([fe(e, 11).estado, fe(e, 11).total, pagos.get(11)], ["aprobada", 112000, 5]);
  assertEquals(pagos.get(12), 1); // contra entrega: efectivo
  assert(!fe(e, 10) && !pagos.has(10));
  // Liberado: sale con transferencia.
  e.retenidas.get(10)!.liberado_en = "2026-10-08T14:00:00Z";
  await procesarCola(e.d);
  assertEquals([fe(e, 10).estado, pagos.get(10)], ["aprobada", 5]);
});

// ─── 29-10 · FACTURA AL COBRAR ───────────────────────────────
// Corte del entorno por defecto: facturar_desde 2026-01-01; reloj 2026-10-08T13:00Z (ventana desde 06-10 13:00).

const pagado = (id: number, over: Partial<PedidoSifen> = {}) =>
  pedido(id, { estado_envio: "EN_PREPARACION", entregado_en: null, tags: ["PAGADO", "PAGO_VERIFICADO", "PRIORIDAD"], pagado_en: "2026-10-08T12:30:00Z", ...over });

Deno.test("29-10 anticipado total → factura al pagar, sin esperar la entrega (iTiPago 5; QR → 7)", async () => {
  const e = entorno();
  const pagos = espiarPagos(e);
  e.agregar(pagado(1), pagado(2, { tags: ["PAGADO_QR"] }));
  // Disparo inmediato (facturarAlCobrar → sifen-cola {motivo:"pagado"} → facturarPedido).
  assertEquals((await facturarPedido(1, e.d)).accion, "aprobada");
  assertEquals([fe(e, 1).estado, pagos.get(1)], ["aprobada", 5]);
  // La cola toma el otro pagado no entregado (pagado_en dentro de la ventana).
  const r = await procesarCola(e.d);
  assertEquals(r.nuevos.map((x) => x.accion), ["aprobada"]);
  assertEquals(fe(e, 2).estado, "aprobada");
  assertEquals(pagos.get(2), 7);
  assertEquals(e.filas.size, 2);
});

Deno.test("29-10 contra entrega → solo al entregar; antes de la entrega no factura", async () => {
  const e = entorno();
  e.agregar(pedido(1, { estado_envio: "DESPACHADO", entregado_en: null }));
  const r0 = await facturarPedido(1, e.d);
  assertEquals(r0.accion, "no_facturable");
  assert(r0.detalle?.includes("todavía no está cobrado"), r0.detalle);
  await procesarCola(e.d);
  assertEquals(e.filas.size, 0);
  Object.assign(e.pedidos.get(1)!, { estado_envio: "ENTREGADO", entregado_en: "2026-10-08T12:45:00Z" });
  const r = await procesarCola(e.d);
  assertEquals(r.nuevos.map((x) => x.accion), ["aprobada"]);
});

Deno.test("29-10 pago parcial (SALDO_PENDIENTE / PAGO_PARCIAL) → no factura al pagar, sí al entregar", async () => {
  const e = entorno();
  // Aunque tenga PAGADO y (por error) pagado_en, con saldo pendiente no es pago completo.
  e.agregar(
    pedido(1, { estado_envio: "DESPACHADO", entregado_en: null, tags: ["PAGADO", "SALDO_PENDIENTE", "SALDO_50000"], pagado_en: "2026-10-08T12:00:00Z" }),
    pedido(2, { estado_envio: "DESPACHADO", entregado_en: null, tags: ["PAGO_VERIFICADO", "PAGO_PARCIAL"] }),
  );
  const r1 = await facturarPedido(1, e.d);
  assertEquals(r1.accion, "no_facturable");
  assert(r1.detalle?.includes("pago parcial"), r1.detalle);
  await procesarCola(e.d);
  assertEquals(e.filas.size, 0);
  for (const id of [1, 2]) Object.assign(e.pedidos.get(id)!, { estado_envio: "ENTREGADO", entregado_en: "2026-10-08T12:50:00Z" });
  const r = await procesarCola(e.d);
  assertEquals(r.nuevos.map((x) => x.accion), ["aprobada", "aprobada"]);
});

Deno.test("29-10 anticipado y después entregado → una sola factura (post-entrega responde ya_existe)", async () => {
  const e = entorno();
  e.agregar(pagado(1));
  await procesarCola(e.d);
  const f1 = fe(e, 1);
  assertEquals(f1.estado, "aprobada");
  Object.assign(e.pedidos.get(1)!, { estado_envio: "ENTREGADO", entregado_en: "2026-10-08T12:55:00Z" });
  assertEquals((await facturarPedido(1, e.d, { entregadoEn: "2026-10-08T12:55:00Z" })).accion, "ya_existe");
  const r = await procesarCola(e.d);
  assertEquals(r.nuevos.length, 0);
  assertEquals([...e.filas.values()].filter((f) => f.tipo_documento === 1).length, 1);
  assertEquals(e.ws.recibidos.size, 1);
});

Deno.test("29-10 doble 'Recibido' y cola + webhook en paralelo → una sola factura (conflicto del índice único)", async () => {
  // Simula la base: facturaDePedido todavía no ve la fila (las tres llamadas leen a la vez) y el INSERT que
  // pierde contra facturas_una_fe_por_pedido_ambiente recibe 23505 → crearFactura devuelve null.
  const e = entorno();
  e.agregar(pagado(1));
  e.d.facturaDePedido = () => Promise.resolve(null);
  let inserts = 0;
  const crear = e.d.crearFactura;
  e.d.crearFactura = (f) => (inserts++, crear(f));
  const r = await Promise.all([facturarPedido(1, e.d), facturarPedido(1, e.d), procesarCola(e.d)]);
  const acciones = [r[0].accion, r[1].accion, ...(r[2] as Awaited<ReturnType<typeof procesarCola>>).nuevos.map((x) => x.accion)];
  assertEquals(acciones.filter((a) => a === "aprobada").length, 1, JSON.stringify(acciones));
  assertEquals(acciones.filter((a) => a === "ya_existe").length, 2, JSON.stringify(acciones));
  assertEquals(inserts, 3);
  assertEquals(e.filas.size, 1);
  assertEquals([...e.ws.recibidos.values()], [1]);
  assertEquals(e.numeracion.get("12345678/001/001/1"), 1);
});

Deno.test("29-10 crearFactura falso que devuelve null la segunda vez → ya_existe, sin emitir", async () => {
  const e = entorno();
  e.agregar(pagado(1));
  e.d.facturaDePedido = () => Promise.resolve(null); // la lectura previa no ve la fila (carrera)
  let n = 0;
  const crear = e.d.crearFactura;
  e.d.crearFactura = (f) => (++n === 1 ? crear(f) : Promise.resolve(null));
  assertEquals((await facturarPedido(1, e.d)).accion, "aprobada");
  assertEquals((await facturarPedido(1, e.d)).accion, "ya_existe");
  assertEquals([e.filas.size, e.ws.recibidos.size], [1, 1]);
});

Deno.test("29-10 pagado + cancelado sin entregar (48 h) → evento de cancelación + aviso de reembolso a Enrique, una vez", async () => {
  for (const cambio of [
    { raw: { cancelled_at: "2026-10-08T15:00:00Z" } },
    { estado_confirmacion: "cancelado_cliente" },
    { tags: ["PAGADO", "PAGO_VERIFICADO", "CANCELADO_CLIENTE"] },
    { estado_envio: "NO_ENTREGADO" },
    { estado_envio: "CANCELADO" },
  ] as Array<Partial<PedidoSifen> & { raw?: Record<string, unknown> }>) {
    const e = entorno();
    e.agregar(pagado(1, { telefono: "595981000111" }));
    await procesarCola(e.d);
    horas(e, 3);
    const p = e.pedidos.get(1)!;
    Object.assign(p, { ...cambio, raw: { ...(p.raw as Record<string, unknown>), ...(cambio.raw ?? {}) } });
    const r = await procesarCola(e.d);
    assertEquals(r.devoluciones.map((x) => x.accion), ["cancelada"], JSON.stringify(cambio));
    assertEquals(fe(e, 1).estado, "cancelada");
    assertEquals(e.eventos.map((x) => x.tipo), ["cancelacion"]);
    const i = e.opciones.findIndex((o) => o.tipo === "sifen_reembolso");
    assert(i >= 0, JSON.stringify(e.opciones));
    assertEquals([e.opciones[i].destino, e.opciones[i].clave, e.opciones[i].unaVezPorDia], ["enrique", "reembolso:1", true]);
    const txt = e.avisos.find((a) => a.includes("Reembolso pendiente"))!;
    for (const x of ["#1", "162000", "595981000111", "transferencia"]) assert(txt.includes(x), `${x} en ${txt}`);
    // Otra corrida: la factura ya está cancelada → no se repite nada.
    await procesarCola(e.d);
    assertEquals(e.avisos.filter((a) => a.includes("Reembolso pendiente")).length, 1);
    assertEquals(e.eventos.length, 1);
  }
});

Deno.test("29-10 pagado con RUC, cancelado fuera de las 48 h → NC por el total + aviso de reembolso (QR)", async () => {
  const e = entorno();
  e.agregar(pagado(1, { tags: ["PAGADO_QR"] }, ), );
  e.pedidos.get(1)!.raw = { ...(e.pedidos.get(1)!.raw as Record<string, unknown>), note_attributes: [{ name: "Ruc", value: `80012345-${digitoVerificadorRuc("80012345")}` }, { name: "Razon social", value: "Empresa Ficticia SA" }] };
  await procesarCola(e.d);
  horas(e, 72);
  e.pedidos.get(1)!.estado_confirmacion = "cancelado_cliente";
  const r = await procesarCola(e.d);
  assertEquals(r.devoluciones[0].accion, "nota_credito");
  assertEquals([...e.filas.values()].filter((f) => f.tipo_documento === 5).length, 1);
  const txt = e.avisos.find((a) => a.includes("Reembolso pendiente"))!;
  assert(txt.includes("QR") && txt.includes("nota de crédito"), txt);
  await procesarCola(e.d);
  assertEquals(e.avisos.filter((a) => a.includes("Reembolso pendiente")).length, 1);
});

Deno.test("29-10 contra entrega devuelto → cancelación SIN aviso de reembolso (no pagó nada)", async () => {
  const e = entorno();
  e.agregar(pedido(1));
  await procesarCola(e.d);
  e.pedidos.get(1)!.estado_envio = "NO_ENTREGADO";
  await procesarCola(e.d);
  assertEquals(fe(e, 1).estado, "cancelada");
  assert(!e.opciones.some((o) => o.tipo === "sifen_reembolso"));
});

Deno.test("29-10 reenvío / reprogramación → la factura no se toca", async () => {
  for (const estado of ["INTENTO_FALLIDO", "NO_ENTREGADO_RESCATABLE", "DESPACHADO", "EN_PREPARACION"]) {
    const e = entorno();
    e.agregar(pagado(1, { estado_envio: "DESPACHADO" }));
    await procesarCola(e.d);
    const antes = { ...fe(e, 1) };
    e.pedidos.get(1)!.estado_envio = estado;
    const r = await procesarCola(e.d);
    assertEquals([r.nuevos.length, r.devoluciones.length], [0, 0], estado);
    assertEquals((await procesarDevolucion(fe(e, 1), e.pedidos.get(1)!, e.d)).accion, "sin_cambios");
    assertEquals((await facturarPedido(1, e.d)).accion, "ya_existe");
    assertEquals([fe(e, 1).estado, fe(e, 1).numero, e.eventos.length, e.filas.size], [antes.estado, antes.numero, 0, 1], estado);
  }
  // Entregado con una tag CANCELADO_CLIENTE vieja: tampoco se anula (se entregó y se cobró).
  const e = entorno();
  e.agregar(pedido(1, { tags: ["CANCELADO_CLIENTE"] }));
  await procesarCola(e.d);
  assertEquals(fe(e, 1).estado, "aprobada");
  assertEquals((await procesarDevolucion(fe(e, 1), e.pedidos.get(1)!, e.d)).accion, "sin_cambios");
});

Deno.test("29-10 fecha de cobro anterior a facturar_desde → retenido (pagado antes del corte, aunque se entregue después)", async () => {
  const e = entorno({ cfg: { facturar_desde: "2026-10-08T03:00:00Z" } });
  e.agregar(pagado(1, { pagado_en: "2026-10-07T20:00:00Z" }));
  const r = await facturarPedido(1, e.d);
  assertEquals([r.accion, r.detalle], ["retenido", "anterior_al_corte"]);
  assert(e.retenidas.get(1)?.nota.startsWith("pagado 2026-10-07T20:00:00Z"), e.retenidas.get(1)?.nota);
  // Se entrega después del corte: manda la fecha de COBRO (pagado_en), sigue retenido.
  Object.assign(e.pedidos.get(1)!, { estado_envio: "ENTREGADO", entregado_en: "2026-10-08T12:00:00Z" });
  await procesarCola(e.d);
  assertEquals(e.filas.size, 0);
  assertEquals((await facturarPedido(1, e.d)).accion, "retenido");
});

Deno.test("29-10 la cola toma los pagados no entregados; pagado sin pagado_en espera la entrega; cancelado no", async () => {
  const e = entorno();
  e.agregar(
    pagado(1),
    pagado(2, { estado_envio: null }),
    pagado(3, { pagado_en: null }), // pagó antes de la migración: sin fecha → al entregar
    pagado(4, { estado_confirmacion: "cancelado_cliente" }),
    pagado(5, { pagado_en: "2026-10-01T00:00:00Z" }), // fuera de la ventana de 2 días
  );
  const r = await procesarCola(e.d);
  assertEquals(r.nuevos.filter((x) => x.accion === "aprobada").length, 2);
  assertEquals([fe(e, 1)?.estado, fe(e, 2)?.estado], ["aprobada", "aprobada"]);
  assertEquals((await facturarPedido(3, e.d)).detalle?.startsWith("pagado sin pagado_en"), true);
  assertEquals((await facturarPedido(4, e.d)).accion, "no_facturable");
  assert(!fe(e, 3) && !fe(e, 4) && !fe(e, 5));
  // El 5 igual se factura: la llamada directa no depende de la ventana, solo del corte.
  assertEquals((await facturarPedido(5, e.d)).accion, "aprobada");
});

Deno.test("29-10 KuDE: se guarda kude_canal junto con kude_enviado_en ('plantilla' si el canal no viene)", async () => {
  const e = entorno();
  e.agregar(pedido(1), pedido(2));
  let n = 0;
  e.d.enviarKude = () => Promise.resolve(++n === 1 ? { ok: true } : { ok: true, canal: "correo" as const });
  await procesarCola(e.d);
  assertEquals([fe(e, 1).kude_canal, fe(e, 2).kude_canal], ["plantilla", "correo"]);
  assert(fe(e, 1).kude_enviado_en && fe(e, 2).kude_enviado_en);
  // Si falla, no se marca canal.
  const f = entorno();
  f.agregar(pedido(1));
  f.d.enviarKude = () => Promise.resolve({ ok: false, error: "x" });
  await procesarCola(f.d);
  assertEquals([fe(f, 1).kude_canal, fe(f, 1).kude_enviado_en], [undefined, undefined]);
  assertEquals(fechaCobro(f.pedidos.get(1)!)?.via, "entregado");
});
