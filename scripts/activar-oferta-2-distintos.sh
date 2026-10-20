#!/bin/bash
# scripts/activar-oferta-2-distintos.sh · para el 21-10 (decisión de Enrique 19-10; nunca el 22 ni el 23).
# 1) activa el prompt v36 (supabase/vendedor/prompt_sistema.md, con la regla de 2 distintos y "1 de cada");
# 2) prende el interruptor config_wa.vendedor.oferta_2_distintos.
# Apagar: bash scripts/activar-oferta-2-distintos.sh --apagar   (interruptor en false + vuelve el prompt v35)
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"; cd "$RAIZ"
set -a; . ./.env.produccion; set +a
U="https://$SUPABASE_PROJECT_REF.supabase.co/rest/v1"; H=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json")
VALOR=$(curl -s "$U/config_wa?select=valor&clave=eq.vendedor" "${H[@]}" | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)[0]['valor']))")
if [ "${1:-}" = "--apagar" ]; then
  NUEVO=$(echo "$VALOR" | python3 -c "import json,sys;v=json.load(sys.stdin);v['oferta_2_distintos']=False;print(json.dumps(v))")
  curl -s -X PATCH "$U/config_wa?clave=eq.vendedor" "${H[@]}" -d "{\"valor\": $NUEVO}" >/dev/null
  node scripts/volver-version-vendedor.mjs --version 35
  echo "Oferta APAGADA y prompt v35 ($(TZ=America/Asuncion date '+%d-%m %H:%M PY'))"; exit 0
fi
node scripts/activar-prompt.mjs
NUEVO=$(echo "$VALOR" | python3 -c "import json,sys;v=json.load(sys.stdin);v['oferta_2_distintos']=True;print(json.dumps(v))")
curl -s -X PATCH "$U/config_wa?clave=eq.vendedor" "${H[@]}" -d "{\"valor\": $NUEVO}" >/dev/null
echo "Oferta 2 distintos PRENDIDA ($(TZ=America/Asuncion date '+%d-%m %H:%M PY')): $(curl -s "$U/config_wa?select=valor->oferta_2_distintos&clave=eq.vendedor" "${H[@]}")"
