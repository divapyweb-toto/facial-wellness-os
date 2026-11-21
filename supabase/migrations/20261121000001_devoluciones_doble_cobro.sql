-- 21-11-2026 · FUNCIONES · Devoluciones por doble cobro.
-- Caso: el cliente pagó por transferencia (tags PAGADO / PAGO_VERIFICADO / PAGADO_QR, o ventas.pago_anticipado) y el
-- courier igual le cobró al entregar (entregas.cobrado > 0). Voltra recibió la plata dos veces y Enrique le devuelve
-- la transferencia al cliente. Esta migración:
--   1) crea la tabla devoluciones_cliente: una fila por pedido devuelto (devuelto_en null = pendiente marcada a mano);
--   2) crea la vista devoluciones_doble_cobro (security_invoker: lee con los permisos de quien consulta), un renglón por
--      pedido, con el MISMO criterio de pago que pedidos-trabados/pagados_con_cobro.ts (senalPago/armarFilas):
--      · pago parcial (SALDO_PENDIENTE / PAGO_PARCIAL) gana; con SALDO_<n> se devuelve greatest(cobrado − saldo, 0);
--      · CREDITO (cobrar después) no entra; venta anulada (deleted_at) no entra; monto a devolver 0 no entra.
-- Solo lectura sobre entregas, ventas y shopify_pedidos: no cambia nada de lo que ya existe.
-- VOLVER ATRÁS:
--   drop view if exists public.devoluciones_doble_cobro;
--   drop table if exists public.devoluciones_cliente;

create table if not exists public.devoluciones_cliente (
  ref text primary key,                                   -- referencia del pedido ('VT-<número>')
  monto bigint not null check (monto >= 0),               -- lo que se devolvió (monto_devolver al marcar)
  devuelto_en timestamptz,                                -- null = pendiente
  nota text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  actualizado_por text
);
comment on table public.devoluciones_cliente is
  'Transferencias devueltas al cliente por doble cobro (pagó por transferencia y el courier igual cobró). La marca la pantalla Rendición.';

alter table public.devoluciones_cliente enable row level security;
drop policy if exists devoluciones_cliente_todo on public.devoluciones_cliente;
create policy devoluciones_cliente_todo on public.devoluciones_cliente for all to authenticated using (true) with check (true);
revoke all on public.devoluciones_cliente from anon, public;
grant select, insert, update, delete on public.devoluciones_cliente to authenticated, service_role;

create or replace view public.devoluciones_doble_cobro with (security_invoker = true) as
with e as (
  -- Entregas de Voltra entregadas y cobradas, con su venta: por venta_id; si no, por n_referencia (venta no anulada).
  select en.transportadora, en.guia_transportadora, en.nro_guia_pap, en.fecha_entrega, en.rendido, en.fecha_rendido,
         en.cobrado, en.created_at, coalesce(vi.n_referencia, vr.n_referencia, en.n_referencia) as ref_venta,
         coalesce(vi.deleted_at, vr.deleted_at) as venta_anulada,
         coalesce(vi.pago_anticipado, vr.pago_anticipado, false) as pago_anticipado
  from public.entregas en
  left join public.ventas vi on vi.id = en.venta_id
  left join lateral (
    select v.n_referencia, v.deleted_at, v.pago_anticipado from public.ventas v
    where vi.id is null and v.n_referencia = en.n_referencia and v.deleted_at is null
    order by v.created_at desc limit 1
  ) vr on true
  where en.tienda = 'voltra' and en.categoria = 'entregado' and coalesce(en.cobrado, 0) > 0
),
c as (
  -- Pedido de Shopify por nombre '#'||número (sin borradores) y sus tags en mayúscula.
  select e.*, p.pagado_en, p.financiero,
         coalesce(p.tags_m, '{}'::text[]) as tags_m
  from e
  left join lateral (
    select sp.pagado_en, sp.raw->>'financial_status' as financiero,
           array(select upper(trim(t)) from unnest(coalesce(sp.tags, '{}'::text[])) t) as tags_m
    from public.shopify_pedidos sp
    where sp.nombre = '#' || regexp_replace(e.ref_venta, '^VT-', '', 'i') and sp.es_borrador = false
    order by sp.creado_en desc nulls last limit 1
  ) p on true
  where e.venta_anulada is null and e.ref_venta is not null
),
s as (
  select c.*,
    case
      when c.tags_m && array['SALDO_PENDIENTE', 'PAGO_PARCIAL'] then 'parcial'
      when c.tags_m && array['PAGO_VERIFICADO', 'PAGADO', 'PAGADO_QR'] or c.pago_anticipado
           or ('PAGO_ANTICIPADO_COMPROBANTE' = any(c.tags_m) and lower(coalesce(c.financiero, '')) = 'paid') then 'pagado'
      when 'CREDITO' = any(c.tags_m) then 'credito'
    end as senal,
    (select substring(t from '^SALDO_(\d+)$')::bigint from unnest(c.tags_m) t where t ~ '^SALDO_\d+$' limit 1) as saldo
  from c
),
m as (
  select s.*,
    case when s.senal = 'parcial' and s.saldo is not null then greatest(s.cobrado - s.saldo, 0) else s.cobrado end::bigint as monto_devolver
  from s
  where s.senal in ('pagado', 'parcial')
)
-- Un renglón por pedido (si hubo reenvío, la entrega más nueva).
select distinct on (m.ref_venta)
  m.ref_venta as ref,
  '#' || regexp_replace(m.ref_venta, '^VT-', '', 'i') as pedido,
  m.transportadora as courier,
  coalesce(nullif(trim(m.guia_transportadora), ''),
           case when trim(coalesce(m.nro_guia_pap, '')) <> '' and m.nro_guia_pap !~* '^L-VT-' then trim(m.nro_guia_pap) end) as guia,
  m.fecha_entrega,
  coalesce(m.rendido, false) as rendido,
  m.fecha_rendido,
  m.cobrado::bigint as cobrado,
  m.saldo,
  m.monto_devolver,
  m.pagado_en,
  (d.devuelto_en is not null) as devuelta,
  d.devuelto_en,
  d.nota
from m
left join public.devoluciones_cliente d on d.ref = m.ref_venta
where m.monto_devolver > 0
order by m.ref_venta, m.fecha_entrega desc nulls last, m.created_at desc nulls last;

comment on view public.devoluciones_doble_cobro is
  'Pedidos pagados por transferencia que el courier igual cobró al entregar (doble cobro). Mismo criterio que pedidos-trabados/pagados_con_cobro.ts.';

revoke all on public.devoluciones_doble_cobro from anon, public;
grant select on public.devoluciones_doble_cobro to authenticated, service_role;
