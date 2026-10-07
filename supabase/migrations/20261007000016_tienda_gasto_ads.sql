-- Agrega la tienda a gasto_ads_diario (Voltra y Facial Wellness tienen cuentas
-- de Meta distintas). Las filas actuales son de Facial Wellness → 'fw'.
-- Corre UNA vez en el SQL editor de Supabase; es seguro repetirla.
alter table public.gasto_ads_diario
  add column if not exists tienda text not null default 'fw'
  check (tienda in ('fw', 'voltra'));

create index if not exists gasto_ads_diario_tienda_fecha_idx
  on public.gasto_ads_diario (tienda, fecha);
