-- 20261124000002 · Cron proveedores-gmail cada 10 minutos (21-11-2026, decisión de Enrique: "GMAIL A PROVEEDORES DE DOY
-- GREENLIGHT 100% PERO DEBE SER 24-7 Y AUTOMATIZADO SIEMPRE QUE EL PRESUPUESTO PERMITA").
-- Lee la bandeja del Gmail de Voltra, responde a los proveedores con el agente y manda los primeros contactos en horario de
-- China. La función no hace nada mientras config.proveedores.activo sea false (interruptor, apagado hasta el OK de Enrique).
-- Minutos 6, 16, 26… para no pisarse con pedidos-trabados (3, 13, 23…).
-- VUELTA ATRÁS: select cron.unschedule('proveedores-gmail');
select cron.unschedule('proveedores-gmail') where exists (select 1 from cron.job where jobname = 'proveedores-gmail');
select cron.schedule('proveedores-gmail', '6-59/10 * * * *', $$select public.invocar_edge_function('proveedores-gmail')$$);
