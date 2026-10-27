-- 27-10 · Avisos: menos Telegram a Enrique ("por Telegram a mí se me escriba lo menos posible… solo cosas que 100% no puede hacer el sistema").
-- 1) avisos_admin: cola sin Telegram (destino 'admin') y avisos de Enrique para el resumen agrupado (destino 'resumen').
-- 2) telegram_enviados: registro de cada Telegram que sale (medición antes/después).
-- 3) config.telegram_politica: qué tipos van a Enrique (inmediato / resumen) y cuáles se descartan.
-- 4) config.lista_despacho + cron L-V 12:30 PY; cron del resumen 09:00 y 15:00 PY (UTC−3 fijo).
--
-- VUELTA ATRÁS (sin desplegar nada): update config set valor = 'todos' where clave = 'telegram_politica';
--   → todo vuelve a salir por Telegram como antes del 27-10.
-- Lista de despacho: update config set valor = '{"activo":false}' where clave = 'lista_despacho';
-- Quitar todo: select cron.unschedule('avisos-resumen'); select cron.unschedule('lista-despacho');
--   drop table public.avisos_admin; drop table public.telegram_enviados; delete from config where clave in ('telegram_politica','lista_despacho');

create table if not exists public.avisos_admin (
  id bigint generated always as identity primary key,
  tipo text not null,
  texto text not null,
  pedido text,
  clave text,
  destino text not null default 'admin' check (destino in ('admin', 'resumen')),
  creado_en timestamptz not null default now(),
  visto boolean not null default false,
  enviado_en timestamptz
);
create index if not exists avisos_admin_tipo_creado on public.avisos_admin (tipo, creado_en desc);
create index if not exists avisos_admin_resumen_pend on public.avisos_admin (creado_en) where destino = 'resumen' and enviado_en is null;

create table if not exists public.telegram_enviados (
  id bigint generated always as identity primary key,
  tipo text not null,
  ok boolean not null,
  error text,
  origen text not null default 'inmediato',
  pedido text,
  clave text,
  creado_en timestamptz not null default now()
);
create index if not exists telegram_enviados_tipo_creado on public.telegram_enviados (tipo, creado_en desc);

alter table public.avisos_admin enable row level security;
alter table public.telegram_enviados enable row level security;
do $$ begin
  create policy "Autenticados gestionan avisos_admin" on public.avisos_admin for all using (auth.uid() is not null) with check (auth.uid() is not null);
  create policy "Autenticados leen telegram_enviados" on public.telegram_enviados for select using (auth.uid() is not null);
exception when duplicate_object then null; end $$;

-- Política inicial (se completa en el archivo aparte 20261027000002, generado de _shared/telegram_tipos.ts).
insert into public.config (clave, valor) values ('lista_despacho', '{"activo":false}')
on conflict (clave) do nothing;

select cron.unschedule('avisos-resumen') where exists (select 1 from cron.job where jobname = 'avisos-resumen');
select cron.schedule('avisos-resumen', '0 12,18 * * *', $$select public.invocar_edge_function('avisos-resumen')$$);
select cron.unschedule('lista-despacho') where exists (select 1 from cron.job where jobname = 'lista-despacho');
select cron.schedule('lista-despacho', '30 15 * * 1-5', $$select public.invocar_edge_function('lista-despacho')$$);
