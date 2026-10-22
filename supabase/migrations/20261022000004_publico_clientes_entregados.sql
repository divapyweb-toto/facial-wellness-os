-- 20261022000004 · Público para anuncios de REPOSICIÓN (Enrique 22-10-2026): compradores con al menos un pedido ENTREGADO en
-- 2026 (FW + Voltra), sacando a los que ALGUNA VEZ rechazaron o devolvieron un pedido. Solo hashes SHA-256. No toca
-- publico_excluir_rechazos (la lista de exclusión del 22-10 sigue igual).

-- Resultado de cada pedido por cliente (teléfono normalizado), de ventas y de entregas. Sin datos en claro hacia afuera:
-- la vista solo la lee service_role.
create or replace view public.clientes_resultado_entrega as
with ventas_res as (
  select public.telefono_meta(v.cliente_telefono) as tel, v.n_referencia, v.tienda, v.fecha,
    public.familia_producto(v.producto_nombre) as producto,
    case v.estado when 'entregado' then 'entregado' when 'devuelto' then 'perdido' end as resultado
  from public.ventas v
  where v.deleted_at is null and v.estado in ('entregado', 'devuelto')
), entregas_res as (
  select public.telefono_meta(coalesce(x.cliente_telefono, e.telefono_courier)) as tel, e.n_referencia, e.tienda,
    coalesce(e.fecha_entrega, e.fecha_ingreso, e.created_at::date) as fecha, public.familia_producto(coalesce(x.producto_nombre, e.producto)) as producto,
    case
      when e.estado_pap ~* '^\s*entregado' or e.categoria = 'entregado' then 'entregado'
      when (e.transportadora = 'pap' and e.estado_pap ~* 'custodi|inubicable|no gestionado|fuera de cobertura|rechaz|devoluci|devuelto|cancelad')
        or (e.transportadora = 'lucero' and e.estado_pap ~* '^\s*(devuelto|cancelado)\s*$') then 'perdido'
    end as resultado
  from public.entregas e
  left join lateral (select y.cliente_telefono, y.producto_nombre from public.ventas y
                      where y.id = e.venta_id or regexp_replace(y.n_referencia, '^(FW-|L-|WA-)', '') = regexp_replace(e.n_referencia, '^(FW-|L-|WA-)', '')
                      order by (y.id = e.venta_id) desc limit 1) x on true
)
select * from ventas_res where tel is not null and resultado is not null
union all
select * from entregas_res where tel is not null and resultado is not null;
revoke all on public.clientes_resultado_entrega from anon, authenticated;
grant select on public.clientes_resultado_entrega to service_role;

create or replace view public.publico_clientes_entregados as
with c as (
  select tel,
    bool_or(resultado = 'perdido') as alguna_vez_perdio,
    bool_or(resultado = 'entregado' and fecha >= '2026-01-01') as entregado_2026,
    bool_or(resultado = 'entregado' and fecha >= '2026-01-01' and producto = 'Parches') as compro_parches,
    bool_or(resultado = 'entregado' and fecha >= '2026-01-01' and producto = 'Tiras') as compro_tiras,
    bool_or(resultado = 'entregado' and fecha >= '2026-01-01' and producto = 'Pack') as compro_pack,
    count(distinct n_referencia) filter (where resultado = 'entregado') as pedidos_entregados,
    max(fecha) filter (where resultado = 'entregado') as ultima_entrega,
    string_agg(distinct tienda, ',') as tiendas
  from public.clientes_resultado_entrega group by tel
), em as (
  select public.telefono_meta(sp.telefono) as tel, max(nullif(lower(trim(coalesce(sp.raw ->> 'email', sp.raw ->> 'contact_email', ''))), '')) as email
  from public.shopify_pedidos sp group by 1
)
select encode(extensions.digest(c.tel, 'sha256'), 'hex') as phone_sha256,
  case when em.email is not null then encode(extensions.digest(em.email, 'sha256'), 'hex') end as email_sha256,
  c.pedidos_entregados, c.ultima_entrega, c.tiendas, c.compro_parches, c.compro_tiras, c.compro_pack
from c left join em on em.tel = c.tel
where c.entregado_2026 and not c.alguna_vez_perdio;
revoke all on public.publico_clientes_entregados from anon, authenticated;
grant select on public.publico_clientes_entregados to service_role;
