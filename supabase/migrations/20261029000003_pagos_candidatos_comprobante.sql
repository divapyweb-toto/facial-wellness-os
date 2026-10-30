-- 29-10 · pagos_candidatos.comprobante_en_chat mira el comprobante REAL del chat (agente F).
-- Hasta hoy miraba la etiqueta PAGO_ANTICIPADO_COMPROBANTE, que ningún código pone desde el 12-10: el comprobante
-- queda en wa_mensajes.contenido.comprobante_pago_anticipado (wa-webhook) y la columna daba siempre false (caso #1164).
-- Ahora: hay comprobante si el cliente del pedido mandó una imagen o PDF marcada como comprobante DESPUÉS de crear el
-- pedido (marca = el pedido, o mismo cliente_id, o mismo celular: últimos 9 dígitos), salvo que el clasificador la haya
-- descartado (comprobante_clasificado.es = false). La etiqueta vieja sigue contando por si alguien la pone a mano.
-- Columna nueva al final: comprobante_ultimo_en (hora del último comprobante), para ordenar por cercanía.
-- Sin datos personales en la vista (igual que antes).
--
-- Vuelta atrás (vuelve a la definición del 27-10; comprobante_ultimo_en desaparece):
--   drop view public.pagos_candidatos;
--   y volver a correr el bloque "create or replace view public.pagos_candidatos" de 20261027000004_pagos_verificados.sql.

create or replace view public.pagos_candidatos with (security_invoker = true) as
with p as (
  select sp.shopify_order_id, sp.nombre, sp.estado_envio, sp.creado_en, sp.total, sp.cliente_id, sp.telefono,
         coalesce(sp.tags, '{}'::text[]) as tags
  from public.shopify_pedidos sp
  where not coalesce(sp.es_borrador, false)
    and sp.raw->>'cancelled_at' is null
    and coalesce(sp.estado_envio, '') <> 'CANCELADO'
    and sp.creado_en > now() - interval '60 days'
),
c as (
  select p.shopify_order_id,
         (select max(m.creado_en)
            from public.wa_mensajes m
            left join public.wa_clientes wc on wc.id = m.cliente_id
           where m.direccion = 'in'
             and m.tipo in ('image', 'document')
             and m.contenido ? 'comprobante_pago_anticipado'
             and coalesce(m.contenido->'comprobante_clasificado'->>'es', 'true') <> 'false'
             and m.creado_en >= p.creado_en
             and (m.contenido->>'comprobante_pago_anticipado' = p.shopify_order_id::text
                  or (p.cliente_id is not null and m.cliente_id = p.cliente_id)
                  or (length(right(regexp_replace(coalesce(p.telefono, ''), '\D', '', 'g'), 9)) = 9
                      and right(regexp_replace(coalesce(wc.telefono, ''), '\D', '', 'g'), 9)
                        = right(regexp_replace(p.telefono, '\D', '', 'g'), 9)))) as ultimo
  from p
)
select p.shopify_order_id,
       p.nombre as pedido,
       case when 'SALDO_PENDIENTE' = any(p.tags) then 'saldo_pendiente'
            when 'SIN_COBERTURA' = any(p.tags) then 'sin_cobertura'
            else 'oferta_pago_anticipado' end as motivo,
       case when 'SALDO_PENDIENTE' = any(p.tags)
            then (select substring(t from '^SALDO_(\d+)$')::int from unnest(p.tags) t where t ~ '^SALDO_\d+$' limit 1)
            else round(p.total)::int end as monto_pendiente,
       ('PAGO_ANTICIPADO_COMPROBANTE' = any(p.tags) or c.ultimo is not null) as comprobante_en_chat,
       p.estado_envio,
       p.creado_en,
       c.ultimo as comprobante_ultimo_en
from p
join c on c.shopify_order_id = p.shopify_order_id
where (p.tags && array['OFERTA_PAGO_ANTICIPADO', 'SIN_COBERTURA', 'SALDO_PENDIENTE'])
  and not (p.tags && array['PAGADO', 'PAGO_VERIFICADO', 'PAGADO_QR'])
  and not exists (select 1 from unnest(p.tags) t where t like '%CANCELADO%' or t like 'REEMPLAZADO_POR_%')
  -- Ya entregado o rendido: pagó al recibir (salvo un saldo pendiente).
  and (coalesce(p.estado_envio, '') not in ('ENTREGADO', 'RENDIDO') or 'SALDO_PENDIENTE' = any(p.tags));
