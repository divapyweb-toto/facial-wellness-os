-- 20261020000001 · Tarifas oficiales CON COBRANZA por courier y ciudad (Enrique 20-10-2026).
-- Solo el ESQUEMA va al repo (público). Los precios se cargan desde la base con scripts/tarifas-courier.mjs
-- (lee el CSV local) y se editan después en la tabla, sin tocar código.
--
-- Reemplaza el flete fijo de PaP (config.flete_pap = 29.000, queda solo de respaldo) y la lista de cobertura de PaP
-- escrita en el código, que daba como "con cobranza" 4 ciudades donde PaP no cobra (p. ej. San Juan Nepomuceno).

-- Clave de ciudad: minúscula, sin tildes, sin lo que va entre paréntesis, sin signos, abreviaturas comunes expandidas.
create or replace function public.ciudad_clave(t text) returns text language sql immutable as $$
  select nullif(trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    translate(lower(coalesce(t, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
    '\(.*?\)', ' ', 'g'),
    '\m(cnel|cnl)\.?(\s|$)', 'coronel ', 'g'),
    '\m(gral)\.?(\s|$)', 'general ', 'g'),
    '\m(pdte|pte)\.?(\s|$)', 'presidente ', 'g'),
    '[^a-z0-9'' ]+', ' ', 'g')), '')
$$;
-- (los espacios repetidos se colapsan aparte, para que el regexp de arriba quede legible)
create or replace function public.ciudad_norm(t text) returns text language sql immutable as $$
  select nullif(regexp_replace(coalesce(public.ciudad_clave(t), ''), '\s+', ' ', 'g'), '')
$$;

create table if not exists public.tarifas_courier (
  id bigserial primary key,
  courier text not null check (courier in ('pap', 'lucero')),
  ciudad text not null,                         -- clave normalizada (ciudad_norm)
  ciudad_nombre text not null,                  -- como se muestra
  alias text[] not null default '{}',           -- otras grafías, ya normalizadas ("cuidad del este", "itagua"…)
  zona text,                                    -- PaP: GRAN ASUNCION, CENTRAL, INTERIOR 1, INTERIOR 2
  precio integer not null check (precio > 0),   -- Gs por paquete, IVA incluido, con cobranza
  tiempo text,                                  -- tal cual lo publica el courier ("24/48HS", "48 a 72 hs")
  dias_min integer,                             -- días hábiles desde el despacho
  dias_max integer,
  aplica_cobranza boolean not null,             -- false = el courier llega pero NO cobra contra entrega
  tiene_agencia boolean,
  vigente_desde date not null default current_date,
  actualizado_en timestamptz not null default now(),
  unique (courier, ciudad, vigente_desde)
);
alter table public.tarifas_courier enable row level security;
drop policy if exists "Autenticados gestionan tarifas_courier" on public.tarifas_courier;
create policy "Autenticados gestionan tarifas_courier" on public.tarifas_courier for all
  using (auth.uid() is not null) with check (auth.uid() is not null);

-- Tarifa vigente hoy: la más nueva de cada courier y ciudad.
create or replace view public.tarifas_courier_vigente as
select distinct on (courier, ciudad) * from public.tarifas_courier
where vigente_desde <= (now() at time zone 'America/Asuncion')::date
order by courier, ciudad, vigente_desde desc;

-- Respaldo por zona para ciudades que no están en la tabla (lo carga el script en config 'tarifas_zona_pap').
-- Ciudad desconocida → la zona más cara (INTERIOR 2) y el flete se marca "estimado".

-- Tasa de entrega por courier: pedidos RESUELTOS (entregado / perdido, los 3 grupos) de los últimos 60 días.
-- Menos de 10 resueltos → 85% Lucero, 75% PaP y "pocos datos".
create or replace view public.tasa_entrega_courier as
with c(courier, respaldo) as (values ('lucero', 85.0), ('pap', 75.0)),
r as (
  select transportadora as courier,
    count(*) filter (where grupo = 'ENTREGADO') as entregados,
    count(*) filter (where grupo in ('ENTREGADO', 'PERDIDO')) as resueltos
  from public.pedidos_entrega
  where fecha >= (now() at time zone 'America/Asuncion')::date - 60 and transportadora in ('pap', 'lucero')
  group by 1
)
select c.courier, coalesce(r.entregados, 0) as entregados, coalesce(r.resueltos, 0) as resueltos,
  round(100.0 * r.entregados / nullif(r.resueltos, 0), 1) as tasa_medida,
  coalesce(r.resueltos, 0) < 10 as pocos_datos,
  case when coalesce(r.resueltos, 0) < 10 then c.respaldo else round(100.0 * r.entregados / r.resueltos, 1) end as tasa_usada
from c left join r using (courier);

-- Tarifa de un courier para una ciudad escrita libre. Orden: clave exacta o alias → la ciudad conocida más larga
-- contenida en el texto ("Asunción, barrio Sajonia" → asuncion). Sin match: PaP por zona (estimado); Lucero null.
create or replace function public.tarifa_courier(p_courier text, p_ciudad text)
returns jsonb language sql stable as $$
  with t as (select public.ciudad_norm(p_ciudad) as k),
  m as (
    select v.*, case when v.ciudad = t.k or t.k = any (v.alias) then 0 else 1 end as orden,
      greatest(length(v.ciudad), coalesce((select max(length(a)) from unnest(v.alias) a where position(' ' || a || ' ' in ' ' || t.k || ' ') > 0), 0)) as largo
    from public.tarifas_courier_vigente v, t
    where v.courier = p_courier and t.k is not null and (
      v.ciudad = t.k or t.k = any (v.alias)
      or position(' ' || v.ciudad || ' ' in ' ' || t.k || ' ') > 0
      or exists (select 1 from unnest(v.alias) a where position(' ' || a || ' ' in ' ' || t.k || ' ') > 0))
    order by orden, largo desc limit 1
  ),
  zona as (select (valor::jsonb ->> 'INTERIOR 2')::int as precio from public.config where clave = 'tarifas_zona_pap')
  select coalesce(
    (select jsonb_build_object('courier', courier, 'ciudad', ciudad_nombre, 'precio', precio, 'zona', zona, 'tiempo', tiempo,
       'dias_min', dias_min, 'dias_max', dias_max, 'cobranza', aplica_cobranza, 'agencia', tiene_agencia, 'estimado', false) from m),
    case when p_courier = 'pap' and (select precio from zona) is not null then
      jsonb_build_object('courier', 'pap', 'ciudad', null, 'precio', (select precio from zona), 'zona', 'INTERIOR 2', 'tiempo', null,
        'dias_min', 3, 'dias_max', 5, 'cobranza', null, 'agencia', null, 'estimado', true) end)
$$;

-- Courier sugerido (no asigna nada): entre los que COBRAN contra entrega en esa ciudad, el de menor flete ÷ tasa de
-- entrega. Con p_cod = false (pago anticipado) cuenta también donde el courier llega sin cobranza.
-- sin_cobertura = ningún courier conocido cobra ahí (PaP sin cobranza nunca se sugiere para contra entrega).
-- ciudad_reconocida = la ciudad está en la tabla de algún courier (si no, puede ser un typo).
create or replace function public.sugerir_courier(p_ciudad text, p_cod boolean default true)
returns jsonb language sql stable as $$
  with o as (
    select c.courier, public.tarifa_courier(c.courier, p_ciudad) as t, te.tasa_usada, te.pocos_datos, te.resueltos
    from (values ('pap'), ('lucero')) c(courier) left join public.tasa_entrega_courier te using (courier)
  ),
  op as (
    select courier, t, tasa_usada, pocos_datos, resueltos,
      (t is not null and not coalesce((t ->> 'estimado')::boolean, false) and (not p_cod or (t ->> 'cobranza')::boolean)) as valido,
      round((t ->> 'precio')::numeric / nullif(tasa_usada / 100, 0)) as costo_por_entregado
    from o
  )
  select jsonb_build_object(
    'ciudad', p_ciudad,
    'sugerido', (select courier from op where valido order by costo_por_entregado, courier limit 1),
    'sin_cobertura', not exists (select 1 from op where valido),
    -- false = ningún courier tiene la ciudad en su tabla (typo o pueblo chico): no avisar "sin cobertura" por esto solo
    'ciudad_reconocida', exists (select 1 from op where t is not null and not coalesce((t ->> 'estimado')::boolean, false)),
    'opciones', coalesce((select jsonb_agg(jsonb_build_object('courier', courier, 'precio', (t ->> 'precio')::int,
        'estimado', coalesce((t ->> 'estimado')::boolean, false), 'cobranza', (t ->> 'cobranza')::boolean, 'zona', t ->> 'zona',
        'tiempo', t ->> 'tiempo', 'dias_min', (t ->> 'dias_min')::int, 'dias_max', (t ->> 'dias_max')::int,
        'tasa', tasa_usada, 'pocos_datos', pocos_datos, 'resueltos', resueltos,
        'costo_por_entregado', costo_por_entregado, 'valido', valido) order by costo_por_entregado) from op where t is not null), '[]'::jsonb))
$$;

-- Flete marcado como estimado (ciudad fuera de la tabla).
alter table public.ventas add column if not exists flete_estimado boolean not null default false;

grant select on public.tarifas_courier_vigente, public.tasa_entrega_courier to authenticated, service_role;
grant execute on function public.tarifa_courier(text, text), public.sugerir_courier(text, boolean), public.ciudad_norm(text), public.ciudad_clave(text) to authenticated, service_role;
