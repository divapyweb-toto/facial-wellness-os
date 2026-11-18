-- 18-11-2026 · FUNCIONES · audit_log y error_log tenían RLS prendido y NINGUNA política: todo lo que escribía la web
-- (src/lib/audit.js, src/lib/errorLog.js, con try/catch silencioso) se rechazaba y las tablas quedaron en 0 filas.
-- Se permite a la web con sesión (authenticated) insertar y leer (la pantalla Sistema los muestra). anon sigue sin acceso.
-- VOLVER ATRÁS:
--   drop policy if exists audit_log_insertar on public.audit_log; drop policy if exists audit_log_leer on public.audit_log;
--   drop policy if exists error_log_insertar on public.error_log; drop policy if exists error_log_leer on public.error_log;
create policy audit_log_insertar on public.audit_log for insert to authenticated with check (true);
create policy audit_log_leer on public.audit_log for select to authenticated using (true);
create policy error_log_insertar on public.error_log for insert to authenticated with check (true);
create policy error_log_leer on public.error_log for select to authenticated using (true);
grant select, insert on public.audit_log, public.error_log to authenticated;
