// Tests del emisor propio con dobles (sin red). Datos inventados.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { DocumentoDE, RespuestaSifen } from "./tipos.ts";
import { type ClienteWsSifen, crearEmisorPropio, type DepsEmisorPropio, wsSimulado } from "./emisor_propio.ts";
import { cdcSimuladoDoc, credencialesDesdeEnv, datosEmisorPrueba, totalesSimulados } from "./emisor.ts";
import { fechaSifen } from "./desde_pedido.ts";

function doc(over: Partial<DocumentoDE> = {}): DocumentoDE {
  return {
    tipo: 1,
    establecimiento: "001",
    punto: "001",
    numero: 15,
    fechaEmision: "2026-10-08T10:00:00",
    tipoEmision: 1,
    codigoSeguridad: "123456789",
    receptor: { tipo: "innominado", pais: "PRY" },
    items: [{ codigo: "P1", descripcion: "Producto", cantidad: 1, precioUnitario: 129000, ivaTasa: 10, ivaAfectacion: 1, unidadMedida: 77 }],
    moneda: "PYG",
    condicion: { tipo: 1, pagos: [{ tipo: 1, monto: 129000 }] },
    ...over,
  };
}

function deps(ws: ClienteWsSifen, over: Partial<DepsEmisorPropio> = {}) {
  const log = { firmas: 0, kudes: 0, esperas: [] as number[] };
  const d: DepsEmisorPropio = {
    emisor: datosEmisorPrueba(),
    cred: credencialesDesdeEnv(() => undefined).cred,
    simulado: true,
    armarXmlDE: (x, e) => {
      const cdc = cdcSimuladoDoc(x, e);
      return { xml: `<rDE><DE Id="${cdc}"></DE></rDE>`, cdc, totales: totalesSimulados(x) };
    },
    firmarXml: (xml) => (log.firmas++, Promise.resolve({ xmlFirmado: xml + "<!--firma-->", digestValue: "ZGln" })),
    armarQr: (a) => ({ urlQr: `https://qr.test/?Id=${a.cdc}`, xmlConQr: a.xmlFirmado.replace("</rDE>", `<gCamFuFD><dCarQR>https://qr.test/?Id=${a.cdc}</dCarQR></gCamFuFD></rDE>`) }),
    generarKude: () => (log.kudes++, Promise.resolve(new Uint8Array([37, 80, 68, 70]))),
    ws,
    eventos: {
      cancelacion: (a) => ({ xml: `<rEve Id="1"><Id>${a.cdc}</Id></rEve>`, id: "1" }),
      inutilizacion: (a) => ({ xml: `<rEve Id="2">${a.desde}-${a.hasta}</rEve>`, id: "2" }),
    },
    ahora: () => new Date("2026-10-08T13:00:00Z"),
    esperar: (ms) => (log.esperas.push(ms), Promise.resolve()),
    fechaSifen,
    ...over,
  };
  return { d, log };
}

Deno.test("emite: aprobada con CDC de 44 dígitos, totales, XML firmado, QR y KuDE", async () => {
  const ws = wsSimulado();
  const { d, log } = deps(ws);
  const r = await crearEmisorPropio(d).emitir(doc());
  assertEquals(r.estado, "aprobada");
  assert(r.ok && /^\d{44}$/.test(r.cdc!));
  assertEquals(r.numeroCompleto, "001-001-0000015");
  assertEquals(r.totales?.total, 129000);
  assertEquals(r.totales?.iva10, Math.round(129000 / 11));
  assert(r.xmlFirmado?.includes("dCarQR") && r.kudePdf?.length);
  assertEquals(ws.recibidos.get(r.cdc!), 1);
  assertEquals(log.kudes, 1);
});

Deno.test("contingencia no habilitada: aunque llegue tipoEmision 2, se emite con 1 (rechazo 1050)", async () => {
  let visto = 0;
  const { d } = deps(wsSimulado(), { armarXmlDE: (x, e) => (visto = x.tipoEmision, { xml: `<DE Id="${cdcSimuladoDoc(x, e)}"/>`, cdc: cdcSimuladoDoc(x, e), totales: totalesSimulados(x) }) });
  await crearEmisorPropio(d).emitir(doc({ tipoEmision: 2 }));
  assertEquals(visto, 1);
});

Deno.test("caída de red a mitad del envío (el DE SÍ llegó): consulta el CDC y NO reenvía", async () => {
  const ws = wsSimulado({ fallasRedLlegando: 1 });
  const { d, log } = deps(ws);
  const r = await crearEmisorPropio(d).emitir(doc());
  assertEquals(r.estado, "aprobada");
  assertEquals(ws.recibidos.get(r.cdc!), 1); // un solo envío
  assertEquals(log.esperas.length, 1);
});

Deno.test("caída de red y el DE NO llegó: la consulta dice inexistente → recién ahí reenvía (una vez)", async () => {
  const ws = wsSimulado({ fallasRedSinLlegar: 1 });
  const { d } = deps(ws);
  const r = await crearEmisorPropio(d).emitir(doc());
  assertEquals(r.estado, "aprobada");
  assertEquals(ws.recibidos.get(r.cdc!), 1);
});

Deno.test("SIFEN no responde ni a la consulta → 'enviada' (pendiente), sin reenviar a ciegas", async () => {
  const caido: ClienteWsSifen = {
    ...wsSimulado(),
    enviarDE: () => Promise.resolve({ ok: false, estado: "error_red", mensaje: "timeout" } as RespuestaSifen),
    consultarDE: () => Promise.resolve({ ok: false, estado: "error_red", mensaje: "timeout" } as RespuestaSifen),
  };
  let envios = 0;
  const ws = { ...caido, enviarDE: (x: string) => (envios++, caido.enviarDE(x)) };
  const { d } = deps(ws);
  const r = await crearEmisorPropio(d).emitir(doc());
  assertEquals(r.estado, "enviada");
  assert(!r.ok && r.cdc && r.xmlFirmado);
  assertEquals(envios, 1);
});

Deno.test("reintento con cdcPrevio ya aprobado en SIFEN: consulta, no reenvía, y retransmite el MISMO XML firmado", async () => {
  const ws = wsSimulado();
  const { d, log } = deps(ws);
  const em = crearEmisorPropio(d);
  const primero = await em.emitir(doc());
  const firmasAntes = log.firmas;
  const r = await em.emitir(doc(), { cdcPrevio: primero.cdc, xmlFirmadoPrevio: primero.xmlFirmado, urlQrPrevio: primero.urlQr });
  assertEquals(r.estado, "aprobada");
  assertEquals(ws.recibidos.get(primero.cdc!), 1);
  assertEquals(log.firmas, firmasAntes); // no se volvió a firmar
  assertEquals(r.xmlFirmado, primero.xmlFirmado);
});

Deno.test("rechazo de SIFEN → 'rechazada' con código; XSD inválido → error sin enviar", async () => {
  const ws = wsSimulado({ rechazarSi: "DE Id" });
  const r = await crearEmisorPropio(deps(ws).d).emitir(doc());
  assertEquals(r.estado, "rechazada");
  assertEquals(r.codigo, "0160");
  const ws2 = wsSimulado();
  const x = await crearEmisorPropio(deps(ws2, { validarXsd: () => ({ ok: false, errores: ["falta dRucEm"] }) }).d).emitir(doc());
  assertEquals(x.estado, "error");
  assertEquals(ws2.recibidos.size, 0);
});

Deno.test("KuDE falla: la factura igual queda aprobada (sin PDF) para reintentarlo", async () => {
  const { d } = deps(wsSimulado(), { generarKude: () => Promise.reject(new Error("pdf roto")) });
  const r = await crearEmisorPropio(d).emitir(doc());
  assertEquals(r.estado, "aprobada");
  assertEquals(r.kudePdf, undefined);
  assert(r.mensaje?.includes("KuDE"));
});

Deno.test("sin número: pide siguienteNumero; cancelar e inutilizar firman y mandan el evento", async () => {
  const ws = wsSimulado();
  const pedidos: string[] = [];
  const { d } = deps(ws, { siguienteNumero: (t, e, p, tipo) => (pedidos.push(`${t}/${e}/${p}/${tipo}`), Promise.resolve(99)) });
  const em = crearEmisorPropio(d);
  const r = await em.emitir(doc({ numero: 0 }));
  assertEquals(r.numeroCompleto, "001-001-0000099");
  assertEquals(pedidos.length, 1);
  assertEquals((await em.cancelar(r.cdc!, "Pedido devuelto por el cliente")).estado, "aprobado");
  assertEquals((await em.inutilizar({ tipo: 1, establecimiento: "001", punto: "001", desde: 3, hasta: 4, motivo: "Saltado por error" })).estado, "aprobado");
  assertEquals(ws.eventos.length, 2);
});
