-- ═══════════════════════════════════════════════════════════
-- Gasto de Meta por ANUNCIO + costo por entregado por anuncio (09-10-2026)
-- Cada pedido de la web guarda en "UTM content" el NOMBRE del anuncio. sync-meta-ads ahora trae
-- también el gasto por anuncio (con su nombre), así que el cruce pedido ↔ gasto se hace por nombre,
-- sin tocar las plantillas de URL de los anuncios en Meta. Idempotente.
-- ═══════════════════════════════════════════════════════════
create table if not exists public.gasto_ads_anuncio_diario (
  fecha          date        not null,
  ad_id          text        not null,
  ad_nombre      text        not null default '',
  adset_id       text,
  campana_nombre text        not null default '',
  gasto          bigint      not null,
  tienda         text        not null default 'voltra',
  sincronizado_en timestamptz not null default now(),
  primary key (fecha, ad_id)
);
create index if not exists gasto_ads_anuncio_nombre_idx on public.gasto_ads_anuncio_diario (lower(trim(ad_nombre)));

alter table public.gasto_ads_anuncio_diario enable row level security;
revoke all on public.gasto_ads_anuncio_diario from anon;
grant select on public.gasto_ads_anuncio_diario to authenticated;
grant all on public.gasto_ads_anuncio_diario to service_role;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'gasto_ads_anuncio_diario' and policyname = 'lectura_autenticados') then
    create policy lectura_autenticados on public.gasto_ads_anuncio_diario for select to authenticated using (true);
  end if;
end $$;

-- Costo por pedido y por entregado, por ANUNCIO (cruce por nombre del anuncio = "UTM content").
drop view if exists public.costo_entregado_por_anuncio;
create view public.costo_entregado_por_anuncio
with (security_invoker = true) as
with gasto as (
  select lower(trim(ad_nombre)) as clave, max(ad_nombre) as anuncio, max(campana_nombre) as campana,
         sum(gasto) as gasto, min(fecha) as gasto_desde, max(fecha) as gasto_hasta
    from public.gasto_ads_anuncio_diario
   where tienda = 'voltra' and ad_nombre <> ''
   group by 1
),
ped_src as (
  -- Web: "UTM content" (nombre del anuncio, o a veces su ID). WhatsApp: el anuncio de origen del chat.
  select o.*, nullif(trim(coalesce(o.utm_content, o.anuncio_wa::text)), '') as ref
    from public.pedidos_origen_anuncio o
),
ped as (
  select coalesce(
           (select lower(trim(max(a.ad_nombre))) from public.gasto_ads_anuncio_diario a where a.ad_id = s.ref),
           lower(s.ref))                                    as clave,
         max(s.ref) as anuncio,
         count(*) as pedidos, count(*) filter (where s.entregado) as entregados,
         min(s.creado_en) as primer_pedido, max(s.creado_en) as ultimo_pedido
    from ped_src s
   where s.ref is not null
   group by 1
)
select coalesce(g.anuncio, p.anuncio)                              as anuncio,
       g.campana,
       case when g.clave is null then 'sin_gasto_cargado'
            when p.clave is null then 'sin_pedidos'
            else 'cruzado' end                                      as cruce,
       coalesce(g.gasto, 0)                                         as gasto,
       coalesce(p.pedidos, 0)                                       as pedidos,
       coalesce(p.entregados, 0)                                    as entregados,
       case when coalesce(p.pedidos, 0) > 0 then round(coalesce(g.gasto, 0)::numeric / p.pedidos) end    as costo_por_pedido,
       case when coalesce(p.entregados, 0) > 0 then round(coalesce(g.gasto, 0)::numeric / p.entregados) end as costo_por_entregado,
       g.gasto_desde, g.gasto_hasta, p.primer_pedido, p.ultimo_pedido
  from gasto g
  full join ped p on p.clave = g.clave;

revoke all on public.costo_entregado_por_anuncio from anon;
grant select on public.costo_entregado_por_anuncio to authenticated, service_role;
