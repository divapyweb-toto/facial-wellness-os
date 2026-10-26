-- ═══════════════════════════════════════════════════════════
-- 26-10-2026 · Registro de la prueba de courier: solo ventas con fecha desde
-- config.courier_preferir_lucero.registro_desde. Antes, editar la ciudad o el pago de
-- una venta vieja (p. ej. VT-1027 del 11-10) la sumaba al registro. Se borran las que
-- ya entraron así (solo filas del registro de prueba; no toca ventas).
-- ═══════════════════════════════════════════════════════════
create or replace function public.registrar_courier_prueba() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb; hoy date := (now() at time zone 'America/Asuncion')::date; s jsonb; v_cod boolean;
begin
  -- Nunca frena la carga de una venta: cualquier error se anota como aviso y sigue.
  begin
    select valor::jsonb into cfg from public.config where clave = 'courier_preferir_lucero';
    if cfg is null or not coalesce((cfg ->> 'activo')::boolean, false)
       or hoy > coalesce((cfg ->> 'registro_hasta')::date, hoy - 1)
       or new.fecha < coalesce((cfg ->> 'registro_desde')::date, hoy)  -- 26-10: solo ventas de la semana de prueba (editar una vieja no la suma)
       or new.deleted_at is not null or coalesce(new.es_mayorista, false) then
      return new;
    end if;
    v_cod := not coalesce(new.pago_anticipado, false);
    s := public.sugerir_courier(new.ciudad, v_cod);
    insert into public.courier_prueba_registro as r (venta_id, n_referencia, fecha_venta, ciudad, cod, ciudad_reconocida, sugerido_regla, sugerido_costo, sin_cobertura)
    values (new.id, new.n_referencia, new.fecha, new.ciudad, v_cod, (s ->> 'ciudad_reconocida')::boolean, s ->> 'sugerido', s ->> 'sugerido_costo', (s ->> 'sin_cobertura')::boolean)
    on conflict (venta_id) do update set n_referencia = excluded.n_referencia, ciudad = excluded.ciudad, cod = excluded.cod,
      ciudad_reconocida = excluded.ciudad_reconocida, sugerido_regla = excluded.sugerido_regla,
      sugerido_costo = excluded.sugerido_costo, sin_cobertura = excluded.sin_cobertura, actualizado_en = now();
  exception when others then
    raise warning 'registrar_courier_prueba (%): %', new.n_referencia, sqlerrm;
  end;
  return new;
end $$;


delete from public.courier_prueba_registro r
 where r.fecha_venta < coalesce((select (valor::jsonb ->> 'registro_desde')::date from public.config where clave = 'courier_preferir_lucero'), r.fecha_venta);

create or replace view public.courier_prueba_semana with (security_invoker = true) as
select r.n_referencia, r.fecha_venta, r.ciudad, r.ciudad_reconocida, r.cod,
       r.sugerido_regla, r.sugerido_costo, r.sin_cobertura,
       -- ventas.transportadora arranca en 'pap' por defecto: el método de envío elegido en la venta manda sobre ella.
       coalesce(e.transportadora,
                case when v.metodo_envio_nombre ilike '%lucero%' then 'lucero'
                     when v.metodo_envio_nombre ilike '%punto a punto%' then 'pap' end,
                case when v.transportadora in ('pap', 'lucero') then v.transportadora end) as elegido,
       e.transportadora is not null as ya_salio,
       v.producto_nombre,
       r.registrado_en
  from public.courier_prueba_registro r
  join public.ventas v on v.id = r.venta_id
  left join lateral (select x.transportadora from public.entregas x where x.n_referencia = r.n_referencia
                      order by x.created_at desc limit 1) e on true
 where v.deleted_at is null
   and r.fecha_venta >= coalesce((select (valor::jsonb ->> 'registro_desde')::date from public.config where clave = 'courier_preferir_lucero'), r.fecha_venta);

revoke all on public.courier_prueba_semana from anon;
grant select on public.courier_prueba_semana to authenticated, service_role;
