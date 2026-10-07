-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN OLA 2 — VENDEDOR CON IA (VOLTRA) · 06-10-2026 · Dueño: G1
-- ═══════════════════════════════════════════════════════════
-- Fuente: supabase/CONTRATO-OLAS2-4.md
--
-- Qué hace:
--   1. wa_conversaciones + turnos_ia y costo_ia_usd (tope de turnos y gasto por conversación).
--   2. vendedor_turnos: un registro por turno de la IA (modelo, uso, costo, herramientas, filtro, derivación).
--   3. wa_pedidos_chat: datos que junta el vendedor antes de crear el pedido (resumen → creado).
--   4. Funciones vendedor_sumar_turno (suma atómica) y vendedor_gasto_desde (gasto del mes para el tope).
--   RLS igual que la ola 1: `authenticated` lee y escribe; el service role pasa por encima.
--
-- NO borra nada. NO toca filas existentes. Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Contadores de IA por conversación ───────────────────
alter table public.wa_conversaciones add column if not exists turnos_ia int not null default 0;
alter table public.wa_conversaciones add column if not exists costo_ia_usd numeric not null default 0;

-- ─── 2. Turnos del vendedor ─────────────────────────────────
create table if not exists public.vendedor_turnos (
  id                  uuid primary key default gen_random_uuid(),
  conversacion_id     uuid not null references public.wa_conversaciones(id) on delete cascade,
  mensaje_entrada_id  text,                  -- wa_message_id del mensaje del cliente que disparó el turno
  modelo              text,
  uso                 jsonb,                 -- {entrada, salida, cache_lectura, cache_escritura, ...}
  costo_usd           numeric not null default 0,
  herramientas        jsonb not null default '[]'::jsonb,   -- [{nombre, input, resultado, error}]
  respuesta           text,
  filtro              jsonb,                 -- {intentos: [{ok, motivos[]}]}
  regenerado          boolean not null default false,
  derivado            boolean not null default false,
  simulado            boolean not null default false,
  accion              text,                  -- respondido | derivado:<motivo> | terminal | error_envio:<...>
  creado_en           timestamptz not null default now()
);
create index if not exists vendedor_turnos_conversacion_idx
  on public.vendedor_turnos (conversacion_id, creado_en desc);
create index if not exists vendedor_turnos_creado_idx
  on public.vendedor_turnos (creado_en desc);

-- ─── 3. Pedidos que arma el vendedor en el chat ─────────────
create table if not exists public.wa_pedidos_chat (
  id                uuid primary key default gen_random_uuid(),
  conversacion_id   uuid not null references public.wa_conversaciones(id) on delete cascade,
  cliente_id        uuid references public.wa_clientes(id) on delete set null,
  estado            text not null default 'resumen'
                    check (estado in ('resumen','creado','fallido','cancelado')),
  datos             jsonb not null,          -- nombre, ciudad, dirección, referencia, ubicación, teléfono, líneas, envío, total
  total             numeric,
  shopify_order_id  bigint,
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);
create index if not exists wa_pedidos_chat_conversacion_idx
  on public.wa_pedidos_chat (conversacion_id, creado_en desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'wa_pedidos_chat_actualizado_en') then
    create trigger wa_pedidos_chat_actualizado_en
      before update on public.wa_pedidos_chat
      for each row execute function public.wa_tocar_actualizado_en();
  end if;
end
$$;

-- ─── 4. Funciones ───────────────────────────────────────────
-- Suma atómica de un turno (dos turnos a la vez no se pisan).
create or replace function public.vendedor_sumar_turno(p_conversacion uuid, p_costo numeric)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.wa_conversaciones
     set turnos_ia = turnos_ia + 1,
         costo_ia_usd = costo_ia_usd + coalesce(p_costo, 0)
   where id = p_conversacion;
$$;

-- Gasto de IA desde una fecha (el tope mensual se calcula desde el día 1 a las 00:00 de Asunción).
create or replace function public.vendedor_gasto_desde(p_desde timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(costo_usd), 0) from public.vendedor_turnos where creado_en >= p_desde;
$$;

revoke all on function public.vendedor_sumar_turno(uuid, numeric) from public, anon;
revoke all on function public.vendedor_gasto_desde(timestamptz) from public, anon;
grant execute on function public.vendedor_sumar_turno(uuid, numeric) to authenticated, service_role;
grant execute on function public.vendedor_gasto_desde(timestamptz) to authenticated, service_role;

-- ─── 5. RLS ─────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['vendedor_turnos','wa_pedidos_chat'] loop
    execute format('alter table public.%I enable row level security', t);
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
