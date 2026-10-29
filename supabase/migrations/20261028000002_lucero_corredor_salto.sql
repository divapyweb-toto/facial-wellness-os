-- 28-10 · Lucero reabrió su corredor CDE → Salto del Guairá (datos de administración y de Enrique):
--   · Tarifas del flyer de Lucero ("tarifas de prueba desde la base de CDE; paquetes estándar"):
--       35.000 Acceso a Santa Fe del Paraná, La Fortuna · 40.000 Cruce Itakyry, Cruce San Alberto, Acceso a Minga Porã /
--       Troncal 3 · 45.000 Troncal 4 / Nueva Esperanza, Cruce Carolina, Katueté, Puente Kyjhá, La Paloma del Espíritu
--       Santo, Salto del Guairá. Hernandarias no se toca (tarifa urbana vigente, ya cargada).
--   · Cobranza contra entrega: SÍ (Enrique 28-10: "se rinde al dia siguiente asi como todos los cobrados de lucero").
--   · 1 salida semanal (día sin dato), ~72 h desde la salida de CDE, solo ruta principal y cruces → plazo 3 a 9 días.
-- Las ciudades que PaP también tiene (San Alberto, Katueté, Nueva Esperanza, Salto del Guairá) las elige sugerir_courier
-- por costo por entregado (y courier_preferir_lucero si está activo). Puente Kyjhá: solo Lucero (PaP avisó que no llega).
-- Vuelta atrás: delete from tarifas_courier where courier = 'lucero' and vigente_desde = '2026-10-28';
insert into public.tarifas_courier (courier, ciudad, ciudad_nombre, alias, precio, tiempo, dias_min, dias_max, aplica_cobranza, vigente_desde)
select 'lucero', c.ciudad, c.nombre, c.alias, c.precio,
       '1 salida semanal, ~72 h desde la salida de CDE (ruta principal y cruces)', 3, 9, true, date '2026-10-28'
from (values
  ('santa fe del parana', 'Santa Fe del Paraná', array['acceso santa fe del parana', 'acceso a santa fe del parana'], 35000),
  ('la fortuna', 'La Fortuna', array[]::text[], 35000),
  ('itakyry', 'Cruce Itakyry', array['cruce itakyry'], 40000),
  ('san alberto', 'Cruce San Alberto', array['cruce san alberto'], 40000),
  ('minga pora', 'Minga Porã', array['acceso minga pora', 'acceso a minga pora', 'troncal 3'], 40000),
  ('nueva esperanza', 'Nueva Esperanza', array['troncal 4'], 45000),
  ('cruce carolina', 'Cruce Carolina', array['carolina'], 45000),
  ('katuete', 'Katueté', array[]::text[], 45000),
  ('puente kyjha', 'Puente Kyjhá', array['puente kyja'], 45000),
  ('la paloma', 'La Paloma del Espíritu Santo', array['la paloma del espiritu santo'], 45000),
  ('salto del guaira', 'Salto del Guairá', array['saltos del guaira', 'salto del guara', 'santo del guaira'], 45000)
) as c(ciudad, nombre, alias, precio)
where not exists (select 1 from public.tarifas_courier t where t.courier = 'lucero' and t.ciudad = c.ciudad);
