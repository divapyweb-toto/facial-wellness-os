# Despliegue del WhatsApp de Voltra a producción

Todo se corre desde la carpeta `fw-os` en la Terminal de la Mac.
**[ENRIQUE]** = solo lo podés hacer vos. El resto lo hace el script.
Ningún valor secreto va al repo (es público): viven en `.env.produccion`, que está en `.gitignore`.

## Una sola vez

| # | Qué | Cómo |
|---|---|---|
| 1 | Instalar la CLI de Supabase | `brew install supabase/tap/supabase` (instala la herramienta) · si ya está: `brew upgrade supabase` (el script necesita `supabase db query`) |
| 2 | **[ENRIQUE]** Iniciar sesión en Supabase | `supabase login` (abre el navegador para entrar con tu cuenta) |
| 3 | **[ENRIQUE]** Completar las variables | `cp .env.produccion.ejemplo .env.produccion` y completar cada valor. Al lado de cada una dice de dónde sale. Obligatorias: Supabase (ref, contraseña de la base, service role **legacy JWT `eyJ...`**), WhatsApp (5), Shopify (3), Telegram (3) y `PRUEBA_TELEFONO`. Opcionales: `WA_APP_ID` y las claves de las olas 2-4 (vacías = modo simulado), incluidas `FACTURASEND_TENANT`, `QR_CLIENT_ID`, `QR_WEBHOOK_SECRET`, `QR_AMBIENTE` y `META_TEST_EVENT_CODE`. |
| 4 | **[ENRIQUE]** Número de prueba | Un teléfono tuyo para `PRUEBA_TELEFONO`. Si todavía no tenés el número real de Voltra, en developers.facebook.com → tu app → WhatsApp → Configuración de la API, agregá tu teléfono como destinatario del número de prueba de Meta. |
| 5 | **[ENRIQUE]** PIN de verificación en 2 pasos | WhatsApp Manager → Números de teléfono → tu número → Verificación en dos pasos → elegir un PIN de 6 dígitos. No se escribe en ningún archivo: el script lo pide por teclado con `--registrar-numero`. |
| 6 | **[ENRIQUE]** Permisos de la app de Shopify | Dev Dashboard → la app de Voltra: `read_orders`, `write_orders`, `read_draft_orders` y los de fulfillment. Agregar uno pide reinstalar la app. |

## Pasos manuales de las olas 2-4 (una vez, después del primer despliegue)
| # | Qué | Cómo |
|---|---|---|
| 7 | **[ENRIQUE]** Tu WhatsApp para las derivaciones | SQL Editor: `update public.config_wa set valor = valor \|\| '{"whatsapp_enrique":"595XXXXXXXXX"}' where clave = 'vendedor';` |
| 8 | **[ENRIQUE]** Formulario (WhatsApp Flow) | WhatsApp Manager → Flows → crear con `supabase/flows/formulario_pedido.json` → Publicar. Copiar el id: `update public.config_wa set valor = valor \|\| '{"flow_id":"<id>"}' where clave = 'vendedor';` |
| 9 | **[ENRIQUE]** Precios ×2 y ×3 del vendedor | `config_wa.vendedor_ofertas` arranca vacío: cargar `{"<handle>": {"2": 125000, "3": 155000}}` con los precios vigentes de Shopify. |
| 10 | **[ENRIQUE]** Conversión personalizada | Administrador de eventos → Conversiones personalizadas → sobre el evento `PedidoEntregado` del conjunto de datos de campañas. |
| 11 | **[ENRIQUE]** Plantilla de factura (solo si activás `ola4.factura`) | WhatsApp Manager → crear `voltra_seguimiento_factura` (UTILITY, encabezado DOCUMENTO, cuerpo igual al seguimiento) y esperar aprobación. |

Las olas 3 y 4 vienen apagadas o en simulado: sin clave = simulado; factura, QR y recuperación con `activo: false` en `config_wa`.

Chequeo sin cambiar nada (recomendado antes de la primera vez):
```bash
bash scripts/desplegar.sh --solo-verificar   # revisa herramientas, variables, archivos y el estado remoto; no cambia nada
```

## El despliegue: un comando
```bash
bash scripts/desplegar.sh --registrar-numero --plantillas   # la primera vez
bash scripts/desplegar.sh                                    # las siguientes (es idempotente: repetirlo no duplica nada)
```

Qué hace, en orden (cada paso lo anuncia en una línea antes de hacerlo):

| Paso | Qué hace | Para saltarlo |
|---|---|---|
| 1 | Chequea `supabase`, `deno`, `node`, que estén todas las variables (sin mostrarlas), que los webhooks tengan `verify_jwt = false` en `config.toml` | — |
| 2 | `supabase link` al proyecto | `--saltar-link` |
| 3 | `supabase db push`: TODAS las migraciones de `supabase/migrations/` que falten, en orden. Después las semillas `supabase/seed_*.sql` (primero `seed_config_wa.sql`) y los secretos de Vault `project_url` y `service_role_key` (crea o actualiza; `service_role_key` = `SUPABASE_SERVICE_ROLE_KEY`, si no los crons dan 401) | `--saltar-db` |
| 4 | `supabase secrets set` con los secretos de las funciones (archivo temporal que se borra al final) | `--saltar-secretos` |
| 5 | Despliega TODAS las carpetas de `supabase/functions/` menos `_shared` | `--saltar-funciones` |
| 6 | Webhooks: Meta (suscribe la app a la WABA y comprueba el GET de verificación), Shopify (por API con el token de la app, **no** desde Notificaciones de la tienda, que firma con otra clave; no duplica), Telegram (`setWebhook` con `secret_token`). Con `--registrar-numero`, antes registra el número con tu PIN | `--saltar-webhooks` |
| 7 | Plantillas: solo las valida; con `--plantillas` las manda a aprobación de Meta (tarda de minutos a 24 h) | — |
| 8 | Prueba de punta a punta en modo seguro: funciones responden, tablas existen, firma inválida da 401, un pedido de PRUEBA firmado programa los 4 envíos; después los cancela y borra el pedido. No manda nada | `--saltar-e2e` · `--e2e-real` manda la confirmación de verdad a `PRUEBA_TELEFONO` |

**[ENRIQUE]** Sin `WA_APP_ID`, la URL del webhook de Meta se pone una vez a mano: developers.facebook.com → tu app → WhatsApp → Configuración → Webhook → URL `https://<ref>.supabase.co/functions/v1/wa-webhook`, token = `WA_VERIFY_TOKEN`, campos `messages`, `phone_number_quality_update`, `account_update`, `message_template_status_update`. Con `WA_APP_ID` lo hace el script.

Qué se puede romper: la migración 0001 agrega la columna `tienda` (default `'fw'`) a `ventas`, `entregas`, `productos`, `gastos`, `campanas_ads`, `stock_movimientos` y `recompra_log`. No cambia datos y las pantallas actuales no la usan.

## Prueba con un pedido real (cierre de la ola 1)
Con las plantillas aprobadas, **[ENRIQUE]** hacé un pedido en Releasit con tu teléfono:

| # | Acción | Qué tiene que pasar |
|---|---|---|
| 1 | Pedido de prueba | En menos de 2 min llega la confirmación con Confirmar / Corregir datos / Cancelar |
| 2 | Tocar **Confirmar** | Respuesta "Listo …"; tag `CONFIRMADO` en Shopify; aviso en Telegram |
| 3 | Importar un CSV de Lucero o PaP con ese pedido despachado (entre 8 y 20 h) | Llega `voltra_pedido_despachado` una sola vez; tag `DESPACHADO` |
| 4 | Reimportar el mismo CSV | No se manda nada de nuevo |
| 5 | Tocar **Necesito ayuda** y responder desde la Bandeja | Chat a "humano", aviso en Telegram, la respuesta llega; con palabra prohibida no sale |

Crons (SQL Editor): `select jobname, schedule from cron.job;` y `select status, return_message from cron.job_run_details order by start_time desc limit 10;`

## Si algo sale mal
| Síntoma | Causa probable |
|---|---|
| El script dice que falta `supabase db query` | CLI vieja: `brew upgrade supabase` |
| Meta no verifica la URL | `WA_VERIFY_TOKEN` distinto en el panel y en `.env.produccion`, o `wa-webhook` no desplegada |
| `wa-webhook` responde 401 | `WA_APP_SECRET` equivocado |
| `shopify-webhook` responde 401 a pedidos reales | El webhook se creó desde Notificaciones de la tienda; borrarlo y repetir el paso 6 |
| Crons con "Faltan los secretos de Vault" o 401 | Paso 3 salteado, o la service role no es la legacy `eyJ...` |
| Mensajes bloqueados con `config_palabras_prohibidas_no_disponible` | Falta la semilla (paso 3) |
