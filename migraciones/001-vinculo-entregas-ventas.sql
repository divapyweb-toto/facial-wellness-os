-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 001 — VÍNCULO ENTRE `entregas` Y `ventas`
-- ═══════════════════════════════════════════════════════════
-- Hoy no hay ningún vínculo guardado. Cada vez que algo necesita saber a qué
-- venta corresponde un paquete, vuelve a calcularlo normalizando el texto de
-- `n_referencia` — en 8 archivos distintos, cada uno con su propia copia de la
-- regla. Eso ya causó bugs (el prefijo 'FW-' de Lucero, el '#' de Shopify).
--
-- Esta migración guarda el vínculo UNA vez, deja registrado CÓMO se estableció,
-- y conserva los datos del courier que hoy se tiran a la basura al importar.
--
-- NO borra nada. NO modifica ninguna fila existente. Solo agrega columnas
-- vacías, índices y una protección. Es reversible con el bloque del final.
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. El vínculo ──────────────────────────────────────────
-- Apunta a UNA fila de `ventas`. Un pedido de 2 productos son 2 filas de venta
-- con la misma referencia (43 de tus 611 pedidos), y el paquete es uno solo:
-- `venta_id` apunta a la fila ancla y las hermanas salen por su referencia
-- compartida, que es como ya funciona todo el resto del sistema.
--
-- ON DELETE SET NULL: si alguna vez borrás una venta de verdad, el paquete no
-- desaparece — vuelve a la cola de pendientes, que es lo correcto.
ALTER TABLE entregas
  ADD COLUMN IF NOT EXISTS venta_id uuid REFERENCES ventas(id) ON DELETE SET NULL;

-- ─── 2. Cómo se estableció el vínculo ───────────────────────
-- Sin esto no hay forma de saber si un vínculo lo puso la referencia (100%
-- confiable) o un match por nombre (que puede estar mal). Y sin distinguir
-- 'manual' del resto, una carga de Excel pisaría lo que confirmaste a mano.
--
--   referencia → el reporte trajo tu N° REFERENCIA. Confianza total.
--   telefono   → cruzó por teléfono normalizado. Alta.
--   nombre     → cruzó por nombre + monto + ciudad. Media.
--   manual     → lo confirmaste vos desde la cola. Intocable.
--   sin_venta  → confirmaste que NO corresponde a ninguna venta (los 199
--                paquetes viejos de PaP que volvieron sin referencia).
--                Sale de la cola para siempre sin inventar un vínculo falso.
ALTER TABLE entregas
  ADD COLUMN IF NOT EXISTS vinculo_metodo text,
  ADD COLUMN IF NOT EXISTS vinculo_at     timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entregas_vinculo_metodo_check') THEN
    ALTER TABLE entregas ADD CONSTRAINT entregas_vinculo_metodo_check
      CHECK (vinculo_metodo IS NULL OR vinculo_metodo IN
             ('referencia', 'telefono', 'nombre', 'manual', 'sin_venta'));
  END IF;
END $$;

-- ─── 3. Datos del courier que hoy se descartan ──────────────
-- El reporte de Gestión de PaP trae Telefono, Nombre y Direccion, y el export
-- de Lucero trae Telefono, Destinatario y Direccion. Los parsers los LEEN y
-- después `soloColumnasEntregas()` los borra, porque no hay columna donde
-- guardarlos. Consecuencia: los 199 paquetes viejos sin referencia ya no se
-- pueden recuperar ni con el mejor matching — el dato se perdió al importar.
-- Guardarlos también deja auditar por qué un vínculo automático se decidió así.
ALTER TABLE entregas
  ADD COLUMN IF NOT EXISTS telefono_courier  text,
  ADD COLUMN IF NOT EXISTS nombre_courier    text,
  ADD COLUMN IF NOT EXISTS direccion_courier text;

-- ─── 4. Índices ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_entregas_venta_id
  ON entregas (venta_id);

-- La cola de pendientes pregunta siempre lo mismo: "¿qué quedó sin vincular?".
-- El índice parcial solo indexa esas filas, que son las pocas que importan.
CREATE INDEX IF NOT EXISTS idx_entregas_sin_vincular
  ON entregas (fecha_ingreso DESC)
  WHERE venta_id IS NULL AND vinculo_metodo IS DISTINCT FROM 'sin_venta';

CREATE INDEX IF NOT EXISTS idx_ventas_n_referencia
  ON ventas (n_referencia) WHERE deleted_at IS NULL;

COMMIT;


-- ═══════════════════════════════════════════════════════════
-- PARTE 2 (opcional pero recomendada) — BLINDAJE DEL VÍNCULO MANUAL
-- ═══════════════════════════════════════════════════════════
-- Pediste que un vínculo confirmado a mano NUNCA lo pise uno automático.
-- Se puede cumplir solo desde el código, pero hoy hay 8 archivos que escriben
-- en `entregas` y alcanza con que uno se olvide de la regla. Esto lo garantiza
-- desde la base: pase lo que pase en el código, un 'manual' o un 'sin_venta'
-- no se pisa. Solo se puede cambiar volviendo a marcarlo a mano.
--
-- Si algún día molesta, se saca con el bloque de reversión de abajo.

CREATE OR REPLACE FUNCTION proteger_vinculo_manual()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo protege lo confirmado por una persona.
  IF OLD.vinculo_metodo IN ('manual', 'sin_venta')
     AND NEW.vinculo_metodo IS DISTINCT FROM 'manual'
     AND NEW.vinculo_metodo IS DISTINCT FROM 'sin_venta'
  THEN
    -- Se conserva la decisión humana y se deja pasar el resto del UPDATE
    -- (estado, importe, rendición). Solo se revierten las 3 columnas del vínculo.
    NEW.venta_id       := OLD.venta_id;
    NEW.vinculo_metodo := OLD.vinculo_metodo;
    NEW.vinculo_at     := OLD.vinculo_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_proteger_vinculo_manual ON entregas;
CREATE TRIGGER trg_proteger_vinculo_manual
  BEFORE UPDATE ON entregas
  FOR EACH ROW EXECUTE FUNCTION proteger_vinculo_manual();


-- ═══════════════════════════════════════════════════════════
-- REVERSIÓN — copiar y ejecutar solo si hay que deshacer todo
-- ═══════════════════════════════════════════════════════════
-- OJO: borra los vínculos ya establecidos, incluidos los que confirmaste
-- a mano. El resto de los datos de `entregas` queda intacto.
--
-- BEGIN;
--   DROP TRIGGER IF EXISTS trg_proteger_vinculo_manual ON entregas;
--   DROP FUNCTION IF EXISTS proteger_vinculo_manual();
--   DROP INDEX IF EXISTS idx_entregas_venta_id;
--   DROP INDEX IF EXISTS idx_entregas_sin_vincular;
--   DROP INDEX IF EXISTS idx_ventas_n_referencia;
--   ALTER TABLE entregas DROP CONSTRAINT IF EXISTS entregas_vinculo_metodo_check;
--   ALTER TABLE entregas
--     DROP COLUMN IF EXISTS venta_id,
--     DROP COLUMN IF EXISTS vinculo_metodo,
--     DROP COLUMN IF EXISTS vinculo_at,
--     DROP COLUMN IF EXISTS telefono_courier,
--     DROP COLUMN IF EXISTS nombre_courier,
--     DROP COLUMN IF EXISTS direccion_courier;
-- COMMIT;
