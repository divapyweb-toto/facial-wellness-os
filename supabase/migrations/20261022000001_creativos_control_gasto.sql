-- 20261022000001 · Control del gasto del libro de creativos contra el gasto por anuncio (Enrique 22-10-2026).
-- El 21-10 la carga de las 06:00 PY dejó el 19-10 en ₲3.986 (real ₲212.559) y nadie se enteró; la pausa automática del socio
-- lee este gasto. creativos-diario ahora recarga 7 días (se cura sola) y compara cada día cerrado con esta vista.
create or replace view public.creativos_control_gasto as
with c as (select fecha, sum(gasto) as creativos from public.creativos_diario group by fecha),
     g as (select fecha, sum(gasto) as anuncio_diario from public.gasto_ads_anuncio_diario where tienda = 'voltra' group by fecha)
select c.fecha, round(c.creativos) as creativos, round(g.anuncio_diario) as anuncio_diario,
  round(100.0 * abs(c.creativos - g.anuncio_diario) / nullif(g.anuncio_diario, 0), 2) as diferencia_pct,
  (g.anuncio_diario is not null and abs(c.creativos - g.anuncio_diario) > 0.02 * g.anuncio_diario) as fuera_de_rango
from c left join g using (fecha);
grant select on public.creativos_control_gasto to authenticated, service_role;
