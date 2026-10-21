-- 20261021000001 · ctwa_clid al lado de origen_anuncio_id en wa_conversaciones (Enrique 20-10-2026).
-- El identificador del clic del anuncio click-to-WhatsApp ya llegaba en wa_mensajes.contenido.referral y los eventos
-- de Meta (Lead/Purchase/OrderDelivered, dataset de mensajería) lo leen de ahí. Esto lo deja también en la
-- conversación (el ÚLTIMO clic y cuándo), para consultarlo y medir cobertura. No cambia ningún envío a Meta.
-- El disparador nunca hace fallar el guardado del mensaje.
alter table public.wa_conversaciones add column if not exists ctwa_clid text;
alter table public.wa_conversaciones add column if not exists ctwa_clid_en timestamptz;

create or replace function public.wa_guardar_ctwa_clid() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.direccion = 'in' and nullif(new.contenido -> 'referral' ->> 'ctwa_clid', '') is not null then
    begin
      update public.wa_conversaciones c
      set ctwa_clid = new.contenido -> 'referral' ->> 'ctwa_clid', ctwa_clid_en = new.creado_en
      where (c.id = new.conversacion_id or (new.conversacion_id is null and c.cliente_id = new.cliente_id))
        and (c.ctwa_clid_en is null or c.ctwa_clid_en <= new.creado_en);
    exception when others then
      raise warning 'wa_guardar_ctwa_clid: %', sqlerrm;
    end;
  end if;
  return new;
end $$;

drop trigger if exists wa_mensajes_ctwa_clid on public.wa_mensajes;
create trigger wa_mensajes_ctwa_clid after insert on public.wa_mensajes
  for each row execute function public.wa_guardar_ctwa_clid();

-- Relleno: último clic de cada conversación.
update public.wa_conversaciones c set ctwa_clid = u.clid, ctwa_clid_en = u.en
from (
  select distinct on (conversacion_id) conversacion_id, contenido -> 'referral' ->> 'ctwa_clid' as clid, creado_en as en
  from public.wa_mensajes
  where direccion = 'in' and nullif(contenido -> 'referral' ->> 'ctwa_clid', '') is not null and conversacion_id is not null
  order by conversacion_id, creado_en desc
) u
where c.id = u.conversacion_id;
