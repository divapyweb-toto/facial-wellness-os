// proveedores-gmail/io.ts · 21-11-2026. Arma las dependencias reales de logica.ts: Gmail (secretos GMAIL_*), el agente
// (_shared/proveedores/agente.ts) y la base. Lo común de las dos vías (WhatsApp y Gmail) sale de _shared/proveedores/io.ts;
// acá solo van las consultas propias del correo (hilos, recordatorios, primeros contactos).
import { db } from "../_shared/db.ts";
import * as comun from "../_shared/proveedores/io.ts";
import { redactarPrimerContacto, responderProveedor, textoCompromete } from "../_shared/proveedores/agente.ts";
import { crearClienteGmail, credencialesDesdeEntorno } from "./gmail.ts";
import type { AgenteGmail, Deps, IoGmail, MensajeBase, PrimerContacto, ProveedorGmail } from "./logica.ts";

type Obj = Record<string, unknown>;
const CAMPOS_MSG = "id,direccion,estado,creado_en,candidato_id,proveedor_id,hilo";

function proveedorDesde(f: Obj | null): ProveedorGmail | null {
  if (!f) return null;
  const idioma = ["zh", "en", "es"].includes(String(f.idioma)) ? f.idioma as ProveedorGmail["idioma"] : null;
  return {
    id: String(f.id),
    nombre: (f.nombre ?? f.razon_social_declarada ?? null) as string | null,
    idioma,
    plataforma: (f.plataforma ?? null) as string | null,
    email: (f.email ?? null) as string | null,
    no_contactar: f.no_contactar === true,
  };
}

function falla(donde: string, error: { message: string } | null) {
  if (error) throw new Error(`${donde}: ${error.message}`);
}

export const ioGmail: IoGmail = {
  config: () => comun.configProveedores(),
  async idsYaGuardados(ids) {
    if (!ids.length) return new Set();
    const { data, error } = await db().from("pi_mensajes").select("id_externo").eq("canal", "email").in("id_externo", ids);
    falla("pi_mensajes ids", error);
    return new Set((data ?? []).map((x: Obj) => String(x.id_externo)));
  },
  async proveedorPorEmail(email) {
    return proveedorDesde(await comun.proveedorPorEmail(email) as unknown as Obj | null);
  },
  async proveedorDeHilo(hilo) {
    const { data, error } = await db().from("pi_mensajes").select("proveedor_id").eq("canal", "email").eq("hilo", hilo)
      .eq("direccion", "out").not("proveedor_id", "is", null).limit(1);
    falla("pi_mensajes hilo", error);
    const pid = data?.[0]?.proveedor_id as string | undefined;
    return pid ? await ioGmail.proveedorPorId(pid) : null;
  },
  async proveedorPorId(id) {
    const { data, error } = await db().from("pi_proveedores").select("id,razon_social_declarada,idioma,plataforma,email,no_contactar").eq("id", id).maybeSingle();
    falla("pi_proveedores", error);
    return proveedorDesde(data as Obj | null);
  },
  candidatoDeHilo: (hilo) => comun.candidatoDeHilo(hilo),
  ultimoCandidatoDe: (pid) => comun.ultimoCandidatoDe(pid),
  async candidatoPorId(id) {
    const { data, error } = await db().from("pi_candidatos").select("id,nombre").eq("id", id).maybeSingle();
    falla("pi_candidatos", error);
    return data ? { id: String(data.id), nombre: String(data.nombre) } : null;
  },
  historialDe: (pid) => comun.historialDe(pid, 20),
  async mensajesDeHilo(hilo) {
    const { data, error } = await db().from("pi_mensajes").select(CAMPOS_MSG).eq("canal", "email").eq("hilo", hilo).order("creado_en", { ascending: true });
    falla("pi_mensajes hilo", error);
    return (data ?? []) as MensajeBase[];
  },
  async mensajesDeProveedor(pid) {
    // Todos los canales: "nunca más de 3 seguidos sin respuesta" vale para el proveedor, no para un canal.
    const { data, error } = await db().from("pi_mensajes").select(CAMPOS_MSG).eq("proveedor_id", pid).not("direccion", "is", null)
      .order("creado_en", { ascending: false }).limit(50);
    falla("pi_mensajes proveedor", error);
    return ((data ?? []) as MensajeBase[]).reverse();
  },
  async hilosConSalientes() {
    const desde = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString();
    const { data, error } = await db().from("pi_mensajes").select("hilo").eq("canal", "email").eq("direccion", "out")
      .eq("estado", "SENT_CONFIRMED").not("hilo", "is", null).gte("creado_en", desde).limit(500);
    falla("pi_mensajes hilos", error);
    return [...new Set((data ?? []).map((x: Obj) => String(x.hilo)))];
  },
  async primerosContactosPendientes() {
    const { data, error } = await db().from("pi_mensajes").select("id,proveedor_id,candidato_id,asunto,original,traduccion")
      .eq("canal", "email").eq("direccion", "out").eq("estado", "AUTHORIZED").eq("autor", "admin").is("hilo", null)
      .order("creado_en", { ascending: true }).limit(20);
    falla("pi_mensajes primeros contactos", error);
    return (data ?? []) as PrimerContacto[];
  },
  async permisoGeneralId() {
    const id = await comun.permisoGeneralId();
    if (!id) throw new Error("falta el permiso general para negociar (pi_politicas con candidato_id null)");
    return id;
  },
  guardarMensaje: (fila) => comun.guardarMensaje(fila),
  actualizarMensaje: (id, cambios) => comun.actualizarMensaje(id, cambios),
  async tomarParaEnviar(id) {
    // Solo si sigue AUTHORIZED (dos corridas juntas no mandan dos veces). El freno de la base revisa permiso y producto.
    const { data, error } = await db().from("pi_mensajes").update({ estado: "SENDING" }).eq("id", id).eq("estado", "AUTHORIZED").select("id");
    falla("pi_mensajes tomar", error);
    return (data?.length ?? 0) > 0;
  },
  async cargarCotizacion(c, ref) {
    await comun.cargarCotizacion(c, ref);
  },
  async avisarAdministracion(texto, o) {
    await comun.avisarAdministracion(texto, o);
  },
};

export const agenteGmail: AgenteGmail = {
  responder: (e) => responderProveedor(e, comun.depsAgenteReales),
  primerContacto: (e) => redactarPrimerContacto(e, comun.depsAgenteReales),
  compromete: (t) => textoCompromete(t),
};

/** Dependencias reales; null si faltan los secretos de Gmail. */
export function depsReales(): Deps | null {
  const cred = credencialesDesdeEntorno();
  if (!cred) return null;
  return { gmail: crearClienteGmail(cred), agente: agenteGmail, io: ioGmail, ahora: () => new Date() };
}
