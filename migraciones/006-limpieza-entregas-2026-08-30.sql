-- ═══════════════════════════════════════════════════════════
-- 006 · Limpieza de entregas duplicadas — 30/08/2026
-- ═══════════════════════════════════════════════════════════
-- QUÉ ARREGLA
--   Dos filas de Lucero creadas el 02/08/2026 por una versión vieja del
--   importador, que usaba el EnvioID de Lucero (14763, 14770) como clave
--   en vez de la referencia propia. La orden ya tenía su fila con la clave
--   correcta (L-2018, L-2025), así que quedaron DOS filas por orden y el
--   sistema contó 196.000 Gs de ingreso que entró una sola vez.
--
--   El código ya no puede volver a generarlo: hoy `guiaLucero()` deriva
--   siempre la clave de la referencia, y el EnvioID va a `guia_transportadora`.
--   Esto limpia las dos filas que quedaron de antes.
--
-- ANTES DE CORRER — deberían salir exactamente 2 filas:
--   SELECT nro_guia_pap, n_referencia, importe, categoria, created_at
--   FROM entregas
--   WHERE nro_guia_pap LIKE 'L-%'
--     AND nro_guia_pap <> 'L-' || n_referencia;

BEGIN;

-- 1. Las dos filas duplicadas con clave legado.
DELETE FROM entregas
WHERE nro_guia_pap IN ('L-14763', 'L-14770')
  AND n_referencia IN ('2018', '2025');

-- 2. Importe basura: la ref 2005 tiene una fila no_despachado con importe = 1.
--    No es plata, es ruido de importación. Se pone en 0 (no se borra: la fila
--    documenta que ese bulto no salió).
UPDATE entregas SET importe = 0
WHERE nro_guia_pap = '26344158' AND importe = 1;

COMMIT;

-- DESPUÉS DE CORRER — las dos consultas deben dar 0 filas:
--   SELECT * FROM entregas WHERE nro_guia_pap IN ('L-14763','L-14770');
--   SELECT * FROM entregas WHERE nro_guia_pap LIKE 'L-%' AND nro_guia_pap <> 'L-' || n_referencia;

-- PARA REVERTIR: no hay vuelta atrás automática (son DELETE). Si hiciera falta,
-- las filas se regeneran volviendo a importar el export de Lucero de julio.
