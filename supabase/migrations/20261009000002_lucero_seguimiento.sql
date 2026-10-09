-- 20261009000002_lucero_seguimiento.sql · Agente W · 09-10-2026
-- Seguimiento automático de Lucero (Edge Function lucero-seguimiento).
-- 1. entregas: cuándo se consultó por última vez la página pública de Lucero y qué falló (para rotar las
--    guías bajo el tope por corrida y poder auditar). El EnvioID ya vive en entregas.guia_transportadora
--    (lo escriben el export y la rendición de Lucero); no hace falta otra columna.
-- 2. Cron 3 veces por día: 09:00, 15:00 y 20:00 de Asunción (UTC-3 fijo) = 12, 18 y 23 UTC.
--    Usa public.invocar_edge_function (migraciones 20261006000003 y 20261007000014; URL y llaves en Vault).
-- Idempotente: se puede correr dos veces. No borra ni modifica datos existentes.

alter table public.entregas
  add column if not exists lucero_consultado_en timestamptz,
  add column if not exists lucero_web_error     text;

comment on column public.entregas.lucero_consultado_en is
  'Última consulta de envio.php?id=<guia_transportadora> por lucero-seguimiento';
comment on column public.entregas.lucero_web_error is
  'null = última consulta OK; si no: http_<n> | no_encontrado | sin_parsear:<motivo> | referencia_distinta | error_red:<msj>';

create index if not exists entregas_lucero_abiertas_idx
  on public.entregas (lucero_consultado_en nulls first)
  where transportadora = 'lucero' and guia_transportadora is not null;

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'lucero-seguimiento') then
    perform cron.unschedule('lucero-seguimiento');
  end if;
end;
$$;

select cron.schedule('lucero-seguimiento', '0 12,18,23 * * *', $$select public.invocar_edge_function('lucero-seguimiento')$$);
