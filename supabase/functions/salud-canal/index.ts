// salud-canal · Dueño: D (Telegram)
// Chequeo "canal sordo". La llama un cron cada 15 min (pg_cron + pg_net, con la
// service role en el header Authorization; verify_jwt queda activo).
import { db } from "../_shared/db.ts";
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { avisar } from "../_shared/telegram.ts";
import {
  avisoSalud,
  type EstadoAvisos,
  evaluarSalud,
  extraerEventosCalidad,
  type HorarioCfg,
  leerCfgSalud,
} from "./salud.ts";

const HORA = 3_600_000;

async function config(clave: string): Promise<unknown> {
  const { data, error } = await db().from("config_wa").select("valor").eq("clave", clave).maybeSingle();
  if (error) throw new Error(`config_wa.${clave}: ${error.message}`);
  return data?.valor ?? null;
}

async function chequear() {
  const ahora = new Date();
  const [horarioV, cfgV, estadoV] = await Promise.all([
    config("horario_marketing"),
    config("salud_canal"),
    config("salud_ultimo_aviso"),
  ]);
  const h = (horarioV ?? {}) as Partial<HorarioCfg>;
  // El contrato fija 8 a 21 h; si config_wa.horario_marketing existe, manda ese.
  const horario: HorarioCfg = {
    desde: typeof h.desde === "number" ? h.desde : 8,
    hasta: typeof h.hasta === "number" ? h.hasta : 21,
  };
  const estado = (estadoV ?? {}) as EstadoAvisos;

  const ultima = await db()
    .from("wa_mensajes")
    .select("creado_en")
    .eq("direccion", "in")
    .order("creado_en", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ultima.error) throw new Error(`wa_mensajes entrantes: ${ultima.error.message}`);

  const fallidos = await db()
    .from("wa_mensajes")
    .select("id", { count: "exact", head: true })
    .eq("direccion", "out")
    .eq("estado", "fallido")
    .gte("creado_en", new Date(ahora.getTime() - HORA).toISOString());
  if (fallidos.error) throw new Error(`wa_mensajes fallidos: ${fallidos.error.message}`);

  // Webhooks de calidad que guarda wa-webhook: se excluyen mensajes (msg:) y estados (st:)
  // para no traer miles de filas; el resto se filtra por payload en salud.ts.
  const crudos = await db()
    .from("eventos_crudos")
    .select("id, recibido_en, payload")
    .eq("fuente", "whatsapp")
    .gt("id", estado.ultimo_evento_calidad_id ?? 0)
    .gte("recibido_en", new Date(ahora.getTime() - 48 * HORA).toISOString())
    .not("id_externo", "like", "msg:%")
    .not("id_externo", "like", "st:%")
    .order("id", { ascending: true })
    .limit(200);
  if (crudos.error) throw new Error(`eventos_crudos: ${crudos.error.message}`);

  const r = evaluarSalud({
    ahora,
    horario,
    cfg: leerCfgSalud(cfgV),
    ultimaEntrada: ultima.data?.creado_en ?? null,
    fallidosUltimaHora: fallidos.count ?? 0,
    eventosCalidad: extraerEventosCalidad(crudos.data ?? []),
    estado,
  });
  if (!r.motivos.length) return { enHorario: r.enHorario, avisos: [] as string[] };

  const a = avisoSalud(r.motivos);
  const env = await avisar(a.texto, a.botones);
  if (!env.ok) throw new Error(`Telegram: ${env.error}`); // no se guarda el estado → reintenta en 15 min

  const g = await db().from("config_wa").upsert({ clave: "salud_ultimo_aviso", valor: r.nuevoEstado });
  if (g.error) throw new Error(`guardar salud_ultimo_aviso: ${g.error.message}`);
  return { enHorario: true, avisos: r.motivos.map((m) => m.clave) };
}

Deno.serve(conServiceRole(async () => {
  try {
    const r = await chequear();
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("salud-canal:", msg);
    // Si falla el propio chequeo, también es una señal: se intenta avisar.
    await avisar(`<b>Atención: el chequeo de salud del canal falló</b>\n${msg.replace(/[<>&]/g, " ")}`).catch(() => {});
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}));
