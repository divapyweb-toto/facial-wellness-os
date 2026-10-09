-- 20261008000010_sifen.sql · Facturación electrónica PROPIA (SIFEN, DNIT, MT v150) · agente E · 08-10-2026
-- Idempotente (se puede volver a correr). Contrato: docs/sifen-contrato.md.
--
-- 1. Evoluciona public.facturas (hoy VACÍA en producción, hallazgo de G 08-10) al esquema del contrato:
--    pk nuevo `id uuid`; `shopify_order_id` pasa a columna común; una sola FE (tipo 1) por pedido
--    (índice único parcial); estados nuevos (emitiendo→pendiente, emitida→aprobada).
-- 2. eventos_sifen (cancelación, inutilización, …).
-- 3. sifen_numeracion + sifen_siguiente_numero() (select … for update: sin saltos ni duplicados con concurrencia)
--    + sifen_asignar_numero() (reserva y graba el número en la factura en la MISMA transacción).
-- 4. tomar_factura() nueva: lease atómico por id de factura (la vieja por pedido se borra).
-- 5. Vistas facturas_resumen_mes y facturas_libro_ventas (panel F / contadora).
-- 6. RLS: authenticated SOLO lee; escribe service_role (Edge Functions).
-- 7. Crons: sifen-cola cada 10 min; sifen-inutilizacion diario. Se borra el cron viejo wa-factura-reintentos.
--
-- Numeración test vs prod: la Edge Function usa como clave de timbrado '<timbrado>' en prod y
-- '<timbrado>-test' en test, para que las pruebas no consuman números de producción.

-- ─── 1. facturas ─────────────────────────────────────────────
alter table public.facturas add column if not exists id uuid not null default gen_random_uuid();

do $$
declare pk_col text;
begin
  select a.attname into pk_col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.conrelid = 'public.facturas'::regclass and c.contype = 'p'
   limit 1;
  if pk_col is distinct from 'id' then
    if pk_col is not null then
      execute 'alter table public.facturas drop constraint ' ||
        (select conname from pg_constraint where conrelid = 'public.facturas'::regclass and contype = 'p');
    end if;
    alter table public.facturas add constraint facturas_pkey primary key (id);
  end if;
end;
$$;

alter table public.facturas alter column shopify_order_id drop not null;
-- El número ya no es único global: es único por (ambiente, timbrado, establecimiento, punto, tipo).
alter table public.facturas drop constraint if exists facturas_numero_key;

-- Estados nuevos.
alter table public.facturas drop constraint if exists facturas_estado_check;
update public.facturas set estado = 'pendiente' where estado = 'emitiendo';
update public.facturas set estado = 'aprobada'  where estado = 'emitida';
alter table public.facturas alter column estado set default 'pendiente';
alter table public.facturas add constraint facturas_estado_check
  check (estado in ('pendiente','enviada','aprobada','rechazada','cancelada','revisar','error','inutilizada'));

alter table public.facturas
  add column if not exists tipo_documento     smallint not null default 1,
  add column if not exists establecimiento    text not null default '001',
  add column if not exists punto              text not null default '001',
  add column if not exists timbrado           text,
  add column if not exists codigo_seguridad   text,
  add column if not exists ambiente           text not null default 'test',
  add column if not exists emisor             text not null default 'propio',
  add column if not exists receptor_tipo      text,
  add column if not exists total              bigint,
  add column if not exists iva10              bigint,
  add column if not exists iva5               bigint,
  add column if not exists base10             bigint,
  add column if not exists base5              bigint,
  add column if not exists exento             bigint,
  add column if not exists xml_firmado        text,
  add column if not exists url_qr             text,
  add column if not exists kude_path          text,
  add column if not exists fecha_emision      timestamptz,
  add column if not exists enviada_en         timestamptz,
  add column if not exists aprobada_en        timestamptz,
  add column if not exists cancelada_en       timestamptz,
  add column if not exists codigo_respuesta   text,
  add column if not exists motivo_rechazo     text,
  add column if not exists factura_original_id uuid references public.facturas(id),
  add column if not exists lote_id            text,
  add column if not exists protocolo          text,
  add column if not exists proximo_intento    timestamptz,
  add column if not exists kude_enviado_en    timestamptz;
-- Ya existían en ola4: numero, numero_completo, tipo (viejo), ruc, razon_social, cdc (unique), pdf_url, pdf_path,
-- simulado, error, intentos, lease_hasta, creado_en, actualizado_en.

-- Datos de la ola4 (si hubiera): pdf_path → kude_path, tipo → receptor_tipo.
update public.facturas set kude_path = pdf_path where kude_path is null and pdf_path is not null;
update public.facturas set receptor_tipo = case tipo when 'ruc' then 'ruc' else 'innominado' end
 where receptor_tipo is null and tipo is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'facturas_tipo_documento_check') then
    alter table public.facturas add constraint facturas_tipo_documento_check check (tipo_documento in (1,4,5,6,7));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'facturas_ambiente_check') then
    alter table public.facturas add constraint facturas_ambiente_check check (ambiente in ('test','prod'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'facturas_emisor_check') then
    alter table public.facturas add constraint facturas_emisor_check check (emisor in ('propio','facturasend'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'facturas_receptor_tipo_check') then
    alter table public.facturas add constraint facturas_receptor_tipo_check
      check (receptor_tipo is null or receptor_tipo in ('ruc','innominado','documento'));
  end if;
end;
$$;

-- Una sola factura (tipo 1) por pedido. Es la llave de la idempotencia: dos corridas a la vez → una falla con 23505.
create unique index if not exists facturas_una_fe_por_pedido
  on public.facturas (shopify_order_id) where tipo_documento = 1 and shopify_order_id is not null;
-- Una sola NC por factura (la NC es siempre por el total).
create unique index if not exists facturas_una_nc_por_original
  on public.facturas (factura_original_id) where tipo_documento = 5;
-- Número único por serie.
create unique index if not exists facturas_numero_por_serie
  on public.facturas (ambiente, timbrado, establecimiento, punto, tipo_documento, numero) where numero is not null;
create index if not exists facturas_cola_idx on public.facturas (proximo_intento) where proximo_intento is not null;
create index if not exists facturas_fecha_emision_idx on public.facturas (fecha_emision desc);
create index if not exists facturas_pedido_idx on public.facturas (shopify_order_id);

create or replace trigger facturas_actualizado_en
  before update on public.facturas
  for each row execute function public.wa_tocar_actualizado_en();

-- ─── 2. eventos_sifen ────────────────────────────────────────
create table if not exists public.eventos_sifen (
  id          uuid primary key default gen_random_uuid(),
  factura_id  uuid references public.facturas(id) on delete set null,
  tipo        text not null,          -- 'cancelacion' | 'inutilizacion' | 'conformidad' | ...
  rango       jsonb,                  -- {tipo, establecimiento, punto, desde, hasta, timbrado}
  motivo      text,
  estado      text not null default 'pendiente' check (estado in ('pendiente','enviado','aprobado','rechazado')),
  respuesta   jsonb,
  codigo      text,
  creado_en   timestamptz not null default now(),
  enviado_en  timestamptz
);
create index if not exists eventos_sifen_factura_idx on public.eventos_sifen (factura_id);
create index if not exists eventos_sifen_tipo_idx on public.eventos_sifen (tipo, estado);

-- ─── 3. Numeración ───────────────────────────────────────────
create table if not exists public.sifen_numeracion (
  timbrado        text not null,      -- clave: '<timbrado>' en prod, '<timbrado>-test' en test
  establecimiento text not null,
  punto           text not null,
  tipo_documento  smallint not null,
  ultimo          integer not null default 0,   -- para arrancar en N: poner ultimo = N-1 a mano
  actualizado_en  timestamptz not null default now(),
  primary key (timbrado, establecimiento, punto, tipo_documento)
);

-- Siguiente número de la serie. La fila se bloquea (for update) hasta el fin de la transacción:
-- dos llamadas a la vez esperan en fila y nunca reciben el mismo número.
create or replace function public.sifen_siguiente_numero(p_timbrado text, p_est text, p_pun text, p_tipo integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  insert into public.sifen_numeracion (timbrado, establecimiento, punto, tipo_documento, ultimo)
  values (p_timbrado, p_est, p_pun, p_tipo, 0)
  on conflict do nothing;
  select ultimo into n from public.sifen_numeracion
   where timbrado = p_timbrado and establecimiento = p_est and punto = p_pun and tipo_documento = p_tipo
   for update;
  n := n + 1;
  update public.sifen_numeracion set ultimo = n, actualizado_en = now()
   where timbrado = p_timbrado and establecimiento = p_est and punto = p_pun and tipo_documento = p_tipo;
  return n;
end;
$$;

-- Asigna número + código de seguridad + fecha a una factura que todavía no los tiene (idempotente:
-- si ya los tiene, los devuelve sin tocar nada). Todo en una transacción → sin números perdidos.
create or replace function public.sifen_asignar_numero(
  p_factura uuid, p_clave_timbrado text, p_codigo_seguridad text, p_fecha timestamptz)
returns table (numero integer, numero_completo text, codigo_seguridad text, fecha_emision timestamptz)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  f public.facturas%rowtype;
  n integer;
begin
  select * into f from public.facturas where id = p_factura for update;
  if not found then raise exception 'factura % no existe', p_factura; end if;
  if f.numero is not null and f.codigo_seguridad is not null and f.fecha_emision is not null then
    return query select f.numero, f.numero_completo, f.codigo_seguridad, f.fecha_emision; return;
  end if;
  n := coalesce(f.numero, public.sifen_siguiente_numero(p_clave_timbrado, f.establecimiento, f.punto, f.tipo_documento));
  update public.facturas
     set numero = n,
         numero_completo = lpad(f.establecimiento, 3, '0') || '-' || lpad(f.punto, 3, '0') || '-' || lpad(n::text, 7, '0'),
         codigo_seguridad = coalesce(f.codigo_seguridad, p_codigo_seguridad),
         fecha_emision = coalesce(f.fecha_emision, p_fecha)
   where id = p_factura
  returning facturas.numero, facturas.numero_completo, facturas.codigo_seguridad, facturas.fecha_emision
    into f.numero, f.numero_completo, f.codigo_seguridad, f.fecha_emision;
  return query select f.numero, f.numero_completo, f.codigo_seguridad, f.fecha_emision;
end;
$$;

revoke all on function public.sifen_siguiente_numero(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.sifen_asignar_numero(uuid, text, text, timestamptz) from public, anon, authenticated;

-- ─── 4. tomar_factura (reemplazo) ────────────────────────────
-- La de ola4 (por pedido, con max(numero)+1) choca con la numeración por serie: se borra.
drop function if exists public.tomar_factura(bigint, integer, integer);
-- Lease atómico por factura: true si la tomó esta corrida (nadie más la tiene). Suma un intento.
create or replace function public.tomar_factura(p_factura uuid, p_lease_min integer default 5)
returns table (tomada boolean, estado text, intentos integer)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare f public.facturas%rowtype;
begin
  select * into f from public.facturas where id = p_factura for update;
  if not found then return query select false, null::text, 0; return; end if;
  if f.lease_hasta is not null and f.lease_hasta > now() then
    return query select false, f.estado, f.intentos; return;
  end if;
  update public.facturas set lease_hasta = now() + make_interval(mins => p_lease_min) where id = p_factura;
  return query select true, f.estado, f.intentos;
end;
$$;
revoke all on function public.tomar_factura(uuid, integer) from public, anon, authenticated;

-- ─── 5. Vistas para el panel y la contadora ──────────────────
-- Resumen mensual (hora de Asunción) de lo APROBADO. Separado por ambiente y tipo de documento:
-- el panel filtra ambiente = 'prod' y resta las NC (tipo 5) si quiere el neto.
create or replace view public.facturas_resumen_mes
with (security_invoker = true) as
select to_char(fecha_emision at time zone 'America/Asuncion', 'YYYY-MM') as mes,
       ambiente,
       tipo_documento,
       count(*)                   as cantidad,
       coalesce(sum(total), 0)    as total,
       coalesce(sum(iva10), 0)    as iva10,
       coalesce(sum(iva5), 0)     as iva5,
       coalesce(sum(base10), 0)   as base10,
       coalesce(sum(base5), 0)    as base5,
       coalesce(sum(exento), 0)   as exento
  from public.facturas
 where estado = 'aprobada' and fecha_emision is not null
 group by 1, 2, 3;

-- Listado por mes para exportar a CSV/Excel (libro de ventas). Incluye canceladas (la contadora las ve).
create or replace view public.facturas_libro_ventas
with (security_invoker = true) as
select to_char(f.fecha_emision at time zone 'America/Asuncion', 'YYYY-MM')               as mes,
       to_char(f.fecha_emision at time zone 'America/Asuncion', 'YYYY-MM-DD HH24:MI:SS') as fecha,
       f.ambiente, f.tipo_documento,
       case f.tipo_documento when 1 then 'Factura' when 4 then 'Autofactura' when 5 then 'Nota de crédito'
                             when 6 then 'Nota de débito' when 7 then 'Nota de remisión' end as tipo,
       f.timbrado, f.numero_completo, f.cdc, f.estado,
       f.receptor_tipo, f.ruc, coalesce(f.razon_social, 'SIN NOMBRE') as razon_social,
       f.base10, f.iva10, f.base5, f.iva5, f.exento, f.total,
       o.numero_completo as factura_asociada, o.cdc as cdc_asociado,
       f.shopify_order_id, f.simulado
  from public.facturas f
  left join public.facturas o on o.id = f.factura_original_id
 where f.fecha_emision is not null and f.estado in ('aprobada', 'cancelada');

-- ─── 6. RLS: authenticated lee; escribe solo service_role ────
do $$
declare t text;
begin
  foreach t in array array['facturas','eventos_sifen','sifen_numeracion'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
    execute format('grant select on public.%I to authenticated', t);
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_authenticated_todo') then
      execute format('drop policy %I on public.%I', t || '_authenticated_todo', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_authenticated_lee') then
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_authenticated_lee', t);
    end if;
  end loop;
end;
$$;
grant select on public.facturas_resumen_mes, public.facturas_libro_ventas to authenticated;

-- El panel (F) abre el KuDE con una URL firmada: authenticated puede LEER los objetos del bucket privado 'facturas'.
do $$
begin
  if to_regclass('storage.objects') is not null and not exists (
    select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'facturas_authenticated_lee'
  ) then
    create policy facturas_authenticated_lee on storage.objects for select to authenticated using (bucket_id = 'facturas');
  end if;
end;
$$;

-- ─── 7. Crons (patrón de 20261006000003_crons.sql: public.invocar_edge_function + Vault) ───
-- Con config_wa['sifen'].activo = false las funciones responden sin hacer nada.
create extension if not exists pg_cron;

do $$
declare j text;
begin
  -- wa-factura-reintentos (ola4) se reemplaza por sifen-cola.
  foreach j in array array['wa-factura-reintentos', 'sifen-cola', 'sifen-inutilizacion'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end;
$$;

select cron.schedule('sifen-cola',          '*/10 * * * *', $$select public.invocar_edge_function('sifen-cola')$$);
-- 12:15 UTC = 09:15 en Asunción (UTC-3).
select cron.schedule('sifen-inutilizacion', '15 12 * * *',  $$select public.invocar_edge_function('sifen-inutilizacion')$$);
