-- Aviso "en recorrido de reparto" para PaP (Enrique 19-10-2026). Lo manda pedidos-trabados (aviso_ruta_pap.ts) cada 10 min.
-- base_hecha=false: la 1.ª corrida solo registra los pedidos que YA estaban en ruta (no se les manda nada).
insert into public.config (clave, valor) values
  ('aviso_ruta_pap', jsonb_build_object('activo', true, 'desde', now(), 'base_hecha', false)::text)
on conflict (clave) do nothing;

-- Calendario de reparto de PaP por ciudad (lo carga Enrique cuando lo consiga). Formato:
-- {"ciudades": {"Villarrica": ["mar", "vie"], "Encarnación": ["lun", "mie", "vie"]}, "actualizado": "AAAA-MM-DD"}
-- Días: lun mar mie jue vie sab. Ciudad sin cargar = sin dato (no se usa todavía para ningún aviso).
insert into public.config (clave, valor) values ('calendario_reparto_pap', '{"ciudades": {}, "actualizado": null}')
on conflict (clave) do nothing;

-- Medición: tasa de entrega de PaP (pedidos confirmados, 3 grupos) antes y después de activar el aviso.
-- Tasa = entregados ÷ (entregados + perdidos); los "en gestión" todavía no cuentan.
create or replace view public.medicion_aviso_ruta_pap as
with cfg as (select (valor::jsonb ->> 'desde')::timestamptz as desde from public.config where clave = 'aviso_ruta_pap'),
pap as (
  select pe.*, case when pe.fecha >= (select (desde at time zone 'America/Asuncion')::date from cfg) then 'despues' else 'antes' end as periodo,
    exists (select 1 from public.envios_programados ep
            where ep.clave_unica = 'courier:' || pe.shopify_order_id || ':EN_RUTA' and ep.estado = 'enviado') as recibio_aviso_ruta
  from public.pedidos_entrega pe
  where pe.transportadora = 'pap' and pe.confirmado and pe.grupo not in ('NO_SALIO')
)
select periodo, recibio_aviso_ruta,
  count(*) as pedidos,
  count(*) filter (where grupo = 'ENTREGADO') as entregados,
  count(*) filter (where grupo = 'PERDIDO') as perdidos,
  count(*) filter (where grupo = 'EN_GESTION') as en_gestion,
  round(100.0 * count(*) filter (where grupo = 'ENTREGADO') / nullif(count(*) filter (where grupo in ('ENTREGADO', 'PERDIDO')), 0), 1) as tasa_entrega
from pap group by periodo, recibio_aviso_ruta;
