-- ═══════════════════════════════════════════════════════════
-- 007 · Motivo de devolución — 03/09/2026 (corrección C3 del diagnóstico)
-- ═══════════════════════════════════════════════════════════
-- QUÉ HACE
--   1. Agrega ventas.motivo_devolucion (texto libre, lista sugerida en
--      src/lib/motivosDevolucion.js — nunca bloqueante).
--   2. Rellena automáticamente los 122 devueltos que SÍ tienen entregas.motivo
--      vinculado por venta_id, traduciendo el texto real de PaP.
--   3. Deja NULL los que no tienen vínculo (quedan para cargar a mano cuando
--      se agregue el selector en la UI — no es parte de esta migración).
--
-- NO CAMBIA ningún número de ventas ya calculado (total, margen, estado).
-- Solo agrega información nueva.
--
-- VERIFICAR ANTES DE CORRER — debería dar 241 filas devueltas, 122 con
-- entregas.motivo no vacío:
--   SELECT count(*) FILTER (WHERE v.estado = 'devuelto') AS total_devueltos,
--          count(*) FILTER (WHERE v.estado = 'devuelto' AND e.motivo IS NOT NULL) AS con_motivo
--   FROM ventas v LEFT JOIN entregas e ON e.venta_id = v.id;

BEGIN;

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS motivo_devolucion text;

COMMENT ON COLUMN public.ventas.motivo_devolucion IS
  'Lista sugerida en src/lib/motivosDevolucion.js (rechazo_puerta, fin_custodia, direccion_mala, fuera_cobertura, en_proceso, otro). Campo libre, no bloqueante.';

-- Backfill: traduce entregas.motivo (texto crudo de PaP) al value cerrado,
-- replicando motivoDesdeTextoPaP() de motivosDevolucion.js.
UPDATE public.ventas v
SET motivo_devolucion = CASE
  WHEN lower(e.motivo) LIKE '%fin de custodia%'            THEN 'fin_custodia'
  WHEN lower(e.motivo) LIKE '%en proceso%'                 THEN 'en_proceso'
  WHEN lower(e.motivo) LIKE '%rechaz%'
    OR lower(e.motivo) LIKE '%no desea%'
    OR lower(e.motivo) LIKE '%rehus%'                      THEN 'rechazo_puerta'
  WHEN lower(e.motivo) LIKE '%inubicable%'
    OR lower(e.motivo) LIKE '%problema de direccion%'      THEN 'direccion_mala'
  WHEN lower(e.motivo) LIKE '%fuera de cobertura%'         THEN 'fuera_cobertura'
  WHEN e.motivo IS NOT NULL AND e.motivo <> ''             THEN 'otro'
  ELSE NULL
END
FROM public.entregas e
WHERE e.venta_id = v.id
  AND v.estado = 'devuelto'
  AND v.motivo_devolucion IS NULL;

COMMIT;

-- VERIFICAR DESPUÉS — el resumen que vas a ver reflejado en el reporte:
--   SELECT motivo_devolucion, count(*)
--   FROM public.ventas WHERE estado = 'devuelto'
--   GROUP BY motivo_devolucion ORDER BY count(*) DESC;
