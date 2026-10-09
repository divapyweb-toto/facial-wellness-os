// _shared/sifen/ws.ts · Cliente de los Web Services de SIFEN (test / producción con guardia).
//
// URLs — fuentes (verificadas 2026-10-08):
// - MT v150 §7.10 "Resumen de las Direcciones Electrónicas": https://sifen(-test).set.gov.py/de/ws/...wsdl?wsdl
//   (el "?wsdl" es para descargar el WSDL; el MT tiene una errata "recibe.wsd?wsdl" en test).
// - Guía de Mejores Prácticas (oct-2024) "Servicios Web Asíncronos": el servicio es
//   https://{ambiente}/de/ws/async/recibe-lote.wsdl y "para obtener el WSDL agregar ?wsdl" → el POST va a la
//   URL CON ".wsdl" y SIN "?wsdl" (igual que la librería TIPS-SA en producción).
// - Observado 2026-10-08: sin certificado de cliente, sifen-test responde 302 → /vdesk/hangup.php3 (F5 BigIP);
//   certificado de servidor *.set.gov.py emitido por DigiCert (confiable por defecto).
//
// GUARDIA: si ambiente === "prod" y produccionAutorizada !== true → throw ANTES de cualquier red
// (docs/sifen-contrato.md: producción prohibida hasta "autorizo producción SIFEN").

import type { AmbienteSifen, CredencialesSifen } from "./tipos.ts";
import {
  cdcDeXml,
  generarDId,
  parsearConsDE,
  parsearConsRuc,
  parsearResEnviConsLoteDe,
  parsearResEnviLoteDe,
  parsearRetEnviDe,
  parsearRetEnviEventoDe,
  type RespuestaWs,
  soapConsDE,
  soapConsLote,
  soapConsRuc,
  soapEnviDe,
  soapEnvioLote,
  soapEvento,
} from "./soap.ts";
import { clasificarErrorRed, ErrorTransporte, type Transporte, transporteDesdeEnv } from "./transporte.ts";

const RUTAS = {
  recibe: "/de/ws/sync/recibe.wsdl", // siRecepDE (MT §9.1)
  recibeLote: "/de/ws/async/recibe-lote.wsdl", // siRecepLoteDE (MT §9.2)
  consultaLote: "/de/ws/consultas/consulta-lote.wsdl", // siResultLoteDE (MT §9.3)
  consulta: "/de/ws/consultas/consulta.wsdl", // siConsDE (MT §9.4)
  evento: "/de/ws/eventos/evento.wsdl", // siRecepEvento (MT §9.5)
  consultaRuc: "/de/ws/consultas/consulta-ruc.wsdl", // siConsRUC (MT §9.6)
} as const;
export type ServicioSifen = keyof typeof RUTAS;

export const HOSTS_SIFEN: Record<AmbienteSifen, string> = {
  test: "https://sifen-test.set.gov.py",
  prod: "https://sifen.set.gov.py",
};

export const URLS_SIFEN: Record<AmbienteSifen, Record<ServicioSifen, string>> = {
  test: Object.fromEntries(Object.entries(RUTAS).map(([k, r]) => [k, HOSTS_SIFEN.test + r])) as Record<ServicioSifen, string>,
  prod: Object.fromEntries(Object.entries(RUTAS).map(([k, r]) => [k, HOSTS_SIFEN.prod + r])) as Record<ServicioSifen, string>,
};

export const MENSAJE_PROD_NO_AUTORIZADA = 'Producción SIFEN no autorizada: falta "autorizo producción SIFEN"';

/** Lanza si se intenta producción sin autorización explícita. Llamar ANTES de tocar la red. */
export function verificarAutorizacionProduccion(ambiente: AmbienteSifen, produccionAutorizada: boolean | undefined) {
  if (ambiente !== "test" && ambiente !== "prod") throw new Error(`Ambiente SIFEN inválido: ${ambiente}`);
  if (ambiente === "prod" && produccionAutorizada !== true) throw new Error(MENSAJE_PROD_NO_AUTORIZADA);
}

export interface OpcionesCliente {
  ambiente: AmbienteSifen;
  produccionAutorizada: boolean;
  transporte: Transporte;
  /** Reintentos ante error de red SIN posible recepción (y en consultas, ante cualquier error de red). Defecto 3. */
  reintentos?: number;
  /** Espera base del backoff exponencial (1 s, 2 s, 4 s...). Defecto 1000 ms. */
  esperaBaseMs?: number;
  /** Inyectable en tests. */
  dormir?: (ms: number) => Promise<void>;
  generarDId?: () => string;
}

export interface ClienteSifen {
  readonly ambiente: AmbienteSifen;
  /** siRecepDE síncrono. Un solo intento si hay riesgo de duplicar (ver enviarDESeguro). */
  enviarDE(xmlFirmado: string): Promise<RespuestaWs>;
  /**
   * enviarDE + protocolo anti-duplicado (Mejores Prácticas punto 5): si la red se corta con posible
   * recepción, CONSULTA el CDC; si SIFEN ya lo aprobó devuelve esa aprobación sin reenviar; si responde 0420
   * (no existe) reenvía una vez; si la consulta tampoco responde devuelve error_red + consultarAntesDeReenviar.
   */
  enviarDESeguro(xmlFirmado: string): Promise<RespuestaWs>;
  /** siRecepLoteDE asíncrono (≤50 DE mismo tipo). Nunca reenvía solo un lote con posible recepción. */
  enviarLote(xmlsFirmados: string[]): Promise<RespuestaWs>;
  consultarLote(protocolo: string): Promise<RespuestaWs>;
  consultarDE(cdc: string): Promise<RespuestaWs>;
  enviarEvento(xmlEventoFirmado: string): Promise<RespuestaWs>;
  consultarRuc(ruc: string): Promise<RespuestaWs>;
}

function errorRed(e: ErrorTransporte): RespuestaWs {
  return {
    ok: false,
    estado: "error_red",
    mensaje: e.message,
    reintentable: true,
    consultarAntesDeReenviar: e.posibleRecepcion,
  };
}

export function crearClienteSifen(op: OpcionesCliente): ClienteSifen {
  // Guardia en la construcción (antes de cualquier red) y otra vez en cada llamada.
  verificarAutorizacionProduccion(op.ambiente, op.produccionAutorizada);
  const reintentos = op.reintentos ?? 3;
  const esperaBase = op.esperaBaseMs ?? 1000;
  const dormir = op.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nuevoDId = op.generarDId ?? (() => generarDId());
  const urls = URLS_SIFEN[op.ambiente];

  /**
   * POST con reintentos. idempotente=true (consultas): reintenta ante cualquier error de red.
   * idempotente=false (envíos): reintenta SOLO si el error garantiza que SIFEN no recibió nada.
   */
  async function llamar(
    servicio: ServicioSifen,
    soap: () => string,
    parsear: (body: string, status: number) => RespuestaWs,
    idempotente: boolean,
  ): Promise<RespuestaWs> {
    verificarAutorizacionProduccion(op.ambiente, op.produccionAutorizada);
    const cuerpo = soap(); // arma (y valida) antes de la red
    let ultimo: ErrorTransporte | undefined;
    for (let intento = 0; intento <= reintentos; intento++) {
      if (intento > 0) await dormir(esperaBase * 2 ** (intento - 1));
      try {
        const r = await op.transporte.post(urls[servicio], cuerpo);
        const res = parsear(r.body, r.status);
        // Servidor ocupado (0161/0162, MT §12.2.6): la petición no se procesó → se puede reintentar.
        if (res.reintentable && res.codigo && ["0161", "0162"].includes(res.codigo) && intento < reintentos) continue;
        return res;
      } catch (e) {
        ultimo = clasificarErrorRed(e);
        if (!idempotente && ultimo.posibleRecepcion) return errorRed(ultimo); // no reenviar a ciegas
      }
    }
    return errorRed(ultimo ?? new ErrorTransporte("desconocido", true, "Sin respuesta de SIFEN"));
  }

  const cliente: ClienteSifen = {
    ambiente: op.ambiente,

    enviarDE: (xml) => llamar("recibe", () => soapEnviDe(nuevoDId(), xml), parsearRetEnviDe, false),

    async enviarDESeguro(xml) {
      const cdc = cdcDeXml(xml);
      const r = await cliente.enviarDE(xml);
      if (r.estado !== "error_red" || !r.consultarAntesDeReenviar) return r;
      const c = await cliente.consultarDE(cdc);
      if (c.estado === "aprobado") {
        return { ...c, mensaje: `Aprobado (confirmado por consulta tras corte de red): ${c.mensaje ?? ""}`.trim() };
      }
      if (c.existe === false) {
        // 0420: no existe o fue rechazado → reenviar es seguro (un solo reintento).
        const r2 = await cliente.enviarDE(xml);
        return r2;
      }
      return { ...r, mensaje: `${r.mensaje} | La consulta del CDC tampoco fue concluyente: ${c.mensaje ?? c.estado}` };
    },

    enviarLote: (xmls) => llamar("recibeLote", () => soapEnvioLote(nuevoDId(), xmls), parsearResEnviLoteDe, false),

    consultarLote: (protocolo) => llamar("consultaLote", () => soapConsLote(nuevoDId(), protocolo), parsearResEnviConsLoteDe, true),

    consultarDE: (cdc) => llamar("consulta", () => soapConsDE(nuevoDId(), cdc), parsearConsDE, true),

    enviarEvento: (xml) => llamar("evento", () => soapEvento(nuevoDId(), xml), parsearRetEnviEventoDe, false),

    consultarRuc: (ruc) => llamar("consultaRuc", () => soapConsRuc(nuevoDId(), ruc), parsearConsRuc, true),
  };
  return cliente;
}

/** Atajo: cliente desde CredencialesSifen (ambiente + guardia) y transporte desde env (o el que se pase). */
export function clienteDesdeCredenciales(
  cred: CredencialesSifen,
  transporte?: Transporte,
  extra: Partial<Omit<OpcionesCliente, "ambiente" | "produccionAutorizada" | "transporte">> = {},
): ClienteSifen {
  // La guardia va primero: ni siquiera se abre el certificado/cliente HTTP si prod no está autorizada.
  verificarAutorizacionProduccion(cred.ambiente, cred.produccionAutorizada);
  return crearClienteSifen({
    ambiente: cred.ambiente,
    produccionAutorizada: cred.produccionAutorizada,
    transporte: transporte ?? transporteDesdeEnv(cred),
    ...extra,
  });
}
