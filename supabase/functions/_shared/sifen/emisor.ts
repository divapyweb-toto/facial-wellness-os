// _shared/sifen/emisor.ts · Dueño: E. Fábrica del emisor intercambiable + carga de los módulos de B/C/D.
//
//   emisorDesdeConfig('propio' | 'facturasend')  → 'propio' por defecto (sistema propio SIFEN).
//   crearEmisorPropioDesdeEntorno(...)          → arma el EmisorPropio con los módulos reales y los secretos.
//
// Modo simulado (sin red): MODO_SIMULADO=1, o falta certificado / timbrado / CSC. En simulado SIFEN responde
// un doble en memoria (wsSimulado) y, si algún módulo de B/C todavía no existe, se usa un reemplazo mínimo
// marcado como SIMULADO (nunca en modo real: ahí falta un módulo = error).
// Producción: solo con SIFEN_AMBIENTE=prod Y SIFEN_PRODUCCION_AUTORIZADA=si (además ws.ts la rechaza sin eso).

import {
  type RespuestaSifen,
  type ArmarQr,
  type ArmarXmlDE,
  type CredencialesSifen,
  type DatosEmisor,
  type DocumentoDE,
  type Emisor,
  ENV_SIFEN,
  type FirmarXml,
  type GenerarKude,
  type ResultadoEmision,
  type TipoDE,
  type TotalesDE,
} from "./tipos.ts";
import { type ArmadoresEventos, type ClienteWsSifen, crearEmisorPropio, type EmisorPropio, type OpcionesEmision, type ValidarXsd, wsSimulado } from "./emisor_propio.ts";
import { crearEmisorFacturaSend } from "./emisor_facturasend.ts";
import { fechaSifen, totalItem } from "./desde_pedido.ts";
import { digitoVerificadorRuc } from "../facturacion.ts";

export type NombreEmisor = "propio" | "facturasend";

/** Emisor que usa la cola: acepta el CDC previo y puede devolver la ruta del KuDE ya subido. */
export interface EmisorCola extends Emisor {
  emitir(doc: DocumentoDE, op?: OpcionesEmision): Promise<ResultadoEmision & { kudePath?: string }>;
}

export function nombreEmisor(x: unknown): NombreEmisor {
  return x === "facturasend" ? "facturasend" : "propio";
}

export async function emisorDesdeConfig(
  nombre: unknown,
  fabricas: { propio: () => Promise<EmisorCola> | EmisorCola; facturasend?: () => EmisorCola },
): Promise<EmisorCola> {
  if (nombreEmisor(nombre) === "facturasend") return (fabricas.facturasend ?? (() => crearEmisorFacturaSend()))();
  return await fabricas.propio();
}

// ─── Credenciales desde el entorno ───────────────────────────

export interface EstadoCredenciales {
  cred: CredencialesSifen;
  simulado: boolean;
  motivo?: string;
  certDePrueba: boolean;
}

function base64ABytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Lee ENV_SIFEN. Nunca devuelve prod sin SIFEN_PRODUCCION_AUTORIZADA=si (y aun así ws.ts vuelve a chequear). */
export function credencialesDesdeEnv(env: (n: string) => string | undefined): EstadoCredenciales {
  const ambiente = env(ENV_SIFEN.ambiente) === "prod" ? "prod" : "test";
  const autorizada = env(ENV_SIFEN.produccionAutorizada) === "si";
  const p12 = env(ENV_SIFEN.certP12Base64);
  const faltan = [
    !p12 && ENV_SIFEN.certP12Base64,
    !env(ENV_SIFEN.certClave) && ENV_SIFEN.certClave,
    !env(ENV_SIFEN.timbrado) && ENV_SIFEN.timbrado,
    !env(ENV_SIFEN.timbradoInicio) && ENV_SIFEN.timbradoInicio,
    !env(ENV_SIFEN.csc) && ENV_SIFEN.csc,
  ].filter(Boolean) as string[];
  let motivo: string | undefined;
  if (env(ENV_SIFEN.simulado) === "1") motivo = "MODO_SIMULADO=1";
  else if (faltan.length) motivo = `faltan ${faltan.join(", ")}`;
  else if (ambiente === "prod" && !autorizada) motivo = "SIFEN_AMBIENTE=prod sin SIFEN_PRODUCCION_AUTORIZADA=si";
  const cred: CredencialesSifen = {
    ambiente: motivo ? "test" : ambiente,
    timbrado: env(ENV_SIFEN.timbrado) ?? "12345678", // inventado para simulado
    timbradoInicio: env(ENV_SIFEN.timbradoInicio) ?? "2026-01-01",
    csc: env(ENV_SIFEN.csc) ?? "ABCD0000000000000000000000000000",
    cscId: env(ENV_SIFEN.cscId) ?? "0001",
    certP12: p12 ? base64ABytes(p12) : new Uint8Array(),
    certClave: env(ENV_SIFEN.certClave) ?? "",
    produccionAutorizada: autorizada,
  };
  return { cred, simulado: !!motivo, motivo, certDePrueba: !p12 };
}

/** Datos del emisor INVENTADOS (simulado / tests). Los reales van en config_wa['sifen'].emisor. */
export function datosEmisorPrueba(): DatosEmisor {
  const ruc = "80000001";
  return {
    ruc,
    dv: String(digitoVerificadorRuc(ruc)),
    razonSocial: "EMPRESA DE PRUEBA S.A.",
    nombreFantasia: "Voltra (prueba)",
    tipoContribuyente: 2,
    direccion: "Calle Inventada",
    numeroCasa: "0",
    departamento: { codigo: 1, descripcion: "CAPITAL" },
    distrito: { codigo: 1, descripcion: "ASUNCION (DISTRITO)" },
    ciudad: { codigo: 1, descripcion: "ASUNCION (DISTRITO)" },
    telefono: "0000000000",
    email: "prueba@example.com",
    actividades: [{ codigo: "47919", descripcion: "VENTA AL POR MENOR POR CORREO E INTERNET" }],
    establecimiento: "001",
    punto: "001",
  };
}

// ─── Carga de módulos de B/C/D ───────────────────────────────

export interface ModulosSifen {
  armarXmlDE: ArmarXmlDE;
  firmarXml: FirmarXml;
  armarQr: ArmarQr;
  generarKude: GenerarKude;
  validarXsd?: ValidarXsd;
  prepararDoc?: (doc: DocumentoDE, emisor: DatosEmisor) => { doc: DocumentoDE; emisor: DatosEmisor };
  ws: ClienteWsSifen;
  eventos: ArmadoresEventos;
  /** Módulos que NO se encontraron y se reemplazaron por un doble simulado. */
  simulados: string[];
}

type Mod = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Fn = (...a: any[]) => any;
const elegir = (m: Mod | null, nombres: string[]): Fn | undefined => {
  for (const n of nombres) if (m && typeof m[n] === "function") return m[n] as Fn;
  return undefined;
};

/** Import opcional: si el archivo del otro agente todavía no existe, devuelve null. */
async function importarOpcional(cargar: () => Promise<Mod>): Promise<Mod | null> {
  try {
    return await cargar();
  } catch (e) {
    const t = e instanceof Error ? e.message : String(e);
    if (/Module not found|Cannot find module|No such file|not found/i.test(t)) return null;
    throw e;
  }
}

// Imports dinámicos con ruta LITERAL: el bundler de Supabase los incluye y no se cargan pdf-lib / wasm / forge
// hasta que se emite de verdad.
export const CARGADORES = {
  xml: () => import("./xml.ts") as Promise<Mod>,
  firma: () => import("./firma.ts") as Promise<Mod>,
  qr: () => import("./qr.ts") as Promise<Mod>,
  kude: () => import("./kude.ts") as Promise<Mod>,
  xsd: () => import("./validar_xsd.ts") as Promise<Mod>,
  ws: () => import("./ws.ts") as Promise<Mod>,
  certificado: () => import("./certificado.ts") as Promise<Mod>,
  eventos: () => import("./eventos_xml.ts") as Promise<Mod>,
};

export async function cargarModulosSifen(
  simulado: boolean,
  cred: CredencialesSifen,
  opciones: { usarFirmaReal?: boolean; cargadores?: Partial<Record<keyof typeof CARGADORES, () => Promise<Mod>>> } = {},
): Promise<ModulosSifen> {
  const c = { ...CARGADORES, ...opciones.cargadores };
  const [xml, firma, qr, kude, xsd, ws, ev] = await Promise.all(
    [c.xml, c.firma, c.qr, c.kude, c.xsd, c.ws, c.eventos].map((f) => importarOpcional(f)),
  );
  const simulados: string[] = [];
  const falta = (nombre: string) => {
    if (!simulado) throw new Error(`SIFEN real: falta el módulo ${nombre} (o no exporta lo esperado)`);
    simulados.push(nombre);
  };

  let armarXmlDE = elegir(xml, ["armarXmlDE", "armarXml"]) as ArmarXmlDE | undefined;
  if (!armarXmlDE) falta("xml.ts"), armarXmlDE = armarXmlSimulado;
  let firmarXml = elegir(firma, ["firmarXml", "firmar"]) as FirmarXml | undefined;
  let armarQr = elegir(qr, ["armarQr", "armarQR"]) as ArmarQr | undefined;
  if (!firmarXml || (simulado && !opciones.usarFirmaReal)) {
    if (!firmarXml) falta("firma.ts");
    else simulados.push("firma.ts (sin certificado de prueba)");
    // qr.ts verifica el DigestValue contra la firma: con firma simulada, QR simulado también.
    firmarXml = firmarSimulado;
    armarQr = armarQrSimulado;
  }
  if (!armarQr) falta("qr.ts"), armarQr = armarQrSimulado;
  let generarKude = elegir(kude, ["generarKude"]) as GenerarKude | undefined;
  if (!generarKude) falta("kude.ts"), generarKude = kudeSimulado;
  // validar_xsd.ts (B): validar(xml, "rDE") → {valido, errores}. Si los XSD no se pueden CARGAR (falta el
  // static_files en el despliegue) no se frena la emisión: SIFEN valida igual y se loguea el problema.
  const fnXsd = elegir(xsd, ["validar", "validarXsd"]);
  const validarXsd: ValidarXsd | undefined = fnXsd
    ? async (x: string) => {
      try {
        const r = await fnXsd(x, "rDE") as { valido?: boolean; ok?: boolean; errores?: string[] };
        return { ok: r.valido ?? r.ok ?? false, errores: r.errores ?? [] };
      } catch (e) {
        console.warn("sifen: no se pudo validar contra XSD (se sigue):", e instanceof Error ? e.message : e);
        return { ok: true, errores: [] };
      }
    }
    : undefined;

  // ws.ts (C): clienteDesdeCredenciales(cred) → ClienteSifen (transporte mTLS con el .p12).
  let cliente: ClienteWsSifen;
  if (simulado) cliente = wsSimulado();
  else {
    const fab = elegir(ws, ["clienteDesdeCredenciales"]);
    if (!fab) throw new Error("SIFEN real: ws.ts no exporta clienteDesdeCredenciales");
    const c = fab(cred) as {
      enviarDE(x: string): Promise<RespuestaSifen>;
      consultarDE(cdc: string): Promise<RespuestaSifen>;
      enviarEvento(x: string): Promise<RespuestaSifen>;
      consultarLote(p: string): Promise<RespuestaSifen>;
      consultarRuc(r: string): Promise<RespuestaSifen & { existe?: boolean; contribuyente?: { razonSocial: string; estado: string } }>;
    };
    cliente = {
      enviarDE: (x) => c.enviarDE(x),
      consultarDE: (cdc) => c.consultarDE(cdc),
      enviarEvento: (x) => c.enviarEvento(x),
      consultarLote: (p) => c.consultarLote(p),
      async consultarRuc(ruc) {
        const r = await c.consultarRuc(ruc.split("-")[0]);
        return { ok: r.estado !== "error_red", existe: r.existe === true, razonSocial: r.contribuyente?.razonSocial, estado: r.contribuyente?.estado, mensaje: r.mensaje };
      },
    };
  }

  // eventos_xml.ts (B): xmlEventoCancelacion({cdc, motivo, fechaFirma}) / xmlEventoInutilizacion({...}) → {xml, idEvento}.
  const can0 = elegir(ev, ["xmlEventoCancelacion", "armarEventoCancelacion"]);
  const inu0 = elegir(ev, ["xmlEventoInutilizacion", "armarEventoInutilizacion"]);
  const can = can0 && ((a: { cdc: string; motivo: string; fecha: string }) => can0({ cdc: a.cdc, motivo: a.motivo, fechaFirma: a.fecha }));
  const inu = inu0 && ((a: Parameters<ArmadoresEventos["inutilizacion"]>[0]) =>
    inu0({ timbrado: a.timbrado, establecimiento: a.establecimiento, punto: a.punto, desde: a.desde, hasta: a.hasta, tipo: a.tipo, motivo: a.motivo, fechaFirma: a.fecha }));
  if (!can || !inu) falta("eventos_xml.ts");
  const eventos: ArmadoresEventos = {
    cancelacion: can ? (a) => normalizarEvento(can(a), a.cdc) : eventoCancelacionSimulado,
    inutilizacion: inu ? (a) => normalizarEvento(inu(a), `inu-${a.desde}-${a.hasta}`) : eventoInutilizacionSimulado,
  };
  // Ambiente test: literales obligatorios de prueba (xml.ts aplicarLeyendasPrueba, MT D105 / E708).
  const leyendas = elegir(xml, ["aplicarLeyendasPrueba"]);
  const prepararDoc = cred.ambiente === "test" && leyendas
    ? (doc: DocumentoDE, em: DatosEmisor) => leyendas(doc, em) as { doc: DocumentoDE; emisor: DatosEmisor }
    : undefined;
  return { armarXmlDE, firmarXml, armarQr, generarKude, validarXsd, prepararDoc, ws: cliente, eventos, simulados };
}

function normalizarEvento(r: unknown, idDefecto: string): { xml: string; id: string } {
  if (typeof r === "string") return { xml: r, id: /\bId="([^"]+)"/.exec(r)?.[1] ?? idDefecto };
  const o = r as { xml: string; id?: string; idEvento?: string | number };
  return { xml: o.xml, id: String(o.idEvento ?? o.id ?? "") || (/\bId="([^"]+)"/.exec(o.xml)?.[1] ?? idDefecto) };
}

export async function crearEmisorPropioDesdeEntorno(args: {
  emisor?: DatosEmisor | null;
  env?: (n: string) => string | undefined;
  siguienteNumero?: (timbrado: string, est: string, pun: string, tipo: TipoDE) => Promise<number>;
  cargadores?: Partial<Record<keyof typeof CARGADORES, () => Promise<Mod>>>;
}): Promise<{ emisor: EmisorPropio; simulado: boolean; motivo?: string; modulosSimulados: string[]; cred: CredencialesSifen }> {
  const env = args.env ?? ((n: string) => Deno.env.get(n) ?? undefined);
  const est = credencialesDesdeEnv(env);
  if (!est.simulado && !args.emisor) throw new Error("SIFEN real: falta config_wa['sifen'].emisor (datos del emisor)");
  let usarFirmaReal = !est.certDePrueba;
  if (est.simulado && est.certDePrueba) {
    // Simulado sin .p12: autofirmado de prueba (certificado.ts de C) para que firma y QR sean los reales.
    try {
      const cm = await (args.cargadores?.certificado ?? CARGADORES.certificado)();
      const gen = elegir(cm, ["generarCertificadoPrueba"]);
      if (gen) {
        const em = args.emisor ?? datosEmisorPrueba();
        const c = await gen({ ruc: em.ruc, dv: em.dv }) as { p12: Uint8Array; clave: string };
        est.cred.certP12 = c.p12;
        est.cred.certClave = c.clave;
        usarFirmaReal = true;
      }
    } catch (e) {
      console.warn("sifen: sin certificado de prueba, firma simulada:", e instanceof Error ? e.message : e);
    }
  }
  const m = await cargarModulosSifen(est.simulado, est.cred, { usarFirmaReal, cargadores: args.cargadores });
  const emisor = crearEmisorPropio({
    emisor: args.emisor ?? datosEmisorPrueba(),
    cred: est.cred,
    simulado: est.simulado,
    ...m,
    siguienteNumero: args.siguienteNumero,
    ahora: () => new Date(),
    fechaSifen,
  });
  return { emisor, simulado: est.simulado, motivo: est.motivo, modulosSimulados: m.simulados, cred: est.cred };
}

// ─── Dobles SIMULADOS (solo modo simulado; nunca valen fiscalmente) ───

/** DV módulo 11 del CDC (MT v150 §CDC: mismo algoritmo que el RUC, base 11). */
function dvMod11(s: string): number {
  return digitoVerificadorRuc(s);
}

/** CDC con la estructura del MT v150 (44 dígitos). Solo para el doble simulado: el real lo calcula cdc.ts (B). */
export function cdcSimuladoDoc(doc: DocumentoDE, emisor: DatosEmisor): string {
  const fecha = doc.fechaEmision.slice(0, 10).replace(/-/g, "");
  const base = String(doc.tipo).padStart(2, "0") + emisor.ruc.padStart(8, "0") + emisor.dv + doc.establecimiento.padStart(3, "0") +
    doc.punto.padStart(3, "0") + String(doc.numero).padStart(7, "0") + String(emisor.tipoContribuyente) + fecha + String(doc.tipoEmision) +
    doc.codigoSeguridad.padStart(9, "0");
  return base + String(dvMod11(base));
}

export function totalesSimulados(doc: DocumentoDE): TotalesDE {
  let g10 = 0, g5 = 0, ex = 0, desc = 0;
  for (const i of doc.items) {
    const t = totalItem(i);
    desc += (i.descuentoUnitario ?? 0) * i.cantidad;
    if (i.ivaTasa === 10) g10 += t;
    else if (i.ivaTasa === 5) g5 += t;
    else ex += t;
  }
  const iva10 = Math.round(g10 / 11), iva5 = Math.round(g5 / 21);
  return {
    total: g10 + g5 + ex,
    totalIva: iva10 + iva5,
    iva10,
    iva5,
    base10: g10 - iva10,
    base5: g5 - iva5,
    gravado10: g10,
    gravado5: g5,
    exento: ex,
    exonerado: 0,
    descuentoTotal: desc,
  };
}

const armarXmlSimulado: ArmarXmlDE = (doc, emisor) => {
  const cdc = cdcSimuladoDoc(doc, emisor);
  const totales = totalesSimulados(doc);
  const xml = `<rDE><!-- SIMULADO: sin valor fiscal --><DE Id="${cdc}"><iTiDE>${doc.tipo}</iTiDE><dNumDoc>${String(doc.numero).padStart(7, "0")}` +
    `</dNumDoc><dTotGralOpe>${totales.total}</dTotGralOpe></DE></rDE>`;
  return { xml, cdc, totales };
};
const firmarSimulado: FirmarXml = (xml) => Promise.resolve({ xmlFirmado: xml.replace("</DE>", "</DE><Signature>SIMULADA</Signature>"), digestValue: "U0lNVUxBRE8=" });
const armarQrSimulado: ArmarQr = (a) => {
  const urlQr = `https://ekuatia.set.gov.py/consultas-test/qr?nVersion=150&Id=${a.cdc}&simulado=1`;
  return { urlQr, xmlConQr: a.xmlFirmado.replace("</rDE>", `<gCamFuFD><dCarQR>${urlQr}</dCarQR></gCamFuFD></rDE>`) };
};
const kudeSimulado: GenerarKude = (a) =>
  Promise.resolve(new TextEncoder().encode(`%PDF-1.4\n% KuDE SIMULADO - SIN VALOR FISCAL - CDC ${a.cdc}\n%%EOF\n`));
const eventoCancelacionSimulado = (a: { cdc: string; motivo: string }) => ({
  xml: `<rEve Id="can-${a.cdc}"><rGeVeCan><Id>${a.cdc}</Id><mOtEve>${a.motivo}</mOtEve></rGeVeCan></rEve>`,
  id: `can-${a.cdc}`,
});
const eventoInutilizacionSimulado = (a: { timbrado: string; establecimiento: string; punto: string; tipo: TipoDE; desde: number; hasta: number; motivo: string }) => ({
  xml: `<rEve Id="inu-${a.desde}-${a.hasta}"><rGeVeInu><dNumTim>${a.timbrado}</dNumTim><dEst>${a.establecimiento}</dEst><dPunExp>${a.punto}</dPunExp>` +
    `<dNumIn>${a.desde}</dNumIn><dNumFin>${a.hasta}</dNumFin><iTiDE>${a.tipo}</iTiDE><mOtEve>${a.motivo}</mOtEve></rGeVeInu></rEve>`,
  id: `inu-${a.desde}-${a.hasta}`,
});
