-- 02-11-2026 · Motor de courier en prueba (plan 02-11 → 09-11), SOLO MEDICIÓN.
-- Despacho ya anota en ventas.courier_motor / courier_regla lo que elegiría el motor al cargar cada venta
-- (ver aplicarMotorLote). Esta vista lee esa anotación y la compara con el courier real. No asigna nada:
-- config.motor_courier sigue {"activo": false}; no hay trigger, cron ni tabla nuevos.
-- ganancia_* se calcula al leer con motor_courier (datos del día), una fila por pedido.
create or replace view public.courier_motor_prueba with (security_invoker = true) as
with ped as (
  select v.n_referencia, min(v.fecha) as fecha, max(v.ciudad) as ciudad, bool_or(coalesce(v.pago_anticipado, false)) as pagado,
    sum(v.total) as cobro,
    -- Una decisión por caja: JawFlex rige el pedido entero (igual que infoPorReferencia en la web).
    (array_agg(v.producto_nombre order by (public.familia_producto(v.producto_nombre) = 'JawFlex') desc, v.id))[1] as producto,
    max(v.courier_motor) as motor, max(v.courier_regla) as regla,
    max(case when v.metodo_envio_nombre ilike '%lucero%' then 'lucero'
             when v.metodo_envio_nombre ilike '%punto a punto%' then 'pap' end) as metodo,
    max(v.transportadora) filter (where v.transportadora in ('pap', 'lucero')) as cargado
  from public.ventas v
  where v.deleted_at is null and not coalesce(v.es_mayorista, false) and v.n_referencia is not null and v.fecha >= '2026-10-26'
  group by v.n_referencia
), con as (
  select p.*, e.transportadora as salio, coalesce(e.transportadora, p.metodo, p.cargado) as elegido,
    public.motor_courier(p.ciudad, p.producto, p.cobro, null, not p.pagado) as m
  from ped p
  left join lateral (select x.transportadora from public.entregas x where x.n_referencia = p.n_referencia order by x.created_at desc limit 1) e on true
)
select c.n_referencia, c.fecha, c.fecha between date '2026-11-02' and date '2026-11-09' as semana_prueba,
  c.ciudad, not c.pagado as cod, c.producto, c.cobro, c.motor, c.regla, c.elegido, c.salio is not null as ya_salio,
  c.motor is not distinct from c.elegido as coincide,
  gm.g as ganancia_motor, ge.g as ganancia_elegido, gm.g - ge.g as diferencia, c.m ->> 'motivo' as motivo
from con c
left join lateral (select (o ->> 'ganancia_esperada')::numeric as g from jsonb_array_elements(c.m -> 'opciones') o where o ->> 'courier' = c.motor) gm on true
left join lateral (select (o ->> 'ganancia_esperada')::numeric as g from jsonb_array_elements(c.m -> 'opciones') o where o ->> 'courier' = c.elegido) ge on true;

revoke all on public.courier_motor_prueba from anon;
grant select on public.courier_motor_prueba to authenticated, service_role;
