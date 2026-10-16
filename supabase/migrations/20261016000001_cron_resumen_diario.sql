-- 20261016000001 · Resumen diario por Telegram (función resumen-diario), pedido por Enrique el 16-10-2026.
-- Hora: 21:30 de Paraguay. Paraguay quedó en UTC−3 fijo (sin horario de verano) desde octubre de 2024,
-- así que 21:30 PY = 21:30 + 3 h = 00:30 UTC del día siguiente → '30 0 * * *'. La función toma el día en hora de
-- Paraguay (a esa hora todavía es el mismo día allá) y manda un solo mensaje por día (candado en eventos_crudos).
select cron.unschedule('voltra-resumen-diario') where exists (select 1 from cron.job where jobname = 'voltra-resumen-diario');
select cron.schedule('voltra-resumen-diario', '30 0 * * *', $$select public.invocar_edge_function('resumen-diario')$$);
