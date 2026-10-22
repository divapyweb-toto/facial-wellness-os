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
trap 'rm -f "$TMP" "$TMP.err"' EXIT
cd "$(dirname "$0")/.."
SQL="select phone_sha256, coalesce(email_sha256, '') as email_sha256 from public.publico_excluir_rechazos order by 1"

for intento in 1 2 3; do
  # -o csv: mismo formato en cualquier terminal (sin esto, la terminal interactiva muestra una tabla).
  # Solo stdout son datos; los avisos de la herramienta (login, versión nueva) van a stderr y se guardan aparte.
  SALIDA="$(supabase db query --linked -o csv "$SQL" 2>"$TMP.err")"
  if printf '%s' "$SALIDA" | python3 -c '
import sys, csv
lineas = [l for l in sys.stdin.read().splitlines() if l.strip()]
try:
    i = next(k for k, l in enumerate(lineas) if l.startswith("phone_sha256"))
except StopIteration:
    sys.exit(1)
import re
filas = [r for r in csv.DictReader(lineas[i:]) if re.fullmatch(r"[0-9a-f]{64}", r.get("phone_sha256") or "")]
if not filas:
    sys.exit(2)
print("phone,email")
for r in filas:
    print(r["phone_sha256"] + "," + (r.get("email_sha256") or ""))
' > "$TMP"; then
    mv "$TMP" "$ARCH"
    echo "$(($(wc -l < "$ARCH") - 1)) clientes → $ARCH"
    exit 0
  fi
  echo "Intento $intento: la base no respondió bien; reintento en 5 s…" >&2
  sleep 5
done
echo "No se pudo exportar. Último mensaje de la base:" >&2
{ printf '%s\n' "$SALIDA"; cat "$TMP.err" 2>/dev/null; } | grep -vE "new version|recommend|Initialising" | tail -5 >&2
echo "El archivo anterior (si había) quedó sin tocar." >&2
exit 1
