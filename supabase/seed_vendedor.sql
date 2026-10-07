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
  -- historial_mensajes: mensajes que viajan al modelo (los más nuevos); el perfil del cliente va aparte, resumido.
  -- espera_agrupar_s: segundos de silencio antes de responder (junta mensajes seguidos del cliente en una respuesta).
  -- La demora de "leer + escribir" está en vendedor_ritmo.
  ('vendedor',
   '{"modelo": "claude-haiku-4-5-20251001",
     "modelo_alternativo": "claude-sonnet-5-5",
     "max_tokens": 600,
     "max_iteraciones": 6,
     "max_turnos_conversacion": 20,
     "tope_mensual_usd": 45,
     "historial_mensajes": 12,
     "espera_agrupar_s": 8,
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

  -- Envío y plazo. Gs 33.000 verificado por Enrique el 06-10-2026 (mismo precio para todas las ciudades); el
  -- plazo es el de Punto a Punto (Lucero en CDE: 1 a 3 días hábiles, ver plazos_courier).
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

  -- Fotos y videos por handle: {handle: {"video": url, "uso": url, "foto": url}}. Sin "foto" usa la imagen de Shopify.
  ('vendedor_media', '{}'::jsonb),

  -- Ritmo humano "sano" (_shared/vendedor/ritmo.ts). Demora antes de la 1.ª burbuja = leer (base + ms por carácter
  -- del cliente, con tope) + escribir (base + ms por carácter de la respuesta), ± variacion, entre min_s y max_s.
  -- De noche (noche_desde_hora a noche_hasta_hora, Asunción) × factor_noche y tope max_noche_s: más lento pero responde.
  -- Respuestas de más de partir_desde_caracteres van en 2 burbujas (la pregunta sola), con una pausa acotada entre ambas.
  -- Se descuenta lo que ya pasó (espera de agrupación + lo que tardó el modelo). "escribiendo…" se renueva cada renovar_escribiendo_s.
  ('vendedor_ritmo',
   '{"leer_base_ms": 1500, "leer_ms_por_caracter": 35, "leer_max_ms": 8000, "escribir_base_ms": 1500, "escribir_ms_por_caracter": 55, "variacion": 0.2, "min_s": 4, "max_s": 25, "noche_desde_hora": 0, "noche_hasta_hora": 7, "factor_noche": 1.3, "max_noche_s": 32, "partir_desde_caracteres": 90, "pausa_burbuja_min_s": 1.5, "pausa_burbuja_max_s": 7, "renovar_escribiendo_s": 20}'::jsonb),

  -- Respuestas sin modelo (ahorro): sticker o emoji suelto al empezar, "gracias" suelto, "ok"/sticker con el pedido
  -- ya creado. Varias variantes por tipo: se elige una al azar y nunca se repite la última. Pasan por el filtro.
  ('vendedor_respuestas_fijas',
   '{"sticker_inicio": ["Jaja buenísimo. ¿Lo buscás para dormir mejor o para el aliento?", "Jaja. Contame, ¿es para dormir mejor, para el aliento o para entrenar?"], "gracias": ["De nada. Cualquier cosa me escribís por acá.", "A vos. Cualquier duda, por acá estoy."], "post_pedido": ["Perfecto. Cualquier novedad de tu pedido te escribimos por acá.", "Buenísimo. Te avisamos por acá cuando salga."]}'::jsonb),

  -- Frases que el filtro de salida bloquea para que no suene a bot (sin tildes, en minúscula; ¡ y ¿ cuentan),
  -- urgencia/stock/reseñas inventadas (Ley 1334, art. 35) y negar ser un asistente virtual (política de WhatsApp).
  ('vendedor_estilo',
   '{"muletillas": ["¡claro", "claro!", "por supuesto", "como asistente", "estoy aqui para ayudar", "no dudes en", "algo mas en lo que pueda ayudar", "algo mas en que pueda ayudar", "algo mas en lo que te pueda ayudar", "en que puedo ayudarte", "en que te puedo ayudar", "en que le puedo ayudar", "en que puedo ayudarle", "puedo ayudarte con algo mas", "te ayudo con algo mas", "entiendo tu preocupacion", "entiendo su preocupacion", "excelente pregunta", "gran pregunta", "espero haberte ayudado", "espero que esto te ayude", "fue un placer ayudarte"], "urgencia": ["ultimas unidades", "quedan pocas", "quedan pocos", "pocas unidades", "solo por hoy", "hasta agotar", "se agota", "se estan agotando", "tiempo limitado", "antes de que se termine", "el mas vendido", "los mas vendidos", "todos lo estan comprando", "miles de clientes", "cientos de clientes", "nuestros clientes dicen", "resenas"], "niega_ia": ["soy una persona", "soy humano", "soy humana", "no soy un bot", "no soy bot", "no soy un robot", "no soy una ia", "no soy una maquina", "no soy inteligencia artificial", "soy de carne y hueso", "soy una persona real"]}'::jsonb),

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

-- Fichas de producto y ofertas por cantidad. Se cargan si la clave no existe o si todavía está vacía ('{}'):
-- si Enrique ya las editó, no se pisan.
--  · Fichas: generadas el 06-10-2026 desde la descripción REAL de cada producto en Shopify (Admin GraphQL 2026-10,
--    solo lectura), por handle. Van al prompt: qué es, para quién, cómo se usa, 3 beneficios sin promesas de salud,
--    objeciones con su respuesta corta y consejo de uso. `precios_referencia` NO va al prompt (los precios de la
--    conversación salen siempre de consultar_catalogo): queda como control de los precios verificados por Enrique
--    el 06-10 (×1 79.000, ×2 125.000, ×3 155.000, pack 120.000; envío 33.000).
--  · Ofertas (Releasit, no están en Shopify): ×2 y ×3 de tiras y parches, verificadas por Enrique el 06-10.
--    [VERIFICAR] si raspador, botella y ejercitador tienen precio por cantidad antes de sumarlos.
insert into public.config_wa (clave, valor) values
  ('vendedor_fichas',
   '{
     "tiras-nasales-gudair-30-unidades": {
       "ficha": "Tira adhesiva que se pega arriba de las aletas de la nariz y las mantiene abiertas mientras dormís o entrenás",
       "para_quien": "Quien ronca por la nariz, a quien se le tapa la nariz de noche o cuya pareja se queja; también para correr, gym o fútbol",
       "como_se_usa": "Nariz limpia y seca, despegás la tira, la ponés arriba de las aletas y presionás unos segundos",
       "beneficios": [
         "Abre las aletas de la nariz para que entre más aire",
         "Se pone en segundos y a la mañana se despega fácil",
         "30 tiras por bolsa, talla única: te dura un mes usando una por noche"
       ],
       "objeciones": [
         {
           "objecion": "¿Funciona de verdad?",
           "respuesta": "Te mando el video real de cómo se pone y pagás recién cuando te llega"
         },
         {
           "objecion": "Está caro",
           "respuesta": "Es una bolsa para un mes; con 2 bolsas te ahorrás plata y pagás un solo envío"
         },
         {
           "objecion": "En la farmacia hay",
           "respuesta": "Acá la bolsa trae 30, te llega a tu casa y pagás al recibir"
         },
         {
           "objecion": "¿Hay talles?",
           "respuesta": "Es talla única"
         }
       ],
       "consejo_uso": "Piel limpia y seca, sin crema ni aceite; presioná unos segundos para que pegue bien",
       "precios_referencia": {
         "x1": 79000,
         "x2": 125000,
         "x3": 155000
       }
     },
     "parches-bucales-gudair-30-unidades": {
       "ficha": "Parche suave que se pone sobre la boca para dormir respirando por la nariz",
       "para_quien": "Quien duerme con la boca abierta, se despierta con la boca seca o ronca con la boca abierta",
       "como_se_usa": "Labios limpios y secos, sacás un parche de la bolsa y lo ponés sobre la boca antes de dormir",
       "beneficios": [
         "Te ayuda a mantener la boca cerrada mientras dormís",
         "Sin látex y se despega suave a la mañana",
         "30 noches por bolsa"
       ],
       "objeciones": [
         {
           "objecion": "¿Y si se me tapa la nariz?",
           "respuesta": "Para eso está el pack, que trae tira nasal y parche; si tenés una duda de salud, consultalo con tu médico"
         },
         {
           "objecion": "¿Duele al sacarlo?",
           "respuesta": "Se despega suave desde una punta"
         },
         {
           "objecion": "Está caro",
           "respuesta": "Es una bolsa para un mes; con 2 bolsas te ahorrás plata y pagás un solo envío"
         },
         {
           "objecion": "¿Se despega de noche?",
           "respuesta": "Con los labios limpios y secos, sin bálsamo, queda firme"
         }
       ],
       "consejo_uso": "Labios limpios y secos, sin bálsamo ni crema; con barba larga sobre el labio pega menos",
       "precios_referencia": {
         "x1": 79000,
         "x2": 125000,
         "x3": 155000
       }
     },
     "pack-gudair-tiras-nasales-parches-bucales": {
       "ficha": "Pack con 30 tiras nasales y 30 parches bucales: nariz abierta y boca cerrada en la misma noche",
       "para_quien": "Quien ronca y además duerme con la boca abierta, o cuya pareja se queja mucho",
       "como_se_usa": "Tira en la nariz y parche en la boca antes de dormir; para entrenar, solo la tira",
       "beneficios": [
         "Las dos cosas en un solo pedido y un solo envío",
         "Sale menos que comprar tiras y parches por separado",
         "30 tiras y 30 parches: un mes completo"
       ],
       "objeciones": [
         {
           "objecion": "¿Necesito las dos cosas?",
           "respuesta": "Si de noche respirás por la boca, sí; si es solo la nariz, alcanzan las tiras"
         },
         {
           "objecion": "Está caro",
           "respuesta": "Sale menos que comprar las dos por separado y pagás un solo envío"
         },
         {
           "objecion": "¿Funciona de verdad?",
           "respuesta": "Te mando el video real y pagás recién cuando te llega"
         }
       ],
       "consejo_uso": "Piel y labios limpios y secos, sin crema ni bálsamo",
       "precios_referencia": {
         "pack": 120000
       }
     },
     "raspador-de-lengua-de-acero-inoxidable": {
       "ficha": "Raspador de lengua de acero inoxidable para limpiar la lengua cada mañana",
       "para_quien": "A quien le preocupa el aliento o se ve la lengua blanca a la mañana",
       "como_se_usa": "Lo mojás, lo pasás por la lengua de atrás hacia adelante y enjuagás la boca y el raspador",
       "beneficios": [
         "Saca los restos que quedan sobre la lengua",
         "Te lleva 30 segundos cada mañana",
         "Acero inoxidable: se lava fácil y dura años"
       ],
       "objeciones": [
         {
           "objecion": "¿No alcanza con el cepillo?",
           "respuesta": "El raspador está hecho para la lengua: la limpiás entera en una pasada"
         },
         {
           "objecion": "¿Se oxida?",
           "respuesta": "Es de acero inoxidable"
         },
         {
           "objecion": "Está caro",
           "respuesta": "Lo comprás una vez: es de acero y dura años"
         }
       ],
       "consejo_uso": "Pasalo suave, de atrás hacia adelante, sin apretar; enjuagalo después de cada pasada",
       "precios_referencia": {
         "x1": 79000
       }
     },
     "botella-flexible-gudair-500-ml": {
       "ficha": "Botella flexible de 500 ml que se enrolla cuando está vacía",
       "para_quien": "Quien corre, entrena o anda todo el día y quiere llevar agua sin bulto",
       "como_se_usa": "La llenás, apretás para tomar y, vacía, la enrollás y la guardás",
       "beneficios": [
         "Vacía se enrolla y entra en cualquier bolsillo",
         "Liviana para correr y entrenar",
         "Libre de BPA y PVC, con boquilla que no gotea"
       ],
       "objeciones": [
         {
           "objecion": "¿Gotea en la mochila?",
           "respuesta": "La boquilla no gotea"
         },
         {
           "objecion": "¿Cuánto entra?",
           "respuesta": "500 ml"
         },
         {
           "objecion": "¿Es de plástico común?",
           "respuesta": "Es libre de BPA y PVC"
         }
       ],
       "consejo_uso": "Lavala con agua y jabón y dejala secar abierta antes de enrollarla",
       "precios_referencia": {
         "x1": 79000
       }
     },
     "ejercitador-de-mandibula-3-niveles": {
       "ficha": "Ejercitador de mandíbula de silicona con 3 niveles de resistencia",
       "para_quien": "Quien quiere entrenar la mandíbula a su ritmo, en ratos libres",
       "como_se_usa": "Elegís el nivel, ponés una pieza en cada muela y masticás 15 minutos al día",
       "beneficios": [
         "3 niveles: empezás suave y subís a tu ritmo",
         "Silicona flexible, fácil de limpiar",
         "Lo usás mientras trabajás, manejás o mirás una serie"
       ],
       "objeciones": [
         {
           "objecion": "¿En cuánto tiempo se nota?",
           "respuesta": "Depende de cada uno; lo importante es usarlo todos los días"
         },
         {
           "objecion": "¿Es difícil?",
           "respuesta": "Empezás con el nivel suave y subís cuando te sentís cómodo"
         },
         {
           "objecion": "Me duele la mandíbula",
           "respuesta": "Eso te conviene consultarlo con tu médico antes de usarlo"
         }
       ],
       "consejo_uso": "Empezá con el nivel suave y pocos minutos; lavalo con agua y jabón",
       "precios_referencia": {
         "x1": 79000
       }
     }
   }'::jsonb),
  ('vendedor_ofertas',
   '{
     "tiras-nasales-gudair-30-unidades": {
       "2": 125000,
       "3": 155000
     },
     "parches-bucales-gudair-30-unidades": {
       "2": 125000,
       "3": 155000
     }
   }'::jsonb)
on conflict (clave) do update set valor = excluded.valor
  where public.config_wa.valor = '{}'::jsonb;

-- Bases donde la semilla vieja ya corrió: ajusta solo los valores que siguen en el default anterior
-- (si Enrique los cambió, no se tocan). Idempotente. Solo toca historial_mensajes, espera_agrupar_s y max_tokens:
-- tope_mensual_usd, whatsapp_enrique y el resto de las claves de config_wa.vendedor NUNCA se modifican acá.
update public.config_wa
   set valor = valor
     || case when valor->'historial_mensajes' = '30'::jsonb then '{"historial_mensajes": 12}'::jsonb else '{}'::jsonb end
     || case when valor->'espera_agrupar_s' = '3'::jsonb then '{"espera_agrupar_s": 8}'::jsonb else '{}'::jsonb end
     || case when valor->'max_tokens' = '1024'::jsonb then '{"max_tokens": 600}'::jsonb else '{}'::jsonb end
 where clave = 'vendedor';

-- La lista de aceptaciones ({lista_de_aceptaciones} del prompt) es la misma de la ola 1: config_wa.aceptaciones.
-- config_wa.vendedor_prompt (opcional): reemplaza la plantilla del prompt sin desplegar, solo si NO hay versión
-- activa en vendedor_versiones (la activa manda; ver _shared/vendedor/version_activa.ts). No se siembra.
