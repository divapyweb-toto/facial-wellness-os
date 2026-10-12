-- 20261012000001 · Cron de eventos a Meta (dataset de mensajería), cada 10 minutos.
-- meta-lead-reenviar con body {origen:"pg_cron"}: LeadSubmitted pendiente de pedidos que vinieron de un anuncio de
-- WhatsApp (red de seguridad del envío en tiempo real de shopify-webhook) y Purchase de los pedidos CONFIRMADOS
-- (decisión de Enrique 12-10-2026). Cada pedido sale una sola vez por evento (candados en eventos_crudos).
select cron.unschedule('meta-eventos-mensajeria') where exists (select 1 from cron.job where jobname = 'meta-eventos-mensajeria');
select cron.schedule('meta-eventos-mensajeria', '*/10 * * * *', $$select public.invocar_edge_function('meta-lead-reenviar')$$);
