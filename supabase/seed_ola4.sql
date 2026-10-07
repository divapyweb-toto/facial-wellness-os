-- Semillas de la ola 4 (I1). on conflict do nothing: no pisa lo que Enrique cambie.
-- TODAS las banderas arrancan en false. Para activar una:
--   update public.config_wa set valor = jsonb_set(valor, '{activo}', 'true') where clave = 'ola4.factura';
--
-- ola4.factura  → factura electrónica (FacturaSend) al pasar a ENTREGADO + PDF en el seguimiento.
--   [VERIFICAR con el contador] establecimiento/punto/numero_inicial, IVA (10 %) y tipo de pago.
--   claves_datos_fiscales: nombres del campo de RUC en el formulario de Releasit (note_attributes). [VERIFICAR con 10 pedidos reales]
-- ola4.qr       → cobro por QR (AdamsPay / arnipay) y webhook de pago.
-- ola4.recuperacion → un mensaje a borradores abandonados de Releasit (1 a 24 h).
--   claves_consentimiento: nombres de los note_attributes del borrador que prueban la aceptación de WhatsApp.
--   Vacía = solo se escribe a quien ya tiene consentimiento 'si' registrado en wa_consentimientos. Sin evidencia: no se manda.
insert into public.config_wa (clave, valor) values
  ('ola4.factura',
   '{"activo": false, "establecimiento": 1, "punto": "001", "numero_inicial": 1, "iva": 10, "formato_kude": "a4", "dias_url_pdf": 7,
     "claves_datos_fiscales": ["factura", "ruc", "datos de factura", "ruc y razon social"],
     "maximo_intentos": 3, "tolerancia_gs": 1, "tag_pagado_qr": "PAGADO_QR", "plantilla_seguimiento": "voltra_seguimiento_factura"}'::jsonb),
  ('ola4.qr',
   '{"activo": false, "validez_horas": 48, "etiqueta": "Pedido Voltra {pedido}", "tag_shopify": "PAGADO_QR", "tolerancia_gs": 0,
     "texto_oferta": "Si querés, podés pagarlo ahora con QR y lo despachamos primero: {url}",
     "aviso_courier": {"lucero": "YA PAGADO - NO COBRAR", "pap": "forma de pago: Pagado"}}'::jsonb),
  ('ola4.recuperacion',
   '{"activo": false, "plantilla": "voltra_recuperar_borrador", "min_horas": 1, "max_horas": 24, "limite": 30,
     "claves_consentimiento": [], "horario": {"desde": 8, "hasta": 21}}'::jsonb)
on conflict (clave) do nothing;
