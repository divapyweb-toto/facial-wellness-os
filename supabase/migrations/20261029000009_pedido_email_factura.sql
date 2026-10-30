-- ═══════════════════════════════════════════════════════════
-- Email para la factura pedido por WhatsApp (29-10-2026, agente E). Idempotente. No toca datos. SIN APLICAR.
-- El vendedor (guardar_email_factura) guarda acá el correo cuando el cliente pide la factura por mail.
-- Por qué una tabla aparte y no pedido_datos_fiscales: ahí ruc, dv y razon_social son NOT NULL con checks, y si el
-- pedido tiene fila la factura sale SÍ O SÍ con RUC (desde_pedido.ts: sin RUC → 'revisar'). Una fila "solo email"
-- rompería la factura de consumidor final. Si el pedido ya tiene fila de datos fiscales, el vendedor además le
-- actualiza el email ahí.
-- Lo lee la entrega del KuDE (emailsFacturaDe en _shared/vendedor/email_factura_io.ts). Repo público: sin datos reales.
-- ═══════════════════════════════════════════════════════════

create table if not exists public.pedido_email_factura (
  shopify_order_id  bigint primary key,
  email             text not null,
  origen            text not null default 'whatsapp',   -- 'whatsapp' | 'panel'
  conversacion_id   uuid,
  cliente_id        uuid,
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pedido_email_factura_formato') then
    alter table public.pedido_email_factura add constraint pedido_email_factura_formato
      check (length(email) <= 254 and email ~* '^[^[:space:]@<>,;]+@[^[:space:]@<>,;]+\.[a-z]{2,}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pedido_email_factura_origen') then
    alter table public.pedido_email_factura add constraint pedido_email_factura_origen
      check (origen in ('whatsapp', 'panel'));
  end if;
end $$;

create index if not exists pedido_email_factura_conversacion on public.pedido_email_factura (conversacion_id);

create or replace trigger pedido_email_factura_actualizado_en
  before update on public.pedido_email_factura
  for each row execute function public.wa_tocar_actualizado_en();

-- RLS: authenticated lee y escribe (panel); anon nada; service_role (vendedor, sifen-cola) pasa.
alter table public.pedido_email_factura enable row level security;
revoke all on public.pedido_email_factura from anon;
grant select, insert, update, delete on public.pedido_email_factura to authenticated;
grant all on public.pedido_email_factura to service_role;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pedido_email_factura'
                 and policyname = 'pedido_email_factura_authenticated_todo') then
    create policy pedido_email_factura_authenticated_todo on public.pedido_email_factura
      for all to authenticated using (true) with check (true);
  end if;
end $$;
