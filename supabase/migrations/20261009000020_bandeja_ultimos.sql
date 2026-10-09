-- ═══════════════════════════════════════════════════════════
-- Bandeja: último mensaje de cada conversación (vista previa y punto
-- de "espera respuesta"). Antes la pantalla traía los últimos 1.000 mensajes
-- de 300 chats juntos: con chats muy activos, los demás quedaban sin vista
-- previa. Esta vista devuelve exactamente una fila por conversación.
-- security_invoker: respeta el RLS de wa_mensajes (solo usuarios logueados).
-- Usa el índice (conversacion_id, creado_en desc) de la ola 1. Idempotente.
-- ═══════════════════════════════════════════════════════════
create or replace view public.wa_ultimo_mensaje
with (security_invoker = true) as
select distinct on (m.conversacion_id)
       m.id, m.conversacion_id, m.direccion, m.tipo, m.texto, m.contenido, m.estado, m.creado_en
  from public.wa_mensajes m
 order by m.conversacion_id, m.creado_en desc;

revoke all on public.wa_ultimo_mensaje from anon;
grant select on public.wa_ultimo_mensaje to authenticated, service_role;
