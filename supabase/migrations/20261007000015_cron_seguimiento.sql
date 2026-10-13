-- 20261007000015_cron_seguimiento.sql · 07-10-2026
-- Recontactos automáticos del vendedor (Edge Function seguimiento-chat): hasta 2 mensajes a clientes que dejaron
-- en visto, siempre dentro de la ventana de 24 h de WhatsApp (gratis, sin plantillas).
--   1. public.vendedor_marcar_seguimiento: guarda el contador y la fecha del último recontacto en
--      wa_conversaciones.perfil_vendedor (claves `seguimientos` y `ultimo_seguimiento_en`) con un merge atómico:
--      no pisa el resto del perfil (necesidad, producto, rechazo…). p_seguimientos <= 0 borra las dos claves.
--   2. Cron 'wa-seguimiento-chat' cada 10 minutos con public.invocar_edge_function (migraciones 0003 y 0014;
--      lee la URL y las llaves de Vault, sin valores en este archivo). La función decide sola el horario
--      (config_wa.vendedor_seguimiento, hora de Asunción) y si está activa.
-- NO borra nada. Se puede correr dos veces (el job se borra y se vuelve a crear).

create or replace function public.vendedor_marcar_seguimiento(p_conversacion uuid, p_seguimientos int, p_en timestamptz)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.wa_conversaciones
     set perfil_vendedor = case
           when coalesce(p_seguimientos, 0) <= 0
             then coalesce(perfil_vendedor, '{}'::jsonb) - 'seguimientos' - 'ultimo_seguimiento_en'
           else coalesce(perfil_vendedor, '{}'::jsonb)
                || jsonb_build_object('seguimientos', p_seguimientos)
                || case when p_en is null then '{}'::jsonb
                        else jsonb_build_object('ultimo_seguimiento_en', to_char(p_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end
         end
   where id = p_conversacion;
$$;

revoke all on function public.vendedor_marcar_seguimiento(uuid, int, timestamptz) from public, anon;
grant execute on function public.vendedor_marcar_seguimiento(uuid, int, timestamptz) to authenticated, service_role;

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'wa-seguimiento-chat') then
    perform cron.unschedule('wa-seguimiento-chat');
  end if;
end;
$$;

select cron.schedule('wa-seguimiento-chat', '*/10 * * * *', $$select public.invocar_edge_function('seguimiento-chat')$$);
