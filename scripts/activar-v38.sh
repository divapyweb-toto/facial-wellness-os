#!/bin/bash
# scripts/activar-v38.sh · 21-10-2026 (miércoles, día del bot; nunca el 22, web, ni el 23, Meta).
# v38: "quiero / me interesa / mandame…" escrito = botón "Quiero 1" (intencion.ts); ningún seguimiento automático si el
# cliente escribió hace menos de 120 min o hay un pedido a medio armar (seguimiento-chat); el resumen con solo el pin
# dice "la ubicación que mandaste"; retiro: listo para retirar sin prometer aviso y la hora 1 vez por día.
# 1) despliega vendedor y seguimiento-chat; 2) activa el prompt (supabase/vendedor/prompt_sistema.md → v38).
# Volver atrás: bash scripts/activar-v38.sh --volver   (prompt v37 + funciones del vendedor como en la etiqueta vendedor-pre-v38)
# Apagar solo una parte sin volver todo: config_wa.vendedor.intencion_escrita = false · config_wa.vendedor_seguimiento
# .min_desde_cliente_min = 0 / .frenar_medio_armado = false.
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"; cd "$RAIZ"
set -a; . ./.env.produccion; set +a
if [ "${1:-}" = "--volver" ]; then
  node scripts/volver-version-vendedor.mjs --version 37
  bash scripts/volver-vendedor-codigo.sh vendedor-pre-v38
  echo "Vuelto a v37 ($(TZ=America/Asuncion date '+%d-%m %H:%M PY'))"; exit 0
fi
DIA=$(TZ=America/Asuncion date '+%d-%m')
if [ "$DIA" = "22-10" ] || [ "$DIA" = "23-10" ]; then
  [ "${1:-}" = "--forzar" ] || { echo "Hoy es $DIA: no se cambia el bot (22 = web, 23 = Meta). Si igual querés: --forzar"; exit 1; }
fi
for f in vendedor seguimiento-chat; do supabase functions deploy "$f" --project-ref "$SUPABASE_PROJECT_REF" --use-api 2>&1 | grep -E "Deployed|rror"; done
node scripts/activar-prompt.mjs
echo "v38 ACTIVA: $(TZ=America/Asuncion date '+%d-%m %H:%M:%S PY')"
