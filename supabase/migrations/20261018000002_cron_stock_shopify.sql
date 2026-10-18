-- 20261018000002 · Sincronización del stock REAL a Shopify cada 10 minutos (Enrique 18-10-2026).
-- stock-shopify: stock_actual − pedidos válidos todavía no descontados en Despacho; activa el control de inventario.
-- Cubre entrada de lote, pedidos nuevos y devoluciones: todo cambia el stock real y se refleja en ≤ 10 min.
select cron.unschedule('stock-shopify') where exists (select 1 from cron.job where jobname = 'stock-shopify');
select cron.schedule('stock-shopify', '5-59/10 * * * *', $$select public.invocar_edge_function('stock-shopify')$$);
