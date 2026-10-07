-- Semillas de config_wa para post-entrega (ola 3 · H2). on conflict do nothing: no pisa cambios de Enrique.
--   limite: pedidos por corrida · max_intentos: tope de reintentos (48 = 24 h a 30 min)
--   aviso_tras: fallos seguidos antes de avisar por Telegram (una vez)
--   ventana_ctwa_dias: días hacia atrás desde el pedido para tomar el ctwa_clid del anuncio
--   action_source: origen del evento en Conversions API (ver _shared/meta_capi.ts)
insert into public.config_wa (clave, valor) values
  ('post_entrega',
   '{"limite": 50, "max_intentos": 48, "aviso_tras": 3, "ventana_ctwa_dias": 7, "action_source": "system_generated"}'::jsonb)
on conflict (clave) do nothing;
