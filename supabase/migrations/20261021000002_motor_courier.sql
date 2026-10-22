-- 20261021000002 · Motor de decisión de courier (Enrique 21-10-2026).
-- Cada pedido sale por el courier que deja MÁS GANANCIA ESPERADA (no el flete más barato). Un solo lugar:
-- la función public.motor_courier(); Despacho, el resumen diario y los avisos la llaman.
--
--   ganancia = p × (cobro − costo_producto) − flete − (1 − p) × costo_devolución_extra − costo_caja
--   costo_caja = cobro × días_de_rendición_medidos × config.valor_dia_caja
--
-- p (probabilidad de entrega) con datos medidos, por niveles y suavizada:
--   ciudad+courier (si tiene ≥ 10 resueltos) → zona+courier → courier en general.
--   p_nivel = (entregados + 10 × p_del_nivel_de_arriba) / (resueltos + 10).
--   Ventana: pedidos de hace 21 a 141 días (los últimos 21 días todavía no muestran sus devueltos).
--   Ajuste por producto: con ≥ 30 resueltos del producto en ese courier, p × (tasa del producto ÷ tasa general del courier).
-- Se recalcula sola cada noche (cron). Nada de números fijos en el código: lo editable vive en config.

insert into public.config (clave, valor) values
  ('valor_dia_caja', '0.002'),                  -- 0,2 % del cobro por día que el courier retiene la plata
  ('margen_desempate', '3000'),                 -- Gs: si la ganancia esperada difiere menos que esto, gana el que rinde más rápido
  ('motor_courier', '{"activo": false, "desde": null}'),
  ('motor_ajuste_producto', 'no'),           -- 'si' | 'no': ajuste de p por producto. 22-10 (Enrique): apagado; JawFlex ya lo cubre la regla dura
  ('motor_ganancia_minima_pap', '10000'),    -- Gs: PaP solo desplaza a Lucero si gana por esta diferencia o más (cubre el plazo, que la fórmula no mide)
  ('motor_resueltos_minimos', '20')           -- p de LOS DOS couriers (ciudad o zona) con al menos estos resueltos para pasar de Lucero a PaP   -- false = solo sugiere (como hoy); true = asigna solo al cargar
on conflict (clave) do nothing;

-- Familia de producto (misma lógica que familia() del resumen y familiaProducto del front).
create or replace function public.familia_producto(t text) returns text language sql immutable as $$
  select case
    when t ~* 'pack|gudair' then 'Pack'
    when t ~* 'raspador|lengua' then 'Raspador'
    when t ~* 'tira|nasal' then 'Tiras'
    when t ~* 'parche|bucal' then 'Parches'
    when t ~* 'jaw|mand[ií]bula|ejercitador' then 'JawFlex'
    when t ~* 'botella' then 'Botella'
    else 'Otros' end
$$;

alter table public.ventas add column if not exists courier_motor text;      -- lo que habría elegido el motor al cargar
alter table public.ventas add column if not exists courier_regla text;

-- Un renglón por envío resuelto (entregado / devuelto). Fecha del pedido: la de la venta, o la de ingreso si no hay venta.
drop view if exists public.courier_rendimiento;
drop view if exists public.courier_resueltos cascade;
create view public.courier_resueltos as
select e.nro_guia_pap, e.transportadora as courier, public.ciudad_norm(e.ciudad) as ciudad, e.ciudad as ciudad_original,
  coalesce(e.tienda, v.tienda) as tienda,
  public.familia_producto(coalesce(v.producto_nombre, e.producto)) as producto,
  coalesce(v.fecha, e.fecha_ingreso) as fecha_pedido,
  (e.categoria = 'entregado') as entregado,
  e.fecha_entrega, e.fecha_rendido, e.costo_envio, e.importe, e.neto_depositado, v.total as venta_total, v.costo_prod as venta_costo_prod, v.courier_motor,
  case when v.fecha is not null and e.fecha_entrega is not null then e.fecha_entrega - v.fecha end as dias_pedido_entrega,
  case when e.fecha_rendido is not null and e.fecha_entrega is not null then e.fecha_rendido - e.fecha_entrega end as dias_rendicion
from public.entregas e
left join lateral (
  select x.* from public.ventas x
  where x.deleted_at is null and (x.id = e.venta_id or regexp_replace(x.n_referencia, '^(FW-|L-|WA-)', '') = regexp_replace(e.n_referencia, '^(FW-|L-|WA-)', ''))
  order by (x.id = e.venta_id) desc limit 1
) v on true
where e.categoria in ('entregado', 'devuelto') and e.transportadora in ('pap', 'lucero');

-- p por nivel (se recalcula de noche).
create table if not exists public.courier_prob (
  nivel text not null check (nivel in ('general', 'zona', 'ciudad')),
  courier text not null,
  clave text not null,                 -- 'general' | zona | ciudad normalizada
  entregados integer not null,
  resueltos integer not null,
  p numeric not null,                  -- ya suavizada
  actualizado_en timestamptz not null default now(),
  primary key (nivel, courier, clave)
);
-- Tasa de un producto con un courier (para el ajuste por producto).
create table if not exists public.courier_prob_producto (
  courier text not null, producto text not null,
  entregados integer not null, resueltos integer not null, tasa numeric not null,
  actualizado_en timestamptz not null default now(),
  primary key (courier, producto)
);
-- Métricas por courier: rendición, plazo y cargo por devuelto, medidos.
create table if not exists public.courier_metricas (
  courier text primary key,
  dias_rendicion numeric, dias_pedido_entrega numeric,
  devuelto_cobro_extra_pct numeric,    -- cargo del courier por un devuelto ADEMÁS del flete, como % del flete (medido)
  n_rendicion integer, n_plazo integer, actualizado_en timestamptz not null default now()
);
alter table public.courier_prob enable row level security;
alter table public.courier_prob_producto enable row level security;
alter table public.courier_metricas enable row level security;
do $$ begin
  create policy "Autenticados leen courier_prob" on public.courier_prob for select using (auth.uid() is not null);
  create policy "Autenticados leen courier_prob_producto" on public.courier_prob_producto for select using (auth.uid() is not null);
  create policy "Autenticados leen courier_metricas" on public.courier_metricas for select using (auth.uid() is not null);
exception when duplicate_object then null; end $$;

create or replace function public.recalcular_courier_prob() returns jsonb language plpgsql security definer set search_path = public as $$
declare
  hoy date := (now() at time zone 'America/Asuncion')::date;
  k constant integer := 10;
begin
  create temp table _base on commit drop as
    select r.*, tz.zona
    from public.courier_resueltos r
    left join lateral (
      select coalesce(t.zona, t.tiempo) as zona from public.tarifas_courier_vigente t where t.courier = r.courier and t.ciudad = r.ciudad limit 1
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
end $$;

create or replace function public.courier_nombre(c text) returns text language sql immutable as $$ select case c when 'pap' then 'PaP' when 'lucero' then 'Lucero' else initcap(c) end $$;

-- Tarifa + p + ganancia por courier para un pedido, y el ganador. p_cod=false → pagado por adelantado.
create or replace function public.motor_courier(p_ciudad text, p_producto text, p_cobro numeric, p_costo_prod numeric default null, p_cod boolean default true)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  fam text := public.familia_producto(p_producto);
  caja numeric := coalesce((select valor::numeric from public.config where clave = 'valor_dia_caja'), 0.002);
  margen numeric := coalesce((select valor::numeric from public.config where clave = 'margen_desempate'), 3000);
  costo numeric := p_costo_prod;
  ops jsonb := '[]'::jsonb;
  c text; t jsonb; ciu text := public.ciudad_norm(p_ciudad);
  zon text; pr record; pp numeric; nn integer; niv text; sugerencia jsonb; extra numeric; datos_ok boolean; min_pap numeric; min_n integer; adj numeric; flete numeric; dr numeric; ganancia numeric;
  mejor jsonb; otro jsonb; ganador text; regla text; motivo text; sincob boolean;
begin
  if costo is null then
    costo := coalesce((select avg(v.costo_prod) from public.ventas v where v.deleted_at is null and v.fecha >= current_date - 90
                        and public.familia_producto(v.producto_nombre) = fam and v.costo_prod > 0), 0);
  end if;
  foreach c in array array['pap', 'lucero'] loop
    t := public.tarifa_courier(c, p_ciudad);
    continue when t is null;
    -- Contra entrega solo cuenta el que COBRA ahí (y no una tarifa estimada por zona); pagado, cualquiera que llegue.
    continue when p_cod and not coalesce((t ->> 'cobranza')::boolean, false);
    continue when p_cod and coalesce((t ->> 'estimado')::boolean, false);
    zon := coalesce(t ->> 'zona', t ->> 'tiempo');
    niv := 'general'; pp := null; nn := 0;
    select cp.p, cp.resueltos into pp, nn from public.courier_prob cp where cp.nivel = 'ciudad' and cp.courier = c and cp.clave = ciu;
    if found then niv := 'ciudad'; else
      select cp.p, cp.resueltos into pp, nn from public.courier_prob cp where cp.nivel = 'zona' and cp.courier = c and cp.clave = zon;
      if found then niv := 'zona'; else
        select cp.p, cp.resueltos into pp, nn from public.courier_prob cp where cp.nivel = 'general' and cp.courier = c and cp.clave = 'general';
        niv := 'general';
      end if;
    end if;
    pp := coalesce(pp, case c when 'lucero' then 0.85 else 0.75 end);
    -- ajuste por producto (≥ 30 resueltos de ese producto con ese courier)
    adj := 1;
    select pq.tasa, pq.resueltos into pr from public.courier_prob_producto pq where pq.courier = c and pq.producto = fam;
    if found and pr.resueltos >= 30 and coalesce((select valor from public.config where clave = 'motor_ajuste_producto'), 'si') = 'si' then
      adj := pr.tasa / nullif((select cp.p from public.courier_prob cp where cp.nivel = 'general' and cp.courier = c and cp.clave = 'general'), 0);
      pp := least(0.97, pp * coalesce(adj, 1));   -- tope: ninguna entrega es segura
    end if;
    flete := (t ->> 'precio')::numeric;
    dr := coalesce((select cm.dias_rendicion from public.courier_metricas cm where cm.courier = c), case c when 'lucero' then 1.5 else 11.5 end);
    ganancia := pp * (p_cobro - costo) - flete
                - (1 - pp) * flete * coalesce((select cm.devuelto_cobro_extra_pct from public.courier_metricas cm where cm.courier = c), 0)
                - p_cobro * dr * caja;
    ops := ops || jsonb_build_object('courier', c, 'flete', flete, 'p', round(pp, 4), 'nivel_p', niv, 'n_resueltos', coalesce(nn, 0), 'pocos_datos', niv = 'general',
      'ajuste_producto', round(coalesce(adj, 1), 3), 'dias_rendicion', dr, 'costo_caja', round(p_cobro * dr * caja),
      'ganancia_esperada', round(ganancia), 'estimado', coalesce((t ->> 'estimado')::boolean, false),
      'dias_min', t -> 'dias_min', 'dias_max', t -> 'dias_max',
      'dias_pedido_entrega', (select cm.dias_pedido_entrega from public.courier_metricas cm where cm.courier = c));
  end loop;

  sincob := jsonb_array_length(ops) = 0;
  if sincob then
    return jsonb_build_object('ganador', null, 'regla', 'sin_cobertura', 'sin_cobertura', true, 'opciones', ops,
      'motivo', 'Ningún courier cobra contra entrega en esta ciudad: pago anticipado');
  end if;

  -- ganador por ganancia esperada; desempate por rendición más rápida
  select o into mejor from jsonb_array_elements(ops) o order by (o ->> 'ganancia_esperada')::numeric desc limit 1;
  select o into otro from jsonb_array_elements(ops) o where o ->> 'courier' <> mejor ->> 'courier' limit 1;
  ganador := mejor ->> 'courier'; regla := 'ganancia'; sugerencia := null;
  min_pap := coalesce((select valor::numeric from public.config where clave = 'motor_ganancia_minima_pap'), 10000);
  min_n := coalesce((select valor::integer from public.config where clave = 'motor_resueltos_minimos'), 20);
  if not p_cod and otro is not null then
    -- Pagado por adelantado: no hay riesgo de rechazo → el de menor flete; si la diferencia es menor al margen, Lucero (más rápido).
    ganador := case when abs((mejor ->> 'flete')::numeric - (otro ->> 'flete')::numeric) < margen
                    then case when (mejor ->> 'courier') = 'lucero' or (otro ->> 'courier') = 'lucero' then 'lucero' else mejor ->> 'courier' end
                    else (select o ->> 'courier' from jsonb_array_elements(ops) o order by (o ->> 'flete')::numeric limit 1) end;
    regla := 'pagado_adelantado';
  elsif otro is not null and mejor ->> 'courier' = 'pap' then
    -- Pasar de Lucero a PaP exige: PaP gana por ≥ motor_ganancia_minima_pap (cubre el plazo que la fórmula no mide) Y la p de
    -- LOS DOS couriers sale de ciudad o zona con ≥ motor_resueltos_minimos resueltos. Si no, queda Lucero y se muestra la sugerencia.
    extra := (mejor ->> 'ganancia_esperada')::numeric - (otro ->> 'ganancia_esperada')::numeric;
    datos_ok := (mejor ->> 'nivel_p') in ('ciudad', 'zona') and (otro ->> 'nivel_p') in ('ciudad', 'zona')
                and (mejor ->> 'n_resueltos')::int >= min_n and (otro ->> 'n_resueltos')::int >= min_n;
    if extra < min_pap or not datos_ok then
      ganador := 'lucero'; regla := 'guarda_lucero';
      sugerencia := jsonb_build_object('courier', 'pap', 'extra', round(extra),
        'motivo', case when not datos_ok then 'pocos datos' else 'margen menor al mínimo' end);
    end if;
  elsif otro is not null and abs((mejor ->> 'ganancia_esperada')::numeric - (otro ->> 'ganancia_esperada')::numeric) < margen
     and (otro ->> 'dias_rendicion')::numeric < (mejor ->> 'dias_rendicion')::numeric then
    ganador := otro ->> 'courier'; regla := 'desempate_rendicion';
  end if;

  -- regla dura de producto: JawFlex solo Lucero; si Lucero no llega, PaP con aviso
  if fam = 'JawFlex' then
    if exists (select 1 from jsonb_array_elements(ops) o where o ->> 'courier' = 'lucero') then
      ganador := 'lucero'; regla := 'producto_solo_lucero';
    else
      ganador := 'pap'; regla := 'producto_fallback_pap';
    end if;
  end if;

  select o into mejor from jsonb_array_elements(ops) o where o ->> 'courier' = ganador;
  select o into otro from jsonb_array_elements(ops) o where o ->> 'courier' <> ganador limit 1;
  motivo := public.courier_nombre(ganador) || ' · entrega ' || round(100 * (mejor ->> 'p')::numeric) || '% · rinde en '
    || round((mejor ->> 'dias_rendicion')::numeric) || ' días · ganancia esperada ₲' || round((mejor ->> 'ganancia_esperada')::numeric / 1000) || 'k'
    || case when otro is not null then ' vs ' || public.courier_nombre(otro ->> 'courier') || ' ₲' || round((otro ->> 'ganancia_esperada')::numeric / 1000) || 'k' else '' end
    || case regla when 'desempate_rendicion' then ' (desempate: rinde más rápido)'
                  when 'producto_solo_lucero' then ' (regla de producto: JawFlex solo Lucero)'
                  when 'producto_fallback_pap' then ' (JawFlex por PaP: Lucero no llega)'
                  when 'pagado_adelantado' then ' (ya pagado: menor flete; empate → Lucero, más rápido)'
                  when 'guarda_lucero' then ' · sugerencia: PaP (+₲' || round((sugerencia ->> 'extra')::numeric / 1000) || 'k, ' || (sugerencia ->> 'motivo') || ')' else '' end
    || case when (mejor ->> 'pocos_datos')::boolean then ' · pocos datos' else '' end;
  return jsonb_build_object('ganador', ganador, 'regla', regla, 'sin_cobertura', false, 'opciones', ops, 'motivo', motivo,
    'pocos_datos', (mejor ->> 'pocos_datos')::boolean, 'fallback_producto', regla = 'producto_fallback_pap', 'sugerencia', sugerencia);
end $$;

grant execute on function public.motor_courier(text, text, numeric, numeric, boolean), public.familia_producto(text) to authenticated, service_role;
grant select on public.courier_resueltos to authenticated, service_role;

-- Cambios manuales de courier (quién, cuándo, de cuál a cuál) para medir si el criterio de Enrique le gana al motor.
create table if not exists public.courier_cambios (
  id bigserial primary key,
  n_referencia text not null, ciudad text, producto text,
  courier_motor text, courier_final text not null, regla_motor text,
  ganancia_motor numeric, ganancia_final numeric,
  usuario uuid default auth.uid(), creado_en timestamptz not null default now()
);
alter table public.courier_cambios enable row level security;
do $$ begin
  create policy "Autenticados gestionan courier_cambios" on public.courier_cambios for all using (auth.uid() is not null) with check (auth.uid() is not null);
exception when duplicate_object then null; end $$;

-- Recalculo nocturno: 03:00 en Paraguay = 06:00 UTC (UTC−3 fijo).
select cron.unschedule('courier-prob-nocturno') where exists (select 1 from cron.job where jobname = 'courier-prob-nocturno');
select cron.schedule('courier-prob-nocturno', '0 6 * * *', $$select public.recalcular_courier_prob()$$);
