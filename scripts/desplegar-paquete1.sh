#!/bin/bash
# scripts/desplegar-paquete1.sh · 19-10-2026 · Vendedor: paquete 1 (roturas). NO cambia el prompt (sigue la v34).
# Pasos: 1) migraciones (tope de IA a USD 90 + alertas; tablas de modificaciones de pedido) → 2) funciones.
# Volver atrás: bash scripts/volver-vendedor-codigo.sh vendedor-pre-paquete1
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
set -a; . ./.env.produccion; set +a
for m in 20261019000001_tope_ia_preparado 20261019000002_modificaciones_pedido; do
  echo "→ migración $m"
  supabase db query --linked -f "supabase/migrations/$m.sql" >/dev/null
  supabase migration repair --linked --status applied "${m%%_*}" >/dev/null
done
for f in vendedor wa-webhook seguimiento-chat shopify-webhook meta-lead-reenviar recuperar-borradores; do
  echo "→ función $f"
  supabase functions deploy "$f" --project-ref "$SUPABASE_PROJECT_REF" --use-api 2>&1 | grep -E "Deployed|rror" || true
done
echo "✅ Paquete 1 desplegado: $(TZ=America/Asuncion date '+%d-%m %H:%M') PY"
