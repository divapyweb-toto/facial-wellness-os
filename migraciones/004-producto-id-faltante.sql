-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 004 — COMPLETAR producto_id EN LAS VENTAS IMPORTADAS
-- ═══════════════════════════════════════════════════════════
-- 328 ventas quedaron sin `producto_id` (el mismo bug de nombres que corrigió
-- la 003 para el costo). Sin ese campo el motor de stock no encuentra el
-- producto y no puede mover una sola unidad.
--
-- Esta migración hace DOS cosas, y la segunda es la importante:
--
--   1. Completa `producto_id` para que el stock funcione DE ACÁ EN ADELANTE
--      (devoluciones, ediciones, borrados de esas ventas).
--
--   2. Las marca como `stock_descontado = true`, o sea: liquidadas.
--      NO es que se hayan descontado — es que su stock ya se corrigió por
--      otro camino, a mano. El historial lo muestra:
--        03/07  ajuste manual de stock (−41)
--        13/07  ajuste manual: -2 → 8 (+10)
--        13/07  importación masiva (109 ventas)
--      Descontarlas ahora dejaría el Raspador de Lengua en −21 unidades, que
--      es imposible: prueba de que ese stock YA se restó.
--
--      Sin esta marca, apretar «Sincronizar stock» las descontaría de nuevo y
--      duplicaría el faltante.
--
-- El número correcto de stock NO sale de esta migración: sale de un CONTEO
-- FÍSICO (Stock → Conteo físico). Esto solo evita que el sistema se siga
-- equivocando solo.
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- Mismo mapeo por familia que la migración 003 y que familiaProducto().
-- El orden de los WHEN importa: 'gudair' primero, porque un pack de
-- tiras+parches contiene las dos palabras.
WITH canon AS (
  SELECT
    CASE
      WHEN lower(nombre) LIKE '%gudair%'
        OR (lower(nombre) LIKE '%tira%' AND lower(nombre) LIKE '%parche%')     THEN 'gudair'
      WHEN lower(nombre) LIKE '%bebird%'                                       THEN 'bebird'
      WHEN lower(nombre) LIKE '%raspador%' OR lower(nombre) LIKE '%lengua%'
        OR lower(nombre) LIKE '%limpiador%'                                    THEN 'lengua'
      WHEN lower(nombre) LIKE '%parche%' OR lower(nombre) LIKE '%bucal%'       THEN 'parche'
      WHEN lower(nombre) LIKE '%tira%'   OR lower(nombre) LIKE '%nasal%'       THEN 'nasal'
      WHEN lower(nombre) LIKE '%jaw%'    OR lower(nombre) LIKE '%mandibula%'
        OR lower(nombre) LIKE '%mandíbula%' OR lower(nombre) LIKE '%ejercitador%' THEN 'jaw'
      WHEN lower(nombre) LIKE '%botella%' OR lower(nombre) LIKE '%flexible%'   THEN 'botella'
    END AS familia,
    id, nombre,
    -- Con varios productos de la misma familia gana el de nombre más corto:
    -- es el canónico ("Raspador de Lengua" antes que un pack de nombre largo).
    row_number() OVER (PARTITION BY 1 ORDER BY length(nombre)) AS rn
  FROM productos
),
elegido AS (
  SELECT DISTINCT ON (familia) familia, id
  FROM canon WHERE familia IS NOT NULL
  ORDER BY familia, length(nombre)
)
UPDATE ventas v SET
  producto_id = e.id,
  stock_descontado = true   -- ver nota 2 de la cabecera
FROM elegido e
WHERE v.deleted_at IS NULL
  AND v.producto_id IS NULL
  AND v.producto_nombre IS NOT NULL
  AND e.familia = CASE
      WHEN lower(v.producto_nombre) LIKE '%gudair%'
        OR (lower(v.producto_nombre) LIKE '%tira%' AND lower(v.producto_nombre) LIKE '%parche%') THEN 'gudair'
      WHEN lower(v.producto_nombre) LIKE '%bebird%'                                    THEN 'bebird'
      WHEN lower(v.producto_nombre) LIKE '%raspador%' OR lower(v.producto_nombre) LIKE '%lengua%'
        OR lower(v.producto_nombre) LIKE '%limpiador%'                                 THEN 'lengua'
      WHEN lower(v.producto_nombre) LIKE '%parche%' OR lower(v.producto_nombre) LIKE '%bucal%' THEN 'parche'
      WHEN lower(v.producto_nombre) LIKE '%tira%'   OR lower(v.producto_nombre) LIKE '%nasal%' THEN 'nasal'
      WHEN lower(v.producto_nombre) LIKE '%jaw%'    OR lower(v.producto_nombre) LIKE '%mandibula%'
        OR lower(v.producto_nombre) LIKE '%mandíbula%' OR lower(v.producto_nombre) LIKE '%ejercitador%' THEN 'jaw'
      WHEN lower(v.producto_nombre) LIKE '%botella%' OR lower(v.producto_nombre) LIKE '%flexible%' THEN 'botella'
    END;

COMMIT;


-- ─── VERIFICACIÓN ───────────────────────────────────────────
-- Debe dar 0:
-- SELECT count(*) FROM ventas WHERE deleted_at IS NULL AND producto_id IS NULL;
--
-- Y el stock NO se movió con esta migración (se arregla con el conteo físico):
-- SELECT nombre, stock_actual FROM productos ORDER BY nombre;
