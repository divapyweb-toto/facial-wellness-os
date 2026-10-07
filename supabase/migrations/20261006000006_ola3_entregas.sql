-- ═══════════════════════════════════════════════════════════
-- OLA 3 · Post-entrega y KPI semanal (subagente H2) · 06-10-2026
-- ═══════════════════════════════════════════════════════════
-- 1. shopify_pedidos: fecha real de entrega, marcas de "ya hecho" (pagado / CAPI)
--    y control de reintentos de la función post-entrega.
-- 2. Vista post_entrega_pendientes (la lee la función post-entrega).
-- 3. Vista kpi_whatsapp_semanal (la lee el panel /kpi-whatsapp).
-- 4. Cron: post-entrega cada 30 minutos (mismo patrón que 20261006000003_crons.sql).
-- Idempotente: se puede correr dos veces. No toca datos existentes.
-- ═══════════════════════════════════════════════════════════

-- ─── 1. Columnas ────────────────────────────────────────────
alter table public.shopify_pedidos
  add column if not exists entregado_en              timestamptz,
  add column if not exists entregado_fuente          text,          -- 'courier' (fecha del reporte) | 'importacion' (hora en que se importó)
  add column if not exists pagado_marcado            boolean not null default false,
  add column if not exists capi_enviado              boolean not null default false,
  add column if not exists capi_omitido              text,          -- motivo si no se manda (p. ej. 'fuera_de_plazo_7_dias')
  add column if not exists post_entrega_intentos     int not null default 0,
  add column if not exists post_entrega_ultimo_error text,
  add column if not exists post_entrega_procesado_en timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shopify_pedidos_entregado_fuente_chk') then
    alter table public.shopify_pedidos
      add constraint shopify_pedidos_entregado_fuente_chk
      check (entregado_fuente is null or entregado_fuente in ('courier','importacion'));
  end if;
end
$$;

create index if not exists shopify_pedidos_entregado_en_idx
  on public.shopify_pedidos (entregado_en desc) where entregado_en is not null;
create index if not exists pedido_estados_entregado_idx
  on public.pedido_estados (shopify_order_id) where estado = 'ENTREGADO';
-- Para buscar el ctwa_clid del anuncio click-to-WhatsApp en los mensajes entrantes.
create index if not exists wa_mensajes_ctwa_idx
  on public.wa_mensajes (cliente_id, creado_en desc)
  where direccion = 'in' and (contenido -> 'referral' ->> 'ctwa_clid') is not null;

-- ─── 2. Pendientes de post-entrega ──────────────────────────
-- Pedidos con ENTREGADO registrado a los que les falta algo. Los cancelados por el
-- cliente no entran (importar-courier ya los manda a courier_revision).
create or replace view public.post_entrega_pendientes
with (security_invoker = true) as
select p.shopify_order_id, p.nombre, p.cliente_id, p.telefono, p.total, p.tags, p.creado_en,
       p.entregado_en, p.pagado_marcado, p.capi_enviado, p.capi_omitido, p.post_entrega_intentos,
       e.creado_en as entregado_registrado_en,
       e.fuente    as entregado_fuente_estado
  from public.pedido_estados e
  join public.shopify_pedidos p on p.shopify_order_id = e.shopify_order_id
 where e.estado = 'ENTREGADO'
   and not p.es_borrador
   and p.estado_confirmacion not in ('cancelado_cliente','cancelado_sin_respuesta')
   and (p.entregado_en is null
        or not p.pagado_marcado
        or (not p.capi_enviado and p.capi_omitido is null));

revoke all on public.post_entrega_pendientes from anon;
grant select on public.post_entrega_pendientes to authenticated, service_role;

-- ─── 3. KPI semanal ─────────────────────────────────────────
-- Semana = lunes a domingo en hora de Asunción. Cohortes:
--   · pedidos, confirmación, entrega, recompra y costo por entregado: por semana de CREACIÓN del pedido
--     (los entregados de una semana reciente todavía crecen hasta que el courier los reporta).
--   · mensajes (costo), conversaciones, derivaciones y reclamos: por semana en que ocurrieron.
-- costo_ia_usd sale de wa_conversaciones.costo_ia_usd (columna de la ola 2); se lee con to_jsonb
-- para que la vista funcione aunque esa columna todavía no exista (queda en 0).
create or replace view public.kpi_whatsapp_semanal
with (security_invoker = true) as
with ped as (
  select p.shopify_order_id, p.cliente_id, p.creado_en,
         date_trunc('week', p.creado_en at time zone 'America/Asuncion')::date as semana,
         (p.estado_confirmacion = 'confirmado' or 'CONFIRMADO' = any(p.tags)) as confirmado,
         ('ORIGEN_WHATSAPP' = any(p.tags)) as de_whatsapp,
         exists (select 1 from public.pedido_estados e
                  where e.shopify_order_id = p.shopify_order_id and e.estado = 'ENTREGADO') as entregado,
         exists (select 1 from public.pedido_estados e
                  where e.shopify_order_id = p.shopify_order_id and e.estado = 'NO_ENTREGADO') as no_entregado,
         (select min(m.creado_en) from public.wa_mensajes m
           where m.cliente_id = p.cliente_id and m.direccion = 'in'
             and coalesce(m.contenido -> 'interactive' -> 'button_reply' ->> 'id',
                          m.contenido -> 'button' ->> 'payload') = 'conf_si:' || p.shopify_order_id) as confirmado_en,
         exists (select 1 from public.shopify_pedidos a
                  join public.pedido_estados ea on ea.shopify_order_id = a.shopify_order_id and ea.estado = 'ENTREGADO'
                 where a.cliente_id = p.cliente_id and a.cliente_id is not null
                   and a.shopify_order_id <> p.shopify_order_id
                   and a.creado_en < p.creado_en and not a.es_borrador) as es_recompra
    from public.shopify_pedidos p
   where not p.es_borrador
),
ped_sem as (
  select semana,
         count(*)                                                    as pedidos,
         count(*) filter (where de_whatsapp)                         as pedidos_whatsapp,
         count(*) filter (where confirmado)                          as confirmados,
         count(*) filter (where entregado)                           as entregados,
         count(*) filter (where no_entregado and not entregado)      as no_entregados,
         count(*) filter (where confirmado and entregado)            as entregados_confirmados,
         count(*) filter (where confirmado and no_entregado and not entregado) as no_entregados_confirmados,
         count(*) filter (where not confirmado and entregado)        as entregados_no_confirmados,
         count(*) filter (where not confirmado and no_entregado and not entregado) as no_entregados_no_confirmados,
         percentile_cont(0.5) within group (
           order by extract(epoch from (confirmado_en - creado_en)) / 60.0
         ) filter (where confirmado_en is not null and confirmado_en >= creado_en) as minutos_mediana_confirmar,
         count(*) filter (where es_recompra)                         as recompras
    from ped group by semana
),
msg_sem as (
  select date_trunc('week', creado_en at time zone 'America/Asuncion')::date as semana,
         coalesce(sum(costo_usd), 0)                                  as costo_mensajes_usd,
         count(*) filter (where direccion = 'in'
           and coalesce(contenido -> 'interactive' -> 'button_reply' ->> 'id',
                        contenido -> 'button' ->> 'payload') like 'seg_problema:%') as reclamos
    from public.wa_mensajes group by 1
),
conv_sem as (
  select date_trunc('week', c.creado_en at time zone 'America/Asuncion')::date as semana,
         count(*)                                                     as conversaciones,
         count(*) filter (where c.estado = 'humano' or c.asignado_a is not null) as derivadas,
         count(*) filter (where c.origen_anuncio_id is not null)      as conversaciones_anuncio,
         coalesce(sum(nullif(to_jsonb(c) ->> 'costo_ia_usd', '')::numeric), 0) as costo_ia_usd
    from public.wa_conversaciones c group by 1
),
semanas as (
  select semana from ped_sem union select semana from msg_sem union select semana from conv_sem
)
select s.semana,
       coalesce(p.pedidos, 0)                    as pedidos,
       coalesce(p.pedidos_whatsapp, 0)           as pedidos_whatsapp,
       coalesce(p.confirmados, 0)                as confirmados,
       round(100.0 * p.confirmados / nullif(p.pedidos, 0), 1) as pct_confirmados,
       coalesce(p.entregados, 0)                 as entregados,
       coalesce(p.no_entregados, 0)              as no_entregados,
       round(100.0 * p.entregados / nullif(p.entregados + p.no_entregados, 0), 1) as pct_entregados,
       round(100.0 * p.entregados_confirmados / nullif(p.entregados_confirmados + p.no_entregados_confirmados, 0), 1)
                                                 as pct_entrega_confirmados,
       round(100.0 * p.entregados_no_confirmados / nullif(p.entregados_no_confirmados + p.no_entregados_no_confirmados, 0), 1)
                                                 as pct_entrega_no_confirmados,
       round(p.minutos_mediana_confirmar::numeric, 1) as minutos_mediana_confirmar,
       coalesce(m.costo_mensajes_usd, 0)         as costo_mensajes_usd,
       coalesce(c.costo_ia_usd, 0)               as costo_ia_usd,
       round(m.costo_mensajes_usd / nullif(p.entregados, 0), 4) as costo_mensajes_por_entregado_usd,
       round(c.costo_ia_usd / nullif(p.entregados, 0), 4)       as costo_ia_por_entregado_usd,
       coalesce(c.conversaciones, 0)             as conversaciones,
       coalesce(c.conversaciones_anuncio, 0)     as conversaciones_anuncio,
       coalesce(c.derivadas, 0)                  as derivadas,
       round(100.0 * c.derivadas / nullif(c.conversaciones, 0), 1) as pct_derivado,
       round(100.0 * p.pedidos_whatsapp / nullif(c.conversaciones, 0), 1) as pct_conversacion_a_pedido,
       coalesce(p.recompras, 0)                  as recompras,
       coalesce(m.reclamos, 0)                   as reclamos,
       round(100.0 * m.reclamos / nullif(p.entregados, 0), 1) as reclamos_por_100_entregados
  from semanas s
  left join ped_sem  p on p.semana = s.semana
  left join msg_sem  m on m.semana = s.semana
  left join conv_sem c on c.semana = s.semana;

revoke all on public.kpi_whatsapp_semanal from anon;
grant select on public.kpi_whatsapp_semanal to authenticated, service_role;

-- ─── 4. Cron cada 30 min ────────────────────────────────────
-- Usa public.invocar_edge_function (20261006000003_crons.sql; URL y service role desde Vault).
create extension if not exists pg_cron;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'wa-post-entrega') then
    perform cron.unschedule('wa-post-entrega');
  end if;
end
$$;
select cron.schedule('wa-post-entrega', '*/30 * * * *', $$select public.invocar_edge_function('post-entrega')$$);
