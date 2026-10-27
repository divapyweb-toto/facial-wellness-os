-- 27-10 · Verificación automática de transferencias (avisos de ueno en el Gmail de Voltra; pedido de administración,
-- Enrique 27-10 "que el chat/sistema de whatsapp lo haga"). La función pago-verificado hace lo mismo que "Recibido".
-- 1) pagos_verificados: un registro por transferencia; nro_transaccion ÚNICO → nunca se marca dos veces.
-- 2) config.pago_auto_gmail: interruptor, APAGADO hasta el OK de Enrique.
-- 3) vista pagos_candidatos: pedidos que esperan una transferencia, SIN datos personales (número, motivo, monto, comprobante).
-- Vuelta atrás: update config set valor = '{"activo":false}' where clave = 'pago_auto_gmail';
--   quitar todo: drop view public.pagos_candidatos; drop table public.pagos_verificados; delete from config where clave = 'pago_auto_gmail';

create table if not exists public.pagos_verificados (
  id bigint generated always as identity primary key,
  nro_transaccion text not null unique,
  shopify_order_id bigint not null,
  pedido text not null,
  monto integer not null check (monto > 0),
  origen text not null default 'gmail_ueno',
  motivo text,
  coincidencia text,
  resultado jsonb,
  creado_en timestamptz not null default now()
);
create index if not exists pagos_verificados_pedido on public.pagos_verificados (shopify_order_id);
alter table public.pagos_verificados enable row level security;
do $$ begin
  create policy "Autenticados leen pagos_verificados" on public.pagos_verificados for select using (auth.uid() is not null);
exception when duplicate_object then null; end $$;

insert into public.config (clave, valor) values ('pago_auto_gmail', '{"activo":false}')
on conflict (clave) do nothing;

create or replace view public.pagos_candidatos with (security_invoker = true) as
with p as (
  select sp.shopify_order_id, sp.nombre, sp.estado_envio, sp.creado_en, sp.total,
         coalesce(sp.tags, '{}'::text[]) as tags
  from public.shopify_pedidos sp
  where not coalesce(sp.es_borrador, false)
    and sp.raw->>'cancelled_at' is null
    and coalesce(sp.estado_envio, '') <> 'CANCELADO'
    and sp.creado_en > now() - interval '60 days'
)
select p.shopify_order_id,
       p.nombre as pedido,
       case when 'SALDO_PENDIENTE' = any(p.tags) then 'saldo_pendiente'
            when 'SIN_COBERTURA' = any(p.tags) then 'sin_cobertura'
            else 'oferta_pago_anticipado' end as motivo,
       case when 'SALDO_PENDIENTE' = any(p.tags)
            then (select substring(t from '^SALDO_(\d+)$')::int from unnest(p.tags) t where t ~ '^SALDO_\d+$' limit 1)
            else round(p.total)::int end as monto_pendiente,
       'PAGO_ANTICIPADO_COMPROBANTE' = any(p.tags) as comprobante_en_chat,
       p.estado_envio,
       p.creado_en
from p
where (p.tags && array['OFERTA_PAGO_ANTICIPADO', 'SIN_COBERTURA', 'SALDO_PENDIENTE'])
  and not (p.tags && array['PAGADO', 'PAGO_VERIFICADO', 'PAGADO_QR'])
  and not exists (select 1 from unnest(p.tags) t where t like '%CANCELADO%' or t like 'REEMPLAZADO_POR_%')
  -- Ya entregado o rendido: pagó al recibir (salvo un saldo pendiente).
  and (coalesce(p.estado_envio, '') not in ('ENTREGADO', 'RENDIDO') or 'SALDO_PENDIENTE' = any(p.tags));
