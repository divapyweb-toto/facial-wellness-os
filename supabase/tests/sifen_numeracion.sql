-- supabase/tests/sifen_numeracion.sql · prueba MANUAL de la numeración SIFEN (migración 20261008000010).
-- Correr en el SQL Editor de Supabase (o psql) DESPUÉS de aplicar la migración. Todo va dentro de una
-- transacción que termina en ROLLBACK: no deja nada grabado. Datos inventados.
--
-- Concurrencia real (dos sesiones): abrir dos pestañas del SQL Editor y correr a la vez
--   begin; select public.sifen_siguiente_numero('00000000-prueba','001','001',1); select pg_sleep(5); commit;
-- La segunda espera a la primera (bloqueo de fila) y recibe el número siguiente: nunca el mismo.

begin;

-- 1. Correlativo sin saltos por serie, y series independientes.
do $$
declare a int; b int; c int; x int;
begin
  a := public.sifen_siguiente_numero('00000000-prueba', '001', '001', 1);
  b := public.sifen_siguiente_numero('00000000-prueba', '001', '001', 1);
  c := public.sifen_siguiente_numero('00000000-prueba', '001', '001', 1);
  x := public.sifen_siguiente_numero('00000000-prueba', '001', '001', 5); -- NC: otra serie
  assert a = 1 and b = 2 and c = 3, format('correlativo: %s %s %s', a, b, c);
  assert x = 1, format('la serie de NC empieza en 1, vino %s', x);
  raise notice 'OK 1: correlativo 1,2,3 y serie NC independiente';
end $$;

-- 2. sifen_asignar_numero: asigna y graba en la factura en la misma transacción; idempotente.
do $$
declare f uuid; r1 record; r2 record;
begin
  insert into public.facturas (shopify_order_id, tipo_documento, establecimiento, punto, timbrado, ambiente, emisor, estado, intentos)
  values (-999001, 1, '001', '001', '00000000', 'test', 'propio', 'pendiente', 0) returning id into f;
  select * into r1 from public.sifen_asignar_numero(f, '00000000-prueba', '123456789', now());
  select * into r2 from public.sifen_asignar_numero(f, '00000000-prueba', '999999999', now() + interval '1 day');
  assert r1.numero = 4, format('esperaba 4, vino %s', r1.numero);
  assert r1.numero_completo = '001-001-0000004', r1.numero_completo;
  assert r2.numero = r1.numero and r2.codigo_seguridad = '123456789', 'la segunda llamada no debe cambiar nada';
  raise notice 'OK 2: asignar número idempotente (%)', r1.numero_completo;
end $$;

-- 3. Una sola FE por pedido (índice único parcial) pero se permite su NC.
do $$
declare f uuid;
begin
  select id into f from public.facturas where shopify_order_id = -999001 and tipo_documento = 1;
  begin
    insert into public.facturas (shopify_order_id, tipo_documento, ambiente, emisor, estado, intentos) values (-999001, 1, 'test', 'propio', 'pendiente', 0);
    raise exception 'se permitió una segunda FE para el mismo pedido';
  exception when unique_violation then
    raise notice 'OK 3a: segunda FE rechazada (23505)';
  end;
  insert into public.facturas (shopify_order_id, tipo_documento, factura_original_id, ambiente, emisor, estado, intentos)
  values (-999001, 5, f, 'test', 'propio', 'pendiente', 0);
  begin
    insert into public.facturas (shopify_order_id, tipo_documento, factura_original_id, ambiente, emisor, estado, intentos)
    values (-999001, 5, f, 'test', 'propio', 'pendiente', 0);
    raise exception 'se permitió una segunda NC para la misma factura';
  exception when unique_violation then
    raise notice 'OK 3b: una sola NC por factura';
  end;
end $$;

-- 4. tomar_factura: lease atómico.
do $$
declare f uuid; t1 boolean; t2 boolean;
begin
  select id into f from public.facturas where shopify_order_id = -999001 and tipo_documento = 1;
  select tomada into t1 from public.tomar_factura(f, 5);
  select tomada into t2 from public.tomar_factura(f, 5);
  assert t1 and not t2, format('lease: %s %s', t1, t2);
  raise notice 'OK 4: el segundo no toma la factura mientras dura el lease';
end $$;

-- 5. Estados nuevos: 'emitida' ya no es válido.
do $$
begin
  update public.facturas set estado = 'emitida' where shopify_order_id = -999001 and tipo_documento = 1;
  raise exception 'se aceptó el estado viejo emitida';
exception when check_violation then
  raise notice 'OK 5: check de estados nuevo';
end $$;

rollback;
