-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 002 — PRECIOS NUEVOS · vigentes 25/08/2026 10:30
-- ═══════════════════════════════════════════════════════════
-- Cambio de negocio: TODOS los productos pasan a "envío gratis" para el
-- cliente. El flete lo sigue pagando Enrique — solo que ahora está adentro
-- del precio en vez de cobrarse como una línea aparte.
--
-- NO toca ninguna venta ya cargada: cada venta guardó su propio `precio_unit`
-- y `total` al momento de hacerse. El histórico y los reportes viejos quedan
-- exactamente igual. Esto solo cambia el precio de las ventas NUEVAS.
--
-- Recordatorio de cómo lee el sistema estas columnas:
--   precio_1u / 2u / 3u = PRECIO TOTAL DEL PACK, no el precio por unidad.
--   (VentasPage: `setTotal(precio)`, sin multiplicar por la cantidad.)
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Grupo A — misma escalera para los cinco ─────────────
-- 129.000 / 199.000 / 249.000, todo con envío incluido.
UPDATE productos SET precio_1u = 129000, precio_2u = 199000, precio_3u = 249000
WHERE nombre IN (
  'Raspador de Lengua',
  'Tiras nasales',
  'Parches bucales',
  'Ejercitador de mandibula JawFlex Pro',
  'Botella Flexible'
);

-- ─── 2. Pack Gudair — CORRECCIÓN, no aumento ────────────────
-- En la base figuraba 79.000/125.000/155.000, pero las ventas reales ya son
-- de 150.000. El dato del catálogo estaba viejo: se pone al día.
UPDATE productos SET precio_1u = 150000, precio_2u = 235000, precio_3u = 309000
WHERE nombre = 'tiras nasales + parches bucales Pack Gudair';

-- ─── 3. Bebird Pro — solo se vende de a uno ─────────────────
-- ×2 y ×3 no se ofrecen. Igual se cargan a precio lineal (2× y 3×) por
-- seguridad: si alguien carga 2 por error, hoy cobraría 365.000 por los DOS
-- —el mismo precio que por uno— porque el sistema cae al precio de 1u cuando
-- el de 2u está vacío. Con esto, un error de carga no te regala un producto.
UPDATE productos SET precio_1u = 365000, precio_2u = 730000, precio_3u = 1095000
WHERE nombre = 'Limpiador de oido Bebird Pro';

-- ─── 4. El cliente ya no paga envío ─────────────────────────
-- Sin esto, el precio nuevo se suma AL envío y el cliente pagaría
-- 129.000 + 29.000 = 158.000.
--
-- Son dos lugares porque el sistema prueba primero el método de envío y
-- recién después la config:  `envioSel?.costo_cliente || getEnvioCliente()`
UPDATE metodos_envio SET costo_cliente = 0;

INSERT INTO config (clave, valor, actualizado)
VALUES ('envio_cliente', '0', now())
ON CONFLICT (clave) DO UPDATE SET valor = '0', actualizado = now();

COMMIT;


-- ─── VERIFICACIÓN — corré esto después y revisá que dé lo esperado ───
-- Contribución = lo que paga el cliente − costo del producto − flete (29.000 PaP).
-- SELECT nombre, grupo_envio, costo_unit,
--        precio_1u, precio_1u - costo_unit - 29000     AS contrib_1u,
--        precio_2u, precio_2u - costo_unit*2 - 29000   AS contrib_2u,
--        precio_3u, precio_3u - costo_unit*3 - 29000   AS contrib_3u
-- FROM productos WHERE activo ORDER BY nombre;
--
-- SELECT clave, valor FROM config WHERE clave = 'envio_cliente';   -- debe dar 0
-- SELECT nombre, costo_cliente FROM metodos_envio;                 -- todos en 0


-- ═══════════════════════════════════════════════════════════
-- REVERSIÓN — solo si hay que volver atrás
-- ═══════════════════════════════════════════════════════════
-- BEGIN;
--   UPDATE productos SET precio_1u = 79000, precio_2u = 125000, precio_3u = 155000
--   WHERE grupo_envio = 'A';
--   UPDATE productos SET precio_1u = 365000, precio_2u = 365000, precio_3u = 365000
--   WHERE nombre = 'Limpiador de oido Bebird Pro';
--   UPDATE metodos_envio SET costo_cliente = 29000;
--   UPDATE config SET valor = '33000' WHERE clave = 'envio_cliente';
-- COMMIT;
-- OJO: Pack Gudair NO se revierte a 79.000 — ese valor estaba mal.
