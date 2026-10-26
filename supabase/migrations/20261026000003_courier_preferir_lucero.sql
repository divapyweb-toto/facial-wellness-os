-- ═══════════════════════════════════════════════════════════
-- 26-10-2026 · Regla de courier "preferir Lucero" (MANDATO v2, punto 7), SOLO SUGERENCIA.
-- · config.courier_preferir_lucero {"activo": true}: si Lucero llega a la ciudad con cobranza
--   (o, con pago anticipado, si llega) → se sugiere Lucero. Si no → el de siempre (PaP solo si
--   cobra ahí; si nadie cobra, sin_cobertura como antes).
-- · No asigna nada: config.motor_courier sigue {"activo": false}. JawFlex y el bloqueo de
--   PaP sin cobranza viven en Despacho/transportadoras.js y no cambian.
-- · sugerir_courier suma 'regla' y 'sugerido_costo' (el que habría salido por costo), sin
--   cambiar ninguna clave existente.
-- · Registro de 7 días por venta cargada (courier_prueba_registro + vista courier_prueba_semana).
-- ═══════════════════════════════════════════════════════════

insert into public.config (clave, valor)
values ('courier_preferir_lucero', jsonb_build_object(
  'activo', true,
  'registro_desde', (now() at time zone 'America/Asuncion')::date,
  'registro_hasta', (now() at time zone 'America/Asuncion')::date + 7)::text)
on conflict (clave) do nothing;

create or replace function public.sugerir_courier(p_ciudad text, p_cod boolean DEFAULT true)
 returns jsonb language sql stable as $function$
  with o as (
    select c.courier, public.tarifa_courier(c.courier, p_ciudad) as t, te.tasa_usada, te.pocos_datos, te.resueltos
    from (values ('pap'), ('lucero')) c(courier) left join public.tasa_entrega_courier te using (courier)
  ),
  op as (
    select courier, t, tasa_usada, pocos_datos, resueltos,
      (t is not null and not coalesce((t ->> 'estimado')::boolean, false) and (not p_cod or (t ->> 'cobranza')::boolean)) as valido,
      round((t ->> 'precio')::numeric / nullif(tasa_usada / 100, 0)) as costo_por_entregado
    from o
  ),
  pref as (select coalesce((select (valor::jsonb ->> 'activo')::boolean from public.config where clave = 'courier_preferir_lucero'), false) as activo),
  por_costo as (select courier from op where valido order by costo_por_entregado, courier limit 1),
  regla as (select case when (select activo from pref) and exists (select 1 from op where courier = 'lucero' and valido)
                        then 'preferir_lucero' else 'costo' end as r)
  select jsonb_build_object(
    'ciudad', p_ciudad,
    -- 26-10: con la regla activa y Lucero válido (cobra acá, o llega si es pago anticipado) → Lucero.
    'sugerido', case when (select r from regla) = 'preferir_lucero' then 'lucero' else (select courier from por_costo) end,
    'regla', (select r from regla),
    'sugerido_costo', (select courier from por_costo),
    'sin_cobertura', not exists (select 1 from op where valido),
    -- false = ningún courier tiene la ciudad en su tabla (typo o pueblo chico): no avisar "sin cobertura" por esto solo
    'ciudad_reconocida', exists (select 1 from op where t is not null and not coalesce((t ->> 'estimado')::boolean, false)),
    'opciones', coalesce((select jsonb_agg(jsonb_build_object('courier', courier, 'precio', (t ->> 'precio')::int,
        'estimado', coalesce((t ->> 'estimado')::boolean, false), 'cobranza', (t ->> 'cobranza')::boolean, 'zona', t ->> 'zona',
        'tiempo', t ->> 'tiempo', 'dias_min', (t ->> 'dias_min')::int, 'dias_max', (t ->> 'dias_max')::int,
        'tasa', tasa_usada, 'pocos_datos', pocos_datos, 'resueltos', resueltos,
        'costo_por_entregado', costo_por_entregado, 'valido', valido) order by costo_por_entregado) from op where t is not null), '[]'::jsonb))
$function$;

-- ── Registro de la prueba (una fila por venta cargada mientras dure el registro) ──
create table if not exists public.courier_prueba_registro (
  venta_id uuid primary key references public.ventas(id) on delete cascade,
  n_referencia text,
  fecha_venta date,
  ciudad text,
  cod boolean not null,
  ciudad_reconocida boolean,
  sugerido_regla text,          -- lo que sugiere la regla vigente (preferir Lucero)
  sugerido_costo text,          -- lo que habría salido solo por costo
  sin_cobertura boolean,
  registrado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
alter table public.courier_prueba_registro enable row level security;
do $$ begin
  create policy "Autenticados leen courier_prueba_registro" on public.courier_prueba_registro for select using (auth.uid() is not null);
exception when duplicate_object then null; end $$;

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

drop trigger if exists courier_prueba_registro_trg on public.ventas;
create trigger courier_prueba_registro_trg
  after insert or update of ciudad, pago_anticipado on public.ventas
  for each row execute function public.registrar_courier_prueba();

-- ── Lectura: sugerido vs elegido al final (lo que salió en la guía; si todavía no salió, lo cargado en la venta) ──
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
 where v.deleted_at is null;

revoke all on public.courier_prueba_semana from anon;
grant select on public.courier_prueba_semana to authenticated, service_role;
