-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN OLA 1 — WHATSAPP POST-VENTA (VOLTRA) · 06-10-2026
-- ═══════════════════════════════════════════════════════════
-- Fuente única: supabase/CONTRATO-OLA1.md
--
-- Qué hace:
--   1. Crea las tablas nuevas del canal de WhatsApp (wa_*, eventos_crudos,
--      shopify_pedidos, pedido_estados, envios_programados, courier_revision,
--      config_wa) con RLS: `authenticated` lee y escribe; el service role
--      (Edge Functions) pasa por encima de RLS.
--   2. Agrega la columna `tienda` ('fw' | 'voltra', default 'fw') a las 7
--      tablas existentes. Las filas actuales quedan como 'fw'.
--   3. Publica wa_mensajes y wa_conversaciones en Realtime (bandeja en vivo).
--   4. Crea el bucket privado `wa-media` (audios/imágenes de clientes).
--
-- NO borra nada. NO modifica filas existentes. Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════

BEGIN;

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ─── 0. Función para mantener `actualizado_en` ──────────────
create or replace function public.wa_tocar_actualizado_en()
returns trigger
language plpgsql
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

-- ─── 1. Clientes de WhatsApp ────────────────────────────────
-- Un cliente puede llegar solo con BSUID (usuario sin número visible) o solo
-- con teléfono; por eso ambos son únicos pero opcionales.
create table if not exists public.wa_clientes (
  id              uuid primary key default gen_random_uuid(),
  wa_user_id      text unique,                       -- BSUID de Meta
  telefono        text unique
                  check (telefono is null or telefono ~ '^\+5959[0-9]{8}$'),
  wa_username     text,
  nombre          text,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

create or replace trigger wa_clientes_actualizado_en
  before update on public.wa_clientes
  for each row execute function public.wa_tocar_actualizado_en();

-- ─── 2. Consentimientos ─────────────────────────────────────
-- Historial: el estado vigente es la fila más reciente por (cliente, tipo).
create table if not exists public.wa_consentimientos (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.wa_clientes(id) on delete cascade,
  tipo        text not null check (tipo in ('utilidad','marketing')),
  estado      text not null check (estado in ('si','no','baja')),
  origen      text check (origen in ('releasit','chat','boton')),
  creado_en   timestamptz not null default now()
);
create index if not exists wa_consentimientos_cliente_tipo_idx
  on public.wa_consentimientos (cliente_id, tipo, creado_en desc);

-- ─── 3. Conversaciones ──────────────────────────────────────
create table if not exists public.wa_conversaciones (
  id                  uuid primary key default gen_random_uuid(),
  cliente_id          uuid not null references public.wa_clientes(id) on delete cascade,
  estado              text not null default 'ia' check (estado in ('ia','humano','cerrada')),
  asignado_a          text,
  ultima_entrada_en   timestamptz,       -- último mensaje entrante (ventana de 24 h)
  origen_anuncio_id   text,              -- anuncio click-to-WhatsApp, si vino de uno
  creado_en           timestamptz not null default now()
);
create index if not exists wa_conversaciones_cliente_idx
  on public.wa_conversaciones (cliente_id);
create index if not exists wa_conversaciones_bandeja_idx
  on public.wa_conversaciones (estado, ultima_entrada_en desc);

-- ─── 4. Mensajes ────────────────────────────────────────────
create table if not exists public.wa_mensajes (
  id                uuid primary key default gen_random_uuid(),
  conversacion_id   uuid references public.wa_conversaciones(id) on delete cascade,
  cliente_id        uuid references public.wa_clientes(id) on delete cascade,
  direccion         text not null check (direccion in ('in','out')),
  wa_message_id     text unique,
  tipo              text,
  texto             text,
  contenido         jsonb,
  estado            text check (estado in ('recibido','enviado','entregado','leido','fallido')),
  categoria_precio  text,
  costo_usd         numeric,
  error             jsonb,
  creado_en         timestamptz not null default now()
);
create index if not exists wa_mensajes_conversacion_idx
  on public.wa_mensajes (conversacion_id, creado_en desc);
create index if not exists wa_mensajes_cliente_idx
  on public.wa_mensajes (cliente_id, creado_en desc);
create index if not exists wa_mensajes_entrantes_idx
  on public.wa_mensajes (creado_en desc) where direccion = 'in';
create index if not exists wa_mensajes_fallidos_idx
  on public.wa_mensajes (creado_en desc) where estado = 'fallido';

-- ─── 5. Eventos crudos (webhooks tal cual llegaron) ─────────
-- Se guardan ANTES de procesar. unique(fuente, id_externo) descarta repetidos.
create table if not exists public.eventos_crudos (
  id            bigserial primary key,
  fuente        text not null check (fuente in ('whatsapp','shopify','telegram','courier')),
  id_externo    text not null,
  payload       jsonb,
  recibido_en   timestamptz not null default now(),
  procesado_en  timestamptz,
  error         text,
  unique (fuente, id_externo)
);
create index if not exists eventos_crudos_pendientes_idx
  on public.eventos_crudos (recibido_en) where procesado_en is null;

-- ─── 6. Pedidos de Shopify (Voltra) ─────────────────────────
create table if not exists public.shopify_pedidos (
  shopify_order_id     bigint primary key,
  nombre               text,                 -- '#1001'
  cliente_id           uuid references public.wa_clientes(id) on delete set null,
  telefono             text,
  total                numeric,
  estado_confirmacion  text not null default 'pendiente'
                       check (estado_confirmacion in ('pendiente','confirmado','a_corregir',
                              'cancelado_cliente','retenido','cancelado_sin_respuesta')),
  estado_envio         text
                       check (estado_envio is null or estado_envio in ('EN_PREPARACION','DESPACHADO',
                              'INTENTO_FALLIDO','ENTREGADO','NO_ENTREGADO_RESCATABLE',
                              'NO_ENTREGADO','CANCELADO','RENDIDO')),
  courier              text,
  tags                 text[] not null default '{}',
  es_borrador          boolean not null default false,
  raw                  jsonb,
  creado_en            timestamptz not null default now(),
  actualizado_en       timestamptz not null default now()
);
create index if not exists shopify_pedidos_cliente_idx
  on public.shopify_pedidos (cliente_id);
create index if not exists shopify_pedidos_telefono_idx
  on public.shopify_pedidos (telefono);
create index if not exists shopify_pedidos_nombre_idx
  on public.shopify_pedidos (nombre);
create index if not exists shopify_pedidos_confirmacion_idx
  on public.shopify_pedidos (estado_confirmacion, creado_en desc);

create or replace trigger shopify_pedidos_actualizado_en
  before update on public.shopify_pedidos
  for each row execute function public.wa_tocar_actualizado_en();

-- ─── 7. Historial de estados por pedido ─────────────────────
-- unique(shopify_order_id, estado) = un aviso por cambio de estado.
create table if not exists public.pedido_estados (
  id                uuid primary key default gen_random_uuid(),
  shopify_order_id  bigint not null references public.shopify_pedidos(shopify_order_id) on delete cascade,
  estado            text not null,
  fuente            text,
  notificado        boolean not null default false,
  creado_en         timestamptz not null default now(),
  unique (shopify_order_id, estado)
);
create index if not exists pedido_estados_sin_notificar_idx
  on public.pedido_estados (creado_en) where notificado = false;

-- ─── 8. Envíos programados (cola de mensajes) ───────────────
create table if not exists public.envios_programados (
  id                uuid primary key default gen_random_uuid(),
  cliente_id        uuid references public.wa_clientes(id) on delete cascade,
  shopify_order_id  bigint,
  plantilla         text not null,
  variables         jsonb,
  categoria         text not null check (categoria in ('utilidad','marketing')),
  enviar_desde      timestamptz not null default now(),
  estado            text not null default 'pendiente'
                    check (estado in ('pendiente','enviado','cancelado','fallido')),
  clave_unica       text unique,
  intentos          int not null default 0,
  ultimo_error      text,
  creado_en         timestamptz not null default now()
);
create index if not exists envios_programados_vencidos_idx
  on public.envios_programados (enviar_desde) where estado = 'pendiente';
create index if not exists envios_programados_pedido_idx
  on public.envios_programados (shopify_order_id);
create index if not exists envios_programados_cliente_idx
  on public.envios_programados (cliente_id);

-- ─── 9. Filas de courier que no coincidieron ────────────────
create table if not exists public.courier_revision (
  id          uuid primary key default gen_random_uuid(),
  courier     text,
  referencia  text,
  fila        jsonb,
  motivo      text,
  resuelto    boolean not null default false,
  creado_en   timestamptz not null default now()
);
create index if not exists courier_revision_abiertas_idx
  on public.courier_revision (creado_en desc) where resuelto = false;

-- ─── 10. Configuración del canal (datos, no código) ─────────
create table if not exists public.config_wa (
  clave           text primary key,
  valor           jsonb not null,
  actualizado_en  timestamptz not null default now()
);

create or replace trigger config_wa_actualizado_en
  before update on public.config_wa
  for each row execute function public.wa_tocar_actualizado_en();

-- ─── 11. RLS: authenticated lee/escribe; service role pasa ──
do $$
declare
  t text;
begin
  foreach t in array array[
    'wa_clientes','wa_consentimientos','wa_conversaciones','wa_mensajes',
    'eventos_crudos','shopify_pedidos','pedido_estados','envios_programados',
    'courier_revision','config_wa'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = t || '_authenticated_todo'
    ) then
      execute format(
        'create policy %I on public.%I for all to authenticated using (true) with check (true)',
        t || '_authenticated_todo', t
      );
    end if;
  end loop;
end
$$;

grant usage, select on sequence public.eventos_crudos_id_seq to authenticated;

-- ─── 12. Columna `tienda` en las 7 tablas existentes ────────
-- Solo si la tabla existe (no inventa tablas). Las filas actuales → 'fw'.
do $$
declare
  t text;
begin
  foreach t in array array[
    'ventas','entregas','productos','gastos','campanas_ads','stock_movimientos','recompra_log'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format(
        'alter table public.%I add column if not exists tienda text not null default ''fw'' '
        || 'check (tienda in (''fw'',''voltra''))', t
      );
    else
      raise notice 'Tabla public.% no existe: no se agregó la columna tienda', t;
    end if;
  end loop;
end
$$;

-- ─── 13. Realtime: bandeja en vivo ──────────────────────────
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['wa_mensajes','wa_conversaciones'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  else
    raise notice 'No existe la publicación supabase_realtime: Realtime no se configuró';
  end if;
end
$$;

-- ─── 14. Storage: bucket privado wa-media ───────────────────
-- Las Edge Functions suben con service role. La bandeja (authenticated)
-- solo necesita leer para generar URLs firmadas.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('wa-media', 'wa-media', false)
    on conflict (id) do nothing;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname = 'wa_media_authenticated_leer'
    ) then
      create policy wa_media_authenticated_leer on storage.objects
        for select to authenticated
        using (bucket_id = 'wa-media');
    end if;
  else
    raise notice 'No existe storage.buckets: el bucket wa-media no se creó';
  end if;
end
$$;

COMMIT;
