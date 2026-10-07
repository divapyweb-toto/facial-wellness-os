-- Semilla de config_wa.mejora_mensual (ciclo mensual de mejora del vendedor, 06-10-2026).
-- Fuente: supabase/CONTRATO-MEJORA-MENSUAL.md. Lo leen dos módulos:
--   · mejora-mensual/tipos.ts (leerCfgMejora): tope_usd, min_conversaciones, reparto_clasificacion, modelos,
--     tamaños de la conversación y chars_por_token.
--   · mejora-mensual/aprobacion.ts (leerConfig): tope_usd, min_conversaciones, reserva_usd (síntesis + prueba)
--     y usd_por_conversacion (estimación si no hay precio en config_wa.precios_claude, que siembra seed_vendedor.sql).
-- tope_usd = tope DURO por ciclo en USD (clasificación + síntesis + prueba). Objetivo: menos de USD 3 por mes.
-- Si la clave ya existe no se pisa (on conflict do nothing); las claves nuevas que falten se agregan sin
-- tocar las que ya están (valor_existente || faltantes, con lo existente ganando).
insert into public.config_wa (clave, valor) values
  ('mejora_mensual',
   '{"tope_usd": 3,
     "min_conversaciones": 100,
     "reparto_clasificacion": 0.7,
     "modelo_clasificacion": "claude-haiku-4-5-20251001",
     "modelo_sintesis": "claude-sonnet-5-5",
     "max_tokens_clasificacion": 300,
     "max_chars_conversacion": 4000,
     "max_mensajes_conversacion": 40,
     "min_mensajes_conversacion": 2,
     "chars_por_token": 3,
     "reserva_usd": 0.75,
     "usd_por_conversacion": 0.002}'::jsonb)
on conflict (clave) do nothing;

-- Bases donde la clave ya existía con menos campos: suma solo los que faltan (lo que ya está, gana).
update public.config_wa
   set valor = '{"tope_usd": 3,
                 "min_conversaciones": 100,
                 "reparto_clasificacion": 0.7,
                 "modelo_clasificacion": "claude-haiku-4-5-20251001",
                 "modelo_sintesis": "claude-sonnet-5-5",
                 "max_tokens_clasificacion": 300,
                 "max_chars_conversacion": 4000,
                 "max_mensajes_conversacion": 40,
                 "min_mensajes_conversacion": 2,
                 "chars_por_token": 3,
                 "reserva_usd": 0.75,
                 "usd_por_conversacion": 0.002}'::jsonb || valor
 where clave = 'mejora_mensual'
   and jsonb_typeof(valor) = 'object';
