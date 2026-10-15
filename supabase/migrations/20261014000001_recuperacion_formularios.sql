-- 14-10 · Recuperación de formularios abandonados de Releasit (recuperar-borradores).
-- 1. recuperacion_borradores.conversacion_id: la conversación donde quedó la plantilla. Sirve para medir cuántos
--    terminan el pedido y para sacar estos chats de la medición de los 100 chats de anuncios del vendedor v33.
-- 2. El cron pasa de cada hora a cada 5 minutos: la ventana es de 15 a 60 min desde el abandono.
-- 3. Config: requiere_consentimiento=false (decisión de Enrique, 14-10), plantilla voltra_mk_recuperar_pedido,
--    tope 30/día. La bandera (activo) NO se toca acá: se prende a mano después de las pruebas.

alter table public.recuperacion_borradores
  add column if not exists conversacion_id uuid references public.wa_conversaciones(id) on delete set null;
create index if not exists recuperacion_borradores_creado_idx on public.recuperacion_borradores (creado_en);

do $$
begin
  if exists (select 1 from cron.job where jobname = 'wa-recuperar-borradores') then
    perform cron.unschedule('wa-recuperar-borradores');
  end if;
end;
$$;
select cron.schedule('wa-recuperar-borradores', '*/5 * * * *', $$select public.invocar_edge_function('recuperar-borradores')$$);

update public.config_wa
set valor = coalesce(valor, '{}'::jsonb)
  - 'min_horas' - 'max_horas'
  || jsonb_build_object(
       'plantilla', 'voltra_mk_recuperar_pedido',
       'categoria', 'MARKETING',
       'requiere_consentimiento', false,
       'demora_releasit_min', 15,
       'min_minutos', 15,
       'max_minutos', 60,
       'limite', 30,
       'dias_pedido', 7,
       'dias_entre_envios', 7,
       'alerta_cada_h', 6,
       'horario', jsonb_build_object('desde', 8, 'hasta', 21)
     )
where clave = 'ola4.recuperacion';
