-- Integración olas 2-4 (06-10-2026). Idempotente.
-- wa_consentimientos.origen admite 'meta_131050': procesar-envios y wa-webhook registran la baja de
-- marketing cuando Meta rechaza un envío con el error 131050 (el cliente apagó "Ofertas y anuncios").
alter table public.wa_consentimientos drop constraint if exists wa_consentimientos_origen_check;
alter table public.wa_consentimientos add constraint wa_consentimientos_origen_check
  check (origen in ('releasit', 'chat', 'boton', 'meta_131050'));
