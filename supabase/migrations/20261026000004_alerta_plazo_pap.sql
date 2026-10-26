-- 20261026000004 · Alerta de plazo PaP (Enrique 26-10-2026). Pedidos de Voltra en PaP que siguen en "En Oficina",
-- "Asignado a ruta" o "Borrador" (sin importar mayúsculas ni tildes). La fecha de la venta sale de ventas.fecha (si la
-- entrega no tiene venta, fecha_ingreso). Los días hábiles y el umbral (> 5) se calculan en la Edge Function
-- pedidos-trabados (plazo_pap.ts), que avisa por Telegram UNA vez por pedido (candado auto_plazo_pap:<ref>).
-- Fuera: ventas borradas, pedidos de prueba (etiqueta PRUEBA), cancelados o reemplazados en Shopify. Sin nombre ni teléfono.
create or replace view public.entregas_plazo_pap with (security_invoker = true) as
select e.n_referencia as ref, coalesce(nullif(trim(e.ciudad), ''), v.ciudad) as ciudad, trim(e.estado_pap) as estado,
  coalesce(v.fecha, e.fecha_ingreso) as fecha_venta, nullif(trim(e.nro_guia_pap), '') as guia
from public.entregas e
left join lateral (
  select x.* from public.ventas x
  where x.deleted_at is null and (x.id = e.venta_id or (e.venta_id is null and x.n_referencia = e.n_referencia))
  order by x.created_at limit 1
) v on true
where e.tienda = 'voltra' and e.transportadora = 'pap' and e.categoria is distinct from 'entregado'
  and translate(lower(trim(e.estado_pap)), 'áéíóú', 'aeiou') in ('en oficina', 'asignado a ruta', 'borrador')
  and coalesce(v.fecha, e.fecha_ingreso) is not null
  and e.n_referencia !~* 'prueba|test'
  and not exists (select 1 from public.ventas x where x.id = e.venta_id and x.deleted_at is not null)
  and not exists (
    select 1 from public.shopify_pedidos sp
    where sp.nombre = '#' || replace(e.n_referencia, 'VT-', '') and not sp.es_borrador
      and ((sp.raw ->> 'cancelled_at') is not null
        or exists (select 1 from unnest(sp.tags) t where upper(t) like '%PRUEBA%' or upper(t) like 'REEMPLAZADO%'
                     or upper(t) = 'CANCELADO_CLIENTE'))
  );

grant select on public.entregas_plazo_pap to authenticated, service_role;
