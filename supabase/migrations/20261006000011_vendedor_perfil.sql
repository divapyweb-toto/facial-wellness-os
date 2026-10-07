-- ═══════════════════════════════════════════════════════════
-- MIGRACIÓN 0011 — PERFIL DEL CLIENTE PARA EL VENDEDOR · 06-10-2026 · Dueño: G1
-- ═══════════════════════════════════════════════════════════
-- Qué hace:
--   wa_conversaciones + perfil_vendedor (jsonb): lo que el vendedor con IA detectó del cliente en la
--   conversación, para no volver a preguntarlo en los turnos siguientes:
--     {necesidad: ronca|pareja_se_queja|boca_seca|aliento|mandibula|deporte|regalo|otro,
--      perfil: apurado|desconfiado|curioso|precio|regalo|indefinido,
--      nota: texto corto, ofrecido_x2: bool, pregunto_freno: bool}
--   Lo escribe _shared/vendedor/orquestador.ts (perfil.ts valida los valores).
--
-- NO borra nada. NO toca filas existentes (default '{}'). Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════

BEGIN;

alter table public.wa_conversaciones
  add column if not exists perfil_vendedor jsonb not null default '{}'::jsonb;

comment on column public.wa_conversaciones.perfil_vendedor is
  'Perfil del cliente detectado por el vendedor IA (necesidad, perfil, nota, ofrecido_x2, pregunto_freno). Ver _shared/vendedor/perfil.ts';

COMMIT;
