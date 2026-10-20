#!/bin/bash
# scripts/activar-v37.sh · para el miércoles 21-10 (nunca el 22, web, ni el 23, Meta).
# Paquete 2: gancho según el anuncio (wa-webhook pasa el texto del anuncio), retiro en Área 1 y colores.
# 1) config_wa.vendedor_retiro con dirección, horario y el WhatsApp de Enrique (sale de config_wa.vendedor.whatsapp_enrique;
#    el número no se escribe en el repo); 2) despliega wa-webhook y vendedor; 3) activa el prompt v37.
# Volver atrás: bash scripts/activar-v37.sh --volver   (prompt v36 + borra vendedor_retiro; el código nuevo queda inerte)
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"; cd "$RAIZ"
set -a; . ./.env.produccion; set +a
U="https://$SUPABASE_PROJECT_REF.supabase.co/rest/v1"; H=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json")
if [ "${1:-}" = "--volver" ]; then
  curl -s -X DELETE "$U/config_wa?clave=eq.vendedor_retiro" "${H[@]}" >/dev/null
  node scripts/volver-version-vendedor.mjs --version 36
  echo "Vuelto a v36 ($(TZ=America/Asuncion date '+%d-%m %H:%M PY'))"; exit 0
fi
TEL=$(curl -s "$U/config_wa?select=valor->>whatsapp_enrique&clave=eq.vendedor" "${H[@]}" | python3 -c "import json,sys;t=json.load(sys.stdin)[0]['whatsapp_enrique'] or '';t=t[-9:];print(f'0{t[:3]} {t[3:6]} {t[6:]}' if len(t)==9 else '')")
[ -n "$TEL" ] || { echo "Falta config_wa.vendedor.whatsapp_enrique"; exit 1; }
TEXTO="Área 1, Avenida Los Lapachos, Ciudad del Este · lunes a viernes de 8:00 a 16:00 (sábados y domingos no hay retiro) · antes de pasar, que le escriba a Enrique al $TEL"
CUERPO=$(TEXTO="$TEXTO" python3 -c 'import json,os; print(json.dumps(dict(clave="vendedor_retiro", valor=dict(texto=os.environ["TEXTO"]))))')
curl -sf -X POST "$U/config_wa?on_conflict=clave" "${H[@]}" -H "Prefer: resolution=merge-duplicates" -d "$CUERPO" >/dev/null
for f in wa-webhook vendedor; do supabase functions deploy "$f" --project-ref "$SUPABASE_PROJECT_REF" --use-api 2>&1 | grep -E "Deployed|rror"; done
node scripts/activar-prompt.mjs
echo "v37 ACTIVA: $(TZ=America/Asuncion date '+%d-%m %H:%M:%S PY')"
