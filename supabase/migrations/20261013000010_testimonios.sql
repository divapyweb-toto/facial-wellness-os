-- ═══════════════════════════════════════════════════════════
-- Testimonios de clientes después de la entrega (13-10-2026). Idempotente.
-- wa-webhook: "Todo bien" → se pide foto, video o un comentario corto; lo que llega se guarda acá y se pide
-- permiso para mostrarlo sin nombre ni número (botones tst_si / tst_no). Nunca se publica nada solo.
--   autorizado: null = todavía no respondió; true = "Sí, podés usarla"; false = "No, prefiero que no".
--   ruta_storage: copia en el bucket wa-media (la misma que ve la Bandeja); null en los de texto.
-- testimonios_hitos: un aviso a Enrique por Telegram al llegar a 5 autorizados y cada 5 más (5, 10, 15…),
-- una sola vez por hito (la clave primaria lo garantiza aunque se reprocese).
-- RLS: solo service role (las Edge Functions). Nada para anon ni authenticated.
-- ═══════════════════════════════════════════════════════════
create table if not exists public.testimonios (
  id                uuid primary key default gen_random_uuid(),
  cliente_id        uuid not null references public.wa_clientes(id) on delete cascade,
  shopify_order_id  bigint,
  tipo              text not null check (tipo in ('foto', 'video', 'texto')),
  ruta_storage      text,
  texto             text,
  producto          text,
  autorizado        boolean,
  autorizado_en     timestamptz,
  wa_message_id     text unique,
  creado_en         timestamptz not null default now()
);

create index if not exists testimonios_autorizados_idx
  on public.testimonios (creado_en desc) where autorizado = true;
create index if not exists testimonios_cliente_idx
  on public.testimonios (cliente_id);

create table if not exists public.testimonios_hitos (
  hito       int primary key check (hito > 0),
  creado_en  timestamptz not null default now()
);

alter table public.testimonios enable row level security;
alter table public.testimonios_hitos enable row level security;
revoke all on public.testimonios, public.testimonios_hitos from anon, authenticated;
grant select, insert, update, delete on public.testimonios, public.testimonios_hitos to service_role;

comment on table public.testimonios is
  '13-10: testimonios de clientes (foto, video o texto) con permiso para mostrarlos sin nombre ni número. Nunca se publican solos.';
comment on table public.testimonios_hitos is
  '13-10: hitos de testimonios autorizados (5, 10, 15…) ya avisados a Enrique por Telegram.';
