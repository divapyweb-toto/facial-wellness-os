-- ═══════════════════════════════════════════════════════════
-- OLA 1 · procesar-envios (subagente F) · 06-10-2026
-- ═══════════════════════════════════════════════════════════
-- Función para que la Edge Function `procesar-envios` tome un lote de
-- envios_programados vencidos SIN que dos ejecuciones manden lo mismo.
--
-- Cómo bloquea: `for update skip locked` (otra ejecución salta las filas tomadas)
-- y corre `enviar_desde` unos minutos hacia adelante (lease). Si la función se
-- cae a mitad de camino, las filas vuelven a estar disponibles al vencer el lease.
-- No agrega estados nuevos ni toca datos existentes. Se puede correr dos veces.
-- ═══════════════════════════════════════════════════════════

create or replace function public.reclamar_envios_programados(
  p_lote int default 50,
  p_lease_min int default 10
)
returns setof public.envios_programados
language sql
security definer
set search_path = public
as $$
  update public.envios_programados e
     set enviar_desde = now() + make_interval(mins => p_lease_min)
   where e.id in (
     select id
       from public.envios_programados
      where estado = 'pendiente'
        and enviar_desde <= now()
      order by enviar_desde
      limit greatest(1, least(p_lote, 500))
      for update skip locked
   )
  returning e.*;
$$;

-- Solo el service role (Edge Functions) puede llamarla.
revoke all on function public.reclamar_envios_programados(int, int) from public, anon, authenticated;
grant execute on function public.reclamar_envios_programados(int, int) to service_role;
