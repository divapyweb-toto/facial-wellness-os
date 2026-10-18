-- 20261018000001 · Entrada de lote con costo PROMEDIO PONDERADO (Enrique 18-10-2026).
-- costo nuevo = (unidades en stock × costo actual + unidades del lote × costo del lote) ÷ total.
-- Las ventas ya registradas guardaron su costo_prod al venderse: no se tocan. El stock negativo cuenta como 0.
create or replace function public.fw_registrar_lote(p_producto uuid, p_cantidad integer, p_costo_unit numeric, p_motivo text default 'Lote')
returns table (stock_nuevo integer, costo_nuevo integer)
language plpgsql security definer set search_path to 'public' as $$
declare
  prod public.productos%rowtype;
  base integer;
  costo integer;
begin
  if p_cantidad is null or p_cantidad <= 0 then raise exception 'cantidad inválida'; end if;
  if p_costo_unit is null or p_costo_unit <= 0 then raise exception 'costo inválido'; end if;
  select * into prod from public.productos where id = p_producto for update;
  if not found then raise exception 'producto inexistente'; end if;
  if prod.es_combo then raise exception 'un combo no tiene stock propio: cargá sus componentes'; end if;
  base := greatest(prod.stock_actual, 0);
  costo := round((base * coalesce(prod.costo_unit, 0) + p_cantidad * p_costo_unit) / (base + p_cantidad));
  update public.productos set stock_actual = stock_actual + p_cantidad, costo_unit = costo where id = prod.id;
  insert into public.stock_movimientos (producto_id, producto_nombre, tipo, cantidad, motivo)
  values (prod.id, prod.nombre, 'compra', p_cantidad, p_motivo || ' · costo lote ' || p_costo_unit || ' → promedio ' || costo);
  return query select prod.stock_actual + p_cantidad, costo;
end;
$$;
revoke all on function public.fw_registrar_lote(uuid, integer, numeric, text) from public, anon;
grant execute on function public.fw_registrar_lote(uuid, integer, numeric, text) to authenticated, service_role;
