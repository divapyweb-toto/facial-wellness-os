#!/bin/bash
# Exporta el público de EXCLUSIÓN para Meta (clientes que rechazaron o devolvieron un pedido en 2026) desde la vista
# public.publico_excluir_rechazos. Solo hashes SHA-256 de teléfono (E.164 sin '+') y email (minúsculas). Nada en claro.
# El archivo se escribe FUERA del repo (es público): por defecto ~/Negocios/datos-meta/. Regenerar cada semana.
#   ./scripts/exportar-publico-excluir.sh [carpeta_destino]
# 22-10: reintenta si la conexión a la base falla (pasa de vez en cuando) y solo reemplaza el archivo si salió bien.
set -uo pipefail
DEST="${1:-$HOME/Negocios/datos-meta}"
mkdir -p "$DEST"
ARCH="$DEST/excluir-rechazos-$(date +%Y-%m-%d).csv"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cd "$(dirname "$0")/.."
SQL="select phone_sha256, coalesce(email_sha256, '') as email_sha256 from public.publico_excluir_rechazos order by 1"

for intento in 1 2 3; do
  SALIDA="$(supabase db query --linked "$SQL" 2>&1)"
  if printf '%s' "$SALIDA" | python3 -c '
import sys, json, re
s = sys.stdin.read()
if "\"rows\"" not in s:
    sys.exit(1)
t = s[s.index("{"):s.rindex("}") + 1]
t = re.sub(r",(\s*[}\]])", r"\1", t)
filas = json.loads(t)["rows"]
if not filas or any(len(r["phone_sha256"]) != 64 for r in filas):
    sys.exit(2)
print("phone,email")
for r in filas:
    print(r["phone_sha256"] + "," + r["email_sha256"])
' > "$TMP"; then
    mv "$TMP" "$ARCH"
    echo "$(($(wc -l < "$ARCH") - 1)) clientes → $ARCH"
    exit 0
  fi
  echo "Intento $intento: la base no respondió bien; reintento en 5 s…" >&2
  sleep 5
done
echo "No se pudo exportar. Último mensaje de la base:" >&2
printf '%s\n' "$SALIDA" | grep -vE "new version|recommend" | tail -5 >&2
echo "El archivo anterior (si había) quedó sin tocar." >&2
exit 1
