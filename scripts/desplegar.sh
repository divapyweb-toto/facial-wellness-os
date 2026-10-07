#!/usr/bin/env bash
# Despliegue del sistema de WhatsApp de Voltra a producción (Supabase + webhooks).
#
#   bash scripts/desplegar.sh                  → despliegue completo (idempotente: se puede repetir)
#   bash scripts/desplegar.sh --solo-verificar → chequea todo y NO cambia nada
#   bash scripts/desplegar.sh --ayuda          → lista de opciones
#
# Lee los valores de .env.produccion (no se sube a Git; plantilla: .env.produccion.ejemplo).
# Nunca imprime valores secretos. El único archivo con secretos que escribe es un temporal
# (permisos 600) para `supabase secrets set`, que se borra al terminar pase lo que pase.
# Descubre migraciones, semillas y funciones por carpeta: lo que agreguen las olas 2-4 entra solo.

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_PRODUCCION:-$RAIZ/.env.produccion}"
ENV_EJEMPLO="$RAIZ/.env.produccion.ejemplo"
DIR_SB="$RAIZ/supabase"
DIR_FUNCIONES="$DIR_SB/functions"
DIR_MIGRACIONES="$DIR_SB/migrations"
CONFIG_TOML="$DIR_SB/config.toml"

SOLO_VERIFICAR=0
PLANTILLAS=0
REGISTRAR_NUMERO=0
E2E_REAL=0
SALTAR_LINK=0
SALTAR_DB=0
SALTAR_SECRETOS=0
SALTAR_FUNCIONES=0
SALTAR_WEBHOOKS=0
SALTAR_E2E=0

ayuda() {
  cat <<'EOF'
Uso: bash scripts/desplegar.sh [opciones]

  --solo-verificar     Chequea herramientas, variables, archivos y el estado remoto (solo lectura). No cambia nada.
  --plantillas         Además manda las plantillas de WhatsApp a aprobación de Meta (paso 7).
  --registrar-numero   Registra el número en la Cloud API; pide el PIN de 6 dígitos por teclado (no se guarda).
  --e2e-real           La prueba final manda de verdad la confirmación a PRUEBA_TELEFONO (tu número de prueba).
  --saltar-link        No corre `supabase link`.
  --saltar-db          No aplica migraciones, semillas ni Vault.
  --saltar-secretos    No carga secretos de funciones ni de Vault.
  --saltar-funciones   No despliega funciones.
  --saltar-webhooks    No registra webhooks (Meta, Shopify, Telegram).
  --saltar-e2e         No corre la prueba de punta a punta.
  --ayuda              Muestra esto.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --solo-verificar) SOLO_VERIFICAR=1 ;;
    --plantillas) PLANTILLAS=1 ;;
    --registrar-numero) REGISTRAR_NUMERO=1 ;;
    --e2e-real) E2E_REAL=1 ;;
    --saltar-link) SALTAR_LINK=1 ;;
    --saltar-db) SALTAR_DB=1 ;;
    --saltar-secretos) SALTAR_SECRETOS=1 ;;
    --saltar-funciones) SALTAR_FUNCIONES=1 ;;
    --saltar-webhooks) SALTAR_WEBHOOKS=1 ;;
    --saltar-e2e) SALTAR_E2E=1 ;;
    --ayuda|-h|--help) ayuda; exit 0 ;;
    *) echo "Opción desconocida: $arg" >&2; ayuda >&2; exit 2 ;;
  esac
done

# ── utilidades ────────────────────────────────────────────────────────────────
PASO_N=0
paso() { PASO_N=$((PASO_N + 1)); printf '\n\033[1m[%s] %s\033[0m\n' "$PASO_N" "$1"; }
info() { printf '    %s\n' "$1"; }
ok()   { printf '    OK  %s\n' "$1"; }
aviso(){ printf '    !!  %s\n' "$1"; }
falla(){ printf '\nERROR: %s\n' "$1" >&2; exit 1; }

TEMPORALES=()
limpiar() {
  local f
  for f in "${TEMPORALES[@]+"${TEMPORALES[@]}"}"; do
    [ -n "$f" ] && rm -f "$f"
  done
}
trap limpiar EXIT INT TERM

temporal() { # crea un archivo temporal privado y lo anota para borrarlo al final
  local f
  f="$(mktemp "${TMPDIR:-/tmp}/voltra-despliegue.XXXXXX")"
  chmod 600 "$f"
  TEMPORALES+=("$f")
  printf '%s' "$f"
}

# Variables de .env.produccion.ejemplo, por sección (fuente única de la lista).
vars_de_seccion() { # $1 = OBLIGATORIAS | OPCIONALES
  awk -v sec="$1" '
    /^# ==== / { actual = ($0 ~ sec) ? 1 : 0; next }
    actual && /^[A-Z][A-Z0-9_]*=/ { sub(/=.*/, ""); print }
  ' "$ENV_EJEMPLO"
}

# Solo para el despliegue: no van como secretos de las funciones.
es_solo_despliegue() {
  case "$1" in SUPABASE_*|PRUEBA_*|WA_APP_ID) return 0 ;; *) return 1 ;; esac
}

# Carga .env.produccion sin `source` (los valores pueden tener caracteres raros) y exporta.
PRESENTES=" "   # nombres presentes en el archivo (bash 3.2 de macOS no tiene arrays asociativos)
cargar_env() {
  local linea clave valor
  while IFS= read -r linea || [ -n "$linea" ]; do
    linea="${linea%$'\r'}"
    [[ "$linea" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$linea" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    clave="${BASH_REMATCH[2]}"
    valor="${BASH_REMATCH[3]}"
    if [[ "$valor" =~ ^\"(.*)\"$ ]] || [[ "$valor" =~ ^\'(.*)\'$ ]]; then valor="${BASH_REMATCH[1]}"; fi
    PRESENTES="$PRESENTES$clave "
    export "$clave=$valor"
  done < "$ENV_FILE"
}

# Funciones desplegables: carpetas con index.ts que no empiezan con "_" (deja afuera _shared).
listar_funciones() {
  local d n
  for d in "$DIR_FUNCIONES"/*/; do
    n="$(basename "$d")"
    [[ "$n" == _* ]] && continue
    [ -f "$d/index.ts" ] && printf '%s\n' "$n"
  done
}

listar_migraciones() { find "$DIR_MIGRACIONES" -maxdepth 1 -name '*.sql' -print | sort; }

# Semillas: seed_config_wa.sql primero (las demás pueden leer config_wa), después el resto en orden alfabético.
listar_semillas() {
  [ -f "$DIR_SB/seed_config_wa.sql" ] && printf '%s\n' "$DIR_SB/seed_config_wa.sql"
  find "$DIR_SB" -maxdepth 1 -name 'seed_*.sql' ! -name 'seed_config_wa.sql' -print | sort
}

verify_jwt_false() { # ¿config.toml tiene verify_jwt = false para la función $1?
  awk -v f="[functions.$1]" '
    $0 == f { dentro = 1; next }
    /^\[/ { dentro = 0 }
    dentro && /^[[:space:]]*verify_jwt[[:space:]]*=[[:space:]]*false/ { encontrado = 1 }
    END { exit encontrado ? 0 : 1 }
  ' "$CONFIG_TOML"
}

# Corre un archivo SQL contra la base remota. Vía 1: `supabase db query --linked --file`
# (Management API; usa el login de la CLI). Vía 2: psql con SUPABASE_DB_URL. $2=1 → sin salida.
SQL_VIA=""
detectar_via_sql() {
  if supabase db query --help >/dev/null 2>&1; then SQL_VIA="cli"
  elif command -v psql >/dev/null 2>&1 && [ -n "${SUPABASE_DB_URL:-}" ]; then SQL_VIA="psql"
  else SQL_VIA=""
  fi
}
correr_sql() {
  local archivo="$1" silencioso="${2:-0}"
  case "$SQL_VIA" in
    cli)
      if [ "$silencioso" = 1 ]; then supabase db query --linked --file "$archivo" >/dev/null
      else supabase db query --linked --file "$archivo"; fi ;;
    psql)
      if [ "$silencioso" = 1 ]; then psql "$SUPABASE_DB_URL" -q -v ON_ERROR_STOP=1 -f "$archivo" >/dev/null
      else psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$archivo"; fi ;;
    *) falla "No hay forma de correr SQL remoto: actualizá la CLI (brew upgrade supabase) para tener 'supabase db query', o instalá psql y poné SUPABASE_DB_URL en .env.produccion." ;;
  esac
}

sql_literal() { local v="${1//\'/\'\'}"; printf "'%s'" "$v"; } # escapa comillas simples

# ── 1. herramientas y variables ───────────────────────────────────────────────
paso "Chequeo herramientas (supabase, deno, node), archivos y que .env.produccion tenga todas las variables (sin mostrar valores)"
PROBLEMAS=()
for h in supabase deno node; do
  if command -v "$h" >/dev/null 2>&1; then ok "$h instalado"
  else PROBLEMAS+=("Falta la herramienta '$h' (supabase: brew install supabase/tap/supabase · deno: brew install deno · node: brew install node)")
  fi
done
[ -f "$ENV_EJEMPLO" ] || falla "No encuentro $ENV_EJEMPLO (es la lista de variables)."

OBLIGATORIAS=()
while IFS= read -r v; do OBLIGATORIAS+=("$v"); done < <(vars_de_seccion OBLIGATORIAS)
OPCIONALES=()
while IFS= read -r v; do OPCIONALES+=("$v"); done < <(vars_de_seccion OPCIONALES)

FALTAN=()
if [ -f "$ENV_FILE" ]; then
  cargar_env
  for v in "${OBLIGATORIAS[@]}"; do
    [ -n "${!v:-}" ] || FALTAN+=("$v")
  done
  for v in "${OPCIONALES[@]}"; do
    if [[ "$PRESENTES" != *" $v "* ]]; then aviso "$v no está en .env.produccion (opcional; queda vacía)"
    elif [ -z "${!v:-}" ]; then info "$v vacía → modo simulado o desactivada"
    fi
  done
else
  PROBLEMAS+=("No existe .env.produccion. Crealo con: cp .env.produccion.ejemplo .env.produccion y completá los valores")
  FALTAN=("${OBLIGATORIAS[@]}")
fi
if [ "${#FALTAN[@]}" -gt 0 ]; then
  PROBLEMAS+=("Variables obligatorias vacías o ausentes en .env.produccion: ${FALTAN[*]}")
else
  ok "las ${#OBLIGATORIAS[@]} variables obligatorias están completas"
fi

if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && [[ "$SUPABASE_SERVICE_ROLE_KEY" != eyJ* ]]; then
  PROBLEMAS+=("SUPABASE_SERVICE_ROLE_KEY no parece la service role legacy (JWT, empieza con eyJ). Los crons la necesitan así.")
fi
if [ -n "${TELEGRAM_WEBHOOK_SECRET:-}" ] && { ! [[ "$TELEGRAM_WEBHOOK_SECRET" =~ ^[A-Za-z0-9_-]+$ ]] || [ "${#TELEGRAM_WEBHOOK_SECRET}" -gt 256 ]; }; then
  PROBLEMAS+=("TELEGRAM_WEBHOOK_SECRET solo admite letras, números, _ y - (máx. 256).")
fi

FUNCIONES=()
while IFS= read -r f; do FUNCIONES+=("$f"); done < <(listar_funciones)
MIGRACIONES=()
while IFS= read -r m; do MIGRACIONES+=("$m"); done < <(listar_migraciones)
SEMILLAS=()
while IFS= read -r s; do SEMILLAS+=("$s"); done < <(listar_semillas)
info "Funciones (${#FUNCIONES[@]}): ${FUNCIONES[*]:-ninguna}"
info "Migraciones (${#MIGRACIONES[@]}): $(for m in "${MIGRACIONES[@]+"${MIGRACIONES[@]}"}"; do printf '%s ' "$(basename "$m")"; done)"
info "Semillas (${#SEMILLAS[@]}): $(for s in "${SEMILLAS[@]+"${SEMILLAS[@]}"}"; do printf '%s ' "$(basename "$s")"; done)"
[ "${#FUNCIONES[@]}" -gt 0 ] || PROBLEMAS+=("No encontré funciones en supabase/functions/")

# Webhooks externos sin JWT de Supabase: avisar si alguna función *webhook* no tiene verify_jwt=false.
for f in "${FUNCIONES[@]+"${FUNCIONES[@]}"}"; do
  if [[ "$f" == *webhook* ]] && ! verify_jwt_false "$f"; then
    PROBLEMAS+=("supabase/config.toml no tiene [functions.$f] verify_jwt = false: el proveedor externo recibiría 401")
  fi
done
for m in "${MIGRACIONES[@]+"${MIGRACIONES[@]}"}"; do
  [[ "$(basename "$m")" =~ ^[0-9]{14}_.+\.sql$ ]] || PROBLEMAS+=("Migración con nombre inválido para la CLI: $(basename "$m")")
done
bash -n "$0" || PROBLEMAS+=("Error de sintaxis en desplegar.sh")
if command -v node >/dev/null 2>&1; then
  for s in registrar-webhooks.mjs prueba-e2e.mjs crear-plantillas-wa.mjs; do
    node --check "$RAIZ/scripts/$s" 2>/dev/null || PROBLEMAS+=("Error de sintaxis en scripts/$s")
  done
fi

if [ "${#PROBLEMAS[@]}" -gt 0 ]; then
  printf '\nNo se puede seguir. Falta resolver:\n' >&2
  for p in "${PROBLEMAS[@]}"; do printf '  - %s\n' "$p" >&2; done
  exit 1
fi

REF="$SUPABASE_PROJECT_REF"
export SUPABASE_URL="https://$REF.supabase.co"
export SUPABASE_DB_PASSWORD            # la CLI lo lee del entorno: no pregunta la contraseña
cd "$RAIZ"

# ── modo solo verificar: lecturas remotas, nada se cambia ─────────────────────
if [ "$SOLO_VERIFICAR" = 1 ]; then
  paso "Modo --solo-verificar: miro el estado remoto sin cambiar nada"
  if [ -f "$DIR_SB/.temp/project-ref" ] && [ "$(cat "$DIR_SB/.temp/project-ref")" = "$REF" ]; then
    info "Migraciones que faltan aplicar (simulación, no aplica nada):"
    supabase db push --linked --dry-run || aviso "No pude simular db push (¿falta supabase login?)"
  else
    aviso "La carpeta todavía no está vinculada a $REF: el despliegue real corre 'supabase link' primero."
  fi
  info "Webhooks: lo que se registraría"
  node scripts/registrar-webhooks.mjs --dry-run
  info "Prueba de solo lectura (funciones responden, tablas existen):"
  node scripts/prueba-e2e.mjs --solo-lectura || aviso "La prueba de solo lectura falló (normal si todavía no desplegaste)."
  printf '\nVerificación terminada. No se cambió nada.\n'
  exit 0
fi

# ── 2. link ───────────────────────────────────────────────────────────────────
if [ "$SALTAR_LINK" = 0 ]; then
  paso "Vinculo esta carpeta con el proyecto de Supabase $REF (supabase link)"
  supabase link --project-ref "$REF"
else
  paso "Salteo el link (--saltar-link)"
fi

# ── 3. migraciones, semillas y Vault ──────────────────────────────────────────
if [ "$SALTAR_DB" = 0 ]; then
  paso "Aplico las migraciones que falten, en orden (supabase db push)"
  supabase migration list --linked || true
  supabase db push --linked --yes

  detectar_via_sql
  paso "Cargo las semillas seed_*.sql (idempotentes: no pisan valores ya cambiados)"
  for s in "${SEMILLAS[@]+"${SEMILLAS[@]}"}"; do
    info "$(basename "$s")"
    correr_sql "$s" 1
  done
  ok "${#SEMILLAS[@]} semillas cargadas"

  if [ "$SALTAR_SECRETOS" = 0 ]; then
    paso "Creo o actualizo los secretos de Vault project_url y service_role_key (los usan los crons)"
    SQL_VAULT="$(temporal)"
    {
      printf 'do $vault$\nbegin\n'
      for par in "project_url|$SUPABASE_URL" "service_role_key|$SUPABASE_SERVICE_ROLE_KEY"; do
        nombre="${par%%|*}"; valor="${par#*|}"
        printf "  if exists (select 1 from vault.secrets where name = '%s') then\n" "$nombre"
        printf "    perform vault.update_secret((select id from vault.secrets where name = '%s'), %s);\n" "$nombre" "$(sql_literal "$valor")"
        printf "  else\n    perform vault.create_secret(%s, '%s');\n  end if;\n" "$(sql_literal "$valor")" "$nombre"
      done
      printf 'end\n$vault$;\n'
    } > "$SQL_VAULT"
    correr_sql "$SQL_VAULT" 1
    rm -f "$SQL_VAULT"
    ok "Vault actualizado (valores no mostrados)"
  fi
else
  paso "Salteo migraciones, semillas y Vault (--saltar-db)"
fi

# ── 4. secretos de las funciones ──────────────────────────────────────────────
if [ "$SALTAR_SECRETOS" = 0 ]; then
  paso "Cargo los secretos de las funciones (supabase secrets set con un archivo temporal que se borra)"
  SECRETOS_TMP="$(temporal)"
  n=0
  for v in "${OBLIGATORIAS[@]}" "${OPCIONALES[@]}"; do
    es_solo_despliegue "$v" && continue
    [ -n "${!v:-}" ] || continue
    printf '%s=%s\n' "$v" "${!v}" >> "$SECRETOS_TMP"
    n=$((n + 1))
  done
  supabase secrets set --project-ref "$REF" --env-file "$SECRETOS_TMP" >/dev/null
  rm -f "$SECRETOS_TMP"
  ok "$n secretos cargados. Nombres en Supabase: supabase secrets list"
fi

# ── 5. funciones ──────────────────────────────────────────────────────────────
if [ "$SALTAR_FUNCIONES" = 0 ]; then
  paso "Despliego las ${#FUNCIONES[@]} funciones de supabase/functions (menos _shared)"
  for f in "${FUNCIONES[@]}"; do
    info "$f"
    supabase functions deploy "$f" --project-ref "$REF" --use-api
  done
  ok "funciones desplegadas en $SUPABASE_URL/functions/v1/<nombre>"
fi

# ── 6. webhooks ───────────────────────────────────────────────────────────────
if [ "$SALTAR_WEBHOOKS" = 0 ]; then
  if [ "$REGISTRAR_NUMERO" = 1 ]; then
    paso "Registro el número de WhatsApp en la Cloud API (pide tu PIN de 2 pasos; no se guarda)"
    read -r -s -p "    PIN de 6 dígitos: " WA_PIN; echo
    [[ "$WA_PIN" =~ ^[0-9]{6}$ ]] || falla "El PIN tiene que ser de 6 dígitos."
    WA_PIN="$WA_PIN" node scripts/registrar-webhooks.mjs --solo-registrar-numero
    unset WA_PIN
  fi
  paso "Registro los webhooks de Meta, Shopify y Telegram (sin duplicar los que ya existen)"
  node scripts/registrar-webhooks.mjs
fi

# ── 7. plantillas ─────────────────────────────────────────────────────────────
if [ "$PLANTILLAS" = 1 ]; then
  paso "Mando las plantillas de WhatsApp a aprobación de Meta"
  node scripts/crear-plantillas-wa.mjs --enviar
else
  paso "Valido las plantillas sin mandarlas (para mandarlas: --plantillas)"
  if node scripts/crear-plantillas-wa.mjs >/dev/null; then ok "plantillas válidas"
  else aviso "Hay plantillas inválidas: corré 'node scripts/crear-plantillas-wa.mjs' para ver cuáles (con --plantillas no se manda ninguna)"; fi
fi

# ── 8. prueba de punta a punta ────────────────────────────────────────────────
if [ "$SALTAR_E2E" = 0 ]; then
  if [ "$E2E_REAL" = 1 ]; then
    paso "Prueba de punta a punta con envío REAL al número de prueba (PRUEBA_TELEFONO)"
    node scripts/prueba-e2e.mjs --real
  else
    paso "Prueba de punta a punta en modo seguro (no manda nada)"
    node scripts/prueba-e2e.mjs
  fi
fi

printf '\nDespliegue terminado.\n'
