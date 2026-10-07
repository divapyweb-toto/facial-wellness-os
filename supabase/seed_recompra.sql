-- Semilla de recompra (ola 3 · H1). Fuente: docs/Voltra_WhatsApp_venta_postventa_recompra.md,
-- sección "Recompra con bolsas de 30 unidades". on conflict do nothing: no pisa lo que Enrique cambió.
--
-- [VERIFICAR precios vigentes en Shopify] Los precios de oferta son los del documento (1-oct-2026).
-- [VERIFICAR] Que las bolsas de tiras y parches traigan 30 unidades (hallazgo de 1-oct-2026).
-- [VERIFICAR] Los "patrones" contra los títulos reales de los productos de Voltra en Shopify
--   (se compara sin tildes ni mayúsculas; gana el primer producto de la lista que coincide).
--
-- Cómo se calcula (functions/recompra/calendario.ts):
--   D = unidades_por_bolsa × bolsas ÷ unidades_por_noche
--   M1 = min(pct_m1 × D, D − margen_dias_m1)        (días desde la entrega, hacia abajo)
--   M2 = D ÷ factor_uso_real − resta_m2              (solo si no recompró)
--   factor_uso_real 0,8 es un supuesto: con 30 recompras propias, reemplazar por la mediana real.
-- ofertas[clave o tipo]["1"|"2"|"3"]: "3" vale para 3 bolsas o más. Cada oferta va a la plantilla
-- {{3}} = oferta, {{4}} = precio (sin "Gs", se formatea 79.000).
insert into public.config_wa (clave, valor) values
  ('recompra',
   '{
     "unidades_por_noche": 1,
     "factor_uso_real": 0.8,
     "pct_m1": 0.85,
     "margen_dias_m1": 7,
     "resta_m2": 3,
     "dia_cruzada": 14,
     "hora_envio": 9,
     "dias_gracia": 3,
     "ventana_dias": 200,
     "nombre_si_falta": "de nuevo",
     "productos": [
       {"clave": "ejercitador", "nombre": "ejercitador de mandíbula", "tipo": "unico",
        "patrones": ["ejercitador", "jawflex", "mandibula"], "afin": "botella"},
       {"clave": "raspador", "nombre": "raspador de lengua", "tipo": "unico",
        "patrones": ["raspador", "limpiador de lengua", "tongue"], "afin": "parches"},
       {"clave": "botella", "nombre": "botella", "tipo": "unico",
        "patrones": ["botella", "bottle"], "afin": "tiras"},
       {"clave": "pack", "nombre": "tiras y parches", "tipo": "pack", "unidades_por_bolsa": 30,
        "patrones": ["pack", "tiras y parches", "tira nasal + parche"], "contiene": ["tiras", "parches"],
        "afin": "raspador"},
       {"clave": "parches", "nombre": "parches bucales", "tipo": "consumible", "unidades_por_bolsa": 30,
        "patrones": ["parche", "cinta bucal", "mouth tape"], "afin": "tiras"},
       {"clave": "tiras", "nombre": "tiras nasales", "tipo": "consumible", "unidades_por_bolsa": 30,
        "patrones": ["tira", "nasal", "nose strip"], "afin": "parches"}
     ],
     "ofertas": {
       "consumible": {
         "1": {"M1": {"plantilla": "voltra_mk_reposicion", "oferta": "otra bolsa", "precio": 79000},
               "M2": {"plantilla": "voltra_mk_pack", "oferta": "el pack de 2 bolsas", "precio": 125000}},
         "2": {"M1": {"plantilla": "voltra_mk_reposicion", "oferta": "el pack de 2 bolsas", "precio": 125000},
               "M2": {"plantilla": "voltra_mk_pack", "oferta": "el pack de 3 bolsas", "precio": 155000}},
         "3": {"M1": {"plantilla": "voltra_mk_reposicion", "oferta": "el pack de 3 bolsas", "precio": 155000},
               "M2": {"plantilla": "voltra_mk_pack", "oferta": "el pack de 3 bolsas", "precio": 155000}}
       },
       "pack": {
         "1": {"M1": {"plantilla": "voltra_mk_reposicion", "oferta": "otro pack de tiras y parches", "precio": 120000},
               "M2": {"plantilla": "voltra_mk_pack", "oferta": "el pack de tiras y parches", "precio": 120000}}
       }
     },
     "cruzada": {"plantilla": "voltra_mk_cruzada", "precio": 79000},
     "lanzamiento": {"plantilla": "voltra_mk_lanzamiento"},
     "topes": {"por_mes": 3, "por_semana_dias": 7, "sin_leer_para_bajar": 2, "por_mes_reducido": 1,
               "dias_sin_leer_fuera": 60},
     "palabras_baja": ["baja", "no quiero ofertas", "no quiero mas ofertas", "stop"]
   }'::jsonb)
on conflict (clave) do nothing;
