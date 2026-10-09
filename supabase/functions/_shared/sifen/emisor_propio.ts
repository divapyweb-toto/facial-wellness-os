// _shared/sifen/emisor_propio.ts · Dueño: E. Emisor del sistema propio (implementa `Emisor` de tipos.ts).
//
// Flujo de emitir(doc): numeración (si falta) → armarXmlDE (B) → firmarXml (C) → armarQr (B)
//   → validarXsd (B, sobre el rDE completo) → ws.enviarDE (C) → si aprobado: generarKude (D) → ResultadoEmision.
// Todo entra por `DepsEmisorPropio` (lógica pura + dobles en los tests). Las implementaciones reales
// se cargan en emisor.ts (cargarModulosSifen).
//
// Contingencia / caída de red (regla propia, alineada con el MT v150):
//   - El CDC es determinista (tipo, RUC, est, punto, número, fecha, tipo de emisión, código de seguridad):
//     reintentar con los mismos datos da el MISMO CDC. Por eso NUNCA se reenvía a ciegas:
//     si hubo un envío previo (op.cdcPrevio) o la red falló, primero se CONSULTA el CDC (siConsDE).
//   - Si la consulta dice aprobado → no se reenvía. Si dice que no existe → recién ahí se envía.
//   - Si SIFEN no responde ni a la consulta → estado 'enviada' (resultado desconocido); la cola reintenta con espera.
//   - Tipo de emisión: SIEMPRE 1 (normal). La contingencia NO existe todavía en SIFEN (MT v150 §14 "Futuro";
//     iTipEmi=2 se rechaza con 1050). El DE firmado se retransmite tal cual (op.xmlFirmadoPrevio) con
//     iTipEmi=1: plazo 72 h desde la firma (MT §6.2.1, A004); después aprobado con observación 1005;
//     emisión > 30 días atrás → rechazo 1150. La cola alerta por Telegram si un pendiente pasa 48 h.

import type {
  ArmarQr,
  ArmarXmlDE,
  CredencialesSifen,
  DatosEmisor,
  DocumentoDE,
  Emisor,
  FirmarXml,
  GenerarKude,
  ResultadoEmision,
  RespuestaSifen,
  TipoDE,
} from "./tipos.ts";
import { numeroCompletoSifen } from "./desde_pedido.ts";

/** Cliente de los web services de SIFEN (lo implementa C en ws.ts; acá solo la forma que usa el emisor). */
export interface ClienteWsSifen {
  /** siRecepDE (envío sincrónico de un DE). */
  enviarDE(xmlFirmado: string): Promise<RespuestaSifen>;
  /** siConsDE (consulta de un DE por CDC). */
  consultarDE(cdc: string): Promise<RespuestaSifen>;
  /** siRecepEvento (cancelación, inutilización, …), XML del evento ya firmado. */
  enviarEvento(xmlEventoFirmado: string): Promise<RespuestaSifen>;
  /** siConsRUC. */
  consultarRuc(ruc: string): Promise<{ ok: boolean; existe: boolean; razonSocial?: string; estado?: string; mensaje?: string }>;
  /** siConsLoteDE (opcional). */
  consultarLote?(protocolo: string): Promise<RespuestaSifen>;
}

/** Armadores de XML de eventos (los implementa B en eventos_xml.ts). Devuelven XML SIN firmar y el Id a firmar. */
export interface ArmadoresEventos {
  cancelacion(args: { cdc: string; motivo: string; fecha: string }): { xml: string; id: string };
  inutilizacion(args: {
    timbrado: string;
    establecimiento: string;
    punto: string;
    tipo: TipoDE;
    desde: number;
    hasta: number;
    motivo: string;
    fecha: string;
  }): { xml: string; id: string };
}

export type ValidarXsd = (xml: string) => Promise<{ ok: boolean; errores: string[] }> | { ok: boolean; errores: string[] };

export interface DepsEmisorPropio {
  emisor: DatosEmisor;
  cred: CredencialesSifen;
  simulado: boolean;
  armarXmlDE: ArmarXmlDE;
  firmarXml: FirmarXml;
  armarQr: ArmarQr;
  generarKude: GenerarKude;
  validarXsd?: ValidarXsd;
  /** Ambiente test: xml.ts aplicarLeyendasPrueba (literales obligatorios de prueba, MT D105). */
  prepararDoc?: (doc: DocumentoDE, emisor: DatosEmisor) => { doc: DocumentoDE; emisor: DatosEmisor };
  ws: ClienteWsSifen;
  eventos: ArmadoresEventos;
  /** sifen_siguiente_numero(...) — solo si el doc llega sin número (uso suelto, p. ej. la batería). */
  siguienteNumero?(timbrado: string, est: string, pun: string, tipo: TipoDE): Promise<number>;
  ahora(): Date;
  esperar?(ms: number): Promise<void>;
  /** Cuántas veces se reintenta el envío tras confirmar por consulta que el CDC NO existe. */
  reintentosRed?: number;
  esperaRedMs?: number;
  fechaSifen(d: Date): string;
}

export interface OpcionesEmision {
  /** CDC de un intento anterior de ESTE mismo documento: si viene, se consulta antes de enviar. */
  cdcPrevio?: string | null;
  /** XML firmado (con QR) del intento anterior: se retransmite el MISMO (no se vuelve a firmar). */
  xmlFirmadoPrevio?: string | null;
  urlQrPrevio?: string | null;
}

export interface EmisorPropio extends Emisor {
  nombre: "propio";
  emitir(doc: DocumentoDE, op?: OpcionesEmision): Promise<ResultadoEmision>;
}

const aprobado = (r: RespuestaSifen) => r.estado === "aprobado" || r.estado === "aprobado_obs";
/** Consulta que permite enviar: el CDC no está en SIFEN (rechazado/inexistente). error/error_red/en_proceso = desconocido. */
const noExiste = (r: RespuestaSifen) => (r as { existe?: boolean }).existe === false || r.estado === "rechazado";

export function crearEmisorPropio(d: DepsEmisorPropio): EmisorPropio {
  const esperar = d.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const reintentos = d.reintentosRed ?? 2;
  const esperaMs = d.esperaRedMs ?? 2000;

  async function firmarEvento(arm: { xml: string; id: string }): Promise<string> {
    const f = await d.firmarXml(arm.xml, arm.id, d.cred.certP12, d.cred.certClave);
    return f.xmlFirmado;
  }

  async function emitir(docEntrada: DocumentoDE, op: OpcionesEmision = {}): Promise<ResultadoEmision> {
    let doc: DocumentoDE = { ...docEntrada, tipoEmision: 1 as const }; // contingencia no habilitada (1050)
    if (!doc.numero) {
      if (!d.siguienteNumero) return { ok: false, estado: "error", mensaje: "documento sin número y sin numeración", simulado: d.simulado };
      doc.numero = await d.siguienteNumero(d.cred.timbrado, doc.establecimiento, doc.punto, doc.tipo);
    }
    const numeroCompleto = numeroCompletoSifen(doc.establecimiento, doc.punto, doc.numero);
    // 0. RUC del receptor activo en Marangatu (MT validaciones D206c/1307 y D206d/1308: rechazo si está
    //    CANCELADO, CANCELADO DEFINITIVO o en SUSPENSIÓN). Solo FE. Si la consulta falla (red) se sigue igual.
    let avisoRuc: string | undefined;
    if (doc.tipo === 1 && doc.receptor.tipo === "ruc" && doc.receptor.ruc) {
      try {
        const rr = await d.ws.consultarRuc(doc.receptor.dv ? `${doc.receptor.ruc}-${doc.receptor.dv}` : doc.receptor.ruc);
        const inactivo = rr.ok && (!rr.existe || /CANCELAD|SUSPENS/i.test(rr.estado ?? ""));
        if (inactivo) {
          avisoRuc = `RUC ${doc.receptor.ruc} ${rr.existe ? `en estado ${rr.estado}` : "inexistente"} en SIFEN: se factura como consumidor final`;
          doc = { ...doc, receptor: { tipo: "innominado", direccion: doc.receptor.direccion, telefono: doc.receptor.telefono, celular: doc.receptor.celular, email: doc.receptor.email } };
        }
      } catch { /* sin respuesta: se emite con el RUC informado */ }
    }
    let emisor = d.emisor;
    if (d.prepararDoc) ({ doc, emisor } = d.prepararDoc(doc, emisor));
    const base = { numeroCompleto, simulado: d.simulado, ...(avisoRuc ? { mensaje: avisoRuc } : {}) };

    // 1. XML + CDC + totales (B). Errores de reglas propias = error sin enviar.
    let armado: ReturnType<ArmarXmlDE>;
    try {
      armado = d.armarXmlDE(doc, emisor, { timbrado: d.cred.timbrado, timbradoInicio: d.cred.timbradoInicio });
    } catch (e) {
      return { ...base, ok: false, estado: "error", mensaje: `armado XML: ${msj(e)}` };
    }
    const { cdc, totales } = armado;
    // 3. Firma (C) y 4. QR (B). Si ya hay un XML firmado de este mismo CDC, se retransmite ese.
    let xmlFinal: string, urlQr: string;
    const urlPrevia = op.urlQrPrevio ?? /<dCarQR>([^<]+)<\/dCarQR>/.exec(op.xmlFirmadoPrevio ?? "")?.[1]?.replace(/&amp;/g, "&");
    if (op.xmlFirmadoPrevio && op.cdcPrevio === cdc && op.xmlFirmadoPrevio.includes(cdc) && urlPrevia) {
      xmlFinal = op.xmlFirmadoPrevio;
      urlQr = urlPrevia;
    } else try {
      const f = await d.firmarXml(armado.xml, cdc, d.cred.certP12, d.cred.certClave);
      const q = d.armarQr({ xmlFirmado: f.xmlFirmado, cdc, digestValue: f.digestValue, csc: d.cred.csc, cscId: d.cred.cscId, ambiente: d.cred.ambiente });
      xmlFinal = q.xmlConQr;
      urlQr = q.urlQr;
    } catch (e) {
      return { ...base, ok: false, estado: "error", cdc, totales, mensaje: `firma/QR: ${msj(e)}` };
    }
    const conDatos = { ...base, cdc, totales, xmlFirmado: xmlFinal, urlQr };
    // 5. XSD (B) sobre el rDE COMPLETO (el XSD exige ds:Signature y gCamFuFD). Si no valida, no se manda nada.
    if (d.validarXsd) {
      const v = await d.validarXsd(xmlFinal);
      if (!v.ok) return { ...conDatos, ok: false, estado: "error", mensaje: `XSD: ${v.errores.slice(0, 5).join("; ")}` };
    }

    // 5. Envío con consulta previa si ya hubo un intento (nunca duplicar).
    let r: RespuestaSifen | null = null;
    if (op.cdcPrevio) {
      if (op.cdcPrevio !== cdc) {
        return { ...conDatos, ok: false, estado: "error", mensaje: `el CDC cambió entre intentos (${op.cdcPrevio} → ${cdc}): revisar a mano` };
      }
      const c = await d.ws.consultarDE(cdc);
      if (aprobado(c)) r = c;
      else if (!noExiste(c)) return { ...conDatos, ok: false, estado: "enviada", codigo: c.codigo, mensaje: `consulta previa sin respuesta definitiva: ${c.mensaje ?? c.estado}` };
    }
    for (let intento = 0; !r; intento++) {
      const env = await d.ws.enviarDE(xmlFinal);
      if (env.estado !== "error_red") {
        r = env;
        break;
      }
      // Caída de red a mitad del envío: puede haber llegado. Consultar ANTES de cualquier reenvío.
      await esperar(esperaMs * (intento + 1));
      const c = await d.ws.consultarDE(cdc);
      if (aprobado(c)) {
        r = c;
        break;
      }
      if (!noExiste(c) || intento >= reintentos) {
        return { ...conDatos, ok: false, estado: "enviada", codigo: c.codigo, mensaje: `SIFEN no respondió (${env.mensaje ?? "red"}); queda pendiente de consulta` };
      }
    }

    if (r.estado === "en_proceso") return { ...conDatos, ok: false, estado: "enviada", codigo: r.codigo, mensaje: r.mensaje };
    if (r.estado === "rechazado") return { ...conDatos, ok: false, estado: "rechazada", codigo: r.codigo, mensaje: r.mensaje };
    if (!aprobado(r)) return { ...conDatos, ok: false, estado: "error", codigo: r.codigo, mensaje: r.mensaje ?? r.estado };

    // 6. KuDE (D). Si falla, la factura igual está aprobada: la cola lo vuelve a pedir.
    let kudePdf: Uint8Array | undefined;
    let errorKude: string | undefined;
    try {
      kudePdf = await d.generarKude({
        doc,
        emisor,
        timbrado: d.cred.timbrado,
        timbradoInicio: d.cred.timbradoInicio,
        cdc,
        totales,
        urlQr,
        ambiente: d.cred.ambiente,
        simulado: d.simulado,
      });
    } catch (e) {
      errorKude = `KuDE: ${msj(e)}`;
    }
    return { ...conDatos, ok: true, estado: "aprobada", codigo: r.codigo, mensaje: errorKude ?? r.mensaje, kudePdf };
  }

  return {
    nombre: "propio",
    emitir,
    consultar: (cdc) => d.ws.consultarDE(cdc),
    async cancelar(cdc, motivo) {
      // Evento de cancelación (MT v150, grupo rGeVeCan: Id = CDC, mOtEve motivo 5-500 caracteres).
      try {
        const xml = await firmarEvento(d.eventos.cancelacion({ cdc, motivo, fecha: d.fechaSifen(d.ahora()) }));
        return await d.ws.enviarEvento(xml);
      } catch (e) {
        return { ok: false, estado: "error", mensaje: `cancelación: ${msj(e)}` };
      }
    },
    async inutilizar(a) {
      // Evento de inutilización (MT v150, grupo rGeVeInu: dNumTim, dEst, dPunExp, dNumIn, dNumFin, iTiDE, mOtEve).
      try {
        const xml = await firmarEvento(d.eventos.inutilizacion({
          timbrado: d.cred.timbrado,
          establecimiento: a.establecimiento,
          punto: a.punto,
          tipo: a.tipo,
          desde: a.desde,
          hasta: a.hasta,
          motivo: a.motivo,
          fecha: d.fechaSifen(d.ahora()),
        }));
        return await d.ws.enviarEvento(xml);
      } catch (e) {
        return { ok: false, estado: "error", mensaje: `inutilización: ${msj(e)}` };
      }
    },
    consultarRuc: (ruc) => d.ws.consultarRuc(ruc),
  };
}

function msj(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── SIFEN simulado (sin red) ────────────────────────────────
// Lo usan MODO_SIMULADO=1, la batería sin certificado y los tests. Guarda en memoria lo "aprobado".
// Códigos de respuesta orientativos [VERIFICAR MT v150 tabla de códigos]: 0260 aprobado, 0420 CDC inexistente,
// 0600 evento registrado.

export interface OpcionesWsSimulado {
  /** Rechaza los DE cuyo XML contenga este texto (para probar rechazos). */
  rechazarSi?: string;
  /** Las primeras N llamadas a enviarDE fallan por red (pero el DE SÍ llega: simula "se cortó la respuesta"). */
  fallasRedLlegando?: number;
  /** Las primeras N llamadas a enviarDE fallan por red y el DE NO llega. */
  fallasRedSinLlegar?: number;
}

export function wsSimulado(op: OpcionesWsSimulado = {}): ClienteWsSifen & { recibidos: Map<string, number>; eventos: string[] } {
  const recibidos = new Map<string, number>();
  const eventos: string[] = [];
  let llegando = op.fallasRedLlegando ?? 0;
  let sinLlegar = op.fallasRedSinLlegar ?? 0;
  const cdcDe = (xml: string) => /\bId="(\d{44})"/.exec(xml)?.[1] ?? /<DE[^>]*Id="([^"]+)"/.exec(xml)?.[1] ?? "";
  return {
    recibidos,
    eventos,
    enviarDE(xml) {
      const cdc = cdcDe(xml);
      if (sinLlegar > 0) {
        sinLlegar--;
        return Promise.resolve({ ok: false, estado: "error_red", mensaje: "simulado: timeout (no llegó)" });
      }
      if (op.rechazarSi && xml.includes(op.rechazarSi)) {
        return Promise.resolve({ ok: false, estado: "rechazado", codigo: "0160", mensaje: "simulado: XML mal formado" });
      }
      recibidos.set(cdc, (recibidos.get(cdc) ?? 0) + 1);
      if (llegando > 0) {
        llegando--;
        return Promise.resolve({ ok: false, estado: "error_red", mensaje: "simulado: timeout (sí llegó)" });
      }
      return Promise.resolve({ ok: true, estado: "aprobado", codigo: "0260", mensaje: "Autorización del DE satisfactoria (simulado)", protocolo: `SIM-${cdc.slice(-8)}` });
    },
    consultarDE(cdc) {
      return Promise.resolve(
        recibidos.has(cdc)
          ? { ok: true, estado: "aprobado", codigo: "0422", mensaje: "CDC encontrado (simulado)" }
          : { ok: false, estado: "error", existe: false, codigo: "0420", mensaje: "CDC inexistente (simulado)" } as RespuestaSifen,
      );
    },
    enviarEvento(xml) {
      eventos.push(xml);
      return Promise.resolve({ ok: true, estado: "aprobado", codigo: "0600", mensaje: "Evento registrado correctamente (simulado)" });
    },
    consultarRuc(ruc) {
      const m = /^(\d{3,9})(?:-(\d))?$/.exec(ruc.trim());
      return Promise.resolve({ ok: true, existe: !!m, razonSocial: m ? "CONTRIBUYENTE DE PRUEBA" : undefined, estado: m ? "ACTIVO" : undefined });
    },
    consultarLote(protocolo) {
      return Promise.resolve({ ok: true, estado: "aprobado", codigo: "0362", mensaje: `Lote ${protocolo} procesado (simulado)` });
    },
  };
}
