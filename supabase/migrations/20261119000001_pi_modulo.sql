-- 19-11-2026 · MÓDULO DE INTELIGENCIA DE PRODUCTOS (pi_*) · agente BASE (contrato reportes/productos/CONTRATO-MODULO.md, fuera del repo).
-- Qué hace:
--   1. Crea 16 tablas pi_* (+ pi_fotos y pi_decisiones, decisión 18-11 (3)) (candidatos → fichas → evidencias → ofertas de competencia → proveedores → cotizaciones →
--      escenarios de costo → casos → experimentos → trabajos → políticas → mensajes → órdenes de compra → eventos). Dinero en enteros de
--      unidad menor (*_minor bigint) + moneda ('PYG','USD','CNY'); fechas timestamptz (UTC).
--   2. Disparador que pone actualizado_en en cada cambio; las órdenes de compra dejan cada cambio de estado en pi_eventos;
--      un mensaje no pasa a AUTHORIZED sin política vigente que permita enviar; un candidato no pasa a la etapa DECIDIR
--      con menos de 3 fotos reales (no IA), al menos 1 del proveedor.
--   6. Bucket PRIVADO de Storage pi-fotos (solo authenticated; nunca público).
--   3. RLS prendido en todas; política única "logueado hace todo"; anon y public sin ningún permiso.
--      pi_eventos y pi_decisiones solo se agregan (sin update ni delete). Autorizar campañas que envían y confirmar o
--      marcar pagada una orden: SOLO el usuario autorizado de pi_config (3b), con su sesión; nunca la clave de servicio.
--   4. Función pi_reclamar_trabajo(ejecutor, tipos, minutos): toma UN trabajo de la cola con lease (for update skip locked).
--   5. Vistas de solo lectura sobre los datos reales de Voltra (security_invoker = respetan el RLS de quien consulta):
--      pi_pedidos_voltra (un renglón por pedido, mismas definiciones que socio/consultas/base.sql + anuncio de origen),
--      pi_base_operativa (por familia y canal, 60 días de pedidos con 14+ días), pi_resultado_experimentos (A1) y
--      pi_tasa_acierto (A2).
-- No toca ninguna tabla existente: solo LEE shopify_pedidos, ventas, entregas, productos, pedidos_origen_anuncio_todos,
-- creativos_diario, gasto_ads_anuncio_diario y gasto_ads_diario. Nada ejecutable por anon.
--
-- VUELTA ATRÁS (completa, en este orden; borra los datos pi_*):
--   drop view if exists public.pi_tasa_acierto;
--   drop view if exists public.pi_resultado_experimentos;
--   drop view if exists public.pi_base_operativa;
--   drop view if exists public.pi_pedidos_voltra;
--   drop function if exists public.pi_reclamar_trabajo(text, text[], int);
--   drop policy if exists pi_fotos_storage_leer on storage.objects;
--   drop policy if exists pi_fotos_storage_subir on storage.objects;
--   drop policy if exists pi_fotos_storage_cambiar on storage.objects;
--   drop policy if exists pi_fotos_storage_borrar on storage.objects;
--   (el bucket: vaciarlo desde el panel de Storage o la API y después  delete from storage.buckets where id = 'pi-fotos';
--    Supabase no deja borrar filas de storage.objects con SQL)
--   drop table if exists public.pi_decisiones, public.pi_fotos, public.pi_eventos, public.pi_ordenes_compra, public.pi_mensajes, public.pi_politicas, public.pi_trabajos,
--     public.pi_experimentos, public.pi_casos, public.pi_escenarios_costo, public.pi_cotizaciones,
--     public.pi_proveedores, public.pi_ofertas_competencia, public.pi_evidencias, public.pi_fichas, public.pi_candidatos;
--   drop function if exists public.pi_tocar_actualizado_en();
--   drop function if exists public.pi_ordenes_compra_auditar();
--   drop function if exists public.pi_mensajes_freno_envio();
--   drop function if exists public.pi_candidatos_freno_decidir();
--   drop function if exists public.pi_politicas_solo_enrique();
--   drop function if exists public.pi_ordenes_compra_solo_enrique();
--   drop function if exists public.pi_es_enrique();
--   drop table if exists public.pi_config;

-- ───────────────────────────── 1. Tablas ─────────────────────────────

create table public.pi_candidatos (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  nombre text not null check (btrim(nombre) <> ''),
  hipotesis text,
  categoria text,
  origen text check (origen in ('demanda','producto')),
  estado text not null default 'INVESTIGAR'
    check (estado in ('INVESTIGAR','DESCARTAR','SOLICITAR_COTIZACION','PROBAR_MUESTRA','PROBAR_OFERTA','REORDENAR','ESCALAR')),
  familia_producto text,          -- familia de productos (familia_producto()) si ya se vende
  siguiente_accion text,
  notas text,
  demo boolean not null default false,
  -- etapa del embudo de Importaciones (decisión 18-11 (3)); estado sigue siendo la recomendación de investigación
  etapa text not null default 'SUGERIDO'
    check (etapa in ('SUGERIDO','INVESTIGADO','COTIZADO','MUESTRA','EN_PRUEBA','DECIDIR','IMPORTADO','DESCARTADO'))
);

create table public.pi_fichas (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  candidato_id uuid not null references public.pi_candidatos(id) on delete cascade,
  version int not null check (version > 0),
  spec jsonb not null check (jsonb_typeof(spec) = 'object'),
  unique (candidato_id, version)
);

create table public.pi_evidencias (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  candidato_id uuid not null references public.pi_candidatos(id) on delete cascade,
  tipo text not null check (tipo in ('observed','supplier_claim','estimated','hypothesis','unknown')),
  campo text not null check (btrim(campo) <> ''),   -- ej. 'precio_minorista', 'dias_activo_anuncio' (A8)
  valor text,
  moneda text check (moneda in ('PYG','USD','CNY')),
  fuente_url text check (fuente_url is null or fuente_url ~* '^https?://'),
  fuente_entidad text,
  observado_en timestamptz,
  valido_hasta timestamptz,
  variante text,
  captura_ref text,
  cobertura text,
  cargado_por text
);

create table public.pi_ofertas_competencia (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  candidato_id uuid not null references public.pi_candidatos(id) on delete cascade,
  vendedor text,
  vendedor_clave text,            -- para deduplicar el mismo vendedor en varias fuentes
  comparacion text check (comparacion in ('identico','equivalente','sustituto')),
  zona text check (zona in ('CDE','GRAN_ASUNCION','INTERIOR','NACIONAL','DESCONOCIDA')),
  precio_minor bigint check (precio_minor >= 0),
  moneda text not null default 'PYG' check (moneda in ('PYG','USD','CNY')),
  tipo_precio text,
  incluye_envio boolean,
  url text check (url is null or url ~* '^https?://'),
  observado_en timestamptz,
  evidencia_id uuid references public.pi_evidencias(id) on delete set null
);

create table public.pi_proveedores (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  plataforma text not null check (plataforma in ('alibaba','1688','local','otro')),
  id_externo text,
  razon_social_declarada text,
  url text check (url is null or url ~* '^https?://'),
  riesgos text,
  notas text
);

create table public.pi_cotizaciones (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  candidato_id uuid not null references public.pi_candidatos(id) on delete cascade,
  proveedor_id uuid references public.pi_proveedores(id) on delete set null,
  ficha_version int check (ficha_version > 0),
  variante text,
  moneda text check (moneda in ('PYG','USD','CNY')),
  escalones jsonb check (escalones is null or jsonb_typeof(escalones) = 'array'),  -- [{cantidad, precio_unit_minor}]
  moq int check (moq > 0),
  incoterm text,
  lugar text,
  incluye_envio text,
  plazo_dias int check (plazo_dias >= 0),
  valida_hasta timestamptz,
  costo_muestra_minor bigint check (costo_muestra_minor >= 0),
  peso_bruto_g int check (peso_bruto_g >= 0),
  unidades_por_caja int check (unidades_por_caja > 0),
  medidas_caja_cm text,
  tipo text not null check (tipo in ('firme','escaparate','estimada')),  -- escaparate NUNCA es firme
  evidencia_id uuid references public.pi_evidencias(id) on delete set null
);

create table public.pi_escenarios_costo (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  candidato_id uuid not null references public.pi_candidatos(id) on delete cascade,
  nombre text,
  version int not null default 1 check (version > 0),
  entradas jsonb not null check (jsonb_typeof(entradas) = 'object'),
  resultado jsonb,
  calculado_en timestamptz
);

create table public.pi_casos (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  candidato_id uuid not null references public.pi_candidatos(id) on delete cascade,
  segmento text,
  oferta text,
  canal text check (canal in ('whatsapp','web','mayorista','complemento')),
  precio_prueba_minor bigint check (precio_prueba_minor >= 0),
  escenario_ids uuid[],
  rubrica jsonb,
  bloqueos jsonb,
  decision text,
  version int not null default 1 check (version > 0)
);

create table public.pi_experimentos (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  candidato_id uuid not null references public.pi_candidatos(id) on delete cascade,
  hipotesis text,
  presupuesto_minor bigint check (presupuesto_minor >= 0),
  perdida_maxima_minor bigint check (perdida_maxima_minor >= 0),
  metricas jsonb,
  ventana_desde date,
  ventana_hasta date,
  criterio_cierre text,
  estado text not null default 'PLANEADO' check (estado in ('PLANEADO','EN_CURSO','CERRADO')),
  resultado jsonb,
  -- A1 (ampliación 18-11): atribución automática con los anuncios de Meta o, si no hay, por familia y canal.
  meta_adset_ids text[],
  meta_ad_ids text[],
  familia_producto text,
  canal text check (canal in ('WA','Web')),   -- solo para la atribución por familia; null = los dos canales
  check (ventana_hasta is null or ventana_desde is null or ventana_hasta >= ventana_desde)
);

create table public.pi_trabajos (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  tipo text not null check (tipo in ('investigar_py','buscar_proveedores','cotizar','analizar')),
  candidato_id uuid references public.pi_candidatos(id) on delete cascade,
  carga jsonb,
  estado text not null default 'QUEUED'
    check (estado in ('QUEUED','LEASED','RUNNING','SUCCEEDED','BLOCKED','WAITING_REPLY','FAILED','CANCELLED')),
  intento int not null default 0 check (intento >= 0),
  lease_hasta timestamptz,
  ejecutor text,
  checkpoint jsonb,
  bloqueo text,
  resultado jsonb,
  check (estado not in ('LEASED','RUNNING') or lease_hasta is not null)
);

create table public.pi_politicas (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  candidato_id uuid references public.pi_candidatos(id) on delete cascade,
  alcance jsonb,                  -- producto, proveedores máx. (5), rondas máx. (2), seguimiento, escalones, vigencia (14 días)
  permite_envio boolean not null default false,
  vigente_hasta timestamptz,
  autorizada_por text,
  autorizada_en timestamptz,
  autorizada_texto text,          -- lo que escribió Enrique al autorizar la campaña, textual (decisión 18-11 (2))
  -- una política que permite enviar tiene que decir quién, cuándo y con qué palabras la autorizó
  check (not permite_envio or (autorizada_por is not null and autorizada_en is not null
                               and autorizada_texto is not null and btrim(autorizada_texto) <> ''))
);

create table public.pi_mensajes (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  -- restrict (no cascade): borrar una política no puede borrar el rastro de un mensaje (evita reenvíos a ciegas)
  politica_id uuid not null references public.pi_politicas(id) on delete restrict,
  proveedor_id uuid references public.pi_proveedores(id) on delete restrict,
  estado text not null default 'DRAFT'
    check (estado in ('DRAFT','AUTHORIZED','SENDING','SENT_CONFIRMED','SEND_UNKNOWN','FAILED')),
  idempotencia text unique,
  original text,
  traduccion text,
  idioma text
);

create table public.pi_ordenes_compra (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  -- restrict (no cascade): una orden de compra es un registro de plata; borrar el candidato no la puede borrar
  candidato_id uuid not null references public.pi_candidatos(id) on delete restrict,
  proveedor_id uuid references public.pi_proveedores(id) on delete restrict,
  cotizacion_id uuid references public.pi_cotizaciones(id) on delete set null,
  plataforma text check (plataforma in ('alibaba','1688','local','otro')),
  variante text,
  cantidad int not null check (cantidad > 0),
  precio_unit_minor bigint check (precio_unit_minor >= 0),
  envio_minor bigint check (envio_minor >= 0),
  total_minor bigint check (total_minor >= 0),
  moneda text not null check (moneda in ('PYG','USD','CNY')),
  deposito_destino text,          -- 1688 no envía al exterior: depósito en China de un agente/forwarder
  forwarder text,
  estado text not null default 'BORRADOR'
    check (estado in ('BORRADOR','CONFIRMADA_POR_ENRIQUE','PEDIDA','PAGADA_POR_ENRIQUE','EN_TRANSITO','RECIBIDA','CANCELADA')),
  confirmada_texto text,          -- lo que escribió Enrique al confirmar producto y total
  confirmada_en timestamptz,
  tracking text,
  notas text,
  -- pasada de BORRADOR (salvo cancelarla) solo con la confirmación textual de Enrique y su fecha
  check (estado in ('BORRADOR','CANCELADA') or (confirmada_texto is not null and btrim(confirmada_texto) <> '' and confirmada_en is not null))
);

create table public.pi_fotos (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  candidato_id uuid not null references public.pi_candidatos(id) on delete cascade,
  storage_path text,              -- ruta dentro del bucket privado pi-fotos
  url_externa text check (url_externa is null or url_externa ~* '^https?://'),
  fuente text not null check (fuente in ('proveedor','muestra','propia','ia_referencia')),
  es_principal boolean not null default false,
  orden int not null default 0,
  descripcion text,
  check (storage_path is not null or url_externa is not null)
);

create table public.pi_decisiones (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  -- restrict (no cascade): una decisión de Enrique queda registrada; borrar el candidato no la puede borrar
  candidato_id uuid not null references public.pi_candidatos(id) on delete restrict,
  decision text not null check (decision in ('IMPORTAR','MUESTRA','RENEGOCIAR','DESCARTAR')),
  texto_enrique text not null check (btrim(texto_enrique) <> ''),
  motivo text,
  snapshot jsonb,                 -- los números al momento de decidir
  check (decision <> 'DESCARTAR' or (motivo is not null and btrim(motivo) <> ''))   -- descartar pide el motivo
);

create table public.pi_eventos (
  id uuid primary key default gen_random_uuid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  entidad text not null,
  entidad_id uuid,
  accion text not null,
  detalle jsonb,
  actor text
);

-- Índices útiles
create index pi_fichas_candidato_idx on public.pi_fichas (candidato_id);
create index pi_evidencias_candidato_idx on public.pi_evidencias (candidato_id, campo);
create index pi_ofertas_candidato_idx on public.pi_ofertas_competencia (candidato_id, vendedor_clave);
create unique index pi_proveedores_externo_uq on public.pi_proveedores (plataforma, id_externo) where id_externo is not null;
create index pi_cotizaciones_candidato_idx on public.pi_cotizaciones (candidato_id);
create index pi_cotizaciones_proveedor_idx on public.pi_cotizaciones (proveedor_id);
create index pi_escenarios_candidato_idx on public.pi_escenarios_costo (candidato_id, version);
create index pi_casos_candidato_idx on public.pi_casos (candidato_id);
create index pi_experimentos_candidato_idx on public.pi_experimentos (candidato_id);
create index pi_trabajos_cola_idx on public.pi_trabajos (estado, creado_en) where estado in ('QUEUED','LEASED','RUNNING');
create index pi_trabajos_candidato_idx on public.pi_trabajos (candidato_id);
create index pi_politicas_candidato_idx on public.pi_politicas (candidato_id);
create index pi_mensajes_politica_idx on public.pi_mensajes (politica_id);
create index pi_ordenes_candidato_idx on public.pi_ordenes_compra (candidato_id, estado);
create index pi_fotos_candidato_idx on public.pi_fotos (candidato_id, orden);
create unique index pi_fotos_una_principal_uq on public.pi_fotos (candidato_id) where es_principal;
create index pi_decisiones_candidato_idx on public.pi_decisiones (candidato_id, creado_en);
create index pi_candidatos_etapa_idx on public.pi_candidatos (etapa);
create index pi_eventos_entidad_idx on public.pi_eventos (entidad, entidad_id, creado_en);

-- ───────────────────── 2. Disparador actualizado_en ─────────────────────

create function public.pi_tocar_actualizado_en()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;
revoke all on function public.pi_tocar_actualizado_en() from public, anon, authenticated;

-- ─────────────── 3. Disparador + RLS + permisos en cada tabla ───────────────
do $$
declare t text;
begin
  foreach t in array array['pi_candidatos','pi_fichas','pi_evidencias','pi_ofertas_competencia','pi_proveedores',
    'pi_cotizaciones','pi_escenarios_costo','pi_casos','pi_experimentos','pi_trabajos','pi_politicas','pi_mensajes','pi_ordenes_compra','pi_fotos','pi_decisiones','pi_eventos']
  loop
    execute format('create trigger %I before update on public.%I for each row execute function public.pi_tocar_actualizado_en()',
                   t || '_actualizado_en', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)',
                   t || '_logueado', t);
    execute format('revoke all on table public.%I from anon, public', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- Auditoría inalterable (revisión adversarial 18-11, hallazgo 5): pi_eventos y pi_decisiones solo se agregan, no se editan
-- ni se borran (ni desde la web ni con la clave de servicio).
revoke update, delete on public.pi_eventos, public.pi_decisiones from authenticated, service_role;

-- ─────────────── 3b. Quién es Enrique (revisión adversarial 18-11, hallazgo 4) ───────────────
-- Autorizar una campaña que permite enviar mensajes y confirmar o marcar pagada una orden de compra lo puede hacer SOLO
-- el usuario autorizado, con su sesión en la web. La base lo identifica por su id de usuario guardado en pi_config
-- (NO por correo ni id en el código: el repo es público). pi_config no la puede leer ni escribir la web ni la clave de
-- servicio: se carga una vez con SQL del dueño de la base, fuera del repo:
--   update public.pi_config set valor = '<id de auth.users de Enrique>', actualizado_en = now() where clave = 'usuario_autorizado';
-- Sin esa fila cargada, nadie puede autorizar (falla cerrado). La clave de servicio (CLI) no tiene usuario: nunca pasa.
create table public.pi_config (
  clave text primary key,
  valor text,
  actualizado_en timestamptz not null default now()
);
alter table public.pi_config enable row level security;
revoke all on table public.pi_config from public, anon, authenticated, service_role;
insert into public.pi_config (clave, valor) values ('usuario_autorizado', null);

create function public.pi_es_enrique()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (select 1 from public.pi_config c where c.clave = 'usuario_autorizado' and c.valor = auth.uid()::text)
$$;
revoke all on function public.pi_es_enrique() from public, anon;
grant execute on function public.pi_es_enrique() to authenticated, service_role;

-- Políticas: prender permite_envio, o cambiar alcance/vigencia/candidato/texto de una política que permite enviar,
-- solo Enrique. Apagarla lo puede hacer cualquiera (frenar siempre está permitido). Quién y cuándo los pone la base.
create function public.pi_politicas_solo_enrique()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.permite_envio and (tg_op = 'INSERT' or not old.permite_envio
      or new.alcance is distinct from old.alcance or new.vigente_hasta is distinct from old.vigente_hasta
      or new.candidato_id is distinct from old.candidato_id or new.autorizada_texto is distinct from old.autorizada_texto
      or new.autorizada_por is distinct from old.autorizada_por or new.autorizada_en is distinct from old.autorizada_en) then
    if not public.pi_es_enrique() then
      raise exception 'pi_politicas: solo Enrique, con su sesión en Voltra OS, puede autorizar una campaña que envía mensajes'
        using errcode = 'insufficient_privilege';
    end if;
    new.autorizada_por := 'usuario:' || auth.uid()::text;
    new.autorizada_en := now();
  end if;
  return new;
end;
$$;
revoke all on function public.pi_politicas_solo_enrique() from public, anon, authenticated;
create trigger pi_politicas_solo_enrique before insert or update on public.pi_politicas
  for each row execute function public.pi_politicas_solo_enrique();

-- Órdenes de compra: sacar una orden de BORRADOR (salvo cancelarla), marcarla PAGADA_POR_ENRIQUE, o cambiar plata,
-- cantidad, proveedor o texto de confirmación de una orden ya confirmada, solo Enrique. Los pasos logísticos
-- (PEDIDA, EN_TRANSITO, RECIBIDA) y cancelar quedan para el CLI. confirmada_en la pone la base.
create function public.pi_ordenes_compra_solo_enrique()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare necesita boolean := false;
begin
  if new.estado not in ('BORRADOR','CANCELADA') and (tg_op = 'INSERT' or old.estado in ('BORRADOR','CANCELADA')) then
    necesita := true;
    new.confirmada_en := now();
  elsif new.estado = 'PAGADA_POR_ENRIQUE' and (tg_op = 'INSERT' or old.estado is distinct from 'PAGADA_POR_ENRIQUE') then
    necesita := true;
  elsif tg_op = 'UPDATE' and old.estado not in ('BORRADOR','CANCELADA') and new.estado <> 'CANCELADA'
      and (new.cantidad, new.precio_unit_minor, new.envio_minor, new.total_minor, new.moneda, new.proveedor_id,
           new.cotizacion_id, new.variante, new.confirmada_texto, new.confirmada_en)
          is distinct from
          (old.cantidad, old.precio_unit_minor, old.envio_minor, old.total_minor, old.moneda, old.proveedor_id,
           old.cotizacion_id, old.variante, old.confirmada_texto, old.confirmada_en) then
    necesita := true;
  end if;
  if necesita and not public.pi_es_enrique() then
    raise exception 'pi_ordenes_compra: confirmar, marcar pagada o cambiar una orden confirmada lo hace solo Enrique, con su sesión en Voltra OS'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
revoke all on function public.pi_ordenes_compra_solo_enrique() from public, anon, authenticated;
create trigger pi_ordenes_compra_solo_enrique before insert or update on public.pi_ordenes_compra
  for each row execute function public.pi_ordenes_compra_solo_enrique();

-- Freno de envíos: un mensaje solo pasa a AUTHORIZED o SENDING (o a SENT_CONFIRMED sin venir de SENDING) si su política
-- permite enviar y está vigente (vigente_hasta futura). Si no, el cambio se rechaza y el mensaje queda como estaba.
-- El control fino del alcance (proveedores, rondas) lo hace el CLI; esto es la última barrera en la base.
create function public.pi_mensajes_freno_envio()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Se revisa la política en TODO paso a AUTHORIZED o SENDING (y en el cambio de política de un mensaje ya autorizado),
  -- y en SENT_CONFIRMED salvo que venga de SENDING (registrar el resultado de un envío ya empezado).
  if (new.estado in ('AUTHORIZED','SENDING')
        and (tg_op = 'INSERT' or new.estado is distinct from old.estado or new.politica_id is distinct from old.politica_id))
     or (new.estado = 'SENT_CONFIRMED' and (tg_op = 'INSERT' or old.estado <> 'SENDING')) then
    if not exists (select 1 from public.pi_politicas p
                    where p.id = new.politica_id and p.permite_envio
                      and p.vigente_hasta is not null and p.vigente_hasta > now()) then
      raise exception 'pi_mensajes: la política % no permite enviar o no está vigente; el mensaje queda en %',
        new.politica_id, case when tg_op = 'INSERT' then 'DRAFT' else old.estado end
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.pi_mensajes_freno_envio() from public, anon, authenticated;
create trigger pi_mensajes_freno_envio before insert or update on public.pi_mensajes
  for each row execute function public.pi_mensajes_freno_envio();

-- Freno de etapa (decisión 18-11 (3)): un candidato no pasa a DECIDIR con menos de 3 fotos reales (las de IA de
-- referencia no cuentan) y al menos 1 del proveedor. Solo mira el paso a DECIDIR (alta o cambio de etapa).
create function public.pi_candidatos_freno_decidir()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare n_reales int; n_proveedor int;
begin
  if new.etapa = 'DECIDIR' and (tg_op = 'INSERT' or old.etapa is distinct from 'DECIDIR') then
    select count(*) filter (where fuente <> 'ia_referencia'), count(*) filter (where fuente = 'proveedor')
      into n_reales, n_proveedor
      from public.pi_fotos where candidato_id = new.id;
    if n_reales < 3 or n_proveedor < 1 then
      raise exception 'pi_candidatos: para pasar a DECIDIR hacen falta 3 fotos reales (hay %) y al menos 1 del proveedor (hay %)',
        n_reales, n_proveedor using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.pi_candidatos_freno_decidir() from public, anon, authenticated;
create trigger pi_candidatos_freno_decidir before insert or update on public.pi_candidatos
  for each row execute function public.pi_candidatos_freno_decidir();

-- Auditoría de órdenes de compra: cada alta y cada cambio de estado queda en pi_eventos (quién, de qué a qué, total).
create function public.pi_ordenes_compra_auditar()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.estado is distinct from old.estado then
    insert into public.pi_eventos (entidad, entidad_id, accion, detalle, actor)
    values ('pi_ordenes_compra', new.id, 'estado:' || new.estado,
            jsonb_build_object('de', case when tg_op = 'UPDATE' then old.estado end, 'a', new.estado,
                               'total_minor', new.total_minor, 'moneda', new.moneda, 'confirmada_texto', new.confirmada_texto),
            coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', current_user));
  end if;
  return new;
end;
$$;
revoke all on function public.pi_ordenes_compra_auditar() from public, anon, authenticated;
create trigger pi_ordenes_compra_auditar after insert or update on public.pi_ordenes_compra
  for each row execute function public.pi_ordenes_compra_auditar();

-- ───────────────────── 4. Cola: reclamar un trabajo ─────────────────────
-- Toma UN trabajo QUEUED, o LEASED/RUNNING con el lease vencido (el ejecutor murió sin cerrar: el heartbeat del CLI
-- renueva lease_hasta mientras trabaja). Lo pone LEASED, con lease_hasta = ahora + p_lease_min (1 a 240 min),
-- intento + 1 y el ejecutor. skip locked: dos ejecutores a la vez nunca reciben el mismo trabajo.
-- p_tipos null o vacío = cualquier tipo. security invoker: corre con los permisos de quien llama (RLS aplica).
create function public.pi_reclamar_trabajo(p_ejecutor text, p_tipos text[] default null, p_lease_min int default 15)
returns setof public.pi_trabajos
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_ejecutor is null or btrim(p_ejecutor) = '' then
    raise exception 'pi_reclamar_trabajo: falta p_ejecutor';
  end if;
  return query
  update public.pi_trabajos t
     set estado = 'LEASED',
         lease_hasta = now() + make_interval(mins => greatest(1, least(coalesce(p_lease_min, 15), 240))),
         intento = t.intento + 1,
         ejecutor = p_ejecutor
   where t.id = (
     select c.id
       from public.pi_trabajos c
      where (c.estado = 'QUEUED' or (c.estado in ('LEASED','RUNNING') and c.lease_hasta < now()))
        and (p_tipos is null or cardinality(p_tipos) = 0 or c.tipo = any(p_tipos))
      order by c.creado_en, c.id
      limit 1
      for update skip locked
   )
  returning t.*;
end;
$$;
revoke all on function public.pi_reclamar_trabajo(text, text[], int) from public, anon;
grant execute on function public.pi_reclamar_trabajo(text, text[], int) to authenticated, service_role;

-- ───────────────────── 5. Vistas sobre datos reales ─────────────────────

-- 5a. Un renglón por pedido de Voltra. Pedido válido, canal (por tags), familia principal (Raspador manda en mixtos),
-- costo, flete y estado final: IGUAL que socio/consultas/base.sql y ctrl-entrega.sql (18-11-2026).
-- confirmado: misma regla que pedidos_entrega ('confirmado' o 'cancelado_cliente' = confirmó y después canceló).
-- ad_id / adset_id: mismo criterio que pedidos_entrega (WA: último anuncio del chat; web: UTM content = ID o nombre).
create view public.pi_pedidos_voltra with (security_invoker = true) as
with pedidos as (
  select p.shopify_order_id oid, p.nombre,
    'VT-' || regexp_replace(p.nombre, '\D', '', 'g') ref,
    (p.creado_en at time zone 'America/Asuncion')::date fecha,
    case when 'ORIGEN_WHATSAPP' = any(p.tags) then 'WA' else 'Web' end canal,
    p.total::bigint ticket,
    (p.raw->>'cancelled_at') is not null cancelado,
    coalesce(p.estado_confirmacion, 'pendiente') estado_confirmacion,
    p.estado_envio, p.tags, p.raw
  from public.shopify_pedidos p
  where not p.es_borrador
    and p.nombre !~* 'prueba'
    and not exists (select 1 from unnest(p.tags) t where upper(t) like '%PRUEBA%' or upper(t) like 'REEMPLAZADO%')
),
lineas as (
  select q.oid, public.familia_producto(li->>'title') fam, sum((li->>'quantity')::int) u, min(ord) ord
  from pedidos q, jsonb_array_elements(q.raw->'line_items') with ordinality as x(li, ord) group by 1, 2
),
costos as (select public.familia_producto(nombre) fam, max(costo_unit) costo from public.productos where activo group by 1),
pp as (
  select l.oid,
    coalesce(max(l.fam) filter (where l.fam = 'Raspador'), (array_agg(l.fam order by l.ord))[1]) familia,
    count(*) > 1 es_mixto,
    sum(l.u)::int unidades_total,
    sum(l.u * c.costo)::bigint costo_total,
    coalesce(sum(l.u) filter (where l.fam = 'Raspador'), (array_agg(l.u order by l.ord))[1])::int unidades_principal
  from lineas l join costos c using (fam) group by 1
),
ven as (
  select n_referencia ref, max(estado) estado, sum(costo_envio)::bigint flete
  from public.ventas where tienda = 'voltra' and deleted_at is null group by 1
),
-- Una fila por referencia: con reingresos puede haber varias filas; se agrupa (antes: limit 1 sin orden = al azar).
ent as (
  select n_referencia ref,
    bool_or(categoria = 'entregado') entregado,
    bool_or(categoria = 'devuelto') devuelto,
    bool_and(categoria = 'no_despachado') solo_borrador
  from public.entregas where tienda = 'voltra' group by 1
),
anuncio as (
  select o.shopify_order_id oid,
    coalesce(
      case when o.origen = 'whatsapp' then o.anuncio_wa end,
      case when o.utm_content ~ '^\d{10,}$' then o.utm_content end,
      (select c.ad_id from public.creativos_diario c where c.ad_nombre = o.utm_content order by c.fecha desc limit 1)
    ) ad_id,
    o.adset_id_utm
  from public.pedidos_origen_anuncio_todos o
)
select q.oid shopify_order_id, q.nombre, q.ref, q.fecha, q.canal, q.ticket, q.cancelado, q.estado_confirmacion,
  q.estado_confirmacion in ('confirmado', 'cancelado_cliente') confirmado,
  pp.familia, pp.es_mixto, pp.unidades_total, pp.unidades_principal, pp.costo_total,
  v.flete,
  case
    when v.ref is null and e.ref is null and q.cancelado then 'cancelado_antes'
    when v.estado = 'entregado' or e.entregado or q.estado_envio = 'ENTREGADO' then 'entregado'
    when v.estado = 'devuelto' or e.devuelto then 'devuelto'
    when v.ref is null then 'sin_despachar'
    when e.solo_borrador then 'guia_borrador'
    else 'en_transito'
  end estado_final,
  a.ad_id,
  coalesce(a.adset_id_utm,
    (select g.adset_id from public.gasto_ads_anuncio_diario g where g.ad_id = a.ad_id order by g.fecha desc limit 1),
    (select c.adset_id from public.creativos_diario c where c.ad_id = a.ad_id order by c.fecha desc limit 1)) adset_id
from pedidos q
join pp using (oid)
left join ven v on v.ref = q.ref
left join ent e on e.ref = q.ref
left join anuncio a on a.oid = q.oid;

comment on view public.pi_pedidos_voltra is
  'Un renglón por pedido válido de Voltra (definiciones de socio/consultas/base.sql). Solo lectura. Módulo pi_.';

-- 5b. Base operativa por familia y canal: cohorte de 60 días de pedidos con 14+ días (madura para la entrega).
-- ventana = [hoy PY − 73, hoy PY − 14]. Bases (NO son la misma, por eso van los conteos):
--   pct_cancelado_antes_despacho = no salieron (cancelado_antes + sin_despachar) ÷ pedidos
--   pct_entregado / pct_devuelto = entregados (o devueltos) ÷ resueltos (entregados + devueltos), igual que ctrl-entrega.sql
--   ticket_prom y flete_prom = promedio de los pedidos que salieron (flete solo si está cargado y > 0)
--   costo_producto_unit = max(costo_unit) de productos activos de la familia (como base.sql)
-- Porcentajes en escala 0-100. Para ramas del motor por pedido iniciado: cancelado = c; entregado ≈ (1−c)·e; devuelto ≈ (1−c)·d.
create view public.pi_base_operativa with (security_invoker = true) as
with v as (
  select ((now() at time zone 'America/Asuncion')::date - 73) desde,
         ((now() at time zone 'America/Asuncion')::date - 14) hasta
),
costos as (select public.familia_producto(nombre) fam, max(costo_unit) costo from public.productos where activo group by 1),
r as (
  select p.*, (p.estado_final in ('cancelado_antes', 'sin_despachar')) no_salio
  from public.pi_pedidos_voltra p, v
  where p.fecha between v.desde and v.hasta
)
select r.familia, r.canal,
  count(*)::int pedidos,
  round(avg(r.ticket) filter (where not r.no_salio))::bigint ticket_prom,
  round(100.0 * count(*) filter (where r.no_salio) / count(*), 1) pct_cancelado_antes_despacho,
  round(100.0 * count(*) filter (where r.estado_final = 'entregado')
        / nullif(count(*) filter (where r.estado_final in ('entregado', 'devuelto')), 0), 1) pct_entregado,
  round(100.0 * count(*) filter (where r.estado_final = 'devuelto')
        / nullif(count(*) filter (where r.estado_final in ('entregado', 'devuelto')), 0), 1) pct_devuelto,
  round(avg(r.flete) filter (where not r.no_salio and r.flete > 0))::bigint flete_prom,
  max(c.costo)::bigint costo_producto_unit,
  min(v.desde) ventana_desde,
  min(v.hasta) ventana_hasta,
  count(*) filter (where r.estado_final in ('entregado', 'devuelto'))::int resueltos,
  count(*) filter (where r.estado_final in ('en_transito', 'guia_borrador'))::int sin_resolver,
  -- confirmados de Voltra ÷ pedidos (incluye a los que confirmaron y después cancelaron): base del costo por confirmado.
  -- NO es 100 − pct_cancelado_antes_despacho (eso es la tasa de despacho). Revisión adversarial 18-11, hallazgo 3.
  round(100.0 * count(*) filter (where r.confirmado) / count(*), 1) pct_confirmado
from r cross join v
left join costos c on c.fam = r.familia
group by r.familia, r.canal;

comment on view public.pi_base_operativa is
  'Por familia y canal (WA/Web): 60 días de pedidos con 14+ días. pct_cancelado sobre pedidos; pct_entregado/devuelto sobre resueltos. Módulo pi_.';

-- 5c. A1 · Resultado de cada experimento con los pedidos reales atribuidos.
-- Atribución: si el experimento tiene meta_ad_ids o meta_adset_ids → pedidos cuyo anuncio o conjunto está en la lista;
-- si no, por familia_producto (familia principal del pedido) y canal (null = los dos). Sin ninguno → 'sin_criterio' (0).
-- Ventana: ventana_desde → ventana_hasta (o hoy PY). Gasto (PYG, solo tienda voltra): gasto_ads_diario de los conjuntos
-- + gasto_ads_anuncio_diario de los anuncios cuyo conjunto NO está ya en la lista (no se cuenta dos veces). Sin anuncios
-- = gasto desconocido (null), nunca 0.
-- Ganador (criterio de Voltra): ≥ 30 confirmados en los primeros 30 días a ≤ ₲35.000 por confirmado.
--   true/false solo con gasto conocido y con la prueba CERRADA o los 30 días cumplidos; si no, null (todavía no se sabe).
create view public.pi_resultado_experimentos with (security_invoker = true) as
with hoy as (select (now() at time zone 'America/Asuncion')::date d),
e as (
  select x.*,
    coalesce(cardinality(x.meta_ad_ids), 0) + coalesce(cardinality(x.meta_adset_ids), 0) > 0 con_anuncios,
    least(coalesce(x.ventana_hasta, hoy.d), hoy.d) hasta_ef,
    least(x.ventana_desde + 29, coalesce(x.ventana_hasta, x.ventana_desde + 29), hoy.d) hasta_30
  from public.pi_experimentos x, hoy
),
ped as materialized (
  select * from public.pi_pedidos_voltra
  where fecha >= coalesce((select min(ventana_desde) from public.pi_experimentos), 'infinity'::date)
),
m as (
  select e.id,
    count(p.*) filter (where not p.cancelado)::int pedidos_validos,
    count(p.*) filter (where p.confirmado)::int confirmados,
    count(p.*) filter (where p.estado_final = 'entregado')::int entregados,
    count(p.*) filter (where p.estado_final = 'devuelto')::int devueltos,
    count(p.*) filter (where p.estado_final in ('en_transito', 'guia_borrador'))::int sin_resolver,
    coalesce(sum(p.unidades_total) filter (where not p.cancelado), 0)::int unidades,
    count(p.*) filter (where p.confirmado and p.fecha <= e.hasta_30)::int confirmados_30d
  from e
  left join ped p
    on e.ventana_desde is not null
   and p.fecha between e.ventana_desde and e.hasta_ef
   and case
         when e.con_anuncios then
           p.ad_id = any(coalesce(e.meta_ad_ids, '{}')) or p.adset_id = any(coalesce(e.meta_adset_ids, '{}'))
         when e.familia_producto is not null then
           p.familia = e.familia_producto and (e.canal is null or p.canal = e.canal)
         else false
       end
  group by e.id
),
g as (
  select e.id,
    case when e.con_anuncios and e.ventana_desde is not null then
      coalesce((select sum(d.gasto) from public.gasto_ads_diario d
                 where d.tienda = 'voltra' and d.adset_id = any(coalesce(e.meta_adset_ids, '{}'))
                   and d.fecha between e.ventana_desde and e.hasta_ef), 0)
    + coalesce((select sum(a.gasto) from public.gasto_ads_anuncio_diario a
                 where a.tienda = 'voltra' and a.ad_id = any(coalesce(e.meta_ad_ids, '{}'))
                   and not (coalesce(a.adset_id, '') = any(coalesce(e.meta_adset_ids, '{}')))
                   and a.fecha between e.ventana_desde and e.hasta_ef), 0)
    end gasto,
    case when e.con_anuncios and e.ventana_desde is not null then
      coalesce((select sum(d.gasto) from public.gasto_ads_diario d
                 where d.tienda = 'voltra' and d.adset_id = any(coalesce(e.meta_adset_ids, '{}'))
                   and d.fecha between e.ventana_desde and e.hasta_30), 0)
    + coalesce((select sum(a.gasto) from public.gasto_ads_anuncio_diario a
                 where a.tienda = 'voltra' and a.ad_id = any(coalesce(e.meta_ad_ids, '{}'))
                   and not (coalesce(a.adset_id, '') = any(coalesce(e.meta_adset_ids, '{}')))
                   and a.fecha between e.ventana_desde and e.hasta_30), 0)
    end gasto_30
  from e
)
select e.id experimento_id, e.candidato_id, c.demo, e.estado,
  case when e.con_anuncios then 'anuncios' when e.familia_producto is not null then 'familia_canal' else 'sin_criterio' end atribucion,
  e.ventana_desde, case when e.ventana_desde is null then null else e.hasta_ef end ventana_hasta_efectiva,
  m.pedidos_validos, m.confirmados, m.entregados, m.devueltos, m.sin_resolver, m.unidades,
  round(g.gasto)::bigint gasto_minor,
  case when g.gasto is not null and m.confirmados > 0 then round(g.gasto / m.confirmados)::bigint end costo_por_confirmado,
  m.confirmados_30d,
  round(g.gasto_30)::bigint gasto_30d_minor,
  case
    when e.ventana_desde is null or g.gasto_30 is null then null
    when m.confirmados_30d >= 30 and g.gasto_30 / m.confirmados_30d <= 35000 then true
    when e.estado = 'CERRADO' or (select d from hoy) >= e.ventana_desde + 29 then false
    else null
  end ganador
from e
join public.pi_candidatos c on c.id = e.candidato_id
join m on m.id = e.id
join g on g.id = e.id;

comment on view public.pi_resultado_experimentos is
  'A1: pedidos reales atribuidos a cada experimento (anuncios o familia+canal) + gasto de Meta. Ganador = >=30 confirmados en 30 días a <=35.000 PYG por confirmado. Módulo pi_.';

-- 5d. A2 · Tasa de acierto (sin candidatos DEMO). Una sola fila para el tablero de Oportunidades.
-- acierto_pct = ganadores ÷ pruebas cerradas con veredicto (las sin dato de gasto se cuentan aparte, no entran).
-- El puntaje de la rúbrica NUNCA es esta tasa ni una probabilidad.
create view public.pi_tasa_acierto with (security_invoker = true) as
with cand as (select * from public.pi_candidatos where not demo),
res as (select r.* from public.pi_resultado_experimentos r where not r.demo),
mes as (
  select to_char(date_trunc('month', r.ventana_desde), 'YYYY-MM') mes,
    count(*) pruebas,
    count(*) filter (where r.estado = 'CERRADO') cerradas,
    count(*) filter (where r.estado = 'CERRADO' and r.ganador) ganadores
  from res r where r.ventana_desde is not null group by 1
)
select
  (select count(*) from cand)::int candidatos_total,
  coalesce((select jsonb_object_agg(estado, n) from (select estado, count(*) n from cand group by 1) s), '{}'::jsonb) candidatos_por_estado,
  (select count(*) from res)::int pruebas_total,
  (select count(*) from res where estado = 'EN_CURSO')::int pruebas_en_curso,
  (select count(*) from res where estado = 'CERRADO')::int pruebas_cerradas,
  (select count(*) from res where estado = 'CERRADO' and ganador)::int ganadores,
  (select count(*) from res where estado = 'CERRADO' and ganador = false)::int no_ganadores,
  (select count(*) from res where estado = 'CERRADO' and ganador is null)::int cerradas_sin_dato,
  (select round(100.0 * count(*) filter (where ganador) / nullif(count(*) filter (where ganador is not null), 0), 1)
     from res where estado = 'CERRADO') acierto_pct,
  coalesce((select jsonb_agg(jsonb_build_object('mes', mes, 'pruebas', pruebas, 'cerradas', cerradas, 'ganadores', ganadores) order by mes) from mes), '[]'::jsonb) pruebas_por_mes,
  '>=30 confirmados en 30 dias a <=35.000 PYG por confirmado'::text criterio_ganador;

comment on view public.pi_tasa_acierto is
  'A2: candidatos por estado, pruebas cerradas, ganadores y acierto acumulado (sin DEMO). Módulo pi_.';

-- Permisos de las vistas: solo logueado y servidor.
revoke all on public.pi_pedidos_voltra, public.pi_base_operativa, public.pi_resultado_experimentos, public.pi_tasa_acierto from anon, public;
grant select on public.pi_pedidos_voltra, public.pi_base_operativa, public.pi_resultado_experimentos, public.pi_tasa_acierto to authenticated, service_role;

-- ───────────────────── 6. Storage: bucket privado pi-fotos ─────────────────────
-- Privado (public = false): solo se ve con sesión, por URL firmada. Solo imágenes, hasta 10 MB.
-- Si el bucket ya existiera, se fuerza a privado.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pi-fotos', 'pi-fotos', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update set public = false;

create policy pi_fotos_storage_leer on storage.objects for select to authenticated using (bucket_id = 'pi-fotos');
create policy pi_fotos_storage_subir on storage.objects for insert to authenticated with check (bucket_id = 'pi-fotos');
create policy pi_fotos_storage_cambiar on storage.objects for update to authenticated
  using (bucket_id = 'pi-fotos') with check (bucket_id = 'pi-fotos');
create policy pi_fotos_storage_borrar on storage.objects for delete to authenticated using (bucket_id = 'pi-fotos');
