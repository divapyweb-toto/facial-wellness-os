import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { clienteDesdeCredenciales, crearClienteSifen, MENSAJE_PROD_NO_AUTORIZADA, URLS_SIFEN } from "./ws.ts";
import { type Transporte, TransporteSimulado } from "./transporte.ts";
import { firmarConCertificado } from "./firma.ts";
import { cargarP12, generarCertificadoPrueba } from "./certificado.ts";
import type { CredencialesSifen } from "./tipos.ts";

const NS = "http://ekuatia.set.gov.py/sifen/xsd";
const CDC = "01" + "80000000" + "0" + "001" + "001" + "0000001" + "2" + "20261008" + "1" + "123456789" + "2";
const cdcN = (n: number) => CDC.slice(0, 18) + String(n).padStart(7, "0") + CDC.slice(25);
const rde = (cdc: string) =>
  `<rDE xmlns="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${NS} siRecepDE_v150.xsd"><dVerFor>150</dVerFor><DE Id="${cdc}"><dDVId>2</dDVId></DE></rDE>`;
const evento = (id: string) =>
  `<gGroupGesEve xmlns="${NS}"><rGesEve><rEve Id="${id}"><dVerFor>150</dVerFor><gGroupTiEvt><rGeVeCan><Id>${CDC}</Id><mOtEve>Prueba</mOtEve></rGeVeCan></gGroupTiEvt></rEve></rGesEve></gGroupGesEve>`;

async function firmar(xml: string, id: string) {
  const c = cargarP12((await generarCertificadoPrueba()).p12, "prueba");
  return firmarConCertificado(xml, id, c).xmlFirmado;
}
const sinEspera = { dormir: () => Promise.resolve(), esperaBaseMs: 1 };
const espia = (): Transporte & { llamadas: number } => ({
  llamadas: 0,
  post() {
    this.llamadas++;
    return Promise.resolve({ status: 200, body: "" });
  },
});

Deno.test("URLs oficiales (MT §7.10 + Mejores Prácticas): POST a .wsdl sin ?wsdl", () => {
  assertEquals(URLS_SIFEN.test, {
    recibe: "https://sifen-test.set.gov.py/de/ws/sync/recibe.wsdl",
    recibeLote: "https://sifen-test.set.gov.py/de/ws/async/recibe-lote.wsdl",
    consultaLote: "https://sifen-test.set.gov.py/de/ws/consultas/consulta-lote.wsdl",
    consulta: "https://sifen-test.set.gov.py/de/ws/consultas/consulta.wsdl",
    evento: "https://sifen-test.set.gov.py/de/ws/eventos/evento.wsdl",
    consultaRuc: "https://sifen-test.set.gov.py/de/ws/consultas/consulta-ruc.wsdl",
  });
  assertEquals(URLS_SIFEN.prod.recibe, "https://sifen.set.gov.py/de/ws/sync/recibe.wsdl");
  assertEquals(URLS_SIFEN.prod.consultaRuc, "https://sifen.set.gov.py/de/ws/consultas/consulta-ruc.wsdl");
});

Deno.test("GUARDIA: prod sin autorización lanza ANTES de cualquier red", async () => {
  const t = espia();
  assertThrows(() => crearClienteSifen({ ambiente: "prod", produccionAutorizada: false, transporte: t }), Error, MENSAJE_PROD_NO_AUTORIZADA);
  // deno-lint-ignore no-explicit-any
  assertThrows(() => crearClienteSifen({ ambiente: "prod", produccionAutorizada: "si" as any, transporte: t }), Error, MENSAJE_PROD_NO_AUTORIZADA);
  const c = await generarCertificadoPrueba();
  const cred: CredencialesSifen = { ambiente: "prod", timbrado: "12345678", timbradoInicio: "2026-01-01", csc: "x", cscId: "0001", certP12: c.p12, certClave: c.clave, produccionAutorizada: false };
  assertThrows(() => clienteDesdeCredenciales(cred), Error, MENSAJE_PROD_NO_AUTORIZADA); // ni abre el cert
  assertEquals(t.llamadas, 0);
  // Con autorización explícita se construye (no se llama: el transporte es un espía)
  const ok = crearClienteSifen({ ambiente: "prod", produccionAutorizada: true, transporte: t });
  assertEquals(ok.ambiente, "prod");
});

Deno.test("enviarDE aprobado y rechazado (simulado)", async () => {
  const t = new TransporteSimulado({ escenario: "aprobado" });
  const cli = crearClienteSifen({ ambiente: "test", produccionAutorizada: false, transporte: t, ...sinEspera });
  const x = await firmar(rde(CDC), CDC);
  const a = await cli.enviarDE(x);
  assertEquals([a.ok, a.estado, a.codigo], [true, "aprobado", "0260"]);
  assert(a.protocolo);
  assertEquals(t.solicitudes[0].url, URLS_SIFEN.test.recibe);
  t.escenario = "rechazado";
  const r = await cli.enviarDE(await firmar(rde(cdcN(9)), cdcN(9)));
  assertEquals([r.ok, r.estado, r.codigo], [false, "rechazado", "1000"]);
});

Deno.test("corte de red tras procesar → consulta CDC → NO reenvía porque ya estaba aprobado", async () => {
  const t = new TransporteSimulado({ guion: ["corte_despues_de_procesar"], escenario: "aprobado" });
  const cli = crearClienteSifen({ ambiente: "test", produccionAutorizada: false, transporte: t, ...sinEspera });
  const x = await firmar(rde(CDC), CDC);
  const r = await cli.enviarDESeguro(x);
  assertEquals([r.ok, r.estado, r.codigo], [true, "aprobado", "0422"]);
  assertEquals(t.contar("rEnviDe"), 1, "un solo envío");
  assertEquals(t.contar("rEnviConsDeRequest"), 1);
});

Deno.test("timeout sin procesar → consulta 0420 → reenvía una vez y aprueba", async () => {
  const t = new TransporteSimulado({ guion: ["timeout"], escenario: "aprobado" });
  const cli = crearClienteSifen({ ambiente: "test", produccionAutorizada: false, transporte: t, ...sinEspera });
  const r = await cli.enviarDESeguro(await firmar(rde(CDC), CDC));
  assertEquals([r.ok, r.estado], [true, "aprobado"]);
  assertEquals(t.contar("rEnviDe"), 2);
  assertEquals(t.contar("rEnviConsDeRequest"), 1);
});

Deno.test("enviarDE: sin conexión (no llegó) reintenta con backoff; corte con posible recepción NO reintenta", async () => {
  const esperas: number[] = [];
  const t = new TransporteSimulado({ guion: ["sin_conexion", "sin_conexion"], escenario: "aprobado" });
  const cli = crearClienteSifen({ ambiente: "test", produccionAutorizada: false, transporte: t, esperaBaseMs: 100, dormir: (ms) => (esperas.push(ms), Promise.resolve()) });
  const r = await cli.enviarDE(await firmar(rde(CDC), CDC));
  assertEquals(r.estado, "aprobado");
  assertEquals(esperas, [100, 200]);
  const t2 = new TransporteSimulado({ guion: ["timeout"], escenario: "aprobado" });
  const cli2 = crearClienteSifen({ ambiente: "test", produccionAutorizada: false, transporte: t2, ...sinEspera });
  const r2 = await cli2.enviarDE(await firmar(rde(CDC), CDC));
  assertEquals([r2.estado, r2.consultarAntesDeReenviar], ["error_red", true]);
  assertEquals(t2.contar("rEnviDe"), 1);
});

Deno.test("todo caído: enviarDESeguro devuelve error_red con consultarAntesDeReenviar (para reintento posterior ≤72 h)", async () => {
  const t = new TransporteSimulado({ escenario: "timeout" });
  const cli = crearClienteSifen({ ambiente: "test", produccionAutorizada: false, transporte: t, reintentos: 2, ...sinEspera });
  const r = await cli.enviarDESeguro(await firmar(rde(CDC), CDC));
  assertEquals([r.ok, r.estado, r.consultarAntesDeReenviar], [false, "error_red", true]);
  assertEquals(t.contar("rEnviDe"), 1);
  assertEquals(t.contar("rEnviConsDeRequest"), 3, "consulta idempotente: 1 + 2 reintentos");
});

Deno.test("lote: enviar → 0361 → 0362 con detalle; corte en el envío NO reenvía el lote", async () => {
  const t = new TransporteSimulado({ escenario: "aprobado", consultasLoteEnProceso: 1 });
  const cli = crearClienteSifen({ ambiente: "test", produccionAutorizada: false, transporte: t, ...sinEspera });
  const xs = [await firmar(rde(cdcN(1)), cdcN(1)), await firmar(rde(cdcN(2)), cdcN(2))];
  const env = await cli.enviarLote(xs);
  assertEquals([env.ok, env.estado, env.codigo], [true, "en_proceso", "0300"]);
  const c1 = await cli.consultarLote(env.protocolo!);
  assertEquals([c1.estado, c1.codigo], ["en_proceso", "0361"]);
  const c2 = await cli.consultarLote(env.protocolo!);
  assertEquals([c2.estado, c2.codigo, c2.documentos?.length], ["aprobado", "0362", 2]);
  assertEquals(c2.documentos!.map((d) => d.cdc), [cdcN(1), cdcN(2)]);
  const t2 = new TransporteSimulado({ guion: ["corte_despues_de_procesar"] });
  const cli2 = crearClienteSifen({ ambiente: "test", produccionAutorizada: false, transporte: t2, ...sinEspera });
  const r = await cli2.enviarLote(xs);
  assertEquals([r.estado, r.consultarAntesDeReenviar], ["error_red", true]);
  assertEquals(t2.contar("rEnvioLote"), 1);
});

Deno.test("evento y consulta RUC (simulado)", async () => {
  const t = new TransporteSimulado();
  const cli = crearClienteSifen({ ambiente: "test", produccionAutorizada: false, transporte: t, ...sinEspera });
  const ev = await cli.enviarEvento(await firmar(evento("44"), "44"));
  assertEquals([ev.ok, ev.codigo], [true, "0600"]);
  assertEquals(t.solicitudes[0].url, URLS_SIFEN.test.evento);
  const ruc = await cli.consultarRuc("80000005-6");
  assertEquals([ruc.ok, ruc.codigo, ruc.contribuyente?.ruc], [true, "0502", "80000005"]);
});
