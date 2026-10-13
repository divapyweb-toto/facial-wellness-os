-- Semilla de config_wa.vendedor_seguimiento (recontactos automáticos del vendedor, 07-10-2026).
-- La lee supabase/functions/seguimiento-chat/logica.ts (leerCfgSeguimiento; lo que falte toma el default del código)
-- y toque3.ts (leerCfgToque3, clave toque3).
--   activo: arranca prendido (decisión de Enrique, 07-10). Para apagar:
--     update public.config_wa set valor = valor || '{"activo": false}' where clave = 'vendedor_seguimiento';
--   horas_1: horas sin respuesta (desde el último mensaje del bot) para el recontacto 1 (12-10: 1,5; antes 2).
--   horas_2: horas desde la última entrada del cliente para el recontacto 2.
--   max: recontactos por conversación cada dias_reinicio días (el contador no se reinicia cuando el cliente escribe).
--   ventana_1_h / ventana_max_h: el 1 sale solo si la última entrada fue hace < 23 h; ninguno después de 23,5 h
--     (la ventana gratis de WhatsApp es de 24 h; si se cierra antes, el recontacto se pierde).
--   horario_desde / horario_hasta: hora de Asunción [12, 21) (12-10; antes [8, 21)); fuera de horario se espera.
--   lote_max: máximo de recontactos por corrida (el cron corre cada 10 min).
--   separacion_min_h: horas mínimas entre el recontacto 1 y el 2.
--   dias_pedido: un pedido del cliente en estos días bloquea el recontacto (y el toque 3).
--   horas_2_min / margen_2_h (12-10): si esperar las horas_2 deja al 2 fuera de la ventana o del horario, se adelanta
--     al último momento en horario que deja margen_2_h (0,5 h) para el cron, nunca antes de horas_2_min (8 h) desde
--     la última entrada del cliente. Si no hay ningún momento válido, el 2 se saltea.
--   toque3 (12-10): plantilla de marketing voltra_mk_seguimiento_oferta a quien vino de un anuncio y no compró, entre
--     desde_h (48) y hasta_h (70) horas después de la primera respuesta del bot (las 72 h gratis del anuncio), si no
--     escribe hace sin_escribir_h (24) horas. Una vez por conversación. Arranca APAGADO; para prenderlo (con la
--     plantilla aprobada por Meta):
--       update public.config_wa set valor = jsonb_set(valor, '{toque3,activo}', 'true') where clave = 'vendedor_seguimiento';
--     requiere_consentimiento: true = solo a clientes con consentimiento de marketing 'si'. reintento_h: horas sin
--     reintentar tras una falla. nombre_si_falta: {{1}} sin nombre usable ("Hola de nuevo, …").
-- Si la clave ya existe no se pisa (on conflict do nothing); las claves nuevas que falten se agregan sin tocar
-- las que ya están (lo existente gana). Por eso los cambios de valor del 12-10 (horas_1 2 → 1,5 y horario_desde
-- 8 → 12) NO llegan solos a una base que ya tenía la clave: van con este update, una sola vez:
--   update public.config_wa set valor = valor || '{"horas_1": 1.5, "horario_desde": 12}'::jsonb
--    where clave = 'vendedor_seguimiento';
insert into public.config_wa (clave, valor) values
  ('vendedor_seguimiento',
   '{"activo": true,
     "horas_1": 1.5,
     "horas_2": 20,
     "max": 2,
     "ventana_1_h": 23,
     "ventana_max_h": 23.5,
     "horario_desde": 12,
     "horario_hasta": 21,
     "lote_max": 20,
     "separacion_min_h": 2,
     "dias_reinicio": 7,
     "dias_pedido": 7,
     "horas_2_min": 8,
     "margen_2_h": 0.5,
     "toque3": {"activo": false,
                "requiere_consentimiento": true,
                "plantilla": "voltra_mk_seguimiento_oferta",
                "idioma": "es",
                "desde_h": 48,
                "hasta_h": 70,
                "sin_escribir_h": 24,
                "reintento_h": 24,
                "lote_max": 20,
                "nombre_si_falta": "de nuevo"}}'::jsonb)
on conflict (clave) do nothing;

-- Bases donde la clave ya existía con menos campos: suma solo los que faltan (lo que ya está, gana).
update public.config_wa
   set valor = '{"activo": true,
                 "horas_1": 1.5,
                 "horas_2": 20,
                 "max": 2,
                 "ventana_1_h": 23,
                 "ventana_max_h": 23.5,
                 "horario_desde": 12,
                 "horario_hasta": 21,
                 "lote_max": 20,
                 "separacion_min_h": 2,
                 "dias_reinicio": 7,
                 "dias_pedido": 7,
                 "horas_2_min": 8,
                 "margen_2_h": 0.5,
                 "toque3": {"activo": false,
                            "requiere_consentimiento": true,
                            "plantilla": "voltra_mk_seguimiento_oferta",
                            "idioma": "es",
                            "desde_h": 48,
                            "hasta_h": 70,
                            "sin_escribir_h": 24,
                            "reintento_h": 24,
                            "lote_max": 20,
                            "nombre_si_falta": "de nuevo"}}'::jsonb || valor
 where clave = 'vendedor_seguimiento'
   and jsonb_typeof(valor) = 'object';
