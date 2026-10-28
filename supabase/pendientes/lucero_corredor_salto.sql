-- PENDIENTE (no es una migración): aplicar cuando Lucero pase TARIFA y COBRANZA del corredor. La tabla exige precio
-- (precio NOT NULL): reemplazar el null de abajo por el precio real y aplica_cobranza por lo que diga Lucero.
-- 28-10 · Cobertura (datos de administración):
--   · PaP avisó el 27-10 15:36 "No llegamos en Puente kyjha" → sacado de la lista de PaP en src/lib/cobranzaPaP.js
--     (la tabla no tenía fila de PaP para Puente Kyjhá: la cobertura salía de esa lista).
--   · Lucero reabrió el 28-10 su corredor a Salto del Guairá: 1 salida semanal, ~72 h desde la salida, solo sobre la ruta
--     principal y cruces. Tarifa y cobranza SIN DATO → solo prepago (aplica_cobranza = false) y precio NULL (pendiente).
--     Hernandarias no se toca (Lucero ya la cubre con cobranza, Gs 30.000).
-- Cuando Lucero pase tarifa y cobranza: update tarifas_courier set precio = …, aplica_cobranza = … where courier = 'lucero' and ciudad in (…).
-- Vuelta atrás: delete from tarifas_courier where courier = 'lucero' and vigente_desde = '2026-10-28' and precio is null;
insert into public.tarifas_courier (courier, ciudad, ciudad_nombre, alias, precio, tiempo, dias_min, dias_max, aplica_cobranza, vigente_desde)
select 'lucero', c.ciudad, c.nombre, c.alias, null, '1 salida semanal, ~72 h desde la salida (ruta principal y cruces)', 3, 9, false, date '2026-10-28'
from (values
  ('santa fe del parana', 'Santa Fe del Paraná', array['acceso santa fe del parana']),
  ('la fortuna', 'La Fortuna', array[]::text[]),
  ('itakyry', 'Cruce Itakyry', array['cruce itakyry']),
  ('san alberto', 'Cruce San Alberto', array['cruce san alberto']),
  ('minga pora', 'Minga Porã', array['acceso minga pora', 'troncal 3']),
  ('nueva esperanza', 'Nueva Esperanza', array['troncal 4']),
  ('cruce carolina', 'Cruce Carolina', array['carolina']),
  ('katuete', 'Katueté', array[]::text[]),
  ('puente kyjha', 'Puente Kyjhá', array['puente kyjá', 'puente kyja']),
  ('la paloma', 'La Paloma del Espíritu Santo', array['la paloma del espiritu santo']),
  ('salto del guaira', 'Salto del Guairá', array['saltos del guaira', 'salto del guara'])
) as c(ciudad, nombre, alias)
where not exists (select 1 from public.tarifas_courier t where t.courier = 'lucero' and t.ciudad = c.ciudad);
