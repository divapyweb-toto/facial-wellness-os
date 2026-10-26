-- ═══════════════════════════════════════════════════════════
-- 26-10-2026 · Ciudades mal escritas en ventas (90 días) sin tarifa.
-- La normalización ya existía (ciudad_norm/ciudad_clave: minúsculas, sin tildes,
-- sin signos) y tarifa_courier/sugerir_courier/motor_courier ya la usan. Faltaban
-- grafías reales → alias (los mismos que scripts/tarifas-courier.mjs, para que una
-- carga nueva de tarifas no los borre). courier_prob ahora también usa los alias
-- para ubicar la zona de una ciudad mal escrita.
-- ═══════════════════════════════════════════════════════════
with a(ciudad, nuevos) as (values
  ('ciudad del este',     array['cd del este', 'ciudadde este']),
  ('asuncion',            array['asucion']),
  ('fernando de la mora', array['frenando de la mora']),
  ('salto del guaira',    array['santo del guaira'])
)
update public.tarifas_courier t
   set alias = (select array_agg(distinct x order by x) from unnest(t.alias || a.nuevos) x)
  from a
 where t.ciudad = a.ciudad
   and not (a.nuevos <@ t.alias);

CREATE OR REPLACE FUNCTION public.recalcular_courier_prob()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  hoy date := (now() at time zone 'America/Asuncion')::date;
  k constant integer := 10;
begin
  create temp table _base on commit drop as
    select r.*, tz.zona
    from public.courier_resueltos r
    left join lateral (
      select coalesce(t.zona, t.tiempo) as zona from public.tarifas_courier_vigente t where t.courier = r.courier and (t.ciudad = r.ciudad or r.ciudad = any (t.alias)) order by (t.ciudad = r.ciudad) desc limit 1
    ) tz on true
    where r.fecha_pedido between hoy - 141 and hoy - 21;

  delete from public.courier_prob;
  -- general
  insert into public.courier_prob (nivel, courier, clave, entregados, resueltos, p)
    select 'general', courier, 'general', count(*) filter (where entregado), count(*), count(*) filter (where entregado)::numeric / count(*)
    from _base group by courier;
  -- zona: suavizada hacia el general del courier
  insert into public.courier_prob (nivel, courier, clave, entregados, resueltos, p)
    select 'zona', b.courier, b.zona, count(*) filter (where b.entregado), count(*),
      (count(*) filter (where b.entregado) + k * g.p) / (count(*) + k)
    from _base b join public.courier_prob g on g.nivel = 'general' and g.courier = b.courier
    where b.zona is not null group by b.courier, b.zona, g.p;
  -- ciudad: solo con ≥ 10 resueltos; suavizada hacia su zona (o el general si no tiene zona)
  insert into public.courier_prob (nivel, courier, clave, entregados, resueltos, p)
    select 'ciudad', b.courier, b.ciudad, count(*) filter (where b.entregado), count(*),
      (count(*) filter (where b.entregado) + k * coalesce(z.p, g.p)) / (count(*) + k)
    from _base b
    join public.courier_prob g on g.nivel = 'general' and g.courier = b.courier
    left join public.courier_prob z on z.nivel = 'zona' and z.courier = b.courier and z.clave = b.zona
    where b.ciudad is not null group by b.courier, b.ciudad, z.p, g.p
    having count(*) >= k;

  delete from public.courier_prob_producto;
  insert into public.courier_prob_producto (courier, producto, entregados, resueltos, tasa)
    select courier, producto, count(*) filter (where entregado), count(*), count(*) filter (where entregado)::numeric / count(*)
    from _base where producto <> 'Otros' group by courier, producto;

  delete from public.courier_metricas;
  insert into public.courier_metricas (courier, dias_rendicion, dias_pedido_entrega, devuelto_cobro_extra_pct, n_rendicion, n_plazo)
    select r.courier,
      percentile_cont(0.5) within group (order by r.dias_rendicion) filter (where r.entregado and r.dias_rendicion between 0 and 90),
      percentile_cont(0.5) within group (order by r.dias_pedido_entrega) filter (where r.entregado and r.dias_pedido_entrega between 0 and 90),
      0,
      count(*) filter (where r.entregado and r.dias_rendicion between 0 and 90),
      count(*) filter (where r.entregado and r.dias_pedido_entrega between 0 and 90)
    from public.courier_resueltos r where r.fecha_pedido >= hoy - 141 group by r.courier;

  return jsonb_build_object('ok', true, 'filas', (select count(*) from public.courier_prob));
end $function$;
