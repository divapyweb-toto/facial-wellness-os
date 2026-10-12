-- 20261012000002 · Cron pedidos-trabados cada 10 minutos (12-10-2026, aprobado por Enrique).
-- Corrige en Shopify lo que no coincide con Voltra OS: etiqueta CONFIRMADO, cancelados por el cliente (2 h de margen)
-- y FALTAN_DATOS (sin calle ni pin GPS). Cada acción una sola vez por pedido (candados auto_* en eventos_crudos).
select cron.unschedule('pedidos-trabados') where exists (select 1 from cron.job where jobname = 'pedidos-trabados');
select cron.schedule('pedidos-trabados', '3-59/10 * * * *', $$select public.invocar_edge_function('pedidos-trabados')$$);
