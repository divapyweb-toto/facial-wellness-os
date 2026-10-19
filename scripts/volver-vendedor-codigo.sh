#!/bin/bash
# scripts/volver-vendedor-codigo.sh · 19-10-2026 (interruptor del encargo v35)
# Vuelve a desplegar las funciones del vendedor tal como estaban en un commit o etiqueta de git
# (por ejemplo `vendedor-pre-paquete1`), sin tocar tu copia de trabajo: usa un worktree temporal.
#   bash scripts/volver-vendedor-codigo.sh vendedor-pre-paquete1
# Funciones: vendedor, wa-webhook, seguimiento-chat, shopify-webhook, meta-lead-reenviar, pedidos-trabados.
# El prompt se vuelve atrás aparte: node scripts/volver-version-vendedor.mjs --version 34
set -euo pipefail
REF="${1:?Pasá el commit o la etiqueta de git a la que querés volver}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$RAIZ/.env.produccion"; set +a
TMP="$(mktemp -d)"
git -C "$RAIZ" worktree add --detach "$TMP/fw-os" "$REF" >/dev/null
trap 'git -C "$RAIZ" worktree remove --force "$TMP/fw-os" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
cd "$TMP/fw-os"
for f in vendedor wa-webhook seguimiento-chat shopify-webhook meta-lead-reenviar pedidos-trabados; do
  echo "→ $f ($REF)"
  supabase functions deploy "$f" --project-ref "$SUPABASE_PROJECT_REF" --use-api 2>&1 | grep -E "Deployed|rror" || true
done
echo "Listo: funciones del vendedor en $REF ($(date '+%d-%m %H:%M'))"
