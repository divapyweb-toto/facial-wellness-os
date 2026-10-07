-- Cotización diaria USD → guaraníes. La app la completa sola (fuente pública)
-- para cada día en que hubo gasto en dólares (WhatsApp API, Claude API); una
-- fila se puede corregir a mano con el cambio real que cobró el banco o la tarjeta.
create table if not exists public.tipo_cambio (
  fecha     date primary key,
  usd_pyg   numeric not null check (usd_pyg > 0),
  fuente    text not null default 'manual',
  creado_en timestamptz not null default now()
);
alter table public.tipo_cambio enable row level security;
drop policy if exists "tipo_cambio_authenticated_todo" on public.tipo_cambio;
create policy "tipo_cambio_authenticated_todo" on public.tipo_cambio
  for all to authenticated using (true) with check (true);
grant select, insert, update on public.tipo_cambio to authenticated;
