# Contrato olas 2, 3 y 4 (06-10-2026)

Complementa `CONTRATO-OLA1.md` (sus reglas valen todas: repo público, Deno + TS, lógica pura con tests, nada de secretos ni datos reales, textos y tarifas en `config_wa`, palabras prohibidas, horario Asunción). Referencia funcional: `docs/Voltra_Plan_construccion_WhatsApp.md` (olas 2-4, mejoras, riesgos) y `docs/Voltra_WhatsApp_venta_postventa_recompra.md` (prompt del vendedor, glosario, reglas de estilo, recompra, reclamos, marco legal).

## Reglas extra
- **Modo simulado obligatorio:** toda integración externa nueva (Claude, ElevenLabs, OpenAI, Meta CAPI, FacturaSend, QR) funciona sin credencial: si falta la clave o `MODO_SIMULADO=1`, usa un simulador determinista y lo deja registrado. Los tests nunca llaman a APIs reales.
- **Migraciones:** cada subagente crea SU archivo (`supabase/migrations/2026100600000N_*.sql`, número asignado abajo), idempotente, sin tocar las anteriores. **Semillas:** cada uno en su propio `supabase/seed_<area>.sql` (on conflict do nothing). **Crons:** en su propia migración, mismo patrón que `20261006000003_crons.sql` (Vault `project_url` y `service_role_key`), y las funciones de cron usan `_shared/auth_servicio.ts`.
- Decisión de Enrique (6-oct): el vendedor atiende 24 h y **crea el pedido solo** (con aviso a Telegram y botón para cancelarlo). Haiku 4.5 y Sonnet 5.5 se comparan lado a lado en la batería de 50; si Haiku pasa (0 palabras prohibidas, 0 precios inventados, tono igual de natural) va Haiku; si no, Sonnet con tope de USD 45. El modelo vive en `config_wa.vendedor.modelo`.
- Modelos (verificá IDs y precios vigentes en la documentación oficial de Anthropic antes de fijarlos): `claude-haiku-4-5-20251001`, `claude-sonnet-5-5`.

## Secretos nuevos (nombres)
ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, META_CAPI_TOKEN, META_DATASET_ID, META_DATASET_MENSAJERIA_ID, FACTURASEND_API_KEY, QR_PROVEEDOR, QR_API_KEY. (OPENAI_API_KEY solo en scripts locales de comparación, nunca en funciones.)

## Interfaces compartidas
| Archivo | Dueño | Exporta |
|---|---|---|
| `_shared/claude.ts` | G1 | `llamarClaude({modelo, system, mensajes, herramientas, maxTokens, cache:true}) → {contenido, uso:{entrada,salida,cache_lectura,cache_escritura}, costo_usd, simulado}`; `llamarClaudeLote(pedidos)` (Batch API, con simulador) |
| `_shared/vendedor/herramientas.ts` | G1 | definiciones de herramientas (JSON schema) + ejecutores: `consultar_catalogo`, `estado_pedido`, `crear_pedido_cod`, `derivar_a_enrique`, `enviar_media`, `pedir_ubicacion`, `enviar_formulario`, `enviar_opciones` (carrusel ×1/×2/×3), `pedir_telefono` |
| `_shared/vendedor/filtro_salida.ts` | G1 | `revisarRespuesta(texto, {catalogo, prohibidas, afirmaciones}) → {ok, motivos[]}` (palabras prohibidas, precios que no están en el catálogo de ESTA conversación, promesas de salud, > 3 líneas, > 1 pregunta, > 1 emoji) |
| `_shared/wa_interactivos.ts` | G2 | constructores: `ubicacionRequest`, `flowFormulario`, `carruselOpciones`, `pedirContacto` (REQUEST_CONTACT_INFO), `botonesSiNo`; parsers de respuestas entrantes: `parsearUbicacion`, `parsearFlow` (nfm_reply), `parsearContacto` |
| `_shared/transcripcion.ts` | G2 | `transcribirAudio(bytes, mime, {palabrasClave}) → {texto, confianza, simulado}` (ElevenLabs Scribe v2) |
| `_shared/meta_capi.ts` | H2 | `enviarEventoEntregado({pedido, telefonoE164, valor, moneda:'PYG', origenAnuncio?}) → {ok, simulado}` (teléfono con SHA-256, event_id = `entregado:<order_id>` para no duplicar) |
| `_shared/shopify_pagos.ts` | H2 | `marcarPagado(orderGid)` (orderMarkAsPaid) |
| `_shared/facturacion.ts` | I1 | `emitirFactura(pedido, datosFiscales) → {ok, pdf_url?, cdc?, simulado}` (FacturaSend) |
| `_shared/pago_qr.ts` | I1 | `crearCobroQR(pedido) → {ok, url, qr_texto?, simulado}`; `verificarWebhookQR(raw, headers)` |

## Esquema nuevo (cada uno en su migración)
| Migración | Dueño | Contenido |
|---|---|---|
| `20261006000004_ola2_vendedor.sql` | G1 | `vendedor_turnos` (conversacion_id, mensaje_entrada_id, modelo, uso jsonb, costo_usd, herramientas jsonb, respuesta, filtro jsonb, regenerado bool, derivado bool, creado_en); `wa_conversaciones` + `turnos_ia int default 0`, `costo_ia_usd numeric default 0`; `wa_pedidos_chat` (datos que junta el vendedor antes de crear el pedido) |
| `20261006000005_ola3_recompra.sql` | H1 | `recompra_plan` (cliente_id, shopify_order_id, tipo M1/M2/CRUZADA/LANZAMIENTO, dia_objetivo date, estado, clave_unica unique); `wa_marketing_tope` (cliente_id, mes, enviados, sin_leer_seguidos, ultimo_envio) |
| `20261006000006_ola3_entregas.sql` | H2 | `shopify_pedidos` + `entregado_en timestamptz`, `pagado_marcado bool default false`, `capi_enviado bool default false`; vista `kpi_whatsapp_semanal` |
| `20261006000007_ola4.sql` | I1 | `facturas` (shopify_order_id, ruc, razon_social, estado, cdc, pdf_url, error), `cobros_qr` (shopify_order_id, proveedor, estado, monto, url, id_externo), `recuperacion_borradores` (draft_id, estado, enviado_en) |

## Dueños y archivos
| Sub | Ola | Archivos (solo estos) |
|---|---|---|
| G1 · Vendedor | 2 | `_shared/claude.ts`, `_shared/vendedor/*`, `functions/vendedor/`, `supabase/vendedor/prompt_sistema.md`, `seed_vendedor.sql` (glosario, afirmaciones permitidas, fichas, envío y plazos, lista de aceptaciones, límites de turnos, modelo), migración 0004. **Único autorizado a editar** `functions/wa-webhook/` para: (a) pasar los mensajes de conversaciones en estado 'ia' al vendedor (vía `EdgeRuntime.waitUntil` + fetch a `functions/v1/vendedor` con service role), (b) transcribir audios con `_shared/transcripcion.ts` antes de pasarlos, (c) parsear ubicación/flow/contacto con `_shared/wa_interactivos.ts`. Sin romper los 156 tests existentes |
| G2 · Audios y cierre | 2 | `_shared/wa_interactivos.ts`, `_shared/transcripcion.ts`, `supabase/flows/formulario_pedido.json` (WhatsApp Flow estático: nombre, ciudad, dirección, referencia), `scripts/comparar-transcripcion.mjs` (Scribe vs OpenAI sobre una carpeta local de audios; sin carpeta, explica cómo usarlo) |
| G3 · Batería y auditoría | 2 | `supabase/vendedor/pruebas/*.json` (50 conversaciones), `scripts/probar-vendedor.mjs` (simulado por defecto; `--real --modelos haiku,sonnet` para lado a lado con informe de costo, palabras prohibidas, precios inventados y tono), `supabase/vendedor/evaluador.ts` o `.mjs`, `functions/auditoria-diaria/` (Batch con Haiku sobre las conversaciones de ayer → Telegram solo lo raro), migración de su cron en `20261006000008_cron_auditoria.sql` |
| H1 · Recompra | 3 | `functions/recompra/` (cron diario), lógica del calendario (bolsas de 30, M1 = min(0,85·D, D−7), M2 = D/0,8 − 3, venta cruzada día 14, afinidades, topes 3/mes y 1/semana, 2 sin leer → 1/mes, 60 días sin leer → fuera, BAJA), `supabase/plantillas/voltra_mk_*.json` (MARKETING con botón de baja), `seed_recompra.sql`, migración 0005 + su cron |
| H2 · Post-entrega y KPI | 3 | `functions/post-entrega/` (cron: pedidos con estado ENTREGADO no procesados → `marcarPagado`, `entregado_en`, CAPI al dataset de campañas y al de mensajería si hay origen de anuncio), `_shared/meta_capi.ts`, `_shared/shopify_pagos.ts`, `src/pages/kpi-whatsapp/` (panel semanal; ruta y menú los suma la integración), migración 0006 + su cron |
| I1 · Extras ola 4 | 4 | `_shared/facturacion.ts`, `_shared/pago_qr.ts`, `functions/factura/`, `functions/pago-qr-webhook/`, `functions/recuperar-borradores/` (un solo mensaje, solo si el borrador trae el consentimiento), migración 0007; todo detrás de banderas en `config_wa` (`ola4.factura`, `ola4.qr`, `ola4.recuperacion`) apagadas por defecto, `seed_ola4.sql` |
| J · Despliegue | — | `scripts/desplegar.sh`, `scripts/registrar-webhooks.mjs`, `scripts/prueba-e2e.mjs`, `.env.produccion.ejemplo`, `supabase/DESPLIEGUE.md`. Descubre funciones, migraciones y semillas por carpeta (corre al final, incluye lo de todos) |

Nadie toca `package.json`, `App.jsx`, `Layout.jsx` ni archivos de otro; la integración final los une.

## Integración (06-10-2026): cómo quedó de verdad
Si algo de arriba contradice esto, manda esto.

| Tema | Cómo quedó |
|---|---|
| Pedido del vendedor | `orderCreate` (Admin GraphQL 2026-10, pago pendiente como un COD de Releasit), **no** `draftOrderComplete`. En dos pasos: `crear_pedido_cod` con `confirmar=false` muestra el resumen con botones (`vend_conf`); con `confirmar=true` lo crea, solo después del sí del cliente. Aviso a Telegram con botón para cancelarlo. |
| Herramientas del vendedor | `consultar_catalogo`, `estado_pedido`, `crear_pedido_cod`, `derivar_a_enrique` (con `motivo`, uno es `salud`), `enviar_media`, `pedir_ubicacion`, `enviar_formulario`, `enviar_opciones`, `pedir_telefono`. |
| Derivación por salud | El texto que el modelo escribe junto con `derivar_a_enrique` ya no se descarta: pasa por el filtro de salida y va arriba del botón. Con `motivo: salud` y si el texto no nombra al médico, se antepone "Eso te conviene consultarlo con tu médico." (`config_wa.vendedor_textos.derivacion_salud`). |
| `_shared/claude.ts` | Interfaz más amplia que la de arriba: `llamarClaude({modelo, system, mensajes, herramientas?, maxTokens?, cache?, ttlCache?, esfuerzo?, fallbackServidor?}) → {contenido (bloques), stop_reason, uso, costo_usd, simulado, modelo}`; además `llamarClaudeLote`, `consultarLote`, `parsearResultadosLote`, `simularRespuesta`, `calcularCostoUsd`. |
| Meta CAPI | Dataset de campañas: evento propio `PedidoEntregado`, `action_source: system_generated` (sobre él se arma la conversión personalizada). Dataset de mensajería: `OrderDelivered` estándar, `action_source: business_messaging` (no admite eventos personalizados). `event_id = entregado:<order_id>`. |
| Botones de recompra (`wa-webhook`) | `mk_baja:<id>` o el texto "No quiero ofertas" / "BAJA" (`esPedidoDeBaja`, lista en `config_wa.recompra.palabras_baja`) → `registrarBaja` + `config_wa.textos_marketing.baja_confirmada`. `mk_luego` → `textos_marketing.mas_adelante` y nada más. `mk_si`, `mk_pack`, `mk_una`, `mk_quiero` → el vendedor recibe `[oferta aceptada] …` con la oferta del último envío de marketing y arma el pedido con `crear_pedido_cod`. Si el chat está en `humano`, no se le saca a Enrique: le llega el aviso. Sin pedido (lanzamiento) el payload es `<prefijo>:0`. |
| Error 131050 | El cliente apagó "Ofertas y anuncios": `procesar-envios` (respuesta del envío) y `wa-webhook` (estado `failed`) llaman `registrarBaja(cliente, 'meta_131050')`; el envío queda `cancelado` y no se reintenta. La migración `0010` suma `meta_131050` al check de `wa_consentimientos.origen`. |
| Factura (ola 4) | Con `config_wa['ola4.factura'].activo`: `post-entrega` llama `facturarPedidoEntregado` (su falla no frena pagado ni CAPI; la reintenta el cron de `factura`) y `procesar-envios` pregunta `envioSeguimientoParaPedido` antes de `voltra_seguimiento_entrega` (si hay factura con PDF sale `voltra_seguimiento_factura`). Adaptador: FacturaSend (`FACTURASEND_API_KEY` + `FACTURASEND_TENANT`). |
| QR (ola 4) | Con `config_wa['ola4.qr'].activo`: tras `conf_si`, `wa-webhook` llama `ofrecerCobroQR` y manda su texto. Adaptadores AdamsPay y arnipay (`QR_PROVEEDOR`, `QR_API_KEY`, `QR_CLIENT_ID` solo arnipay, `QR_WEBHOOK_SECRET`, `QR_AMBIENTE`). |
| Plantillas | `crear-plantillas-wa.mjs`: MARKETING solo para `voltra_mk_*` (y esas tienen que ser MARKETING); el resto UTILITY. 11 válidas. `procesar-envios` conoce las 11. |
| Horario de marketing | **8 a 21** (`config_wa.horario_marketing`), según el plan del 6-oct, que es más nuevo que el documento de mensajes (decía 8 a 20 en "topes"). Los avisos de envío siguen 8 a 20 (`horario_avisos_envio`). |
| Transcripción | Costo con `config_wa.transcripcion.usd_por_hora` (0,27 = Scribe v2 con palabras clave); si falta, el valor del código. |
| Bandeja | `config_wa.auditoria.url_bandeja` = `https://divapyweb-toto.github.io/facial-wellness-os/#/bandeja` (HashRouter); la auditoría agrega `?c=<id>` y la Bandeja abre esa conversación. |
| Semillas nuevas | `seed_integracion.sql`: `transcripcion`, `auditoria.url_bandeja`, `textos_marketing` (merge sin pisar). |

### Falta confirmar
- Precios de oferta de recompra, unidades por bolsa y patrones de producto contra Shopify (`seed_recompra.sql`).
- Datos fiscales con el contador (`seed_ola4.sql`) y el campo de RUC de Releasit.
- Tarifa vigente de ElevenLabs y de Claude antes de fijar el modelo.
- Batería con Claude real (`node scripts/probar-vendedor.mjs --real --modelos haiku,sonnet`; tiene costo).
- La plantilla `voltra_seguimiento_factura` (encabezado documento) todavía no tiene JSON en `supabase/plantillas/`.
