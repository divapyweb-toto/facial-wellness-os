-- Semillas de config_wa (ola 1 · WhatsApp). Fuente: supabase/CONTRATO-OLA1.md
-- on conflict do nothing: si Enrique ya cambió un valor, no se pisa.
insert into public.config_wa (clave, valor) values
  ('palabras_prohibidas',
   '["garantía","devolución","reembolso","sin riesgo","cura","curar","tratamiento","oxígeno"]'::jsonb),
  ('horario_marketing',
   '{"desde": 8, "hasta": 21}'::jsonb),
  ('plazos_courier',
   '{"lucero": "1 a 3 días hábiles", "pap": "2 a 5 días hábiles; interior, hasta 10"}'::jsonb),
  ('tarifas_usd',
   '{"utilidad": 0.0113, "marketing": 0.074}'::jsonb),
  ('confirmacion',
   '{"recordatorio_h": 4, "retener_h": 48, "cancelar_h": 72}'::jsonb)
on conflict (clave) do nothing;

-- ─── Integración ola 1 (06-10-2026) ─────────────────────────────────────────
-- Textos tomados de docs/Voltra_WhatsApp_venta_postventa_recompra.md (local).
-- Ninguno usa palabras prohibidas (lo verifica tests/plantillas-wa.test.mjs y,
-- de todas formas, _shared/wa.ts bloquea el envío si alguna se cuela).
-- Variables: {nombre} (primer nombre; si falta se borra junto con el espacio),
-- {pedido} ('#1001'), {plazo} (sale de plazos_courier según el courier del pedido).
insert into public.config_wa (clave, valor) values
  -- wa-webhook: respuesta escrita que cuenta como "Confirmar" (si el cliente tiene UN solo pedido pendiente).
  ('aceptaciones',
   '["si","sí","ok","okay","dale","ya","katu","mandame katu","si luego","confirmo"]'::jsonb),
  -- wa-webhook: respuesta al tocar los botones de la confirmación.
  ('respuestas_confirmacion',
   '{"confirmado": "Listo {nombre}, quedó confirmado. Te llega en {plazo}; te avisamos cuando lo preparemos.",
     "a_corregir": "Dale, escribime acá el dato correcto (dirección, ciudad o referencia) y lo cambiamos.",
     "cancelado":  "Entendido, cancelamos tu pedido. Si más adelante lo querés, escribinos por acá."}'::jsonb),
  -- wa-webhook: envíos programados que se cancelan cuando el cliente responde (subcadena de envios_programados.plantilla).
  ('plantillas_cancelables_al_responder',
   '["recordatorio","retener","cancelar"]'::jsonb),
  -- wa-webhook: botones post-venta de las plantillas (ayuda, ne_*, seg_*) y consentimiento del día 0.
  -- consentimiento_si / consentimiento_no son etiquetas de botón: máximo 20 caracteres.
  ('textos_botones',
   '{"ayuda":         "Dale {nombre}, contame qué necesitás con tu pedido {pedido} y una persona del equipo te responde por acá.",
     "ne_reintentar": "Listo {nombre}, coordinamos con el courier para intentar de nuevo la entrega de tu pedido {pedido}. Te avisamos el día que pase.",
     "ne_direccion":  "Dale {nombre}, escribime acá la dirección nueva (calle, número, ciudad y una referencia) y la cambiamos.",
     "ne_cancelar":   "Entendido {nombre}, le pasamos tu pedido {pedido} al equipo para cancelarlo. Si cambiás de idea, escribinos por acá.",
     "seg_problema":  "Entiendo {nombre}. Contame qué pasó con el producto y lo vemos ahora. Si me mandás una foto, lo resolvemos más rápido.",
     "seg_bien_ya":   "Gracias {nombre}, qué bueno que llegó todo bien.",
     "consentimiento": "¡Qué bueno {nombre}! ¿Te puedo avisar por acá cuando se te estén por acabar y cuando haya novedades de Voltra?",
     "consentimiento_si": "Sí, avisame",
     "consentimiento_no": "No, gracias",
     "cons_si": "Listo, te avisamos por acá. Si en algún momento no querés más avisos, escribí BAJA.",
     "cons_no": "Entendido, no te mandamos novedades. Seguimos por acá para lo que necesites con tus pedidos."}'::jsonb),
  -- telegram-webhook: aviso al cliente cuando Enrique decide desde Telegram (solo con ventana de 24 h abierta).
  ('textos_decisiones',
   '{"cancelado":  "Hola {nombre}, cancelamos tu pedido {pedido} como pediste. Si más adelante lo querés, escribinos por acá.",
     "reposicion": "Hola {nombre}, te mandamos de nuevo tu pedido {pedido} sin costo. Te avisamos cuando salga.",
     "escribo":    "Hola {nombre}, soy Enrique de Voltra. Ya vi tu mensaje sobre el pedido {pedido} y te escribo por acá."}'::jsonb),
  -- importar-courier: prefijos del Codigo de Lucero que son de esta tienda.
  -- "FW-" queda aceptado durante la transición (ver supabase/CONTRATO-OLA1.md, sección Integración).
  ('prefijos_courier',
   '{"lucero": ["VT-","FW-"], "pap": []}'::jsonb),
  -- procesar-envios: texto libre en lugar de plantilla cuando la ventana está abierta (apagado hasta probarlo).
  ('usar_texto_libre_en_ventana', 'false'::jsonb),
  ('textos_libres', '{}'::jsonb),
  -- procesar-envios: despachado / entrega hoy / no entregado solo de 8 a 20 h (lo importado de noche sale a las 8:00).
  ('horario_avisos_envio',
   '{"desde": 8, "hasta": 20}'::jsonb),
  -- procesar-envios: lote y reintentos (los mismos valores que el código usa si falta la clave).
  ('procesar_envios',
   '{"lote": 50, "lease_min": 10, "max_intentos": 3, "esperas_min": [5, 30], "reintento_131049_h": 24}'::jsonb),
  -- salud-canal: umbrales del aviso "canal sordo" (los mismos del contrato).
  ('salud_canal',
   '{"horas_sin_entrantes": 3, "fallidos_por_hora": 3, "repetir_cada_h": 3}'::jsonb)
on conflict (clave) do nothing;

-- shopify-webhook lee confirmacion.confirmar_min (demora de la confirmación, en minutos).
-- Se agrega sin pisar las otras claves ni un valor que Enrique ya haya cambiado.
update public.config_wa
   set valor = jsonb_build_object('confirmar_min', 2) || valor,
       actualizado_en = now()
 where clave = 'confirmacion'
   and not (valor ? 'confirmar_min');

-- Claves que NO van en la semilla (las escribe el sistema):
--   salud_ultimo_aviso → salud-canal guarda cuándo avisó cada cosa.
