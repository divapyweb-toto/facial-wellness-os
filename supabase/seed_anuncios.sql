-- Anuncios de Meta → producto (config_wa.anuncios_producto = {"<ad_id>": "<handle>"}).
-- Lo usa wa-webhook (procesar.ts) para saber qué producto vio el cliente que entra por un anuncio de WhatsApp
-- y avisarle al vendedor con la marca "[vino del anuncio de <producto>, handle <handle>]" (no pregunta qué vio).
-- Generado por scripts/mapear-anuncios.mjs (no editar a mano la lista; correr el script con los anuncios nuevos).
-- Insert si no existe (on conflict do nothing) + merge que agrega los ids nuevos sin pisar los que ya están en la
-- base (lo existente va a la DERECHA del ||, así gana). Para corregir uno:
--   update public.config_wa set valor = valor || jsonb_build_object('<ad_id>', '<handle>') where clave = 'anuncios_producto';
-- Nombres en Meta:
--   120251028172410429 = TIRAS NASALES
--   120251028173280429 = PARCHES BUCALES
--   120251028175490429 = RASPADOR DE LENGUA
--   120251028181900429 = TIRAS NASALES
--   120251028210620429 = EJERCITADOR DE MANDIBULA
--   120251028211490429 = RASPADOR DE LENGUA
--   120251028212040429 = PARCHES BUCALES
--   120251028212170429 = PACK TIRAS + PARCHES
--   120251028236970429 = RASPADOR DE LENGUA
--   120251028237050429 = BOTELLA FLEXIBLE
--   120251028237510429 = BOTELLA FLEXIBLE
--   120251028533010429 = RASPADOR DE LENGUA
--   120251028535240429 = BOTELLA FLEXIBLE
--   120251028537220429 = TIRAS NASALES
--   120251028538280429 = PARCHES BUCALES
insert into public.config_wa (clave, valor) values
  ('anuncios_producto', '{
    "120251028172410429": "tiras-nasales-gudair-30-unidades",
    "120251028173280429": "parches-bucales-gudair-30-unidades",
    "120251028175490429": "raspador-de-lengua-de-acero-inoxidable",
    "120251028181900429": "tiras-nasales-gudair-30-unidades",
    "120251028210620429": "ejercitador-de-mandibula-3-niveles",
    "120251028211490429": "raspador-de-lengua-de-acero-inoxidable",
    "120251028212040429": "parches-bucales-gudair-30-unidades",
    "120251028212170429": "pack-gudair-tiras-nasales-parches-bucales",
    "120251028236970429": "raspador-de-lengua-de-acero-inoxidable",
    "120251028237050429": "botella-flexible-gudair-500-ml",
    "120251028237510429": "botella-flexible-gudair-500-ml",
    "120251028533010429": "raspador-de-lengua-de-acero-inoxidable",
    "120251028535240429": "botella-flexible-gudair-500-ml",
    "120251028537220429": "tiras-nasales-gudair-30-unidades",
    "120251028538280429": "parches-bucales-gudair-30-unidades"
  }'::jsonb)
on conflict (clave) do nothing;
update public.config_wa set valor = '{
    "120251028172410429": "tiras-nasales-gudair-30-unidades",
    "120251028173280429": "parches-bucales-gudair-30-unidades",
    "120251028175490429": "raspador-de-lengua-de-acero-inoxidable",
    "120251028181900429": "tiras-nasales-gudair-30-unidades",
    "120251028210620429": "ejercitador-de-mandibula-3-niveles",
    "120251028211490429": "raspador-de-lengua-de-acero-inoxidable",
    "120251028212040429": "parches-bucales-gudair-30-unidades",
    "120251028212170429": "pack-gudair-tiras-nasales-parches-bucales",
    "120251028236970429": "raspador-de-lengua-de-acero-inoxidable",
    "120251028237050429": "botella-flexible-gudair-500-ml",
    "120251028237510429": "botella-flexible-gudair-500-ml",
    "120251028533010429": "raspador-de-lengua-de-acero-inoxidable",
    "120251028535240429": "botella-flexible-gudair-500-ml",
    "120251028537220429": "tiras-nasales-gudair-30-unidades",
    "120251028538280429": "parches-bucales-gudair-30-unidades"
  }'::jsonb || valor
  where clave = 'anuncios_producto';
