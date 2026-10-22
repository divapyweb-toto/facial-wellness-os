-- 20261022000003 · (1) Hora real de confirmación del pedido, para el evento PedidoConfirmado (web) de Meta.
--                   (2) Público para EXCLUIR de los anuncios: clientes que rechazaron o devolvieron un pedido en 2026 (Enrique 22-10-2026).

-- (1) confirmado_en: lo pone la base sola cuando el pedido pasa a 'confirmado' (lo escriban procesar-envios, el vendedor,
-- la reactivación o Despacho). Nunca falla el guardado del pedido.
alter table public.shopify_pedidos add column if not exists confirmado_en timestamptz;

create or replace function public.shopify_pedidos_confirmado_en() returns trigger language plpgsql as $$
begin
  if new.estado_confirmacion = 'confirmado' and new.confirmado_en is null
     and (tg_op = 'INSERT' or old.estado_confirmacion is distinct from 'confirmado') then
    new.confirmado_en := now();
  end if;
  return new;
end $$;
drop trigger if exists shopify_pedidos_confirmado_en on public.shopify_pedidos;
create trigger shopify_pedidos_confirmado_en before insert or update of estado_confirmacion on public.shopify_pedidos
  for each row execute function public.shopify_pedidos_confirmado_en();

-- Relleno de los últimos 10 días: la primera respuesta con botón del cliente después de crear el pedido (es como se
-- confirma); si confirmó sin botón (pedido del vendedor, que nace confirmado), la creación del pedido.
update public.shopify_pedidos sp set confirmado_en = coalesce(
  (select min(m.creado_en) from public.wa_mensajes m
    where m.cliente_id = sp.cliente_id and m.direccion = 'in' and m.tipo in ('button', 'interactive') and m.creado_en > sp.creado_en),
  sp.creado_en)
where sp.estado_confirmacion = 'confirmado' and sp.confirmado_en is null and sp.creado_en > now() - interval '10 days';

-- (2) Teléfono normalizado E.164 sin '+', como pide Meta para listas de clientes (Paraguay: 595 + número sin el 0).
create or replace function public.telefono_meta(t text) returns text language sql immutable as $$
  select case
    when d is null or length(d) < 8 then null
    when d like '595%' then d
    when d like '0%' then '595' || substr(d, 2)
    when length(d) = 9 and d like '9%' then '595' || d
    else d end
  from (select nullif(regexp_replace(coalesce(t, ''), '\D', '', 'g'), '') as d) x
$$;

-- Envíos perdidos en 2026 (FW + Voltra), con la regla de entrega por courier:
--   PaP: custodio, inubicable, no gestionado, fuera de cobertura, rechazado, devolución/devuelto, cancelado.
--   Lucero: solo devuelto o cancelado.
-- Solo hashes SHA-256 (nada en claro): sirve para subir a Meta como público personalizado de exclusión.
create or replace view public.publico_excluir_rechazos as
with perdidos as (
  select e.n_referencia, e.tienda, e.transportadora, coalesce(e.fecha_ingreso, e.created_at::date) as fecha,
    public.telefono_meta(coalesce(v.cliente_telefono, sp.telefono, e.telefono_courier)) as tel,
    nullif(lower(trim(coalesce(sp.raw ->> 'email', sp.raw ->> 'contact_email', ''))), '') as email
  from public.entregas e
  left join lateral (select x.cliente_telefono from public.ventas x
                      where x.id = e.venta_id or regexp_replace(x.n_referencia, '^(FW-|L-|WA-)', '') = regexp_replace(e.n_referencia, '^(FW-|L-|WA-)', '')
                      order by (x.id = e.venta_id) desc limit 1) v on true
  left join public.shopify_pedidos sp on e.n_referencia ~ '^VT-[0-9]+$' and sp.nombre = '#' || substr(e.n_referencia, 4)
  where coalesce(e.fecha_ingreso, e.created_at::date) >= '2026-01-01'
    and ((e.transportadora = 'pap' and e.estado_pap ~* 'custodi|inubicable|no gestionado|fuera de cobertura|rechaz|devoluci|devuelto|cancelad')
      or (e.transportadora = 'lucero' and e.estado_pap ~* '^\s*(devuelto|cancelado)\s*$'))
  union all
  -- Ventas marcadas 'devuelto' (rendiciones e importaciones viejas de FW que no quedaron en entregas con estado).
  select x.n_referencia, x.tienda, x.transportadora, x.fecha, public.telefono_meta(x.cliente_telefono), null
  from public.ventas x where x.deleted_at is null and x.estado = 'devuelto' and x.fecha >= '2026-01-01'
)
select encode(extensions.digest(tel, 'sha256'), 'hex') as phone_sha256,
  case when max(email) is not null then encode(extensions.digest(max(email), 'sha256'), 'hex') end as email_sha256,
  count(distinct n_referencia) as envios_perdidos, max(fecha) as ultima_perdida,
  string_agg(distinct tienda, ',') as tiendas
from perdidos where tel is not null
group by tel;
revoke all on public.publico_excluir_rechazos from anon, authenticated;
grant select on public.publico_excluir_rechazos to service_role;
