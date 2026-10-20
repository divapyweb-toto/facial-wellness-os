-- 20261020000002 · Flete real en las ventas de Voltra ya despachadas por PaP (Enrique 20-10-2026).
-- Tenían el fijo de 29.000 (config.flete_pap); pasan al precio de su ciudad en tarifas_courier (ganancia_neta se
-- recalcula sola: es columna generada total − costo_prod − costo_envio). Lucero ya guardaba su precio real por ciudad.
-- Ciudad fuera de la tabla → tarifa de zona y flete_estimado = true. FW no se toca.
update public.ventas v
set costo_envio = (t ->> 'precio')::int, flete_estimado = coalesce((t ->> 'estimado')::boolean, false)
from (select id, public.tarifa_courier('pap', ciudad) as t from public.ventas
      where tienda = 'voltra' and transportadora = 'pap' and costo_envio = 29000) x
where v.id = x.id and x.t is not null;

-- Equilibrio por producto: el del 19-10 asumía flete fijo de 29.000. Se le resta lo que el flete real promedio de
-- cada producto (ventas de Voltra de los últimos 30 días al 20-10, tarifas oficiales con cobranza) supera los 29.000:
--   (promedios por producto calculados en la base el 20-10; Parches tenía 1 venta → se usó el promedio general, igual que Varios).
-- Redondeado a 500.
update public.config set valor =
  '{"Raspador":57500,"Pack":46500,"Parches":44500,"Botella":41500,"Tiras":38500,"JawFlex":33000,"Varios":37500}', actualizado = now()
where clave = 'equilibrio_producto';
