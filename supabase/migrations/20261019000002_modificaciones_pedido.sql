-- ═══════════════════════════════════════════════════════════
-- 20261019000002 · Vendedor v35: modificar pedidos y vínculo chat ↔ pedido (W2, 19-10-2026)
--   1. wa_pedidos_vinculados: pedidos que buscar_pedido encontró en un chat o que el cliente confirmó como suyos
--      (habilita modificar_pedido / guardar_factura aunque el pedido tenga otro teléfono) + medición chat ↔ pedido web.
--   2. wa_modificaciones_pedido: resumen pendiente de modificar_pedido (Confirmo/Corregir) y resultado
--      (edición directa o pedido nuevo que reemplaza al viejo). Idempotencia: resumen → ejecutando es atómico y
--      un índice único parcial impide dos ejecuciones a la vez sobre el mismo pedido.
--   RLS igual que wa_pedidos_chat: `authenticated` lee y escribe; anon nada; el service role pasa por encima.
--
-- NO borra nada. NO toca filas existentes. Se puede correr dos veces. NO APLICADA (la aplica el integrador).
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Vínculo chat ↔ pedido ──────────────────────────────
create table if not exists public.wa_pedidos_vinculados (
  id                uuid primary key default gen_random_uuid(),
  conversacion_id   uuid not null references public.wa_conversaciones(id) on delete cascade,
  shopify_order_id  bigint not null,
  fuente            text not null default 'busqueda'
                    check (fuente in ('busqueda','confirmado','modificacion','factura')),
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now(),
  unique (conversacion_id, shopify_order_id)
);
create index if not exists wa_pedidos_vinculados_pedido_idx on public.wa_pedidos_vinculados (shopify_order_id);

-- ─── 2. Modificaciones de pedidos ──────────────────────────
create table if not exists public.wa_modificaciones_pedido (
  id                uuid primary key default gen_random_uuid(),
  conversacion_id   uuid not null references public.wa_conversaciones(id) on delete cascade,
  cliente_id        uuid references public.wa_clientes(id) on delete set null,
  shopify_order_id  bigint not null,             -- pedido original
  estado            text not null default 'resumen'
                    check (estado in ('resumen','ejecutando','hecho','parcial','fallido','corregido')),
  datos             jsonb not null,              -- {pedido_nombre, camino, lineas_antes, total_antes, lineas, envio, total}
  nuevo_order_id    bigint,                      -- pedido que lo reemplaza (camino 'reemplazar')
  nuevo_nombre      text,
  error             text,
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);
create index if not exists wa_modificaciones_pedido_conv_idx
  on public.wa_modificaciones_pedido (conversacion_id, creado_en desc);
create unique index if not exists wa_modificaciones_pedido_un_ejecutando
  on public.wa_modificaciones_pedido (shopify_order_id) where estado = 'ejecutando';

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'wa_modificaciones_pedido_actualizado_en') then
    create trigger wa_modificaciones_pedido_actualizado_en
      before update on public.wa_modificaciones_pedido
      for each row execute function public.wa_tocar_actualizado_en();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'wa_pedidos_vinculados_actualizado_en') then
    create trigger wa_pedidos_vinculados_actualizado_en
      before update on public.wa_pedidos_vinculados
      for each row execute function public.wa_tocar_actualizado_en();
  end if;
end
$$;

-- ─── 3. RLS ─────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['wa_pedidos_vinculados','wa_modificaciones_pedido'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = t || '_authenticated_todo'
    ) then
      execute format(
        'create policy %I on public.%I for all to authenticated using (true) with check (true)',
        t || '_authenticated_todo', t
      );
    end if;
  end loop;
end
$$;

COMMIT;
