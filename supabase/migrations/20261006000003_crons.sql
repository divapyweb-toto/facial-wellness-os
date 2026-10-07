-- Crons de la ola 1 (WhatsApp Voltra) · integración 06-10-2026
-- pg_cron dispara y pg_net hace el POST a cada Edge Function:
--   procesar-envios    cada minuto      (envios_programados vencidos)
--   salud-canal        cada 15 minutos  (canal sordo / fallidos / calidad del número)
--   shopify-conciliar  cada hora        (pedidos que el webhook no trajo)
--
-- NO hay valores en este archivo (el repo es público). La URL del proyecto y la
-- service role key se leen en cada ejecución desde Supabase Vault. Crearlos UNA vez
-- en el SQL Editor del panel de Supabase (los valores los pega Enrique):
--
--   select vault.create_secret('https://<ref-del-proyecto>.supabase.co', 'project_url');
--   select vault.create_secret('<service role key>', 'service_role_key');
--
-- Para cambiar un valor: select vault.update_secret(
--   (select id from vault.secrets where name = 'service_role_key'), '<nuevo valor>');
-- Para comprobar que existen (sin mostrar el valor):
--   select name from vault.decrypted_secrets where name in ('project_url','service_role_key');
--
-- Idempotente: si un job con el mismo nombre ya existe, se borra y se vuelve a crear.
-- Ver ejecuciones: select * from cron.job_run_details order by start_time desc limit 20;
-- Ver respuestas HTTP: select * from net._http_response order by created desc limit 20;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Helper: POST a una Edge Function con la service role (leída de Vault en cada llamada).
create or replace function public.invocar_edge_function(nombre text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault, net
as $$
declare
  url  text;
  clave text;
begin
  select decrypted_secret into url   from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into clave from vault.decrypted_secrets where name = 'service_role_key';
  if url is null or clave is null then
    raise exception 'Faltan los secretos de Vault project_url / service_role_key (ver 20261006000003_crons.sql)';
  end if;
  return net.http_post(
    url     := rtrim(url, '/') || '/functions/v1/' || nombre,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || clave
    ),
    body    := jsonb_build_object('origen', 'pg_cron'),
    timeout_milliseconds := 55000
  );
end;
$$;

-- Solo el dueño (postgres / pg_cron) la puede ejecutar; nunca desde la app.
revoke all on function public.invocar_edge_function(text) from public;
revoke all on function public.invocar_edge_function(text) from anon, authenticated;

-- Borrar los jobs si ya existen (re-aplicar la migración no los duplica).
do $$
declare
  j text;
begin
  foreach j in array array['wa-procesar-envios', 'wa-salud-canal', 'wa-shopify-conciliar'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end;
$$;

select cron.schedule('wa-procesar-envios',   '* * * * *',    $$select public.invocar_edge_function('procesar-envios')$$);
select cron.schedule('wa-salud-canal',       '*/15 * * * *', $$select public.invocar_edge_function('salud-canal')$$);
select cron.schedule('wa-shopify-conciliar', '0 * * * *',    $$select public.invocar_edge_function('shopify-conciliar')$$);
