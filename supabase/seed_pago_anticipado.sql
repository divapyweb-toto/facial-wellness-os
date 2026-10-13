-- Pago anticipado por transferencia (decisión del dueño, 07-10-2026; flujo nuevo del 12-10). on conflict do nothing:
-- no pisa lo que ya está en la base.
-- 12-10: los datos de la cuenta (banco, cuenta, titular, RUC, alias) van SOLO en la base (config_wa), nunca en Git:
-- acá quedan en null. La base en producción ya los tiene cargados; si se arma una base nueva, cargarlos a mano.
-- 12-10: al confirmar ya no se ofrece pagar antes (`activo` y `texto` ya no se leen). La oferta sale una sola vez
-- cuando el pedido pasa a "preparado" y se configura en config_wa['pago_prioridad'] (seed_config_wa.sql).
-- Lo que se sigue leyendo de esta clave:
--   texto_recibido   → respuesta al cliente cuando manda la foto o el PDF del comprobante (wa-webhook).
--   dias_comprobante → hasta cuántos días después del pedido una imagen cuenta como comprobante.
--   banco            → datos para transferir que da el vendedor IA si el cliente los pide (vendedor/config.ts).
insert into public.config_wa (clave, valor) values
  ('pago_anticipado',
   '{"activo": false,
     "texto": null,
     "texto_recibido": "Recibido, gracias. Lo verificamos y tu pedido sale en el primer despacho.",
     "dias_comprobante": 7,
     "banco": {"entidad": null, "tipo": null, "cuenta": null, "titular": null, "ruc": null, "alias": null}}'::jsonb)
on conflict (clave) do nothing;
