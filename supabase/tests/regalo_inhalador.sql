-- Prueba del regalo por etiqueta (20261125000001). Correr con la migración aplicada: supabase db query --linked -o csv -f supabase/tests/regalo_inhalador.sql
-- Todo dentro de begin/rollback; datos inventados (#999901, #999902). Columna resultado: todo OK.
begin;
create temp table res (n serial, paso text, inhal_delta int, esperado int, raspador_delta int);
create temp table base as select (select stock_actual from productos where lower(nombre)='inhalador de menta') i0,
  (select id from productos where nombre ilike 'raspador%' and not coalesce(es_combo,false) order by nombre limit 1) rid;
create temp table base2 as select (select stock_actual from productos where id=(select rid from base)) r0;
create or replace function pg_temp.d() returns int language sql as $$ select (select stock_actual from productos where lower(nombre)='inhalador de menta') - (select i0 from base) $$;
create or replace function pg_temp.r() returns int language sql as $$ select (select stock_actual from productos where id=(select rid from base)) - (select r0 from base2) $$;
create or replace function pg_temp.ok(p text, e int) returns void language sql as $$ insert into res (paso, inhal_delta, esperado, raspador_delta) values (p, pg_temp.d(), e, pg_temp.r()) $$;

insert into shopify_pedidos (shopify_order_id, nombre, tags, es_borrador, creado_en) values (999999000001, '#999901', '{CONFIRMADO,REGALO_INHALADOR}', false, now());
select pg_temp.ok('1 pedido con etiqueta, sin venta', 0);
insert into ventas (producto_id, producto_nombre, cantidad, precio_unit, total, estado, n_referencia, tienda, afecta_stock)
  select rid, 'Raspador PRUEBA', 1, 99000, 99000, 'pendiente', 'VT-999901', 'voltra', true from base;
select pg_temp.ok('2 venta creada (stock descontado)', -1);
insert into ventas (producto_id, producto_nombre, cantidad, precio_unit, total, estado, n_referencia, tienda, afecta_stock)
  select rid, 'Raspador PRUEBA', 1, 0, 0, 'pendiente', 'VT-999901', 'voltra', true from base;
select pg_temp.ok('3 segunda línea del mismo pedido: no repite', -1);
update shopify_pedidos set tags = '{CONFIRMADO,REGALO_INHALADOR,PRIORIDAD}' where shopify_order_id = 999999000001;
select pg_temp.ok('4 cambian otras etiquetas: no repite', -1);
update ventas set estado = 'devuelto' where n_referencia = 'VT-999901';
select pg_temp.ok('5 devuelto sin escanear: no repone', -1);
update ventas set reingresado_at = now(), stock_descontado = false where n_referencia = 'VT-999901';
select pg_temp.ok('6 escaneado en Recepción: repone', 0);
update ventas set estado = 'pendiente' where n_referencia = 'VT-999901';
select pg_temp.ok('7 reactivada: vuelve a descontar', -1);
update shopify_pedidos set tags = '{CANCELADO_CLIENTE,REGALO_INHALADOR}' where shopify_order_id = 999999000001;
select pg_temp.ok('8a cancelado en Shopify, venta viva: sigue descontado', -1);
select cancelar_venta_por_shopify('VT-999901');
select pg_temp.ok('8b cancelar_venta_por_shopify: repone', 0);
update ventas set deleted_at = null, stock_descontado = true where n_referencia = 'VT-999901';
select pg_temp.ok('9a sale de la papelera descontada: descuenta', -1);
delete from ventas where n_referencia = 'VT-999901';
select pg_temp.ok('9b venta borrada: repone', 0);
insert into shopify_pedidos (shopify_order_id, nombre, tags, es_borrador, creado_en) values (999999000002, '#999902', '{CONFIRMADO}', false, now());
insert into ventas (producto_id, producto_nombre, cantidad, precio_unit, total, estado, n_referencia, tienda, afecta_stock)
  select rid, 'Raspador PRUEBA', 1, 99000, 99000, 'pendiente', 'VT-999902', 'voltra', true from base;
select pg_temp.ok('10a pedido sin etiqueta: nada', 0);
update shopify_pedidos set tags = '{CONFIRMADO,regalo_inhalador}' where shopify_order_id = 999999000002;
select pg_temp.ok('10b etiqueta agregada después (minúsculas): descuenta', -1);
update shopify_pedidos set tags = '{CONFIRMADO,REGALO_INHALADOR}' where shopify_order_id = 999999000002;
select pg_temp.ok('10c misma etiqueta otra vez: no repite', -1);
update shopify_pedidos set tags = '{CONFIRMADO}' where shopify_order_id = 999999000002;
select pg_temp.ok('10d etiqueta sacada: repone', 0);
insert into res (paso, inhal_delta, esperado) select 'movimientos regalo: ' || count(*) || ' (esperado 8: 3+3 de VT-999901, 1+1 de VT-999902)', 0, 0 from stock_movimientos where motivo like 'Regalo REGALO_INHALADOR %VT-99990_';
insert into res (paso, inhal_delta, esperado) select 'regalos_stock ' || ref || ' veces=' || veces || ' descontado=' || descontado || ' error=' || coalesce(error,'-'), 0, 0 from regalos_stock;
select n, paso, inhal_delta, esperado, case when inhal_delta = esperado then 'OK' else 'MAL' end as resultado, raspador_delta from res order by n;
rollback;
