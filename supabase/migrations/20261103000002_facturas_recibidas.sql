-- 03-11-2026 · Facturas para la contadora (contrato docs/contrato-imprimir-facturas-03-11.md, pedido de Enrique:
-- "todas las facturas a nombre de Voltra, en papel"). Dos cosas:
--  1. public.facturas_recibidas: facturas electrónicas que llegan a voltraparaguay@gmail.com. Las carga la Edge
--     Function factura-recibida-email (service_role) desde un Apps Script. Los archivos van al bucket privado
--     'facturas' con prefijo recibidas/<gmail_id>/ (el bucket ya existe y authenticated ya puede leerlo).
--  2. public.facturas.impreso_en: para tildar las emitidas por Voltra que ya se imprimieron.
-- RLS (mismo patrón que facturas en 20261008000010_sifen.sql y profiles en 20261009000021_seguridad.sql):
--   authenticated lee todo y solo puede cambiar impreso_en / descartada (permiso por columna + policy de update);
--   anon nada; service_role todo (pasa por encima de RLS).
-- Volver atrás:
--   drop table public.facturas_recibidas;
--   drop policy facturas_authenticated_marca_impreso on public.facturas;
--   revoke update (impreso_en) on public.facturas from authenticated;
--   alter table public.facturas drop column impreso_en;
--   (y borrar en Storage los objetos facturas/recibidas/*)

-- ─── 1. Tabla de recibidas ───
create table if not exists public.facturas_recibidas (
  id uuid primary key default gen_random_uuid(),
  gmail_id text unique not null,
  recibida_en timestamptz not null,
  remitente text,
  asunto text,
  proveedor text,
  ruc_emisor text,
  numero text,            -- 001-001-0000001
  cdc text,
  fecha_doc date,
  total numeric,
  receptor_ruc text,
  pdf_path text,          -- ruta dentro del bucket 'facturas'
  xml_path text,
  es_de_voltra boolean,   -- true: el XML dice receptor RUC 80177762; null: no hay XML de SIFEN
  descartada boolean not null default false,
  impreso_en timestamptz,
  creado_en timestamptz default now()
);

comment on table public.facturas_recibidas is
  'Facturas electrónicas recibidas por correo (voltraparaguay@gmail.com). Carga: Edge Function factura-recibida-email.';

create index if not exists facturas_recibidas_recibida_en_idx on public.facturas_recibidas (recibida_en desc);

alter table public.facturas_recibidas enable row level security;
revoke all on public.facturas_recibidas from anon;
revoke insert, update, delete on public.facturas_recibidas from authenticated;
grant select on public.facturas_recibidas to authenticated;
grant update (impreso_en, descartada) on public.facturas_recibidas to authenticated;
grant all on public.facturas_recibidas to service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'facturas_recibidas'
                 and policyname = 'facturas_recibidas_authenticated_lee') then
    create policy facturas_recibidas_authenticated_lee on public.facturas_recibidas
      for select to authenticated using (true);
  end if;
  -- El permiso por columna limita el update a impreso_en y descartada; la policy solo habilita la fila.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'facturas_recibidas'
                 and policyname = 'facturas_recibidas_authenticated_marca') then
    create policy facturas_recibidas_authenticated_marca on public.facturas_recibidas
      for update to authenticated using (true) with check (true);
  end if;
end;
$$;

-- ─── 2. Emitidas: marca de impresa ───
alter table public.facturas add column if not exists impreso_en timestamptz;

-- Hoy authenticated solo LEE facturas (sin update). El front tiene que poder escribir impreso_en y nada más.
grant update (impreso_en) on public.facturas to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'facturas'
                 and policyname = 'facturas_authenticated_marca_impreso') then
    create policy facturas_authenticated_marca_impreso on public.facturas
      for update to authenticated using (true) with check (true);
  end if;
end;
$$;
