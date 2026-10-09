// scripts/bateria-pruebas-sifen.ts · Batería oficial de la Guía de Pruebas e-kuatia (feb-2026) en el ambiente TEST.
// Se corre con el envoltorio Node: `node scripts/bateria-pruebas-sifen.mjs` (ese invoca `deno run` sobre este archivo).
//
// - NUNCA usa producción: el ambiente se fuerza a "test" y SIFEN_PRODUCCION_AUTORIZADA se ignora.
// - Si no hay certificado real + timbrado + CSC en el entorno → MODO SIMULADO (sin red) y lo dice en el reporte.
//   La Guía exige certificado cualificado incluso en test: sin él la batería solo prueba el armado local.
// - Reporte: docs/sifen-bateria/reporte-<fecha>.md y .json (+ KuDE en PDF) — carpeta ignorada por Git.
// Conteos: docs/sifen-requisitos.md §5 (agente A). Ajustables en CASOS.
//
// Variables opcionales (además de las de ENV_SIFEN):
//   SIFEN_BATERIA_EMISOR_JSON   DatosEmisor en JSON (por defecto: datos inventados de prueba)
//   SIFEN_BATERIA_RECEPTOR_RUC  "RUC-DV" de un contribuyente receptor (por defecto: el mismo emisor)
//   SIFEN_BATERIA_RECEPTOR_RAZON razón social de ese RUC
//   SIFEN_BATERIA_NUMERO_DESDE  primer número a usar (por defecto 1; usar uno libre si se repite la batería)
//   SIFEN_BATERIA_ESPERA_LOTE_MIN minutos máximos esperando los lotes asíncronos (por defecto 15)

import type { DatosEmisor, DocumentoDE, ItemDE, RespuestaSifen, TipoDE } from "../supabase/functions/_shared/sifen/tipos.ts";
import { cargarModulosSifen, credencialesDesdeEnv, datosEmisorPrueba, CARGADORES } from "../supabase/functions/_shared/sifen/emisor.ts";
import { type ClienteWsSifen, crearEmisorPropio, type DepsEmisorPropio, type EmisorPropio } from "../supabase/functions/_shared/sifen/emisor_propio.ts";
import { codigoSeguridadAleatorio, fechaSifen } from "../supabase/functions/_shared/sifen/desde_pedido.ts";

// ─── Casos (Guía de Pruebas feb-2026, docs/sifen-requisitos.md §5) ───
export const CASOS = {
  tipos: [1, 5, 6, 4, 7] as TipoDE[], // FE, NC, ND, AF, NR
  syncAprobados: 5, // por tipo
  syncRechazados: 5, // por tipo, errores distintos
  asyncAprobados: 5, // por tipo, 1 lote por tipo
  asyncRechazados: 5, // por tipo, 1 lote por tipo
  cancelaciones: 5,
  inutilizaciones: [1, 1, 5, 6, 4] as TipoDE[], // 2 FE, 1 NC, 1 ND, 1 AF
  eventosReceptor: 15, // conformidad/disconformidad/desconocimiento/notificación/ajuste ×3 [VERIFICAR cómo hacerlos en test]
  consultasPorTipo: 3,
  kudePorTipo: 1,
  qrPorTipo: 2,
};

const NOMBRE: Record<number, string> = { 1: "FE", 4: "AF", 5: "NC", 6: "ND", 7: "NR" };

interface Resultado {
  bloque: string;
  tipo?: string;
  caso: string;
  esperado: string;
  obtenido: string;
  ok: boolean | "simulado" | "pendiente";
  cdc?: string;
  codigo?: string;
  mensaje?: string;
}

const raiz = new URL("../", import.meta.url);
const sello = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dirSalida = new URL(`docs/sifen-bateria/${sello}/`, raiz);

// ─── Entorno: SIEMPRE test ───
const envReal = (n: string) => Deno.env.get(n) ?? undefined;
if ((envReal("SIFEN_AMBIENTE") ?? "test") === "prod") {
  console.error("La batería NUNCA corre en producción. Sacá SIFEN_AMBIENTE=prod.");
  Deno.exit(2);
}
const env = (n: string) => n === "SIFEN_AMBIENTE" ? "test" : n === "SIFEN_PRODUCCION_AUTORIZADA" ? undefined : envReal(n);

const est = credencialesDesdeEnv(env);
const simulado = est.simulado;
const cred = est.cred;
cred.ambiente = "test";
cred.produccionAutorizada = false;
const emisorDatos: DatosEmisor = envReal("SIFEN_BATERIA_EMISOR_JSON") ? JSON.parse(envReal("SIFEN_BATERIA_EMISOR_JSON")!) : datosEmisorPrueba();

// En simulado sin .p12: autofirmado de prueba (certificado.ts) para usar la firma y el QR reales.
let usarFirmaReal = !est.certDePrueba;
if (simulado && est.certDePrueba) {
  try {
    const cm = await CARGADORES.certificado();
    const c = await (cm.generarCertificadoPrueba as (o: unknown) => Promise<{ p12: Uint8Array; clave: string }>)({ ruc: emisorDatos.ruc, dv: emisorDatos.dv });
    cred.certP12 = c.p12;
    cred.certClave = c.clave;
    usarFirmaReal = true;
  } catch (e) {
    console.warn("sin certificado de prueba:", e);
  }
}
const mod = await cargarModulosSifen(simulado, cred, { usarFirmaReal });

// Cliente WS completo de C (para lotes) solo en modo real.
// deno-lint-ignore no-explicit-any
let clienteC: any = null;
if (!simulado) {
  const ws = await CARGADORES.ws();
  clienteC = (ws.clienteDesdeCredenciales as (c: unknown) => unknown)(cred);
}

// Numeración propia de la batería (por tipo y punto).
const desde = Number(envReal("SIFEN_BATERIA_NUMERO_DESDE") ?? "1");
const contadores = new Map<string, number>();
const siguiente = (tipo: TipoDE, punto: string) => {
  const k = `${tipo}/${punto}`;
  const n = (contadores.get(k) ?? desde - 1) + 1;
  contadores.set(k, n);
  return n;
};

function emisorCon(over: Partial<DepsEmisorPropio> = {}, credOver: Partial<typeof cred> = {}): EmisorPropio {
  return crearEmisorPropio({
    emisor: emisorDatos,
    cred: { ...cred, ...credOver },
    simulado,
    ...mod,
    ahora: () => new Date(),
    fechaSifen,
    ...over,
  });
}
const em = emisorCon();

// ─── Documentos de prueba (datos inventados) ───
const recRuc = envReal("SIFEN_BATERIA_RECEPTOR_RUC") ?? `${emisorDatos.ruc}-${emisorDatos.dv}`;
const receptorRuc = {
  tipo: "ruc" as const,
  ruc: recRuc.split("-")[0],
  dv: recRuc.split("-")[1],
  razonSocial: envReal("SIFEN_BATERIA_RECEPTOR_RAZON") ?? emisorDatos.razonSocial,
  pais: "PRY",
  direccion: "Calle Inventada",
  numeroCasa: "1",
  departamento: 11,
  ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" },
};
const items = (): ItemDE[] => [
  { codigo: "P-1", descripcion: "Producto de prueba uno", cantidad: 1, precioUnitario: 129000, ivaTasa: 10, ivaAfectacion: 1, unidadMedida: 77 },
  { codigo: "ENVIO", descripcion: "Envío a domicilio", cantidad: 1, precioUnitario: 33000, ivaTasa: 10, ivaAfectacion: 1, unidadMedida: 77 },
];
const LUGAR = { direccion: "Depósito Inventado", departamento: 11, ciudad: { codigo: 3428, descripcion: "CIUDAD DEL ESTE" } };
const AUTOFACTURA = {
  naturalezaVendedor: 1, documentoTipo: 1, documentoNumero: "1234567", nombre: "Vendedor Inventado", direccion: "Ruta Inventada",
  numeroCasa: "", departamento: 11, ciudad: LUGAR.ciudad, lugar: LUGAR, constancia: { tipo: 1 },
};
const hoy = fechaSifen(new Date()).slice(0, 10);
const manana = fechaSifen(new Date(Date.now() + 86_400_000)).slice(0, 10);
const REMISION = {
  motivo: 1, responsable: 1, km: 10,
  transporte: {
    tipo: 2, modalidad: 1, responsableFlete: 1, inicio: hoy, fin: manana, salida: LUGAR,
    entregas: [{ direccion: "Casa Inventada", numeroCasa: "12", departamento: 11, ciudad: LUGAR.ciudad }],
    vehiculos: [{ tipo: "Moto", marca: "Generica", tipoIdentificacion: 2, matricula: "ABC123" }],
    transportista: {
      naturaleza: 2, nombre: "Transportista Inventado", documentoTipo: 1, documentoNumero: "7654321", choferDocumento: "7654321",
      choferNombre: "Chofer Inventado", domicilioFiscal: "Calle Ficticia 1", direccionChofer: "Calle Ficticia 1",
    },
  },
};

let cdcFeApoyo = ""; // FE con receptor RUC a la que se asocian NC y ND

function documento(tipo: TipoDE, punto: string, over: Partial<DocumentoDE> = {}): DocumentoDE {
  const base: DocumentoDE = {
    tipo, establecimiento: "001", punto, numero: siguiente(tipo, punto), fechaEmision: fechaSifen(new Date()), tipoEmision: 1,
    codigoSeguridad: codigoSeguridadAleatorio(), receptor: receptorRuc, items: items(), moneda: "PYG",
  };
  const total = 162000;
  if (tipo === 1) Object.assign(base, { condicion: { tipo: 1, pagos: [{ tipo: 1, monto: total }] } });
  if (tipo === 5 || tipo === 6) Object.assign(base, { asociado: { tipo: 1, cdc: cdcFeApoyo }, motivoNota: tipo === 5 ? 2 : 1 });
  if (tipo === 4) {
    Object.assign(base, {
      receptor: { tipo: "ruc", ruc: emisorDatos.ruc, dv: emisorDatos.dv, razonSocial: emisorDatos.razonSocial, pais: "PRY" },
      condicion: { tipo: 1, pagos: [{ tipo: 1, monto: total }] },
      asociado: { tipo: 3 },
      autofactura: AUTOFACTURA,
    });
  }
  if (tipo === 7) Object.assign(base, { remision: REMISION });
  return { ...base, ...over };
}

// ─── Ejecución ───
const res: Resultado[] = [];
const aprobados: Record<number, Array<{ cdc: string; urlQr?: string; kude?: Uint8Array }>> = { 1: [], 4: [], 5: [], 6: [], 7: [] };
const conexion = new Map<string, string>();
const marcarConexion = (ws: string, r: { estado: string } | undefined) => {
  if (r && r.estado !== "error_red" && !conexion.has(ws)) conexion.set(ws, "OK");
  else if (r && !conexion.has(ws)) conexion.set(ws, `sin respuesta (${r.estado})`);
};

async function emitir(bloque: string, tipo: TipoDE, caso: string, doc: DocumentoDE, e: EmisorPropio = em, esperado = "aprobada") {
  try {
    const r = await e.emitir(doc);
    marcarConexion("recibe (sync)", { estado: r.estado === "enviada" ? "error_red" : "ok" });
    const okReal = esperado === "aprobada" ? r.estado === "aprobada" : r.estado === "rechazada";
    res.push({
      bloque, tipo: NOMBRE[tipo], caso, esperado, obtenido: r.estado,
      ok: simulado && esperado !== "aprobada" ? "simulado" : okReal,
      cdc: r.cdc, codigo: r.codigo, mensaje: r.mensaje,
    });
    if (r.estado === "aprobada" && r.cdc) aprobados[tipo].push({ cdc: r.cdc, urlQr: r.urlQr, kude: r.kudePdf });
    return r;
  } catch (e) {
    res.push({ bloque, tipo: NOMBRE[tipo], caso, esperado, obtenido: "excepción", ok: false, mensaje: e instanceof Error ? e.message : String(e) });
  }
}

console.log(`Batería SIFEN · ambiente TEST · ${simulado ? `MODO SIMULADO (${est.motivo})` : "SIFEN test REAL"}`);

// 0. FE de apoyo con RUC (asociación de NC/ND).
const apoyo = await em.emitir(documento(1, "001"));
cdcFeApoyo = apoyo.cdc ?? "";
res.push({ bloque: "0 apoyo", tipo: "FE", caso: "FE con RUC para asociar NC/ND", esperado: "aprobada", obtenido: apoyo.estado, ok: apoyo.estado === "aprobada", cdc: apoyo.cdc, codigo: apoyo.codigo, mensaje: apoyo.mensaje });

// 4.2 Sync aprobados.
for (const t of CASOS.tipos) {
  for (let i = 1; i <= CASOS.syncAprobados; i++) await emitir("4.2 sync aprobados", t, `#${i}`, documento(t, "001"));
}

// 4.2 Sync rechazados: 5 errores distintos que pasan las validaciones locales y debe rechazar SIFEN.
const rechazos: Array<{ caso: string; e: () => EmisorPropio; doc: (t: TipoDE) => DocumentoDE }> = [
  { caso: "timbrado inexistente", e: () => emisorCon({}, { timbrado: "99999999" }), doc: (t) => documento(t, "001") },
  { caso: "emisión 40 días atrás (1150)", e: () => em, doc: (t) => documento(t, "001", { fechaEmision: fechaSifen(new Date(Date.now() - 40 * 86_400_000)) }) },
  { caso: "QR con CSC incorrecto (2501)", e: () => emisorCon({}, { csc: "ZZZZ0000000000000000000000000000" }), doc: (t) => documento(t, "001") },
  {
    caso: "número duplicado con otro CDC",
    e: () => em,
    doc: (t) => ({ ...documento(t, "001"), numero: contadores.get(`${t}/001`)! - 1 }),
  },
  {
    caso: "XML alterado después de firmar (firma inválida)",
    e: () => {
      const ws: ClienteWsSifen = { ...mod.ws, enviarDE: (x) => mod.ws.enviarDE(x.replace(/<dDesProSer>([^<]*)<\/dDesProSer>/, "<dDesProSer>$1 ALTERADO</dDesProSer>")) };
      return emisorCon({ ws });
    },
    doc: (t) => documento(t, "001"),
  },
];
for (const t of CASOS.tipos) {
  for (const r of rechazos.slice(0, CASOS.syncRechazados)) await emitir("4.2 sync rechazados", t, r.caso, r.doc(t), r.e(), "rechazada");
}

// 4.2 Async (lotes de 5 del mismo tipo). Se firman sin mandar y se envían con siRecepLoteDE.
async function firmarSinEnviar(doc: DocumentoDE): Promise<string | undefined> {
  const capt: ClienteWsSifen = { ...mod.ws, enviarDE: () => Promise.resolve({ ok: false, estado: "en_proceso" } as RespuestaSifen) };
  const r = await emisorCon({ ws: capt }).emitir(doc);
  return r.xmlFirmado;
}
const lotes: Array<{ tipo: TipoDE; esperado: string; protocolo?: string; xmls: string[]; resp?: RespuestaSifen }> = [];
for (const t of CASOS.tipos) {
  for (const [esperado, n] of [["aprobada", CASOS.asyncAprobados], ["rechazada", CASOS.asyncRechazados]] as const) {
    const xmls: string[] = [];
    for (let i = 0; i < n; i++) {
      const d = esperado === "aprobada" ? documento(t, "002") : documento(t, "002", { fechaEmision: fechaSifen(new Date(Date.now() - 40 * 86_400_000)) });
      const x = await firmarSinEnviar(d);
      if (x) xmls.push(x);
    }
    const lote = { tipo: t, esperado, xmls } as (typeof lotes)[number];
    if (clienteC) {
      lote.resp = await clienteC.enviarLote(xmls);
      lote.protocolo = lote.resp?.protocolo;
      marcarConexion("recibe-lote (async)", lote.resp);
    }
    lotes.push(lote);
  }
}
if (clienteC) {
  const limite = Date.now() + Number(envReal("SIFEN_BATERIA_ESPERA_LOTE_MIN") ?? "15") * 60_000;
  // GP: primera consulta a los 10 min y luego cada ≥ 10 min; acá se consulta cada minuto hasta el límite.
  for (const l of lotes.filter((x) => x.protocolo)) {
    let r: RespuestaSifen & { documentos?: Array<{ cdc: string; estado: string; codigo?: string; mensaje?: string }> } = { ok: false, estado: "en_proceso" };
    while (Date.now() < limite) {
      r = await clienteC.consultarLote(l.protocolo);
      marcarConexion("consulta-lote", r);
      if (r.estado !== "en_proceso") break;
      await new Promise((z) => setTimeout(z, 60_000));
    }
    for (const doc of r.documentos ?? []) {
      const obtenido = doc.estado === "aprobado" || doc.estado === "aprobado_obs" ? "aprobada" : doc.estado === "rechazado" ? "rechazada" : doc.estado;
      res.push({ bloque: "4.2 async", tipo: NOMBRE[l.tipo], caso: `lote ${l.protocolo} (${l.esperado})`, esperado: l.esperado, obtenido, ok: obtenido === l.esperado, cdc: doc.cdc, codigo: doc.codigo, mensaje: doc.mensaje });
      if (obtenido === "aprobada") aprobados[l.tipo].push({ cdc: doc.cdc });
    }
    if (!r.documentos?.length) res.push({ bloque: "4.2 async", tipo: NOMBRE[l.tipo], caso: `lote ${l.protocolo}`, esperado: l.esperado, obtenido: r.estado, ok: false, codigo: r.codigo, mensaje: r.mensaje });
  }
  for (const l of lotes.filter((x) => !x.protocolo)) {
    res.push({ bloque: "4.2 async", tipo: NOMBRE[l.tipo], caso: "envío de lote", esperado: "protocolo", obtenido: l.resp?.estado ?? "?", ok: false, codigo: l.resp?.codigo, mensaje: l.resp?.mensaje });
  }
} else {
  for (const l of lotes) {
    res.push({ bloque: "4.2 async", tipo: NOMBRE[l.tipo], caso: `lote de ${l.xmls.length} (${l.esperado})`, esperado: l.esperado, obtenido: `${l.xmls.length} XML firmados, sin enviar`, ok: "simulado" });
  }
}

// 4.4 Consultas DE (3 por tipo).
for (const t of CASOS.tipos) {
  for (const a of aprobados[t].slice(0, CASOS.consultasPorTipo)) {
    const r = await em.consultar(a.cdc);
    marcarConexion("consulta DE", r);
    res.push({ bloque: "4.4 consulta DE", tipo: NOMBRE[t], caso: a.cdc, esperado: "aprobado", obtenido: r.estado, ok: r.estado === "aprobado" || r.estado === "aprobado_obs", cdc: a.cdc, codigo: r.codigo, mensaje: r.mensaje });
  }
}
// Consulta RUC (conexión).
const rr = await em.consultarRuc(`${emisorDatos.ruc}-${emisorDatos.dv}`);
conexion.set("consulta RUC", rr.ok ? `OK (existe=${rr.existe})` : `falló: ${rr.mensaje ?? ""}`);

// 4.5 KuDE (1 por tipo) y QR (2 por tipo).
await Deno.mkdir(dirSalida, { recursive: true });
for (const t of CASOS.tipos) {
  for (const a of aprobados[t].filter((x) => x.kude).slice(0, CASOS.kudePorTipo)) {
    const archivo = new URL(`kude-${NOMBRE[t]}-${a.cdc}.pdf`, dirSalida);
    await Deno.writeFile(archivo, a.kude!);
    const esPdf = new TextDecoder().decode(a.kude!.slice(0, 4)) === "%PDF";
    res.push({ bloque: "4.5 KuDE", tipo: NOMBRE[t], caso: archivo.pathname.split("/").pop()!, esperado: "PDF", obtenido: esPdf ? "PDF" : "no es PDF", ok: esPdf, cdc: a.cdc });
  }
  for (const a of aprobados[t].filter((x) => x.urlQr).slice(0, CASOS.qrPorTipo)) {
    const formato = /^https:\/\/ekuatia\.set\.gov\.py\/consultas-test\/qr\?/.test(a.urlQr!) && a.urlQr!.includes("cHashQR=");
    let obtenido = formato ? "URL test con cHashQR" : "URL inválida";
    let ok: Resultado["ok"] = simulado ? (formato ? "simulado" : false) : formato;
    if (!simulado && formato) {
      try {
        const h = await fetch(a.urlQr!);
        obtenido = `HTTP ${h.status}`;
        ok = h.ok;
        await h.body?.cancel();
      } catch (e) {
        obtenido = `red: ${e instanceof Error ? e.message : e}`;
        ok = false;
      }
    }
    res.push({ bloque: "4.5 QR", tipo: NOMBRE[t], caso: a.urlQr!, esperado: "consulta OK", obtenido, ok, cdc: a.cdc });
  }
}

// 4.3 Cancelaciones (FE aprobadas sin documentos asociados).
const paraCancelar = aprobados[1].slice(0, CASOS.cancelaciones);
for (const a of paraCancelar) {
  const r = await em.cancelar(a.cdc, "Prueba de cancelación de la batería de habilitación");
  marcarConexion("evento", r);
  res.push({ bloque: "4.3 cancelación", tipo: "FE", caso: a.cdc, esperado: "aprobado", obtenido: r.estado, ok: r.estado === "aprobado", cdc: a.cdc, codigo: r.codigo, mensaje: r.mensaje });
}

// 4.3 Inutilizaciones (2 FE, 1 NC, 1 ND, 1 AF): números nunca usados, punto 003.
for (const t of CASOS.inutilizaciones) {
  const n = siguiente(t, "003") + 100;
  contadores.set(`${t}/003`, n);
  const r = await em.inutilizar({ tipo: t, establecimiento: "001", punto: "003", desde: n, hasta: n, motivo: "Prueba de inutilización de la batería de habilitación" });
  marcarConexion("evento", r);
  res.push({ bloque: "4.3 inutilización", tipo: NOMBRE[t], caso: `001-003 n.º ${n}`, esperado: "aprobado", obtenido: r.estado, ok: r.estado === "aprobado", codigo: r.codigo, mensaje: r.mensaje });
}

// 4.3 Eventos del receptor: requieren DTE emitidos A NOMBRE de Voltra por otro emisor [VERIFICAR con la Mesa SIFEN].
res.push({ bloque: "4.3 eventos receptor", caso: `${CASOS.eventosReceptor} eventos (conformidad, disconformidad, desconocimiento, notificación, ajuste ×3)`, esperado: "aprobado", obtenido: "no implementado", ok: "pendiente", mensaje: "Faltan los armadores en eventos_xml.ts y DTE recibidos por Voltra en test [VERIFICAR]" });

// 4.1 Conexión por WS.
for (const ws of ["recibe (sync)", "recibe-lote (async)", "consulta-lote", "consulta DE", "evento", "consulta RUC"]) {
  const v = conexion.get(ws) ?? (simulado ? "simulado" : "sin llamada");
  res.push({ bloque: "4.1 conexión", caso: ws, esperado: "OK", obtenido: v, ok: simulado ? "simulado" : v.startsWith("OK") });
}

// ─── Reporte ───
const resumen: Record<string, { total: number; ok: number; fallas: number; simulados: number; pendientes: number }> = {};
for (const r of res) {
  const s = resumen[r.bloque] ??= { total: 0, ok: 0, fallas: 0, simulados: 0, pendientes: 0 };
  s.total++;
  if (r.ok === true) s.ok++;
  else if (r.ok === "simulado") s.simulados++;
  else if (r.ok === "pendiente") s.pendientes++;
  else s.fallas++;
}
const json = {
  fecha: new Date().toISOString(),
  ambiente: "test",
  modo: simulado ? "SIMULADO" : "REAL (SIFEN test)",
  motivo_simulado: est.motivo ?? null,
  modulos_simulados: mod.simulados,
  casos: CASOS,
  resumen,
  resultados: res,
};
const md = [
  `# Batería SIFEN — ${json.fecha}`,
  "",
  `**Ambiente:** test · **Modo:** ${json.modo}${simulado ? ` — ${est.motivo}. Sin red: SIFEN es un doble; NO sirve como evidencia de habilitación.` : ""}`,
  mod.simulados.length ? `**Módulos simulados:** ${mod.simulados.join(", ")}` : "",
  "",
  "| Bloque | Total | OK | Fallas | Simulados | Pendientes |",
  "|---|---|---|---|---|---|",
  ...Object.entries(resumen).map(([b, s]) => `| ${b} | ${s.total} | ${s.ok} | ${s.fallas} | ${s.simulados} | ${s.pendientes} |`),
  "",
  "## Detalle",
  "",
  "| Bloque | Tipo | Caso | Esperado | Obtenido | OK | Código | Mensaje |",
  "|---|---|---|---|---|---|---|---|",
  ...res.map((r) =>
    `| ${r.bloque} | ${r.tipo ?? ""} | ${String(r.caso).replace(/\|/g, "/").slice(0, 80)} | ${r.esperado} | ${r.obtenido} | ${r.ok === true ? "sí" : r.ok === false ? "**NO**" : r.ok} | ${r.codigo ?? ""} | ${(r.mensaje ?? "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 120)} |`
  ),
  "",
].join("\n");
const base = new URL(`docs/sifen-bateria/reporte-${sello}`, raiz);
await Deno.writeTextFile(`${base.pathname}.json`, JSON.stringify(json, null, 2));
await Deno.writeTextFile(`${base.pathname}.md`, md);
console.log(Object.entries(resumen).map(([b, s]) => `${b}: ${s.ok}/${s.total} OK, ${s.fallas} fallas, ${s.simulados} simulados, ${s.pendientes} pendientes`).join("\n"));
console.log(`Reporte: ${base.pathname}.md`);
const fallas = Object.values(resumen).reduce((a, s) => a + s.fallas, 0);
Deno.exit(fallas ? 1 : 0);
