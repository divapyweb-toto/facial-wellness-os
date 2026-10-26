-- ═══════════════════════════════════════════════════════════
-- 26-10-2026 · Un Devuelto/Cancelado de Lucero NUNCA cuenta como entregado.
-- Causa: importar-courier registraba RENDIDO también para los devueltos que Lucero
-- incluye en su rendición (cobrado 0), y pedidos_origen_anuncio_todos tomaba
-- RENDIDO = entregado (VT-1003, 1041, 1047, 1091 → Lucero 52/53 en vez de 48/53).
-- 1) pedidos_origen_anuncio_todos: RENDIDO vale solo si no hubo NO_ENTREGADO/CANCELADO.
-- 2) pedidos_entrega: Lucero devuelto/cancelado = PERDIDO antes que cualquier otra regla.
-- Mismas columnas y mismo orden (create or replace). No toca datos.
-- ═══════════════════════════════════════════════════════════
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
         -- 26-10: RENDIDO solo cuenta como entrega si el pedido NUNCA tuvo NO_ENTREGADO/CANCELADO.
         -- Lucero rinde también los devueltos (cobrado 0) y eso los hacía pasar por entregados.
         SELECT pedido_estados.shopify_order_id,
            COALESCE(
              min(pedido_estados.creado_en) FILTER (WHERE pedido_estados.estado = 'ENTREGADO'::text),
              CASE WHEN NOT bool_or(pedido_estados.estado = ANY (ARRAY['NO_ENTREGADO'::text, 'CANCELADO'::text]))
                   THEN min(pedido_estados.creado_en) FILTER (WHERE pedido_estados.estado = 'RENDIDO'::text) END
            ) AS entregado_estado_en
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
  WHERE NOT p.es_borrador;

create or replace view public.pedidos_entrega as
WITH base AS (
         SELECT o.shopify_order_id,
            o.nombre,
            o.referencia,
            (o.creado_en AT TIME ZONE 'America/Asuncion'::text)::date AS fecha,
            o.origen AS canal,
            COALESCE(
                CASE
                    WHEN o.origen = 'whatsapp'::text THEN o.anuncio_wa
                    ELSE NULL::text
                END,
                CASE
                    WHEN o.utm_content ~ '^\d{10,}$'::text THEN o.utm_content
                    ELSE NULL::text
                END, ( SELECT c_1.ad_id
                   FROM creativos_diario c_1
                  WHERE c_1.ad_nombre = o.utm_content
                  ORDER BY c_1.fecha DESC
                 LIMIT 1)) AS ad_id,
            o.entregado,
            COALESCE(o.estado_confirmacion, 'pendiente'::text) AS estado_confirmacion
           FROM pedidos_origen_anuncio_todos o
             JOIN shopify_pedidos sp ON sp.shopify_order_id = o.shopify_order_id
          WHERE ((sp.raw ->> 'cancelled_at'::text) IS NULL OR o.estado_confirmacion ~~ 'cancelado%'::text) AND NOT (EXISTS ( SELECT 1
                   FROM unnest(sp.tags) t(t)
                  WHERE upper(t.t) ~~ '%PRUEBA%'::text OR upper(t.t) ~~ 'REEMPLAZADO%'::text)) AND o.nombre !~~* '%prueba%'::text
        ), con_envio AS (
         SELECT b.shopify_order_id,
            b.nombre,
            b.referencia,
            b.fecha,
            b.canal,
            b.ad_id,
            b.entregado,
            b.estado_confirmacion,
            en.transportadora,
            en.estado_pap AS estado_courier,
            en.motivo,
            en.custodia_desde,
            COALESCE(en.fecha_ingreso::timestamp with time zone, en.created_at) AS gestion_desde,
            (EXISTS ( SELECT 1
                   FROM ventas v
                  WHERE v.n_referencia = b.referencia AND v.reingresado_at IS NOT NULL)) AS reingresado
           FROM base b
             LEFT JOIN LATERAL ( SELECT e.nro_guia_pap,
                    e.n_referencia,
                    e.estado_pap,
                    e.categoria,
                    e.motivo,
                    e.importe,
                    e.cobrado,
                    e.costo_envio,
                    e.fecha_ingreso,
                    e.fecha_entrega,
                    e.dias_entrega,
                    e.mensajero,
                    e.ciudad,
                    e.producto,
                    e.mes,
                    e.created_at,
                    e.rendido,
                    e.fecha_rendido,
                    e.dias_rendicion,
                    e.transportadora,
                    e.neto_depositado,
                    e.guia_transportadora,
                    e.venta_id,
                    e.vinculo_metodo,
                    e.vinculo_at,
                    e.telefono_courier,
                    e.nombre_courier,
                    e.direccion_courier,
                    e.tienda,
                    e.lucero_consultado_en,
                    e.lucero_web_error,
                    e.custodia_desde
                   FROM entregas e
                  WHERE e.n_referencia = b.referencia
                  ORDER BY e.created_at DESC
                 LIMIT 1) en ON true
        )
 SELECT shopify_order_id,
    nombre,
    referencia,
    fecha,
    canal,
    ad_id,
    entregado,
    estado_confirmacion,
    transportadora,
    estado_courier,
    motivo,
    custodia_desde,
    gestion_desde,
    reingresado,
    estado_confirmacion = ANY (ARRAY['confirmado'::text, 'cancelado_cliente'::text]) AS confirmado,
        CASE
            WHEN transportadora = 'lucero'::text AND COALESCE(estado_courier, ''::text) ~* '^\s*(devuelto|cancelado)\s*$'::text THEN 'PERDIDO'::text
            WHEN entregado OR COALESCE(estado_courier, ''::text) ~* '^entregado$'::text THEN 'ENTREGADO'::text
            WHEN estado_confirmacion = 'cancelado_cliente'::text OR reingresado THEN 'PERDIDO'::text
            WHEN estado_confirmacion ~~ 'cancelado_sin%'::text THEN 'NO_CONFIRMADO'::text
            WHEN estado_confirmacion <> 'confirmado'::text THEN 'SIN_CONFIRMAR'::text
            WHEN transportadora = 'lucero'::text AND COALESCE(estado_courier, ''::text) ~* '^\s*(devuelto|cancelado)\s*$'::text THEN 'PERDIDO'::text
            WHEN transportadora = 'pap'::text AND COALESCE(estado_courier, ''::text) ~* 'no ingreso|borrador'::text THEN 'NO_SALIO'::text
            WHEN transportadora = 'pap'::text AND COALESCE(estado_courier, ''::text) ~* 'custodi|inubicable|no gestionado|fuera de cobertura|rechaz|devoluci|devuelto|cancelad'::text THEN 'PERDIDO'::text
            ELSE 'EN_GESTION'::text
        END AS grupo,
    COALESCE(estado_courier, ''::text) ~* 'custodi'::text AS en_custodia
   FROM con_envio c;

revoke all on public.pedidos_origen_anuncio_todos from anon;
grant select on public.pedidos_origen_anuncio_todos to authenticated, service_role;
grant select on public.pedidos_entrega to authenticated, service_role;
