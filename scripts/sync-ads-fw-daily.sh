#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="/Users/enriqueramirez/Negocios"
FW_OS="$PROJECT_ROOT/fw-os"
LOG_FILE="$FW_OS/logs/sync-ads-fw.log"
CLAUDE_BIN="/Users/enriqueramirez/.local/bin/claude"
# Cuentas de Meta a sincronizar, como "ad_account_id:tienda". Facial Wellness
# (1075263797491391:fw) está sin campañas desde oct-2026 y la conexión de Meta
# de esta Mac hoy ve la cuenta de Voltra: se reactiva sumándola acá.
CUENTAS=("1829928881223795:voltra")

mkdir -p "$FW_OS/logs"

set -a
source "$FW_OS/.env"
source "$FW_OS/.env.local"
set +a

cd "$PROJECT_ROOT"

# Corre una sincronización y devuelve su salida completa (para poder revisarla
# antes de decidir si hace falta reintentar).
run_sync() {
  local cuenta="$1" tienda="$2"
  caffeinate -is "$CLAUDE_BIN" -p \
    "Sincronizá el gasto de Meta Ads hacia gasto_ads_diario en Supabase. ad_account_id: ${cuenta}. tienda: ${tienda} (guardá tienda='${tienda}' en CADA fila que cargues). \
SIEMPRE volvé a sincronizar el día de AYER, tenga o no tenga ya una fila cargada — Meta sigue ajustando el gasto de un día \
por un tiempo después de que cierra, y a veces ayer se cargó a mano con el día todavía sin cerrar (gasto parcial), así que \
el upsert de hoy tiene que pisarlo con el monto final. Además, fijate en Supabase qué otros días de los últimos 7 (sin \
contar hoy, que todavía no cerró) NO tienen ninguna fila — puede que hayan quedado 2-3 días sin cargar por una falla \
anterior. Traé y cargá el gasto de ayer SIEMPRE, más cualquier otro día de esos 7 que esté sin ninguna fila." \
    --agent sync-ads-fw \
    --permission-mode bypassPermissions \
    --allowedTools "Bash,Read,ToolSearch,mcp__claude_ai_meta_ads__ads_get_ad_accounts,mcp__claude_ai_meta_ads__ads_get_ad_entities,mcp__claude_ai_meta_ads__ads_get_field_context"
}

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="
  # caffeinate -is: mientras esta corrida está viva, no deja que el sistema
  # entre en reposo por inactividad ni se duerma solo. Antes, si la Mac se
  # dormía a mitad de la respuesta, el proceso se cortaba sin sincronizar
  # nada — no evita que la Mac esté YA dormida (o la tapa cerrada) al llegar
  # la hora del disparo (10am — movido del 8am original porque a esa hora
  # la Mac casi siempre estaba con la tapa cerrada), pero sí evita que se
  # duerma DURANTE la corrida, que es lo que se vio en el log varios días.
  for par in "${CUENTAS[@]}"; do
  cuenta="${par%%:*}"; tienda="${par##*:}"
  echo "--- cuenta ${cuenta} (${tienda}) ---"
  set +e
  salida="$(run_sync "$cuenta" "$tienda" 2>&1)"
  ok=$?
  set -e
  echo "$salida"

  # El servidor MCP de Meta a veces no responde en el primer intento (se vio
  # el 30/08 y el 02/09, y también al probarlo a mano). Un solo reintento
  # corto de margen, no un loop: si vuelve a fallar, se deja constancia y no
  # se insiste — no hay que inventar datos de gasto.
  if [ $ok -ne 0 ] || echo "$salida" | grep -qiE "no responde|no respond|timeout|upstream closed"; then
    echo "----- primer intento con problemas, reintentando en 30s -----"
    sleep 30
    set +e
    salida2="$(run_sync "$cuenta" "$tienda" 2>&1)"
    set -e
    echo "$salida2"
  fi
  done
  echo "===== fin $(date '+%Y-%m-%d %H:%M:%S') ====="
  echo
} >> "$LOG_FILE" 2>&1
