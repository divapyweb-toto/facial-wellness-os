-- 20261007000014_cron_secret.sql · 07-10-2026
-- El cron recibía 401 ("solo service role"): la service role guardada en Vault no es idéntica a la que
-- Supabase inyecta en las funciones como SUPABASE_SERVICE_ROLE_KEY. Ninguna confirmación de pedido salía.
-- Arreglo sin aflojar el control: una llave propia del cron (Vault 'cron_secret' = secreto de funciones
-- CRON_SECRET) que viaja en el encabezado x-cron-secret. El Authorization sigue igual (lo exige verify_jwt).
-- Si 'cron_secret' no está en Vault, se comporta como antes.
create or replace function public.invocar_edge_function(nombre text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault, net
as $$
declare
  url    text;
  clave  text;
  secreto text;
begin
  select decrypted_secret into url     from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into clave   from vault.decrypted_secrets where name = 'service_role_key';
  select decrypted_secret into secreto from vault.decrypted_secrets where name = 'cron_secret';
  if url is null or clave is null then
    raise exception 'Faltan los secretos de Vault project_url / service_role_key (ver 20261006000003_crons.sql)';
  end if;
  return net.http_post(
    url     := rtrim(url, '/') || '/functions/v1/' || nombre,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || clave
    ) || case when secreto is not null then jsonb_build_object('x-cron-secret', secreto) else '{}'::jsonb end,
    body    := jsonb_build_object('origen', 'pg_cron'),
    timeout_milliseconds := 55000
  );
end;
$$;

revoke all on function public.invocar_edge_function(text) from public;
revoke all on function public.invocar_edge_function(text) from anon, authenticated;
