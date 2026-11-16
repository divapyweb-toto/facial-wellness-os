-- Definición previa (16-11-2026) de las dos vistas, para volver atrás la EXPRESIÓN de anuncio_wa sin quitar columnas: reemplazar la expresión nueva por esta.
-- pedidos_origen_anuncio:
/*
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
            WHEN lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL THEN COALESCE(( SELECT c.origen_anuncio_id
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
        END AS entregado_en
   FROM shopify_pedidos p
     LEFT JOIN na ON na.shopify_order_id = p.shopify_order_id
     LEFT JOIN est ON est.shopify_order_id = p.shopify_order_id
  WHERE NOT p.es_borrador AND (COALESCE(p.estado_confirmacion, ''::text) <> ALL (ARRAY['cancelado_cliente'::text, 'cancelado_sin_respuesta'::text]))
*/
-- pedidos_origen_anuncio_todos:
/*
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
            WHEN lower(COALESCE(na.origen_attr, ''::text)) = 'whatsapp'::text OR na.conversacion_id IS NOT NULL THEN COALESCE(( SELECT c.origen_anuncio_id
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
    p.estado_confirmacion
   FROM shopify_pedidos p
     LEFT JOIN na ON na.shopify_order_id = p.shopify_order_id
     LEFT JOIN est ON est.shopify_order_id = p.shopify_order_id
  WHERE NOT p.es_borrador
*/
