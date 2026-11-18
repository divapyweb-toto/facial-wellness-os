-- 18-11-2026 · FUNCIONES · SEGURIDAD (hallazgo de administración 18-11 09:28): el rol anon (la clave pública de la web) podía
-- ejecutar dos funciones SECURITY DEFINER: fw_mover_stock (cambia el stock de cualquier producto; el stock sale a Shopify cada
-- 10 min) y recalcular_courier_prob. Ninguna pantalla ni función las llama por rpc: las usan los disparadores de ventas
-- (fw_stock_on_insert/update/delete), cancelar_venta_por_shopify y el cron courier-prob-nocturno (corre como postgres).
-- Se quita EXECUTE a public y anon y se deja explícito para authenticated y service_role (lo que usan la web con sesión y
-- las funciones del servidor).
-- VOLVER ATRÁS:
--   grant execute on function public.fw_mover_stock(uuid, text, integer, text, text) to public, anon;
--   grant execute on function public.recalcular_courier_prob() to public, anon;
revoke execute on function public.fw_mover_stock(uuid, text, integer, text, text) from public, anon;
grant execute on function public.fw_mover_stock(uuid, text, integer, text, text) to authenticated, service_role;
revoke execute on function public.recalcular_courier_prob() from public, anon;
grant execute on function public.recalcular_courier_prob() to authenticated, service_role;
