-- Ola 4 (I1) · factura electrónica, cobro QR y recuperación de borradores · 06-10-2026
-- Idempotente. Todo detrás de banderas en config_wa (ola4.factura, ola4.qr, ola4.recuperacion), apagadas en seed_ola4.sql.
-- Storage: la factura (PDF) se guarda en un bucket privado 'facturas' (se crea abajo).

-- ─── 1. facturas ─────────────────────────────────────────────
create table if not exists public.facturas (
  shopify_order_id  bigint primary key,
  estado            text not null default 'emitiendo' check (estado in ('revisar','emitiendo','emitida','error')),
  numero            integer unique,                 -- correlativo propio (lo reserva tomar_factura)
  numero_completo   text,                           -- 001-001-0000001
  tipo              text check (tipo in ('consumidor_final','ruc')),
  ruc               text,
  razon_social      text,
  cdc               text unique,                    -- código de control del DE (44 dígitos)
  pdf_url           text,                           -- URL firmada (vence); se renueva con pdf_path
  pdf_path          text,
  simulado          boolean not null default false,
  error             text,
  intentos          integer not null default 0,
  lease_hasta       timestamptz,                    -- bloqueo corto mientras una corrida emite
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);
create index if not exists facturas_estado_idx on public.facturas (estado);

-- Reserva atómica: un solo proceso emite por pedido y el número correlativo no se repite ni salta por carrera.
-- Devuelve (numero, tomada, estado, intentos). tomada=false si ya está emitida o la tiene otro (lease vigente).
create or replace function public.tomar_factura(p_order bigint, p_numero_inicial integer default 1, p_lease_min integer default 10)
returns table (numero integer, tomada boolean, estado text, intentos integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  f public.facturas%rowtype;
  n integer;
begin
  perform pg_advisory_xact_lock(hashtext('facturas_numero'));
  select * into f from public.facturas where shopify_order_id = p_order for update;
  if found then
    if f.estado = 'emitida' then
      return query select f.numero, false, f.estado, f.intentos; return;
    end if;
    if f.estado = 'emitiendo' and f.lease_hasta is not null and f.lease_hasta > now() then
      return query select f.numero, false, f.estado, f.intentos; return;
    end if;
    -- 'error', 'revisar' o lease vencido: se reintenta con el MISMO número si ya tenía uno.
    n := coalesce(f.numero, (select coalesce(max(x.numero), p_numero_inicial - 1) + 1 from public.facturas x));
    update public.facturas
       set estado = 'emitiendo', numero = n, intentos = f.intentos + 1,
           lease_hasta = now() + make_interval(mins => p_lease_min), actualizado_en = now()
     where shopify_order_id = p_order;
    return query select n, true, 'emitiendo'::text, f.intentos + 1; return;
  end if;
  select coalesce(max(x.numero), p_numero_inicial - 1) + 1 into n from public.facturas x;
  insert into public.facturas (shopify_order_id, estado, numero, intentos, lease_hasta)
  values (p_order, 'emitiendo', n, 1, now() + make_interval(mins => p_lease_min));
  return query select n, true, 'emitiendo'::text, 1;
end;
$$;
revoke all on function public.tomar_factura(bigint, integer, integer) from public, anon, authenticated;

-- ─── 2. cobros_qr (+ eventos crudos del proveedor) ───────────
create table if not exists public.cobros_qr (
  id                       uuid primary key default gen_random_uuid(),
  shopify_order_id         bigint not null,
  proveedor                text not null,           -- adamspay | arnipay | upay | simulado
  estado                   text not null default 'pendiente'
                             check (estado in ('pendiente','pagado','fallido','monto_distinto','vencido')),
  monto                    numeric not null,
  url                      text,
  qr_texto                 text,
  id_externo               text,                    -- docId (AdamsPay) / id del link (arnipay) / voltra-<id> (simulado)
  simulado                 boolean not null default false,
  vence_en                 timestamptz,
  pagado_en                timestamptz,
  monto_pagado             numeric,
  ultimo_estado_proveedor  text,
  creado_en                timestamptz not null default now()
);
-- Un solo cobro activo (pendiente) por pedido: evita QR dobles si el cliente toca dos veces.
create unique index if not exists cobros_qr_un_pendiente_por_pedido
  on public.cobros_qr (shopify_order_id) where estado = 'pendiente';
create index if not exists cobros_qr_externo_idx on public.cobros_qr (proveedor, id_externo);

create table if not exists public.cobros_qr_eventos (
  id            bigserial primary key,
  proveedor     text not null,
  id_evento     text not null,
  payload       jsonb,
  recibido_en   timestamptz not null default now(),
  procesado_en  timestamptz,
  error         text,
  unique (proveedor, id_evento)                     -- descarta reintentos del proveedor
);

-- ─── 3. recuperacion_borradores ──────────────────────────────
-- Una fila por borrador. La fila se crea ANTES de mandar (claim) → nunca dos mensajes al mismo borrador.
create table if not exists public.recuperacion_borradores (
  draft_id     bigint primary key,                  -- shopify_pedidos.shopify_order_id del borrador
  estado       text not null default 'enviando' check (estado in ('enviando','enviado','fallido')),
  cliente_id   uuid references public.wa_clientes(id) on delete set null,
  enviado_en   timestamptz,
  wa_message_id text,
  error        text,
  creado_en    timestamptz not null default now()
);

-- ─── 4. RLS (mismo patrón que las demás) y bucket privado ────
do $$
declare t text;
begin
  foreach t in array array['facturas','cobros_qr','cobros_qr_eventos','recuperacion_borradores'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if not exists (
      select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_authenticated_todo'
    ) then
      execute format(
        'create policy %I on public.%I for all to authenticated using (true) with check (true)',
        t || '_authenticated_todo', t);
    end if;
  end loop;
end;
$$;

insert into storage.buckets (id, name, public) values ('facturas', 'facturas', false)
on conflict (id) do nothing;

-- ─── 5. Crons (patrón de 20261006000003_crons.sql; usa public.invocar_edge_function y Vault) ───
-- factura: reintentos y pedidos entregados sin factura, cada hora. recuperar-borradores: cada hora.
-- Con la bandera apagada las funciones responden sin hacer nada.
create extension if not exists pg_cron;

do $$
declare j text;
begin
  foreach j in array array['wa-factura-reintentos', 'wa-recuperar-borradores'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end;
$$;

select cron.schedule('wa-factura-reintentos',    '20 * * * *', $$select public.invocar_edge_function('factura')$$);
select cron.schedule('wa-recuperar-borradores',  '40 * * * *', $$select public.invocar_edge_function('recuperar-borradores')$$);
