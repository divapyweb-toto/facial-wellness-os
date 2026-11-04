-- 04-11 (Enrique): reclamos y coordinaciones de envíos ya despachados. El vendedor los guarda acá en vez de derivar a
-- Enrique; pedidos-trabados los junta y le manda un Telegram por courier, listo para reenviar (08:30 y 14:00, lun–sáb).
create table if not exists public.casos_courier (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  shopify_order_id bigint not null,
  ref text not null,
  courier text not null check (courier in ('lucero', 'pap')),
  origen text not null check (origen in ('bot', 'sistema')),
  tipo text not null check (tipo in ('reclamo', 'coordinar', 'no_encontrada', 'plazo')),
  pide text not null,
  horario text,
  referencia text,
  recibe text,
  urgente boolean not null default false,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'enviado', 'cerrado')),
  enviado_en timestamptz,
  lote text,
  cliente_id uuid,
  conversacion_id uuid
);
-- Un solo caso pendiente por pedido y origen: lo nuevo que diga el cliente se suma a ese.
create unique index if not exists casos_courier_pendiente_uno on public.casos_courier (shopify_order_id, origen) where estado = 'pendiente';
create index if not exists casos_courier_estado on public.casos_courier (estado, creado_en);
alter table public.casos_courier enable row level security; -- solo service role (funciones)
