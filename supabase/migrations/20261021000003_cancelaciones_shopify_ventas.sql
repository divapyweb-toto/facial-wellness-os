-- 20261021000003 · Cuando un pedido se cancela en Shopify, la venta de Voltra OS se entera (Enrique 21-10-2026).
-- Caso #1091: cancelado en Shopify el 21-10 19:13 y la venta VT-1091 seguía 'pendiente' (y Lucero "Aceptado").
-- Cancelado = cancelled_at con dato O etiqueta CANCELADO_CLIENTE (como #1095, que tiene la etiqueta sin cancelled_at).
--
-- Clases (vista ventas_cancelacion_shopify, solo Voltra, últimos 30 días, ventas vivas):
--   cancelar               → la venta NO salió (sin despachado_at y sin estado real del courier): se cancela sola.
--   cancelado_en_courier   → ya está en el courier: NO se cancela sola; aviso por Telegram a Enrique.
--   reemplazo_en_courier   → un pedido nuevo (etiqueta REEMPLAZA_A_#n) reemplaza a este que ya está en el courier:
--                            el nuevo NO se carga como envío nuevo; se vincula a la venta existente.
-- "Salió" = despachado_at, o una fila en entregas con estado real (el placeholder de Lucero, con estado vacío, no cuenta).
-- OJO: NUNCA se usa el fulfillment de Shopify como señal de "salió": la importación lo crea al cargar la venta.

create or replace view public.ventas_cancelacion_shopify as
with canc as (
  select sp.shopify_order_id, sp.nombre, sp.cliente_id, (sp.raw ->> 'cancelled_at')::timestamptz as cancelado_en,
    'VT-' || replace(sp.nombre, '#', '') as ref
  from public.shopify_pedidos sp
  where sp.nombre ~ '^#[0-9]+$' and not sp.es_borrador
    and sp.creado_en >= now() - interval '30 days'
    and ((sp.raw ->> 'cancelled_at') is not null or 'CANCELADO_CLIENTE' = any (sp.tags))
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

-- Cancela la venta de un pedido cancelado en Shopify SI NO SALIÓ: devuelve el stock descontado, la manda a la papelera
-- (deleted_at, como "Mover a la papelera" de Ventas: se puede recuperar), la marca cancelada y saca el placeholder de
-- Lucero. Si salió (o no existe), no hace nada y lo dice.
create or replace function public.cancelar_venta_por_shopify(p_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c record; l record; n integer := 0; devueltas integer := 0;
begin
  select * into c from public.ventas_cancelacion_shopify where ref = p_ref;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'no_aplica'); end if;
  if c.clase <> 'cancelar' then return jsonb_build_object('ok', false, 'motivo', c.clase); end if;
  for l in select * from public.ventas where n_referencia = p_ref and deleted_at is null and despachado_at is null for update loop
    if l.afecta_stock and coalesce(l.stock_descontado, false) and l.reingresado_at is null then
      perform public.fw_mover_stock(l.producto_id, l.producto_nombre, l.cantidad, 'devolucion', 'Cancelado en Shopify ' || p_ref);
      devueltas := devueltas + 1;
    end if;
    update public.ventas set deleted_at = now(), stock_descontado = false, estado_releasit = 'cancelado',
      notas = trim(both E'\n' from coalesce(notas, '') || E'\n' || 'Cancelado en Shopify (' || to_char(now() at time zone 'America/Asuncion', 'DD-MM HH24:MI') || '): se devolvió el stock.')
    where id = l.id;
    n := n + 1;
  end loop;
  delete from public.entregas where n_referencia = p_ref and coalesce(trim(estado_pap), '') = '' and transportadora = 'lucero';
  return jsonb_build_object('ok', true, 'lineas', n, 'stock_devuelto_en', devueltas);
end $$;
revoke all on function public.cancelar_venta_por_shopify(text) from public, anon, authenticated;
grant execute on function public.cancelar_venta_por_shopify(text) to service_role;
grant select on public.ventas_cancelacion_shopify to authenticated, service_role;
