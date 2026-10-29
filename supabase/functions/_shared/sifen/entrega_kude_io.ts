// _shared/sifen/entrega_kude_io.ts · Deps reales de entrega_kude.ts (29-10-2026) · dueño: subagente B.
// WhatsApp (_shared/wa.ts), estado de plantilla en Meta (_shared/plantilla_meta.ts, caché 5 min en memoria),
// ventana de 24 h (wa_conversaciones.ultima_entrada_en, respaldo wa_mensajes 'in'), correo (_shared/correo.ts)
// y Telegram con el PDF (_shared/telegram.ts avisarConArchivo; si no se puede bajar el PDF, va el link).
//
// Uso (sifen-cola/io.ts, dentro de enviarKudeWhatsApp):
//   const d = datosEntregaKude(f, ped, await urlKude(f.kude_path));
//   return await entregarKudeReal(d, plantilla);   // → { ok, canal, intentos, error? }

import { db } from "../db.ts";
import { enviarDocumento, enviarPlantilla } from "../wa.ts";
import { estadoPlantilla } from "../plantilla_meta.ts";
import { avisar, avisarConArchivo } from "../telegram.ts";
import { normalizarTelefonoPY } from "../telefono.ts";
import { correoFactura, enviarCorreo } from "../correo.ts";
import {
  captionDocumentoKude,
  componentesPlantillaFactura,
  type DatosEntregaKude,
  type DepsEntregaKude,
  entregarKude,
  leyendaTelegramKude,
  nombreArchivoKude,
  PLANTILLA_FACTURA,
  type ResultadoEntregaKude,
  ventanaVigente,
} from "./entrega_kude.ts";

const CACHE_PLANTILLA_MS = 5 * 60_000;
const cachePlantilla = new Map<string, { aprobada: boolean; hasta: number }>();

/** Solo para tests. */
export function _limpiarCacheEntrega() {
  cachePlantilla.clear();
}

/** I/O que los tests pueden reemplazar. */
export interface EntornoEntregaKude {
  ahora: () => Date;
  fetch: typeof fetch;
  estadoPlantilla: (nombre: string) => Promise<{ estado: string | null; error?: string }>;
  /** ISO del último mensaje entrante del cliente con ese teléfono (+5959…), o null. */
  ultimaEntrada: (telefonoE164: string) => Promise<string | null>;
}

async function ultimaEntradaReal(tel: string): Promise<string | null> {
  const sb = db();
  const { data: cli, error } = await sb.from("wa_clientes").select("id").eq("telefono", tel).maybeSingle();
  if (error) throw new Error(`wa_clientes: ${error.message}`);
  if (!cli?.id) return null;
  const [conv, msj] = await Promise.all([
    sb.from("wa_conversaciones").select("ultima_entrada_en").eq("cliente_id", cli.id).not("ultima_entrada_en", "is", null)
      .order("ultima_entrada_en", { ascending: false }).limit(1).maybeSingle(),
    sb.from("wa_mensajes").select("creado_en").eq("cliente_id", cli.id).eq("direccion", "in")
      .order("creado_en", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (conv.error && msj.error) throw new Error(`ventana: ${conv.error.message}`);
  const a = (conv.data?.ultima_entrada_en as string | undefined) ?? null;
  const b = (msj.data?.creado_en as string | undefined) ?? null;
  if (!a || !b) return a ?? b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

const entornoReal: EntornoEntregaKude = {
  ahora: () => new Date(),
  fetch: (...a) => fetch(...a),
  estadoPlantilla: (n) => estadoPlantilla(n),
  ultimaEntrada: ultimaEntradaReal,
};

/** Deps reales. `plantilla`: nombre de la plantilla (config sifen.plantilla_factura). */
export function depsEntregaKude(plantilla = PLANTILLA_FACTURA, parcial: Partial<EntornoEntregaKude> = {}): DepsEntregaKude {
  const e = { ...entornoReal, ...parcial };
  return {
    async plantillaAprobada(nombre) {
      const c = cachePlantilla.get(nombre);
      if (c && c.hasta > Date.now()) return c.aprobada;
      const r = await e.estadoPlantilla(nombre);
      // Un error de red/credenciales no se guarda en caché: la próxima corrida vuelve a preguntar.
      if (r.error) throw new Error(r.error);
      const aprobada = r.estado === "APPROVED";
      cachePlantilla.set(nombre, { aprobada, hasta: Date.now() + CACHE_PLANTILLA_MS });
      return aprobada;
    },
    async ventanaAbierta(telefono) {
      const tel = normalizarTelefonoPY(telefono);
      if (!tel) return false;
      return ventanaVigente(await e.ultimaEntrada(tel), e.ahora());
    },
    async enviarPlantillaFactura(d) {
      const r = await enviarPlantilla(d.telefono ?? "", plantilla, "es", componentesPlantillaFactura(d));
      return { ok: r.ok, error: r.error };
    },
    async enviarDocumentoWa(d) {
      const r = await enviarDocumento(d.telefono ?? "", { link: d.pdfUrl, filename: nombreArchivoKude(d.numeroCompleto), caption: captionDocumentoKude(d) });
      return { ok: r.ok, error: r.error };
    },
    async enviarCorreo(d) {
      if (!d.email) return { ok: false, error: "sin email" };
      const c = correoFactura(d);
      return await enviarCorreo({
        para: d.email,
        asunto: c.asunto,
        texto: c.texto,
        html: c.html,
        // Resend baja el PDF de la URL firmada (vale 7 días); no hace falta cargarlo en memoria.
        adjuntos: [{ filename: nombreArchivoKude(d.numeroCompleto), path: d.pdfUrl }],
      }, { fetch: e.fetch });
    },
    async avisarTelegramConPdf(d, motivo) {
      const leyenda = leyendaTelegramKude(d, motivo);
      let bytes: Uint8Array | null = null;
      try {
        const r = await e.fetch(d.pdfUrl, { signal: AbortSignal.timeout(20_000) });
        if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
      } catch (err) {
        console.warn("KuDE para Telegram:", err instanceof Error ? err.message : err);
      }
      // Sin opts a propósito: este aviso es para que Enrique actúe, sale siempre por Telegram (no a la cola admin).
      const r = bytes?.byteLength
        ? await avisarConArchivo(leyenda, { bytes, mime: "application/pdf", nombre: nombreArchivoKude(d.numeroCompleto) })
        : await avisar(`${leyenda}\nNo se pudo adjuntar el PDF: <a href="${d.pdfUrl.replace(/"/g, "&quot;")}">bajarlo acá</a> (vale 7 días).`);
      return { ok: r.ok, error: r.error };
    },
  };
}

/** Atajo para sifen-cola/io.ts y sifen-reenviar: cadena completa con las Deps reales. Nunca tira excepción. */
export function entregarKudeReal(d: DatosEntregaKude, plantilla = PLANTILLA_FACTURA): Promise<ResultadoEntregaKude> {
  return entregarKude(d, depsEntregaKude(plantilla), plantilla);
}
