-- 09-11-2026 · Inhalador de menta GTRC (encargo de ADMINISTRACIÓN, socio/lanzamiento-inhalador.md punto 4).
-- 1) familia_producto: "Inhalador" antes que Kit Deporte y Tiras ("inhalador nasal" caía en Tiras por "nasal").
-- 2) Vistas creativos_dia_detalle y libro_creativos_senales: el mismo caso (copian el CASE de familia por nombre de anuncio).
--    Se reescriben desde su definición viva insertando la rama Inhalador; si el texto esperado no está, la migración falla
--    y no cambia nada (todo en una transacción).
-- 3) Fila en productos (tienda voltra). Idempotente: no se duplica si ya existe.
-- Volver atrás:
--   delete from productos where nombre = 'Inhalador de menta' and tienda = 'voltra';  (solo si no tiene ventas)
--   familia_producto: volver a la versión de 20261026000006_kit_deporte.sql (sin la línea de Inhalador).
--   vistas: create or replace view <vista> as <definición> quitando la rama "WHEN (... ~* 'inhalador|wakeful|gtrc') THEN 'Inhalador'".

create or replace function public.familia_producto(t text)
returns text language sql immutable as $$
  select case
    when t ~* 'inhalador|wakeful|gtrc' then 'Inhalador'
    when t ~* 'kit ?deporte' or (t ~* 'botella' and t ~* 'tira|nasal') then 'Kit Deporte'
    when t ~* 'pack|gudair' then 'Pack'
    when t ~* 'raspador|lengua' then 'Raspador'
    when t ~* 'tira|nasal' then 'Tiras'
    when t ~* 'parche|bucal' then 'Parches'
    when t ~* 'jaw|mand[ií]bula|ejercitador' then 'JawFlex'
    when t ~* 'botella' then 'Botella'
    else 'Otros' end
$$;

do $$
declare
  v record;
  def text;
  nuevo text;
  opts text[];
  ancla text;
  veces int;
begin
  for v in select * from (values ('creativos_dia_detalle', 'ad_nombre'), ('libro_creativos_senales', 'ga.anuncio')) x(vista, col) loop
    select reloptions into opts from pg_class where oid = ('public.' || v.vista)::regclass;
    def := pg_get_viewdef(('public.' || v.vista)::regclass);
    if position('inhalador|wakeful|gtrc' in def) > 0 then continue; end if; -- ya aplicada
    ancla := format('WHEN ((%s ~* ''kit ?deporte''::text)', v.col);
    veces := (length(def) - length(replace(def, ancla, ''))) / length(ancla);
    if veces <> 1 then raise exception 'vista %: esperaba 1 CASE de familia, hay %', v.vista, veces; end if;
    nuevo := replace(def, ancla, format('WHEN (%s ~* ''inhalador|wakeful|gtrc''::text) THEN ''Inhalador''::text ', v.col) || ancla);
    execute format('create or replace view public.%I as %s', v.vista, rtrim(btrim(nuevo), ';'));
    -- libro_creativos_senales tiene security_invoker=true: se vuelve a poner por las dudas
    if opts is not null then execute format('alter view public.%I set (%s)', v.vista, array_to_string(opts, ',')); end if;
  end loop;
end $$;

-- El stock entra por fw_registrar_lote (motor único de stock: deja el movimiento 'compra' y el costo 3.750).
do $$
declare pid uuid;
begin
  select id into pid from public.productos where nombre = 'Inhalador de menta' and tienda = 'voltra';
  if pid is not null then return; end if; -- ya aplicada
  insert into public.productos (nombre, costo_unit, stock_actual, stock_alerta, precio_1u, precio_2u, precio_3u, grupo_envio, prioridad, tienda, activo, es_combo)
  values ('Inhalador de menta', 0, 0, 50, 99000, 129000, 149000, 'A', 'Media', 'voltra', true, false)
  returning id into pid;
  perform public.fw_registrar_lote(pid, 500, 3750, 'Lote inicial inhalador GTRC 09-11 (500 u)');
end $$;
