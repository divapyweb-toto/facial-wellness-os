-- ═══════════════════════════════════════════════════════════
-- Confirmación rápida (10-10-2026). Idempotente (se puede correr dos veces).
-- Secuencia nueva: conf (al instante) → rec (+60 min) → avi (+3 h, Telegram a Enrique)
--   → ult (+24 h, último aviso, 8 a 20 h) → canc (+48 h, nunca antes de 24 h, 8 a 20 h)
--   → cmsg ("dimos de baja tu pedido", lo programa procesar-envios al cancelar OK).
-- Ya no hay retención a las 48 h.
-- APLICAR DESPUÉS de desplegar shopify-webhook y procesar-envios: el shopify-webhook viejo exige
-- recordatorio_h / retener_h en config_wa.confirmacion y dejaría de programar confirmaciones.
-- ═══════════════════════════════════════════════════════════

-- (a) config_wa.confirmacion = contrato nuevo (conserva confirmar_min). Se DEJAN recordatorio_h y retener_h
--     (claves viejas) para que la versión de wa-webhook todavía no redesplegada (la del vendedor IA) siga
--     programando confirmaciones; el código nuevo las ignora cuando hay claves nuevas (no programa 'ret').
insert into public.config_wa (clave, valor)
values ('confirmacion', '{"confirmar_min":0,"recordatorio_min":60,"aviso_enrique_h":3,"ultimo_aviso_h":24,"cancelar_h":48,"recordatorio_h":1,"retener_h":48}'::jsonb)
on conflict (clave) do update
  set valor = coalesce(public.config_wa.valor, '{}'::jsonb)
              || '{"recordatorio_min":60,"aviso_enrique_h":3,"ultimo_aviso_h":24,"cancelar_h":48,"recordatorio_h":1,"retener_h":48}'::jsonb
              || jsonb_build_object('confirmar_min', coalesce(public.config_wa.valor -> 'confirmar_min', '0'::jsonb));

-- wa-webhook cancela por subcadena de la plantilla cuando el cliente toca Confirmar/Cancelar:
-- se suman el aviso a Enrique y el último aviso.
update public.config_wa
   set valor = valor || '["aviso_enrique"]'::jsonb
 where clave = 'plantillas_cancelables_al_responder' and jsonb_typeof(valor) = 'array'
   and not valor ? 'aviso_enrique';
update public.config_wa
   set valor = valor || '["ultimo_aviso"]'::jsonb
 where clave = 'plantillas_cancelables_al_responder' and jsonb_typeof(valor) = 'array'
   and not valor ? 'ultimo_aviso';

-- Momento del pedido (en cada paso): created_at de Shopify (REST o GraphQL) o, si falta, creado_en de la fila.

-- (b) Cancelaciones pendientes: a las 48 h del pedido (nunca antes de 24 h ni en el pasado).
--     Si cae de noche, procesar-envios la corre a las 8:00.
update public.envios_programados e
   set enviar_desde = greatest(p.creado + interval '48 hours', p.creado + interval '24 hours', now() + interval '5 minutes')
  from (select sp.shopify_order_id, sp.estado_confirmacion,
              coalesce((sp.raw ->> 'created_at')::timestamptz, (sp.raw ->> 'createdAt')::timestamptz, sp.creado_en) as creado
         from public.shopify_pedidos sp where not sp.es_borrador) p
 where e.shopify_order_id = p.shopify_order_id
   and e.estado = 'pendiente'
   and e.plantilla = 'accion:cancelar';

-- (c) Retenciones pendientes: ya no existen.
update public.envios_programados
   set estado = 'cancelado', ultimo_error = 'retencion_eliminada_10-10 (confirmacion rapida)'
 where estado = 'pendiente' and plantilla = 'accion:retener';

-- (d) Pedidos que siguen sin confirmar y tienen su cancelación pendiente: avi (+3 h) y ult (+24 h).
--     Mismas variables que la cancelación (las arma shopify-webhook). Si la hora ya pasó: en unos minutos.
--     El último aviso de noche lo corre procesar-envios a las 8:00.
insert into public.envios_programados (cliente_id, shopify_order_id, plantilla, variables, categoria, enviar_desde, clave_unica)
select c.cliente_id, c.shopify_order_id, 'accion:aviso_enrique', c.variables, 'utilidad',
       greatest(p.creado + interval '3 hours', now() + interval '2 minutes'),
       'avi:' || c.shopify_order_id
  from public.envios_programados c
  join (select sp.shopify_order_id, sp.estado_confirmacion,
              coalesce((sp.raw ->> 'created_at')::timestamptz, (sp.raw ->> 'createdAt')::timestamptz, sp.creado_en) as creado
         from public.shopify_pedidos sp where not sp.es_borrador) p on p.shopify_order_id = c.shopify_order_id
 where c.plantilla = 'accion:cancelar' and c.estado = 'pendiente'
   and p.estado_confirmacion in ('pendiente', 'retenido')
   and c.cliente_id is not null
on conflict (clave_unica) do nothing;

insert into public.envios_programados (cliente_id, shopify_order_id, plantilla, variables, categoria, enviar_desde, clave_unica)
select c.cliente_id, c.shopify_order_id, 'voltra_ultimo_aviso_confirmacion', c.variables, 'utilidad',
       greatest(p.creado + interval '24 hours', now() + interval '5 minutes'),
       'ult:' || c.shopify_order_id
  from public.envios_programados c
  join (select sp.shopify_order_id, sp.estado_confirmacion,
              coalesce((sp.raw ->> 'created_at')::timestamptz, (sp.raw ->> 'createdAt')::timestamptz, sp.creado_en) as creado
         from public.shopify_pedidos sp where not sp.es_borrador) p on p.shopify_order_id = c.shopify_order_id
 where c.plantilla = 'accion:cancelar' and c.estado = 'pendiente'
   and p.estado_confirmacion in ('pendiente', 'retenido')
   and c.cliente_id is not null
on conflict (clave_unica) do nothing;
