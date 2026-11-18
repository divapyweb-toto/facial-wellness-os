-- Vuelta atrás de 20261119000002_pi_permiso_general.sql (correr entera, en este orden).
-- 1) freno de mensajes como estaba en 20261119000001:
create or replace function public.pi_mensajes_freno_envio()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Se revisa la política en TODO paso a AUTHORIZED o SENDING (y en el cambio de política de un mensaje ya autorizado),
  -- y en SENT_CONFIRMED salvo que venga de SENDING (registrar el resultado de un envío ya empezado).
  if (new.estado in ('AUTHORIZED','SENDING')
        and (tg_op = 'INSERT' or new.estado is distinct from old.estado or new.politica_id is distinct from old.politica_id))
     or (new.estado = 'SENT_CONFIRMED' and (tg_op = 'INSERT' or old.estado <> 'SENDING')) then
    if not exists (select 1 from public.pi_politicas p
                    where p.id = new.politica_id and p.permite_envio
                      and p.vigente_hasta is not null and p.vigente_hasta > now()) then
      raise exception 'pi_mensajes: la política % no permite enviar o no está vigente; el mensaje queda en %',
        new.politica_id, case when tg_op = 'INSERT' then 'DRAFT' else old.estado end
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
-- 2) permiso general, índice y columna:
delete from public.pi_politicas where candidato_id is null;
drop index if exists public.pi_politicas_general_uq;
alter table public.pi_mensajes drop column if exists candidato_id;
