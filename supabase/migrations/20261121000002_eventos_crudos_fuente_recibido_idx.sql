-- 21-11-2026 · Índice para salud-canal: eventos_crudos por fuente y fecha.
-- El 21-11 a las 14:00 salud-canal se pasó de tiempo ("statement timeout") al buscar webhooks de calidad de las últimas
-- 48 h: sin índice leía la tabla entera (≈43.000 filas, 1.129 ms). Con este índice: 5,6 ms (probado con rollback).
-- CONCURRENTLY: se crea sin bloquear las escrituras de la tabla (correr fuera de una transacción).
-- VUELTA ATRÁS: drop index concurrently if exists public.eventos_crudos_fuente_recibido_idx;
create index concurrently if not exists eventos_crudos_fuente_recibido_idx on public.eventos_crudos (fuente, recibido_en);
