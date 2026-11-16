-- 16-11-2026 · FUNCIONES · Atribución WhatsApp por el ÚLTIMO anuncio (paquete (c), OK de Enrique 16-11: "Tu OK en este chat para cada paquete OK OK OK").
-- Antes: anuncio_wa = origen_anuncio_id de la conversación (el PRIMER anuncio; un chat viejo que vuelve por otro anuncio quedaba con el viejo o NULL, caso #1237).
-- Ahora: anuncio_wa = último mensaje entrante con referral de esa conversación ANTERIOR al pedido; respaldo: origen de la conversación; respaldo 2: última conversación del cliente con origen (igual que antes).
-- Columnas nuevas AL FINAL (las 9 vistas dependientes no cambian): anuncio_wa_primero (la atribución vieja, para comparar) y anuncio_wa_fuente ('ultimo_referral' | 'origen' | 'cliente').
-- Vista nueva wa_entradas_anuncio: cada entrada de una conversación por un anuncio (chat nuevo o viejo que volvió), para contar chats por anuncio.
-- No toca wa-webhook ni el CAPI (el CAPI ya usa el último ctwa_clid).
-- VOLVER ATRÁS: drop view public.wa_entradas_anuncio; y recrear las dos vistas con la definición de supabase/reversiones/20261116000003_vistas_previas.sql
--   (las columnas agregadas al final no se pueden quitar con create or replace: el archivo de vuelta hace drop ... cascade y recrea dependientes; preferible dejar las columnas y solo restaurar la expresión: usar anuncio_wa_primero en lugar de anuncio_wa).

create or replace view public.pedidos_origen_anuncio with (security_invoker = true) as
WITH attrs AS (
         SELECT p_1.shopify_order_id,
            lower(regexp_replace(TRIM(BOTH FROM a.value ->> 'name'::text), '[\s\-]+'::text, '_'::text, 'g'::text)) AS k,
            NULLIF(TRIM(BOTH FROM a.value ->> 'value'::text), ''::text) AS v
           FROM shopify_pedidos p_1,
            LATERAL jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(p_1.raw -> 'note_attributes'::text) = 'array'::text THEN p_1.raw -> 'note_attributes'::text
                    ELSE '[]'::jsonb
                END) a(value)
        ), na AS (
         SELECT attrs.shopify_order_id,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_source'::text) AS utm_source,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_medium'::text) AS utm_medium,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_campaign'::text) AS utm_campaign,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_content'::text) AS utm_content,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_term'::text) AS utm_term,
            max(attrs.v) FILTER (WHERE attrs.k = 'origen'::text) AS origen_attr,
            max(attrs.v) FILTER (WHERE attrs.k = 'conversacion_id'::text) AS conversacion_id
           FROM attrs
          GROUP BY attrs.shopify_order_id
        ), est AS (
         SELECT pedido_estados.shopify_order_id,
            min(pedido_estados.creado_en) FILTER (WHERE pedido_estados.estado = ANY (ARRAY['ENTREGADO'::text, 'RENDIDO'::text])) AS entregado_estado_en
           FROM pedido_estados
          GROUP BY pedido_estados.shopify_order_id
        )
 SELECT p.shopify_order_id,
    p.nombre,
    'VT-'::text || NULLIF(regexp_replace(COALESCE(p.nombre, ''::text), '\D'::text, ''::text, 'g'::text), ''::text)::bigint AS referencia,
    p.creado_en,
    na.utm_source,
    na.utm_medium,
    na.utm_campaign,
    na.utm_content,
    na.utm_term,
        CASE
            WHEN lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL THEN 'whatsapp'::text
            ELSE 'web'::text
        END AS origen,
        CASE
            WHEN lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL THEN COALESCE(( SELECT m.contenido -> 'referral' ->> 'source_id' FROM wa_mensajes m WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND m.conversacion_id = na.conversacion_id::uuid AND m.direccion = 'in'::text AND (m.contenido -> 'referral' ->> 'source_id') IS NOT NULL AND m.creado_en <= p.creado_en ORDER BY m.creado_en DESC LIMIT 1), ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND c.id = na.conversacion_id::uuid), ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE c.cliente_id = p.cliente_id AND c.origen_anuncio_id IS NOT NULL AND c.creado_en <= p.creado_en
              ORDER BY c.creado_en DESC
             LIMIT 1))
            ELSE NULL::text
        END AS anuncio_wa,
        CASE
            WHEN na.utm_term ~ '^\d{10,}$'::text THEN na.utm_term
            ELSE NULL::text
        END AS adset_id_utm,
    est.entregado_estado_en IS NOT NULL AS entregado,
        CASE
            WHEN est.entregado_estado_en IS NOT NULL THEN COALESCE(p.entregado_en, est.entregado_estado_en)
            ELSE NULL::timestamp with time zone
        END AS entregado_en,
        CASE
            WHEN lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL THEN COALESCE(( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND c.id = na.conversacion_id::uuid), ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE c.cliente_id = p.cliente_id AND c.origen_anuncio_id IS NOT NULL AND c.creado_en <= p.creado_en
              ORDER BY c.creado_en DESC
             LIMIT 1))
            ELSE NULL::text
        END AS anuncio_wa_primero,
        CASE
            WHEN NOT (lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL) THEN NULL::text
            WHEN ( SELECT m.contenido -> 'referral' ->> 'source_id' FROM wa_mensajes m WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND m.conversacion_id = na.conversacion_id::uuid AND m.direccion = 'in'::text AND (m.contenido -> 'referral' ->> 'source_id') IS NOT NULL AND m.creado_en <= p.creado_en ORDER BY m.creado_en DESC LIMIT 1) IS NOT NULL THEN 'ultimo_referral'::text
            WHEN ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND c.id = na.conversacion_id::uuid) IS NOT NULL THEN 'origen'::text
            WHEN ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE c.cliente_id = p.cliente_id AND c.origen_anuncio_id IS NOT NULL AND c.creado_en <= p.creado_en
              ORDER BY c.creado_en DESC
             LIMIT 1) IS NOT NULL THEN 'cliente'::text
            ELSE NULL::text
        END AS anuncio_wa_fuente
   FROM shopify_pedidos p
     LEFT JOIN na ON na.shopify_order_id = p.shopify_order_id
     LEFT JOIN est ON est.shopify_order_id = p.shopify_order_id
  WHERE NOT p.es_borrador AND (COALESCE(p.estado_confirmacion, ''::text) <> ALL (ARRAY['cancelado_cliente'::text, 'cancelado_sin_respuesta'::text]));

create or replace view public.pedidos_origen_anuncio_todos with (security_invoker = true) as
WITH attrs AS (
         SELECT p_1.shopify_order_id,
            lower(regexp_replace(TRIM(BOTH FROM a.value ->> 'name'::text), '[\s\-]+'::text, '_'::text, 'g'::text)) AS k,
            NULLIF(TRIM(BOTH FROM a.value ->> 'value'::text), ''::text) AS v
           FROM shopify_pedidos p_1,
            LATERAL jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(p_1.raw -> 'note_attributes'::text) = 'array'::text THEN p_1.raw -> 'note_attributes'::text
                    ELSE '[]'::jsonb
                END) a(value)
        ), na AS (
         SELECT attrs.shopify_order_id,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_source'::text) AS utm_source,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_medium'::text) AS utm_medium,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_campaign'::text) AS utm_campaign,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_content'::text) AS utm_content,
            max(attrs.v) FILTER (WHERE attrs.k = 'utm_term'::text) AS utm_term,
            max(attrs.v) FILTER (WHERE attrs.k = 'origen'::text) AS origen_attr,
            max(attrs.v) FILTER (WHERE attrs.k = 'conversacion_id'::text) AS conversacion_id
           FROM attrs
          GROUP BY attrs.shopify_order_id
        ), est AS (
         SELECT pedido_estados.shopify_order_id,
            COALESCE(min(pedido_estados.creado_en) FILTER (WHERE pedido_estados.estado = 'ENTREGADO'::text),
                CASE
                    WHEN NOT bool_or(pedido_estados.estado = ANY (ARRAY['NO_ENTREGADO'::text, 'CANCELADO'::text])) THEN min(pedido_estados.creado_en) FILTER (WHERE pedido_estados.estado = 'RENDIDO'::text)
                    ELSE NULL::timestamp with time zone
                END) AS entregado_estado_en
           FROM pedido_estados
          GROUP BY pedido_estados.shopify_order_id
        )
 SELECT p.shopify_order_id,
    p.nombre,
    'VT-'::text || NULLIF(regexp_replace(COALESCE(p.nombre, ''::text), '\D'::text, ''::text, 'g'::text), ''::text)::bigint AS referencia,
    p.creado_en,
    na.utm_source,
    na.utm_medium,
    na.utm_campaign,
    na.utm_content,
    na.utm_term,
        CASE
            WHEN lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL THEN 'whatsapp'::text
            ELSE 'web'::text
        END AS origen,
        CASE
            WHEN lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL THEN COALESCE(( SELECT m.contenido -> 'referral' ->> 'source_id' FROM wa_mensajes m WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND m.conversacion_id = na.conversacion_id::uuid AND m.direccion = 'in'::text AND (m.contenido -> 'referral' ->> 'source_id') IS NOT NULL AND m.creado_en <= p.creado_en ORDER BY m.creado_en DESC LIMIT 1), ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND c.id = na.conversacion_id::uuid), ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE c.cliente_id = p.cliente_id AND c.origen_anuncio_id IS NOT NULL AND c.creado_en <= p.creado_en
              ORDER BY c.creado_en DESC
             LIMIT 1))
            ELSE NULL::text
        END AS anuncio_wa,
        CASE
            WHEN na.utm_term ~ '^\d{10,}$'::text THEN na.utm_term
            ELSE NULL::text
        END AS adset_id_utm,
    est.entregado_estado_en IS NOT NULL AS entregado,
        CASE
            WHEN est.entregado_estado_en IS NOT NULL THEN COALESCE(p.entregado_en, est.entregado_estado_en)
            ELSE NULL::timestamp with time zone
        END AS entregado_en,
    p.estado_confirmacion,
        CASE
            WHEN lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL THEN COALESCE(( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND c.id = na.conversacion_id::uuid), ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE c.cliente_id = p.cliente_id AND c.origen_anuncio_id IS NOT NULL AND c.creado_en <= p.creado_en
              ORDER BY c.creado_en DESC
             LIMIT 1))
            ELSE NULL::text
        END AS anuncio_wa_primero,
        CASE
            WHEN NOT (lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL) THEN NULL::text
            WHEN ( SELECT m.contenido -> 'referral' ->> 'source_id' FROM wa_mensajes m WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND m.conversacion_id = na.conversacion_id::uuid AND m.direccion = 'in'::text AND (m.contenido -> 'referral' ->> 'source_id') IS NOT NULL AND m.creado_en <= p.creado_en ORDER BY m.creado_en DESC LIMIT 1) IS NOT NULL THEN 'ultimo_referral'::text
            WHEN ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE na.conversacion_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text AND c.id = na.conversacion_id::uuid) IS NOT NULL THEN 'origen'::text
            WHEN ( SELECT c.origen_anuncio_id
               FROM wa_conversaciones c
              WHERE c.cliente_id = p.cliente_id AND c.origen_anuncio_id IS NOT NULL AND c.creado_en <= p.creado_en
              ORDER BY c.creado_en DESC
             LIMIT 1) IS NOT NULL THEN 'cliente'::text
            ELSE NULL::text
        END AS anuncio_wa_fuente
   FROM shopify_pedidos p
     LEFT JOIN na ON na.shopify_order_id = p.shopify_order_id
     LEFT JOIN est ON est.shopify_order_id = p.shopify_order_id
  WHERE NOT p.es_borrador;

create or replace view public.wa_entradas_anuncio with (security_invoker = true) as
select m.conversacion_id,
       m.contenido -> 'referral' ->> 'source_id' as ad_id,
       min(m.creado_en) as entro_en,
       bool_or(c.creado_en >= m.creado_en - interval '5 minutes') as chat_nuevo
from wa_mensajes m
join wa_conversaciones c on c.id = m.conversacion_id
where m.direccion = 'in' and (m.contenido -> 'referral' ->> 'source_id') is not null
group by m.conversacion_id, m.contenido -> 'referral' ->> 'source_id';
