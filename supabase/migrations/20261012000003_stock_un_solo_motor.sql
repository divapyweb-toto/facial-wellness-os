-- 20261012000003 · Stock con UN solo motor (auditoría 12-10-2026). Requiere aprobación de Enrique antes de aplicar.
--
-- Problemas que arregla (verificados en la base el 12-10):
--  1. Dos motores descontaban la misma venta: el trigger de la base y la app (aplicarStockNuevaVenta / "Sincronizar").
--     El trigger nunca marcaba ventas.stock_descontado, así que la app volvía a descontar (casos del 28-07 y 29-08).
--  2. El trigger descontaba el COMBO y no sus componentes: Pack Gudair quedó en -34 y Tiras/Parches inflados.
--  3. El trigger reponía al pasar a 'devuelto' (el paquete todavía está en el courier) y Recepción volvía a sumar al
--     escanearlo: doble reposición.
--
-- Regla nueva (la misma que ya usaba la app, src/lib/stockEngine.js):
--  · Venta nueva activa (pendiente/entregado) → descuenta; si es combo, descuenta sus componentes. Marca
--    stock_descontado = true para que la app no repita.
--  · Pasa a 'devuelto' → NO repone: se repone recién al escanear en Recepción (reingresado_at).
--  · Vuelve de 'devuelto' a activo → solo si ya se había reingresado, se vuelve a descontar.
--  · Venta borrada → repone solo si estaba descontada y no reingresada.

create or replace function public.fw_mover_stock(p_producto uuid, p_nombre text, p_delta integer, p_tipo text, p_motivo text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  prod public.productos%rowtype;
  comp record;
begin
  if p_delta = 0 then return; end if;
  select * into prod from public.productos
   where (p_producto is not null and id = p_producto) or (p_producto is null and nombre = p_nombre)
   limit 1;
  if not found then return; end if;
  if prod.es_combo then
    for comp in
      select c.id, c.nombre, x.qty from (values (prod.componente_1_id, coalesce(prod.componente_1_qty, 1)),
                                               (prod.componente_2_id, coalesce(prod.componente_2_qty, 1))) as x(id, qty)
      join public.productos c on c.id = x.id
    loop
      update public.productos set stock_actual = stock_actual + p_delta * comp.qty where id = comp.id;
      insert into public.stock_movimientos (producto_id, producto_nombre, tipo, cantidad, motivo)
      values (comp.id, comp.nombre, p_tipo, abs(p_delta * comp.qty), p_motivo || ' (combo ' || prod.nombre || ')');
    end loop;
  else
    update public.productos set stock_actual = stock_actual + p_delta where id = prod.id;
    insert into public.stock_movimientos (producto_id, producto_nombre, tipo, cantidad, motivo)
    values (prod.id, prod.nombre, p_tipo, abs(p_delta), p_motivo);
  end if;
end;
$$;

-- INSERT: BEFORE, para poder marcar stock_descontado en la misma fila.
create or replace function public.fw_stock_on_insert()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if NEW.afecta_stock and NEW.estado in ('pendiente', 'entregado') and coalesce(NEW.stock_descontado, false) = false then
    perform public.fw_mover_stock(NEW.producto_id, NEW.producto_nombre, -NEW.cantidad, 'venta', 'Venta ' || coalesce(NEW.n_referencia, ''));
    NEW.stock_descontado := true;
  end if;
  return NEW;
end;
$$;

create or replace function public.fw_stock_on_update()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if not NEW.afecta_stock then return NEW; end if;
  -- A 'devuelto': nada (repone Recepción al escanear). De 'devuelto' a activo: solo si ya se había reingresado.
  -- (o si el trigger viejo la había repuesto: movimiento "Devolución <ref>").
  if OLD.estado = 'devuelto' and NEW.estado in ('pendiente', 'entregado') and (OLD.reingresado_at is not null or exists (
       select 1 from public.stock_movimientos m where m.tipo = 'devolucion' and m.motivo = 'Devolución ' || coalesce(OLD.n_referencia, ''))) then
    perform public.fw_mover_stock(NEW.producto_id, NEW.producto_nombre, -NEW.cantidad, 'venta', 'Reactivación ' || coalesce(NEW.n_referencia, ''));
    NEW.reingresado_at := null;
    NEW.stock_descontado := true;
  end if;
  return NEW;
end;
$$;

create or replace function public.fw_stock_on_delete()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if OLD.afecta_stock and coalesce(OLD.stock_descontado, false) and OLD.reingresado_at is null then
    perform public.fw_mover_stock(OLD.producto_id, OLD.producto_nombre, OLD.cantidad, 'devolucion', 'Venta eliminada ' || coalesce(OLD.n_referencia, ''));
  end if;
  return OLD;
end;
$$;

-- Los triggers de INSERT y UPDATE pasan a BEFORE (modifican NEW). DELETE sigue AFTER.
do $$
declare t record;
begin
  for t in select tgname from pg_trigger where tgrelid = 'public.ventas'::regclass and not tgisinternal
             and tgfoid in ('public.fw_stock_on_insert'::regproc, 'public.fw_stock_on_update'::regproc)
  loop
    execute format('drop trigger %I on public.ventas', t.tgname);
  end loop;
end $$;
create trigger fw_stock_insert before insert on public.ventas for each row execute function public.fw_stock_on_insert();
create trigger fw_stock_update before update of estado on public.ventas for each row execute function public.fw_stock_on_update();

-- ── Datos viejos ──
-- a) Ventas que el trigger viejo ya descontó (tienen su movimiento "Venta <ref>") pero quedaron sin marca: se marcan,
--    así "Sincronizar" no las vuelve a descontar.
update public.ventas v set stock_descontado = true
 where coalesce(v.stock_descontado, false) = false and v.afecta_stock and v.n_referencia is not null
   and exists (select 1 from public.stock_movimientos m where m.tipo = 'venta' and m.motivo in ('Venta ' || v.n_referencia, 'Venta #' || v.n_referencia));
-- b) Devueltas que el trigger viejo ya repuso al pasar a 'devuelto' (movimiento "Devolución <ref>"): NO se tocan acá,
--    para que sigan apareciendo en Recepción. Al escanearlas, la app ve ese movimiento y las marca sin volver a sumar
--    (src/lib/stockEngine.js, registrarReingresoLote).
-- c) Combos con stock propio distinto de 0 (Pack Gudair en -34): ese saldo son ventas que debieron salir de los
--    componentes. Se pasa a los componentes y el combo queda en 0 (su stock se calcula de los componentes).
do $$
declare c record;
begin
  for c in select id, nombre, stock_actual from public.productos where es_combo and stock_actual <> 0 loop
    perform public.fw_mover_stock(c.id, c.nombre, c.stock_actual, 'ajuste', 'Ajuste auditoría 12-10: saldo del combo pasado a sus componentes');
    update public.productos set stock_actual = 0 where id = c.id;
  end loop;
end $$;
