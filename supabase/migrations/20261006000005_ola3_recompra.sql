-- ═══════════════════════════════════════════════════════════
-- OLA 3 · RECOMPRA (H1) · 06-10-2026
-- Fuente: supabase/CONTRATO-OLAS2-4.md
--   recompra_plan     → avisos M1 / M2 / CRUZADA / LANZAMIENTO por pedido entregado
--   wa_marketing_tope → foto por cliente y mes de los topes de marketing
-- No toca tablas existentes. Idempotente (se puede correr dos veces).
-- La recompra vieja de FW (src/lib/recompra.js + recompra_log) sigue aparte y no se toca.
-- ═══════════════════════════════════════════════════════════
begin;

create table if not exists public.recompra_plan (
  id                uuid primary key default gen_random_uuid(),
  cliente_id        uuid not null references public.wa_clientes(id) on delete cascade,
  shopify_order_id  bigint references public.shopify_pedidos(shopify_order_id) on delete set null,
  tipo              text not null check (tipo in ('M1','M2','CRUZADA','LANZAMIENTO')),
  producto_clave    text not null,
  dia_objetivo      date not null,            -- día local de Asunción en que corresponde mandarlo
  estado            text not null default 'planificado'
                    check (estado in ('planificado','programado','enviado','cancelado')),
  motivo            text,                     -- por qué se postergó o canceló (tope_semana, recompro, baja...)
  plantilla         text not null,
  variables         jsonb,
  envio_id          uuid references public.envios_programados(id) on delete set null,
  clave_unica       text not null unique,     -- rc:<order>:<tipo> · lz:<producto>:<cliente>
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);
create index if not exists recompra_plan_abiertos_idx
  on public.recompra_plan (dia_objetivo) where estado in ('planificado','programado');
create index if not exists recompra_plan_cliente_idx
  on public.recompra_plan (cliente_id);

create table if not exists public.wa_marketing_tope (
  cliente_id         uuid not null references public.wa_clientes(id) on delete cascade,
  mes                text not null check (mes ~ '^\d{4}-\d{2}$'),   -- 'YYYY-MM' de Asunción
  enviados           int not null default 0,
  sin_leer_seguidos  int not null default 0,
  ultimo_envio       timestamptz,
  fuera              boolean not null default false,               -- salió de la lista (60 días sin leer, baja)
  motivo             text,
  actualizado_en     timestamptz not null default now(),
  primary key (cliente_id, mes)
);

-- Triggers de actualizado_en (función de la migración 0001).
create or replace trigger recompra_plan_actualizado_en
  before update on public.recompra_plan
  for each row execute function public.wa_tocar_actualizado_en();
create or replace trigger wa_marketing_tope_actualizado_en
  before update on public.wa_marketing_tope
  for each row execute function public.wa_tocar_actualizado_en();

-- RLS: authenticated lee/escribe (panel); el service role pasa por encima.
do $$
declare
  t text;
begin
  foreach t in array array['recompra_plan','wa_marketing_tope'] loop
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

commit;
