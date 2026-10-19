-- 20261019000003 · Libro de creativos v2 (Enrique 19-10-2026):
--  1. Cansancio: últimos 2 días contra los 2 MEJORES días del anuncio (su pico), mismos mínimos de volumen por día
--     (web ≥ 5 clics, WhatsApp ≥ 3 chats). Un ganador en Paraguay dura 2-4 días: con "primeros 3" el aviso llegaba tarde.
--  2. Equilibrio por producto (CPA máximo que deja cada pedido antes de pagar Meta) en config 'equilibrio_producto',
--     editable. Valores del 07 al 18-10 (80% de entrega, costos actuales, mezcla real de unidades).
--  3. Costo por entregado solo sobre pedidos RESUELTOS: (gasto por pedido × resueltos) ÷ entregados; columna pendientes aparte.
insert into public.config (clave, valor) values
  ('equilibrio_producto', '{"Raspador":60000,"Pack":51000,"Parches":48000,"Botella":45000,"Tiras":44000,"JawFlex":39000,"Varios":41000}')
on conflict (clave) do nothing;

drop view if exists public.libro_creativos;
drop view if exists public.creativos_dia_detalle;

create view public.creativos_dia_detalle as
with ped as (
  select coalesce(
           case when o.origen = 'whatsapp' then o.anuncio_wa end,
           case when o.utm_content ~ '^\d{10,}$' then o.utm_content end,
           (select c.ad_id from public.creativos_diario c where c.ad_nombre = o.utm_content order by c.fecha desc limit 1)
         ) as ad_id,
         (o.creado_en at time zone 'America/Asuncion')::date as fecha, o.entregado,
         (not o.entregado and (
            exists (select 1 from public.pedido_estados e where e.shopify_order_id = o.shopify_order_id and e.estado in ('CANCELADO', 'NO_ENTREGADO', 'DEVUELTO'))
            or exists (select 1 from public.entregas en where en.n_referencia = o.referencia and en.categoria = 'devuelto'))) as devuelto
  from public.pedidos_origen_anuncio_todos o
  where coalesce(o.estado_confirmacion, '') not like 'cancelado%'
), pd as (
  select ad_id, fecha, count(*) as pedidos, count(*) filter (where entregado) as entregados, count(*) filter (where devuelto) as devueltos
  from ped where ad_id is not null group by 1, 2
), dia as (
  select d.*, coalesce(pd.pedidos, 0) as pedidos, coalesce(pd.entregados, 0) as entregados, coalesce(pd.devueltos, 0) as devueltos
  from public.creativos_diario d left join pd using (ad_id, fecha)
)
select dia.*,
  case when dia.ad_nombre ~* 'pack|gudair' then 'Pack' when dia.ad_nombre ~* 'raspador|lengua' then 'Raspador'
       when dia.ad_nombre ~* 'tira|nasal' then 'Tiras' when dia.ad_nombre ~* 'parche|bucal' then 'Parches'
       when dia.ad_nombre ~* 'jaw|mandibula|mandíbula|ejercitador' then 'JawFlex' when dia.ad_nombre ~* 'botella' then 'Botella' else 'Varios' end as producto,
  sum(gasto) over w3 as gasto_3d, sum(pedidos) over w3 as pedidos_3d,
  case when canal = 'whatsapp' then case when conversaciones > 0 then pedidos::numeric / conversaciones end
       else case when clics > 0 then formularios::numeric / clics end end as tasa,
  case when canal = 'whatsapp' then conversaciones >= 3 else clics >= 5 end as volumen_ok,
  count(*) filter (where gasto > 0) over (partition by ad_id order by fecha) as dia_n
from dia
window w3 as (partition by ad_id order by fecha rows between 2 preceding and current row);

create view public.libro_creativos as
with eq as (select coalesce((select valor::jsonb from public.config where clave = 'equilibrio_producto'), '{}'::jsonb) as j),
d as (
  select x.*, coalesce((eq.j ->> x.producto)::numeric, (eq.j ->> 'Varios')::numeric, 41000) as equilibrio
  from public.creativos_dia_detalle x, eq
),
ult as (  -- últimos 2 días con gasto
  select ad_id, fecha, tasa, volumen_ok, row_number() over (partition by ad_id order by fecha desc) as k from d where gasto > 0
),
pico as (  -- los 2 mejores días (con volumen) fuera de los últimos 2
  select ad_id, avg(tasa) as tasa_pico, count(*) as n from (
    select d.ad_id, d.tasa, row_number() over (partition by d.ad_id order by d.tasa desc) as r
    from d join ult u on u.ad_id = d.ad_id and u.fecha = d.fecha
    where u.k > 2 and d.volumen_ok and d.tasa is not null
  ) t where r <= 2 group by ad_id
),
cans as (
  select u.ad_id,
    count(*) = 2 and bool_and(u.volumen_ok and p.n = 2 and p.tasa_pico > 0 and coalesce(u.tasa, 0) <= 0.5 * p.tasa_pico) as cansado,
    round(100 * (avg(coalesce(u.tasa, 0)) / nullif(max(p.tasa_pico), 0) - 1)) as caida_pct
  from ult u join pico p using (ad_id) where u.k <= 2 group by u.ad_id
),
agg as (
  select ad_id, max(ad_nombre) as anuncio, max(canal) as canal, max(producto) as producto, max(adset_nombre) as conjunto,
    max(campana_nombre) as campana, max(equilibrio) as equilibrio,
    min(fecha) filter (where gasto > 0) as publicado, max(fecha) filter (where gasto > 0) as ultimo_gasto,
    sum(gasto) as gasto, sum(clics) as clics, sum(formularios) as formularios, sum(compras) as compras_pixel,
    sum(conversaciones) as chats, sum(pedidos) as pedidos, sum(entregados) as entregados, sum(devueltos) as devueltos,
    count(*) filter (where pedidos_3d > 0 and gasto_3d / pedidos_3d < equilibrio) as dias_utiles
  from d group by ad_id
)
select a.ad_id, a.anuncio, a.canal, a.producto, a.conjunto, a.campana, a.publicado, a.ultimo_gasto, round(a.gasto) as gasto,
  a.clics, a.formularios, a.compras_pixel, a.chats, a.pedidos, a.entregados, a.devueltos,
  a.pedidos - a.entregados - a.devueltos as pendientes,
  round(a.gasto / nullif(a.pedidos, 0)) as cpa, round(a.equilibrio) as equilibrio,
  -- gasto que corresponde a los pedidos ya resueltos ÷ entregados de esos pedidos
  round((a.gasto / nullif(a.pedidos, 0)) * (a.entregados + a.devueltos) / nullif(a.entregados, 0)) as costo_por_entregado,
  a.dias_utiles, round(p.tasa_pico * 100, 1) as tasa_pico_pct, c.caida_pct,
  case when a.ultimo_gasto is null or a.ultimo_gasto < (now() at time zone 'America/Asuncion')::date - 1 then 'apagado'
       when coalesce(c.cansado, false) then 'cansado'
       when a.conjunto ~* 'prueba' then 'prueba'
       else 'escala' end as estado
from agg a left join pico p using (ad_id) left join cans c using (ad_id);

grant select on public.creativos_dia_detalle, public.libro_creativos to authenticated, service_role;
