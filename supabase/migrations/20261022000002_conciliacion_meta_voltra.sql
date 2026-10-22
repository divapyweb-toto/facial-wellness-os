-- 20261022000002 · Conciliación Meta contra Voltra OS por día y canal (Enrique 22-10-2026). Solo lectura.
-- Meta cuenta una compra cuando se dispara el evento (al crear el pedido web / al confirmarlo por WhatsApp) y NO la
-- descuenta si el pedido se cancela después; no cuenta los pedidos de prueba ni los de WhatsApp sin clic de anuncio.
-- Por eso: web  → meta ≈ vigentes + cancelados;  WhatsApp → meta ≈ vigentes con clic de anuncio + cancelados/reemplazados que ya se habían enviado.
-- OJO: la fecha de Meta es la del DÍA DEL ANUNCIO (impresión/clic), no la del pedido: día a día puede correrse uno o dos; los totales cierran.
create or replace view public.conciliacion_meta_voltra as
with p as (
  select sp.shopify_order_id, (sp.creado_en at time zone 'America/Asuncion')::date as fecha,
    case when 'ORIGEN_WHATSAPP' = any (sp.tags) then 'whatsapp' else 'web' end as canal,
    (sp.nombre ilike '%prueba%' or exists (select 1 from unnest(sp.tags) t where t ilike '%PRUEBA%')) as prueba,
    ((sp.raw ->> 'cancelled_at') is not null or 'CANCELADO_CLIENTE' = any (sp.tags)) as cancelado,
    exists (select 1 from unnest(sp.tags) t where t ilike 'REEMPLAZADO%') as reemplazado,
    ('ORIGEN_WHATSAPP' = any (sp.tags) and exists (
       select 1 from public.wa_mensajes m where m.cliente_id = sp.cliente_id and m.direccion = 'in'
         and m.contenido -> 'referral' ->> 'ctwa_clid' is not null and m.creado_en between sp.creado_en - interval '7 days' and sp.creado_en)) as con_clic
  from public.shopify_pedidos sp
  where not sp.es_borrador and sp.nombre ~ '^#[0-9]+$' and sp.creado_en >= now() - interval '90 days'
), v as (
  select fecha, canal,
    count(*) filter (where not prueba) as voltra_pedidos,
    count(*) filter (where not prueba and not cancelado and not reemplazado) as voltra_vigentes,
    count(*) filter (where not prueba and cancelado) as voltra_cancelados,
    count(*) filter (where not prueba and reemplazado and not cancelado) as voltra_reemplazados,
    count(*) filter (where prueba) as voltra_prueba,
    count(*) filter (where not prueba and not cancelado and not reemplazado and con_clic) as voltra_vigentes_con_clic,
    count(*) filter (where not prueba and not cancelado and not reemplazado and canal = 'whatsapp' and not con_clic) as voltra_vigentes_sin_anuncio
  from p group by fecha, canal
), m as (
  select fecha, canal, sum(compras)::int as meta_compras, round(sum(gasto)) as gasto from public.creativos_diario group by fecha, canal
)
select coalesce(m.fecha, v.fecha) as fecha, coalesce(m.canal, v.canal) as canal,
  coalesce(m.meta_compras, 0) as meta_compras, m.gasto,
  coalesce(v.voltra_pedidos, 0) as voltra_pedidos, coalesce(v.voltra_vigentes, 0) as voltra_vigentes,
  coalesce(v.voltra_cancelados, 0) as voltra_cancelados, coalesce(v.voltra_reemplazados, 0) as voltra_reemplazados,
  coalesce(v.voltra_prueba, 0) as voltra_prueba, coalesce(v.voltra_vigentes_con_clic, 0) as voltra_vigentes_con_clic,
  coalesce(v.voltra_vigentes_sin_anuncio, 0) as voltra_vigentes_sin_anuncio,
  coalesce(m.meta_compras, 0) - coalesce(v.voltra_vigentes, 0) as diferencia_meta_menos_vigentes,
  -- lo que NO se explica después de sumar a los vigentes los cancelados/reemplazados (web) o de usar solo los con clic (WhatsApp)
  coalesce(m.meta_compras, 0) - case when coalesce(m.canal, v.canal) = 'web'
      then coalesce(v.voltra_vigentes, 0) + coalesce(v.voltra_cancelados, 0)
      else coalesce(v.voltra_vigentes_con_clic, 0) + coalesce(v.voltra_cancelados, 0) + coalesce(v.voltra_reemplazados, 0) end as sin_explicar
from m full outer join v on v.fecha = m.fecha and v.canal = m.canal
where coalesce(m.fecha, v.fecha) >= '2026-10-09';

-- Totales por canal (lo que se lee en el parte): una fila por canal desde el 09-10.
create or replace view public.conciliacion_meta_voltra_total as
select canal, count(distinct fecha) as dias, sum(meta_compras) as meta_compras, sum(voltra_pedidos) as voltra_pedidos,
  sum(voltra_vigentes) as voltra_vigentes, sum(voltra_cancelados) as voltra_cancelados, sum(voltra_reemplazados) as voltra_reemplazados,
  sum(voltra_prueba) as voltra_prueba, sum(voltra_vigentes_con_clic) as voltra_vigentes_con_clic,
  sum(voltra_vigentes_sin_anuncio) as voltra_vigentes_sin_anuncio, sum(sin_explicar) as sin_explicar
from public.conciliacion_meta_voltra group by canal;
grant select on public.conciliacion_meta_voltra, public.conciliacion_meta_voltra_total to authenticated, service_role;
