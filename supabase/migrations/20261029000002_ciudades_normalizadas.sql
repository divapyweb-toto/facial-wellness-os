-- ═══════════════════════════════════════════════════════════
-- 29-10-2026 · Ciudades mal escritas que no encontraban tarifa (#1159 "Mbocayaty" vs tarifa Lucero "Mbocajaty"
-- ₲40.000 con cobranza: el motor y sugerir_courier dijeron "ningún courier cobra" a un pedido de ₲188.000).
--
-- Lo que ya estaba bien (verificado en la base el 29-10 con SELECT): ciudad_norm/ciudad_clave ya sacan tildes,
-- mayúsculas y espacios ("AsunciÓn", "asuncion", "  CIUDAD  DEL ESTE " → la misma clave). unaccent está disponible
-- pero NO instalada; no hace falta (translate ya cubre las tildes) y no se instala.
--
-- Lo nuevo:
--   1. public.ciudad_fonetica(t): clave "como suena": y→j, v→b, z→s, sin espacios, sin letras repetidas
--      ("Mbocayaty" = "Mbocajaty", "Villa Rica" = "Villarrica"). Se verificó que no junta dos ciudades distintas
--      de tarifas_courier_vigente (ni ciudad ni alias). La misma función en JS: claveFonetica de
--      supabase/functions/_shared/sale_hoy.js (la usa la web en src/lib/tarifasCourier.js).
--   2. tarifa_courier: después de "exacta o alias" (orden 0) y "contiene" (orden 1), un último intento por la
--      clave fonética ENTERA (orden 2; nunca "contiene"). sugerir_courier y motor_courier llaman a tarifa_courier:
--      quedan arreglados sin tocarlos.
--   3. Alias explícitos de las grafías reales de los pedidos de los últimos 60 días sin tarifa:
--      mbocajaty ← 'mbocayaty' (Lucero), villarrica ← 'villa rica' (PaP y Lucero). Los mismos en
--      scripts/tarifas-courier.mjs para que una recarga de tarifas no los borre.
--   Las otras ciudades de esos 60 días sin tarifa (Yasy Cañy, Vallemí, Filadelfia, Curuguaty, Capitán Bado,
--   Colonia Manitoba, Gral. Resquín, "Central") NO son typos de una ciudad de la tabla: no se inventa alias.
--
-- VUELTA ATRÁS (pegar en el SQL editor):
--   update public.tarifas_courier set alias = array_remove(alias, 'mbocayaty') where ciudad = 'mbocajaty';
--   update public.tarifas_courier set alias = array_remove(alias, 'villa rica') where ciudad = 'villarrica';
--   -- tarifa_courier como estaba (20261020000001_tarifas_courier.sql): volver a correr ese "create or replace
--   -- function public.tarifa_courier" tal cual, y después:
--   drop function if exists public.ciudad_fonetica(text);
-- ═══════════════════════════════════════════════════════════

create or replace function public.ciudad_fonetica(t text) returns text language sql immutable as $$
  select nullif(regexp_replace(replace(translate(coalesce(public.ciudad_norm(t), ''), 'yvz', 'jbs'), ' ', ''), '(.)\1+', '\1', 'g'), '')
$$;

-- Tarifa de un courier para una ciudad escrita libre. Orden: clave exacta o alias → la ciudad conocida más larga
-- contenida en el texto ("Asunción, barrio Sajonia" → asuncion) → 29-10: misma clave fonética entera
-- ("Mbocayaty" → mbocajaty). Sin match: PaP por zona (estimado); Lucero null.
create or replace function public.tarifa_courier(p_courier text, p_ciudad text)
returns jsonb language sql stable as $$
  with t as (select public.ciudad_norm(p_ciudad) as k, public.ciudad_fonetica(p_ciudad) as f),
  m as (
    select v.*,
      case when v.ciudad = t.k or t.k = any (v.alias) then 0
           when position(' ' || v.ciudad || ' ' in ' ' || t.k || ' ') > 0
             or exists (select 1 from unnest(v.alias) a where position(' ' || a || ' ' in ' ' || t.k || ' ') > 0) then 1
           else 2 end as orden,
      greatest(length(v.ciudad), coalesce((select max(length(a)) from unnest(v.alias) a where position(' ' || a || ' ' in ' ' || t.k || ' ') > 0), 0)) as largo
    from public.tarifas_courier_vigente v, t
    where v.courier = p_courier and t.k is not null and (
      v.ciudad = t.k or t.k = any (v.alias)
      or position(' ' || v.ciudad || ' ' in ' ' || t.k || ' ') > 0
      or exists (select 1 from unnest(v.alias) a where position(' ' || a || ' ' in ' ' || t.k || ' ') > 0)
      -- 29-10: último intento, la clave fonética entera de la ciudad o de un alias
      or (t.f is not null and (public.ciudad_fonetica(v.ciudad) = t.f
          or exists (select 1 from unnest(v.alias) a where public.ciudad_fonetica(a) = t.f))))
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

-- Alias de grafías reales (normalizadas con ciudad_norm). Idempotente: no duplica si ya están.
with a(ciudad, nuevos) as (values
  ('mbocajaty',  array['mbocayaty']),
  ('villarrica', array['villa rica'])
)
update public.tarifas_courier t
   set alias = (select array_agg(distinct x order by x) from unnest(t.alias || a.nuevos) x),
       actualizado_en = now()
  from a
 where t.ciudad = a.ciudad
   and not (a.nuevos <@ t.alias);

grant execute on function public.ciudad_fonetica(text), public.tarifa_courier(text, text) to authenticated, service_role;
