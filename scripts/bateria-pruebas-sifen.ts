// scripts/bateria-pruebas-sifen.ts · Batería oficial de la Guía de Pruebas e-kuatia (feb-2026) en el ambiente TEST.
// Se corre con el envoltorio Node: `node scripts/bateria-pruebas-sifen.mjs` (ese invoca `deno run` sobre este archivo).
//
// - NUNCA usa producción: el ambiente se fuerza a "test" y SIFEN_PRODUCCION_AUTORIZADA se ignora.
// - Si no hay certificado real + timbrado + CSC en el entorno → MODO SIMULADO (sin red) y lo dice en el reporte.
//   La Guía exige certificado cualificado incluso en test: sin él la batería solo prueba el armado local.
// - Reporte: docs/sifen-bateria/reporte-<fecha>.md y .json (+ KuDE en PDF) — carpeta ignorada por Git.
// Conteos: docs/sifen-requisitos.md §5 (agente A). Ajustables en CASOS.
//
// 27-10 (primera corrida REAL, cortada en el primer lote de rechazados con "Lote vacío"):
// - REANUDABLE (modo real): el avance queda en docs/sifen-bateria/estado-bateria.json después de CADA paso. Si se
//   corta (error, red, Ctrl-C), volver a correr retoma desde el paso siguiente sin repetir lo hecho.
//   SIFEN_BATERIA_NUEVA=1 arranca una batería nueva (con números nuevos).
// - Números: docs/sifen-bateria/numeros-test.json guarda el último número usado por tipo en SIFEN TEST. Cada número se
//   reserva y se guarda ANTES de mandar el documento: nunca se reutiliza (ni aunque se corte a mitad del envío).
// - Antes de cada envío se guarda el CDC (enCurso): si se corta justo ahí, al reanudar se CONSULTA ese CDC en vez de
//   mandar otro documento.
// - El reporte (parcial o final) lista todos los CDC enviados con número y estado, y se escribe aunque se corte.
// - Los casos de rechazo respetan el inicio del timbrado: con un timbrado de menos de 40 días, "emisión 40 días atrás"
//   no se puede armar (xml.ts: fecha anterior al timbrado) y se usa "emisión adelantada 10 días"; los lotes de
//   rechazados usan timbrado inexistente. Un lote sin documentos firmados no se manda (lo frena también soap.ts).
//
// Variables opcionales (además de las de ENV_SIFEN):
//   SIFEN_BATERIA_EMISOR_JSON   DatosEmisor en JSON (por defecto: datos inventados de prueba)
//   SIFEN_BATERIA_RECEPTOR_RUC  "RUC-DV" de un contribuyente receptor (por defecto: el mismo emisor)
//   SIFEN_BATERIA_RECEPTOR_RAZON razón social de ese RUC
//   SIFEN_BATERIA_NUMERO_DESDE  primer número (solo batería nueva; nunca menor que lo ya usado en numeros-test.json)
//   SIFEN_BATERIA_ESPERA_LOTE_MIN minutos máximos esperando los lotes asíncronos (por defecto 15)
//   SIFEN_BATERIA_NUEVA=1       descartar el avance guardado y empezar otra batería
//   SIFEN_BATERIA_DIR           carpeta del avance y los reportes (por defecto docs/sifen-bateria)
//
// Voltra tiene UN solo punto de expedición (001-001, decisión del 11-10-2026): sync, lotes, inutilizaciones y
// eventos usan 001. Las inutilizaciones toman números lejanos (desde + 900…) que la batería nunca emite.

import type { DatosEmisor, DocumentoDE, ItemDE, RespuestaSifen, ResultadoEmision, TipoDE } from "../supabase/functions/_shared/sifen/tipos.ts";
import { cargarModulosSifen, credencialesDesdeEnv, datosEmisorPrueba, CARGADORES } from "../supabase/functions/_shared/sifen/emisor.ts";
import { type ClienteWsSifen, crearEmisorPropio, type DepsEmisorPropio, type EmisorPropio } from "../supabase/functions/_shared/sifen/emisor_propio.ts";
import { codigoSeguridadAleatorio, fechaSifen } from "../supabase/functions/_shared/sifen/desde_pedido.ts";
import { type EventoReceptor, xmlEventoReceptor } from "../supabase/functions/_shared/sifen/eventos_xml.ts";
import { cdcDeXml } from "../supabase/functions/_shared/sifen/soap.ts";

// ─── Casos (Guía de Pruebas feb-2026, docs/sifen-requisitos.md §5) ───
export const CASOS = {
  tipos: [1, 5, 6, 4, 7] as TipoDE[], // FE, NC, ND, AF, NR
  syncAprobados: 5, // por tipo
  syncRechazados: 5, // por tipo, errores distintos
  asyncAprobados: 5, // por tipo, 1 lote por tipo
  asyncRechazados: 5, // por tipo, 1 lote por tipo
  cancelaciones: 5,
  inutilizaciones: [1, 1, 5, 6, 4] as TipoDE[], // 2 FE, 1 NC, 1 ND, 1 AF
  eventosReceptor: 3, // por tipo: notificación, conformidad, disconformidad, desconocimiento y ajuste (Guía §4.3, rol RECEPTOR)
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
  numero?: number;
  codigo?: string;
  mensaje?: string;
}
interface Aprobado { cdc: string; numero?: number; urlQr?: string; kude?: string }
interface Enviado { clave: string; via: "sync" | "lote" | "consulta tras corte"; tipo: string; numero?: number; cdc: string; estado: string; codigo?: string; mensaje?: string; fecha: string }
interface Lote { clave: string; tipo: TipoDE; esperado: string; cdcs: Array<{ cdc: string; numero: number }>; protocolo?: string; estadoEnvio?: string; codigo?: string; mensaje?: string }
interface Estado {
  version: 1;
  sello: string;
  desde: number;
  contadores: Record<string, number>;
  hechos: Record<string, true>;
  res: Resultado[];
  aprobados: Record<number, Aprobado[]>;
  enviados: Enviado[];
  lotes: Lote[];
  propias: Array<{ cdc: string; fechaEmision: string; total: number }>;
  conexion: Record<string, string>;
  cdcFeApoyo: string;
  enCurso: { clave: string; via: "sync" | "lote"; tipo: string; cdcs: Array<{ cdc: string; numero?: number }> } | null;
  terminado: boolean;
}

const envReal = (n: string) => Deno.env.get(n) ?? undefined;
const raiz = new URL("../", import.meta.url);
// SIFEN_BATERIA_DIR: otra carpeta para el avance y los reportes (pruebas de la propia batería); por defecto docs/sifen-bateria.
const dirBase = envReal("SIFEN_BATERIA_DIR") ? new URL(`file://${envReal("SIFEN_BATERIA_DIR")!.replace(/\/?$/, "/")}`) : new URL("docs/sifen-bateria/", raiz);
const ARCHIVO_ESTADO = new URL("estado-bateria.json", dirBase);
const ARCHIVO_NUMEROS = new URL("numeros-test.json", dirBase);
await Deno.mkdir(dirBase, { recursive: true });

// ─── Entorno: SIEMPRE test ───
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
// Modo real: el certificado tiene que servir ANTES de mandar nada (Guía §4.1: cualificado, con el RUC del emisor y clientAuth).
if (!simulado) {
  const cm = await CARGADORES.certificado();
  try {
    // deno-lint-ignore no-explicit-any
    const c = (cm.cargarP12 as any)(cred.certP12, cred.certClave);
    const avisos: string[] = (cm.avisosCertificado as (c: unknown, r?: string) => string[])(c, emisorDatos.ruc);
    console.log(`Certificado: RUC ${c.ruc ?? "?"}-${c.dv ?? "?"} · emitido por ${c.emisor} · vence ${c.venceEl.toISOString().slice(0, 10)} · clientAuth ${c.clientAuth ? "sí" : "NO"}`);
    for (const a of avisos) console.log(`  aviso: ${a}`);
    const graves = avisos.filter((a) => !/vence pronto/.test(a));
    if (graves.length) {
      console.error("El certificado no sirve para SIFEN test; no se envió nada. Corregí esto y volvé a correr la batería.");
      Deno.exit(2);
    }
  } catch (e) {
    console.error(`No se pudo abrir el certificado: ${e instanceof Error ? e.message : e}`);
    Deno.exit(2);
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

// ─── Estado reanudable y registro de números (solo modo real: en simulado no se guarda nada) ───
const leerJson = <T>(u: URL): T | null => {
  try { return JSON.parse(Deno.readTextFileSync(u)) as T; } catch { return null; }
};
const numerosUsados: Record<string, number> = simulado ? {} : (leerJson<Record<string, number>>(ARCHIVO_NUMEROS) ?? {});
const maxUsado = () => Math.max(0, ...Object.values(numerosUsados).filter((v) => typeof v === "number"));

function estadoNuevo(): Estado {
  const pedido = envReal("SIFEN_BATERIA_NUMERO_DESDE") ? Number(envReal("SIFEN_BATERIA_NUMERO_DESDE")) : null;
  const libre = maxUsado() + 1;
  if (pedido !== null && pedido < libre && !simulado) {
    console.error(`SIFEN_BATERIA_NUMERO_DESDE=${pedido} pisa números ya usados en SIFEN TEST (hasta ${libre - 1}, ver ${ARCHIVO_NUMEROS.pathname}). No se envió nada.`);
    Deno.exit(2);
  }
  return {
    version: 1, sello: new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19), desde: pedido ?? (simulado ? 1 : libre),
    contadores: {}, hechos: {}, res: [], aprobados: { 1: [], 4: [], 5: [], 6: [], 7: [] }, enviados: [], lotes: [], propias: [],
    conexion: {}, cdcFeApoyo: "", enCurso: null, terminado: false,
  };
}
const previo = simulado || envReal("SIFEN_BATERIA_NUEVA") === "1" ? null : leerJson<Estado>(ARCHIVO_ESTADO);
const E: Estado = previo && !previo.terminado ? previo : estadoNuevo();
const reanudada = E === previo;
const dirSalida = new URL(`${E.sello}/`, dirBase);
await Deno.mkdir(dirSalida, { recursive: true });

/** Guarda el avance (sincrónico: tiene que quedar en disco antes de seguir con la red). */
function guardar() {
  if (simulado) return;
  Deno.writeTextFileSync(ARCHIVO_NUMEROS, JSON.stringify(numerosUsados, null, 2));
  Deno.writeTextFileSync(ARCHIVO_ESTADO, JSON.stringify(E, null, 2));
}

/** Reserva el próximo número del tipo y lo deja guardado ANTES de usarlo. */
const siguiente = (tipo: TipoDE, punto: string) => {
  const k = `${tipo}/${punto}`;
  const n = (E.contadores[k] ?? E.desde - 1) + 1;
  E.contadores[k] = n;
  numerosUsados[NOMBRE[tipo]] = Math.max(numerosUsados[NOMBRE[tipo]] ?? 0, n);
  guardar();
  return n;
};

/** Corre un paso una sola vez: si ya está hecho (corrida anterior), lo saltea. */
async function paso(clave: string, fn: () => Promise<void>) {
  if (E.hechos[clave]) return;
  await fn();
  E.hechos[clave] = true;
  guardar();
}

const marcarConexion = (ws: string, r: { estado: string } | undefined) => {
  if (r && r.estado !== "error_red" && !E.conexion[ws]) E.conexion[ws] = "OK";
  else if (r && !E.conexion[ws]) E.conexion[ws] = `sin respuesta (${r.estado})`;
};

/** WS que deja guardado el CDC en enCurso antes de mandarlo (para consultar en vez de reenviar si se corta). */
function wsQueAnota(base: ClienteWsSifen, clave: string, tipo: TipoDE, numero: number): ClienteWsSifen {
  return {
    ...base,
    consultarDE: (c) => base.consultarDE(c),
    enviarDE: (xml) => {
      if (!simulado) {
        E.enCurso = { clave, via: "sync", tipo: NOMBRE[tipo], cdcs: [{ cdc: cdcDeXml(xml), numero }] };
        guardar();
      }
      return base.enviarDE(xml);
    },
  };
}

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
// La ciudad tiene que ir con la descripción oficial del código (3428 = "CIUDAD DEL ESTE(PLANTA URBANA)"): si no, 1329.
const CIUDAD = emisorDatos.ciudad ?? { codigo: 3428, descripcion: "CIUDAD DEL ESTE(PLANTA URBANA)" };
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
  ciudad: CIUDAD,
};
const items = (): ItemDE[] => [
  { codigo: "P-1", descripcion: "Producto de prueba uno", cantidad: 1, precioUnitario: 129000, ivaTasa: 10, ivaAfectacion: 1, unidadMedida: 77 },
  { codigo: "ENVIO", descripcion: "Envío a domicilio", cantidad: 1, precioUnitario: 33000, ivaTasa: 10, ivaAfectacion: 1, unidadMedida: 77 },
];
const LUGAR = { direccion: "Depósito Inventado", departamento: 11, ciudad: CIUDAD };
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

function documento(tipo: TipoDE, punto: string, over: Partial<DocumentoDE> = {}): DocumentoDE {
  const base: DocumentoDE = {
    tipo, establecimiento: "001", punto, numero: over.numero ?? siguiente(tipo, punto), fechaEmision: fechaSifen(new Date()), tipoEmision: 1,
    codigoSeguridad: codigoSeguridadAleatorio(), receptor: receptorRuc, items: items(), moneda: "PYG",
  };
  const total = 162000;
  if (tipo === 1) Object.assign(base, { condicion: { tipo: 1, pagos: [{ tipo: 1, monto: total }] } });
  if (tipo === 5 || tipo === 6) Object.assign(base, { asociado: { tipo: 1, cdc: E.cdcFeApoyo }, motivoNota: tipo === 5 ? 2 : 1 });
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

// Rechazo por fecha: 40 días atrás solo si esa fecha no cae antes del inicio del timbrado (si no, ni se arma).
const hace40 = fechaSifen(new Date(Date.now() - 40 * 86_400_000));
const rechazoFecha = hace40.slice(0, 10) >= String(cred.timbradoInicio ?? "")
  ? { caso: "emisión 40 días atrás (1150)", fecha: () => hace40 }
  : { caso: "emisión adelantada 10 días", fecha: () => fechaSifen(new Date(Date.now() + 10 * 86_400_000)) };

async function guardarKude(tipo: TipoDE, cdc: string, pdf?: Uint8Array): Promise<string | undefined> {
  if (!pdf || E.aprobados[tipo].filter((a) => a.kude).length >= CASOS.kudePorTipo) return undefined;
  const archivo = new URL(`kude-${NOMBRE[tipo]}-${cdc}.pdf`, dirSalida);
  await Deno.writeFile(archivo, pdf);
  return archivo.pathname;
}

/** Emite un DE sincrónico como paso reanudable. Devuelve el resultado (undefined si ya estaba hecho). */
async function emitir(clave: string, bloque: string, tipo: TipoDE, caso: string, hacerDoc: () => DocumentoDE, e: (ws: (b: ClienteWsSifen) => ClienteWsSifen) => EmisorPropio = (w) => emisorCon({ ws: w(mod.ws) }), esperado = "aprobada"): Promise<ResultadoEmision | undefined> {
  let salida: ResultadoEmision | undefined;
  await paso(clave, async () => {
    const doc = hacerDoc();
    try {
      const r = await e((b) => wsQueAnota(b, clave, tipo, doc.numero!)).emitir(doc);
      salida = r;
      marcarConexion("recibe (sync)", { estado: r.estado === "enviada" ? "error_red" : "ok" });
      const okReal = esperado === "aprobada" ? r.estado === "aprobada" : r.estado === "rechazada";
      E.res.push({
        bloque, tipo: NOMBRE[tipo], caso, esperado, obtenido: r.estado,
        ok: simulado && esperado !== "aprobada" ? "simulado" : okReal,
        cdc: r.cdc, numero: doc.numero, codigo: r.codigo, mensaje: r.mensaje,
      });
      if (E.enCurso?.clave === clave && r.cdc) {
        E.enviados.push({ clave, via: "sync", tipo: NOMBRE[tipo], numero: doc.numero, cdc: r.cdc, estado: r.estado, codigo: r.codigo, mensaje: r.mensaje, fecha: new Date().toISOString() });
      }
      if (r.estado === "aprobada" && r.cdc) E.aprobados[tipo].push({ cdc: r.cdc, numero: doc.numero, urlQr: r.urlQr, kude: await guardarKude(tipo, r.cdc, r.kudePdf) });
    } catch (ex) {
      E.res.push({ bloque, tipo: NOMBRE[tipo], caso, esperado, obtenido: "excepción", ok: false, numero: doc.numero, mensaje: ex instanceof Error ? ex.message : String(ex) });
    }
    E.enCurso = null;
  });
  return salida;
}

/** Si la corrida anterior se cortó en pleno envío: consulta esos CDC en SIFEN (nunca reenvía) y cierra el paso. */
async function cerrarEnvioCortado() {
  const c = E.enCurso;
  if (!c || simulado) return;
  console.log(`Se había cortado durante el envío de ${c.clave}: consultando ${c.cdcs.length} CDC en SIFEN en vez de reenviar.`);
  for (const x of c.cdcs) {
    const r = await em.consultar(x.cdc);
    const t = Number(Object.entries(NOMBRE).find(([, v]) => v === c.tipo)?.[0]) as TipoDE;
    E.enviados.push({ clave: c.clave, via: "consulta tras corte", tipo: c.tipo, numero: x.numero, cdc: x.cdc, estado: r.estado, codigo: r.codigo, mensaje: r.mensaje, fecha: new Date().toISOString() });
    E.res.push({ bloque: "reanudación", tipo: c.tipo, caso: `${c.clave} (cortado en el envío; consultado)`, esperado: "estado conocido", obtenido: r.estado, ok: r.estado !== "error_red" && r.estado !== "error", cdc: x.cdc, numero: x.numero, codigo: r.codigo, mensaje: r.mensaje });
    if ((r.estado === "aprobado" || r.estado === "aprobado_obs") && t) E.aprobados[t].push({ cdc: x.cdc, numero: x.numero });
  }
  if (c.via === "sync") E.hechos[c.clave] = true;
  else {
    const l = E.lotes.find((x) => x.clave === c.clave);
    if (l) { l.estadoEnvio = "cortado: consultado por CDC"; E.hechos[`${c.clave}-consulta`] = true; }
    E.hechos[c.clave] = true;
  }
  E.enCurso = null;
  guardar();
}

// ─── Reporte (parcial o final): se escribe siempre, aunque la corrida se corte ───
function escribirReporte(final: boolean, error?: string): string {
  const res = E.res;
  if (final) {
    for (const ws of ["recibe (sync)", "recibe-lote (async)", "consulta-lote", "consulta DE", "evento", "consulta RUC"]) {
      const v = E.conexion[ws] ?? (simulado ? "simulado" : "sin llamada");
      res.push({ bloque: "4.1 conexión", caso: ws, esperado: "OK", obtenido: v, ok: simulado ? "simulado" : v.startsWith("OK") });
    }
    // En simulado nada pasó por SIFEN: todo lo que depende de la red queda "simulado", nunca "sí" (solo el KuDE es local).
    if (simulado) for (const r of res) if (r.ok === true && r.bloque !== "4.5 KuDE") r.ok = "simulado";
  }
  const resumen: Record<string, { total: number; ok: number; fallas: number; simulados: number; pendientes: number }> = {};
  for (const r of res) {
    const s = resumen[r.bloque] ??= { total: 0, ok: 0, fallas: 0, simulados: 0, pendientes: 0 };
    s.total++;
    if (r.ok === true) s.ok++;
    else if (r.ok === "simulado") s.simulados++;
    else if (r.ok === "pendiente") s.pendientes++;
    else s.fallas++;
  }
  const fecha = new Date().toISOString();
  const modo = simulado ? "SIMULADO" : "REAL (SIFEN test)";
  const json = {
    fecha, ambiente: "test", modo, parcial: !final, error: error ?? null, reanudada, sello: E.sello, numero_desde: E.desde,
    motivo_simulado: est.motivo ?? null, modulos_simulados: mod.simulados, casos: CASOS, resumen, enviados: E.enviados, lotes: E.lotes, resultados: res,
  };
  const md = [
    `# Batería SIFEN — ${fecha}${final ? "" : " — **PARCIAL**"}`,
    "",
    `**Ambiente:** test · **Modo:** ${modo}${simulado ? ` — ${est.motivo}. Sin red: SIFEN es un doble; NO sirve como evidencia de habilitación.` : ""}`,
    `**Batería:** ${E.sello}${reanudada ? " (reanudada)" : ""} · números desde ${E.desde}`,
    error ? `\n**Se cortó:** ${error}\nVolvé a correr la batería: retoma desde el paso siguiente sin repetir lo hecho.` : "",
    mod.simulados.length ? `**Módulos simulados:** ${mod.simulados.join(", ")}` : "",
    "",
    "| Bloque | Total | OK | Fallas | Simulados | Pendientes |",
    "|---|---|---|---|---|---|",
    ...Object.entries(resumen).map(([b, s]) => `| ${b} | ${s.total} | ${s.ok} | ${s.fallas} | ${s.simulados} | ${s.pendientes} |`),
    "",
    `## Documentos que llegaron a SIFEN (${E.enviados.length})`,
    "",
    "| Vía | Tipo | N.º | CDC | Estado | Código | Mensaje |",
    "|---|---|---|---|---|---|---|",
    ...E.enviados.map((x) => `| ${x.via} | ${x.tipo} | ${x.numero ?? ""} | ${x.cdc} | ${x.estado} | ${x.codigo ?? ""} | ${(x.mensaje ?? "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 100)} |`),
    "",
    "## Detalle",
    "",
    "| Bloque | Tipo | Caso | N.º | Esperado | Obtenido | OK | Código | Mensaje |",
    "|---|---|---|---|---|---|---|---|---|",
    ...res.map((r) =>
      `| ${r.bloque} | ${r.tipo ?? ""} | ${String(r.caso).replace(/\|/g, "/").slice(0, 80)} | ${r.numero ?? ""} | ${r.esperado} | ${r.obtenido} | ${r.ok === true ? "sí" : r.ok === false ? "**NO**" : r.ok} | ${r.codigo ?? ""} | ${(r.mensaje ?? "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 120)} |`
    ),
    "",
  ].join("\n");
  const base = new URL(`reporte-${E.sello}${final ? "" : "-parcial"}`, dirBase);
  Deno.writeTextFileSync(`${base.pathname}.json`, JSON.stringify(json, null, 2));
  Deno.writeTextFileSync(`${base.pathname}.md`, md);
  console.log(Object.entries(resumen).map(([b, s]) => `${b}: ${s.ok}/${s.total} OK, ${s.fallas} fallas, ${s.simulados} simulados, ${s.pendientes} pendientes`).join("\n"));
  console.log(`Reporte${final ? "" : " PARCIAL"}: ${base.pathname}.md`);
  return base.pathname;
}

// Ctrl-C: guarda avance y reporte parcial antes de salir.
try {
  Deno.addSignalListener("SIGINT", () => {
    guardar();
    escribirReporte(false, "interrumpida con Ctrl-C");
    Deno.exit(130);
  });
} catch { /* sin señales (p. ej. Windows) */ }

// ─── Ejecución ───
async function correr() {
  console.log(`Batería SIFEN · ambiente TEST · ${simulado ? `MODO SIMULADO (${est.motivo})` : "SIFEN test REAL"} · ${reanudada ? `REANUDADA (${Object.keys(E.hechos).length} pasos ya hechos)` : `nueva, números desde ${E.desde}`}`);
  await cerrarEnvioCortado();

  // 0. FE de apoyo con RUC (asociación de NC/ND).
  const apoyo = await emitir("apoyo", "0 apoyo", 1, "FE con RUC para asociar NC/ND", () => documento(1, "001"));
  if (apoyo?.cdc) { E.cdcFeApoyo = apoyo.cdc; guardar(); }

  // 4.2 Sync aprobados.
  for (const t of CASOS.tipos) {
    for (let i = 1; i <= CASOS.syncAprobados; i++) await emitir(`sync-ok-${NOMBRE[t]}-${i}`, "4.2 sync aprobados", t, `#${i}`, () => documento(t, "001"));
  }

  // 4.2 Sync rechazados: 5 errores distintos que pasan las validaciones locales y debe rechazar SIFEN.
  const rechazos: Array<{ caso: string; e: (w: (b: ClienteWsSifen) => ClienteWsSifen) => EmisorPropio; doc: (t: TipoDE) => DocumentoDE }> = [
    { caso: "timbrado inexistente", e: (w) => emisorCon({ ws: w(mod.ws) }, { timbrado: "99999999" }), doc: (t) => documento(t, "001") },
    { caso: rechazoFecha.caso, e: (w) => emisorCon({ ws: w(mod.ws) }), doc: (t) => documento(t, "001", { fechaEmision: rechazoFecha.fecha() }) },
    { caso: "QR con CSC incorrecto (2501)", e: (w) => emisorCon({ ws: w(mod.ws) }, { csc: "ZZZZ0000000000000000000000000000" }), doc: (t) => documento(t, "001") },
    {
      // Repite el número de un DE APROBADO de ese tipo (antes repetía el del caso anterior, que podía no haber llegado).
      caso: "número duplicado con otro CDC",
      e: (w) => emisorCon({ ws: w(mod.ws) }),
      doc: (t) => documento(t, "001", { numero: E.aprobados[t][0]?.numero ?? E.desde }),
    },
    {
      caso: "XML alterado después de firmar (firma inválida)",
      e: (w) => emisorCon({ ws: w({ ...mod.ws, enviarDE: (x) => mod.ws.enviarDE(x.replace(/<dDesProSer>([^<]*)<\/dDesProSer>/, "<dDesProSer>$1 ALTERADO</dDesProSer>")) }) }),
      doc: (t) => documento(t, "001"),
    },
  ];
  for (const t of CASOS.tipos) {
    for (const [i, r] of rechazos.slice(0, CASOS.syncRechazados).entries()) await emitir(`sync-rech-${NOMBRE[t]}-${i + 1}`, "4.2 sync rechazados", t, r.caso, () => r.doc(t), r.e, "rechazada");
  }

  // 4.2 Async (lotes de 5 del mismo tipo). Se firman sin mandar y se envían con siRecepLoteDE.
  // Rechazados: timbrado inexistente (pasa el armado local; SIFEN lo rechaza documento por documento).
  async function firmarSinEnviar(doc: DocumentoDE, credOver: Partial<typeof cred>): Promise<{ xml?: string; error?: string }> {
    const capt: ClienteWsSifen = { ...mod.ws, enviarDE: () => Promise.resolve({ ok: false, estado: "en_proceso" } as RespuestaSifen) };
    const r = await emisorCon({ ws: capt }, credOver).emitir(doc);
    return r.xmlFirmado ? { xml: r.xmlFirmado } : { error: `${r.estado}: ${r.mensaje ?? ""}` };
  }
  for (const t of CASOS.tipos) {
    for (const [esperado, n] of [["aprobada", CASOS.asyncAprobados], ["rechazada", CASOS.asyncRechazados]] as const) {
      const clave = `lote-${NOMBRE[t]}-${esperado}`;
      await paso(clave, async () => {
        const xmls: string[] = [];
        const lote: Lote = { clave, tipo: t, esperado, cdcs: [] };
        const errores: string[] = [];
        for (let i = 0; i < n; i++) {
          const d = documento(t, "001");
          const f = await firmarSinEnviar(d, esperado === "rechazada" ? { timbrado: "99999999" } : {});
          if (f.xml) { xmls.push(f.xml); lote.cdcs.push({ cdc: cdcDeXml(f.xml), numero: d.numero }); } else errores.push(`n.º ${d.numero}: ${f.error}`);
        }
        E.lotes.push(lote);
        if (!xmls.length) {
          // Nunca se manda un lote vacío (SIFEN bloquea el RUC): queda como falla con el motivo de cada documento.
          E.res.push({ bloque: "4.2 async", tipo: NOMBRE[t], caso: `lote ${esperado}: ningún DE se pudo firmar`, esperado, obtenido: "lote vacío, no enviado", ok: false, mensaje: errores.join(" · ") });
          return;
        }
        if (errores.length) E.res.push({ bloque: "4.2 async", tipo: NOMBRE[t], caso: `lote ${esperado}: ${errores.length} DE no se firmaron`, esperado: `${n} DE`, obtenido: `${xmls.length} DE`, ok: false, mensaje: errores.join(" · ") });
        if (!clienteC) {
          E.res.push({ bloque: "4.2 async", tipo: NOMBRE[t], caso: `lote de ${xmls.length} (${esperado})`, esperado, obtenido: `${xmls.length} XML firmados, sin enviar`, ok: "simulado" });
          return;
        }
        E.enCurso = { clave, via: "lote", tipo: NOMBRE[t], cdcs: lote.cdcs };
        guardar();
        try {
          const r = await clienteC.enviarLote(xmls);
          lote.protocolo = r?.protocolo;
          lote.estadoEnvio = r?.estado;
          lote.codigo = r?.codigo;
          lote.mensaje = r?.mensaje;
          marcarConexion("recibe-lote (async)", r);
          if (!lote.protocolo) E.res.push({ bloque: "4.2 async", tipo: NOMBRE[t], caso: "envío de lote", esperado: "protocolo", obtenido: r?.estado ?? "?", ok: false, codigo: r?.codigo, mensaje: r?.mensaje });
        } catch (ex) {
          lote.estadoEnvio = "excepción";
          E.res.push({ bloque: "4.2 async", tipo: NOMBRE[t], caso: "envío de lote", esperado: "protocolo", obtenido: "excepción", ok: false, mensaje: ex instanceof Error ? ex.message : String(ex) });
        }
        E.enCurso = null;
      });
    }
  }
  if (clienteC) {
    const limite = Date.now() + Number(envReal("SIFEN_BATERIA_ESPERA_LOTE_MIN") ?? "15") * 60_000;
    // GP: primera consulta a los 10 min y luego cada ≥ 10 min; acá se consulta cada minuto hasta el límite.
    for (const l of E.lotes.filter((x) => x.protocolo)) {
      const clave = `${l.clave}-consulta`;
      if (E.hechos[clave]) continue;
      let r: RespuestaSifen & { documentos?: Array<{ cdc: string; estado: string; codigo?: string; mensaje?: string }> } = { ok: false, estado: "en_proceso" };
      while (Date.now() < limite) {
        r = await clienteC.consultarLote(l.protocolo);
        marcarConexion("consulta-lote", r);
        if (r.estado !== "en_proceso") break;
        await new Promise((z) => setTimeout(z, 60_000));
      }
      if (r.estado === "en_proceso") {
        // Sigue en proceso: queda pendiente y la próxima corrida lo vuelve a consultar (no se marca hecho).
        E.res.push({ bloque: "4.2 async", tipo: NOMBRE[l.tipo], caso: `lote ${l.protocolo} (${l.esperado})`, esperado: l.esperado, obtenido: "en proceso", ok: "pendiente" });
        guardar();
        continue;
      }
      for (const doc of r.documentos ?? []) {
        const obtenido = doc.estado === "aprobado" || doc.estado === "aprobado_obs" ? "aprobada" : doc.estado === "rechazado" ? "rechazada" : doc.estado;
        const numero = l.cdcs.find((c) => c.cdc === doc.cdc)?.numero;
        E.res.push({ bloque: "4.2 async", tipo: NOMBRE[l.tipo], caso: `lote ${l.protocolo} (${l.esperado})`, esperado: l.esperado, obtenido, ok: obtenido === l.esperado, cdc: doc.cdc, numero, codigo: doc.codigo, mensaje: doc.mensaje });
        E.enviados.push({ clave: l.clave, via: "lote", tipo: NOMBRE[l.tipo], numero, cdc: doc.cdc, estado: obtenido, codigo: doc.codigo, mensaje: doc.mensaje, fecha: new Date().toISOString() });
        if (obtenido === "aprobada") E.aprobados[l.tipo].push({ cdc: doc.cdc, numero });
      }
      if (!r.documentos?.length) {
        E.res.push({ bloque: "4.2 async", tipo: NOMBRE[l.tipo], caso: `lote ${l.protocolo}`, esperado: l.esperado, obtenido: r.estado, ok: false, codigo: r.codigo, mensaje: r.mensaje });
        for (const c of l.cdcs) E.enviados.push({ clave: l.clave, via: "lote", tipo: NOMBRE[l.tipo], numero: c.numero, cdc: c.cdc, estado: `lote ${r.estado}`, codigo: r.codigo, mensaje: r.mensaje, fecha: new Date().toISOString() });
      }
      E.hechos[clave] = true;
      guardar();
    }
  }

  // 4.4 Consultas DE (3 por tipo).
  for (const t of CASOS.tipos) {
    for (const a of E.aprobados[t].slice(0, CASOS.consultasPorTipo)) {
      await paso(`consulta-${a.cdc}`, async () => {
        const r = await em.consultar(a.cdc);
        marcarConexion("consulta DE", r);
        E.res.push({ bloque: "4.4 consulta DE", tipo: NOMBRE[t], caso: a.cdc, esperado: "aprobado", obtenido: r.estado, ok: r.estado === "aprobado" || r.estado === "aprobado_obs", cdc: a.cdc, numero: a.numero, codigo: r.codigo, mensaje: r.mensaje });
      });
    }
  }
  // Consulta RUC (conexión).
  await paso("consulta-ruc", async () => {
    const rr = await em.consultarRuc(`${emisorDatos.ruc}-${emisorDatos.dv}`);
    E.conexion["consulta RUC"] = rr.ok ? `OK (existe=${rr.existe})` : `falló: ${rr.mensaje ?? ""}`;
  });

  // 4.5 KuDE (1 por tipo, guardados al aprobarse) y QR (2 por tipo).
  await paso("kude-qr", async () => {
    for (const t of CASOS.tipos) {
      for (const a of E.aprobados[t].filter((x) => x.kude).slice(0, CASOS.kudePorTipo)) {
        const pdf = await Deno.readFile(a.kude!);
        const esPdf = new TextDecoder().decode(pdf.slice(0, 4)) === "%PDF";
        E.res.push({ bloque: "4.5 KuDE", tipo: NOMBRE[t], caso: a.kude!.split("/").pop()!, esperado: "PDF", obtenido: esPdf ? "PDF" : "no es PDF", ok: esPdf, cdc: a.cdc });
      }
      for (const a of E.aprobados[t].filter((x) => x.urlQr).slice(0, CASOS.qrPorTipo)) {
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
        E.res.push({ bloque: "4.5 QR", tipo: NOMBRE[t], caso: a.urlQr!, esperado: "consulta OK", obtenido, ok, cdc: a.cdc });
      }
    }
  });

  // 4.3 Cancelaciones (FE aprobadas sin documentos asociados: se saltea la FE de apoyo).
  for (const a of E.aprobados[1].filter((x) => x.cdc !== E.cdcFeApoyo).slice(0, CASOS.cancelaciones)) {
    await paso(`cancelacion-${a.cdc}`, async () => {
      const r = await em.cancelar(a.cdc, "Prueba de cancelación de la batería de habilitación");
      marcarConexion("evento", r);
      E.res.push({ bloque: "4.3 cancelación", tipo: "FE", caso: a.cdc, esperado: "aprobado", obtenido: r.estado, ok: r.estado === "aprobado", cdc: a.cdc, numero: a.numero, codigo: r.codigo, mensaje: r.mensaje });
    });
  }

  // 4.3 Inutilizaciones (2 FE, 1 NC, 1 ND, 1 AF): punto 001, números lejanos que la batería nunca emite.
  const inuPorTipo = new Map<TipoDE, number>();
  for (const t of CASOS.inutilizaciones) {
    const n = E.desde + 900 + (inuPorTipo.get(t) ?? 0);
    inuPorTipo.set(t, (inuPorTipo.get(t) ?? 0) + 1);
    await paso(`inutilizacion-${NOMBRE[t]}-${n}`, async () => {
      numerosUsados[NOMBRE[t]] = Math.max(numerosUsados[NOMBRE[t]] ?? 0, n);
      guardar();
      const r = await em.inutilizar({ tipo: t, establecimiento: "001", punto: "001", desde: n, hasta: n, motivo: "Prueba de inutilización de la batería de habilitación" });
      marcarConexion("evento", r);
      E.res.push({ bloque: "4.3 inutilización", tipo: NOMBRE[t], caso: `001-001 n.º ${n}`, esperado: "aprobado", obtenido: r.estado, ok: r.estado === "aprobado", numero: n, codigo: r.codigo, mensaje: r.mensaje });
    });
  }

  // 4.3 Eventos del receptor (rol RECEPTOR). Con el mismo RUC: Voltra se emite FE a sí misma y, como receptora (firma
  // con su propio certificado), registra sobre esos CDC 3 notificaciones, 3 conformidades, 3 disconformidades,
  // 3 desconocimientos y 3 ajustes (conformidad sobre los CDC que ya tenían disconformidad).
  // [VERIFICAR] que SIFEN test acepte FE con receptor = emisor y que ese sea el "ajuste" que pide la Guía:
  // si no, el reporte trae el código de rechazo de SIFEN.
  const yo = { tipo: 1 as const, nombre: emisorDatos.razonSocial, ruc: emisorDatos.ruc, dv: emisorDatos.dv };
  for (let i = 1; i <= CASOS.eventosReceptor * 4; i++) {
    let fechaDoc = "";
    const r = await emitir(`propia-${i}`, "4.3 eventos receptor (FE a Voltra)", 1, `FE a nombre de Voltra #${i}`, () => {
      const d = documento(1, "001", { receptor: { ...receptorRuc, ruc: emisorDatos.ruc, dv: emisorDatos.dv, razonSocial: emisorDatos.razonSocial } });
      fechaDoc = d.fechaEmision;
      return d;
    });
    if (r?.estado === "aprobada" && r.cdc) { E.propias.push({ cdc: r.cdc, fechaEmision: fechaDoc, total: r.totales?.total ?? 162000 }); guardar(); }
  }
  async function eventoReceptor(clave: string, caso: string, ev: EventoReceptor) {
    await paso(clave, async () => {
      try {
        const arm = xmlEventoReceptor(ev);
        const firmado = await mod.firmarXml(arm.xml, arm.idEvento, cred.certP12, cred.certClave);
        const r = await mod.ws.enviarEvento(firmado.xmlFirmado);
        marcarConexion("evento", r);
        E.res.push({ bloque: "4.3 eventos receptor", caso, esperado: "aprobado", obtenido: r.estado, ok: r.estado === "aprobado", cdc: ev.cdc, codigo: r.codigo, mensaje: r.mensaje });
      } catch (e) {
        E.res.push({ bloque: "4.3 eventos receptor", caso, esperado: "aprobado", obtenido: "excepción", ok: false, cdc: ev.cdc, mensaje: e instanceof Error ? e.message : String(e) });
      }
    });
  }
  const grupo = (k: number) => E.propias.slice(k * CASOS.eventosReceptor, (k + 1) * CASOS.eventosReceptor);
  const recibido = () => fechaSifen(new Date());
  for (const p of grupo(0)) {
    await eventoReceptor(`ev-notif-${p.cdc}`, "notificación de recepción", { evento: "notificacion", cdc: p.cdc, fechaEmision: p.fechaEmision, fechaRecepcion: recibido(), receptor: yo, totalGs: p.total });
  }
  for (const p of grupo(1)) await eventoReceptor(`ev-conf-${p.cdc}`, "conformidad", { evento: "conformidad", cdc: p.cdc, fechaRecepcion: recibido() });
  for (const p of grupo(2)) await eventoReceptor(`ev-disc-${p.cdc}`, "disconformidad", { evento: "disconformidad", cdc: p.cdc, motivo: "Prueba de disconformidad de la batería de habilitación" });
  for (const p of grupo(3)) {
    await eventoReceptor(`ev-desc-${p.cdc}`, "desconocimiento", { evento: "desconocimiento", cdc: p.cdc, fechaEmision: p.fechaEmision, fechaRecepcion: recibido(), receptor: yo, motivo: "Prueba de desconocimiento de la batería de habilitación" });
  }
  for (const p of grupo(2)) await eventoReceptor(`ev-ajuste-${p.cdc}`, "ajuste (conformidad tras disconformidad)", { evento: "conformidad", cdc: p.cdc, fechaRecepcion: recibido() });
}

let fallas = 0;
try {
  await correr();
  const pendientes = E.res.some((r) => r.ok === "pendiente");
  E.terminado = !pendientes;
  guardar();
  escribirReporte(true);
  fallas = E.res.filter((r) => r.ok === false).length;
  if (pendientes) console.log("Hay lotes todavía en proceso: volvé a correr la batería para consultarlos (no se reenvía nada).");
} catch (e) {
  const msg = e instanceof Error ? `${e.message}${e.stack ? `\n${e.stack.split("\n").slice(1, 4).join("\n")}` : ""}` : String(e);
  guardar();
  escribirReporte(false, msg);
  console.error(`La batería se cortó: ${msg}\nEl avance quedó guardado: volvé a correrla y retoma desde acá.`);
  Deno.exit(1);
}
Deno.exit(fallas ? 1 : 0);
