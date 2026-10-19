-- ═══════════════════════════════════════════════════════════
-- 20261019000001 · Tope de IA del vendedor (paquete 1, 19-10) · PREPARADA, NO APLICADA
-- ═══════════════════════════════════════════════════════════
-- Decisión de Enrique (19-10): tope mensual USD 90 (antes 45). Alertas al 70% y 90%. Al llegar al tope el vendedor
-- sigue con un modelo más barato (modelo_tope); recién con el tope duro (tope × 1,3 = USD 117) pasa los chats a humano.
--   1. config_wa.vendedor: tope_mensual_usd = 90 + campos nuevos (los lee _shared/vendedor/config.ts → extrasVendedor;
--      sin esta migración el código usa los mismos defaults salvo el tope, que queda en el valor actual).
--   2. config_wa.vendedor_alerta_tope: alertas ya mandadas por mes ({"2026-10": ["70","90"]}).
--   3. Función vendedor_marcar_alerta_tope(mes, clave): marca atómica; true solo la primera vez (dedupe sin carreras).
-- Se puede correr dos veces. NO borra nada.
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Tope y campos nuevos ─────────────────────────────────
-- modelo_tope: Haiku 4.5 porque ya tiene precio en config_wa.precios_claude (un modelo sin precio no suma al gasto).
update public.config_wa
set valor = valor || jsonb_build_object(
  'tope_mensual_usd', 90,
  'tope_duro_usd', 117,
  'modelo_tope', 'claude-haiku-4-5-20251001',
  'alertas_tope_pct', jsonb_build_array(70, 90),
  'espera_agrupar_datos_s', 18
)
where clave = 'vendedor';

-- ─── 2. Registro de alertas ya mandadas ──────────────────────
insert into public.config_wa (clave, valor) values ('vendedor_alerta_tope', '{}'::jsonb)
on conflict (clave) do nothing;

-- ─── 3. Marca atómica de una alerta ──────────────────────────
-- true = no estaba (hay que avisar a Enrique); false = ya se avisó este mes. El update condicional evita que dos
-- turnos simultáneos manden la misma alerta.
create or replace function public.vendedor_marcar_alerta_tope(p_mes text, p_clave text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  n int;
begin
  insert into public.config_wa (clave, valor) values ('vendedor_alerta_tope', '{}'::jsonb)
  on conflict (clave) do nothing;
  update public.config_wa
  set valor = jsonb_set(valor, array[p_mes], coalesce(valor -> p_mes, '[]'::jsonb) || to_jsonb(p_clave), true)
  where clave = 'vendedor_alerta_tope'
    and not coalesce(valor -> p_mes, '[]'::jsonb) ? p_clave;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.vendedor_marcar_alerta_tope(text, text) from public, anon;
grant execute on function public.vendedor_marcar_alerta_tope(text, text) to authenticated, service_role;

COMMIT;
