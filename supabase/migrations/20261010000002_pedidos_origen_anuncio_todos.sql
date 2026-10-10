-- Igual que pedidos_origen_anuncio pero SIN excluir cancelados y con estado_confirmacion.
-- Solo lo usa Reportes > Costo por anuncio para la columna "cayeron sin respuesta". No toca la vista existente.
create or replace view public.pedidos_origen_anuncio_todos
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
            then coalesce(p.entregado_en, est.entregado_estado_en) end           as entregado_en,
       p.estado_confirmacion
  from public.shopify_pedidos p
  left join na  on na.shopify_order_id  = p.shopify_order_id
  left join est on est.shopify_order_id = p.shopify_order_id
 where not p.es_borrador;

revoke all on public.pedidos_origen_anuncio_todos from anon;
grant select on public.pedidos_origen_anuncio_todos to authenticated, service_role;
