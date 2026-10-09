-- ═══════════════════════════════════════════════════════════
-- Seguridad (revisión del 09-10-2026). Idempotente.
-- 1) Alta de usuario: el rol SIEMPRE nace 'staff' (antes se podía pedir 'admin' al registrarse).
-- 2) Un usuario no puede cambiarse el rol a sí mismo: solo puede editar nombre y avatar.
-- 3) Vistas de KPIs que salteaban RLS y anon podía leer: ahora respetan RLS y anon no las ve.
-- 4) anon (la clave pública del sitio) sin permisos de tabla en public: todo pasa por login.
-- 5) Triggers SECURITY DEFINER sin search_path fijo ni ejecución pública.
-- El registro abierto se cierra en el panel de Supabase (Authentication → "Allow new users to sign up").
-- ═══════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  insert into public.profiles (id, nombre, rol)
  values (new.id, coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)), 'staff');
  return new;
end;
$function$;

revoke update on public.profiles from authenticated;
grant update (nombre, avatar_url) on public.profiles to authenticated;

alter view if exists public.kpis_mensuales set (security_invoker = true);
alter view if exists public.ventas_por_producto set (security_invoker = true);

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

do $$
declare f text;
begin
  foreach f in array array['fw_stock_on_insert','fw_stock_on_update','fw_stock_on_delete','handle_new_user'] loop
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f) then
      execute format('revoke execute on function public.%I() from public, anon, authenticated', f);
      execute format('alter function public.%I() set search_path = public', f);
    end if;
  end loop;
end $$;
