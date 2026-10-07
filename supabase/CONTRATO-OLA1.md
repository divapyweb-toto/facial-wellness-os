# Contrato ola 1 · WhatsApp post-venta (06-10-2026)

Este archivo es la fuente única para todos los que construyen la ola 1. Si algo no cierra, se cambia acá primero.
Referencias funcionales: `docs/Voltra_Plan_construccion_WhatsApp.md` y `docs/Voltra_WhatsApp_venta_postventa_recompra.md` (locales, ignorados por Git).

## Reglas
- El repo es PÚBLICO: nada de secretos, teléfonos ni datos de clientes en el código, los tests ni los fixtures (usar 0981000000 y nombres inventados).
- Edge Functions en Deno + TypeScript, en `supabase/functions/<nombre>/index.ts`. Lo compartido va en `supabase/functions/_shared/`.
- Lógica pura separada del I/O (archivo propio), con tests `*_test.ts` (`deno test`).
- Graph API `v25.0`, Shopify Admin GraphQL `2026-10`.
- Webhooks: verificar la firma, guardar en `eventos_crudos` ANTES de procesar, descartar repetidos por `(fuente, id_externo)`, responder 200 rápido y procesar con `EdgeRuntime.waitUntil`.
- Textos, tarifas, horarios, palabras prohibidas y plazos van en `config_wa` (datos), nunca en el código.
- Nada a clientes sin consentimiento (`wa_consentimientos`) cuando la plantilla es de marketing. Las de utilidad (pedido) sí salen.
- Palabras prohibidas en cualquier texto saliente: garantía, devolución, reembolso, "sin riesgo", cura/curar, tratamiento, oxígeno.
- Zona horaria: America/Asuncion. Marketing solo de 8:00 a 21:00. Utilidad y respuestas, las 24 h.

## Secretos (nombres; los valores los carga Enrique con `supabase secrets set`)
WA_TOKEN, WA_PHONE_NUMBER_ID, WA_WABA_ID, WA_APP_SECRET, WA_VERIFY_TOKEN,
SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET.
(SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya los inyecta Supabase.)

## Esquema (migración `supabase/migrations/20261006000001_ola1_whatsapp.sql`)
Todas con RLS activado; política: usuarios `authenticated` pueden leer/escribir; el service role pasa por encima.

| Tabla | Columnas clave |
|---|---|
| `wa_clientes` | `id uuid pk default gen_random_uuid()`, `wa_user_id text unique null` (BSUID), `telefono text unique null` (E.164 +5959XXXXXXXX), `wa_username text`, `nombre text`, `creado_en`, `actualizado_en` |
| `wa_consentimientos` | `id`, `cliente_id fk`, `tipo text check in ('utilidad','marketing')`, `estado text check in ('si','no','baja')`, `origen text` ('releasit','chat','boton'), `creado_en` |
| `wa_conversaciones` | `id`, `cliente_id fk`, `estado text check in ('ia','humano','cerrada') default 'ia'`, `asignado_a text`, `ultima_entrada_en timestamptz` (ventana de 24 h), `origen_anuncio_id text`, `creado_en` |
| `wa_mensajes` | `id`, `conversacion_id fk`, `cliente_id fk`, `direccion text check in ('in','out')`, `wa_message_id text unique`, `tipo text`, `texto text`, `contenido jsonb`, `estado text` ('recibido','enviado','entregado','leido','fallido'), `categoria_precio text`, `costo_usd numeric`, `error jsonb`, `creado_en` |
| `eventos_crudos` | `id bigserial`, `fuente text check in ('whatsapp','shopify','telegram','courier')`, `id_externo text`, `payload jsonb`, `recibido_en`, `procesado_en`, `error text`, `unique(fuente,id_externo)` |
| `shopify_pedidos` | `shopify_order_id bigint pk`, `nombre text` ('#1001'), `cliente_id fk null`, `telefono text`, `total numeric`, `estado_confirmacion text default 'pendiente'` ('pendiente','confirmado','a_corregir','cancelado_cliente','retenido','cancelado_sin_respuesta'), `estado_envio text null` (ver EstadoEnvio), `courier text`, `tags text[]`, `es_borrador bool default false`, `raw jsonb`, `creado_en`, `actualizado_en` |
| `pedido_estados` | `id`, `shopify_order_id fk`, `estado text`, `fuente text`, `notificado bool default false`, `creado_en`, `unique(shopify_order_id, estado)` ← garantiza "un aviso por cambio de estado" |
| `envios_programados` | `id`, `cliente_id fk`, `shopify_order_id bigint null`, `plantilla text`, `variables jsonb`, `categoria text check in ('utilidad','marketing')`, `enviar_desde timestamptz`, `estado text default 'pendiente'` ('pendiente','enviado','cancelado','fallido'), `clave_unica text unique`, `intentos int default 0`, `ultimo_error text`, `creado_en` |
| `courier_revision` | `id`, `courier text`, `referencia text`, `fila jsonb`, `motivo text`, `resuelto bool default false`, `creado_en` |
| `config_wa` | `clave text pk`, `valor jsonb`, `actualizado_en` (semillas: `palabras_prohibidas`, `horario_marketing` {desde:8,hasta:21}, `plazos_courier` {lucero:"1 a 3 días hábiles", pap:"2 a 5 días hábiles; interior, hasta 10"}, `tarifas_usd` {utilidad:0.0113, marketing:0.074}, `confirmacion` {recordatorio_h:4, retener_h:48, cancelar_h:72}) |

Además: `alter table` de `ventas`, `entregas`, `productos`, `gastos`, `campanas_ads`, `stock_movimientos`, `recompra_log` → `tienda text not null default 'fw' check (tienda in ('fw','voltra'))`. No toca nada más de esas tablas.
Realtime: publicar `wa_mensajes` y `wa_conversaciones`.

## Tipos y módulos compartidos (`supabase/functions/_shared/`)
| Archivo | Dueño | Exporta |
|---|---|---|
| `tipos.ts` | A | `type EstadoEnvio = 'EN_PREPARACION'\|'DESPACHADO'\|'INTENTO_FALLIDO'\|'ENTREGADO'\|'NO_ENTREGADO_RESCATABLE'\|'NO_ENTREGADO'\|'CANCELADO'\|'RENDIDO'`; tipos de filas de las tablas |
| `db.ts` | A | `db()` → cliente Supabase con service role; `guardarEventoCrudo(fuente, idExterno, payload): Promise<boolean>` (false si repetido) |
| `telefono.ts` | A | `normalizarTelefonoPY(x: string): string \| null` → '+5959XXXXXXXX' |
| `horario.ts` | A | `ahoraAsuncion()`, `dentroHorarioMarketing(d: Date, cfg)`, `proximaAperturaMarketing(d, cfg)` |
| `filtro.ts` | A | `contienePalabraProhibida(texto, lista): string \| null` |
| `wa.ts` | B | `verificarFirmaMeta(rawBody, header, appSecret)`, `enviarPlantilla(to, nombre, idioma, componentes)`, `enviarTexto(to, texto)`, `enviarBotones(to, texto, botones[{id,titulo}])`, `marcarLeidoYEscribiendo(messageId)`; todos devuelven `{ok, wa_message_id?, error?}` y aplican el filtro de palabras prohibidas |
| `shopify.ts` | C | `tokenShopify()` (client credentials, cachea 24 h), `gql(query, vars)`, `verificarHmacShopify(rawBody, header, secret)`, `agregarTags(orderGid, tags[])`, `quitarTags(orderGid, tags[])`, `cancelarPedido(orderGid, motivo)`, `crearEventoEnvio(orderGid, estado)` (crea el fulfillment con `notifyCustomer:false` si no existe) |
| `telegram.ts` | D | `avisar(texto, botones?: {texto, callback}[][])`, `verificarSecretoTelegram(header)` |
| `estados_courier.ts` | E | `traducirEstado(courier: 'lucero'\|'pap', estadoCrudo, extra?): EstadoEnvio \| null` (tabla del plan) |

Callbacks de Telegram (formato `accion:shopify_order_id`): `reponer:<id>`, `escribo:<id>`, `cancelar:<id>`.
IDs de botones de WhatsApp en la confirmación: `conf_si:<id>`, `conf_corregir:<id>`, `conf_cancelar:<id>`.
Tags en Shopify: CONFIRMADO, A_CORREGIR, CANCELADO_CLIENTE, RETENIDO_SIN_RESPUESTA, DESPACHADO, ENTREGADO, NO_ENTREGADO, ORIGEN_WHATSAPP.

## Funciones y dueños
| Subagente | Carpeta / archivos | Hace |
|---|---|---|
| A · Datos | `supabase/migrations/`, `_shared/{tipos,db,telefono,horario,filtro}.ts`, `supabase/seed_config_wa.sql` | Esquema de arriba, RLS, semillas de config, tests de los módulos puros |
| B · WhatsApp | `functions/wa-webhook/`, `_shared/wa.ts` | GET de verificación; POST con firma; mensajes entrantes (texto, audio → copia a Storage `wa-media` antes de 5 min, botones); estados (guarda categoría y costo); respuestas a botones de confirmación → `shopify_pedidos`, tags, aviso por Telegram, cancela envíos pendientes del pedido |
| C · Shopify | `functions/shopify-webhook/`, `functions/shopify-conciliar/`, `_shared/shopify.ts` | orders/create, orders/updated, draft_orders/create (tag `abandoned_checkout_releasit_cod_form` → solo guardar, no mandar); upsert cliente y pedido; programa confirmación (+2 min), recordatorio (+4 h), retención (+48 h) y cancelación (+72 h) en `envios_programados`; conciliación horaria |
| D · Telegram | `functions/telegram-webhook/`, `_shared/telegram.ts` | Avisos (pedido nuevo, chat que necesita a Enrique, fallas), botones de decisión, enlace wa.me al cliente; `functions/salud-canal/` (cada 15 min: en horario, 3 h sin entrantes o envíos fallidos → aviso) |
| E · Bandeja y CSV | `functions/importar-courier/`, `_shared/estados_courier.ts`, `src/pages/bandeja/`, `src/lib/importarCourierWA.js` | Recibe filas ya parseadas por los parsers existentes (`src/lib/exportLucero.js`, `src/lib/importarPaP.js`), traduce estado, inserta en `pedido_estados` (unique = una vez), programa el aviso, carga el evento en Shopify, filas sin pedido → `courier_revision`. Bandeja en vivo (Supabase Realtime) para leer/responder y tomar/devolver chats |
| F · Plantillas y envíos | `supabase/plantillas/*.json`, `scripts/crear-plantillas-wa.mjs`, `functions/procesar-envios/` | Plantillas de utilidad del documento de mensajes (confirmación con 3 botones, recordatorio, despacho, entrega hoy, no entregado, seguimiento); script que las manda a aprobación por API; función cron (cada minuto) que procesa `envios_programados` vencidos respetando horario y consentimiento |

Nadie toca `package.json`, `App.jsx` ni archivos de otro subagente; la integración final los une.

## Integración (06-10-2026): cómo quedó de verdad
Lo que cambió respecto de lo de arriba al unir el trabajo de A a F. Si algo de arriba contradice esto, manda esto.

| Tema | Cómo quedó |
|---|---|
| Cancelación a las 72 h | `procesar-envios` cancela si el pedido sigue `pendiente` **o** `retenido` (la retención de las 48 h lo deja en `retenido`, que también es "sin respuesta"). La retención de las 48 h actúa solo sobre `pendiente`. |
| `ahoraAsuncion()` | Devuelve un objeto `PartesAsuncion` ({anio, mes, dia, hora, minuto, segundo, ...}), no un `Date`. |
| `verify_jwt` | `false` en `wa-webhook`, `shopify-webhook` y `telegram-webhook` (`supabase/config.toml`): Meta, Shopify y Telegram no mandan JWT de Supabase; cada una verifica su firma o secreto. El resto (`procesar-envios`, `salud-canal`, `shopify-conciliar`, `importar-courier`, `wa-enviar-manual`) queda con `verify_jwt` activo. Además las 3 de cron aceptan SOLO la service role (`_shared/auth_servicio.ts`: Bearer comparado en tiempo constante contra `SUPABASE_SERVICE_ROLE_KEY`); anon key o usuario → 401. |
| Idioma de plantillas | `"es"` (Meta no tiene `es_PY`). |
| Reclamos | No hay tabla de reclamos. "Reponer" desde Telegram queda registrado en `eventos_crudos` (fuente `telegram`, tipo `reclamo_reposicion`). |
| BSUID | Si el cliente no tiene teléfono, `_shared/wa.ts` manda con `recipient: <wa_user_id>` en lugar de `to`. |
| Cambios de webhook que no son `messages` | `wa-webhook` guarda `phone_number_quality_update`, `account_update`, `message_template_status_update`, etc. en `eventos_crudos` con `id_externo = chg:<field>:<sha256>` y payload `{field, value, entry_id, time}`. No los procesa: los lee `salud-canal` (excluye `msg:%` y `st:%`). |
| Telegram desde `wa-webhook` | Los textos se escapan a HTML en `wa-webhook/index.ts` (el aviso trae lo que escribió el cliente). |
| `respuestas_confirmacion` | Claves `confirmado`, `a_corregir`, `cancelado` (también acepta `conf_si`, `conf_corregir`, `conf_cancelar`). Variables `{nombre}`, `{plazo}` (de `plazos_courier` según el courier del pedido), `{pedido}`. |
| `prefijos_courier` | `{"lucero": ["VT-","FW-"], "pap": []}`. `FW-` queda aceptado en la transición para no perder envíos de Voltra que se carguen en Lucero con el prefijo viejo. Riesgo anotado: una fila `FW-` de un pedido real de Facial Wellness no está en `shopify_pedidos` (es otra tienda) → va a `courier_revision`; si el número coincide con un pedido de Voltra y la fila trae teléfono distinto, `importar-courier` la manda a revisión (`telefono_no_coincide`) en lugar de avisar al cliente equivocado. Cuando no quede nada en tránsito con `FW-`, sacarlo de la lista. |
| Avisos de envío de noche | `voltra_pedido_despachado`, `voltra_entrega_hoy` y `voltra_no_entregado` solo salen dentro de `config_wa.horario_avisos_envio` (`{desde:8, hasta:20}`); si vencen afuera, `procesar-envios` los reprograma a la próxima apertura. Confirmación y recordatorio, 24 h. |

### IDs de botón (WhatsApp → `wa-webhook`)
| ID | Viene de | Qué hace |
|---|---|---|
| `conf_si:<order_id>` / `conf_corregir:<order_id>` / `conf_cancelar:<order_id>` | confirmación y recordatorio | Igual que arriba. |
| `ayuda:<order_id>` | despachado, entrega hoy | Chat a `humano`, respuesta al cliente, aviso a Telegram con resumen (estado del envío) y botones "Le escribo yo" + wa.me. |
| `ne_reintentar:<order_id>` | no entregado | Respuesta al cliente y aviso para coordinar el reintento con el courier. |
| `ne_direccion:<order_id>` | no entregado | Pide la dirección nueva, chat a `humano`, aviso. |
| `ne_cancelar:<order_id>` | no entregado | Respuesta y aviso con botón `cancelar:<order_id>` (decide Enrique). |
| `seg_bien:<order_id>` | seguimiento de entrega | Si el cliente nunca respondió el consentimiento: texto libre con botones `cons_si:<cliente_id>` / `cons_no:<cliente_id>`. Si ya respondió (sí, no o baja): solo agradece; no se vuelve a preguntar. |
| `seg_problema:<order_id>` | seguimiento de entrega | Chat a `humano`, respuesta, aviso como reclamo con botones `reponer:<id>` y `escribo:<id>`. |
| `cons_si:<cliente_id>` / `cons_no:<cliente_id>` | consentimiento del día 0 | Inserta en `wa_consentimientos` (`tipo 'marketing'`, `estado 'si'/'no'`, `origen 'boton'`). Solo si el `cliente_id` es el de quien toca. |

Todos verifican que el pedido sea del cliente que toca; si no, no responden y avisan.

### Claves de `config_wa` (todas en `supabase/seed_config_wa.sql`)
`palabras_prohibidas`, `horario_marketing`, `plazos_courier`, `tarifas_usd`, `confirmacion` (+ `confirmar_min: 2`), `aceptaciones`, `respuestas_confirmacion`, `plantillas_cancelables_al_responder`, `textos_botones`, `textos_decisiones` ({cancelado, reposicion, escribo} con `{nombre}` y `{pedido}`), `prefijos_courier`, `usar_texto_libre_en_ventana` (false), `textos_libres` ({}), `horario_avisos_envio`, `procesar_envios`, `salud_canal`. La escribe el sistema: `salud_ultimo_aviso`. Si falta una clave, cada función usa el valor por defecto de su código y lo deja en el log.

### Funciones nuevas o completadas en la integración
| Función | Qué hace |
|---|---|
| `wa-enviar-manual` | POST `{conversacion_id, texto}` desde la bandeja con el JWT del usuario (se valida con `auth.getUser`). Solo con ventana de 24 h abierta. Pasa el chat a `humano` (`asignado_a 'enrique'`) y manda con `enviarTexto` (filtro de palabras prohibidas + registro en `wa_mensajes`). Devuelve `{ok, wa_message_id?, error?}`. |
| Crons (`migrations/20261006000003_crons.sql`) | pg_cron + pg_net: `procesar-envios` cada minuto, `salud-canal` cada 15 min, `shopify-conciliar` cada hora. URL y service role desde Vault (`project_url`, `service_role_key`). |

### Deno y pruebas
- `supabase/functions/deno.json`: imports de `@std/assert` y `@supabase/supabase-js`, `"lock": false` y lint sin la regla `no-import-prefix`. El código sigue usando especificadores `jsr:`/`npm:` en línea a propósito: así cada función se despliega igual aunque la CLI de Supabase no lea ese `deno.json` de la carpeta padre.
- `deno.lock` no se versiona (`.gitignore`).
- `npm test` incluye `tests/plantillas-wa.test.mjs` (plantillas + semilla de `config_wa` sin palabras prohibidas). `npm run test:functions` corre los tests de Deno.
