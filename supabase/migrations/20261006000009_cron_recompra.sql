-- Cron de recompra (ola 3 · H1) · 06-10-2026
-- Corre la Edge Function `recompra` una vez por día a las 9:00 de Asunción.
-- pg_cron usa UTC: Paraguay está en UTC−3 todo el año desde oct-2024 (hora fija), así que 9:00 = 12:00 UTC.
-- [VERIFICAR] Si Paraguay volviera a tener horario de verano, cambiar a '0 13 * * *' en esa época.
--
-- Usa public.invocar_edge_function (migración 20261006000003_crons.sql), que lee la URL y la
-- service role desde Vault (project_url, service_role_key). Sin valores en este archivo.
-- Idempotente: si el job existe, se borra y se vuelve a crear.

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'wa-recompra') then
    perform cron.unschedule('wa-recompra');
  end if;
end;
$$;

select cron.schedule('wa-recompra', '0 12 * * *', $$select public.invocar_edge_function('recompra')$$);
