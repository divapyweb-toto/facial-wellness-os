-- Semillas de config_wa para el vendedor con IA (ola 2 · G1). Fuente: supabase/CONTRATO-OLAS2-4.md y
-- docs/Voltra_WhatsApp_venta_postventa_recompra.md (local). on conflict do nothing: si Enrique ya cambió
-- un valor, no se pisa. Los precios de los productos NO van acá: salen de Shopify (consultar_catalogo).
insert into public.config_wa (clave, valor) values

  -- Modelo y límites. Haiku 4.5 primero; si no pasa la batería de 50 (0 palabras prohibidas, 0 precios
  -- inventados, tono igual de natural) se cambia `modelo` por `modelo_alternativo` (Sonnet 5.5).
  -- esfuerzo: solo lo usa Sonnet 5.5 ("low" = recomendado para chat); Haiku 4.5 no lo acepta y se ignora.
  -- whatsapp_enrique: número del WhatsApp manual de Enrique en formato 595XXXXXXXXX. No va en el repo
  -- (es público): cargarlo con
  --   update public.config_wa set valor = valor || '{"whatsapp_enrique":"595XXXXXXXXX"}' where clave = 'vendedor';
  -- Mientras sea null, al derivar el cliente recibe un texto sin botón y Enrique un aviso de que falta.
  -- flow_id: id del WhatsApp Flow publicado (supabase/flows/formulario_pedido.json, pantalla PEDIDO). null = sin formulario.
  ('vendedor',
   '{"modelo": "claude-haiku-4-5-20251001",
     "modelo_alternativo": "claude-sonnet-5-5",
     "max_tokens": 1024,
     "max_iteraciones": 6,
     "max_turnos_conversacion": 20,
     "tope_mensual_usd": 45,
     "historial_mensajes": 30,
     "demora_min_s": 2,
     "demora_max_s": 6,
     "espera_agrupar_s": 3,
     "cache_ttl": "1h",
     "esfuerzo": "low",
     "fallback_servidor": true,
     "whatsapp_enrique": null,
     "catalogo_cache_min": 10,
     "catalogo_estado": "ACTIVE",
     "cantidad_max": 3,
     "flow_id": null,
     "flow_pantalla": "PEDIDO",
     "max_caracteres": 500}'::jsonb),

  -- Precios de Claude en USD por millón de tokens (verificados en platform.claude.com/docs/en/about-claude/pricing
  -- el 06-10-2026). lote = multiplicador del Batch API (50 % de descuento). Revisar cuando Anthropic cambie precios.
  ('precios_claude',
   '{"claude-haiku-4-5-20251001": {"entrada": 1, "salida": 5, "cache_escritura_5m": 1.25, "cache_escritura_1h": 2, "cache_lectura": 0.10, "lote": 0.5},
     "claude-haiku-4-5":          {"entrada": 1, "salida": 5, "cache_escritura_5m": 1.25, "cache_escritura_1h": 2, "cache_lectura": 0.10, "lote": 0.5},
     "claude-sonnet-5-5":         {"entrada": 2, "salida": 10, "cache_escritura_5m": 2.50, "cache_escritura_1h": 4, "cache_lectura": 0.20, "lote": 0.5}}'::jsonb),

  -- Envío y plazo. [VERIFICAR] Gs 33.000 es lo cargado en Releasit el 30-09; el plazo es el de Punto a Punto
  -- (Lucero en CDE: 1 a 3 días hábiles, ver plazos_courier).
  ('vendedor_envio',
   '{"costo_gs": 33000, "plazo": "2 a 5 días hábiles; interior, hasta 10"}'::jsonb),

  -- Glosario jopara (tabla "Cómo escribe el cliente paraguayo" del documento de mensajes).
  ('vendedor_glosario',
   '[{"escribe": "pasame na el precio", "significa": "\"na\" suaviza el pedido, como \"por favor\"", "accion": "Dar precio, envío y total"},
     {"escribe": "un poco (decime un poco)", "significa": "Suaviza, no indica cantidad", "accion": "Dar el dato completo"},
     {"escribe": "pio, piko, pa", "significa": "Marcan pregunta; \"piko\" agrega duda o sorpresa", "accion": "Con \"piko\", responder con una prueba concreta"},
     {"escribe": "katu, py (mandame katu)", "significa": "\"Dale, hacelo\"", "accion": "Cerrar: pedir nombre, ciudad y dirección"},
     {"escribe": "ya, si luego, dale, ok", "significa": "Aceptación", "accion": "Tomarlo como sí y confirmar con el resumen del pedido"},
     {"escribe": "ya te dije luego", "significa": "\"Como ya te dije\"; puede marcar fastidio", "accion": "No repetir la pregunta"},
     {"escribe": "mba''e (y bueno, mba''e)", "significa": "Muletilla de indecisión", "accion": "Una razón más y una pregunta cerrada"},
     {"escribe": "mba''e pio", "significa": "\"No es para tanto\"", "accion": "Responder con un dato sobrio, sin exagerar"},
     {"escribe": "ndaje (ndaje que no llega)", "significa": "\"Dicen que\", rumor", "accion": "Contestar con un dato propio: plazo y pago al recibir"},
     {"escribe": "gua''u (de gua''u nomás es)", "significa": "\"De mentira\"", "accion": "Mostrar video o foto real"},
     {"escribe": "nambre, mbore, nanga", "significa": "Rechazo, \"ni ahí\"", "accion": "No insistir; una pregunta abierta"},
     {"escribe": "nde (exclamación)", "significa": "Sorpresa, por ejemplo ante el precio", "accion": "Explicar el porqué y ofrecer el ×2"},
     {"escribe": "che", "significa": "Trato de confianza", "accion": "Mantener el tono cercano"},
     {"escribe": "ha upéi?", "significa": "Saludo, \"¿y qué tal?\"", "accion": "Saludar y seguir"},
     {"escribe": "me hallo", "significa": "\"Estoy a gusto\"", "accion": "Señal de satisfacción: pedir reseña o foto"},
     {"escribe": "ahora el lunes", "significa": "\"Este lunes que viene\"", "accion": "Repetir con fecha: \"lunes 5/10\""},
     {"escribe": "q, xq, tmb, dsp, bno", "significa": "que, porque, también, después, bueno", "accion": "Entender; nunca usarlas desde la marca"}]'::jsonb),

  -- Fichas por handle de Shopify: se completan a mano (texto sin precios ni promesas de salud). Los títulos
  -- salen de Shopify en cada turno; acá va solo lo que agrega contexto. Ejemplo de forma:
  --   {"tiras-nasales-gudair-30-unidades": {"ficha": "...", "consejo_uso": "piel limpia y seca, sin crema"}}
  ('vendedor_fichas', '{}'::jsonb),

  -- Afirmaciones permitidas: lista CONSERVADORA, solo lo que no es promesa de salud.
  -- [VERIFICAR con el Plan Web] antes de sumar beneficios de producto.
  ('vendedor_afirmaciones',
   '["Pagás al recibir",
     "Envío a todo el país",
     "Te llega en 2 a 5 días hábiles",
     "Cualquier problema lo vemos por acá caso por caso",
     "Te mandamos la confirmación por WhatsApp antes de despacharlo"]'::jsonb),

  -- Frases que el filtro de salida bloquea como promesa de salud (además de config_wa.palabras_prohibidas).
  ('vendedor_promesas_salud',
   '["dejás de roncar", "dejas de roncar", "deja de roncar", "dejar de roncar",
     "elimina el ronquido", "elimina los ronquidos", "eliminá el ronquido", "adiós al ronquido", "chau ronquido",
     "más oxígeno", "mas oxigeno", "oxigena",
     "resultados garantizados", "100% efectivo", "100 % efectivo", "efectividad comprobada", "clínicamente comprobado",
     "sin efectos secundarios", "mejora tu salud", "mejora la salud", "sanar", "previene enfermedades",
     "recomendado por médicos", "aprobado por médicos", "te soluciona la apnea", "para la apnea", "quita la apnea"]'::jsonb),

  -- Ofertas por cantidad que viven en Releasit y no en Shopify: {handle: {"2": total, "3": total}}.
  -- Vacío = el vendedor solo ofrece ×1. [VERIFICAR] los valores vigentes en Releasit antes de cargarlos.
  ('vendedor_ofertas', '{}'::jsonb),

  -- Fotos y videos por handle: {handle: {"video": url, "uso": url, "foto": url}}. Sin "foto" usa la imagen de Shopify.
  ('vendedor_media', '{}'::jsonb),

  -- Textos fijos del vendedor. Variables entre llaves.
  ('vendedor_textos',
   '{"resumen": "Te resumo: {lineas}. Envío Gs {envio}. Total Gs {total}, pagás al recibir. Lo entregamos en {direccion}, {ciudad}.",
     "boton_confirmar": "Confirmar",
     "boton_corregir": "Corregir",
     "pedido_creado": "Listo {nombre}, ya cargamos tu pedido {pedido}. En unos minutos te llega la confirmación por acá.",
     "derivacion": "Te paso con Enrique para que lo vea personalmente. Tocá el botón y le llega tu caso ya escrito.",
     "derivacion_sin_boton": "Le paso tu caso a Enrique y te escribe por acá apenas lo vea.",
     "boton_enrique": "Hablar con Enrique",
     "mensaje_a_enrique": "Hola Enrique, soy {nombre}. {resumen}",
     "formulario_titulo": "Datos para tu pedido",
     "formulario_cta": "Completar datos"}'::jsonb)

on conflict (clave) do nothing;

-- La lista de aceptaciones ({lista_de_aceptaciones} del prompt) es la misma de la ola 1: config_wa.aceptaciones.
-- config_wa.vendedor_prompt (opcional): reemplaza la plantilla del prompt sin desplegar. No se siembra.
