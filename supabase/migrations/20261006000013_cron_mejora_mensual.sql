-- Ciclo mensual de mejora del vendedor (M3) · 06-10-2026
-- 1) Cron de la Edge Function mejora-mensual.
--    Día 1 a las 12:00 UTC = 09:00 de Asunción (Paraguay está en UTC-3 todo el año desde
--    octubre de 2024, sin horario de verano; pg_cron de Supabase corre en UTC).
--    Reintentos cada 30 min (a los :15 y :45, para no pisarse con la corrida principal)
--    del día 1 desde las 12:15 UTC hasta el día 3: el Batch de Haiku tarda, y cada corrida
--    sigue el ciclo desde el paso donde quedó. Si el ciclo ya está en un estado final
--    (esperando_aprobacion, aplicado, descartado, sin_datos_suficientes, error), la función
--    sale sin hacer nada. Además la función solo ARRANCA un ciclo nuevo del 1 (desde las
--    9:00 de Asunción) al 3, así que una corrida fuera de fecha no hace nada.
--    Usa public.invocar_edge_function() de 20261006000003_crons.sql: URL y service role desde
--    Vault (project_url, service_role_key). La función acepta SOLO la service role
--    (_shared/auth_servicio.ts). Si Paraguay vuelve a cambiar de huso, ajustar las horas.
-- 2) public.mejora_activar_version(): activa una versión del vendedor en UNA transacción
--    (la activa pasa a 'archivada'), para el botón "Aplicar" y "Volver a la versión N" de
--    Telegram. Solo la puede ejecutar la service role.
--
-- Depende de 20261006000012_mejora_mensual.sql (tabla vendedor_versiones, dueño M1).
-- Idempotente: jobs y función se borran/reemplazan al re-aplicar.

create extension if not exists pg_cron;

create or replace function public.mejora_activar_version(p_version_id uuid, p_permitidos text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
  v_anterior int;
begin
  -- Un solo cambio de versión a la vez (dos toques simultáneos no se cruzan).
  perform pg_advisory_xact_lock(hashtext('mejora_activar_version'));

  select id, numero, estado into v from public.vendedor_versiones where id = p_version_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'la versión no existe');
  end if;
  if v.estado = 'activa' then
    return jsonb_build_object('ok', true, 'ya_activa', true, 'numero', v.numero, 'anterior', null);
  end if;
  if not (v.estado = any(coalesce(p_permitidos, array[]::text[]))) then
    return jsonb_build_object('ok', false, 'error', format('la versión %s está %s', v.numero, v.estado));
  end if;

  select numero into v_anterior from public.vendedor_versiones where estado = 'activa' limit 1;
  -- Primero se archiva la activa (índice único parcial: una sola 'activa').
  update public.vendedor_versiones set estado = 'archivada' where estado = 'activa';
  update public.vendedor_versiones set estado = 'activa', activada_en = now() where id = p_version_id;

  return jsonb_build_object('ok', true, 'ya_activa', false, 'numero', v.numero, 'anterior', v_anterior);
end;
$$;

revoke all on function public.mejora_activar_version(uuid, text[]) from public;
revoke all on function public.mejora_activar_version(uuid, text[]) from anon, authenticated;
grant execute on function public.mejora_activar_version(uuid, text[]) to service_role;

do $$
declare
  j text;
begin
  foreach j in array array['vendedor-mejora-mensual', 'vendedor-mejora-reintento-d1', 'vendedor-mejora-reintento-d2-3'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end;
$$;

select cron.schedule('vendedor-mejora-mensual',        '0 12 1 * *',          $$select public.invocar_edge_function('mejora-mensual')$$);
select cron.schedule('vendedor-mejora-reintento-d1',   '15,45 12-23 1 * *',   $$select public.invocar_edge_function('mejora-mensual')$$);
select cron.schedule('vendedor-mejora-reintento-d2-3', '15,45 * 2-3 * *',     $$select public.invocar_edge_function('mejora-mensual')$$);
