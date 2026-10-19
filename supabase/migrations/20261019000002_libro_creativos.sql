-- 20261019000002 · Vista libro_creativos: una fila por anuncio (cada anuncio vive en un solo canal: web o WhatsApp).
-- Vínculo con pedidos (pedidos_origen_anuncio_todos):
--   web: UTM content = ID del anuncio (pedidos nuevos) o su NOMBRE (pedidos viejos); WhatsApp: origen_anuncio_id del chat.
-- Días útiles: días con CPA de 3 días (gasto 3 días ÷ pedidos 3 días) debajo del equilibrio (₲41.000).
-- Cansancio (§3): formularios÷clics (web) o pedidos÷chats (WhatsApp) cae 50% o más contra sus primeros 3 días con gasto,
--   en sus 2 últimos días con gasto. Mínimo de volumen para no alarmar por ruido: web ≥ 15 clics en los primeros 3 días
--   y ≥ 5 en cada uno de los 2 últimos; WhatsApp ≥ 8 chats y ≥ 3. Solo informa: nada de esto toca los anuncios.
create or replace view public.creativos_dia_detalle as
with ped as (
  select coalesce(
           case when o.origen = 'whatsapp' then o.anuncio_wa end,
           case when o.utm_content ~ '^\d{10,}$' then o.utm_content end,
           (select c.ad_id from public.creativos_diario c where c.ad_nombre = o.utm_content order by c.fecha desc limit 1)
         ) as ad_id,
         (o.creado_en at time zone 'America/Asuncion')::date as fecha, o.entregado
  from public.pedidos_origen_anuncio_todos o
  where coalesce(o.estado_confirmacion, '') not like 'cancelado%'
), pd as (
  select ad_id, fecha, count(*) as pedidos, count(*) filter (where entregado) as entregados from ped where ad_id is not null group by 1, 2
), dia as (
  select d.*, coalesce(pd.pedidos, 0) as pedidos, coalesce(pd.entregados, 0) as entregados
  from public.creativos_diario d left join pd using (ad_id, fecha)
)
select dia.*,
  sum(gasto) over w3 as gasto_3d, sum(pedidos) over w3 as pedidos_3d,
  case when canal = 'whatsapp' then case when conversaciones > 0 then pedidos::numeric / conversaciones end
       else case when clics > 0 then formularios::numeric / clics end end as tasa,
  count(*) filter (where gasto > 0) over (partition by ad_id order by fecha) as dia_n
from dia
window w3 as (partition by ad_id order by fecha rows between 2 preceding and current row);

create or replace view public.libro_creativos as
with d as (select * from public.creativos_dia_detalle),
base as (  -- primeros 3 días con gasto
  select ad_id,
    case when max(canal) = 'whatsapp' then sum(pedidos)::numeric / nullif(sum(conversaciones), 0)
         else sum(formularios)::numeric / nullif(sum(clics), 0) end as tasa_inicial,
    case when max(canal) = 'whatsapp' then sum(conversaciones) >= 8 else sum(clics) >= 15 end as base_suficiente
  from d where gasto > 0 and dia_n <= 3 group by ad_id
), ult as (  -- últimos 2 días con gasto (después de los 3 primeros)
  select ad_id, tasa, fecha, row_number() over (partition by ad_id order by fecha desc) as k,
    case when canal = 'whatsapp' then conversaciones >= 3 else clics >= 5 end as volumen_ok
  from d where gasto > 0 and dia_n > 3
), cans as (
  select u.ad_id,
    bool_and(b.base_suficiente and u.volumen_ok and b.tasa_inicial > 0 and coalesce(u.tasa, 0) <= 0.5 * b.tasa_inicial) and count(*) = 2 as cansado,
    round(100 * (avg(coalesce(u.tasa, 0)) / nullif(max(b.tasa_inicial), 0) - 1)) as caida_pct
  from ult u join base b using (ad_id) where u.k <= 2 group by u.ad_id
), agg as (
  select ad_id, max(ad_nombre) as anuncio, max(canal) as canal, max(adset_nombre) as conjunto, max(campana_nombre) as campana,
    min(fecha) filter (where gasto > 0) as publicado, max(fecha) filter (where gasto > 0) as ultimo_gasto,
    sum(gasto) as gasto, sum(impresiones) as impresiones, sum(clics) as clics, sum(formularios) as formularios,
    sum(compras) as compras_pixel, sum(conversaciones) as chats, sum(pedidos) as pedidos, sum(entregados) as entregados,
    count(*) filter (where pedidos_3d > 0 and gasto_3d / pedidos_3d < 41000) as dias_utiles
  from d group by ad_id
)
select a.ad_id, a.anuncio, a.canal,
  case when a.anuncio ~* 'pack|gudair' then 'Pack' when a.anuncio ~* 'raspador|lengua' then 'Raspador'
       when a.anuncio ~* 'tira|nasal' then 'Tiras' when a.anuncio ~* 'parche|bucal' then 'Parches'
       when a.anuncio ~* 'jaw|mandibula|mandíbula|ejercitador' then 'JawFlex' when a.anuncio ~* 'botella' then 'Botella' else 'Varios' end as producto,
  a.conjunto, a.campana, a.publicado, a.ultimo_gasto, round(a.gasto) as gasto, a.clics, a.formularios, a.compras_pixel, a.chats,
  a.pedidos, a.entregados,
  round(a.gasto / nullif(a.pedidos, 0)) as cpa, round(a.gasto / nullif(a.entregados, 0)) as costo_por_entregado,
  a.dias_utiles, round(b.tasa_inicial * 100, 1) as tasa_inicial_pct, c.caida_pct,
  case when a.ultimo_gasto is null or a.ultimo_gasto < (now() at time zone 'America/Asuncion')::date - 1 then 'apagado'
       when coalesce(c.cansado, false) then 'cansado'
       when a.conjunto ~* 'prueba' then 'prueba'
       else 'escala' end as estado
from agg a left join base b using (ad_id) left join cans c using (ad_id);

grant select on public.creativos_dia_detalle, public.libro_creativos to authenticated, service_role;
