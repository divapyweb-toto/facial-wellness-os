-- 29-10 · FACTURA AL COBRAR (contrato docs/contrato-factura-al-cobrar-29-10.md §1). SIN APLICAR: la aplica el principal.
-- Se factura cuando el dinero está cobrado, nunca antes:
--   - pago anticipado COMPLETO (tags PAGADO / PAGO_VERIFICADO / PAGADO_QR, sin SALDO_PENDIENTE ni PAGO_PARCIAL) → al pagarse;
--   - contra entrega y pago parcial → al quedar ENTREGADO o RENDIDO (entregado_en), como hasta hoy.
--
-- 1) shopify_pedidos.pagado_en: momento en que el pedido quedó cobrado por completo por adelantado. La llena el trigger
--    shopify_pedidos_pagado_en SOLO en la transición (las tags pasan de "no pagado completo" a "pagado completo", o el
--    pedido nace pagado) y solo si estaba en null. Nunca la borra ni la pisa.
--    SIN backfill: los pedidos que ya estaban pagados antes de aplicar esto quedan con null y se facturan al entregarse
--    (por eso el trigger no se dispara con cualquier UPDATE de un pedido viejo ya pagado: eso sería un backfill con now()
--    y facturaría hoy plata cobrada antes del corte facturar_desde).
--    El nombre ordena DESPUÉS de shopify_pedidos_no_pisar_viejo (los BEFORE corren en orden alfabético): ve las tags
--    finales, ya corregidas si el webhook era viejo.
-- 2) facturas.kude_canal: por dónde salió el KuDE ('plantilla' | 'whatsapp_documento' | 'correo' | 'telegram_manual');
--    se escribe junto con kude_enviado_en (sifen cola.ts).
-- 3) Idempotencia: una sola FE por pedido y ambiente. El índice vigente es facturas_una_fe_por_pedido_ambiente
--    (20261009000022, reemplazó a facturas_una_fe_por_pedido de 20261008000010). Se re-asegura con IF NOT EXISTS
--    (no hace nada si ya está). Es lo que hace que la factura al pagar y la de la entrega, dos clics en "Recibido" o
--    la cola y el webhook a la vez terminen en UNA factura: el segundo INSERT falla con 23505 y crearFactura → null.
--
-- Vuelta atrás (en este orden; el código tolera que falte pagado_en y vuelve a facturar solo al entregar):
--   drop trigger if exists shopify_pedidos_pagado_en on public.shopify_pedidos;
--   drop function if exists public.shopify_pedidos_pagado_en();
--   drop function if exists public.tags_pagado_completo(text[]);
--   drop index if exists public.shopify_pedidos_pagado_en_idx;
--   alter table public.shopify_pedidos drop column if exists pagado_en;
--   alter table public.facturas drop constraint if exists facturas_kude_canal_check;
--   alter table public.facturas drop column if exists kude_canal;
--   (el índice facturas_una_fe_por_pedido_ambiente NO se borra: es de 20261009000022.)

-- ─── 1. pagado_en ────────────────────────────────────────────
alter table public.shopify_pedidos add column if not exists pagado_en timestamptz;
comment on column public.shopify_pedidos.pagado_en is
  'Cobrado por completo por adelantado (tags PAGADO/PAGO_VERIFICADO/PAGADO_QR sin SALDO_PENDIENTE ni PAGO_PARCIAL). Trigger shopify_pedidos_pagado_en. Se factura desde esta fecha (29-10).';

-- Mismas listas que _shared/pago_anticipado.ts (TAGS_PAGADO_ANTICIPADO / TAGS_PAGO_PARCIAL). Mayúsculas y sin espacios.
create or replace function public.tags_pagado_completo(p_tags text[]) returns boolean
language sql immutable as $$
  select coalesce(
    exists (select 1 from unnest(p_tags) t where upper(btrim(t)) in ('PAGADO', 'PAGO_VERIFICADO', 'PAGADO_QR'))
    and not exists (select 1 from unnest(p_tags) t where upper(btrim(t)) in ('SALDO_PENDIENTE', 'PAGO_PARCIAL')),
    false)
$$;

create or replace function public.shopify_pedidos_pagado_en() returns trigger language plpgsql as $$
begin
  if new.pagado_en is not null or not public.tags_pagado_completo(new.tags) then
    return new;
  end if;
  -- Solo en la transición: un pedido que YA estaba pagado completo (antes de esta migración) no recibe now().
  if tg_op = 'UPDATE' and public.tags_pagado_completo(old.tags) then
    return new;
  end if;
  new.pagado_en := now();
  return new;
end $$;

drop trigger if exists shopify_pedidos_pagado_en on public.shopify_pedidos;
create trigger shopify_pedidos_pagado_en before insert or update on public.shopify_pedidos
  for each row when (new.pagado_en is null)
  execute function public.shopify_pedidos_pagado_en();

-- La cola de 10 min busca por pagado_en ≥ ventana.
create index if not exists shopify_pedidos_pagado_en_idx
  on public.shopify_pedidos (pagado_en) where pagado_en is not null;

-- ─── 2. facturas.kude_canal ──────────────────────────────────
alter table public.facturas add column if not exists kude_canal text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'facturas_kude_canal_check') then
    alter table public.facturas add constraint facturas_kude_canal_check
      check (kude_canal is null or kude_canal in ('plantilla', 'whatsapp_documento', 'correo', 'telegram_manual'));
  end if;
end;
$$;
comment on column public.facturas.kude_canal is 'Canal por el que salió el KuDE (contrato 29-10 §4). Junto con kude_enviado_en.';

-- ─── 3. Una sola FE por pedido y ambiente (re-asegurado) ────
create unique index if not exists facturas_una_fe_por_pedido_ambiente
  on public.facturas (shopify_order_id, ambiente) where tipo_documento = 1 and shopify_order_id is not null;
