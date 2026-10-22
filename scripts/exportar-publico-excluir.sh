#!/bin/bash
# Exporta el público de EXCLUSIÓN para Meta (clientes que rechazaron o devolvieron un pedido en 2026) desde la vista
# public.publico_excluir_rechazos. Solo hashes SHA-256 de teléfono (E.164 sin '+') y email (minúsculas). Nada en claro.
# El archivo se escribe FUERA del repo (es público): por defecto ~/Negocios/datos-meta/. Regenerar cada semana.
#   ./scripts/exportar-publico-excluir.sh [carpeta_destino]
set -euo pipefail
DEST="${1:-$HOME/Negocios/datos-meta}"
mkdir -p "$DEST"
ARCH="$DEST/excluir-rechazos-$(date +%Y-%m-%d).csv"
cd "$(dirname "$0")/.."
supabase db query --linked "select phone_sha256, coalesce(email_sha256, '') as email_sha256 from public.publico_excluir_rechazos order by 1" 2>/dev/null \
  | python3 -c '
import sys, json, re
s = sys.stdin.read(); t = s[s.index("{"):s.rindex("}") + 1]; t = re.sub(r",(\s*[}\]])", r"\1", t)
filas = json.loads(t)["rows"]
print("phone,email")
for r in filas:
    print(r["phone_sha256"] + "," + r["email_sha256"])
' > "$ARCH"
echo "$(($(wc -l < "$ARCH") - 1)) clientes → $ARCH"
