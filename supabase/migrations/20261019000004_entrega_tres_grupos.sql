-- 20261019000004 · Regla de entrega en 3 grupos + embudo (Enrique 19-10-2026).
-- ENTREGADO / EN_GESTION / PERDIDO (definitivo). Fuera del cálculo de entrega: NO_SALIO (PaP "NO INGRESO A PAP",
-- "Borrador"), NO_CONFIRMADO (cancelado sin respuesta: va en la tasa de confirmación) y SIN_CONFIRMAR (todavía pendiente).
--  · Lucero: PERDIDO solo con ESTADO Devuelto o Cancelado. Fallido, Aceptado, En camino, Cargado, reagendado = EN_GESTION.
--  · PaP (no reintenta): Custodio, inubicable, no gestionado, fuera de cobertura, rechazado, devolución en proceso,
--    devuelto definitivo, cancelado = PERDIDO. Asignado a ruta / en camino = EN_GESTION.
--  · Los dos: reingresado al stock o cancelado por el cliente = PERDIDO.
-- Tasa de entrega y costo por entregado: solo ENTREGADO + PERDIDO.

-- Custodia de PaP: desde cuándo (no había registro). Se completa sola al pasar a Custodio.
alter table public.entregas add column if not exists custodia_desde timestamptz;
create or replace function public.fw_entregas_custodia() returns trigger language plpgsql as $$
begin
  if coalesce(NEW.estado_pap, '') ~* 'custodi' then
    if TG_OP = 'INSERT' or coalesce(OLD.estado_pap, '') !~* 'custodi' or NEW.custodia_desde is null then
      NEW.custodia_desde := coalesce(NEW.custodia_desde, now());
    end if;
  else
    NEW.custodia_desde := null;
  end if;
  return NEW;
end $$;
drop trigger if exists entregas_custodia on public.entregas;
create trigger entregas_custodia before insert or update of estado_pap on public.entregas for each row execute function public.fw_entregas_custodia();
update public.entregas set custodia_desde = created_at where estado_pap ~* 'custodi' and custodia_desde is null; -- los viejos: desde que entraron al sistema

-- Rescate de pedidos en custodia (aviso al cliente): listo, apagado hasta que Enrique confirme que se puede.
insert into public.config (clave, valor) values ('rescate_custodia', '{"activo": false}') on conflict (clave) do nothing;

create or replace view public.pedidos_entrega as
with base as (
  select o.shopify_order_id, o.nombre, o.referencia, (o.creado_en at time zone 'America/Asuncion')::date as fecha, o.origen as canal,
    coalesce(case when o.origen = 'whatsapp' then o.anuncio_wa end, case when o.utm_content ~ '^\d{10,}$' then o.utm_content end,
      (select c.ad_id from public.creativos_diario c where c.ad_nombre = o.utm_content order by c.fecha desc limit 1)) as ad_id,
    o.entregado, coalesce(o.estado_confirmacion, 'pendiente') as estado_confirmacion
  from public.pedidos_origen_anuncio_todos o
  join public.shopify_pedidos sp on sp.shopify_order_id = o.shopify_order_id
  where (sp.raw ->> 'cancelled_at' is null or o.estado_confirmacion like 'cancelado%')
    and not exists (select 1 from unnest(sp.tags) t where upper(t) like '%PRUEBA%' or upper(t) like 'REEMPLAZADO%')
    and o.nombre not ilike '%prueba%'
), con_envio as (
  select b.*, en.transportadora, en.estado_pap as estado_courier, en.motivo, en.custodia_desde,
    coalesce(en.fecha_ingreso::timestamptz, en.created_at) as gestion_desde,
    exists (select 1 from public.ventas v where v.n_referencia = b.referencia and v.reingresado_at is not null) as reingresado
  from base b
  left join lateral (select * from public.entregas e where e.n_referencia = b.referencia order by e.created_at desc limit 1) en on true
)
select c.*,
  c.estado_confirmacion in ('confirmado', 'cancelado_cliente') as confirmado,
  case
    when c.entregado or coalesce(c.estado_courier, '') ~* '^entregado$' then 'ENTREGADO'
    when c.estado_confirmacion = 'cancelado_cliente' or c.reingresado then 'PERDIDO'
    when c.estado_confirmacion like 'cancelado_sin%' then 'NO_CONFIRMADO'
    when c.estado_confirmacion <> 'confirmado' then 'SIN_CONFIRMAR'
    when c.transportadora = 'lucero' and coalesce(c.estado_courier, '') ~* '^\s*(devuelto|cancelado)\s*$' then 'PERDIDO'
    when c.transportadora = 'pap' and coalesce(c.estado_courier, '') ~* 'no ingreso|borrador' then 'NO_SALIO'
    when c.transportadora = 'pap' and coalesce(c.estado_courier, '') ~* 'custodi|inubicable|no gestionado|fuera de cobertura|rechaz|devoluci|devuelto|cancelad' then 'PERDIDO'
    else 'EN_GESTION'
  end as grupo,
  coalesce(c.estado_courier, '') ~* 'custodi' as en_custodia
from con_envio c;

-- Embudo por día y canal: generados → confirmados → entregados / perdidos → % cobrado sobre generados.
create or replace view public.embudo_diario as
select fecha, canal,
  count(*) as generados,
  count(*) filter (where confirmado) as confirmados,
  count(*) filter (where grupo = 'ENTREGADO') as entregados,
  count(*) filter (where grupo = 'PERDIDO') as perdidos,
  count(*) filter (where grupo = 'EN_GESTION') as en_gestion,
  round(100.0 * count(*) filter (where confirmado) / nullif(count(*), 0), 1) as tasa_confirmacion,
  round(100.0 * count(*) filter (where grupo = 'ENTREGADO') / nullif(count(*) filter (where grupo in ('ENTREGADO', 'PERDIDO')), 0), 1) as tasa_entrega,
  round(100.0 * count(*) filter (where grupo = 'ENTREGADO') / nullif(count(*), 0), 1) as cobrado_sobre_generados
from public.pedidos_entrega group by fecha, canal;

drop view if exists public.libro_creativos;
drop view if exists public.creativos_dia_detalle;

create view public.creativos_dia_detalle as
with pd as (
  select ad_id, fecha, count(*) as generados, count(*) filter (where confirmado) as confirmados,
    count(*) filter (where grupo = 'ENTREGADO') as entregados, count(*) filter (where grupo = 'PERDIDO') as perdidos,
    count(*) filter (where grupo = 'EN_GESTION') as en_gestion
  from public.pedidos_entrega where ad_id is not null group by 1, 2
), dia as (
  select d.*, coalesce(pd.generados, 0) as pedidos, coalesce(pd.confirmados, 0) as confirmados, coalesce(pd.entregados, 0) as entregados,
    coalesce(pd.perdidos, 0) as perdidos, coalesce(pd.en_gestion, 0) as en_gestion
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
ult as (select ad_id, fecha, tasa, volumen_ok, row_number() over (partition by ad_id order by fecha desc) as k from d where gasto > 0),
pico as (
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
    sum(conversaciones) as chats, sum(pedidos) as generados, sum(confirmados) as confirmados, sum(entregados) as entregados,
    sum(perdidos) as perdidos, sum(en_gestion) as en_gestion,
    count(*) filter (where pedidos_3d > 0 and gasto_3d / pedidos_3d < equilibrio) as dias_utiles
  from d group by ad_id
)
select a.ad_id, a.anuncio, a.canal, a.producto, a.conjunto, a.campana, a.publicado, a.ultimo_gasto, round(a.gasto) as gasto,
  a.clics, a.formularios, a.compras_pixel, a.chats,
  a.generados, a.confirmados, a.entregados, a.perdidos, a.en_gestion,
  round(100.0 * a.confirmados / nullif(a.generados, 0), 1) as tasa_confirmacion,
  round(100.0 * a.entregados / nullif(a.entregados + a.perdidos, 0), 1) as tasa_entrega,
  round(100.0 * a.entregados / nullif(a.generados, 0), 1) as cobrado_sobre_generados,
  round(a.gasto / nullif(a.generados, 0)) as cpa, round(a.equilibrio) as equilibrio,
  round((a.gasto / nullif(a.generados, 0)) * (a.entregados + a.perdidos) / nullif(a.entregados, 0)) as costo_por_entregado,
  a.dias_utiles, round(p.tasa_pico * 100, 1) as tasa_pico_pct, c.caida_pct,
  case when a.ultimo_gasto is null or a.ultimo_gasto < (now() at time zone 'America/Asuncion')::date - 1 then 'apagado'
       when coalesce(c.cansado, false) then 'cansado'
       when a.conjunto ~* 'prueba' then 'prueba'
       else 'escala' end as estado
from agg a left join pico p using (ad_id) left join cans c using (ad_id);

grant select on public.pedidos_entrega, public.embudo_diario, public.creativos_dia_detalle, public.libro_creativos to authenticated, service_role;
