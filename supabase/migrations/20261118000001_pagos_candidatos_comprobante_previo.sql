-- 18-11-2026 · FUNCIONES · pagos_candidatos: acepta el comprobante que llegó hasta 30 min ANTES de crearse el pedido, SOLO si
-- está marcado con ESE pedido (contenido.comprobante_pago_anticipado = shopify_order_id; lo escribe seguimiento-chat con
-- comprobante_previo, interruptor config_wa.pago_anticipado.comprobante_previo de WhatsApp API). Caso #1239 (comprobante 22 s antes).
-- Sin esa marca, todo queda igual que antes. Mismo criterio en pago-verificado/logica.ts (comprobanteEnVentana).
-- VOLVER ATRÁS: recrear la vista con la condición vieja: reemplazar la línea
--   (m.creado_en >= p_1.creado_en OR (m.contenido ->> 'comprobante_pago_anticipado') = p_1.shopify_order_id::text AND m.creado_en >= (p_1.creado_en - '00:30:00'::interval))
-- por  m.creado_en >= p_1.creado_en  (definición original: migración 20261029000003).
create or replace view public.pagos_candidatos with (security_invoker = true) as
WITH p AS (
         SELECT sp.shopify_order_id,
            sp.nombre,
            sp.estado_envio,
            sp.creado_en,
            sp.total,
            sp.cliente_id,
            sp.telefono,
            COALESCE(sp.tags, '{}'::text[]) AS tags
           FROM shopify_pedidos sp
          WHERE NOT COALESCE(sp.es_borrador, false) AND (sp.raw ->> 'cancelled_at'::text) IS NULL AND COALESCE(sp.estado_envio, ''::text) <> 'CANCELADO'::text AND sp.creado_en > (now() - '60 days'::interval)
        ), c AS (
         SELECT p_1.shopify_order_id,
            ( SELECT max(m.creado_en) AS max
                   FROM wa_mensajes m
                     LEFT JOIN wa_clientes wc ON wc.id = m.cliente_id
                  WHERE m.direccion = 'in'::text AND (m.tipo = ANY (ARRAY['image'::text, 'document'::text])) AND m.contenido ? 'comprobante_pago_anticipado'::text AND COALESCE((m.contenido -> 'comprobante_clasificado'::text) ->> 'es'::text, 'true'::text) <> 'false'::text AND (m.creado_en >= p_1.creado_en OR (m.contenido ->> 'comprobante_pago_anticipado'::text) = p_1.shopify_order_id::text AND m.creado_en >= (p_1.creado_en - '00:30:00'::interval)) AND ((m.contenido ->> 'comprobante_pago_anticipado'::text) = p_1.shopify_order_id::text OR p_1.cliente_id IS NOT NULL AND m.cliente_id = p_1.cliente_id OR length("right"(regexp_replace(COALESCE(p_1.telefono, ''::text), '\D'::text, ''::text, 'g'::text), 9)) = 9 AND "right"(regexp_replace(COALESCE(wc.telefono, ''::text), '\D'::text, ''::text, 'g'::text), 9) = "right"(regexp_replace(p_1.telefono, '\D'::text, ''::text, 'g'::text), 9))) AS ultimo
           FROM p p_1
        )
 SELECT p.shopify_order_id,
    p.nombre AS pedido,
        CASE
            WHEN 'SALDO_PENDIENTE'::text = ANY (p.tags) THEN 'saldo_pendiente'::text
            WHEN 'SIN_COBERTURA'::text = ANY (p.tags) THEN 'sin_cobertura'::text
            ELSE 'oferta_pago_anticipado'::text
        END AS motivo,
        CASE
            WHEN 'SALDO_PENDIENTE'::text = ANY (p.tags) THEN ( SELECT "substring"(t.t, '^SALDO_(\d+)$'::text)::integer AS "substring"
               FROM unnest(p.tags) t(t)
              WHERE t.t ~ '^SALDO_\d+$'::text
             LIMIT 1)
            ELSE round(p.total)::integer
        END AS monto_pendiente,
    ('PAGO_ANTICIPADO_COMPROBANTE'::text = ANY (p.tags)) OR c.ultimo IS NOT NULL AS comprobante_en_chat,
    p.estado_envio,
    p.creado_en,
    c.ultimo AS comprobante_ultimo_en
   FROM p
     JOIN c ON c.shopify_order_id = p.shopify_order_id
  WHERE p.tags && ARRAY['OFERTA_PAGO_ANTICIPADO'::text, 'SIN_COBERTURA'::text, 'SALDO_PENDIENTE'::text] AND NOT p.tags && ARRAY['PAGADO'::text, 'PAGO_VERIFICADO'::text, 'PAGADO_QR'::text] AND NOT (EXISTS ( SELECT 1
           FROM unnest(p.tags) t(t)
          WHERE t.t ~~ '%CANCELADO%'::text OR t.t ~~ 'REEMPLAZADO_POR_%'::text)) AND ((COALESCE(p.estado_envio, ''::text) <> ALL (ARRAY['ENTREGADO'::text, 'RENDIDO'::text])) OR ('SALDO_PENDIENTE'::text = ANY (p.tags)));
