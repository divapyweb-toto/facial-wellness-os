// sifen-inutilizacion · I/O real para procesarInutilizacion (_shared/sifen/cola.ts).
import { db } from "../_shared/db.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { partesAsuncion } from "../_shared/horario.ts";
import type { TipoDE } from "../_shared/sifen/tipos.ts";
import { type DepsInutilizacion, type NumeroEnBase, procesarInutilizacion, type SerieNumeracion } from "../_shared/sifen/cola.ts";
import { claveTimbrado, construirEmisor, leerConfigSifen } from "../sifen-cola/io.ts";

export function mesAsuncion(iso: string): string {
  const p = partesAsuncion(new Date(iso));
  return `${p.anio}-${String(p.mes).padStart(2, "0")}`;
}

export async function ejecutarInutilizacion() {
  const cfg = await leerConfigSifen();
  if (!cfg.activo) return { accion: "bandera_apagada" };
  const sb = db();
  const e = await construirEmisor(cfg);
  if (e.emisor.nombre !== "propio") return { accion: "emisor_externo", detalle: "con FacturaSend la inutilización se hace en su panel" };
  const clave = claveTimbrado(e.timbrado, e.ambiente);
  const deps: DepsInutilizacion = {
    ahora: () => new Date(),
    cfg,
    emisor: e.emisor,
    mesDe: mesAsuncion,
    diaDelMes: (d) => partesAsuncion(d).dia,
    async series() {
      const { data, error } = await sb.from("sifen_numeracion").select("*").eq("timbrado", clave);
      if (error) throw new Error(`sifen_numeracion: ${error.message}`);
      return (data ?? []).map((s) => ({
        timbrado: e.timbrado,
        clave_timbrado: clave,
        establecimiento: s.establecimiento,
        punto: s.punto,
        tipo_documento: Number(s.tipo_documento) as TipoDE,
        ultimo: Number(s.ultimo),
      }));
    },
    async numerosDeSerie(s: SerieNumeracion): Promise<NumeroEnBase[]> {
      const { data, error } = await sb.from("facturas").select("numero,estado,fecha_emision,creado_en")
        .eq("ambiente", e.ambiente).eq("timbrado", s.timbrado).eq("establecimiento", s.establecimiento)
        .eq("punto", s.punto).eq("tipo_documento", s.tipo_documento).not("numero", "is", null);
      if (error) throw new Error(`facturas de la serie: ${error.message}`);
      return (data ?? []).map((f) => ({ numero: Number(f.numero), estado: f.estado, fecha: f.fecha_emision ?? f.creado_en }));
    },
    async eventosCubiertos(s) {
      const { data, error } = await sb.from("eventos_sifen").select("rango,estado").eq("tipo", "inutilizacion")
        .in("estado", ["pendiente", "enviado", "aprobado"]);
      if (error) throw new Error(`eventos_sifen: ${error.message}`);
      return (data ?? []).map((x) => x.rango as Record<string, unknown>)
        .filter((r) => r && r.timbrado === s.timbrado && r.establecimiento === s.establecimiento && r.punto === s.punto && Number(r.tipo) === s.tipo_documento)
        .map((r) => ({ desde: Number(r.desde), hasta: Number(r.hasta) }));
    },
    async registrarEvento(ev) {
      const { error } = await sb.from("eventos_sifen").insert(ev);
      if (error) throw new Error(`eventos_sifen: ${error.message}`);
    },
    async marcarInutilizadas(s, desde, hasta) {
      const { error } = await sb.from("facturas").update({ estado: "inutilizada", proximo_intento: null })
        .eq("ambiente", e.ambiente).eq("timbrado", s.timbrado).eq("establecimiento", s.establecimiento).eq("punto", s.punto)
        .eq("tipo_documento", s.tipo_documento).gte("numero", desde).lte("numero", hasta).in("estado", ["rechazada", "error"]);
      if (error) throw new Error(`marcar inutilizadas: ${error.message}`);
    },
    avisar: (t) => avisar(t),
    escapar: escaparHtml,
  };
  return { simulado: e.simulado, ambiente: e.ambiente, ...(await procesarInutilizacion(deps)) };
}
