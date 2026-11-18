-- 19-11-2026 · PERMISO GENERAL PARA NEGOCIAR (módulo pi_*).
-- Pedido de Enrique (18-11, textual): "yo quiero que siempre estes autorizado a negociar todo precio color producto
-- calidad todo packaging todo pero siempre y no que tengas que preguntar de a 1".
-- Qué hace:
--   1. pi_mensajes.candidato_id: a qué producto pertenece cada mensaje (con el permiso general la política no lo dice).
--   2. Índice único: hay UNA sola fila de permiso general (pi_politicas.candidato_id IS NULL).
--   3. Crea esa fila como PROPUESTA (permite_envio = false, sin vencimiento). La autoriza Enrique una vez, con su sesión
--      (el freno pi_politicas_solo_enrique de 20261119000001 ya lo exige); la revoca cualquiera (permite_envio = false).
--   4. Freno de mensajes: una política sirve para enviar si permite_envio y (vence en el futuro, o es la general sin
--      vencimiento). Con la general, el mensaje TIENE que decir su candidato_id; con una por producto, si lo dice,
--      tiene que coincidir con el de la política.
-- Topes por producto del permiso general (10 proveedores, 3 rondas) y lo que nunca cubre (aceptar o confirmar órdenes,
-- pagar, muestras, exclusividad, términos): en el alcance y en el CLI (puedeAutorizarMensaje); órdenes y pagos además
-- con el freno de la base (pi_ordenes_compra_solo_enrique).
-- VUELTA ATRÁS: supabase/reversiones/20261119000002_volver.sql (deja el freno como estaba y borra la fila general,
-- el índice y la columna).

alter table public.pi_mensajes
  add column candidato_id uuid references public.pi_candidatos(id) on delete restrict;

create unique index pi_politicas_general_uq on public.pi_politicas ((candidato_id is null)) where candidato_id is null;

insert into public.pi_politicas (candidato_id, alcance, permite_envio, vigente_hasta)
values (null,
  '{"tipo":"general","negocia":["precio","cantidades","color_variante","calidad","empaque","plazos","condiciones"],"proveedores_max_por_producto":10,"rondas_max_por_producto":3,"seguimiento_dias_habiles":2}'::jsonb,
  false, null);

create or replace function public.pi_mensajes_freno_envio()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare p public.pi_politicas%rowtype;
begin
  -- Se revisa la política en TODO paso a AUTHORIZED o SENDING (y en el cambio de política o de producto de un mensaje
  -- ya autorizado), y en SENT_CONFIRMED salvo que venga de SENDING (registrar el resultado de un envío ya empezado).
  if (new.estado in ('AUTHORIZED','SENDING')
        and (tg_op = 'INSERT' or new.estado is distinct from old.estado or new.politica_id is distinct from old.politica_id
             or new.candidato_id is distinct from old.candidato_id))
     or (new.estado = 'SENT_CONFIRMED' and (tg_op = 'INSERT' or old.estado <> 'SENDING')) then
    select * into p from public.pi_politicas where id = new.politica_id;
    if not found or not p.permite_envio
       -- coalesce: con vigente_hasta NULL la comparación da NULL y el freno no saltaría (encontrado por la prueba 11h)
       or not (coalesce(p.vigente_hasta > now(), false) or (p.vigente_hasta is null and p.candidato_id is null)) then
      raise exception 'pi_mensajes: el permiso para negociar % no permite enviar o no está vigente; el mensaje queda en %',
        new.politica_id, case when tg_op = 'INSERT' then 'DRAFT' else old.estado end
        using errcode = 'check_violation';
    end if;
    if p.candidato_id is null and new.candidato_id is null then
      raise exception 'pi_mensajes: con el permiso general el mensaje tiene que decir de qué producto es (candidato_id)'
        using errcode = 'check_violation';
    end if;
    if p.candidato_id is not null and new.candidato_id is not null and new.candidato_id <> p.candidato_id then
      raise exception 'pi_mensajes: el mensaje es de otro producto que su permiso para negociar'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.pi_mensajes_freno_envio() from public, anon, authenticated;
