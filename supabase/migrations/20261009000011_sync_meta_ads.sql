-- 20261009000011_sync_meta_ads.sql · Dueño: A2 (09-10-2026)
-- Gasto de Meta Ads desde el servidor (Edge Function sync-meta-ads), sin depender de la Mac.
-- Cron diario a las 10:00 de Asunción (UTC-3 fijo) = 13:00 UTC. Resincroniza los últimos 7 días cerrados.
-- Usa public.invocar_edge_function (20261006000003 + 20261007000014: service role + x-cron-secret de Vault).
-- No crea columnas: gasto_ads_diario ya tiene tienda (20261007000016) y el único (fecha, adset_id).
--
-- Requisito ANTES de que sirva: secreto de funciones META_ADS_TOKEN (usuario del sistema con ads_read y la
-- cuenta publicitaria asignada). Sin él usa META_CAPI_TOKEN, que hoy (09-10) NO tiene ads_read.
-- Config opcional (sin ella: solo Voltra act 1829928881223795, 7 días):
--   insert into public.config_wa (clave, valor) values ('sync_meta_ads',
--     '{"activo": true, "dias": 7, "cuentas": [{"id": "1829928881223795", "tienda": "voltra"}]}')
--   on conflict (clave) do update set valor = excluded.valor;
-- Desactivar: select cron.unschedule('sync-meta-ads');

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-meta-ads') then
    perform cron.unschedule('sync-meta-ads');
  end if;
end;
$$;

select cron.schedule('sync-meta-ads', '0 13 * * *', $$select public.invocar_edge_function('sync-meta-ads')$$);
