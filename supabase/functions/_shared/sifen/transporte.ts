// _shared/sifen/transporte.ts · Transporte HTTP de los sobres SOAP hacia SIFEN.
//
// Fuentes:
// - MT v150 §7.4 y §7.9 (Tabla E): TLS 1.2 con AUTENTICACIÓN MUTUA usando el certificado del contribuyente;
//   SOAP 1.2. La conexión se cierra al recibir la respuesta (§8.1.1).
// - Guía de Mejores Prácticas (oct-2024) punto 5: "Nunca se debe enviar un mismo CDC sin haber tenido la
//   respuesta definitiva de SIFEN" y "Motivos de bloqueo" (reenvíos duplicados bloquean el RUC 10-60 min).
//   Por eso cada error de red se clasifica en `posibleRecepcion`: si la petición pudo llegar a SIFEN, el
//   siguiente paso es CONSULTAR (por CDC o por lote), nunca reenviar a ciegas.
// - Contingencia: según docs/sifen-requisitos.md (agente A, 2026-10-08) iTipEmi=2 se rechaza (código 1050):
//   ante error de red NO hay modo contingencia; se consulta el CDC y se retransmite dentro de las 72 h.
//   [VERIFICAR en docs/sifen-requisitos.md]
//
// Content-Type: SOAP 1.2 define "application/soap+xml"; la librería TIPS-SA (en producción) usa
// "application/xml; charset=utf-8". Se usa esta última por estar probada contra SIFEN; configurable. [VERIFICAR]
//
// ── Cómo hacer lo mismo desde Node (script de batería en la Mac) ──
//   import https from "node:https"; import fs from "node:fs";
//   const agent = new https.Agent({ pfx: fs.readFileSync("/ruta/fuera/del/repo/cert.p12"),
//                                   passphrase: process.env.SIFEN_CERT_CLAVE, minVersion: "TLSv1.2" });
//   const res = await new Promise((ok, mal) => {
//     const req = https.request(url, { method: "POST", agent, timeout: 90_000,
//       headers: { "Content-Type": "application/xml; charset=utf-8" } }, (r) => {
//         let b = ""; r.setEncoding("utf8"); r.on("data", (c) => b += c); r.on("end", () => ok({ status: r.statusCode, body: b })); });
//     req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", mal); req.end(soap); });
//   (Probado 2026-10-08 con Node contra un servidor mTLS local: OK.) En Deno, node:https NO pasa pfx/cert
//   al cliente (el polyfill solo usa caCerts) → en Deno usar TransporteMtlsDeno.

import { cargarP12 } from "./certificado.ts";
import type { CredencialesSifen } from "./tipos.ts";
import { ENV_SIFEN } from "./tipos.ts";
import {
  bloques,
  cdcDeXml,
  deszipLoteBase64,
  NS_SIFEN,
  NS_SOAP12,
  valor,
} from "./soap.ts";

export interface RespuestaHttp {
  status: number;
  body: string;
}

export interface Transporte {
  post(url: string, soap: string): Promise<RespuestaHttp>;
}

export type TipoErrorTransporte = "dns" | "conexion" | "tls" | "timeout" | "corte" | "desconocido";

/**
 * Error de red clasificado.
 * posibleRecepcion = false → la petición NO llegó a SIFEN (DNS, conexión rechazada, handshake TLS): se
 *   puede reintentar el envío sin riesgo de duplicar.
 * posibleRecepcion = true  → pudo llegar (timeout esperando respuesta, conexión cortada a mitad): CONSULTAR
 *   el CDC / lote antes de reenviar (Mejores Prácticas punto 5). También es la señal para evaluar contingencia.
 */
export class ErrorTransporte extends Error {
  constructor(public tipo: TipoErrorTransporte, public posibleRecepcion: boolean, mensaje: string) {
    super(mensaje);
    this.name = "ErrorTransporte";
  }
}

/** Clasifica un error de fetch (Deno) por su mensaje/causa. */
export function clasificarErrorRed(e: unknown): ErrorTransporte {
  if (e instanceof ErrorTransporte) return e;
  const err = e as Error & { cause?: unknown; name?: string };
  const texto = `${err?.name ?? ""} ${err?.message ?? String(e)} ${err?.cause ? String((err.cause as Error)?.message ?? err.cause) : ""}`;
  if (err?.name === "TimeoutError" || /timed? ?out|deadline/i.test(texto)) {
    return new ErrorTransporte("timeout", true, `Timeout esperando a SIFEN: ${texto.trim()}`);
  }
  if (err?.name === "AbortError") return new ErrorTransporte("timeout", true, `Petición abortada: ${texto.trim()}`);
  if (/dns|lookup|getaddrinfo|name or service|failed to lookup|nodename/i.test(texto)) {
    return new ErrorTransporte("dns", false, `No se resolvió el nombre del servidor SIFEN: ${texto.trim()}`);
  }
  if (/certificate|handshake|tls|ssl|alert|unknown ca|bad certificate|peer did not return/i.test(texto)) {
    return new ErrorTransporte("tls", false, `Fallo TLS/mTLS (certificado o handshake): ${texto.trim()}`);
  }
  // hyper/Deno: "client error (Connect): ..." = falló al establecer la conexión, nada se envió.
  if (/connection refused|ECONNREFUSED|network is unreachable|no route|ENETUNREACH|EHOSTUNREACH|\(Connect\)|are blocked/i.test(texto)) {
    return new ErrorTransporte("conexion", false, `No se pudo conectar con SIFEN: ${texto.trim()}`);
  }
  if (/reset|broken pipe|incomplete|unexpected eof|connection closed|body|socket hang up|ECONNRESET|EPIPE/i.test(texto)) {
    return new ErrorTransporte("corte", true, `Conexión cortada durante el intercambio: ${texto.trim()}`);
  }
  // Ante la duda se asume que pudo llegar (lo seguro para no duplicar es consultar).
  return new ErrorTransporte("desconocido", true, `Error de red: ${texto.trim()}`);
}

export interface OpcionesMtls {
  /** Certificado del contribuyente en PEM (titular + intermedias). */
  certPem: string;
  /** Clave privada en PEM. */
  keyPem: string;
  /** CAs extra (solo para tests contra un servidor local). SIFEN usa DigiCert: no hace falta. */
  caCerts?: string[];
  /** Timeout por petición. Por defecto 90 s (mismo valor que la librería TIPS-SA). */
  timeoutMs?: number;
  contentType?: string;
}

/**
 * Transporte real con TLS mutuo usando Deno.createHttpClient({ cert, key }).
 * Probado 2026-10-08 en Deno 2.9.7 contra un servidor local que EXIGE certificado de cliente: con
 * certificado → 200; sin certificado → falla el handshake. En Supabase Edge Runtime la API existe en el
 * código fuente (supabase/edge-runtime, ext/runtime/js/denoOverrides.js expone createHttpClient del
 * deno_fetch vendorizado que acepta cert/key) pero NO se probó en el runtime alojado. [VERIFICAR con un deploy de prueba]
 */
export class TransporteMtlsDeno implements Transporte {
  private cliente: Deno.HttpClient;
  private timeoutMs: number;
  private contentType: string;

  constructor(op: OpcionesMtls) {
    if (typeof Deno === "undefined" || typeof Deno.createHttpClient !== "function") {
      throw new Error(
        "Este runtime no tiene Deno.createHttpClient (mTLS). Alternativa: enviar desde la Mac con Deno/Node " +
          "(https.Agent con pfx) o desde otro runtime; ver comentario al inicio de transporte.ts.",
      );
    }
    this.cliente = Deno.createHttpClient({ cert: op.certPem, key: op.keyPem, caCerts: op.caCerts });
    this.timeoutMs = op.timeoutMs ?? 90_000;
    this.contentType = op.contentType ?? "application/xml; charset=utf-8";
  }

  async post(url: string, soap: string): Promise<RespuestaHttp> {
    // Refuerzo: aunque ws.ts ya lo controla, el transporte tampoco llega a producción sin autorización.
    if (/^https:\/\/sifen\.set\.gov\.py\//i.test(url) && Deno.env.get("SIFEN_PRODUCCION_AUTORIZADA") !== "si") {
      throw new Error('Producción SIFEN no autorizada: falta "autorizo producción SIFEN"');
    }
    const senal = AbortSignal.timeout(this.timeoutMs);
    let r: Response;
    try {
      r = await fetch(url, {
        method: "POST",
        client: this.cliente,
        headers: { "Content-Type": this.contentType, "User-Agent": "voltra-os-sifen/1" },
        body: soap,
        signal: senal,
        redirect: "manual", // el F5 de la SET redirige a /vdesk/hangup.php3 si falla el mTLS
      } as RequestInit & { client: Deno.HttpClient });
    } catch (e) {
      throw clasificarErrorRed(e);
    }
    try {
      return { status: r.status, body: await r.text() };
    } catch (e) {
      // Ya hubo respuesta HTTP: SIFEN recibió la petición.
      const ce = clasificarErrorRed(e);
      throw new ErrorTransporte(ce.tipo === "timeout" ? "timeout" : "corte", true, ce.message);
    }
  }

  cerrar() {
    this.cliente.close();
  }
}

// ─── Transporte simulado (tests y MODO_SIMULADO) ───

export type EscenarioSimulado =
  /** Aprueba todo (0260 / 0300→0362 / 0600 / 0502). */
  | "aprobado"
  /** Rechaza envíos con `codigoRechazo` (por defecto 1000 "CDC no correspondiente..."). */
  | "rechazado"
  /** Nunca responde: lanza ErrorTransporte timeout con posibleRecepcion=true (sin procesar). */
  | "timeout"
  /** Procesa y aprueba, pero la conexión se corta antes de la respuesta (posibleRecepcion=true). */
  | "corte_despues_de_procesar"
  /** No llega a SIFEN (conexión rechazada, posibleRecepcion=false). */
  | "sin_conexion"
  /** Responde OK después de `demoraMs`; si supera `timeoutMs` → timeout. */
  | "lento";

export interface OpcionesSimulado {
  escenario?: EscenarioSimulado;
  codigoRechazo?: string;
  mensajeRechazo?: string;
  demoraMs?: number;
  timeoutMs?: number;
  /** Cola de escenarios por petición (se consumen en orden; al vaciarse se usa `escenario`). */
  guion?: EscenarioSimulado[];
  /** Si el lote sigue "en procesamiento" (0361) las primeras N consultas. */
  consultasLoteEnProceso?: number;
}

const env12 = (cuerpo: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="${NS_SOAP12}"><env:Header/><env:Body>${cuerpo}</env:Body></env:Envelope>`;

function fechaSifen(): string {
  // Formato observado en la guía de 2024: 2024-10-08T14:51:21-03:00 (hora de Asunción).
  const d = new Date(Date.now() - 3 * 3600e3);
  return d.toISOString().slice(0, 19) + "-03:00";
}

/**
 * Responde como SIFEN (formas tomadas de los ejemplos del MT §7.4 y de la Guía de Mejores Prácticas 2024).
 * Recuerda los CDC aprobados: una consulta posterior devuelve 0422 (sirve para probar "corte → consulta →
 * no reenviar"). Registra cada petición en `solicitudes`.
 */
export class TransporteSimulado implements Transporte {
  readonly solicitudes: Array<{ url: string; soap: string; raiz: string }> = [];
  readonly aprobados = new Map<string, string>(); // cdc → protocolo
  private lotes = new Map<string, { cdcs: string[]; consultas: number; escenario: EscenarioSimulado }>();
  private contador = 1_000_000_000;
  private op: Required<Omit<OpcionesSimulado, "guion">> & { guion: EscenarioSimulado[] };

  constructor(op: OpcionesSimulado = {}) {
    this.op = {
      escenario: op.escenario ?? "aprobado",
      codigoRechazo: op.codigoRechazo ?? "1000",
      mensajeRechazo: op.mensajeRechazo ?? "CDC no correspondiente con las informaciones del XML",
      demoraMs: op.demoraMs ?? 50,
      timeoutMs: op.timeoutMs ?? 90_000,
      guion: [...(op.guion ?? [])],
      consultasLoteEnProceso: op.consultasLoteEnProceso ?? 0,
    };
  }

  /** Cambia el escenario de las próximas peticiones. */
  set escenario(e: EscenarioSimulado) {
    this.op.escenario = e;
  }

  private nuevoProtocolo(): string {
    return String(++this.contador);
  }

  async post(url: string, soap: string): Promise<RespuestaHttp> {
    const raiz = /<soap:Body><(\w+)/.exec(soap)?.[1] ?? "?";
    this.solicitudes.push({ url, soap, raiz });
    const esc = this.op.guion.shift() ?? this.op.escenario;

    if (esc === "sin_conexion") throw new ErrorTransporte("conexion", false, "Simulado: connection refused");
    if (esc === "timeout") {
      await new Promise((r) => setTimeout(r, Math.min(this.op.demoraMs, 50)));
      throw new ErrorTransporte("timeout", true, "Simulado: timeout esperando a SIFEN");
    }
    if (esc === "lento") {
      if (this.op.demoraMs > this.op.timeoutMs) {
        await new Promise((r) => setTimeout(r, this.op.timeoutMs));
        throw new ErrorTransporte("timeout", true, "Simulado: respuesta lenta superó el timeout");
      }
      await new Promise((r) => setTimeout(r, this.op.demoraMs));
    }
    const respuesta = this.responder(raiz, soap, esc);
    if (esc === "corte_despues_de_procesar") throw new ErrorTransporte("corte", true, "Simulado: conexión cortada tras procesar");
    return respuesta;
  }

  private responder(raiz: string, soap: string, esc: EscenarioSimulado): RespuestaHttp {
    const rechazar = esc === "rechazado";
    const ok = (b: string): RespuestaHttp => ({ status: 200, body: env12(b) });
    switch (raiz) {
      case "rEnviDe": {
        const cdc = cdcDeXml(soap);
        const digest = /<DigestValue>([^<]+)</.exec(soap)?.[1] ?? "";
        if (rechazar) {
          return ok(`<ns2:rRetEnviDe xmlns:ns2="${NS_SIFEN}"><ns2:rProtDe><ns2:Id>${cdc}</ns2:Id><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:dDigVal>${digest}</ns2:dDigVal><ns2:dEstRes>Rechazado</ns2:dEstRes><ns2:gResProc><ns2:dCodRes>${this.op.codigoRechazo}</ns2:dCodRes><ns2:dMsgRes>${this.op.mensajeRechazo}</ns2:dMsgRes></ns2:gResProc></ns2:rProtDe></ns2:rRetEnviDe>`);
        }
        const prot = this.aprobados.get(cdc) ?? this.nuevoProtocolo();
        this.aprobados.set(cdc, prot);
        return ok(`<ns2:rRetEnviDe xmlns:ns2="${NS_SIFEN}"><ns2:rProtDe><ns2:Id>${cdc}</ns2:Id><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:dDigVal>${digest}</ns2:dDigVal><ns2:dEstRes>Aprobado</ns2:dEstRes><ns2:dProtAut>${prot}</ns2:dProtAut><ns2:gResProc><ns2:dCodRes>0260</ns2:dCodRes><ns2:dMsgRes>Autorización del DE satisfactoria</ns2:dMsgRes></ns2:gResProc></ns2:rProtDe></ns2:rRetEnviDe>`);
      }
      case "rEnvioLote": {
        const lote = deszipLoteBase64(valor(soap, "xDE") ?? "");
        const cdcs = [...lote.matchAll(/<DE\s[^>]*Id="(\d{44})"/g)].map((m) => m[1]);
        if (rechazar) {
          return ok(`<ns2:rResEnviLoteDe xmlns:ns2="${NS_SIFEN}"><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:dCodRes>0301</ns2:dCodRes><ns2:dMsgRes>Lote no encolado para procesamiento</ns2:dMsgRes><ns2:dTpoProces>0</ns2:dTpoProces></ns2:rResEnviLoteDe>`);
        }
        const nro = this.nuevoProtocolo() + "0000000";
        this.lotes.set(nro, { cdcs, consultas: 0, escenario: esc });
        return ok(`<ns2:rResEnviLoteDe xmlns:ns2="${NS_SIFEN}"><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:dCodRes>0300</ns2:dCodRes><ns2:dMsgRes>Lote recibido con &#233;xito</ns2:dMsgRes><ns2:dProtConsLote>${nro}</ns2:dProtConsLote><ns2:dTpoProces>0</ns2:dTpoProces></ns2:rResEnviLoteDe>`);
      }
      case "rEnviConsLoteDe": {
        const nro = valor(soap, "dProtConsLote") ?? "";
        const l = this.lotes.get(nro);
        if (!l) {
          return ok(`<ns2:rResEnviConsLoteDe xmlns:ns2="${NS_SIFEN}"><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:dCodResLot>0360</ns2:dCodResLot><ns2:dMsgResLot>Número del Lote inexistente</ns2:dMsgResLot></ns2:rResEnviConsLoteDe>`);
        }
        l.consultas++;
        if (l.consultas <= this.op.consultasLoteEnProceso) {
          return ok(`<ns2:rResEnviConsLoteDe xmlns:ns2="${NS_SIFEN}"><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:dCodResLot>0361</ns2:dCodResLot><ns2:dMsgResLot>Lote {${nro}} en procesamiento</ns2:dMsgResLot></ns2:rResEnviConsLoteDe>`);
        }
        const items = l.cdcs.map((cdc, i) => {
          const rech = rechazar && i === 0;
          if (!rech) {
            const p = this.aprobados.get(cdc) ?? this.nuevoProtocolo();
            this.aprobados.set(cdc, p);
            return `<ns2:gResProcLote><ns2:id>${cdc}</ns2:id><ns2:dEstRes>Aprobado</ns2:dEstRes><ns2:dProtAut>${p}</ns2:dProtAut><ns2:gResProc><ns2:dCodRes>0260</ns2:dCodRes><ns2:dMsgRes>Autorización del DE satisfactoria</ns2:dMsgRes></ns2:gResProc></ns2:gResProcLote>`;
          }
          return `<ns2:gResProcLote><ns2:id>${cdc}</ns2:id><ns2:dEstRes>Rechazado</ns2:dEstRes><ns2:gResProc><ns2:dCodRes>${this.op.codigoRechazo}</ns2:dCodRes><ns2:dMsgRes>${this.op.mensajeRechazo}</ns2:dMsgRes></ns2:gResProc></ns2:gResProcLote>`;
        }).join("");
        return ok(`<ns2:rResEnviConsLoteDe xmlns:ns2="${NS_SIFEN}"><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:dCodResLot>0362</ns2:dCodResLot><ns2:dMsgResLot>Procesamiento de lote {${nro}} concluido</ns2:dMsgResLot>${items}</ns2:rResEnviConsLoteDe>`);
      }
      case "rEnviConsDeRequest": {
        const cdc = valor(soap, "dCDC") ?? "";
        const p = this.aprobados.get(cdc);
        if (!p) {
          return ok(`<ns2:rEnviConsDeResponse xmlns:ns2="${NS_SIFEN}"><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:dCodRes>0420</ns2:dCodRes><ns2:dMsgRes>Documento No Existe en SIFEN o ha sido Rechazado</ns2:dMsgRes></ns2:rEnviConsDeResponse>`);
        }
        return ok(`<ns2:rEnviConsDeResponse xmlns:ns2="${NS_SIFEN}"><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:dCodRes>0422</ns2:dCodRes><ns2:dMsgRes>CDC encontrado</ns2:dMsgRes><ns2:xContenDE>&lt;rContDe&gt;&lt;dProtAut&gt;${p}&lt;/dProtAut&gt;&lt;/rContDe&gt;</ns2:xContenDE></ns2:rEnviConsDeResponse>`);
      }
      case "rEnviEventoDe": {
        const id = /<rEve\s[^>]*Id="([^"]+)"/.exec(soap)?.[1] ?? "0";
        if (rechazar) {
          return ok(`<ns2:rRetEnviEventoDe xmlns:ns2="${NS_SIFEN}"><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:gResProcEVe><ns2:dEstRes>Rechazado</ns2:dEstRes><ns2:id>${id}</ns2:id><ns2:gResProc><ns2:dCodRes>${this.op.codigoRechazo}</ns2:dCodRes><ns2:dMsgRes>${this.op.mensajeRechazo}</ns2:dMsgRes></ns2:gResProc></ns2:gResProcEVe></ns2:rRetEnviEventoDe>`);
        }
        return ok(`<ns2:rRetEnviEventoDe xmlns:ns2="${NS_SIFEN}"><ns2:dFecProc>${fechaSifen()}</ns2:dFecProc><ns2:gResProcEVe><ns2:dEstRes>Aprobado</ns2:dEstRes><ns2:dProtAut>${this.nuevoProtocolo()}</ns2:dProtAut><ns2:id>${id}</ns2:id><ns2:gResProc><ns2:dCodRes>0600</ns2:dCodRes><ns2:dMsgRes>Evento registrado correctamente</ns2:dMsgRes></ns2:gResProc></ns2:gResProcEVe></ns2:rRetEnviEventoDe>`);
      }
      case "rEnviConsRUC": {
        const ruc = valor(soap, "dRUCCons") ?? "";
        if (rechazar) {
          return ok(`<ns2:rResEnviConsRUC xmlns:ns2="${NS_SIFEN}"><ns2:dCodRes>0500</ns2:dCodRes><ns2:dMsgRes>RUC no existe</ns2:dMsgRes></ns2:rResEnviConsRUC>`);
        }
        return ok(`<ns2:rResEnviConsRUC xmlns:ns2="${NS_SIFEN}"><ns2:dCodRes>0502</ns2:dCodRes><ns2:dMsgRes>RUC encontrado</ns2:dMsgRes><ns2:xContRUC><ns2:dRUCCons>${ruc}</ns2:dRUCCons><ns2:dRazCons>CONTRIBUYENTE DE PRUEBA</ns2:dRazCons><ns2:dCodEstCons>ACT</ns2:dCodEstCons><ns2:dDesEstCons>ACTIVO</ns2:dDesEstCons><ns2:dRUCFactElec>S</ns2:dRUCFactElec></ns2:xContRUC></ns2:rResEnviConsRUC>`);
      }
      default:
        return { status: 500, body: env12(`<env:Fault><env:Code><env:Value>env:Sender</env:Value></env:Code><env:Reason><env:Text xml:lang="es">Operación desconocida ${raiz}</env:Text></env:Reason></env:Fault>`) };
    }
  }

  /** Cantidad de peticiones con cierta raíz (ej. "rEnviDe"). */
  contar(raiz: string): number {
    return this.solicitudes.filter((s) => s.raiz === raiz).length;
  }

  /** Útil en tests: bloques crudos de la última petición. */
  ultima(): string | undefined {
    return this.solicitudes.at(-1)?.soap;
  }
}

// ─── Fábrica ───

/**
 * MODO_SIMULADO=1 → TransporteSimulado("aprobado"). Si no, TransporteMtlsDeno con el .p12 de las credenciales.
 * `leerEnv` permite inyectar variables en tests.
 */
export function transporteDesdeEnv(
  cred: Pick<CredencialesSifen, "certP12" | "certClave">,
  leerEnv: (n: string) => string | undefined = (n) => {
    try {
      return Deno.env.get(n);
    } catch {
      return undefined;
    }
  },
  opciones: Partial<Pick<OpcionesMtls, "timeoutMs" | "contentType">> = {},
): Transporte {
  if (leerEnv(ENV_SIFEN.simulado) === "1") return new TransporteSimulado({ escenario: "aprobado" });
  const c = cargarP12(cred.certP12, cred.certClave);
  return new TransporteMtlsDeno({ certPem: c.cadenaPem, keyPem: c.clavePrivadaPem, ...opciones });
}

// Re-export para quien solo importe transporte.ts en tests.
export { bloques };
