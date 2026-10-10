-- ═══════════════════════════════════════════════════════════
-- Blindaje SIFEN (agente P1, 10-10-2026). Idempotente: se puede correr más de una vez.
-- 1) config_wa['sifen']: datos del emisor en 'datos_emisor' (la clave que lee sifen-cola/io.ts), corte
--    facturar_desde (obligatorio al activar) y activo SIEMPRE en false (se prende a mano, con el corte cargado).
-- 2) facturas_retenidas: pedidos que NO se facturan solos (p. ej. entregados antes del corte). La pantalla
--    Facturas → "Pendientes de criterio contable" los muestra; se liberan con el criterio de la contadora.
-- 3) RPC sifen_liberar(p_origen, p_id, p_criterio): libera una retención (solo pedidos de Shopify).
-- 4) RPC sifen_retener(p_shopify_order_id, p_motivo, p_nota): la usa P2 (pedido mayorista "anterior al corte").
--
-- Ventas directas (P2) EN ESPERA por decisión de Enrique (10-10): NO se crean facturas.origen ni
-- facturas.venta_directa_id (ni FK, ni índice, ni check). Cuando se retome, va en una migración aparte:
--   alter table public.facturas add column origen text not null default 'shopify' check (origen in ('shopify','directa')),
--     add column venta_directa_id uuid references public.ventas_directas(id);
--   create unique index ... on public.facturas (venta_directa_id, ambiente) where tipo_documento = 1 and venta_directa_id is not null;
-- Producción SIFEN: esta migración no toca SIFEN_PRODUCCION_AUTORIZADA ni llama a SIFEN.
-- ═══════════════════════════════════════════════════════════

-- ─── 1. config_wa['sifen'] ───────────────────────────────────
-- Códigos geográficos verificados el 10-10-2026 contra la tabla oficial de la DNIT
-- "CÓDIGO DE REFERENCIA GEOGRÁFICA" (actualización 03-11-2025, publicada 27-01-2026; Manual Técnico v150 §15 Tabla 2.1):
--   departamento 11 ALTO PARANA · distrito 145 CIUDAD DEL ESTE · ciudad 3428 CIUDAD DEL ESTE(PLANTA URBANA).
-- Datos del emisor: Formulario 364 N.º 364010077486 (contrato P1-P2 10-10). Son los que figuran en cada KuDE.
-- Merge: lo que ya exista se conserva (salvo 'activo', que queda en false, y los datos del emisor, que se pisan
-- con los del formulario). Si alguien guardó los datos en la clave vieja 'emisor' (objeto), se corrige a 'propio'.
do $$
declare
  datos jsonb := jsonb_build_object(
    'ruc', '80177762',
    'dv', '3',
    'razonSocial', 'VOLTRA E.A.S. UNIPERSONAL',
    'nombreFantasia', 'VOLTRA',
    'tipoContribuyente', 2,
    'direccion', 'URBANIZACION PARQUE DIANA',
    'numeroCasa', '1167',
    'departamento', jsonb_build_object('codigo', 11, 'descripcion', 'ALTO PARANA'),
    'distrito', jsonb_build_object('codigo', 145, 'descripcion', 'CIUDAD DEL ESTE'),
    'ciudad', jsonb_build_object('codigo', 3428, 'descripcion', 'CIUDAD DEL ESTE(PLANTA URBANA)'),
    'telefono', '0985914500',
    'email', '',  -- el email real se carga aparte (docs/sifen-datos-privados.sql, fuera de Git)
    'actividades', jsonb_build_array(
      jsonb_build_object('codigo', '47190', 'descripcion', 'COMERCIO AL POR MENOR DE OTROS PRODUCTOS EN COMERCIOS NO ESPECIALIZADOS'),
      jsonb_build_object('codigo', '46900', 'descripcion', 'COMERCIO AL POR MAYOR NO ESPECIALIZADO')
    ),
    'establecimiento', '001',
    'punto', '001'  -- punto de expedición pendiente de confirmar con la DNIT
  );
  previo jsonb;
  nuevo jsonb;
begin
  select valor into previo from public.config_wa where clave = 'sifen';
  previo := coalesce(previo, '{}'::jsonb);
  nuevo := jsonb_build_object('activo', false, 'emisor', 'propio', 'facturar_desde', null)
           || (previo - 'emisor_datos')
           || jsonb_build_object(
                'datos_emisor', coalesce(previo -> 'emisor_datos', '{}'::jsonb)
                                || coalesce(case when jsonb_typeof(previo -> 'datos_emisor') = 'object' then previo -> 'datos_emisor' end, '{}'::jsonb)
                                || datos,
                'activo', false);
  if jsonb_typeof(nuevo -> 'emisor') is distinct from 'string' or (nuevo ->> 'emisor') not in ('propio', 'facturasend') then
    nuevo := nuevo || '{"emisor":"propio"}'::jsonb;
  end if;
  insert into public.config_wa (clave, valor) values ('sifen', nuevo)
  on conflict (clave) do update set valor = excluded.valor;
end $$;

-- ─── 2. facturas_retenidas ───────────────────────────────────
-- Una fila por pedido. Sin liberado_en: la cola, post-entrega y la llamada manual NUNCA lo facturan.
-- Liberado (sifen_liberar): lo toma la cola aunque esté fuera de la ventana de días.
create table if not exists public.facturas_retenidas (
  id                uuid primary key default gen_random_uuid(),
  shopify_order_id  bigint unique,
  motivo            text not null default 'anterior_al_corte',
  criterio          text,           -- criterio de la contadora al liberar (obligatorio para liberar)
  retenido_en       timestamptz not null default now(),
  liberado_en       timestamptz,
  liberado_por      uuid,           -- auth.uid() de quien liberó (null si fue service_role)
  nota              text
);
create index if not exists facturas_retenidas_pendientes_idx
  on public.facturas_retenidas (retenido_en desc) where liberado_en is null;
create index if not exists facturas_retenidas_liberados_idx
  on public.facturas_retenidas (liberado_en) where liberado_en is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'facturas_retenidas_liberado_con_criterio') then
    alter table public.facturas_retenidas add constraint facturas_retenidas_liberado_con_criterio
      check (liberado_en is null or length(btrim(coalesce(criterio, ''))) >= 3);
  end if;
end $$;

-- RLS: authenticated solo LEE; escribe la cola (service_role) o la RPC sifen_liberar. anon nada.
alter table public.facturas_retenidas enable row level security;
revoke all on public.facturas_retenidas from anon;
revoke insert, update, delete on public.facturas_retenidas from authenticated;
grant select on public.facturas_retenidas to authenticated;
grant all on public.facturas_retenidas to service_role;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'facturas_retenidas'
                 and policyname = 'facturas_retenidas_authenticated_lee') then
    create policy facturas_retenidas_authenticated_lee on public.facturas_retenidas
      for select to authenticated using (true);
  end if;
end $$;

-- ─── 3. RPC sifen_liberar ────────────────────────────────────
-- p_origen 'shopify': p_id = shopify_order_id. Exige criterio (≥ 3 caracteres) y deja quién y cuándo.
-- p_origen 'directa': EN ESPERA (ventas directas no implementadas) → error explícito.
create or replace function public.sifen_liberar(p_origen text, p_id text, p_criterio text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_criterio text := btrim(coalesce(p_criterio, ''));
  v_id bigint;
  r public.facturas_retenidas%rowtype;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'sifen_liberar: requiere sesión iniciada' using errcode = '42501';
  end if;
  if length(v_criterio) < 3 then
    raise exception 'sifen_liberar: falta el criterio de la contadora' using errcode = '22023';
  end if;
  if coalesce(p_origen, '') <> 'shopify' then
    raise exception 'sifen_liberar: origen % no habilitado (ventas directas en espera)', coalesce(p_origen, 'null') using errcode = '22023';
  end if;
  begin
    v_id := btrim(p_id)::bigint;
  exception when others then
    raise exception 'sifen_liberar: pedido inválido (%)', p_id using errcode = '22023';
  end;

  update public.facturas_retenidas
     set liberado_en = now(), liberado_por = auth.uid(), criterio = left(v_criterio, 2000)
   where shopify_order_id = v_id and liberado_en is null
  returning * into r;
  if not found then
    raise exception 'sifen_liberar: el pedido % no tiene una retención pendiente', v_id using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true, 'shopify_order_id', r.shopify_order_id, 'liberado_en', r.liberado_en, 'criterio', r.criterio);
end;
$$;

revoke all on function public.sifen_liberar(text, text, text) from public, anon;
grant execute on function public.sifen_liberar(text, text, text) to authenticated, service_role;

-- ─── 4. RPC sifen_retener ────────────────────────────────────
-- Para el formulario de pedidos mayoristas de P2 (casilla "ya entregado y cobrado, anterior al corte"):
-- deja el pedido retenido ANTES de que llegue a facturación. Idempotente (si ya está retenido, no cambia nada).
-- No retiene un pedido que ya tiene factura electrónica (tipo 1) de cualquier ambiente: avisa en la respuesta.
create or replace function public.sifen_retener(p_shopify_order_id bigint, p_motivo text default 'anterior_al_corte', p_nota text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_motivo text := coalesce(nullif(btrim(p_motivo), ''), 'anterior_al_corte');
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'sifen_retener: requiere sesión iniciada' using errcode = '42501';
  end if;
  if p_shopify_order_id is null then
    raise exception 'sifen_retener: falta el pedido' using errcode = '22023';
  end if;
  if exists (select 1 from public.facturas where shopify_order_id = p_shopify_order_id and tipo_documento = 1) then
    return jsonb_build_object('ok', false, 'motivo', 'el pedido ya tiene factura electrónica');
  end if;
  insert into public.facturas_retenidas (shopify_order_id, motivo, nota)
  values (p_shopify_order_id, left(v_motivo, 100), left(p_nota, 2000))
  on conflict (shopify_order_id) do nothing;
  return jsonb_build_object('ok', true, 'shopify_order_id', p_shopify_order_id);
end;
$$;

revoke all on function public.sifen_retener(bigint, text, text) from public, anon;
grant execute on function public.sifen_retener(bigint, text, text) to authenticated, service_role;
