// proveedores-gmail/logica.ts · 21-11-2026. Reglas del canal Gmail con proveedores (contrato común:
// ~/Negocios/reportes/proveedores-automatico/CONTRATO.md). Todo con dependencias inyectadas (Deps): Gmail, el agente
// (_shared/proveedores/agente.ts) y la base (io.ts). Las pruebas usan versiones falsas: nunca Google ni la base real.
//
// Una corrida (cada 10 min):
//   1. Interruptor config.proveedores.activo apagado → no hace nada (salvo simular, que solo lee y no escribe ni manda).
//   2. Entrantes: bandeja de los últimos 2 días que no son nuestros. Es de proveedor si el remitente está en
//      pi_proveedores.email (no_contactar = false) o si el hilo ya tiene un mensaje nuestro. Lo demás no se toca.
//      Se guarda (RECEIVED; la idempotencia frena duplicados), responde el agente, y la respuesta sale en el mismo hilo.
//   3. Recordatorio: 48 h sin respuesta → uno solo; nunca más de 3 salientes seguidos sin respuesta.
//   4. Primeros contactos que carga administración: solo en horario de China (08–20 China = 21–09 Paraguay).
import { armarCorreo, armarRespuesta, adjuntosDe, base64url, type ClienteGmail, direccionDe, encabezado, extraerTexto, type MensajeGmail } from "./gmail.ts";

// ─── Tipos del agente (mismos campos que la interfaz FIJA de _shared/proveedores/agente.ts) ──────────────────
export type Idioma = "zh" | "en" | "es";
export interface ProveedorRef { id: string; nombre: string | null; idioma: Idioma | null; plataforma: string | null }
export interface CandidatoRef { id: string; nombre: string; ficha?: unknown }
export interface EntradaAgente {
  canal: "whatsapp" | "email";
  proveedor: ProveedorRef;
  candidato: CandidatoRef | null;
  texto: string;
  historial: Array<{ direccion: "in" | "out"; texto: string; traduccion?: string | null; creado_en: string }>;
  ahora: Date;
}
export interface Cotizacion {
  moneda: string; escalones: Array<{ cantidad: number; precio_unit_minor: number }>;
  moq?: number | null; peso_bruto_g?: number | null; medidas_caja_cm?: string | null; unidades_por_caja?: number | null;
  plazo_dias?: number | null; costo_muestra_minor?: number | null; incoterm?: string | null;
  completa: boolean;
}
export interface SalidaAgente {
  responder: boolean;
  texto: string | null;
  idioma: Idioma;
  traduccion_es: string | null;
  traduccion_entrante_es: string;
  frena: boolean;
  motivo: string | null;
  cotizacion: Cotizacion | null;
  costo_usd: number;
  modelo: string;
}
export interface ConfigProveedores { activo: boolean; tope_ia_usd_mes: number; tope_plantillas_mes: number; modelo: string; direccion_deposito: string | null; firma: string }

// ─── Lo que la lógica necesita de afuera ────────────────────────────────────
export interface ProveedorGmail extends ProveedorRef { email: string | null; no_contactar: boolean }
/** Mensaje de pi_mensajes (canal email), viejo → nuevo. */
export interface MensajeBase { id: string; direccion: "in" | "out"; estado: string; creado_en: string; candidato_id: string | null; proveedor_id: string | null; hilo: string | null }
export interface PrimerContacto { id: string; proveedor_id: string | null; candidato_id: string | null; asunto: string | null; original: string | null; traduccion: string | null }
export type TipoAviso = "proveedor_frena" | "proveedor_cotizacion" | "proveedor_tope_ia";
export interface FilaMensaje {
  canal: "email";
  direccion: "in" | "out";
  estado: "RECEIVED" | "DRAFT" | "AUTHORIZED";
  autor: "proveedor" | "agente";
  proveedor_id: string;
  candidato_id: string | null;
  politica_id: string | null; // null solo en entrantes (la base lo exige en salientes)
  idempotencia: string;
  id_externo: string | null;
  hilo: string | null;
  asunto: string | null;
  original: string | null;
  traduccion: string | null;
  idioma: Idioma | null;
  costo_usd: number | null;
}

export interface IoGmail {
  config(): Promise<ConfigProveedores>;
  idsYaGuardados(ids: string[]): Promise<Set<string>>;
  proveedorPorEmail(email: string): Promise<ProveedorGmail | null>;
  proveedorDeHilo(hilo: string): Promise<ProveedorGmail | null>; // dueño del hilo si tiene un mensaje nuestro
  proveedorPorId(id: string): Promise<ProveedorGmail | null>;
  candidatoDeHilo(hilo: string): Promise<CandidatoRef | null>;
  ultimoCandidatoDe(proveedorId: string): Promise<CandidatoRef | null>;
  candidatoPorId(id: string): Promise<CandidatoRef | null>;
  historialDe(proveedorId: string): Promise<EntradaAgente["historial"]>;
  mensajesDeHilo(hilo: string): Promise<MensajeBase[]>;
  mensajesDeProveedor(proveedorId: string): Promise<MensajeBase[]>;
  hilosConSalientes(): Promise<string[]>; // hilos de email con un saliente enviado en los últimos 14 días
  primerosContactosPendientes(): Promise<PrimerContacto[]>;
  permisoGeneralId(): Promise<string>;
  guardarMensaje(fila: FilaMensaje): Promise<string | null>; // null = la idempotencia ya existía (ya procesado)
  actualizarMensaje(id: string, cambios: Record<string, unknown>): Promise<void>;
  tomarParaEnviar(id: string): Promise<boolean>; // AUTHORIZED → SENDING solo si sigue AUTHORIZED
  cargarCotizacion(c: Cotizacion, ref: { candidatoId: string; proveedorId: string; mensajeId: string; canal: "email" }): Promise<void>;
  avisarAdministracion(texto: string, o: { tipo: TipoAviso; clave: string }): Promise<void>; // una vez por día por clave
}
export interface AgenteGmail {
  responder(e: EntradaAgente): Promise<SalidaAgente>;
  primerContacto(e: { canal: "email"; proveedor: ProveedorRef; candidato: CandidatoRef; pedido: string; ahora: Date }): Promise<SalidaAgente>;
  compromete(texto: string): string | null; // doble freno sobre el texto que sale
}
export interface Deps { gmail: ClienteGmail; agente: AgenteGmail; io: IoGmail; ahora: () => Date }

// ─── Reglas puras ───────────────────────────────────────────────────────────
export const CONSULTA_BANDEJA = "in:inbox newer_than:2d -from:me";
export const HORAS_RECORDATORIO = 48;
export const MAX_SEGUIDOS = 3;
export const MAX_ENVIOS_POR_CORRIDA = 20;

/** 08:00–20:00 en China (UTC+8, sin horario de verano) = 21:00–09:00 en Paraguay (UTC−3). */
export function enHorarioChina(d: Date): boolean {
  const h = (d.getUTCHours() + 8) % 24;
  return h >= 8 && h < 20;
}

const cuenta = (m: MensajeBase) => m.direccion === "in" || ["SENT_CONFIRMED", "SENDING", "SEND_UNKNOWN"].includes(m.estado);

/** Salientes (enviados o en camino) después del último entrante. */
export function salientesSeguidos(msgs: MensajeBase[]): number {
  let n = 0;
  for (const m of [...msgs].filter(cuenta).sort((a, b) => a.creado_en.localeCompare(b.creado_en))) n = m.direccion === "in" ? 0 : n + 1;
  return n;
}

/** Recordatorio: después del último entrante salió UN solo mensaje nuestro y pasaron 48 h. Uno solo; después, nada. */
export function tocaRecordatorio(msgsHilo: MensajeBase[], ahora: Date): MensajeBase | null {
  const v = [...msgsHilo].filter(cuenta).sort((a, b) => a.creado_en.localeCompare(b.creado_en));
  const ultimoIn = v.map((m) => m.direccion).lastIndexOf("in");
  const despues = v.slice(ultimoIn + 1);
  if (despues.length !== 1 || despues[0].estado !== "SENT_CONFIRMED") return null;
  return ahora.getTime() - Date.parse(despues[0].creado_en) >= HORAS_RECORDATORIO * 3_600_000 ? despues[0] : null;
}

/** Texto fijo del recordatorio (sin IA, sin costo), en el idioma del proveedor. */
export function textoRecordatorio(idioma: Idioma | null, firma: string): string {
  const t = idioma === "zh" ? "您好，跟进一下我上一封邮件，期待您的回复。谢谢！"
    : idioma === "es" ? "Hola, retomo mi mensaje anterior. Quedo atento a su respuesta. ¡Gracias!"
    : "Hello, just following up on my previous email. Looking forward to your reply. Thank you!";
  return `${t}\n\n${firma}`;
}

// ─── La corrida ─────────────────────────────────────────────────────────────
export interface Hecho { paso: "entrante" | "respuesta" | "recordatorio" | "primer_contacto"; accion: string; proveedor_id?: string; hilo?: string; mensaje_id?: string; estado?: string; motivo?: string; error?: string }
export interface Resultado { activo: boolean; simulado: boolean; revisados: number; ignorados: number; hechos: Hecho[]; error?: string }

const err = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function procesarCorrida(deps: Deps, opciones: { simular: boolean }): Promise<Resultado> {
  const { io, gmail, agente } = deps;
  const simular = opciones.simular;
  const cfg = await io.config();
  const res: Resultado = { activo: cfg.activo, simulado: simular, revisados: 0, ignorados: 0, hechos: [] };
  if (!cfg.activo && !simular) return res; // interruptor apagado: nada de nada
  const ahora = deps.ahora();
  const miCorreo = await gmail.perfil();
  let envios = 0;
  let politica: string | null = null;
  const politicaId = async () => politica ??= await io.permisoGeneralId();
  const avisar = (texto: string, tipo: TipoAviso, clave: string) =>
    simular ? Promise.resolve() : io.avisarAdministracion(texto, { tipo, clave }).catch((e) => console.warn("proveedores-gmail aviso:", err(e)));

  /** Saliente ya insertado AUTHORIZED: lo toma (SENDING), lo manda y deja SENT_CONFIRMED / FAILED / SEND_UNKNOWN. */
  async function mandar(id: string, raw: string, threadId: string | null): Promise<{ estado: string; error?: string; threadId?: string }> {
    if (!(await io.tomarParaEnviar(id))) return { estado: "YA_TOMADO" };
    envios++;
    const r = await gmail.enviar(raw, threadId);
    if (r.ok) {
      await io.actualizarMensaje(id, { estado: "SENT_CONFIRMED", id_externo: r.id, hilo: r.threadId || threadId });
      return { estado: "SENT_CONFIRMED", threadId: r.threadId };
    }
    const estado = r.seguro ? "FAILED" : "SEND_UNKNOWN";
    await io.actualizarMensaje(id, { estado });
    return { estado, error: r.error };
  }

  // ── 2. Entrantes ──
  const ids = await gmail.listar(CONSULTA_BANDEJA, 50);
  res.revisados = ids.length;
  const ya = await io.idsYaGuardados(ids);
  for (const id of ids) {
    if (ya.has(id)) continue;
    try {
      const meta = await gmail.leer(id, "metadata");
      const de = direccionDe(encabezado(meta.payload, "From"));
      if ((meta.labelIds ?? []).includes("SENT") || (miCorreo && de === miCorreo)) continue; // nuestro
      let prov = de ? await io.proveedorPorEmail(de) : null;
      if (!prov) prov = await io.proveedorDeHilo(meta.threadId);
      if (!prov || prov.no_contactar) { res.ignorados++; continue; } // no es proveedor (o no se le escribe): no se toca
      await procesarEntrante(id, meta.threadId, prov);
    } catch (e) {
      res.hechos.push({ paso: "entrante", accion: "error", mensaje_id: id, error: err(e) });
    }
  }

  async function procesarEntrante(id: string, hilo: string, prov: ProveedorGmail) {
    const msg: MensajeGmail = await gmail.leer(id, "full");
    const adjuntos = adjuntosDe(msg.payload);
    const texto = [extraerTexto(msg.payload), adjuntos.length ? `[adjuntos: ${adjuntos.join(", ")}]` : ""].filter(Boolean).join("\n\n");
    const asunto = encabezado(msg.payload, "Subject") || null;
    const candidato = (await io.candidatoDeHilo(hilo)) ?? (await io.ultimoCandidatoDe(prov.id));
    if (simular) {
      res.hechos.push({ paso: "entrante", accion: "respondería con el agente", proveedor_id: prov.id, hilo, mensaje_id: id });
      return;
    }
    const historial = await io.historialDe(prov.id);
    const idIn = await io.guardarMensaje({
      canal: "email", direccion: "in", estado: "RECEIVED", autor: "proveedor", proveedor_id: prov.id, candidato_id: candidato?.id ?? null,
      politica_id: null, idempotencia: `email:in:${id}`, id_externo: id, hilo, asunto, original: texto, traduccion: null, idioma: prov.idioma, costo_usd: null,
    });
    if (!idIn) return; // ya procesado por otra corrida
    res.hechos.push({ paso: "entrante", accion: "guardado", proveedor_id: prov.id, hilo, mensaje_id: idIn });

    let salida: SalidaAgente;
    try {
      salida = await agente.responder({ canal: "email", proveedor: prov, candidato, texto, historial, ahora });
    } catch (e) {
      await avisar(`⚠️ Proveedor por correo: el agente falló y no respondí (${err(e)}). Revisá el hilo en Importaciones.`, "proveedor_frena", `email:${hilo}`);
      res.hechos.push({ paso: "respuesta", accion: "agente falló", hilo, error: err(e) });
      return;
    }
    const traduccionIn = { traduccion: salida.traduccion_entrante_es, idioma: salida.idioma };

    if (salida.cotizacion && candidato) {
      await io.cargarCotizacion(salida.cotizacion, { candidatoId: candidato.id, proveedorId: prov.id, mensajeId: idIn, canal: "email" });
      if (salida.cotizacion.completa) {
        await avisar(resumenCotizacion(prov, candidato, salida.cotizacion), "proveedor_cotizacion", `email:cot:${idIn}`);
      }
    }
    // Doble freno sobre lo que saldría (aunque el agente diga que responde).
    const compromete = salida.responder && salida.texto ? agente.compromete(salida.texto) : null;
    const frena = salida.frena || !!compromete;
    const motivo = compromete ?? salida.motivo;
    if (frena) {
      const tope = motivo === "tope_ia";
      await avisar(tope
        ? "⛔ Proveedores: se llegó al tope de IA del mes. El agente dejó de responder solo."
        : `✋ Proveedor ${prov.nombre ?? ""} (correo) pide algo que confirma el dueño: ${motivo ?? "revisar"}. Lo ves en Importaciones.`,
        tope ? "proveedor_tope_ia" : "proveedor_frena", tope ? "tope_ia" : `email:${hilo}`);
    }
    const sale = salida.responder && !!salida.texto && !compromete;
    if (!sale) {
      await io.actualizarMensaje(idIn, { ...traduccionIn, costo_usd: salida.costo_usd });
      res.hechos.push({ paso: "respuesta", accion: "no responde", hilo, motivo: motivo ?? undefined });
      return;
    }
    await io.actualizarMensaje(idIn, traduccionIn);
    if (envios >= MAX_ENVIOS_POR_CORRIDA) {
      res.hechos.push({ paso: "respuesta", accion: "tope de envíos de la corrida", hilo });
      return;
    }
    const resp = armarRespuesta(msg, salida.texto!, miCorreo || null);
    const fila: FilaMensaje = {
      canal: "email", direccion: "out", estado: candidato ? "AUTHORIZED" : "DRAFT", autor: "agente", proveedor_id: prov.id,
      candidato_id: candidato?.id ?? null, politica_id: await politicaId(), idempotencia: `email:out:${hilo}:${id}:1`, id_externo: null,
      hilo, asunto: resp.asunto, original: salida.texto, traduccion: salida.traduccion_es, idioma: salida.idioma, costo_usd: salida.costo_usd,
    };
    const idOut = await io.guardarMensaje(fila);
    if (!idOut) return;
    if (!candidato) { // sin producto la base no deja autorizar: queda en borrador y avisa
      await avisar(`📝 Proveedor ${prov.nombre ?? ""} (correo): respuesta en borrador porque no sé de qué producto es. Asignale el producto en Importaciones.`, "proveedor_frena", `email:${hilo}`);
      res.hechos.push({ paso: "respuesta", accion: "borrador sin producto", hilo, mensaje_id: idOut, estado: "DRAFT" });
      return;
    }
    const r = await mandar(idOut, resp.raw, resp.threadId);
    res.hechos.push({ paso: "respuesta", accion: "respuesta", hilo, mensaje_id: idOut, estado: r.estado, ...(r.error ? { error: r.error } : {}) });
  }

  const china = enHorarioChina(ahora);

  // ── 3. Recordatorios (también en horario de China: es un mensaje que iniciamos nosotros) ──
  if (china) {
    for (const hilo of await io.hilosConSalientes()) {
      if (envios >= MAX_ENVIOS_POR_CORRIDA) break;
      try {
        const ultimo = tocaRecordatorio(await io.mensajesDeHilo(hilo), ahora);
        if (!ultimo?.proveedor_id || !ultimo.candidato_id) continue;
        const prov = await io.proveedorPorId(ultimo.proveedor_id);
        if (!prov || prov.no_contactar) continue;
        if (salientesSeguidos(await io.mensajesDeProveedor(prov.id)) >= MAX_SEGUIDOS) continue;
        if (simular) { res.hechos.push({ paso: "recordatorio", accion: "mandaría recordatorio", proveedor_id: prov.id, hilo }); continue; }
        const th = await gmail.hilo(hilo);
        const base = th.messages?.[th.messages.length - 1];
        if (!base) continue;
        const texto = textoRecordatorio(prov.idioma, cfg.firma);
        const resp = armarRespuesta({ ...base, threadId: hilo }, texto, miCorreo || null);
        const idOut = await io.guardarMensaje({
          canal: "email", direccion: "out", estado: "AUTHORIZED", autor: "agente", proveedor_id: prov.id, candidato_id: ultimo.candidato_id,
          politica_id: await politicaId(), idempotencia: `email:out:${hilo}:recordatorio:${ultimo.id}`, id_externo: null, hilo,
          asunto: resp.asunto, original: texto, traduccion: textoRecordatorio("es", cfg.firma), idioma: prov.idioma, costo_usd: 0,
        });
        if (!idOut) continue;
        const r = await mandar(idOut, resp.raw, hilo);
        res.hechos.push({ paso: "recordatorio", accion: "recordatorio", proveedor_id: prov.id, hilo, mensaje_id: idOut, estado: r.estado, ...(r.error ? { error: r.error } : {}) });
      } catch (e) {
        res.hechos.push({ paso: "recordatorio", accion: "error", hilo, error: err(e) });
      }
    }
  }

  // ── 4. Primeros contactos (solo 08–20 China) ──
  const pendientes = await io.primerosContactosPendientes();
  for (const pc of pendientes) {
    if (!china) { res.hechos.push({ paso: "primer_contacto", accion: "espera horario de China", mensaje_id: pc.id }); continue; }
    if (envios >= MAX_ENVIOS_POR_CORRIDA) break;
    try {
      await primerContacto(pc);
    } catch (e) {
      res.hechos.push({ paso: "primer_contacto", accion: "error", mensaje_id: pc.id, error: err(e) });
    }
  }

  async function primerContacto(pc: PrimerContacto) {
    const prov = pc.proveedor_id ? await io.proveedorPorId(pc.proveedor_id) : null;
    const cand = pc.candidato_id ? await io.candidatoPorId(pc.candidato_id) : null;
    const frenar = async (motivo: string) => {
      if (!simular) {
        await io.actualizarMensaje(pc.id, { estado: "DRAFT" });
        await avisar(`✋ Primer contacto por correo${prov?.nombre ? ` a ${prov.nombre}` : ""} no salió: ${motivo}. Quedó en borrador.`, motivo === "tope_ia" ? "proveedor_tope_ia" : "proveedor_frena", `email:primer:${pc.id}`);
      }
      res.hechos.push({ paso: "primer_contacto", accion: "frenado", mensaje_id: pc.id, motivo, estado: "DRAFT" });
    };
    if (!prov || !prov.email) return frenar("el proveedor no tiene correo");
    if (prov.no_contactar) return frenar("el proveedor está en 'no contactar'");
    if (!cand) return frenar("no tiene producto");
    if (salientesSeguidos(await io.mensajesDeProveedor(prov.id)) >= MAX_SEGUIDOS) return frenar("ya hay 3 mensajes seguidos sin respuesta");
    if (simular) { res.hechos.push({ paso: "primer_contacto", accion: "mandaría primer contacto", proveedor_id: prov.id, mensaje_id: pc.id }); return; }
    if (!(await io.tomarParaEnviar(pc.id))) return; // otra corrida lo tomó
    let texto = pc.original, cambios: Record<string, unknown> = {};
    if (!texto) {
      const s = await agente.primerContacto({ canal: "email", proveedor: prov, candidato: cand, pedido: pc.traduccion ?? "", ahora })
        .catch((e) => ({ responder: false, texto: null, frena: true, motivo: `el agente falló (${err(e)})`, costo_usd: 0, idioma: prov.idioma ?? "en", traduccion_es: null } as Partial<SalidaAgente> as SalidaAgente));
      cambios = { costo_usd: s.costo_usd, idioma: s.idioma };
      if (s.frena || !s.responder || !s.texto) { await io.actualizarMensaje(pc.id, cambios); return frenar(s.motivo ?? "el agente no lo redactó"); }
      texto = s.texto;
      cambios = { ...cambios, original: texto, traduccion: s.traduccion_es ?? pc.traduccion };
    }
    const compromete = agente.compromete(texto);
    if (compromete) { await io.actualizarMensaje(pc.id, cambios); return frenar(compromete); }
    if (Object.keys(cambios).length) await io.actualizarMensaje(pc.id, cambios);
    const raw = base64url(armarCorreo({ de: miCorreo || null, para: prov.email, asunto: pc.asunto || cand.nombre, texto }));
    envios++;
    const r = await gmail.enviar(raw, null);
    const estado = r.ok ? "SENT_CONFIRMED" : r.seguro ? "FAILED" : "SEND_UNKNOWN";
    await io.actualizarMensaje(pc.id, r.ok ? { estado, id_externo: r.id, hilo: r.threadId } : { estado });
    res.hechos.push({ paso: "primer_contacto", accion: "primer contacto", proveedor_id: prov.id, mensaje_id: pc.id, hilo: r.ok ? r.threadId : undefined, estado, ...(r.ok ? {} : { error: r.error }) });
  }

  return res;
}

/** Resumen de una cotización completa para administración (el costo puesto en Paraguay lo calcula Importaciones). */
export function resumenCotizacion(prov: ProveedorRef, cand: CandidatoRef, c: Cotizacion): string {
  const precio = (m: number) => c.moneda === "PYG" ? `₲${m.toLocaleString("es-PY")}` : `${(m / 100).toFixed(2)} ${c.moneda}`; // minor = centavos (PYG no tiene)
  const esc = c.escalones.map((e) => `${e.cantidad} u: ${precio(e.precio_unit_minor)}`).join(" · ");
  const extra = [
    c.peso_bruto_g != null ? `peso ${c.peso_bruto_g} g` : "",
    c.medidas_caja_cm ? `caja ${c.medidas_caja_cm} cm` : "",
    c.unidades_por_caja != null ? `${c.unidades_por_caja} u/caja` : "",
    c.plazo_dias != null ? `${c.plazo_dias} días` : "",
  ].filter(Boolean).join(" · ");
  return `💰 Cotización completa por correo: ${cand.nombre} (${prov.nombre ?? "proveedor"}). ${esc}${extra ? ` · ${extra}` : ""}. El costo puesto en Paraguay lo ves en Importaciones.`;
}
