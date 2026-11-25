-- 20261125000001 · Regalo por etiqueta: el pedido con REGALO_INHALADOR descuenta 1 Inhalador de menta extra (25-11-2026).
-- Black Friday 27-30/11 (calendario fila "Stock: descontar 1 Inhalador extra", OK permanente de Enrique del 24-11).
-- No hay línea a ₲0 en Shopify (SIFEN rechaza precio 0): el regalo vive solo en la etiqueta. La factura no cambia.
--
-- Regla: el regalo sigue al stock del pedido, con el MISMO criterio que el motor único (20261012000003):
--   · Descontado  ⇔ el pedido tiene la etiqueta Y alguna venta viva de ese pedido (VT-n, sin papelera, afecta_stock)
--                   tiene el stock descontado y no reingresado.
--   · Se repone cuando eso deja de cumplirse: venta borrada, cancelada en Shopify (cancelar_venta_por_shopify), mandada
--     a la papelera, o devuelta y ESCANEADA en Recepción (reingresado_at). 'devuelto' sin escanear NO repone (igual
--     que el resto: el paquete sigue en el courier). Si la venta vuelve (reactivación / sale de la papelera), se descuenta
--     otra vez. Etiqueta sacada antes de despachar → se repone.
--   · Nunca dos veces: una fila por (pedido, etiqueta) en regalos_stock con su estado, bloqueada mientras se decide.
--   · Si algo falla, la venta NO se traba: se anota el error en regalos_stock.error y se sigue.
-- Se dispara al cambiar ventas (alta, estado, papelera, reingreso, borrado) y al cambiar las etiquetas en shopify_pedidos.
--
-- Vuelta atrás exacta (reponer primero lo que quedó descontado, después borrar):
--   select public.fw_mover_stock(r.producto_id, null, r.cantidad, 'devolucion', 'Regalo ' || r.etiqueta || ' anulado ' || r.ref)
--     from public.regalos_stock r where r.descontado;
--   drop trigger if exists regalo_stock_ventas on public.ventas;
--   drop trigger if exists regalo_stock_pedidos on public.shopify_pedidos;
--   drop function if exists public.regalo_stock_trg_ventas(); drop function if exists public.regalo_stock_trg_pedidos();
--   drop function if exists public.regalo_stock_sincronizar(text);
--   drop table if exists public.regalos_stock; drop table if exists public.regalos_etiqueta;

create table if not exists public.regalos_etiqueta (
  etiqueta    text primary key check (etiqueta = upper(etiqueta) and etiqueta <> ''),
  producto_id uuid not null references public.productos (id),
  cantidad    integer not null default 1 check (cantidad > 0),
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);
comment on table public.regalos_etiqueta is 'Regalo que descuenta stock por etiqueta del pedido (sin línea en Shopify). Misma lista en supabase/functions/_shared/regalos.ts.';

create table if not exists public.regalos_stock (
  ref            text not null,                       -- 'VT-1301'
  etiqueta       text not null references public.regalos_etiqueta (etiqueta),
  producto_id    uuid not null references public.productos (id),
  cantidad       integer not null check (cantidad > 0),
  descontado     boolean not null default false,
  descontado_en  timestamptz,
  repuesto_en    timestamptz,
  veces          integer not null default 0,          -- cuántas veces se descontó (reactivaciones incluidas)
  error          text,
  actualizado_en timestamptz not null default now(),
  primary key (ref, etiqueta)
);
comment on table public.regalos_stock is 'Estado del regalo por pedido: descontado o no. Lo maneja regalo_stock_sincronizar(); no editar a mano.';

alter table public.regalos_etiqueta enable row level security;
alter table public.regalos_stock enable row level security;
revoke all on public.regalos_etiqueta, public.regalos_stock from anon, public;
grant select on public.regalos_etiqueta, public.regalos_stock to authenticated;
grant all on public.regalos_etiqueta, public.regalos_stock to service_role;
drop policy if exists regalos_etiqueta_leer on public.regalos_etiqueta;
create policy regalos_etiqueta_leer on public.regalos_etiqueta for select to authenticated using (true);
drop policy if exists regalos_stock_leer on public.regalos_stock;
create policy regalos_stock_leer on public.regalos_stock for select to authenticated using (true);

-- El regalo de Black Friday. Si el producto no existe con ese nombre, la migración falla (mejor que descontar otro).
insert into public.regalos_etiqueta (etiqueta, producto_id, cantidad)
select 'REGALO_INHALADOR', p.id, 1 from public.productos p
 where lower(trim(p.nombre)) = 'inhalador de menta' and not coalesce(p.es_combo, false)
on conflict (etiqueta) do nothing;
do $$ begin
  if not exists (select 1 from public.regalos_etiqueta where etiqueta = 'REGALO_INHALADOR') then
    raise exception 'No encontré el producto "Inhalador de menta" para el regalo';
  end if;
end $$;

create or replace function public.regalo_stock_sincronizar(p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare
  g record; r public.regalos_stock%rowtype; debe boolean; nombre_pedido text;
begin
  if p_ref is null or p_ref !~ '^VT-[0-9]+$' then return; end if;
  nombre_pedido := '#' || substr(p_ref, 4);
  for g in select * from public.regalos_etiqueta loop
    begin
      debe := g.activo
        and exists (select 1 from public.shopify_pedidos sp
                     where sp.nombre = nombre_pedido and not coalesce(sp.es_borrador, false)
                       and exists (select 1 from unnest(sp.tags) t where upper(trim(t)) = g.etiqueta))
        and exists (select 1 from public.ventas v
                     where v.n_referencia = p_ref and v.deleted_at is null and coalesce(v.tienda, 'voltra') = 'voltra'
                       and v.afecta_stock and coalesce(v.stock_descontado, false) and v.reingresado_at is null);
      select * into r from public.regalos_stock where ref = p_ref and etiqueta = g.etiqueta for update;
      if not found then
        if not debe then continue; end if;             -- nada que hacer y nada que guardar
        insert into public.regalos_stock (ref, etiqueta, producto_id, cantidad)
        values (p_ref, g.etiqueta, g.producto_id, g.cantidad)
        on conflict (ref, etiqueta) do nothing;
        select * into r from public.regalos_stock where ref = p_ref and etiqueta = g.etiqueta for update;
      end if;
      if debe and not r.descontado then
        perform public.fw_mover_stock(r.producto_id, null, -r.cantidad, 'venta', 'Regalo ' || g.etiqueta || ' ' || p_ref);
        update public.regalos_stock set descontado = true, descontado_en = now(), veces = veces + 1, error = null, actualizado_en = now()
         where ref = p_ref and etiqueta = g.etiqueta;
      elsif not debe and r.descontado then
        perform public.fw_mover_stock(r.producto_id, null, r.cantidad, 'devolucion', 'Regalo ' || g.etiqueta || ' repuesto ' || p_ref);
        update public.regalos_stock set descontado = false, repuesto_en = now(), error = null, actualizado_en = now()
         where ref = p_ref and etiqueta = g.etiqueta;
      end if;
    exception when others then
      -- La venta o el pedido NO se traban por el regalo: se anota y se sigue.
      raise warning 'regalo_stock_sincronizar(%, %): %', p_ref, g.etiqueta, sqlerrm;
      insert into public.regalos_stock (ref, etiqueta, producto_id, cantidad, error)
      values (p_ref, g.etiqueta, g.producto_id, g.cantidad, left(sqlerrm, 500))
      on conflict (ref, etiqueta) do update set error = excluded.error, actualizado_en = now();
    end;
  end loop;
end;
$$;
revoke all on function public.regalo_stock_sincronizar(text) from anon, public, authenticated;
grant execute on function public.regalo_stock_sincronizar(text) to service_role;

create or replace function public.regalo_stock_trg_ventas() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and OLD.n_referencia like 'VT-%' then perform public.regalo_stock_sincronizar(OLD.n_referencia); end if;
  if tg_op in ('INSERT', 'UPDATE') and NEW.n_referencia like 'VT-%'
     and (tg_op = 'INSERT' or NEW.n_referencia is distinct from OLD.n_referencia) then
    perform public.regalo_stock_sincronizar(NEW.n_referencia);
  end if;
  return null;
end;
$$;
revoke all on function public.regalo_stock_trg_ventas() from anon, public, authenticated;

create or replace function public.regalo_stock_trg_pedidos() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Solo si la etiqueta de algún regalo está (o estaba) en el pedido: el resto de los pedidos no paga nada.
  if exists (select 1 from public.regalos_etiqueta g
              where exists (select 1 from unnest(coalesce(NEW.tags, '{}') || coalesce(case when tg_op = 'UPDATE' then OLD.tags end, '{}')) t
                             where upper(trim(t)) = g.etiqueta)) then
    if NEW.nombre ~ '^#[0-9]+$' then perform public.regalo_stock_sincronizar('VT-' || substr(NEW.nombre, 2)); end if;
    if tg_op = 'UPDATE' and OLD.nombre is distinct from NEW.nombre and OLD.nombre ~ '^#[0-9]+$' then
      perform public.regalo_stock_sincronizar('VT-' || substr(OLD.nombre, 2));
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.regalo_stock_trg_pedidos() from anon, public, authenticated;

drop trigger if exists regalo_stock_ventas on public.ventas;
create trigger regalo_stock_ventas
  after insert or delete or update of estado, deleted_at, stock_descontado, reingresado_at, afecta_stock, n_referencia, tienda
  on public.ventas for each row execute function public.regalo_stock_trg_ventas();

drop trigger if exists regalo_stock_pedidos on public.shopify_pedidos;
create trigger regalo_stock_pedidos
  after insert or update of tags, es_borrador, nombre on public.shopify_pedidos
  for each row execute function public.regalo_stock_trg_pedidos();

-- Pedidos que ya tienen la etiqueta (al 25-11 eran 0): se ponen al día una vez.
do $$
declare x record;
begin
  for x in select distinct 'VT-' || substr(sp.nombre, 2) as ref from public.shopify_pedidos sp
            where sp.nombre ~ '^#[0-9]+$' and exists (select 1 from unnest(sp.tags) t join public.regalos_etiqueta g on upper(trim(t)) = g.etiqueta)
  loop
    perform public.regalo_stock_sincronizar(x.ref);
  end loop;
end $$;
