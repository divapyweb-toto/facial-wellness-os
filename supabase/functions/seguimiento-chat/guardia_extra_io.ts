// seguimiento-chat/guardia_extra_io.ts · 26-10 (Enrique): guardia de las ofertas extra post-compra.
// Freno temprano en cada corrida (3+ cancelados entre las primeras 10 ofertas → se apaga ya). Además, una vez por día
// (desde las 8 de Asunción) mide cada oferta activa con fecha `desde` y, si empeoró (guardia_extra.ts),
// la apaga sola (config_wa.vendedor.ofertas_extra.<clave>.activo = false) y avisa por Telegram. La línea base son los
// 30 días antes de `desde`. Los pedidos de los últimos 2 días no cuentan todavía (la cancelación tarda en verse).
import { db } from "../_shared/db.ts";
import { partesAsuncion } from "../_shared/horario.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { type DatosGuardia, evaluarGuardia, frenoTemprano, guardiaDe, type ResultadoGuardia, type Tasa } from "../_shared/vendedor/guardia_extra.ts";

const DIA = 86_400_000;
type Fila = Record<string, unknown>;

async function todas(q: () => { range(a: number, b: number): PromiseLike<{ data: unknown; error: { message: string } | null }> }): Promise<Fila[]> {
  const out: Fila[] = [];
  for (let i = 0; i < 50_000; i += 1000) {
    const { data, error } = await q().range(i, i + 999);
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as Fila[];
    out.push(...filas);
    if (filas.length < 1000) break;
  }
  return out;
}

const tags = (p: Fila) => (p.tags as string[] | null) ?? [];
const cancelado = (p: Fila) => String(p.estado_confirmacion ?? "").startsWith("cancelado") || !!p.cancelado_en;
const reemplazado = (p: Fila) => tags(p).some((t) => t.startsWith("REEMPLAZADO_POR"));
const deWhatsApp = (p: Fila) => tags(p).includes("ORIGEN_WHATSAPP") && !tags(p).some((t) => /PRUEBA/.test(t));
const lleva = (p: Fila, re: RegExp) => ((p.lineas ?? []) as Array<{ title?: string }>).some((l) => re.test(String(l.title ?? "").toLowerCase()));

/** Pedidos de WhatsApp creados en [desde, hasta). */
const pedidosWa = async (desde: string, hasta: string) =>
  (await todas(() =>
    db().from("shopify_pedidos").select("shopify_order_id,nombre,cliente_id,estado_confirmacion,tags,creado_en,lineas:raw->line_items,cancelado_en:raw->>cancelled_at")
      .gte("creado_en", desde).lt("creado_en", hasta).eq("es_borrador", false)
  )).filter(deWhatsApp);

/** Títulos de las líneas → regex de `si_lleva` (que es sobre handles: "raspador" también aparece en el título). */
const reTitulo = (siLleva: string) => new RegExp(siLleva.replace(/-/g, " "));

export async function datosGuardia(o: { si_lleva: string; tag: string }, desdeOferta: Date, ahora: Date): Promise<DatosGuardia> {
  const iso = (d: Date) => d.toISOString();
  const baseDesde = new Date(desdeOferta.getTime() - 30 * DIA), hastaMedible = new Date(ahora.getTime() - 2 * DIA);
  const re = reTitulo(o.si_lleva);
  const [antes, despues, convAntes, convDespues] = await Promise.all([
    pedidosWa(iso(baseDesde), iso(new Date(desdeOferta.getTime() + 2 * DIA))),
    pedidosWa(iso(desdeOferta), iso(ahora)),
    todas(() => db().from("wa_conversaciones").select("cliente_id,creado_en").gte("creado_en", iso(baseDesde)).lt("creado_en", iso(new Date(desdeOferta.getTime() - 2 * DIA)))),
    todas(() => db().from("wa_conversaciones").select("cliente_id,creado_en").gte("creado_en", iso(desdeOferta)).lt("creado_en", iso(hastaMedible))),
  ]);
  // (a) conversaciones nuevas que terminan en un pedido vigente.
  const vigentes = (ps: Fila[]) => new Set(ps.filter((p) => !cancelado(p)).map((p) => p.cliente_id));
  const tasaConv = (cs: Fila[], set: Set<unknown>): Tasa => ({ si: cs.filter((c) => set.has(c.cliente_id)).length, n: cs.length });
  // (b) base: pedidos del producto antes de la oferta (sin los reemplazados); ahora: los que recibieron la oferta.
  const basePed = antes.filter((p) => Date.parse(String(p.creado_en)) < desdeOferta.getTime() && lleva(p, re) && !reemplazado(p));
  const mods = await todas(() =>
    db().from("wa_modificaciones_pedido").select("shopify_order_id,nuevo_order_id,estado,datos,creado_en")
      .gte("creado_en", iso(desdeOferta)).lt("creado_en", iso(hastaMedible))
  );
  const ofrecidos = mods.filter((m) => (m.datos as { oferta_extra?: string } | null)?.oferta_extra);
  const finales = ofrecidos.map((m) => Number(m.estado === "hecho" && m.nuevo_order_id ? m.nuevo_order_id : m.shopify_order_id));
  const porId = new Map(despues.map((p) => [Number(p.shopify_order_id), p]));
  const finalesPed = finales.map((id) => porId.get(id)).filter((p): p is Fila => !!p);
  // (c) entrega de los pedidos del producto desde la oferta: con el extra (tag) contra sin el extra.
  const ventas = await todas(() => db().from("ventas").select("n_referencia,estado").like("n_referencia", "VT-%").gte("created_at", iso(desdeOferta)).is("deleted_at", null));
  const estado = new Map(ventas.map((v) => [String(v.n_referencia), String(v.estado)]));
  const entrega = (ps: Fila[]): Tasa => {
    let si = 0, n = 0;
    for (const p of ps) {
      const e = estado.get(`VT-${String(p.nombre ?? "").replace("#", "")}`);
      if (e === "entregado") (si++, n++);
      else if (e === "devuelto" || e === "cancelado" || e === "perdido") n++;
    }
    return { si, n };
  };
  const delProducto = despues.filter((p) => lleva(p, re) && !reemplazado(p) && !cancelado(p));
  return {
    a: { base: tasaConv(convAntes, vigentes(antes)), ahora: tasaConv(convDespues, vigentes(despues)) },
    b: { base: { si: basePed.filter(cancelado).length, n: basePed.length }, ahora: { si: finalesPed.filter(cancelado).length, n: finalesPed.length } },
    c: { base: entrega(delProducto.filter((p) => !tags(p).includes(o.tag))), ahora: entrega(delProducto.filter((p) => tags(p).includes(o.tag))) },
  };
}

/**
 * 26-10 (Enrique): freno temprano. Las primeras `n` ofertas de esta clave (en orden de envío) → ¿su pedido final terminó
 * cancelado? (el reemplazado cuenta por el pedido nuevo). Sin esperar 2 días: apenas se cancela, cuenta.
 */
export async function canceladosPrimeras(clave: string, desdeOferta: Date, n: number): Promise<boolean[]> {
  const { data, error } = await db().from("wa_modificaciones_pedido").select("shopify_order_id,nuevo_order_id,estado,datos,creado_en")
    .gte("creado_en", desdeOferta.toISOString()).order("creado_en", { ascending: true }).limit(500);
  if (error) throw new Error(`wa_modificaciones_pedido: ${error.message}`);
  const ofertas = ((data ?? []) as Fila[]).filter((m) => (m.datos as { oferta_extra?: string } | null)?.oferta_extra === clave).slice(0, n);
  if (!ofertas.length) return [];
  const ids = ofertas.map((m) => Number(m.estado === "hecho" && m.nuevo_order_id ? m.nuevo_order_id : m.shopify_order_id));
  const { data: peds, error: e2 } = await db().from("shopify_pedidos").select("shopify_order_id,estado_confirmacion,tags,cancelado_en:raw->>cancelled_at").in("shopify_order_id", ids);
  if (e2) throw new Error(`shopify_pedidos: ${e2.message}`);
  const porId = new Map(((peds ?? []) as Fila[]).map((p) => [Number(p.shopify_order_id), p]));
  return ids.map((id) => {
    const p = porId.get(id);
    return !!p && cancelado(p) && !reemplazado(p);
  });
}

/** Apaga la oferta en config_wa.vendedor (relee la fila para no pisar otros cambios). */
async function apagarOferta(clave: string): Promise<void> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", "vendedor").single();
  if (error) throw new Error(`config_wa.vendedor: ${error.message}`);
  const v = (data?.valor ?? {}) as Record<string, unknown>;
  const ofertas = { ...((v.ofertas_extra ?? {}) as Record<string, Record<string, unknown>>) };
  if (!ofertas[clave]) return;
  ofertas[clave] = { ...ofertas[clave], activo: false, apagada_por_guardia: new Date().toISOString() };
  const u = await db().from("config_wa").update({ valor: { ...v, ofertas_extra: ofertas } }).eq("clave", "vendedor");
  if (u.error) throw new Error(`config_wa.vendedor (apagar ${clave}): ${u.error.message}`);
}

/** Una vez por día: mide cada oferta activa con `desde`; si empeoró, la apaga y avisa. */
export async function correrGuardiaExtra(ahora = new Date()): Promise<Record<string, ResultadoGuardia | string>> {
  const p = partesAsuncion(ahora);
  const fecha = `${p.anio}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
  const { data } = await db().from("config_wa").select("valor").eq("clave", "vendedor").maybeSingle();
  const v = (data?.valor ?? {}) as Record<string, unknown>;
  const ofertas = (v.ofertas_extra ?? {}) as Record<string, { activo?: boolean; desde?: string; si_lleva?: string; tag?: string }>;
  const activas = Object.entries(ofertas).filter(([, o]) => o?.activo === true && o.desde && o.si_lleva && o.tag);
  if (!activas.length) return {};
  const cfg = guardiaDe(v.guardia_extra);
  const out: Record<string, ResultadoGuardia | string> = {};
  // 26-10 (Enrique): freno temprano en CADA corrida (cada 10 min): 3+ cancelados entre las primeras 10 ofertas → se apaga ya.
  const quedan: typeof activas = [];
  for (const [clave, o] of activas) {
    try {
      const desde = new Date(`${o.desde}T03:00:00Z`);
      const f = frenoTemprano(await canceladosPrimeras(clave, desde, cfg.freno_primeras), cfg);
      if (!f.apagar) {
        quedan.push([clave, o]);
        continue;
      }
      await apagarOferta(clave);
      out[clave] = { apagar: true, motivos: [f.motivo!], detalle: [] };
      await avisar(`⚠️ <b>Oferta extra "${escaparHtml(clave)}" APAGADA sola</b>\n• ${escaparHtml(f.motivo!)}\n\nPara prenderla de nuevo: config_wa.vendedor.ofertas_extra.${escaparHtml(clave)}.activo = true.`);
    } catch (e) {
      quedan.push([clave, o]);
      console.warn(`guardia_extra: freno temprano de ${clave} falló:`, e instanceof Error ? e.message : e);
    }
  }
  if (p.hora < 8 || !quedan.length) return out;
  // Candado diario (eventos_crudos con id único): una sola corrida por día aunque el cron corra cada 10 min.
  const { error: ya } = await db().from("eventos_crudos").insert({ fuente: "shopify", id_externo: `guardia_extra:${fecha}`, payload: { fecha }, procesado_en: new Date().toISOString() });
  if (ya) return ya.code === "23505" ? out : { ...out, error: ya.message };
  for (const [clave, o] of quedan) {
    try {
      const desde = new Date(`${o.desde}T03:00:00Z`); // 00:00 de Asunción
      if (!Number.isFinite(desde.getTime())) throw new Error(`desde inválido: ${o.desde}`);
      const r = evaluarGuardia(await datosGuardia({ si_lleva: o.si_lleva!, tag: o.tag! }, desde, ahora), cfg);
      out[clave] = r;
      await db().from("eventos_crudos").update({ payload: { fecha, resultados: out } }).eq("id_externo", `guardia_extra:${fecha}`);
      if (r.apagar) {
        await apagarOferta(clave);
        await avisar(
          `⚠️ <b>Oferta extra "${escaparHtml(clave)}" APAGADA sola</b> (guardia del ${fecha})\n` +
            r.motivos.map((m) => `• ${escaparHtml(m)}`).join("\n") +
            `\n\n${r.detalle.map((d) => escaparHtml(d)).join("\n")}\n\nPara prenderla de nuevo: config_wa.vendedor.ofertas_extra.${escaparHtml(clave)}.activo = true.`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out[clave] = `error: ${msg}`;
      await avisar(`<b>Guardia de la oferta extra "${escaparHtml(clave)}": falló la medición</b>\n${escaparHtml(msg.slice(0, 400))}\nLa oferta sigue como estaba.`).catch(() => {});
    }
  }
  return out;
}
