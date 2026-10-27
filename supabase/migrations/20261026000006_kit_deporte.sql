-- 20261026000006 · Kit Deporte (Botella Flexible + Tiras nasales, ₲158.000) como combo (encargo del administrador 26-10).
--  1. Producto combo en `productos` (igual que el Pack Gudair): 1 botella + 1 tiras. La venta descuenta las dos
--     (fw_mover_stock ya recorre los componentes de un combo) y stock-shopify publica lo que alcancen botellas y tiras.
--  2. Equilibrio "Kit Deporte" en config.equilibrio_producto: (158.000 − 36.230) × 80 % − flete real 32.365 ≈ 65.000
--     (misma cuenta que el resto: 80 % de entrega, sin IVA).
--  3. Los clasificadores por nombre reconocen el kit ANTES que "tiras": "kit deporte" o botella + tiras en el mismo
--     nombre. Ojo: "deport" solo no sirve (la botella pasa a llamarse "Botella Deportiva Flexible" el 29-10).
-- Volver atrás: delete from productos where nombre = 'Kit Deporte (Botella Flexible + Tiras nasales)';
--   update config set valor = (valor::jsonb - 'Kit Deporte')::text where clave = 'equilibrio_producto'; y aplicar de
--   nuevo familia_producto / creativos_dia_detalle de 20261021000002 / la vista actual sin la línea del kit.

insert into public.productos (nombre, costo_unit, precio_1u, precio_2u, precio_3u, grupo_envio, prioridad, stock_actual,
                              stock_alerta, activo, es_combo, componente_1_id, componente_1_qty, componente_2_id, componente_2_qty, tienda)
select 'Kit Deporte (Botella Flexible + Tiras nasales)', b.costo_unit + t.costo_unit, 158000, 0, 0, 'B', 'Media', 0,
       0, true, true, b.id, 1, t.id, 1, 'voltra'
from public.productos b, public.productos t
where b.nombre = 'Botella Flexible' and t.nombre = 'Tiras nasales'
  and not exists (select 1 from public.productos where nombre = 'Kit Deporte (Botella Flexible + Tiras nasales)');

update public.config set valor = (valor::jsonb || '{"Kit Deporte":65000}'::jsonb)::text, actualizado = now()
where clave = 'equilibrio_producto';

create or replace function public.familia_producto(t text) returns text language sql immutable as $$
  select case
    when t ~* 'kit ?deporte' or (t ~* 'botella' and t ~* 'tira|nasal') then 'Kit Deporte'
    when t ~* 'pack|gudair' then 'Pack'
    when t ~* 'raspador|lengua' then 'Raspador'
    when t ~* 'tira|nasal' then 'Tiras'
    when t ~* 'parche|bucal' then 'Parches'
    when t ~* 'jaw|mand[ií]bula|ejercitador' then 'JawFlex'
    when t ~* 'botella' then 'Botella'
    else 'Otros' end
$$;

-- Libro de creativos: los anuncios "KIT DEPORTE BOTELLA TIRAS" se miden contra el equilibrio del kit (antes caían en Tiras).
create or replace view public.creativos_dia_detalle as
 WITH pd AS (
         SELECT pedidos_entrega.ad_id,
            pedidos_entrega.fecha,
            count(*) AS generados,
            count(*) FILTER (WHERE pedidos_entrega.confirmado) AS confirmados,
            count(*) FILTER (WHERE pedidos_entrega.grupo = 'ENTREGADO'::text) AS entregados,
            count(*) FILTER (WHERE pedidos_entrega.grupo = 'PERDIDO'::text) AS perdidos,
            count(*) FILTER (WHERE pedidos_entrega.grupo = 'EN_GESTION'::text) AS en_gestion
           FROM pedidos_entrega
          WHERE pedidos_entrega.ad_id IS NOT NULL
          GROUP BY pedidos_entrega.ad_id, pedidos_entrega.fecha
        ), dia AS (
         SELECT d.fecha,
            d.ad_id,
            d.ad_nombre,
            d.adset_id,
            d.adset_nombre,
            d.campana_id,
            d.campana_nombre,
            d.canal,
            d.gasto,
            d.impresiones,
            d.clics,
            d.ctr,
            d.visitas,
            d.formularios,
            d.compras,
            d.conversaciones,
            d.actualizado_en,
            COALESCE(pd.generados, 0::bigint) AS pedidos,
            COALESCE(pd.confirmados, 0::bigint) AS confirmados,
            COALESCE(pd.entregados, 0::bigint) AS entregados,
            COALESCE(pd.perdidos, 0::bigint) AS perdidos,
            COALESCE(pd.en_gestion, 0::bigint) AS en_gestion
           FROM creativos_diario d
             LEFT JOIN pd USING (ad_id, fecha)
        )
 SELECT fecha,
    ad_id,
    ad_nombre,
    adset_id,
    adset_nombre,
    campana_id,
    campana_nombre,
    canal,
    gasto,
    impresiones,
    clics,
    ctr,
    visitas,
    formularios,
    compras,
    conversaciones,
    actualizado_en,
    pedidos,
    confirmados,
    entregados,
    perdidos,
    en_gestion,
        CASE
            WHEN ad_nombre ~* 'kit ?deporte'::text OR (ad_nombre ~* 'botella'::text AND ad_nombre ~* 'tira|nasal'::text) THEN 'Kit Deporte'::text
            WHEN ad_nombre ~* 'pack|gudair'::text THEN 'Pack'::text
            WHEN ad_nombre ~* 'raspador|lengua'::text THEN 'Raspador'::text
            WHEN ad_nombre ~* 'tira|nasal'::text THEN 'Tiras'::text
            WHEN ad_nombre ~* 'parche|bucal'::text THEN 'Parches'::text
            WHEN ad_nombre ~* 'jaw|mandibula|mandíbula|ejercitador'::text THEN 'JawFlex'::text
            WHEN ad_nombre ~* 'botella'::text THEN 'Botella'::text
            ELSE 'Varios'::text
        END AS producto,
    sum(gasto) OVER w3 AS gasto_3d,
    sum(pedidos) OVER w3 AS pedidos_3d,
        CASE
            WHEN canal = 'whatsapp'::text THEN
            CASE
                WHEN conversaciones > 0 THEN pedidos::numeric / conversaciones::numeric
                ELSE NULL::numeric
            END
            ELSE
            CASE
                WHEN clics > 0 THEN formularios::numeric / clics::numeric
                ELSE NULL::numeric
            END
        END AS tasa,
        CASE
            WHEN canal = 'whatsapp'::text THEN conversaciones >= 3
            ELSE clics >= 5
        END AS volumen_ok,
    count(*) FILTER (WHERE gasto > 0::numeric) OVER (PARTITION BY ad_id ORDER BY fecha) AS dia_n
   FROM dia
  WINDOW w3 AS (PARTITION BY ad_id ORDER BY fecha ROWS BETWEEN 2 PRECEDING AND CURRENT ROW);
