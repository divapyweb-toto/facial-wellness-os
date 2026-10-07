-- Cron de la auditoría diaria del vendedor (ola 2, G3) · 06-10-2026
-- auditoria-diaria revisa las conversaciones del día anterior (reglas + Haiku por Batch API) y manda
-- a Telegram solo las que tienen algo raro.
--
-- Horario: 7:30 de Asunción. Paraguay está en UTC-3 todo el año desde octubre de 2024 (ley de huso horario permanente,
-- sin horario de verano) y pg_cron de Supabase corre en UTC → 10:30 UTC.
-- Reintentos: cada 20 min de 11:10 a 13:50 UTC (8:10 a 10:50 de Asunción). Solo hacen algo si el lote
-- de Haiku quedó pendiente o si el aviso falló; si el día ya se informó, la función sale sin hacer nada.
-- Si Paraguay vuelve a cambiar de huso, ajustar las horas de abajo.
--
-- Usa public.invocar_edge_function() de 20261006000003_crons.sql (URL y service role desde Vault).
-- Idempotente: si los jobs existen, se borran y se vuelven a crear.

create extension if not exists pg_cron;

do $$
declare
  j text;
begin
  foreach j in array array['vendedor-auditoria-diaria', 'vendedor-auditoria-reintento'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end;
$$;

select cron.schedule('vendedor-auditoria-diaria',   '30 10 * * *',          $$select public.invocar_edge_function('auditoria-diaria')$$);
select cron.schedule('vendedor-auditoria-reintento', '10,30,50 11-13 * * *', $$select public.invocar_edge_function('auditoria-diaria')$$);
