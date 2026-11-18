-- supabase/tests/pi_modulo.sql · pruebas del módulo de inteligencia de productos (migración 20261119000001_pi_modulo.sql).
-- Todo va dentro de una transacción que termina en ROLLBACK: no deja nada grabado. Datos inventados y marcados DEMO.
-- Cómo correrla:
--   a) con la migración ya aplicada: correr este archivo tal cual (SQL Editor o psql).
--   b) sin aplicarla (prueba previa): armar un archivo con  begin; + la migración + este archivo sin sus líneas
--      "begin;" y "rollback;" + rollback;  y correrlo con  supabase db query --linked -f <archivo>.
-- Si algo falla, se corta con un error que dice qué prueba fue. Si todo pasa, la última consulta lista las pruebas OK.

begin;

create temp table pi_prueba_ok (n serial, prueba text) on commit drop;
grant all on pi_prueba_ok to authenticated;
grant usage on sequence pi_prueba_ok_n_seq to authenticated;
grant all on pi_prueba_ok to service_role;
grant usage on sequence pi_prueba_ok_n_seq to service_role;
-- Sesión simulada de un usuario logueado (las políticas de ventas/entregas/productos piden auth.uid() no nulo).
-- UUID inventado: no existe en auth.users; solo se usa dentro de esta transacción.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d3e0","role":"authenticated"}', true);
-- Usuario autorizado (hallazgo 4): el usuario simulado hace de "Enrique" dentro de esta transacción (rollback al final).
update public.pi_config set valor = '00000000-0000-0000-0000-00000000d3e0' where clave = 'usuario_autorizado';

-- 1. Alta del recorrido completo como usuario logueado (rol authenticated, con RLS).
set local role authenticated;
do $$
declare c uuid; pr uuid; co uuid; ev uuid;
begin
  insert into public.pi_candidatos (nombre, hipotesis, origen, demo) values ('DEMO candidato', 'DEMO hipótesis', 'demanda', true) returning id into c;
  insert into public.pi_fichas (candidato_id, version, spec) values (c, 1, '{"funcion":"DEMO","pack":"1 unidad"}');
  insert into public.pi_evidencias (candidato_id, tipo, campo, valor, fuente_entidad, observado_en)
    values (c, 'observed', 'dias_activo_anuncio', '12', 'DEMO biblioteca', now()) returning id into ev;
  insert into public.pi_ofertas_competencia (candidato_id, vendedor, vendedor_clave, comparacion, zona, precio_minor, evidencia_id)
    values (c, 'DEMO vendedor', 'demo-vendedor', 'equivalente', 'CDE', 99000, ev);
  insert into public.pi_proveedores (plataforma, id_externo, razon_social_declarada) values ('otro', 'DEMO-1', 'DEMO SA') returning id into pr;
  insert into public.pi_cotizaciones (candidato_id, proveedor_id, ficha_version, moneda, escalones, moq, tipo)
    values (c, pr, 1, 'USD', '[{"cantidad":100,"precio_unit_minor":150}]', 100, 'escaparate') returning id into co;
  insert into public.pi_escenarios_costo (candidato_id, nombre, entradas) values (c, 'base', '{"precio":99000}');
  insert into public.pi_casos (candidato_id, canal, precio_prueba_minor) values (c, 'whatsapp', 99000);
  insert into public.pi_experimentos (candidato_id, hipotesis, ventana_desde, estado, familia_producto, canal)
    values (c, 'DEMO', (now() at time zone 'America/Asuncion')::date - 30, 'EN_CURSO', 'Raspador', 'WA');
  insert into public.pi_trabajos (tipo, candidato_id, carga) values ('investigar_py', c, '{"consulta":"DEMO"}');
  insert into pi_prueba_ok (prueba) values ('1 alta de candidato DEMO, ficha, evidencia, oferta, proveedor, cotización, escenario, caso, experimento y trabajo (como authenticated)');
end $$;

-- 2. Cola con lease (como authenticated).
do $$
declare t1 public.pi_trabajos; n int; id0 uuid;
begin
  select * into t1 from public.pi_reclamar_trabajo('DEMO-mac', null, 15);
  assert t1.id is not null, '2a: el primer reclamo no devolvió trabajo';
  assert t1.estado = 'LEASED' and t1.intento = 1 and t1.ejecutor = 'DEMO-mac' and t1.lease_hasta > now(),
    format('2a: estado %s intento %s', t1.estado, t1.intento);
  id0 := t1.id;
  select count(*) into n from public.pi_reclamar_trabajo('DEMO-otra', null, 15);
  assert n = 0, '2b: con el lease vigente, un segundo reclamo NO debe devolver el trabajo';
  select count(*) into n from public.pi_reclamar_trabajo('DEMO-mac', array['cotizar'], 15);
  assert n = 0, '2c: el filtro por tipo no se respetó';
  update public.pi_trabajos set lease_hasta = now() - interval '1 minute' where id = id0;   -- vence el lease
  select * into t1 from public.pi_reclamar_trabajo('DEMO-otra', array['investigar_py'], 15);
  assert t1.id = id0 and t1.intento = 2 and t1.ejecutor = 'DEMO-otra', format('2d: tras vencer el lease vino %s intento %s', t1.id, t1.intento);
  update public.pi_trabajos set estado = 'RUNNING', lease_hasta = now() - interval '1 minute' where id = id0;  -- murió corriendo
  select * into t1 from public.pi_reclamar_trabajo('DEMO-mac', null, 15);
  assert t1.id = id0 and t1.intento = 3, '2e: un RUNNING con lease vencido debe poder recuperarse';
  update public.pi_trabajos set estado = 'SUCCEEDED' where id = id0;
  select count(*) into n from public.pi_reclamar_trabajo('DEMO-mac', null, 15);
  assert n = 0, '2f: un trabajo SUCCEEDED no se vuelve a reclamar';
  begin
    perform public.pi_reclamar_trabajo('', null, 15);
    raise exception '2g: aceptó ejecutor vacío';
  exception when raise_exception then
    if sqlerrm like '2g:%' then raise; end if;
  end;
  insert into pi_prueba_ok (prueba) values ('2 cola: reclamo, segundo reclamo vacío con lease vigente, filtro por tipo, lease vencido se recupera (LEASED y RUNNING), SUCCEEDED no vuelve, ejecutor obligatorio');
end $$;

-- 3. Checks: valores inválidos fallan (23514), duplicados (23505).
do $$
declare c uuid; pr uuid; po uuid;
begin
  select id into c from public.pi_candidatos where nombre = 'DEMO candidato';
  select id into pr from public.pi_proveedores where id_externo = 'DEMO-1';
  begin insert into public.pi_candidatos (nombre, estado) values ('DEMO x', 'COMPRAR');
    raise exception '3a: aceptó estado de candidato inválido'; exception when check_violation then null; end;
  begin insert into public.pi_trabajos (tipo, estado) values ('analizar', 'HECHO');
    raise exception '3b: aceptó estado de trabajo inválido'; exception when check_violation then null; end;
  begin insert into public.pi_trabajos (tipo) values ('comprar');
    raise exception '3c: aceptó tipo de trabajo inválido'; exception when check_violation then null; end;
  begin insert into public.pi_evidencias (candidato_id, tipo, campo) values (c, 'rumor', 'x');
    raise exception '3d: aceptó tipo de evidencia inválido'; exception when check_violation then null; end;
  begin insert into public.pi_ofertas_competencia (candidato_id, moneda, precio_minor) values (c, 'EUR', 1);
    raise exception '3e: aceptó moneda EUR'; exception when check_violation then null; end;
  begin insert into public.pi_cotizaciones (candidato_id, tipo) values (c, 'promesa');
    raise exception '3f: aceptó tipo de cotización inválido'; exception when check_violation then null; end;
  begin insert into public.pi_fichas (candidato_id, version, spec) values (c, 1, '{}');
    raise exception '3g: aceptó ficha versión 1 repetida'; exception when unique_violation then null; end;
  begin insert into public.pi_politicas (candidato_id, permite_envio) values (c, true);
    raise exception '3h: aceptó política que permite enviar sin autorización'; exception when check_violation then null; end;
  begin insert into public.pi_politicas (candidato_id, permite_envio, autorizada_por, autorizada_en) values (c, true, 'DEMO', now());
    raise exception '3h2: aceptó política que permite enviar sin el texto de Enrique'; exception when check_violation then null; end;
  insert into public.pi_politicas (candidato_id) values (c) returning id into po;
  begin insert into public.pi_mensajes (politica_id, proveedor_id, estado) values (po, pr, 'ENVIADO');
    raise exception '3i: aceptó estado de mensaje inválido'; exception when check_violation then null; end;
  insert into public.pi_mensajes (politica_id, proveedor_id, idempotencia) values (po, pr, 'DEMO-idem-1');
  begin insert into public.pi_mensajes (politica_id, proveedor_id, idempotencia) values (po, pr, 'DEMO-idem-1');
    raise exception '3j: aceptó clave de idempotencia repetida'; exception when unique_violation then null; end;
  -- freno de envíos: con política que no permite enviar, el mensaje no pasa de DRAFT
  begin update public.pi_mensajes set estado = 'AUTHORIZED' where idempotencia = 'DEMO-idem-1';
    raise exception '3o: autorizó un mensaje con política sin permiso de envío'; exception when check_violation then null; end;
  begin insert into public.pi_mensajes (politica_id, proveedor_id, idempotencia, estado) values (po, pr, 'DEMO-idem-2', 'SENT_CONFIRMED');
    raise exception '3p: insertó un mensaje ya enviado sin política'; exception when check_violation then null; end;
  -- política vencida tampoco sirve
  update public.pi_politicas set permite_envio = true, autorizada_por = 'DEMO', autorizada_en = now(), autorizada_texto = 'DEMO dale',
         vigente_hasta = now() - interval '1 day' where id = po;
  begin update public.pi_mensajes set estado = 'AUTHORIZED' where idempotencia = 'DEMO-idem-1';
    raise exception '3q: autorizó un mensaje con política vencida'; exception when check_violation then null; end;
  -- política vigente con permiso: ahora sí pasa a AUTHORIZED
  update public.pi_politicas set vigente_hasta = now() + interval '14 days' where id = po;
  update public.pi_mensajes set estado = 'AUTHORIZED' where idempotencia = 'DEMO-idem-1';
  assert (select estado from public.pi_mensajes where idempotencia = 'DEMO-idem-1') = 'AUTHORIZED', '3r: con política vigente no pasó a AUTHORIZED';
  begin insert into public.pi_ordenes_compra (candidato_id, cantidad, moneda, estado) values (c, 10, 'USD', 'APROBADA');
    raise exception '3k: aceptó estado de orden inválido'; exception when check_violation then null; end;
  begin insert into public.pi_ordenes_compra (candidato_id, cantidad, moneda, estado) values (c, 10, 'USD', 'PEDIDA');
    raise exception '3l: aceptó orden PEDIDA sin confirmación de Enrique'; exception when check_violation then null; end;
  begin insert into public.pi_ordenes_compra (candidato_id, cantidad, moneda) values (c, 0, 'USD');
    raise exception '3m: aceptó cantidad 0'; exception when check_violation then null; end;
  begin insert into public.pi_experimentos (candidato_id, estado) values (c, 'GANADO');
    raise exception '3n: aceptó estado de experimento inválido'; exception when check_violation then null; end;
  insert into pi_prueba_ok (prueba) values ('3 checks: estados/tipos/moneda inválidos, ficha repetida, política sin autorización o sin texto, idempotencia repetida, mensaje sin política vigente no pasa de DRAFT (vigente sí), orden inválida o sin confirmación, cantidad 0: todos rechazados');
end $$;

-- 4. Orden de compra + auditoría + actualizado_en (como authenticated).
do $$
declare c uuid; o uuid; n int; a timestamptz;
begin
  select id into c from public.pi_candidatos where nombre = 'DEMO candidato';
  insert into public.pi_ordenes_compra (candidato_id, plataforma, cantidad, precio_unit_minor, envio_minor, total_minor, moneda, deposito_destino)
    values (c, 'otro', 100, 150, 5000, 20000, 'USD', 'DEMO depósito') returning id into o;
  update public.pi_ordenes_compra set estado = 'CONFIRMADA_POR_ENRIQUE', confirmada_texto = 'DEMO sí', confirmada_en = now() where id = o;
  update public.pi_ordenes_compra set notas = 'DEMO nota' where id = o;  -- sin cambio de estado: no audita
  select count(*) into n from public.pi_eventos where entidad = 'pi_ordenes_compra' and entidad_id = o;
  assert n = 2, format('4a: esperaba 2 eventos de auditoría, hay %s', n);
  assert exists (select 1 from public.pi_eventos where entidad_id = o and accion = 'estado:CONFIRMADA_POR_ENRIQUE'
                   and detalle->>'de' = 'BORRADOR' and detalle->>'confirmada_texto' = 'DEMO sí'), '4b: evento de confirmación incompleto';
  update public.pi_candidatos set notas = 'DEMO', actualizado_en = '2000-01-01' where id = c;
  select actualizado_en into a from public.pi_candidatos where id = c;
  assert a = now(), format('4c: el disparador no puso actualizado_en (vino %s)', a);
  insert into pi_prueba_ok (prueba) values ('4 orden de compra BORRADOR → CONFIRMADA deja 2 eventos en pi_eventos (con texto de Enrique); actualizado_en lo pone el disparador');
end $$;
reset role;

-- 5. Borrado en cascada desde el candidato; las órdenes y los mensajes frenan el borrado (restrict).
do $$
declare c uuid; c2 uuid; n int;
begin
  select id into c from public.pi_candidatos where nombre = 'DEMO candidato';
  begin delete from public.pi_candidatos where id = c;
    raise exception '5a: borró un candidato con orden de compra'; exception when foreign_key_violation then null; end;
  insert into public.pi_candidatos (nombre, demo) values ('DEMO borrar', true) returning id into c2;
  insert into public.pi_fichas (candidato_id, version, spec) values (c2, 1, '{}');
  insert into public.pi_evidencias (candidato_id, tipo, campo) values (c2, 'unknown', 'precio');
  insert into public.pi_trabajos (tipo, candidato_id, estado) values ('analizar', c2, 'CANCELLED');
  delete from public.pi_candidatos where id = c2;
  select (select count(*) from public.pi_fichas where candidato_id = c2) + (select count(*) from public.pi_evidencias where candidato_id = c2)
       + (select count(*) from public.pi_trabajos where candidato_id = c2) into n;
  assert n = 0, '5b: el borrado del candidato no arrastró a sus hijos';
  insert into pi_prueba_ok (prueba) values ('5 borrar candidato arrastra fichas/evidencias/trabajos; con orden de compra queda frenado (restrict)');
end $$;

-- 6. Seguridad: RLS prendido, anon sin ningún permiso, authenticated sí.
do $$
declare r record; malos text := '';
begin
  for r in select c.relname, c.relkind, c.relrowsecurity from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where s.nspname = 'public' and c.relname like 'pi\_%' and c.relname <> 'pi_config' and c.relkind in ('r','v') loop
    if r.relkind = 'r' and not r.relrowsecurity then malos := malos || ' sin_rls:' || r.relname; end if;
    if has_table_privilege('anon', 'public.' || r.relname, 'select,insert,update,delete,truncate,references,trigger') then
      malos := malos || ' anon:' || r.relname; end if;
    if not has_table_privilege('authenticated', 'public.' || r.relname, 'select') then malos := malos || ' auth_sin_select:' || r.relname; end if;
  end loop;
  if has_function_privilege('anon', 'public.pi_reclamar_trabajo(text,text[],integer)', 'execute') then malos := malos || ' anon:pi_reclamar_trabajo'; end if;
  if has_function_privilege('anon', 'public.pi_tocar_actualizado_en()', 'execute') then malos := malos || ' anon:pi_tocar_actualizado_en'; end if;
  if has_function_privilege('anon', 'public.pi_ordenes_compra_auditar()', 'execute') then malos := malos || ' anon:pi_ordenes_compra_auditar'; end if;
  if has_function_privilege('anon', 'public.pi_mensajes_freno_envio()', 'execute') then malos := malos || ' anon:pi_mensajes_freno_envio'; end if;
  if not has_function_privilege('authenticated', 'public.pi_reclamar_trabajo(text,text[],integer)', 'execute') then malos := malos || ' auth:pi_reclamar_trabajo'; end if;
  if not has_function_privilege('service_role', 'public.pi_reclamar_trabajo(text,text[],integer)', 'execute') then malos := malos || ' svc:pi_reclamar_trabajo'; end if;
  assert malos = '', '6a: permisos mal:' || malos;
  assert (select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relname like 'pi\_%' and c.relkind = 'r') = 17, '6b: no son 17 tablas pi_ (16 + pi_config)';
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename like 'pi\_%') = 16, '6c: falta alguna política';
  assert (select not public from storage.buckets where id = 'pi-fotos'), '6d: el bucket pi-fotos no es privado';
  assert (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'pi\_fotos\_storage\_%'
           and roles = '{authenticated}') = 4, '6e: faltan las 4 políticas del bucket solo para authenticated';
  if has_function_privilege('anon', 'public.pi_candidatos_freno_decidir()', 'execute') then raise exception '6f: anon puede ejecutar pi_candidatos_freno_decidir'; end if;
  insert into pi_prueba_ok (prueba) values ('6 seguridad: 16 tablas con RLS y política; bucket pi-fotos privado con 4 políticas solo authenticated; anon sin permisos en tablas, vistas y funciones; authenticated y service_role pueden reclamar');
end $$;

-- 10. Revisión adversarial 18-11: solo Enrique autoriza (4), auditoría inalterable (5), URLs solo http(s) (8).
do $$
begin
  assert not has_table_privilege('authenticated', 'public.pi_config', 'select'), '10a: authenticated puede leer pi_config';
  assert not has_table_privilege('authenticated', 'public.pi_config', 'update'), '10a2: authenticated puede cambiar pi_config';
  assert not has_table_privilege('service_role', 'public.pi_config', 'update'), '10a3: la clave de servicio puede cambiar pi_config';
  assert not has_function_privilege('anon', 'public.pi_es_enrique()', 'execute'), '10b: anon puede ejecutar pi_es_enrique';
  assert not has_table_privilege('authenticated', 'public.pi_eventos', 'update') and not has_table_privilege('authenticated', 'public.pi_eventos', 'delete'), '10c: pi_eventos editable';
  assert not has_table_privilege('authenticated', 'public.pi_decisiones', 'update') and not has_table_privilege('authenticated', 'public.pi_decisiones', 'delete'), '10c2: pi_decisiones editable';
  assert not has_table_privilege('service_role', 'public.pi_eventos', 'delete'), '10c3: la clave de servicio puede borrar la auditoría';
  insert into pi_prueba_ok (prueba) values ('10a permisos: pi_config cerrada a la web y a la clave de servicio; pi_eventos y pi_decisiones sin editar ni borrar');
end $$;

-- 10b. Como OTRO usuario logueado (no es Enrique): no autoriza campañas ni confirma órdenes.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
set local role authenticated;
do $$
declare c uuid; po uuid; o uuid;
begin
  assert not public.pi_es_enrique(), '10d: otro usuario pasa por Enrique';
  select id into c from public.pi_candidatos where nombre = 'DEMO candidato';
  insert into public.pi_politicas (candidato_id, alcance) values (c, '{"producto":"DEMO"}') returning id into po;  -- proponer sí
  begin update public.pi_politicas set permite_envio = true, autorizada_texto = 'DEMO dale', vigente_hasta = now() + interval '14 days' where id = po;
    raise exception '10e: otro usuario autorizó una campaña'; exception when insufficient_privilege then null; end;
  begin insert into public.pi_politicas (candidato_id, permite_envio, autorizada_por, autorizada_en, autorizada_texto, vigente_hasta)
          values (c, true, 'Enrique', now(), 'DEMO dale', now() + interval '14 days');
    raise exception '10f: otro usuario creó una campaña que envía'; exception when insufficient_privilege then null; end;
  -- cambiar el alcance de una campaña vigente tampoco
  begin update public.pi_politicas set alcance = '{"proveedores_max":50}' where permite_envio and candidato_id = c;
    raise exception '10g: otro usuario agrandó el alcance de una campaña vigente'; exception when insufficient_privilege then null; end;
  insert into public.pi_ordenes_compra (candidato_id, cantidad, moneda, total_minor) values (c, 5, 'USD', 1000) returning id into o;  -- borrador sí
  begin update public.pi_ordenes_compra set estado = 'CONFIRMADA_POR_ENRIQUE', confirmada_texto = 'DEMO sí', confirmada_en = now() where id = o;
    raise exception '10h: otro usuario confirmó una orden'; exception when insufficient_privilege then null; end;
  begin update public.pi_ordenes_compra set total_minor = 1 where estado = 'CONFIRMADA_POR_ENRIQUE' and candidato_id = c;
    raise exception '10i: otro usuario cambió el total de una orden confirmada'; exception when insufficient_privilege then null; end;
  update public.pi_ordenes_compra set estado = 'PEDIDA' where estado = 'CONFIRMADA_POR_ENRIQUE' and candidato_id = c;  -- paso logístico sí
  begin update public.pi_ordenes_compra set estado = 'PAGADA_POR_ENRIQUE' where estado = 'PEDIDA' and candidato_id = c;
    raise exception '10j: otro usuario marcó pagada una orden'; exception when insufficient_privilege then null; end;
  update public.pi_politicas set permite_envio = false where id = po;  -- apagar siempre se puede
  begin update public.pi_eventos set accion = 'DEMO' where entidad = 'pi_ordenes_compra';
    raise exception '10k: editó la auditoría'; exception when insufficient_privilege then null; end;
  begin delete from public.pi_decisiones;
    raise exception '10l: borró decisiones'; exception when insufficient_privilege then null; end;
  begin insert into public.pi_proveedores (plataforma, url) values ('otro', 'javascript:alert(1)');
    raise exception '10m: aceptó una URL javascript:'; exception when check_violation then null; end;
  begin insert into public.pi_fotos (candidato_id, url_externa, fuente) values (c, 'data:text/html,DEMO', 'proveedor');
    raise exception '10n: aceptó una foto data:'; exception when check_violation then null; end;
  insert into public.pi_proveedores (plataforma, url) values ('otro', 'https://example.com/demo');
  insert into pi_prueba_ok (prueba) values ('10b otro usuario: propone campañas y borradores, pide y cancela; NO autoriza, no agranda alcance, no confirma, no cambia el total, no marca pagada; no edita la auditoría; URLs javascript:/data: rechazadas');
end $$;
reset role;

-- 10c. Sin usuario (como la clave de servicio del CLI): tampoco autoriza ni confirma. Y el freno de envío revisa
--      la política en el paso a SENDING (con la campaña vencida, un AUTHORIZED no sale).
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare c uuid; po uuid; o uuid;
begin
  assert not public.pi_es_enrique(), '10o: la clave de servicio pasa por Enrique';
  select id into c from public.pi_candidatos where nombre = 'DEMO candidato';
  begin insert into public.pi_politicas (candidato_id, permite_envio, autorizada_por, autorizada_en, autorizada_texto, vigente_hasta)
          values (c, true, 'Enrique', now(), 'DEMO dale', now() + interval '14 days');
    raise exception '10p: la clave de servicio autorizó una campaña'; exception when insufficient_privilege then null; end;
  insert into public.pi_ordenes_compra (candidato_id, cantidad, moneda) values (c, 5, 'USD') returning id into o;
  begin update public.pi_ordenes_compra set estado = 'CONFIRMADA_POR_ENRIQUE', confirmada_texto = 'DEMO sí', confirmada_en = now() where id = o;
    raise exception '10q: la clave de servicio confirmó una orden'; exception when insufficient_privilege then null; end;
  begin insert into public.pi_eventos (entidad, accion) values ('DEMO', 'DEMO'); delete from public.pi_eventos where entidad = 'DEMO';
    raise exception '10r: la clave de servicio borró la auditoría'; exception when insufficient_privilege then null; end;
  -- freno en SENDING: el mensaje AUTHORIZED del grupo 3 con su campaña vencida no puede pasar a SENDING
  select politica_id into po from public.pi_mensajes where idempotencia = 'DEMO-idem-1';
  update public.pi_politicas set permite_envio = false where id = po;  -- apagar (permitido para cualquiera)
  begin update public.pi_mensajes set estado = 'SENDING' where idempotencia = 'DEMO-idem-1';
    raise exception '10s: un AUTHORIZED pasó a SENDING sin campaña vigente'; exception when check_violation then null; end;
  insert into pi_prueba_ok (prueba) values ('10c clave de servicio: no autoriza campañas ni confirma órdenes ni borra la auditoría; un AUTHORIZED con la campaña apagada no pasa a SENDING');
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d3e0","role":"authenticated"}', true);

-- 9. Fotos, etapa DECIDIR, decisiones y Storage (como authenticated).
set local role authenticated;
do $$
declare c uuid; n int;
begin
  insert into public.pi_candidatos (nombre, demo) values ('DEMO fotos', true) returning id into c;
  begin update public.pi_candidatos set etapa = 'IMPORTAR_YA' where id = c;
    raise exception '9a: aceptó etapa inválida'; exception when check_violation then null; end;
  begin update public.pi_candidatos set etapa = 'DECIDIR' where id = c;
    raise exception '9b: pasó a DECIDIR sin fotos'; exception when check_violation then null; end;
  insert into public.pi_fotos (candidato_id, storage_path, fuente, es_principal, orden) values (c, 'DEMO/1.jpg', 'proveedor', true, 1);
  insert into public.pi_fotos (candidato_id, url_externa, fuente, orden) values (c, 'https://example.com/DEMO-2.jpg', 'proveedor', 2);
  begin update public.pi_candidatos set etapa = 'DECIDIR' where id = c;
    raise exception '9c: pasó a DECIDIR con 2 fotos'; exception when check_violation then null; end;
  insert into public.pi_fotos (candidato_id, storage_path, fuente, orden) values (c, 'DEMO/ia.png', 'ia_referencia', 3);
  begin update public.pi_candidatos set etapa = 'DECIDIR' where id = c;
    raise exception '9d: contó la foto de IA para pasar a DECIDIR'; exception when check_violation then null; end;
  insert into public.pi_fotos (candidato_id, storage_path, fuente, orden) values (c, 'DEMO/3.jpg', 'propia', 4);
  update public.pi_candidatos set etapa = 'DECIDIR' where id = c;   -- 3 reales, 2 del proveedor: pasa
  assert (select etapa from public.pi_candidatos where id = c) = 'DECIDIR', '9e: con 3 fotos reales no pasó a DECIDIR';
  begin insert into public.pi_fotos (candidato_id, storage_path, fuente, es_principal) values (c, 'DEMO/4.jpg', 'muestra', true);
    raise exception '9f: aceptó dos fotos principales'; exception when unique_violation then null; end;
  begin insert into public.pi_fotos (candidato_id, fuente) values (c, 'proveedor');
    raise exception '9g: aceptó foto sin ruta ni URL'; exception when check_violation then null; end;
  begin insert into public.pi_fotos (candidato_id, storage_path, fuente) values (c, 'DEMO/5.jpg', 'internet');
    raise exception '9h: aceptó fuente de foto inválida'; exception when check_violation then null; end;
  begin insert into public.pi_decisiones (candidato_id, decision, texto_enrique) values (c, 'IMPORTAR', '  ');
    raise exception '9i: aceptó decisión sin texto de Enrique'; exception when check_violation then null; end;
  begin insert into public.pi_decisiones (candidato_id, decision, texto_enrique) values (c, 'DESCARTAR', 'DEMO no');
    raise exception '9j: aceptó descartar sin motivo'; exception when check_violation then null; end;
  begin insert into public.pi_decisiones (candidato_id, decision, texto_enrique) values (c, 'COMPRAR', 'DEMO');
    raise exception '9k: aceptó decisión inválida'; exception when check_violation then null; end;
  insert into public.pi_decisiones (candidato_id, decision, texto_enrique, snapshot) values (c, 'IMPORTAR', 'DEMO importalo', '{"ganancia":1}');
  begin delete from public.pi_candidatos where id = c;
    raise exception '9l: borró un candidato con decisión registrada'; exception when foreign_key_violation then null; end;
  -- Storage: authenticated puede registrar un objeto en el bucket privado (solo la fila; se deshace con el rollback)
  insert into storage.objects (bucket_id, name) values ('pi-fotos', 'DEMO/prueba-rollback.jpg');
  select count(*) into n from storage.objects where bucket_id = 'pi-fotos' and name = 'DEMO/prueba-rollback.jpg';
  assert n = 1, '9m: authenticated no ve su objeto en pi-fotos';
  insert into pi_prueba_ok (prueba) values ('9 fotos: etapa inválida falla; DECIDIR con 0 y 2 fotos falla, con 2+IA falla, con 3 reales pasa; 2 principales, foto sin ruta y fuente inválida fallan; decisión sin texto, descartar sin motivo y decisión inválida fallan; candidato con decisión no se borra; authenticated sube y ve en pi-fotos');
end $$;
reset role;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  begin perform 1 from public.pi_candidatos limit 1;
    raise exception '7a: anon pudo leer pi_candidatos'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.pi_base_operativa limit 1;
    raise exception '7b: anon pudo leer pi_base_operativa'; exception when insufficient_privilege then null; end;
  begin perform public.pi_reclamar_trabajo('anon', null, 15);
    raise exception '7c: anon pudo reclamar un trabajo'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.pi_fotos limit 1;
    raise exception '7d: anon pudo leer pi_fotos'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.pi_decisiones limit 1;
    raise exception '7e: anon pudo leer pi_decisiones'; exception when insufficient_privilege then null; end;
  -- Storage: anon no ve nada del bucket (RLS) aunque exista el objeto que subió authenticated en la prueba 9
  begin
    if exists (select 1 from storage.objects where bucket_id = 'pi-fotos') then
      raise exception '7f: anon ve objetos del bucket pi-fotos'; end if;
  exception when insufficient_privilege then null;   -- sin permiso de tabla también cuenta como "no lee"
  end;
  begin insert into storage.objects (bucket_id, name) values ('pi-fotos', 'DEMO/anon.jpg');
    raise exception '7g: anon pudo subir al bucket pi-fotos'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d3e0","role":"authenticated"}', true);
insert into pi_prueba_ok (prueba) values ('7 como anon: leer tabla, vista, pi_fotos y pi_decisiones y reclamar trabajo dan "permiso denegado"; no ve ni puede subir objetos del bucket pi-fotos');

-- 8. Vistas sobre datos reales (como authenticated): responden y son coherentes.
set local role authenticated;
do $$
declare n int; r record; t record; adset text;
begin
  select count(*) into n from public.pi_base_operativa;
  assert n > 0, '8a: pi_base_operativa vacía';
  assert not exists (select 1 from public.pi_base_operativa where pct_entregado + pct_devuelto not between 99.8 and 100.2),
    '8b: entregado + devuelto no suma 100';
  assert not exists (select 1 from public.pi_base_operativa where canal not in ('WA','Web')), '8c: canal fuera de WA/Web';
  -- hallazgo 3: confirmado de Voltra ≥ tasa de despacho (todo despachado fue confirmado), salvo pedidos viejos sin estado
  assert exists (select 1 from public.pi_base_operativa where pct_confirmado is not null), '8c2: pct_confirmado vacío';
  select * into r from public.pi_resultado_experimentos where demo and atribucion = 'familia_canal';
  assert r.experimento_id is not null and r.gasto_minor is null and r.ganador is null,
    format('8d: experimento por familia: gasto %s ganador %s (gasto desconocido debe ser null, no 0)', r.gasto_minor, r.ganador);
  assert r.pedidos_validos >= 0 and r.confirmados <= r.pedidos_validos + r.devueltos + 100, '8e: conteos raros';
  select adset_id into adset from public.gasto_ads_diario where tienda = 'voltra' and fecha >= (now() at time zone 'America/Asuncion')::date - 30
   order by fecha desc limit 1;
  update public.pi_experimentos set meta_adset_ids = array[adset] where familia_producto = 'Raspador' and hipotesis = 'DEMO';
  select * into r from public.pi_resultado_experimentos where demo and atribucion = 'anuncios';
  assert adset is null or (r.gasto_minor is not null and r.gasto_minor >= 0), format('8f: con conjunto %s el gasto vino %s', adset, r.gasto_minor);
  select * into t from public.pi_tasa_acierto;
  assert t.candidatos_total = (select count(*) from public.pi_candidatos where not demo), '8g: la tasa de acierto contó candidatos DEMO';
  assert t.pruebas_total = (select count(*) from public.pi_experimentos e join public.pi_candidatos c on c.id = e.candidato_id where not c.demo),
    '8h: la tasa de acierto contó pruebas DEMO';
  insert into pi_prueba_ok (prueba) values (format('8 vistas: base operativa %s filas (entregado+devuelto=100, canal WA/Web); experimento por familia con gasto desconocido = null; con conjunto %s gasto %s; tasa de acierto sin DEMO',
    n, coalesce(adset, '(ninguno)'), coalesce(r.gasto_minor::text, 'null')));
end $$;
reset role;

select n, prueba from pi_prueba_ok order by n;

rollback;
