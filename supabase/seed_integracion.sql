-- Semillas de config_wa para la integración (transcripción, auditoría, textos de marketing).
-- Idempotente: el insert no pisa filas existentes y el update agrega solo las claves internas que
-- falten ('<nuevo>'::jsonb || valor → lo que ya estaba gana). Corre después de seed_config_wa.sql.

insert into public.config_wa (clave, valor) values
  -- Transcripción de notas de voz (_shared/transcripcion.ts). usd_por_hora = tarifa TOTAL por hora de
  -- audio, keyterms incluidos. Fuente: documentación de ElevenLabs revisada el 06-10-2026
  -- (Scribe v2: USD 0,22/h + keyterms USD 0,05/h = 0,27/h). [VERIFICAR precio vigente en elevenlabs.io/pricing]
  ('transcripcion',
   '{"proveedor": "elevenlabs_scribe_v2", "usd_por_hora": 0.27, "con_palabras_clave": true}'::jsonb),
  -- Auditoría diaria (functions/auditoria-diaria/logica.ts lee auditoria.url_bandeja y le agrega ?c=<id>).
  -- La app usa HashRouter con base /facial-wellness-os/ → la ruta de la bandeja va después del #.
  ('auditoria',
   '{"url_bandeja": "https://divapyweb-toto.github.io/facial-wellness-os/#/bandeja"}'::jsonb),
  -- Respuestas a los botones de las plantillas voltra_mk_* (baja de ofertas / más adelante).
  ('textos_marketing',
   '{"baja_confirmada": "Listo, no te vamos a mandar más ofertas. Si necesitás algo de tu pedido, escribinos por acá.", "mas_adelante": "Dale, sin problema. Cuando quieras, escribinos por acá."}'::jsonb)
on conflict (clave) do nothing;

-- Si la clave ya existía (cargada a mano o por otra semilla), sumar solo los campos que falten.
update public.config_wa
   set valor = '{"proveedor": "elevenlabs_scribe_v2", "usd_por_hora": 0.27, "con_palabras_clave": true}'::jsonb || valor
 where clave = 'transcripcion';

update public.config_wa
   set valor = '{"url_bandeja": "https://divapyweb-toto.github.io/facial-wellness-os/#/bandeja"}'::jsonb || valor
 where clave = 'auditoria';

update public.config_wa
   set valor = '{"baja_confirmada": "Listo, no te vamos a mandar más ofertas. Si necesitás algo de tu pedido, escribinos por acá.", "mas_adelante": "Dale, sin problema. Cuando quieras, escribinos por acá."}'::jsonb || valor
 where clave = 'textos_marketing';
