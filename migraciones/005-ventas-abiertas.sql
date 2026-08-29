-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 005 — PEDIDOS ABIERTOS
-- ═══════════════════════════════════════════════════════════
-- El sistema asumía que todo pedido era: 1 producto, cantidad 1 a 3, precio
-- de lista. El negocio ya no funciona así — hay mayoristas, upsells y
-- descuentos. Estos dos campos abren el modelo sin romper nada.
--
-- Solo AGREGA columnas. Ninguna fila existente se toca, ningún número
-- histórico cambia. `margen` y `ganancia_neta` son columnas generadas y se
-- siguen calculando igual.
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- ─── Mayorista ──────────────────────────────────────────────
-- Va SEPARADO de `canal_origen` a propósito: los mayoristas entran por
-- WhatsApp, pero no todo pedido de WhatsApp es mayorista. Mezclarlos haría
-- que un pedido de 20 unidades sin costo de ads contamine el ticket promedio
-- y el CPA — justo las tablas con las que se deciden precios y campañas.
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS es_mayorista boolean NOT NULL DEFAULT false;

-- ─── Precio de lista al momento de vender ───────────────────
-- Guarda lo que la lista sugería cuando se cargó la venta. Con este único
-- campo se obtiene el descuento gratis:  descuento = precio_lista − total.
-- No hace falta una columna aparte que después haya que mantener sincronizada.
--
-- Queda NULL en las ventas históricas, y eso es lo correcto: significa "no
-- sabemos qué decía la lista en esa fecha", que es la verdad — el sistema no
-- lleva histórico de precios (hallazgo E-2 de la auditoría del 20/08).
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS precio_lista integer;

-- Los reportes van a filtrar "excluir mayoristas" seguido. Índice parcial:
-- solo indexa los mayoristas, que son los pocos.
CREATE INDEX IF NOT EXISTS idx_ventas_mayorista
  ON ventas (fecha) WHERE es_mayorista;

COMMIT;


-- ─── VERIFICACIÓN — los totales no se movieron ──────────────
-- SELECT to_char(fecha,'YYYY-MM') mes, count(*) ventas,
--        sum(total) total, sum(margen) margen, sum(ganancia_neta) ganancia
-- FROM ventas WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1;
--
-- SELECT count(*) FILTER (WHERE es_mayorista) AS mayoristas,
--        count(*) FILTER (WHERE precio_lista IS NOT NULL) AS con_lista
-- FROM ventas WHERE deleted_at IS NULL;   -- al principio: 0 y 0


-- ═══════════════════════════════════════════════════════════
-- REVERSIÓN
-- ═══════════════════════════════════════════════════════════
-- BEGIN;
--   DROP INDEX IF EXISTS idx_ventas_mayorista;
--   ALTER TABLE ventas DROP COLUMN IF EXISTS es_mayorista, DROP COLUMN IF EXISTS precio_lista;
-- COMMIT;
