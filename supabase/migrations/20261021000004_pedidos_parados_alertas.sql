-- 20261021000004 · Que nada quede parado (Enrique 21-10-2026). Vistas de UNA sola fuente para Despacho, resumen diario y avisos.
-- "Salió" = ventas.despachado_at, o un estado REAL del courier en entregas (el placeholder de Lucero, vacío, no cuenta),
-- o la venta ya figura entregada/devuelta. NUNCA el fulfillment de Shopify: la importación lo crea al cargar la venta.

-- Pedidos confirmados de Voltra, de más de 24 h, que todavía no salieron. etapa: sin_cargar (no está en Ventas) | sin_despachar.
create or replace view public.pedidos_parados as
with base as (
  select sp.shopify_order_id, sp.nombre, 'VT-' || replace(sp.nombre, '#', '') as ref, sp.creado_en,
    sp.raw -> 'shipping_address' ->> 'city' as ciudad,
    extract(epoch from (now() - sp.creado_en)) / 3600 as horas
  from public.shopify_pedidos sp
  where sp.nombre ~ '^#[0-9]+$' and not sp.es_borrador and sp.estado_confirmacion = 'confirmado'
    and (sp.raw ->> 'cancelled_at') is null
    and sp.creado_en >= now() - interval '30 days' and sp.creado_en < now() - interval '24 hours'
    and not exists (select 1 from unnest(sp.tags) t where upper(t) in ('CANCELADO_CLIENTE', 'RETIRO_EN_CASA', 'SIN_COBERTURA_CANCELADO')
                      or upper(t) like '%PRUEBA%' or upper(t) like 'REEMPLAZADO%')
    -- sin cobertura esperando el pago anticipado: va en su propia línea
    and not (exists (select 1 from unnest(sp.tags) t where upper(t) = 'SIN_COBERTURA')
             and not exists (select 1 from unnest(sp.tags) t where upper(t) in ('PAGADO', 'PAGO_VERIFICADO', 'PAGADO_QR', 'PAGO_ANTICIPADO_COMPROBANTE')))
)
select b.shopify_order_id, b.nombre, b.ref, b.ciudad, round(b.horas::numeric, 1) as horas, floor(b.horas / 24)::int as dias,
  case when v.id is null then 'sin_cargar' else 'sin_despachar' end as etapa,
  v.transportadora as courier, v.producto_nombre as producto
from base b
left join lateral (select x.* from public.ventas x where x.n_referencia = b.ref and x.deleted_at is null order by x.created_at limit 1) v on true
where not exists (select 1 from public.ventas x where x.n_referencia = b.ref and x.deleted_at is null
                    and (x.despachado_at is not null or x.estado in ('entregado', 'devuelto')))
  and not exists (select 1 from public.entregas e where e.n_referencia = b.ref and coalesce(trim(e.estado_pap), '') <> '');

-- Rendición atrasada: entregados sin rendir. PaP desde 15 días, Lucero desde 4 (lo que el courier le debe a Voltra).
create or replace view public.rendicion_atrasada as
select e.n_referencia as ref, e.transportadora as courier, e.fecha_entrega,
  (current_date - e.fecha_entrega) as dias,
  coalesce(e.cobrado, e.importe, 0) - coalesce(e.costo_envio, 0) as monto_neto
from public.entregas e
where e.tienda = 'voltra' and e.categoria = 'entregado' and coalesce(e.rendido, false) = false and e.fecha_entrega is not null
  and (current_date - e.fecha_entrega) >= case e.transportadora when 'pap' then 15 when 'lucero' then 4 else 9999 end;

-- Estados de entrega que piden acción HOY (Voltra). Lucero: fallido / no contesta / reprogramar. PaP: custodio / inubicable /
-- no gestionado / fuera de cobertura (PaP no reintenta: es la última chance de llamar al cliente).
create or replace view public.entregas_para_actuar as
select e.n_referencia as ref, e.transportadora as courier, e.estado_pap as estado, e.motivo, e.fecha_ingreso,
  case
    when e.transportadora = 'lucero' and e.estado_pap ~* 'fallid|no contest|reprogram' then 'lucero_fallido'
    when e.transportadora = 'pap' and e.estado_pap ~* 'custodi|inubicable|no gestionado|fuera de cobertura' then 'pap_ultima_chance'
  end as tipo
from public.entregas e
where e.tienda = 'voltra' and e.categoria is distinct from 'entregado'
  and ((e.transportadora = 'lucero' and e.estado_pap ~* 'fallid|no contest|reprogram')
    or (e.transportadora = 'pap' and e.estado_pap ~* 'custodi|inubicable|no gestionado|fuera de cobertura'));

-- Rendimiento por courier y zona: últimas 4 semanas contra las 4 anteriores (por fecha del pedido).
create or replace view public.courier_rendimiento as
with base as (
  select r.courier, coalesce(tz.zona, 'sin zona') as zona, r.entregado, r.dias_pedido_entrega, r.dias_rendicion, r.costo_envio,
    r.venta_total as total, r.venta_costo_prod as costo_prod,
    case when r.fecha_pedido >= current_date - 28 then 'ultimas_4_semanas'
         when r.fecha_pedido >= current_date - 56 then '4_semanas_anteriores' end as periodo
  from public.courier_resueltos r
  left join lateral (select coalesce(t.zona, t.tiempo) as zona from public.tarifas_courier_vigente t where t.courier = r.courier and t.ciudad = r.ciudad limit 1) tz on true
  where r.fecha_pedido >= current_date - 56
), tot as (
  select b.*, 1 as uno from base b where periodo is not null
), g as (
  select courier, zona, periodo, count(*) resueltos, count(*) filter (where entregado) entregados,
    percentile_cont(0.5) within group (order by dias_pedido_entrega) filter (where entregado and dias_pedido_entrega between 0 and 90) as dpe,
    percentile_cont(0.5) within group (order by dias_rendicion) filter (where entregado and dias_rendicion between 0 and 90) as dre,
    sum(costo_envio) as fletes,
    sum(coalesce(total, 0) - coalesce(costo_prod, 0)) filter (where entregado) as margen
  from tot group by courier, zona, periodo
  union all
  select courier, 'TODAS', periodo, count(*), count(*) filter (where entregado),
    percentile_cont(0.5) within group (order by dias_pedido_entrega) filter (where entregado and dias_pedido_entrega between 0 and 90),
    percentile_cont(0.5) within group (order by dias_rendicion) filter (where entregado and dias_rendicion between 0 and 90),
    sum(costo_envio), sum(coalesce(total, 0) - coalesce(costo_prod, 0)) filter (where entregado)
  from tot group by courier, periodo
)
select courier, zona, periodo, resueltos, entregados,
  round(100.0 * entregados / nullif(resueltos, 0), 1) as tasa_entrega,
  round(dpe::numeric, 1) as dias_pedido_a_entrega,
  round(dre::numeric, 1) as dias_rendicion,
  round(fletes::numeric / nullif(entregados, 0)) as flete_por_entregado,
  -- ganancia por pedido DESPACHADO = (margen de los entregados − todos los fletes) / resueltos (los devueltos pagan flete igual)
  round((coalesce(margen, 0) - coalesce(fletes, 0))::numeric / nullif(resueltos, 0)) as ganancia_por_pedido_despachado
from g;

-- % de cambios manuales del courier (Despacho guarda cada cambio en courier_cambios).
create or replace view public.courier_cambios_resumen as
select date_trunc('week', c.creado_en)::date as semana, count(*) as cambios,
  count(*) filter (where c.ganancia_final is not null and c.ganancia_motor is not null and c.ganancia_final > c.ganancia_motor) as mejor_que_el_motor,
  count(*) filter (where c.ganancia_final is not null and c.ganancia_motor is not null and c.ganancia_final < c.ganancia_motor) as peor_que_el_motor
from public.courier_cambios c group by 1;

grant select on public.pedidos_parados, public.rendicion_atrasada, public.entregas_para_actuar, public.courier_rendimiento, public.courier_cambios_resumen to authenticated, service_role;
