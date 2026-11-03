-- 03-11-2026 · Correcciones de medición (encargo de administración, pedido de Enrique 02-11).
--  1. pedidos_entrega: cancelado por el cliente que nunca fue a un courier era PERDIDO y bajaba la tasa de entrega.
--     Pasa a NO_SALIO. Cancelado después de salir, o reingresado, sigue PERDIDO.
--  2. entregas.neto_depositado de devueltos de Lucero: exportLucero restaba la tarifa del total aunque no se cobró nada,
--     y quedaba positivo. Lucero cobró 0 y descuenta el flete: neto = −flete.
-- Volver atrás: el mismo replace al revés en pedidos_entrega y, en las filas de abajo, neto_depositado = importe − costo_envio.
do $$
declare
  a text := pg_get_viewdef('public.pedidos_entrega'::regclass);
  viejo text := $v$WHEN ((estado_confirmacion = 'cancelado_cliente'::text) OR reingresado) THEN 'PERDIDO'::text$v$;
  nuevo text := $v$WHEN ((estado_confirmacion = 'cancelado_cliente'::text) AND (transportadora IS NULL) AND (NOT reingresado)) THEN 'NO_SALIO'::text
            WHEN ((estado_confirmacion = 'cancelado_cliente'::text) OR reingresado) THEN 'PERDIDO'::text$v$;
begin
  if position(viejo in a) = 0 then raise exception 'pedidos_entrega: no se encontró el texto a cambiar'; end if;
  execute 'create or replace view public.pedidos_entrega as ' || replace(a, viejo, nuevo);
end $$;

update public.entregas set neto_depositado = -costo_envio
 where transportadora = 'lucero' and categoria = 'devuelto' and coalesce(cobrado, 0) = 0
   and neto_depositado > 0 and costo_envio is not null;
