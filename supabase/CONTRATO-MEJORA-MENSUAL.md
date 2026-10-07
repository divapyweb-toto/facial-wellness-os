# Contrato · Ciclo mensual de mejora del vendedor y de reclamos (06-10-2026)

Valen todas las reglas de `CONTRATO-OLA1.md` y `CONTRATO-OLAS2-4.md` (repo público, Deno + TS, lógica pura con tests, modo simulado sin claves, textos y tarifas en `config_wa`, palabras prohibidas, horario de Asunción, `_shared/auth_servicio.ts` en funciones de cron).

## Objetivo
El día 1 de cada mes (09:00 Asunción) el sistema analiza las conversaciones del mes anterior, aprende qué vende y qué resuelve reclamos, propone cambios versionados, los prueba con la batería de 50 y pide aprobación por Telegram. **Costo objetivo: menos de USD 3 por mes**, con un tope duro en `config_wa.mejora_mensual.tope_usd` (default 3). Si la estimación previa supera el tope, recorta la muestra y lo informa.

## NO tocar (los está editando otro subagente en paralelo)
`_shared/vendedor/*`, `supabase/vendedor/prompt_sistema.md`, `supabase/seed_vendedor.sql`, `functions/vendedor/*`, `functions/auditoria-diaria/reglas.ts`, `supabase/vendedor/pruebas/*`, `scripts/probar-vendedor.mjs`. Se pueden **leer e importar**. El enganche para que el vendedor lea la versión activa del prompt desde la base lo hace la integración final.

## Esquema (migración `supabase/migrations/20261006000012_mejora_mensual.sql`, dueño M1)
| Tabla o vista | Columnas clave |
|---|---|
| `vendedor_versiones` | `id uuid`, `numero int unique`, `estado text check in ('activa','propuesta','descartada','archivada')`, `prompt text`, `ejemplos jsonb`, `faq jsonb`, `objeciones jsonb`, `origen text` ('semilla','mejora_mensual','manual'), `ciclo_id uuid null`, `creado_en`, `activada_en`, `notas text`. Índice único parcial: una sola fila `activa`. |
| `mejora_ciclos` | `id uuid`, `mes date` (primer día del mes analizado) unique, `estado text` ('recolectando','clasificando','sintetizando','probando','esperando_aprobacion','aplicado','descartado','sin_datos_suficientes','error'), `n_conversaciones int`, `lote_id text`, `costo_usd numeric`, `resumen jsonb`, `hallazgos jsonb`, `propuesta_version_id uuid null`, `prueba jsonb`, `telegram_message_id bigint`, `error text`, `creado_en`, `actualizado_en` |
| `mejora_clasificaciones` | `ciclo_id`, `conversacion_id`, `etiquetas jsonb`, `unique(ciclo_id, conversacion_id)` |
| `mejora_cambios` | `id`, `ciclo_id`, `version_id`, `tipo text` ('ejemplo','orden_objeciones','faq','prompt_tono', 'precio','afirmacion','palabra_prohibida','politica_reclamos','derivacion'), `riesgo text check in ('bajo','requiere_decision')`, `antes jsonb`, `despues jsonb`, `motivo text`, `aplicado bool default false` |
| vista `conversacion_resultado` | por conversación: `conversacion_id`, `cliente_id`, `shopify_order_id` (pedido vinculado por cliente y ventana de 7 días después del último mensaje, o por `ORIGEN_WHATSAPP`), `resultado` ('entregado','devuelto','rechazado','cancelado','en_curso','sin_compra'), `costo_ia_usd`, `costo_mensajes_usd`, `tuvo_reclamo bool`, `paso_escalera int null`, `derivado bool` |
RLS como las demás. La semilla de `vendedor_versiones` (número 1, `activa`, `origen 'semilla'`) toma el prompt actual de `supabase/vendedor/prompt_sistema.md` — la carga la integración.

## Módulos (todos en `supabase/functions/mejora-mensual/`)
| Archivo | Dueño | Exporta |
|---|---|---|
| `tipos.ts` | M1 | `Etiquetas` = {etapa: 'consulta'\|'interes'\|'objecion'\|'cierre'\|'postventa'\|'reclamo', objecion_principal: string\|null, respuesta_que_movio: string\|null, errores_bot: string[], reclamo: {hubo: bool, tipo: string\|null, paso_resuelto: 1..5\|null, derivado: bool}, emocion: 'neutral'\|'enojo'\|'abandono'\|'satisfecho', debio_derivar: bool}; `Hallazgos`; `Propuesta`; `Cambio` |
| `anonimizar.ts` | M1 | `anonimizar(texto, ctx) → {texto, mapa}`: teléfonos (cualquier formato PY), nombres conocidos del cliente, direcciones, emails, RUC/CI, números de pedido → códigos `[TEL_1]`, `[NOMBRE_1]`, `[DIR_1]`, `[DOC_1]`, `[PEDIDO_1]`. Nunca sale texto crudo hacia Claude. |
| `datos.ts` | M1 | `recolectarMes(mes) → ConversacionParaAnalizar[]` (mensajes anonimizados + resultado de `conversacion_resultado`), muestreo si hay demasiadas para el tope |
| `clasificar.ts` | M1 | `armarLoteClasificacion(convs)`, `leerResultadosLote(lote)` con `llamarClaudeLote`/`consultarLote` de `_shared/claude.ts` (Haiku 4.5, Batch, salida JSON validada con esquema; reintento de las inválidas una vez) |
| `sintetizar.ts` | M2 | `sintetizar(agregados) → Hallazgos` con Sonnet 5.5 sobre **agregados** (conteos, tasas por objeción/respuesta contra entregado, ejemplos anonimizados cortos), nunca conversaciones crudas. Correlación con **ENTREGADO**, no con venta. |
| `proponer.ts` | M2 | `proponer(hallazgos, versionActiva) → {version: borrador, cambios: Cambio[]}`; clasifica riesgo; los `requiere_decision` se listan pero **no** se incluyen en la versión a aplicar automáticamente |
| `probar.ts` | M2 | `probarVersion(version) → {aprobada: bool, casos: n, prohibidas: n, precios_fuera: n, tono_prom, detalle}` usando la batería de `supabase/vendedor/pruebas/` y las reglas de `auditoria-diaria/reglas.ts` (y `supabase/vendedor/adaptador_vendedor.ts` si sirve en Deno). Una sola palabra prohibida o un solo precio fuera de catálogo ⇒ descartada. |
| `aprobacion.ts` + `index.ts` | M3 | máquina de estados del ciclo (idempotente, reanudable entre corridas del cron porque el Batch tarda), mensaje de Telegram corto con botones `mej_aplicar:<ciclo>`, `mej_descartar:<ciclo>`, `mej_detalle:<ciclo>`, y en el mensaje de confirmación `mej_volver:<version>`; aplicar = la propuesta pasa a `activa` y la anterior a `archivada`; volver = reactiva la versión indicada |
| cron | M3 | `supabase/migrations/20261006000013_cron_mejora_mensual.sql`: día 1 a las 12:00 UTC (09:00 Asunción) y reintentos cada 30 min los días 1-3 hasta que el ciclo salga de los estados intermedios |

**Callbacks de Telegram:** M3 es el único autorizado a editar `functions/telegram-webhook/` para sumar los `mej_*` sin romper los tests existentes.

**Umbral:** si el mes tuvo menos de 100 conversaciones (`config_wa.mejora_mensual.min_conversaciones`, default 100), el ciclo queda `sin_datos_suficientes`, manda un reporte corto por Telegram con los números y **no propone cambios**.

Nadie toca `package.json`, `App.jsx` ni archivos de otro.

---

## Cómo quedó de verdad (integración, 06-10-2026)
La sección de arriba es el contrato original. Lo que sigue es lo que efectivamente corre.

### Firmas entre módulos
| Paso (aprobacion.ts → DepsCiclo) | Implementación en `index.ts` | Nota |
|---|---|---|
| `recolectar(mes)` | `recolectarMes` (M1) → `enlaces.recoleccionParaCiclo` | `total` = conversaciones del mes con el mínimo de mensajes (antes de muestrear); es lo que se compara con `min_conversaciones` |
| `crearLote(muestra)` | `armarLoteClasificacion` + `enviarLoteClasificacion` (M1) | devuelve `ids` del lote; aprobacion.ts los guarda en `mejora_ciclos.resumen.muestra_ids` |
| `consultarLote(id, ciclo)` | `leerResultadosLote(id, convs de la muestra, cfg, {esperados: resumen.muestra_ids})` | en la corrida siguiente del cron no hay convs en memoria: los ids alcanzan para detectar las que no volvieron (cuentan como inválidas y se reintentan una vez) |
| `agregados(cicloId)` | `agregar()` de M2 sobre `mejora_clasificaciones` + vista `conversacion_resultado` (`enlaces.convsClasificadas`), con el `mes` del ciclo | correlación con ENTREGADO |
| `sintetizar(ag)` | `sintetizar(ag, {modelo: cfg.modelo_sintesis})` (M2) → `enlaces.sintesisParaCiclo` | M2 devuelve `HallazgosSintesis` con `costo_usd` adentro; M3 recibe `{hallazgos, costo_usd}` |
| `proponer(h, activa)` | `proponer()` de M2 (síncrono) envuelto en async | |
| `probar(v)` | `probarVersion(v, {semilla: filas de config_wa, base: activa, topeUsd: restante})` | |
Las envolturas puras están en `mejora-mensual/enlaces.ts` (con tests).

### Salida estructurada (Claude)
`_shared/claude.ts` acepta `esquemaJson` en el pedido → `output_config.format = {type:"json_schema", schema}` (GA, sin header beta, también en Batch; verificado en la documentación oficial el 06-10-2026). No se combina con prefill.
| Módulo | Uso | Respaldo |
|---|---|---|
| `clasificar.ts` | intento 1 con `ESQUEMA_ETIQUETAS` (sin prefill) | el reintento de las inválidas va sin esquema y con prefill `{` (camino anterior) |
| `sintetizar.ts` | `ESQUEMA_SINTESIS` (contenido de la sugerencia con todos los campos opcionales) | si la API responde 400 por el esquema, repite sin esquema |
La validación propia (`validarEtiquetas`, `validarSalida`) sigue igual en los dos.

### La batería en producción
Una Edge Function solo despliega lo que importa. Por eso:
| Pieza | Cómo viaja |
|---|---|
| Casos `supabase/vendedor/pruebas/NN_*.json` y `_comun.json` | `mejora-mensual/bateria_embebida.ts`, generado con `node scripts/generar-bateria-embebida.mjs` (`--verificar` solo compara). `bateria_embebida_test.ts` falla si quedó desfasado |
| `supabase/vendedor/adaptador_vendedor.ts` y `evaluador.mjs` | import estático desde `probar.ts`; `supabase functions deploy --use-api` (lo que usa `scripts/desplegar.sh`) sube también los archivos importados fuera de `functions/` (dentro del repo) |
| Semilla del vendedor | `index.ts` pasa las filas reales de `config_wa`; `seed_vendedor.sql` del disco solo se lee en corridas locales |
No hace falta `static_files` en `config.toml`.

### Versiones del prompt
| Qué | Dónde |
|---|---|
| Versión 1 (`activa`, origen `semilla`) con el prompt de `prompt_sistema.md` | `supabase/seed_vendedor_versiones.sql`, generado con `node scripts/generar-seed-versiones.mjs` (comillas de dólar `$prompt_v1$`; solo inserta si la tabla está vacía; `on conflict do nothing`). `semillas_test.ts` verifica que coincide con el .md |
| El vendedor usa la versión activa | `_shared/vendedor/version_activa.ts` + `io.ts`: plantilla = prompt + orden de objeciones + FAQ + ejemplos (la misma función que usa la batería). Caché en memoria de 5 min (1 min tras un error) |
| Precedencia | versión activa > `config_wa.vendedor_prompt` > prompt del archivo. Si la versión no trae las 5 llaves del prompt, se usa el archivo y queda en el log |

### Configuración
`supabase/seed_mejora_mensual.sql` siembra `config_wa.mejora_mensual` (`tope_usd` 3, `min_conversaciones` 100, `reparto_clasificacion` 0,7, modelos Haiku 4.5 / Sonnet 5.5, tamaños, `chars_por_token` 3, `reserva_usd` 0,75, `usd_por_conversacion` 0,002) con `on conflict do nothing` y un merge que solo agrega claves faltantes. `precios_claude` lo siembra `seed_vendedor.sql`.
**Producción:** ninguna semilla pisa valores existentes de `config_wa` (en particular `vendedor.tope_mensual_usd` y `vendedor.whatsapp_enrique`); `semillas_test.ts` lo controla y se probó en un Postgres embebido aplicando todas las semillas dos veces.
