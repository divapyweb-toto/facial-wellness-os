-- ═══════════════════════════════════════════════════════════
-- Arreglos del servidor (revisión del 09-10-2026). Idempotente. No toca datos.
-- 1) post_entrega_pendientes expone post_entrega_procesado_en (al final, para que
--    `create or replace view` no cambie columnas existentes). La función post-entrega
--    ordena por esa columna (nulls first) para rotar y que los viejos no tapen a los nuevos.
-- 2) facturas: una factura (tipo 1) por pedido Y por ambiente. Antes una de prueba (test)
--    bloqueaba la real (prod) del mismo pedido.
-- 3) envios_programados.wa_message_id.
-- Aplicar ANTES de desplegar post-entrega y sifen-cola.
-- ═══════════════════════════════════════════════════════════

-- 1) Vista (misma definición que 20261008000001_pagado_al_rendir.sql + 1 columna al final).
create or replace view public.post_entrega_pendientes
with (security_invoker = true) as
select p.shopify_order_id, p.nombre, p.cliente_id, p.telefono, p.total, p.tags, p.creado_en,
       p.entregado_en, p.pagado_marcado, p.capi_enviado, p.capi_omitido, p.post_entrega_intentos,
       e.creado_en as entregado_registrado_en,
       e.fuente    as entregado_fuente_estado,
       exists (select 1 from public.pedido_estados r
                where r.shopify_order_id = p.shopify_order_id and r.estado = 'RENDIDO') as rendido,
       p.post_entrega_procesado_en
  from public.pedido_estados e
  join public.shopify_pedidos p on p.shopify_order_id = e.shopify_order_id
 where e.estado = 'ENTREGADO'
   and not p.es_borrador
   and p.estado_confirmacion not in ('cancelado_cliente','cancelado_sin_respuesta')
   and (p.entregado_en is null
        or (not p.pagado_marcado
            and exists (select 1 from public.pedido_estados r
                         where r.shopify_order_id = p.shopify_order_id and r.estado = 'RENDIDO'))
        or (not p.capi_enviado and p.capi_omitido is null));

revoke all on public.post_entrega_pendientes from anon;
grant select on public.post_entrega_pendientes to authenticated, service_role;

-- 2) Índice único de factura por pedido, ahora por ambiente.
drop index if exists public.facturas_una_fe_por_pedido;
create unique index if not exists facturas_una_fe_por_pedido_ambiente
  on public.facturas (shopify_order_id, ambiente) where tipo_documento = 1 and shopify_order_id is not null;

-- 3) envios_programados guarda el id del WhatsApp enviado (procesar-envios reintenta el update
--    tras un envío exitoso y deja constancia del mensaje; el código funciona aunque falte).
alter table public.envios_programados add column if not exists wa_message_id text;
