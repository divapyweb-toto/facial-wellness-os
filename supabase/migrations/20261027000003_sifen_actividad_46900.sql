-- 27-10 · SIFEN: texto oficial de la actividad 46900. SIFEN TEST rechazaba todo con 1262 ("Descripción de la actividad
-- económica no corresponde al código"). Probado en TEST con una actividad por vez (FE 925-929):
--   47190 "COMERCIO AL POR MENOR DE OTROS PRODUCTOS EN COMERCIOS NO ESPECIALIZADOS" → pasa (ya estaba bien)
--   46900 "COMERCIO AL POR MAYOR NO ESPECIALIZADO" → 1262;  "COMERCIO AL POR MAYOR NO ESPECIALIZADA" → pasa
-- Vuelta atrás: el mismo update con 'COMERCIO AL POR MAYOR NO ESPECIALIZADO'.
update public.config_wa
set valor = jsonb_set(valor::jsonb, '{datos_emisor,actividades}',
  (select jsonb_agg(case when a->>'codigo' = '46900' then jsonb_set(a, '{descripcion}', '"COMERCIO AL POR MAYOR NO ESPECIALIZADA"') else a end)
   from jsonb_array_elements(valor::jsonb->'datos_emisor'->'actividades') a))
where clave = 'sifen' and valor::jsonb->'datos_emisor'->'actividades' is not null;
