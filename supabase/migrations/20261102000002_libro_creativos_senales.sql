-- 02-11-2026 · Señales por anuncio para la regla de corte (reports/Mejores creativos Voltra.md, sección 4):
-- 0 válidos en ₲30.000 = apagar, 1 = seguir hasta ₲90.000 y ahí costo por válido ≤ equilibrio, 2 = escalar.
-- Regla final de administración, 02-11 (la literal de ₲60.000 cortaba a IMG RASPADOR 2). Vista nueva: libro_creativos no cambia.
--  · Pedidos: todos los del anuncio, también los cancelados en Shopify que quedaron 'confirmado' (pedidos_entrega los
--    deja afuera). Válido = confirmado y sin cancelar.
--  · Gasto: creativos_diario, y gasto_ads_anuncio_diario donde falte (07 y 08-10).
--  · Ventana de ₲30.000 / ₲60.000: el gasto es por día, así que entra todo pedido de un día que arrancó por debajo del tope
--    (mismo corte que el informe; repartir el gasto por hora marcaba "apagar" a ganadores: IMG WA RASPADOR 2, PACK 5).
--  · Pasados ₲60.000 sigue el que tuvo ≥ 2 válidos en la ventana o vende a costo por válido ≤ equilibrio del producto;
--    con 1 válido en ₲30.000 sigue hasta ₲90.000 aunque todavía esté sobre el equilibrio; después, apagar.
--  · Semana: últimos 7 días, hoy incluido.
-- Solo informa: nada pausa anuncios con esta vista.
create or replace view public.libro_creativos_senales with (security_invoker = true) as
with hoy as (select (now() at time zone 'America/Asuncion')::date as d),
gd as (
  select coalesce(c.ad_id, g.ad_id) as ad_id, coalesce(c.fecha, g.fecha) as fecha, coalesce(c.gasto, g.gasto, 0) as gasto,
    coalesce(c.conversaciones, 0) as chats, coalesce(c.ad_nombre, g.ad_nombre) as ad_nombre, c.canal, c.adset_nombre
  from public.creativos_diario c
  full join public.gasto_ads_anuncio_diario g on g.ad_id = c.ad_id and g.fecha = c.fecha
),
ped as (
  select coalesce(case when o.origen = 'whatsapp' then o.anuncio_wa end,
           case when o.utm_content ~ '^\d{10,}$' then o.utm_content end,
           (select c.ad_id from public.creativos_diario c where c.ad_nombre = o.utm_content order by c.fecha desc limit 1)) as ad_id,
    (o.creado_en at time zone 'America/Asuncion')::date as fecha,
    sp.raw ->> 'cancelled_at' is not null or coalesce(o.estado_confirmacion, '') like 'cancelado%' as cancelado,
    sp.raw ->> 'cancelled_at' is null and o.estado_confirmacion = 'confirmado' as valido
  from public.pedidos_origen_anuncio_todos o
  join public.shopify_pedidos sp on sp.shopify_order_id = o.shopify_order_id
  where not exists (select 1 from unnest(sp.tags) t where upper(t) like '%PRUEBA%' or upper(t) like 'REEMPLAZADO%')
    and o.nombre not ilike '%prueba%'
),
ped_gasto as (
  select p.*, x.antes as gasto_antes_del_dia
  from ped p
  cross join lateral (select coalesce(sum(g.gasto) filter (where g.fecha < p.fecha), 0) as antes from gd g where g.ad_id = p.ad_id) x
  where p.ad_id is not null
),
pa as (
  select pg.ad_id, count(*) as generados, count(*) filter (where cancelado) as cancelados, count(*) filter (where valido) as validos,
    count(*) filter (where valido and gasto_antes_del_dia < 30000) as validos_30k,
    count(*) filter (where valido and gasto_antes_del_dia < 60000) as validos_60k,
    count(*) filter (where valido and pg.fecha >= hoy.d - 6) as validos_7d
  from ped_gasto pg, hoy group by pg.ad_id
),
ga as (
  select g.ad_id, max(g.ad_nombre) as anuncio, max(g.canal) as canal, max(g.adset_nombre) as conjunto,
    min(g.fecha) filter (where g.gasto > 0) as publicado, max(g.fecha) filter (where g.gasto > 0) as ultimo_gasto,
    sum(g.gasto) as gasto, sum(g.chats) as chats,
    coalesce(sum(g.gasto) filter (where g.fecha >= hoy.d - 6), 0) as gasto_7d,
    coalesce(sum(g.chats) filter (where g.fecha >= hoy.d - 6), 0) as chats_7d
  from gd g, hoy group by g.ad_id
),
j as (
  select ga.*, coalesce(pa.generados, 0) as generados, coalesce(pa.cancelados, 0) as cancelados, coalesce(pa.validos, 0) as validos,
    coalesce(pa.validos_30k, 0) as validos_30k, coalesce(pa.validos_60k, 0) as validos_60k, coalesce(pa.validos_7d, 0) as validos_7d,
    case when ga.anuncio ~* 'kit ?deporte' or (ga.anuncio ~* 'botella' and ga.anuncio ~* 'tira|nasal') then 'Kit Deporte'
       when ga.anuncio ~* 'pack|gudair' then 'Pack' when ga.anuncio ~* 'raspador|lengua' then 'Raspador'
       when ga.anuncio ~* 'tira|nasal' then 'Tiras' when ga.anuncio ~* 'parche|bucal' then 'Parches'
       when ga.anuncio ~* 'jaw|mandibula|mandíbula|ejercitador' then 'JawFlex' when ga.anuncio ~* 'botella' then 'Botella' else 'Varios' end as producto
  from ga left join pa using (ad_id)
),
e as (
  select j.*, coalesce((eq.v ->> j.producto)::numeric, (eq.v ->> 'Varios')::numeric, 41000) as equilibrio
  from j, (select coalesce((select valor::jsonb from public.config where clave = 'equilibrio_producto'), '{}'::jsonb) as v) eq
)
select j.ad_id, j.anuncio, j.canal, j.producto, j.conjunto, j.publicado, j.ultimo_gasto, round(j.gasto) as gasto,
  j.generados, j.cancelados, j.validos, round(j.gasto / nullif(j.validos, 0)) as costo_por_valido, round(j.equilibrio) as equilibrio,
  j.validos_30k, j.validos_60k,
  round(j.gasto_7d) as gasto_7d, j.validos_7d, round(j.validos_7d * 100000 / nullif(j.gasto_7d, 0), 1) as validos_por_100k_7d,
  j.chats, case when j.canal = 'whatsapp' then round(j.gasto / nullif(j.chats, 0)) end as costo_por_chat,
  case when j.canal = 'whatsapp' then round(j.gasto_7d / nullif(j.chats_7d, 0)) end as costo_por_chat_7d,
  case when j.ultimo_gasto is null or j.ultimo_gasto < hoy.d - 1 then 'ya_apagado'
       when j.gasto < 30000 then 'esperar'
       when j.gasto < 60000 then case when j.validos_30k >= 2 then 'escalar' when j.validos_30k = 1 then 'seguir_hasta_90k' else 'apagar' end
       when j.validos_60k >= 2 or j.gasto / nullif(j.validos, 0) <= j.equilibrio then 'seguir'
       when j.gasto < 90000 and j.validos_30k >= 1 then 'seguir_hasta_90k'
       else 'apagar' end as accion
from e j, hoy;

revoke all on public.libro_creativos_senales from anon;
grant select on public.libro_creativos_senales to authenticated, service_role;
