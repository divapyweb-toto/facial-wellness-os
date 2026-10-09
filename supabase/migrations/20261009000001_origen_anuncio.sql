-- ═══════════════════════════════════════════════════════════
-- 20261009000001_origen_anuncio.sql · Agente Y · 09-10-2026
-- 1. Vista pedidos_origen_anuncio: de qué anuncio vino cada pedido de Voltra y si se entregó.
--    Releasit guarda los UTM en shopify_pedidos.raw->note_attributes ("UTM source", "UTM medium",
--    "UTM campaign", "UTM content", "UTM term"). Los pedidos del vendedor de WhatsApp traen
--    note_attributes "origen" = whatsapp y "conversacion_id"; su anuncio sale de
--    wa_conversaciones.origen_anuncio_id (el referral del click-to-WhatsApp).
-- 2. Vista costo_entregado_por_anuncio: gasto de gasto_ads_diario (tienda 'voltra') ÷ entregados.
--    gasto_ads_diario está a nivel CONJUNTO (adset_id, adset_nombre), no de anuncio ni campaña, así que
--    el cruce es por CONJUNTO y solo cuando el pedido trae el ID del conjunto en el UTM
--    (plantilla de Meta con {{adset.id}}: hoy llega en "UTM term" en una de las dos plantillas en uso).
--    Los pedidos sin ID de conjunto quedan en filas "sin_cruce" (por origen) con sus anuncios listados.
-- 3. Cron diario de la función alerta-despachos (8:00 Asunción = 11:00 UTC).
-- Idempotente: create or replace + unschedule/schedule. No toca datos.
-- ═══════════════════════════════════════════════════════════

-- ─── 1. Pedido → anuncio de origen ──────────────────────────
create or replace view public.pedidos_origen_anuncio
with (security_invoker = true) as
with attrs as (
  select p.shopify_order_id,
         -- "UTM content" / "utm_content" / "Utm-Content" → 'utm_content'
         lower(regexp_replace(trim(a ->> 'name'), '[\s\-]+', '_', 'g')) as k,
         nullif(trim(a ->> 'value'), '')                               as v
    from public.shopify_pedidos p,
         jsonb_array_elements(case when jsonb_typeof(p.raw -> 'note_attributes') = 'array'
                                   then p.raw -> 'note_attributes' else '[]'::jsonb end) a
),
na as (
  select shopify_order_id,
         max(v) filter (where k = 'utm_source')      as utm_source,
         max(v) filter (where k = 'utm_medium')      as utm_medium,
         max(v) filter (where k = 'utm_campaign')    as utm_campaign,
         max(v) filter (where k = 'utm_content')     as utm_content,
         max(v) filter (where k = 'utm_term')        as utm_term,
         max(v) filter (where k = 'origen')          as origen_attr,
         max(v) filter (where k = 'conversacion_id') as conversacion_id
    from attrs
   group by shopify_order_id
),
est as (
  select shopify_order_id,
         min(creado_en) filter (where estado in ('ENTREGADO','RENDIDO')) as entregado_estado_en
    from public.pedido_estados
   group by shopify_order_id
)
select p.shopify_order_id,
       p.nombre,
       'VT-' || nullif(regexp_replace(coalesce(p.nombre, ''), '\D', '', 'g'), '')::bigint as referencia,
       p.creado_en,
       na.utm_source, na.utm_medium, na.utm_campaign, na.utm_content, na.utm_term,
       case when lower(coalesce(na.origen_attr, '')) = 'whatsapp' or na.conversacion_id is not null
            then 'whatsapp' else 'web' end                                       as origen,
       case when lower(coalesce(na.origen_attr, '')) = 'whatsapp' or na.conversacion_id is not null
            then coalesce(
              -- la conversación exacta que generó el pedido
              (select c.origen_anuncio_id from public.wa_conversaciones c
                where na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  and c.id = na.conversacion_id::uuid),
              -- si no, la última conversación con anuncio del mismo cliente antes del pedido
              (select c.origen_anuncio_id from public.wa_conversaciones c
                where c.cliente_id = p.cliente_id and c.origen_anuncio_id is not null
                  and c.creado_en <= p.creado_en
                order by c.creado_en desc limit 1))
       end                                                                       as anuncio_wa,
       -- ID del conjunto si el UTM lo trae (plantilla {{adset.id}}); el nombre de ubicación no sirve para cruzar.
       case when na.utm_term ~ '^\d{10,}$' then na.utm_term end                  as adset_id_utm,
       (est.entregado_estado_en is not null)                                     as entregado,
       case when est.entregado_estado_en is not null
            then coalesce(p.entregado_en, est.entregado_estado_en) end           as entregado_en
  from public.shopify_pedidos p
  left join na  on na.shopify_order_id  = p.shopify_order_id
  left join est on est.shopify_order_id = p.shopify_order_id
 where not p.es_borrador
   and coalesce(p.estado_confirmacion, '') not in ('cancelado_cliente', 'cancelado_sin_respuesta');

revoke all on public.pedidos_origen_anuncio from anon;
grant select on public.pedidos_origen_anuncio to authenticated, service_role;

-- ─── 2. Costo por entregado ─────────────────────────────────
-- Una fila por conjunto con gasto en Voltra (cruce exacto adset_id = adset_id_utm) + filas "sin_cruce"
-- por origen (web / whatsapp) con los pedidos que no traen el ID del conjunto.
-- costo_por_entregado = gasto total del conjunto ÷ entregados atribuidos por UTM (no incluye los
-- entregados que Meta atribuye sin UTM, así que es un techo del costo real).
create or replace view public.costo_entregado_por_anuncio
with (security_invoker = true) as
with gasto as (
  select adset_id, max(adset_nombre) as adset_nombre, sum(gasto) as gasto,
         min(fecha) as gasto_desde, max(fecha) as gasto_hasta
    from public.gasto_ads_diario
   where tienda = 'voltra' and adset_id is not null
   group by adset_id
),
ped as (
  select case when adset_id_utm is not null then 'conjunto' else 'sin_cruce' end as cruce,
         adset_id_utm, case when adset_id_utm is null then origen end as origen_sin_cruce,
         count(*) as pedidos,
         count(*) filter (where entregado) as entregados,
         string_agg(distinct coalesce(utm_content, anuncio_wa), ' | ') as anuncios,
         string_agg(distinct utm_campaign, ' | ') as campanias,
         min(creado_en) as primer_pedido, max(creado_en) as ultimo_pedido
    from public.pedidos_origen_anuncio
   group by 1, 2, 3
)
select coalesce(ped.cruce, 'conjunto')               as cruce,
       coalesce(g.adset_id, ped.adset_id_utm)        as adset_id,
       g.adset_nombre,
       ped.origen_sin_cruce                          as origen,
       ped.campanias,
       ped.anuncios,
       coalesce(ped.pedidos, 0)                      as pedidos,
       coalesce(ped.entregados, 0)                   as entregados,
       g.gasto,
       g.gasto_desde, g.gasto_hasta,
       ped.primer_pedido, ped.ultimo_pedido,
       round(g.gasto / nullif(ped.pedidos, 0))       as costo_por_pedido,
       round(g.gasto / nullif(ped.entregados, 0))    as costo_por_entregado
  from gasto g
  full join (select * from ped where cruce = 'conjunto') ped on ped.adset_id_utm = g.adset_id
union all
select cruce, null, null, origen_sin_cruce, campanias, anuncios, pedidos, entregados,
       null, null, null, primer_pedido, ultimo_pedido, null, null
  from ped where cruce = 'sin_cruce';

revoke all on public.costo_entregado_por_anuncio from anon;
grant select on public.costo_entregado_por_anuncio to authenticated, service_role;

-- ─── 3. Cron diario: alerta-despachos ───────────────────────
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'voltra-alerta-despachos') then
    perform cron.unschedule('voltra-alerta-despachos');
  end if;
end;
$$;

select cron.schedule('voltra-alerta-despachos', '0 11 * * *', $$select public.invocar_edge_function('alerta-despachos')$$);
