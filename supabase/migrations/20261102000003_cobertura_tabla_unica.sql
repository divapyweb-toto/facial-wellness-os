-- 02-11-2026 · Cobranza con una sola fuente: tarifas_courier_vigente con aplica_cobranza=true (encargo de administración,
-- #1176 Filadelfia entró contra entrega sin aviso). La tabla no tenía esas ciudades, la lista vieja las daba por cubiertas.
--  1. Ciudades reales sin tarifa con cobranza: entran como PaP aplica_cobranza=false y llega=false, ni pagado por adelantado
--     se sugiere PaP. PaP confirmó el 02-11 que no llega a Filadelfia; el resto queda igual hasta que responda (historial:
--     0 entregas). Precio provisorio de INTERIOR 2, marcado en tiempo = 'A CONFIRMAR CON PAP'. Si PaP confirma, se cambian
--     llega, aplica_cobranza y precio en la fila, sin desplegar.
--  2. "Ciudad, Departamento": el departamento se saca antes de buscar. Si no, "Vallemí, Concepción" caía en la ciudad de
--     Concepción y salía con cobranza. Sin separador no se toca: "Santa Rosa Misiones" es una ciudad de la tabla.
-- Volver atrás: restaurar tarifa_courier de 20261029000002, sugerir_courier de 20261026000003, motor_courier de
-- 20261021000002 y borrar las filas:
--   delete from public.tarifas_courier where courier = 'pap' and vigente_desde = '2026-11-02' and not aplica_cobranza;
-- ciudad_sin_depto y la columna llega no molestan si quedan.
alter table public.tarifas_courier add column if not exists llega boolean not null default true;
create or replace view public.tarifas_courier_vigente as
select distinct on (courier, ciudad) * from public.tarifas_courier
where vigente_desde <= (now() at time zone 'America/Asuncion')::date
order by courier, ciudad, vigente_desde desc;

create or replace function public.ciudad_sin_depto(t text) returns text language plpgsql immutable as $$
declare
  s text := translate(lower(coalesce(t, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc');
  n text;
begin
  loop
    n := regexp_replace(s, '^(.+?)\s*[,;/-]\s*((departamento|depto|dpto|dep)\.?\s+(del?\s+)?)?(concepcion|san pedro|cordillera|guaira|caaguazu|caazapa|itapua|misiones|paraguari|alto parana|central|neembucu|amambay|canindeyu|presidente hayes|boqueron|alto paraguay|chaco|paraguay|py)\.?\s*$', '\1');
    exit when n = s;
    s := n;
  end loop;
  return s;
end $$;

create or replace function public.tarifa_courier(p_courier text, p_ciudad text)
returns jsonb language sql stable as $$
  with t as (select public.ciudad_norm(p_ciudad) as k0, public.ciudad_norm(public.ciudad_sin_depto(p_ciudad)) as k,
                    public.ciudad_fonetica(public.ciudad_sin_depto(p_ciudad)) as f),
  m as (
    select v.*,
      case when v.ciudad in (t.k, t.k0) or t.k = any (v.alias) or t.k0 = any (v.alias) then 0
           when position(' ' || v.ciudad || ' ' in ' ' || t.k || ' ') > 0
             or exists (select 1 from unnest(v.alias) a where position(' ' || a || ' ' in ' ' || t.k || ' ') > 0) then 1
           else 2 end as orden,
      greatest(length(v.ciudad), coalesce((select max(length(a)) from unnest(v.alias) a where position(' ' || a || ' ' in ' ' || t.k || ' ') > 0), 0)) as largo
    from public.tarifas_courier_vigente v, t
    where v.courier = p_courier and t.k is not null and (
      v.ciudad in (t.k, t.k0) or t.k = any (v.alias) or t.k0 = any (v.alias)
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
       'dias_min', dias_min, 'dias_max', dias_max, 'cobranza', aplica_cobranza, 'agencia', tiene_agencia, 'estimado', false, 'llega', llega) from m),
    case when p_courier = 'pap' and (select precio from zona) is not null then
      jsonb_build_object('courier', 'pap', 'ciudad', null, 'precio', (select precio from zona), 'zona', 'INTERIOR 2', 'tiempo', null,
        'dias_min', 3, 'dias_max', 5, 'cobranza', null, 'agencia', null, 'estimado', true) end)
$$;

-- sugerir_courier y motor_courier: un courier que no llega no cuenta. Se parchea el texto vivo para no copiar las funciones.
do $$
declare
  a text; b text;
begin
  a := pg_get_functiondef('public.sugerir_courier(text,boolean)'::regprocedure);
  b := replace(a, '(not p_cod or (t ->> ''cobranza'')::boolean)', '(not p_cod or (t ->> ''cobranza'')::boolean) and coalesce((t ->> ''llega'')::boolean, true)');
  if a = b then raise exception 'sugerir_courier: no se encontró el texto a cambiar'; end if;
  execute b;
  a := pg_get_functiondef('public.motor_courier(text,text,numeric,numeric,boolean)'::regprocedure);
  b := replace(a, 'continue when t is null;', 'continue when t is null or (t ->> ''llega'') = ''false'';');
  if a = b then raise exception 'motor_courier: no se encontró el texto a cambiar'; end if;
  execute b;
end $$;

insert into public.tarifas_courier (courier, ciudad, ciudad_nombre, alias, zona, precio, tiempo, dias_min, dias_max, aplica_cobranza, tiene_agencia, vigente_desde, llega)
select 'pap', c.ciudad, c.nombre, c.alias, 'INTERIOR 2', (z.valor::jsonb ->> 'INTERIOR 2')::int, 'A CONFIRMAR CON PAP', 3, 5, false, null, date '2026-11-02', false
from (values
  ('filadelfia',            'Filadelfia',              array[]::text[]),
  ('mariscal estigarribia', 'Mariscal Estigarribia',   array['mcal estigarribia', 'mariscal jose f estigarribia']),
  ('neuland',               'Neuland',                 array['colonia neuland']),
  ('colonia manitoba',      'Colonia Manitoba',        array['manitoba']),
  ('curuguaty',             'Curuguaty',               array['villa curuguaty']),
  ('yasy cany',             'Yasy Cañy',               array[]::text[]),
  ('santa rosa del mbutuy', 'Santa Rosa del Mbutuy',   array['santa rosa mbutuy', 'mbutuy']),
  ('guayaibi',              'Guayaibí',                array[]::text[]),
  ('natalio',               'Natalio',                 array[]::text[]),
  ('vallemi',               'Vallemí',                 array[]::text[]),
  ('capitan bado',          'Capitán Bado',            array['cap bado']),
  ('general isidoro resquin', 'General Isidoro Resquín', array['resquin', 'isidoro resquin', 'general resquin'])
) as c(ciudad, nombre, alias), public.config z
where z.clave = 'tarifas_zona_pap'
  and not exists (select 1 from public.tarifas_courier_vigente v where v.courier = 'pap' and v.ciudad = c.ciudad)
on conflict (courier, ciudad, vigente_desde) do nothing;

-- Loreto (depto. Concepción): PaP entregó y cobró ahí como Concepción (octubre). Sin este alias, sacar el departamento
-- lo dejaría sin ciudad. Volver atrás: quitar 'loreto' del alias de esa fila.
update public.tarifas_courier set alias = array_append(alias, 'loreto'), actualizado_en = now()
 where courier = 'pap' and ciudad = 'concepcion' and not ('loreto' = any (alias));

grant execute on function public.ciudad_sin_depto(text) to authenticated, service_role;
