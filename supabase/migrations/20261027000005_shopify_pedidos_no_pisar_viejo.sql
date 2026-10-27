-- 27-10 · shopify_pedidos: un webhook viejo no pisa uno nuevo y una cancelación no se borra.
-- Causa (#1092 y #1093, 23-10): pedidos-trabados cancela y etiqueta en Shopify casi juntos → Shopify manda dos
-- orders/updated; se procesan en paralelo y el MÁS VIEJO (sin cancelled_at) se guardó último y pisó al nuevo
-- (#1092: updated_at 14:43:02 procesado 17:43:12.583 sobre el de 14:43:04 con cancelled_at, procesado 17:43:12.204).
-- Comparación con la Admin API (27-10, últimos 30 días, 142 pedidos, 40 cancelados): solo #1092 y #1093 difieren.
-- Regla (para cualquier proceso que escriba la copia, en formato REST con updated_at):
--   1) si el raw nuevo tiene updated_at ANTERIOR al guardado, se conserva el guardado (raw, tags, total);
--   2) si el guardado tiene cancelled_at y el nuevo no, se conserva la cancelación (en Shopify no tiene vuelta atrás).
-- Vuelta atrás: drop trigger shopify_pedidos_no_pisar_viejo on public.shopify_pedidos; drop function public.shopify_pedidos_no_pisar_viejo();

create or replace function public.shopify_pedidos_no_pisar_viejo() returns trigger language plpgsql as $$
declare
  viejo_upd timestamptz;
  nuevo_upd timestamptz;
begin
  begin
    viejo_upd := (old.raw->>'updated_at')::timestamptz;
    nuevo_upd := (new.raw->>'updated_at')::timestamptz;
  exception when others then
    viejo_upd := null; nuevo_upd := null;
  end;
  if viejo_upd is not null and nuevo_upd is not null and nuevo_upd < viejo_upd then
    new.raw := old.raw;
    new.tags := old.tags;
    new.total := old.total;
  end if;
  if old.raw->>'cancelled_at' is not null and coalesce(new.raw->>'cancelled_at', '') = '' then
    new.raw := jsonb_set(new.raw, '{cancelled_at}', old.raw->'cancelled_at');
  end if;
  return new;
end $$;

drop trigger if exists shopify_pedidos_no_pisar_viejo on public.shopify_pedidos;
create trigger shopify_pedidos_no_pisar_viejo before update on public.shopify_pedidos
  for each row when (old.raw is not null and new.raw is not null)
  execute function public.shopify_pedidos_no_pisar_viejo();

-- Corrección de la copia: la cancelación real de Shopify (Admin API, 27-10).
update public.shopify_pedidos set raw = jsonb_set(raw, '{cancelled_at}', to_jsonb('2026-10-23T14:43:04-03:00'::text)), actualizado_en = now()
where nombre = '#1092' and raw->>'cancelled_at' is null;
update public.shopify_pedidos set raw = jsonb_set(raw, '{cancelled_at}', to_jsonb('2026-10-23T15:13:03-03:00'::text)), actualizado_en = now()
where nombre = '#1093' and raw->>'cancelled_at' is null;
