# Sistema de diseño — Facial Wellness OS v4

Guía corta para que cualquier pantalla nueva se vea y se sienta parte del
sistema. Todo vive en `src/index.css`. **Regla de oro: si vas a escribir un
estilo inline, primero fijate si ya existe la primitiva.**

## Identidad

| Elemento | Valor |
|---|---|
| Fondo | Negro profundo `#060606` con luz ambiental verde ácido |
| Acento | Verde ácido `#c8f135` — la firma de la marca |
| Títulos de página | Barlow Condensed **itálica 800 MAYÚSCULAS** (eco del logo) |
| Números | Space Grotesk, siempre `tabular-nums` (la plata alineada) |
| Cuerpo | Inter |
| Movimiento | Resortes (`--ease-spring`), 100–300 ms, respeta `prefers-reduced-motion` |

## Jerarquía de texto

`--text-primary` #f2f2f2 → contenido · `--text-secondary` #9a9a9a → apoyo ·
`--text-muted` #6a6a6a → etiquetas. **No usar grises propios**: la escala ya
está calibrada para leerse al sol en el celular.

## Primitivas (qué usar para qué)

| Necesitás | Usá | No uses |
|---|---|---|
| Mini-título en mayúsculas | `.section-label` | un div con fontSize 10 a mano |
| Ficha etiqueta+valor | `.data-row` + `.data-col` + `.data-label` + `.data-value` | flex inline |
| Número protagonista (guía) | `.guia-card` + `.guia-num` | card con borde accent |
| Resumen del día (dashboard) | `.hero` + `.hero-stat` | kpi-grid |
| Accesos grandes tappables | `.quick-actions` + `.quick-action` | botones sueltos |
| Campo de búsqueda protagonista | `.search-field` (input adentro sin clase) | form-input |
| Fila-resultado tappable | `.list-card` | card con onClick |
| Opciones tipo chip (motivos) | `.chip-choice` (+ `.active`) | btn-sm con estilos |
| Texto copiable / preview | `.copy-block` | pre con estilos |
| Carga | `.skeleton` + `.skeleton-title/-kpi/-hero/-page` | spinner suelto |
| KPI con label | `.kpi-card` (`.kpi-value.green/.yellow/.red`) | — |
| Tabla en móvil | `<table class="tabla-responsive">` + `data-label` en cada td | tabla pelada |

## Reglas de producto

1. **Escritorio es el caso principal (80% del uso); el móvil, el momento
   crítico.** En pantalla grande: densidad, tablas completas, ⌘K. En el
   celular: impecable para las urgencias (buscar pedido, reclamar) — botones
   ≥46px, inputs a 16px (evita el zoom de iOS), toda tabla con
   `.table-wrapper` y `data-label`.
2. **Estados vacíos guían**: `.empty-state` siempre con título + qué hacer.
3. **Errores en español y con acción**: qué pasó + qué hacer, nunca el código pelado.
4. **La plata en `tabular-nums`** — columnas de montos que no bailan.
5. **Verde ácido = marca e interacción primaria.** Semáforos: `--green/--yellow/--red`.
   No mezclar: el acento no es un color de estado.
6. **Nada de valores de negocio en el código** — precios, tarifas y umbrales
   van a Config (ver auditoría F-04).
