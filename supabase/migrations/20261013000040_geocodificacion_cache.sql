-- 13-10-2026: caché de pin → calle y ciudad (OpenStreetMap Nominatim) para el vendedor de WhatsApp.
-- Solo coordenadas redondeadas (5 decimales); sin datos del cliente. Lo escribe y lee la service role.
create table if not exists public.geocodificacion_cache (
  clave text primary key,          -- "lat,lng" con 5 decimales
  calle text,
  ciudad text,
  crudo jsonb,
  creado_en timestamptz not null default now()
);
alter table public.geocodificacion_cache enable row level security;
grant select, insert, update, delete on public.geocodificacion_cache to service_role;
