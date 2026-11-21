-- 24-11-2026 · PROVEEDORES 24/7 (WhatsApp + Gmail) · columnas de canal en el módulo pi_*.
-- Decisión de Enrique, 21-11 (textual): "A+B VAMOS A HACER.... Y GMAIL A PROVEEDORES DE DOY GREENLIGHT 100% PERO DEBE SER
-- 24-7 Y AUTOMATIZADO SIEMPRE QUE EL PRESUPUESTO PERMITA". Contrato: reportes/proveedores-automatico/CONTRATO.md (fuera del repo).
-- Qué hace:
--   1. pi_proveedores: datos de contacto por canal (whatsapp, email, wechat), canal preferido, no_contactar e idioma.
--   2. pi_mensajes: canal, dirección (in/out), id externo (wamid o id de Gmail, único por canal), hilo, asunto, costo en USD
--      y autor. Estado nuevo 'RECEIVED' para los mensajes que entran.
--   3. config.proveedores (texto JSON): interruptor APAGADO, topes de gasto (USD 10/mes de IA, 30 plantillas/mes), modelo.
-- El freno de envíos de 20261119000002 no cambia: un saliente sigue necesitando permiso vigente (y producto si es el general).
-- VUELTA ATRÁS (en este orden; borra lo cargado en esas columnas):
--   delete from public.config where clave = 'proveedores';
--   alter table public.pi_mensajes drop constraint pi_mensajes_recibido_entrante_check, drop constraint pi_mensajes_politica_saliente_check;
--   alter table public.pi_mensajes alter column politica_id set not null;   -- falla si quedaron entrantes: borrarlos antes
--   drop index if exists public.pi_mensajes_canal_externo_uq; drop index if exists public.pi_mensajes_hilo_idx;
--   drop index if exists public.pi_proveedores_email_idx; drop index if exists public.pi_proveedores_whatsapp_idx;
--   alter table public.pi_mensajes drop constraint pi_mensajes_estado_check;
--   alter table public.pi_mensajes add constraint pi_mensajes_estado_check
--     check (estado in ('DRAFT','AUTHORIZED','SENDING','SENT_CONFIRMED','SEND_UNKNOWN','FAILED'));   -- falla si quedó algún RECEIVED: borrarlos antes
--   alter table public.pi_mensajes drop column canal, drop column direccion, drop column id_externo, drop column hilo,
--     drop column asunto, drop column costo_usd, drop column autor;
--   alter table public.pi_proveedores drop column whatsapp, drop column email, drop column wechat, drop column canal_preferido,
--     drop column no_contactar, drop column idioma;

alter table public.pi_proveedores
  add column whatsapp text check (whatsapp is null or whatsapp ~ '^\d{8,15}$'),
  add column email text check (email is null or (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  add column wechat text,
  add column canal_preferido text check (canal_preferido in ('whatsapp','email','1688')),
  add column no_contactar boolean not null default false,
  add column idioma text check (idioma in ('zh','en','es'));
create index pi_proveedores_email_idx on public.pi_proveedores (email) where email is not null;
create index pi_proveedores_whatsapp_idx on public.pi_proveedores (whatsapp) where whatsapp is not null;

alter table public.pi_mensajes
  add column canal text check (canal in ('whatsapp','email','1688')),
  add column direccion text check (direccion in ('in','out')),
  add column id_externo text,
  add column hilo text,
  add column asunto text,
  add column costo_usd numeric(12,6) check (costo_usd is null or costo_usd >= 0),
  add column autor text check (autor in ('agente','admin','enrique','proveedor'));
create unique index pi_mensajes_canal_externo_uq on public.pi_mensajes (canal, id_externo) where id_externo is not null;
create index pi_mensajes_hilo_idx on public.pi_mensajes (canal, hilo) where hilo is not null;

alter table public.pi_mensajes drop constraint pi_mensajes_estado_check;
alter table public.pi_mensajes add constraint pi_mensajes_estado_check
  check (estado in ('DRAFT','AUTHORIZED','SENDING','SENT_CONFIRMED','SEND_UNKNOWN','FAILED','RECEIVED'));
-- Un mensaje recibido es siempre entrante.
alter table public.pi_mensajes add constraint pi_mensajes_recibido_entrante_check
  check (estado <> 'RECEIVED' or direccion = 'in');
-- Un entrante no pertenece a ningún permiso para negociar: politica_id pasa a ser opcional solo para ellos.
alter table public.pi_mensajes alter column politica_id drop not null;
alter table public.pi_mensajes add constraint pi_mensajes_politica_saliente_check
  check (politica_id is not null or direccion = 'in');

insert into public.config (clave, valor, actualizado)
values ('proveedores', '{"activo": false, "tope_ia_usd_mes": 10, "tope_plantillas_mes": 30, "modelo": "claude-haiku-4-5", "direccion_deposito": null, "firma": "Voltra (Paraguay)"}', now())
on conflict (clave) do nothing;
