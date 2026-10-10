-- ═══════════════════════════════════════════════════════════
-- P2 · pedido_datos_fiscales (contrato P1-P2 del 10-10-2026, sección "P2 REDEFINIDO"). Idempotente. No toca datos.
-- Una fila por pedido de Shopify con los datos para facturar a nombre de una empresa:
--   (a) pedidos mayoristas cargados desde Voltra OS (función pedido-mayorista, origen 'mayorista');
--   (b) RUC agregado a un pedido de la web ya existente (modal "Datos de factura", origen 'web_con_ruc').
-- P1 (_shared/sifen/desde_pedido.ts) la lee: si hay fila, MANDA sobre los atributos del pedido.
-- Aplicar ANTES de desplegar pedido-mayorista. Repo público: sin datos reales acá.
-- ═══════════════════════════════════════════════════════════

-- DV del RUC por módulo 11 (misma fórmula que supabase/functions/_shared/sifen/cdc.ts dvModulo11, baseMax 11:
-- pesos 2..11 desde la derecha, ciclando; resto = suma % 11; DV = resto > 1 ? 11 - resto : 0). Solo dígitos.
create or replace function public.ruc_dv_modulo11(p_ruc text)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  total integer := 0;
  k integer := 2;
  i integer;
begin
  if p_ruc is null or p_ruc !~ '^[0-9]+$' then
    return null;
  end if;
  for i in reverse length(p_ruc)..1 loop
    if k > 11 then k := 2; end if;
    total := total + substr(p_ruc, i, 1)::integer * k;
    k := k + 1;
  end loop;
  return case when total % 11 > 1 then 11 - total % 11 else 0 end;
end
$$;

create table if not exists public.pedido_datos_fiscales (
  shopify_order_id  bigint primary key,
  ruc               text not null,                       -- sin DV, solo dígitos (3 a 8)
  dv                text not null,                       -- 1 dígito, módulo 11
  razon_social      text not null,
  email             text,
  condicion         text not null default 'contado',     -- 'contado' | 'credito'
  plazo_dias        integer,                             -- obligatorio si es crédito (1 a 365)
  origen            text not null,                       -- 'mayorista' | 'web_con_ruc'
  cargado_por       uuid default auth.uid(),
  actualizado_en    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pedido_datos_fiscales_ruc_formato') then
    alter table public.pedido_datos_fiscales add constraint pedido_datos_fiscales_ruc_formato
      check (ruc ~ '^[1-9][0-9]{2,7}$' and dv ~ '^[0-9]$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pedido_datos_fiscales_dv_valido') then
    alter table public.pedido_datos_fiscales add constraint pedido_datos_fiscales_dv_valido
      check (case when dv ~ '^[0-9]$' then dv::integer = public.ruc_dv_modulo11(ruc) else false end);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pedido_datos_fiscales_razon_social') then
    alter table public.pedido_datos_fiscales add constraint pedido_datos_fiscales_razon_social
      check (length(btrim(razon_social)) >= 2);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pedido_datos_fiscales_condicion') then
    alter table public.pedido_datos_fiscales add constraint pedido_datos_fiscales_condicion
      check (condicion in ('contado', 'credito')
             and (plazo_dias is null or plazo_dias between 1 and 365)
             and (condicion <> 'credito' or plazo_dias is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pedido_datos_fiscales_origen') then
    alter table public.pedido_datos_fiscales add constraint pedido_datos_fiscales_origen
      check (origen in ('mayorista', 'web_con_ruc'));
  end if;
end $$;

create or replace trigger pedido_datos_fiscales_actualizado_en
  before update on public.pedido_datos_fiscales
  for each row execute function public.wa_tocar_actualizado_en();

-- Con una factura (tipo 1) de producción ya aprobada, enviada o en emisión, los datos del receptor no se cambian:
-- hay que hacer nota de crédito. Vale para cualquier rol (la pantalla avisa antes; esto es la red de seguridad).
create or replace function public.pedido_datos_fiscales_bloqueo_facturado()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_id bigint := case when tg_op = 'DELETE' then old.shopify_order_id else new.shopify_order_id end;
begin
  if exists (select 1 from public.facturas f
              where f.shopify_order_id = v_id
                and f.tipo_documento = 1
                and f.ambiente = 'prod'
                and f.estado in ('pendiente', 'enviada', 'aprobada')) then
    raise exception 'El pedido % ya tiene factura electrónica: para cambiar el RUC o la razón social hay que hacer una nota de crédito.', v_id
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create or replace trigger pedido_datos_fiscales_bloqueo_facturado
  before insert or update or delete on public.pedido_datos_fiscales
  for each row execute function public.pedido_datos_fiscales_bloqueo_facturado();

-- RLS: authenticated lee y escribe; anon nada; service_role (pedido-mayorista, sifen-cola) pasa.
alter table public.pedido_datos_fiscales enable row level security;
revoke all on public.pedido_datos_fiscales from anon;
grant select, insert, update, delete on public.pedido_datos_fiscales to authenticated;
grant all on public.pedido_datos_fiscales to service_role;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pedido_datos_fiscales'
                 and policyname = 'pedido_datos_fiscales_authenticated_todo') then
    create policy pedido_datos_fiscales_authenticated_todo on public.pedido_datos_fiscales
      for all to authenticated using (true) with check (true);
  end if;
end $$;

revoke all on function public.ruc_dv_modulo11(text) from anon;
revoke all on function public.pedido_datos_fiscales_bloqueo_facturado() from anon;
