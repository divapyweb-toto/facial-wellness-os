-- 20261019000001 · Libro de creativos (Enrique 19-10-2026). Diseño: reportes/sistema-creativos-por-producto.md §3, §6, §7.
-- creativos_diario: una fila por anuncio y día con lo que trae Meta (SOLO LECTURA de Meta, función creativos-diario).
create table if not exists public.creativos_diario (
  fecha date not null,
  ad_id text not null,
  ad_nombre text,
  adset_id text,
  adset_nombre text,
  campana_id text,
  campana_nombre text,
  canal text not null default 'web' check (canal in ('web', 'whatsapp')),
  gasto numeric not null default 0,
  impresiones integer not null default 0,
  clics integer not null default 0,            -- clics en el enlace
  ctr numeric,                                  -- CTR del enlace (%)
  visitas integer not null default 0,           -- vistas de la página de destino
  formularios integer not null default 0,       -- inicios de pago (formulario de Releasit abierto)
  compras integer not null default 0,           -- compras del pixel
  conversaciones integer not null default 0,    -- conversaciones de WhatsApp iniciadas
  actualizado_en timestamptz not null default now(),
  primary key (fecha, ad_id)
);
alter table public.creativos_diario enable row level security;
grant select on public.creativos_diario to authenticated;
grant all on public.creativos_diario to service_role;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'creativos_diario' and policyname = 'lectura_autenticados') then
    create policy lectura_autenticados on public.creativos_diario for select to authenticated using (true);
  end if;
end $$;
-- 06:00 Paraguay (UTC−3 fijo) = 09:00 UTC. Trae los últimos 3 días (Meta corrige números hacia atrás).
select cron.unschedule('creativos-diario') where exists (select 1 from cron.job where jobname = 'creativos-diario');
select cron.schedule('creativos-diario', '0 9 * * *', $$select public.invocar_edge_function('creativos-diario')$$);
