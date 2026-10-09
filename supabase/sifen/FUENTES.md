# Fuentes oficiales SIFEN (XSD y documentos)

Descarga: **2026-10-08** (agente B). Archivos copiados **sin modificar** desde el índice público de la DNIT.
Repo público: aquí solo hay material oficial y público; nada de secretos.

## Origen de los XSD

- Índice oficial: https://ekuatia.set.gov.py/sifen/xsd/ (47 archivos; todos copiados a `xsd/`).
- Página de documentación técnica (DNIT): https://www.dnit.gov.py/web/e-kuatia/documentacion-tecnica
- Fecha de publicación según el servidor (`Last-Modified`): **19-09-2025** para todos, salvo
  `EventoCanc_v141`, `EventoInut_v141`, `RecEventoCanc_v141` y `RecEventoInut_v141` (08-11-2018).
- Los XSD incluyen sus dependencias con URL absoluta (`https://ekuatia.set.gov.py/sifen/xsd/...`).
  `validar_xsd.ts` las reescribe **en memoria** a nombres locales; los archivos en disco quedan idénticos.
- El adjunto "Estructura_DE xsd.rar" de la página de la DNIT es un XML de 2018 (obsoleto): no se usa.

## XSD que usa el sistema (v150, producción vigente)

| Archivo | Versión | Para qué | SHA-256 (16 primeros) |
|---|---|---|---|
| siRecepDE_v150.xsd | 150 | Raíz `rDE` (lo que valida `validar(xml, "rDE")`) | c4f566981645ca42 |
| DE_v150.xsd | 150 | Estructura del DE | 83435e6aa50c3695 |
| DE_Types_v150.xsd | 150 | Tipos simples del DE | 99c5c2ca69eaf567 |
| Departamentos_v141.xsd | 141 | Catálogo de departamentos | 1de13902a775dce8 |
| Unidades_Medida_v141.xsd | 141 | Catálogo de unidades (77 = UNI) | 8a25e5e5decc0540 |
| Monedas_v150.xsd | 150 | Catálogo de monedas (PYG = Guarani) | 16520dd42b5a6e46 |
| Paises_v100.xsd | 100 | Catálogo de países (PRY) | b75edd6b8ee0a101 |
| xmldsig-core-schema.xsd | W3C 2002 (copia DNIT) | Firma `ds:Signature` | f2c353a1238799c8 |
| siRecepEvento_v150.xsd | 150 | Raíz `gGroupGesEve` (eventos) | 27cb5b1438894427 |
| Evento_v150.xsd | 150 | Eventos (rEve, rGeVeCan, rGeVeInu…) | 30321c18269bbf12 |
| Evento_Types_v150.xsd | 150 | Tipos de eventos | 0402d380cdea0b80 |
| WS_SiRecepDE_v150.xsd | 150 | WS recepción DE (para ws.ts) | 4fc96d1999027748 |
| WS_SiRecepEvento_v150.xsd | 150 | WS recepción de eventos | 0d7b804be6743401 |
| protProcesDE_v150.xsd | 150 | Respuesta de procesamiento | 86868979b97d9de8 |
| WS_SiRecepLoteDE_v141.xsd | 141 (última publicada) | WS recepción lote | c5bf03098c2f4c9f |
| WS_SiConsDE_v141.xsd | 141 (última publicada) | WS consulta DE | 61efae1d4804e5d8 |
| WS_SiConsLote_v141.xsd | 141 (última publicada) | WS consulta lote | 204ab6aef6ceef1e |
| WS_SiConsRUC_v141.xsd | 141 (última publicada) | WS consulta RUC | 8802c027530f07d8 |
| SIFEN_Types_v141.xsd / FE_Types_v141.xsd | 141 | Tipos que importan los WS v141 | b8e6d2c5b2ffd097 / 70c5a1cab165802a |

Los demás archivos de `xsd/` (versiones v141 del DE, `*_Ekuatiai_*` de la solución gratuita, consultas
DTE/archivo RUC, eventos receptor/SET) se guardan como espejo completo del índice oficial.
Nota: no existen `siRecepLoteDE_v150.xsd`, `siConsDE_v150.xsd`, `siConsRUC_v150.xsd` (404): los WS de
lote/consulta siguen publicados como `WS_*_v141.xsd`. `siRecepRDE_v150.xsd` incluye `RDE_Group.xsd`,
que **no está publicado** en el índice (no se usa).

## Documentos de referencia (no se guardan en el repo; se leyeron el 2026-10-08)

| Documento | URL (dnit.gov.py) | Usado para |
|---|---|---|
| Manual Técnico v150 (sept. 2019, 217 págs.) | /documents/20123/420592/Manual+T%C3%A9cnico+Versi%C3%B3n+150.pdf | Campos, CDC (§10.1-10.3), QR (§13.8), eventos (§11.5), validaciones |
| Notas Técnicas NT 1 a NT 27 (NT 27 del 09-03-2026, la última) | /documents/20123/420595/NT_E_KUATIA_0xx_MT_V150.pdf | NT 7 (dInfoFisc NR), NT 10 (dSerieNum inutilización, dKmR 1-1), NT 13 (dBasExe), NT 23/24 (innominado, tope ₲7.000.000) |
| Guía de Pruebas para e-kuatia | /documents/20123/424160/Guia+de+Pruebas+para+e-kuatia.pdf | CSC genéricos de test: IdCSC 0001 = `ABCD0000000000000000000000000000`, 0002 = `EFGH0000000000000000000000000000` (públicos); leyendas de prueba |

## Verificaciones hechas contra estas fuentes

- CDC del ejemplo del MT `01444444017001001001452822017012515873260988`: DV módulo 11 = 8 (test).
- QR del ejemplo del MT: cHashQR `97ddbb3c1e7d65af03a70ffe21f2b34846ab1c89e0566c35222086766b7374ed` (test).
- Los 5 tipos de DE generados (FE, AF, NC, ND, NR) + firma ficticia + gCamFuFD validan contra
  `siRecepDE_v150.xsd`; cancelación e inutilización validan contra `siRecepEvento_v150.xsd`
  (motores xmllint-wasm 5.1.0 y /usr/bin/xmllint libxml 2.9.13).
