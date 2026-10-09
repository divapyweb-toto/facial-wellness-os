-- 20261009000003_pap_sync.sql · 09-10-2026
-- Descarga automática de Punto a Punto (Edge Function pap-sync).
--   1. public.pap_sync_estado (UNA fila, id = 1): contador de logins fallidos, freno, firmas del formato
--      de cada reporte y última corrida buena. Sin datos de clientes ni credenciales.
--   2. public.pap_sync_eventos: registro de corridas, logins fallidos y CAMBIOS DE FORMATO/ENDPOINT
--      (para el criterio de abandono: el panel cambia más de 2 veces en 3 meses → volver a lo manual).
--   3. Cron 'pap-sync' 3 veces por día: 08:30, 14:30 y 19:30 de Asunción (UTC-3) = 11:30, 17:30, 22:30 UTC.
--      Usa public.invocar_edge_function (migraciones 0003 y 0014; lee URL y llaves de Vault).
-- Las credenciales de PaP NO van acá: son secretos de funciones (PAP_USUARIO / PAP_CLAVE).
--
-- Reactivar después de que se frenó por 2 logins fallidos (primero corregir la clave):
--   update public.pap_sync_estado set frenado = false, fallos_login = 0 where id = 1;
-- Apagar sin borrar nada:   update public.pap_sync_estado set activo = false where id = 1;
-- Cambios de formato en 90 días:
--   select count(*) from public.pap_sync_eventos where tipo = 'cambio_formato' and creado_en > now() - interval '90 days';
-- NO borra nada. Se puede correr dos veces.

create table if not exists public.pap_sync_estado (
  id                    smallint primary key default 1 check (id = 1),
  activo                boolean not null default true,
  fallos_login          int not null default 0,
  frenado               boolean not null default false,
  errores_seguidos      int not null default 0,
  aviso_errores_enviado boolean not null default false,
  firma_gestion         text,
  firma_paquetes        text,
  ultimo_ok_en          timestamptz,
  actualizado_en        timestamptz not null default now()
);

insert into public.pap_sync_estado (id) values (1) on conflict (id) do nothing;

create table if not exists public.pap_sync_eventos (
  id        bigserial primary key,
  tipo      text not null check (tipo in ('ok', 'login_fallido', 'error', 'cambio_formato', 'frenado')),
  detalle   jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now()
);
create index if not exists pap_sync_eventos_tipo_fecha on public.pap_sync_eventos (tipo, creado_en desc);

-- La función usa la service role (pasa RLS). La app solo LEE (para mostrar el estado).
alter table public.pap_sync_estado  enable row level security;
alter table public.pap_sync_eventos enable row level security;
drop policy if exists "pap_sync_estado_leer" on public.pap_sync_estado;
create policy "pap_sync_estado_leer" on public.pap_sync_estado for select to authenticated using (true);
drop policy if exists "pap_sync_eventos_leer" on public.pap_sync_eventos;
create policy "pap_sync_eventos_leer" on public.pap_sync_eventos for select to authenticated using (true);
revoke all on public.pap_sync_estado, public.pap_sync_eventos from anon;
grant select on public.pap_sync_estado, public.pap_sync_eventos to authenticated;

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'pap-sync') then
    perform cron.unschedule('pap-sync');
  end if;
end;
$$;

select cron.schedule('pap-sync', '30 11,17,22 * * *', $$select public.invocar_edge_function('pap-sync')$$);
