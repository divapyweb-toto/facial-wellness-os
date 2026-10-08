-- ═══════════════════════════════════════════════════════════
-- Pagado en Shopify = cuando el courier RINDE (Excel de Lucero/PaP), no al entregar.
-- Agrega `rendido` a la vista y deja de listar como pendiente al pedido entregado
-- cuyo único faltante es el pago y todavía no fue rendido (si no, la función lo
-- reintentaría cada 30 min para nada). Idempotente. No toca datos.
-- ═══════════════════════════════════════════════════════════
create or replace view public.post_entrega_pendientes
with (security_invoker = true) as
select p.shopify_order_id, p.nombre, p.cliente_id, p.telefono, p.total, p.tags, p.creado_en,
       p.entregado_en, p.pagado_marcado, p.capi_enviado, p.capi_omitido, p.post_entrega_intentos,
       e.creado_en as entregado_registrado_en,
       e.fuente    as entregado_fuente_estado,
       exists (select 1 from public.pedido_estados r
                where r.shopify_order_id = p.shopify_order_id and r.estado = 'RENDIDO') as rendido
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
