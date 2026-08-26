-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 003 — COMPLETAR EL COSTO DE PRODUCTO QUE FALTABA
-- ═══════════════════════════════════════════════════════════
-- 328 ventas quedaron con costo_prod = 0, o sea contadas como si el producto
-- hubiera sido GRATIS. Total no contado: 5.210.618 Gs.
--
-- Causa: Shopify manda el nombre comercial y el catálogo guarda otro.
-- "Limpiador de Lengua Facial Wellness" nunca encontró "Raspador de Lengua",
-- "Parches bucales (30 unidades)" nunca encontró "Parches bucales". La
-- comparación era por texto y ninguno contiene al otro.
-- Ya está arreglado en el código (matchProducto cae a familiaProducto), pero
-- eso solo sirve para las ventas NUEVAS. Esto corrige las viejas.
--
-- OJO — esto BAJA tu ganancia histórica, no la sube. El costo siempre estuvo:
-- lo que estaba mal era el registro. Los reportes van a mostrar menos
-- ganancia que ayer, y ese número nuevo es el correcto.
--
-- Solo toca filas con costo_prod = 0. Una venta con costo ya cargado no se
-- pisa, incluso si el nombre coincide.
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- El orden de los WHEN importa: replica exactamente el de familiaProducto()
-- en src/lib/recompra.js. 'gudair' va primero porque un pack de tiras+parches
-- contiene las dos palabras y si no se evalúa antes cae en la familia
-- equivocada y se le carga el costo de un producto simple.
UPDATE ventas SET costo_prod = COALESCE(cantidad, 1) * CASE
    WHEN lower(producto_nombre) LIKE '%gudair%'
      OR (lower(producto_nombre) LIKE '%tira%' AND lower(producto_nombre) LIKE '%parche%')  THEN 32000
    WHEN lower(producto_nombre) LIKE '%bebird%'                                             THEN 175700
    WHEN lower(producto_nombre) LIKE '%raspador%' OR lower(producto_nombre) LIKE '%lengua%'
      OR lower(producto_nombre) LIKE '%limpiador%' OR lower(producto_nombre) LIKE '%tongue%'
      OR lower(producto_nombre) LIKE '%scraper%'                                            THEN 5018
    WHEN lower(producto_nombre) LIKE '%parche%' OR lower(producto_nombre) LIKE '%bucal%'
      OR lower(producto_nombre) LIKE '%mouth%'  OR lower(producto_nombre) LIKE '%tape%'      THEN 16000
    WHEN lower(producto_nombre) LIKE '%tira%'   OR lower(producto_nombre) LIKE '%nasal%'
      OR lower(producto_nombre) LIKE '%nose%'   OR lower(producto_nombre) LIKE '%strip%'     THEN 16000
    WHEN lower(producto_nombre) LIKE '%jaw%'    OR lower(producto_nombre) LIKE '%mandíbula%'
      OR lower(producto_nombre) LIKE '%mandibula%' OR lower(producto_nombre) LIKE '%ejercitador%' THEN 15000
    WHEN lower(producto_nombre) LIKE '%botella%' OR lower(producto_nombre) LIKE '%flexible%'
      OR lower(producto_nombre) LIKE '%bottle%' OR lower(producto_nombre) LIKE '%flow%'      THEN 20230
    ELSE 0
  END
WHERE deleted_at IS NULL
  AND COALESCE(costo_prod, 0) = 0
  -- Si no cae en ninguna familia queda en 0 y hay que mirarlo a mano: mejor
  -- un cero visible que un costo inventado.
  AND producto_nombre IS NOT NULL;

COMMIT;


-- ─── VERIFICACIÓN — corré esto después ──────────────────────
-- Debe dar 0 filas (o solo productos que no pertenecen a ninguna familia):
-- SELECT producto_nombre, count(*) FROM ventas
-- WHERE deleted_at IS NULL AND COALESCE(costo_prod,0) = 0
-- GROUP BY 1 ORDER BY 2 DESC;
--
-- Costo total por mes, antes vs después:
-- SELECT to_char(fecha,'YYYY-MM') AS mes, count(*) AS ventas, sum(costo_prod) AS costo
-- FROM ventas WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1;


-- ═══════════════════════════════════════════════════════════
-- REVERSIÓN — vuelve a dejarlos en 0 (NO recomendado: el 0 era el error)
-- ═══════════════════════════════════════════════════════════
-- Solo tiene sentido si algo salió mal y querés volver al estado anterior
-- para revisarlo. Los costos correctos son los de arriba.
