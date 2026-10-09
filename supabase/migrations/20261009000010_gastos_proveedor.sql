-- 20261009000010_gastos_proveedor.sql · 09-10-2026 (contrato docs/contrato-gastos-auto-09-10.md, agente A1)
-- Gasto REAL facturado por cada proveedor de API, día por día (antes solo había estimaciones:
-- wa_mensajes.costo_usd y vendedor_turnos.costo_usd). Lo carga la Edge Function sync-gastos.
--   1. public.gastos_proveedor_diario: una fila por (fecha, proveedor, concepto).
--   2. public.gastos_sync_estado: una fila por proveedor (último OK, días seguidos con falla, aviso enviado).
--      Sirve para avisar por Telegram SOLO cuando un proveedor falla 2 días seguidos.
--   3. Cron 'sync-gastos' diario a las 06:30 de Asunción (UTC-3) = 09:30 UTC.
--      Usa public.invocar_edge_function (migraciones 0003 y 0014; URL y llaves en Vault).
--
-- Criterio de fecha (qué día es cada fila):
--   whatsapp   → día de Paraguay: Meta devuelve los cortes diarios en la zona de la cuenta (00:00 = 03:00 UTC).
--   claude     → día UTC del bucket de Anthropic (00:00–24:00 UTC = 21:00 del día anterior a 21:00 en PY).
--   elevenlabs → día UTC del bucket de ElevenLabs (mismo desfase de 3 h).
--   Anthropic y ElevenLabs no permiten cortar por zona horaria: el desfase de 3 h es aceptado y documentado.
-- monto_usd puede ser NULL: ElevenLabs solo informa créditos (no dólares) y WhatsApp si la cuenta no factura en USD.
-- Las claves NO van acá: son secretos de funciones (ANTHROPIC_ADMIN_KEY, WA_TOKEN, WA_WABA_ID, ELEVENLABS_API_KEY).
-- NO borra nada. Se puede correr dos veces.

create table if not exists public.gastos_proveedor_diario (
  fecha           date not null,
  proveedor       text not null check (proveedor in ('claude', 'whatsapp', 'elevenlabs')),
  concepto        text not null default '',
  monto_usd       numeric(14,6),
  detalle         jsonb not null default '{}'::jsonb,
  fuente          text not null default 'api',
  sincronizado_en timestamptz not null default now(),
  primary key (fecha, proveedor, concepto)
);
create index if not exists gastos_proveedor_diario_proveedor_fecha
  on public.gastos_proveedor_diario (proveedor, fecha desc);

create table if not exists public.gastos_sync_estado (
  proveedor          text primary key check (proveedor in ('claude', 'whatsapp', 'elevenlabs')),
  ultimo_ok_en       timestamptz,
  ultimo_error       text,
  ultimo_fallo_dia   date,          -- día de Paraguay de la última corrida con falla
  dias_fallando      int not null default 0,
  aviso_enviado      boolean not null default false,
  actualizado_en     timestamptz not null default now()
);

-- La función escribe con la service role (pasa RLS). La app solo LEE.
alter table public.gastos_proveedor_diario enable row level security;
alter table public.gastos_sync_estado      enable row level security;
drop policy if exists "gastos_proveedor_diario_leer" on public.gastos_proveedor_diario;
create policy "gastos_proveedor_diario_leer" on public.gastos_proveedor_diario for select to authenticated using (true);
drop policy if exists "gastos_sync_estado_leer" on public.gastos_sync_estado;
create policy "gastos_sync_estado_leer" on public.gastos_sync_estado for select to authenticated using (true);
revoke all on public.gastos_proveedor_diario, public.gastos_sync_estado from anon;
revoke insert, update, delete, truncate on public.gastos_proveedor_diario, public.gastos_sync_estado from authenticated;
grant select on public.gastos_proveedor_diario, public.gastos_sync_estado to authenticated;
grant all on public.gastos_proveedor_diario, public.gastos_sync_estado to service_role;

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-gastos') then
    perform cron.unschedule('sync-gastos');
  end if;
end;
$$;

select cron.schedule('sync-gastos', '30 9 * * *', $$select public.invocar_edge_function('sync-gastos')$$);
