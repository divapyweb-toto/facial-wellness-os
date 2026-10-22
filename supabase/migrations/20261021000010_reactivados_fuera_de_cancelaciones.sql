-- 20261021000010 · Un pedido cancelado que el cliente REACTIVÓ (etiqueta REACTIVADO, wa-webhook/reactivacion.ts) deja de
-- figurar como cancelado: sale de ventas_cancelacion_shopify → sin banner rojo en Despacho, sin aviso y sin cancelar la
-- venta (Enrique 22-10). Misma vista que 20261021000003 con esa sola condición más.

create or replace view public.ventas_cancelacion_shopify as
with canc as (
  select sp.shopify_order_id, sp.nombre, sp.cliente_id, (sp.raw ->> 'cancelled_at')::timestamptz as cancelado_en,
    'VT-' || replace(sp.nombre, '#', '') as ref
  from public.shopify_pedidos sp
  where sp.nombre ~ '^#[0-9]+$' and not sp.es_borrador
    and sp.creado_en >= now() - interval '30 days'
    and ((sp.raw ->> 'cancelled_at') is not null or 'CANCELADO_CLIENTE' = any (sp.tags))
    and not ('REACTIVADO' = any (sp.tags))
), v as (
  select c.*, count(x.id) as lineas, bool_or(x.despachado_at is not null) as despachada,
    max(x.transportadora) as transportadora, min(x.fecha) as fecha_venta
  from canc c join public.ventas x on x.n_referencia = c.ref and x.deleted_at is null and x.tienda = 'voltra'
  group by c.shopify_order_id, c.nombre, c.cliente_id, c.cancelado_en, c.ref
)
select v.shopify_order_id, v.nombre, v.ref, v.cancelado_en, v.lineas, v.transportadora,
  e.estado_pap as estado_courier, e.transportadora as courier_real,
  (current_date - v.fecha_venta) as dias_desde_venta,
  (exists (select 1 from public.shopify_pedidos r where r.shopify_order_id <> v.shopify_order_id
            and exists (select 1 from unnest(r.tags) t where upper(t) = 'REEMPLAZA_A_' || upper(v.nombre)))) as reemplazado,
  (v.despachada or coalesce(trim(e.estado_pap), '') <> '') as salio,
  case
    when not (v.despachada or coalesce(trim(e.estado_pap), '') <> '') then 'cancelar'
    when exists (select 1 from public.shopify_pedidos r where r.shopify_order_id <> v.shopify_order_id
                  and exists (select 1 from unnest(r.tags) t where upper(t) = 'REEMPLAZA_A_' || upper(v.nombre))) then 'reemplazo_en_courier'
    else 'cancelado_en_courier'
  end as clase
from v left join lateral (
  select * from public.entregas en where en.n_referencia = v.ref order by (coalesce(trim(en.estado_pap), '') <> '') desc, en.created_at desc limit 1
) e on true;
