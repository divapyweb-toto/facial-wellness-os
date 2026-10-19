// seguimiento-chat · Edge Function de cron (cada 10 min, migración 20261007000015). Solo service role / cron.
// Hasta 2 recontactos automáticos a clientes que dejaron en visto, dentro de la ventana de 24 h de WhatsApp.
// Config: config_wa.vendedor_seguimiento (semilla supabase/seed_seguimiento.sql). Lógica en logica.ts.
// Responde enseguida y procesa en segundo plano (cada turno del vendedor tarda varios segundos).
// Aviso por Telegram si algo falla (una vez por corrida).
// Además (08-10): aviso a Enrique cuando un cliente quedó listo para comprar y no mandó los datos (logica.ts,
// correrAvisosIntencion; sale de 7 a 24 h de Asunción, lo de la noche se junta a las 7).
// Además (08-10): recontacto el día que el cliente dijo que cobra (perfil_vendedor.recontactar_el;
// correrRecontactosCobro): escribe el bot si la ventana de 24 h sigue abierta, si no aviso a Enrique por Telegram.
// Además (12-10): toque 3, plantilla de oferta a quien vino de un anuncio y no compró, entre 48 y 70 h después de la
// primera respuesta del bot (toque3.ts; arranca apagado: config_wa.vendedor_seguimiento.toque3.activo).
// Además (13-10): rescate de datos, a quien tocó "Quiero …" y se calló ≥ 10 min sin terminar los datos el vendedor le
// pide solo lo que falta (rescate_datos.ts; a cualquier hora, dentro de las 24 h; rescate_datos_activo).
// Además (19-10, v35): derivaciones con plazo (derivaciones_plazo.ts): recordatorio a Enrique a las 2 y 8 h, a las 4 h
// hábiles el bot retoma (venta) o mensaje fijo (salud/reclamo), y nunca 24 h sin un mensaje al cliente. Un "Ok"/👌
// suelto al precio ya no frena los recontactos, y el aviso por una fecha prometida fuera de la ventana sale desde las 8.
import { conServiceRole } from "../_shared/auth_servicio.ts";
import { avisar } from "../_shared/telegram.ts";
import { escaparHtml } from "../_shared/telegram_formato.ts";
import { depsReales } from "./io.ts";
import { correrSeguimientos } from "./logica.ts";
import { pedirDatosFaltantes } from "./datos_faltantes.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve(conServiceRole(async () => {
  // 12-10: pedir la dirección a los pedidos que pedidos-trabados marcó FALTAN_DATOS (una vez por pedido).
  const datos = pedirDatosFaltantes()
    .then((r) => console.log("seguimiento-chat datos_faltantes", JSON.stringify(r)))
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      await avisar(`<b>Pedir datos faltantes: la corrida falló</b>\n${escaparHtml(msg.slice(0, 500))}`).catch(() => {});
    });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(datos);
  const tarea = correrSeguimientos(depsReales)
    .then((r) => console.log("seguimiento-chat", JSON.stringify(r)))
    .catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("seguimiento-chat:", msg);
      await avisar(`<b>Recontactos automáticos: la corrida falló</b>\n${escaparHtml(msg.slice(0, 500))}`).catch(() => {});
    });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(tarea);
  else await tarea;
  return Response.json({ ok: true, aceptado: true }, { status: 202 });
}));
