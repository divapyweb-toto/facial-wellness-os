-- ═══════════════════════════════════════════════════════════
-- CICLO MENSUAL DE MEJORA DEL VENDEDOR · 06-10-2026 · Dueño: M1
-- ═══════════════════════════════════════════════════════════
-- Fuente: supabase/CONTRATO-MEJORA-MENSUAL.md
--
-- Qué hace:
--   1. mejora_ciclos: un ciclo por mes analizado (máquina de estados de M3, reanudable).
--   2. vendedor_versiones: versiones del prompt/ejemplos/FAQ/objeciones; una sola 'activa'.
--   3. mejora_clasificaciones: etiquetas de Haiku por conversación y ciclo.
--   4. mejora_cambios: cambios propuestos (riesgo 'bajo' se aplica; 'requiere_decision' lo decide Enrique).
--   5. Vista conversacion_resultado: por conversación, el pedido vinculado y su resultado real
--      (entregado / devuelto / rechazado / cancelado / en_curso / sin_compra), costos, reclamo y derivación.
--   RLS igual que las olas anteriores: `authenticated` lee y escribe; el service role pasa por encima.
--
-- La semilla (versión 1 'activa', origen 'semilla', prompt de supabase/vendedor/prompt_sistema.md)
-- la carga la integración. NO borra nada. NO toca filas existentes. Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Ciclos ──────────────────────────────────────────────
create table if not exists public.mejora_ciclos (
  id                    uuid primary key default gen_random_uuid(),
  mes                   date not null unique,           -- primer día del mes analizado
  estado                text not null default 'recolectando'
                        check (estado in ('recolectando','clasificando','sintetizando','probando',
                               'esperando_aprobacion','aplicado','descartado','sin_datos_suficientes','error')),
  n_conversaciones      int,
  lote_id               text,                            -- id del Batch de Anthropic en curso
  costo_usd             numeric not null default 0,
  resumen               jsonb,
  hallazgos             jsonb,
  propuesta_version_id  uuid,                            -- fk más abajo (vendedor_versiones se crea después)
  prueba                jsonb,
  telegram_message_id   bigint,
  error                 text,
  creado_en             timestamptz not null default now(),
  actualizado_en        timestamptz not null default now(),
  constraint mejora_ciclos_mes_primer_dia check (extract(day from mes) = 1)
);
create index if not exists mejora_ciclos_estado_idx on public.mejora_ciclos (estado, mes desc);

create or replace trigger mejora_ciclos_actualizado_en
  before update on public.mejora_ciclos
  for each row execute function public.wa_tocar_actualizado_en();

-- ─── 2. Versiones del vendedor ──────────────────────────────
create table if not exists public.vendedor_versiones (
  id           uuid primary key default gen_random_uuid(),
  numero       int not null unique,                      -- correlativo: max(numero) + 1 (unique frena carreras)
  estado       text not null default 'propuesta'
               check (estado in ('activa','propuesta','descartada','archivada')),
  prompt       text not null,
  ejemplos     jsonb not null default '[]'::jsonb,
  faq          jsonb not null default '[]'::jsonb,
  objeciones   jsonb not null default '[]'::jsonb,
  origen       text not null default 'manual'
               check (origen in ('semilla','mejora_mensual','manual')),
  ciclo_id     uuid references public.mejora_ciclos(id) on delete set null,
  creado_en    timestamptz not null default now(),
  activada_en  timestamptz,
  notas        text
);
-- Una sola versión activa a la vez.
create unique index if not exists vendedor_versiones_una_activa
  on public.vendedor_versiones ((true)) where estado = 'activa';
create index if not exists vendedor_versiones_ciclo_idx on public.vendedor_versiones (ciclo_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'mejora_ciclos_propuesta_version_fk') then
    alter table public.mejora_ciclos
      add constraint mejora_ciclos_propuesta_version_fk
      foreign key (propuesta_version_id) references public.vendedor_versiones(id) on delete set null;
  end if;
end
$$;

-- ─── 3. Clasificaciones (Haiku por Batch) ───────────────────
create table if not exists public.mejora_clasificaciones (
  id               uuid primary key default gen_random_uuid(),
  ciclo_id         uuid not null references public.mejora_ciclos(id) on delete cascade,
  conversacion_id  uuid not null references public.wa_conversaciones(id) on delete cascade,
  etiquetas        jsonb not null,                       -- tipo Etiquetas (mejora-mensual/tipos.ts), validado
  intento          smallint not null default 1,          -- 1 = primer lote, 2 = reintento de inválidas
  costo_usd        numeric not null default 0,
  creado_en        timestamptz not null default now(),
  unique (ciclo_id, conversacion_id)
);
create index if not exists mejora_clasificaciones_conversacion_idx
  on public.mejora_clasificaciones (conversacion_id, creado_en desc);

-- ─── 4. Cambios propuestos ──────────────────────────────────
create table if not exists public.mejora_cambios (
  id          uuid primary key default gen_random_uuid(),
  ciclo_id    uuid not null references public.mejora_ciclos(id) on delete cascade,
  version_id  uuid references public.vendedor_versiones(id) on delete set null,
  tipo        text not null
              check (tipo in ('ejemplo','orden_objeciones','faq','prompt_tono','precio','afirmacion',
                     'palabra_prohibida','politica_reclamos','derivacion')),
  riesgo      text not null check (riesgo in ('bajo','requiere_decision')),
  antes       jsonb,
  despues     jsonb,
  motivo      text,
  aplicado    boolean not null default false,
  creado_en   timestamptz not null default now()
);
create index if not exists mejora_cambios_ciclo_idx on public.mejora_cambios (ciclo_id);

-- ─── 5. Vista conversacion_resultado ────────────────────────
-- Pedido vinculado, en este orden de prioridad:
--   a) el que creó el vendedor en ESA conversación (wa_pedidos_chat.shopify_order_id);
--   b) uno con la tag ORIGEN_WHATSAPP del mismo cliente dentro de la ventana;
--   c) cualquier pedido del cliente (por cliente_id o por teléfono E.164) dentro de la ventana.
-- Ventana: desde el primer mensaje de la conversación hasta 7 días después del último. Borradores fuera.
-- Resultado (prioridad): entregado (ENTREGADO o RENDIDO = el courier ya rindió la plata, o entregado_en)
--   > devuelto (NO_ENTREGADO: volvió al depósito) > rechazado (NO_ENTREGADO_RESCATABLE: el cliente no lo
--   recibió y la devolución está en proceso) > cancelado (por el cliente, sin respuesta o CANCELADO)
--   > en_curso; sin pedido = sin_compra.
-- tuvo_reclamo: botón seg_problema, derivación del vendedor por reclamo/devolución, reposición decidida
--   por Telegram (eventos_crudos 'accion:reponer:<pedido>') o la última clasificación con reclamo.hubo.
-- paso_escalera: 3 si hubo reposición; si no, el paso_resuelto de la última clasificación.
create or replace view public.conversacion_resultado
with (security_invoker = true) as
with msg as (
  select m.conversacion_id,
         min(m.creado_en)                  as primer_mensaje_en,
         max(m.creado_en)                  as ultimo_mensaje_en,
         coalesce(sum(m.costo_usd), 0)     as costo_mensajes_usd,
         bool_or(m.direccion = 'in'
                 and coalesce(m.contenido -> 'interactive' -> 'button_reply' ->> 'id',
                              m.contenido -> 'button' ->> 'payload', '') like 'seg_problema:%') as boton_problema
    from public.wa_mensajes m
   where m.conversacion_id is not null
   group by m.conversacion_id
),
turnos as (
  select t.conversacion_id,
         bool_or(t.derivado) as derivado_ia,
         bool_or(
           coalesce(t.accion, '') ~ '^derivado:(reclamo|devolucion)'
           or exists (
             select 1
               from jsonb_array_elements(case when jsonb_typeof(t.herramientas) = 'array'
                                              then t.herramientas else '[]'::jsonb end) h
              where coalesce(h ->> 'nombre', h ->> 'name') = 'derivar_a_enrique'
                and coalesce(h -> 'input' ->> 'motivo', '') in ('reclamo','devolucion'))
         ) as derivado_reclamo
    from public.vendedor_turnos t
   group by t.conversacion_id
)
select c.id                                         as conversacion_id,
       c.cliente_id,
       p.shopify_order_id,
       case
         when p.shopify_order_id is null then 'sin_compra'
         when p.entregado                then 'entregado'
         when p.devuelto                 then 'devuelto'
         when p.rechazado                then 'rechazado'
         when p.cancelado                then 'cancelado'
         else 'en_curso'
       end                                          as resultado,
       coalesce(c.costo_ia_usd, 0)::numeric         as costo_ia_usd,
       coalesce(msg.costo_mensajes_usd, 0)::numeric as costo_mensajes_usd,
       (coalesce(msg.boton_problema, false)
        or coalesce(tu.derivado_reclamo, false)
        or coalesce(p.reposicion, false)
        or coalesce(cl.hubo, false))                as tuvo_reclamo,
       case when coalesce(p.reposicion, false) then 3 else cl.paso end as paso_escalera,
       (c.estado = 'humano' or c.asignado_a is not null or coalesce(tu.derivado_ia, false)) as derivado
  from public.wa_conversaciones c
  left join msg       on msg.conversacion_id = c.id
  left join turnos tu on tu.conversacion_id = c.id
  left join public.wa_clientes wc on wc.id = c.cliente_id
  left join lateral (
    select sp.shopify_order_id,
           (sp.estado_envio in ('ENTREGADO','RENDIDO') or sp.entregado_en is not null
            or exists (select 1 from public.pedido_estados e
                        where e.shopify_order_id = sp.shopify_order_id and e.estado in ('ENTREGADO','RENDIDO'))) as entregado,
           (sp.estado_envio = 'NO_ENTREGADO'
            or exists (select 1 from public.pedido_estados e
                        where e.shopify_order_id = sp.shopify_order_id and e.estado = 'NO_ENTREGADO'))           as devuelto,
           (sp.estado_envio = 'NO_ENTREGADO_RESCATABLE')                                                          as rechazado,
           (sp.estado_confirmacion in ('cancelado_cliente','cancelado_sin_respuesta') or sp.estado_envio = 'CANCELADO') as cancelado,
           exists (select 1 from public.eventos_crudos ec
                    where ec.fuente = 'telegram' and ec.id_externo = 'accion:reponer:' || sp.shopify_order_id)   as reposicion
      from public.shopify_pedidos sp
     where not sp.es_borrador
       and (
         exists (select 1 from public.wa_pedidos_chat pc
                  where pc.conversacion_id = c.id and pc.shopify_order_id = sp.shopify_order_id)
         or (
           (sp.cliente_id = c.cliente_id or (wc.telefono is not null and sp.telefono = wc.telefono))
           and sp.creado_en >= coalesce(msg.primer_mensaje_en, c.creado_en)
           and sp.creado_en <  coalesce(msg.ultimo_mensaje_en, c.creado_en) + interval '7 days'
         )
       )
     order by exists (select 1 from public.wa_pedidos_chat pc
                       where pc.conversacion_id = c.id and pc.shopify_order_id = sp.shopify_order_id) desc,
              ('ORIGEN_WHATSAPP' = any(sp.tags)) desc,
              sp.creado_en asc
     limit 1
  ) p on true
  left join lateral (
    select (mc.etiquetas -> 'reclamo' ->> 'hubo') = 'true' as hubo,
           case when (mc.etiquetas -> 'reclamo' ->> 'paso_resuelto') ~ '^[1-5]$'
                then (mc.etiquetas -> 'reclamo' ->> 'paso_resuelto')::int end as paso
      from public.mejora_clasificaciones mc
     where mc.conversacion_id = c.id
     order by mc.creado_en desc
     limit 1
  ) cl on true;

revoke all on public.conversacion_resultado from anon;
grant select on public.conversacion_resultado to authenticated, service_role;

-- ─── 6. RLS ─────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['mejora_ciclos','vendedor_versiones','mejora_clasificaciones','mejora_cambios'] loop
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
